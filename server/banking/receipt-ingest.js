'use strict';
/**
 * banking/receipt-ingest.js — ingest a receipt that arrived through the messaging bot.
 *
 *   ingestReceipt(query, io, userId, { buffer, mimeType, originalName })
 *     1. OCR + gatekeeper (is_receipt) — reject non-receipts.
 *     2. compute dedup hashes (file / perceptual / OCR-text) and run findDuplicate.
 *     3. store the file (R2 + documents row; disk fallback) — always, as a file record.
 *     4. insert the receipts row with hashes + duplicate_status/review_status.
 *     5. branch:
 *          hard     → blocked: rejected_duplicate, NO source_transaction; bot says "already saved".
 *          possible → held: needs_review, NO source_transaction yet; opens a same/separate question.
 *          unique   → active: receipt_items + source_transaction + reconciliation (findMatch).
 *
 * Returns a tagged result the bot turns into the right SMS:
 *   { rejected, reason } | { level:'hard', existing } | { level:'possible', newOcr, existing }
 *   | { level:'unique', id, ocr, matched }
 */
const crypto    = require('crypto');
const path      = require('path');
const fs        = require('fs');
const r2        = require('../core/r2');
const documents = require('../core/documents');
const { ocrReceipt, compareToTxn } = require('./receipt-ocr');
const { recordReceiptRemodel }     = require('./receipt-store');
const { fileSha256, perceptualHashes, ocrTextHash } = require('./receipt-hash');
const { findDuplicate } = require('./receipt-dedup');
const dupflow = require('./receipt-dupflow');

// Best-effort match of an OCR'd receipt to a recent transaction (amount + date + merchant).
function findMatch(ocr, txns) {
  if (!ocr || ocr.total == null) return null;
  const total = Number(ocr.total);
  let best = null, bestScore = 0;
  for (const t of (txns || [])) {
    if (!t || t.excluded) continue;
    if (Math.abs(Math.abs(Number(t.amount) || 0) - total) > 0.02) continue;
    let score = 1;
    if (ocr.date && t.date) {
      const dd = Math.abs((new Date(ocr.date) - new Date(t.date)) / 86400000);
      if (dd > 5) continue;
      score += (5 - dd) / 5;
    }
    if (ocr.merchant && t.desc) {
      const a = String(ocr.merchant).toLowerCase().split(/\s+/)[0];
      const b = String(t.desc).toLowerCase();
      if (a && a.length >= 3 && b.includes(a)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// Gate: only genuine proofs of purchase are stored. (is_receipt from the OCR; if unclassified,
// accept only when real purchase data was read.)
function shouldAccept(ocr) {
  if (ocr && ocr.is_receipt === false) return { accept: false, reason: 'not_receipt', docType: ocr.doc_type || 'other' };
  if (ocr && ocr.is_receipt === true)  return { accept: true };
  const readable = !!(ocr && (ocr.merchant != null || ocr.total != null));
  return readable ? { accept: true } : { accept: false, reason: 'unreadable', docType: (ocr && ocr.doc_type) || null };
}

// Store bytes — R2 + documents row preferred; disk fallback. Returns { docId, filePath, name }.
async function storeBytes(io, userId, buffer, mimeType, originalName) {
  const ext  = path.extname(originalName || '') || (mimeType === 'application/pdf' ? '.pdf' : '.png');
  const name = originalName || `receipt${ext}`;
  let docId = null, filePath = null;
  if (r2.configured) {
    try {
      docId = `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const { key } = await documents.saveDocument({ id: docId, userId, name, mimeType, bytes: buffer, folderPath: 'receipts', tags: {} });
      filePath = key;
    } catch (e) { console.error('[receipt-ingest] R2 store failed, disk fallback:', e.message); docId = null; }
  }
  if (!docId) {
    const dir = path.join(io.dir, 'receipts'); fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
    fs.writeFileSync(filePath, buffer);
  }
  return { docId, filePath, name };
}

async function ingestReceipt(query, io, userId, { buffer, mimeType, originalName }) {
  // 1. OCR + classify.
  let ocrData;
  try { ocrData = await ocrReceipt(buffer, mimeType); }
  catch (e) { ocrData = { is_receipt: null, merchant: null, total: null, date: null, items: [], error: e.message }; }
  const gate = shouldAccept(ocrData);
  if (!gate.accept) return { rejected: true, reason: gate.reason, docType: gate.docType };

  // 2. dedup hashes + check against existing active receipts.
  const file_sha256 = fileSha256(buffer);
  const perceptual_hashes = await perceptualHashes(buffer, mimeType);   // [0°,90°,180°,270°] — rotation-invariant
  const perceptual_hash = perceptual_hashes[0] || null;                 // the upright hash we store on the row
  const ocr_text_hash = ocrTextHash(ocrData);
  const dup = await findDuplicate(query, userId, { file_sha256, perceptual_hash, perceptual_hashes, ocr_text_hash, ocr: ocrData });
  const existingOcr = (dup.existing && dup.existing.ocr_data) || {};

  // 3. store the file (a file record always exists, even for blocked duplicates).
  const { docId, filePath, name } = await storeBytes(io, userId, buffer, mimeType, originalName);

  // 4. reconciliation only matters for receipts that will become active (unique path).
  const match = dup.level === 'unique' ? findMatch(ocrData, io.read('transactions.json') || []) : null;
  const cmp   = match ? compareToTxn(ocrData, match) : null;

  const status = dup.level === 'hard'     ? ['hard_duplicate',     'rejected_duplicate']
               : dup.level === 'possible' ? ['possible_duplicate', 'needs_review']
               :                            ['unique',             'auto_accepted'];
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO receipts (id,user_id,txn_id,file_path,doc_id,original_name,mime_type,ocr_data,match_status,match_flags,
        merchant_name,receipt_date,total_amount,parser_status,file_sha256,perceptual_hash,ocr_text_hash,
        duplicate_status,review_status,duplicate_of_receipt_id,duplicate_confidence,duplicate_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'parsed',$14,$15,$16,$17,$18,$19,$20,$21)`,
    [id, userId, match ? match.id : null, filePath, docId, name, mimeType,
     JSON.stringify(ocrData), cmp ? cmp.status : (match ? 'matched' : 'unreviewed'), JSON.stringify(cmp ? cmp.flags : []),
     ocrData.merchant || null, ocrData.date || null, ocrData.total != null ? ocrData.total : null,
     file_sha256, perceptual_hash, ocr_text_hash,
     status[0], status[1], dup.matchedReceiptId || null, dup.level === 'unique' ? null : dup.score, dup.reason || null]);

  // 5. branch.
  if (dup.level === 'hard') {
    await dupflow.logCheck(query, { userId, newReceiptId: id, newFileId: docId, existingReceiptId: dup.matchedReceiptId,
      score: dup.score, reason: dup.reason, signals: dup.signals, botMessage: dupflow.hardDuplicateMessage(existingOcr), finalDecision: 'hard_duplicate' });
    return { level: 'hard', id, existing: existingOcr, existingDocId: dup.existing && dup.existing.doc_id, existingReceiptId: dup.matchedReceiptId };
  }
  if (dup.level === 'possible') {
    const checkId = await dupflow.logCheck(query, { userId, newReceiptId: id, newFileId: docId, existingReceiptId: dup.matchedReceiptId,
      score: dup.score, reason: dup.reason, signals: dup.signals, botMessage: dupflow.possibleDuplicateMessage(ocrData, existingOcr) });
    await dupflow.createDedupQuestion(query, userId, { newReceiptId: id, existingReceiptId: dup.matchedReceiptId, checkId });
    return { level: 'possible', id, newOcr: ocrData, existing: existingOcr, existingDocId: dup.existing && dup.existing.doc_id, existingReceiptId: dup.matchedReceiptId };
  }
  // unique → active receipt: items + source_transaction + evidence link.
  try {
    const matchScore = cmp ? (cmp.status === 'matched' ? 1 : cmp.status === 'partial' ? 0.5 : 0.1) : null;
    await recordReceiptRemodel(query, { userId, receiptId: id, txnId: match ? match.id : null, txn: match || null, ocrData, matchScore });
  } catch (e) { console.error('[receipt-ingest/remodel]', e.message); }
  return { level: 'unique', id, ocr: ocrData, matched: match ? { id: match.id, desc: match.desc, date: match.date } : null };
}

module.exports = { ingestReceipt, findMatch, shouldAccept, storeBytes };
