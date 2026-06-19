'use strict';
/**
 * banking/receipt-ingest.js — ingest a receipt that arrived through the messaging bot
 * (a DM attachment), with no transaction context required.
 *
 *   ingestReceipt(query, io, userId, { buffer, mimeType, originalName })
 *     1. OCR the image/PDF → { merchant, total, date, items }   (best-effort; never throws)
 *     2. best-effort auto-match to a recent transaction (amount + date + merchant)
 *     3. store the bytes (R2 via core/documents; disk fallback)
 *     4. INSERT the receipts row (txn_id may be NULL — standalone)
 *     5. remodel write-flow: receipt_items + source_transactions + structured columns,
 *        and the receipt→transaction evidence link when a match was found.
 *
 * Mirrors the storage path of banking/receipt-routes.js, but txn-optional. Runs in-process
 * with the server, so the bot calls it directly (no HTTP round-trip).
 */
const crypto    = require('crypto');
const path      = require('path');
const fs        = require('fs');
const r2        = require('../core/r2');
const documents = require('../core/documents');
const { ocrReceipt, compareToTxn } = require('./receipt-ocr');
const { recordReceiptRemodel }     = require('./receipt-store');

// Best-effort match of an OCR'd receipt to a recent transaction: amount must line up, date
// must be within a few days, and a shared merchant word boosts confidence. Returns the
// transaction (or null). Pure — testable without a DB.
function findMatch(ocr, txns) {
  if (!ocr || ocr.total == null) return null;
  const total = Number(ocr.total);
  let best = null, bestScore = 0;
  for (const t of (txns || [])) {
    if (!t || t.excluded) continue;
    if (Math.abs(Math.abs(Number(t.amount) || 0) - total) > 0.02) continue;   // amount must match
    let score = 1;
    if (ocr.date && t.date) {
      const dd = Math.abs((new Date(ocr.date) - new Date(t.date)) / 86400000);
      if (dd > 5) continue;                                                    // within ~5 days
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

// Gate: only genuine proofs of purchase are stored. The vision model classifies is_receipt;
// when it didn't classify (odd/old response), accept only if real purchase data was read.
function shouldAccept(ocr) {
  if (ocr && ocr.is_receipt === false) return { accept: false, reason: 'not_receipt', docType: ocr.doc_type || 'other' };
  if (ocr && ocr.is_receipt === true)  return { accept: true };
  const readable = !!(ocr && (ocr.merchant != null || ocr.total != null));
  return readable ? { accept: true } : { accept: false, reason: 'unreadable', docType: (ocr && ocr.doc_type) || null };
}

async function ingestReceipt(query, io, userId, { buffer, mimeType, originalName }) {
  // 1. OCR + classify — best-effort; a failure yields a blank, which the gate then rejects.
  let ocrData;
  try { ocrData = await ocrReceipt(buffer, mimeType); }
  catch (e) { ocrData = { is_receipt: null, merchant: null, total: null, date: null, items: [], error: e.message }; }

  // 1b. Gatekeeper — a non-receipt (random photo, etc.) is rejected and nothing is stored.
  const gate = shouldAccept(ocrData);
  if (!gate.accept) return { rejected: true, reason: gate.reason, docType: gate.docType };

  // 2. Auto-match to a recent transaction.
  const match = findMatch(ocrData, io.read('transactions.json') || []);
  const cmp   = match ? compareToTxn(ocrData, match) : null;

  // 3. Store bytes — R2 (documents) preferred, disk fallback (same as receipt-routes).
  const ext  = path.extname(originalName || '') || (mimeType === 'application/pdf' ? '.pdf' : '.png');
  const name = originalName || `receipt${ext}`;
  let docId = null, filePath = null;
  if (r2.configured) {
    try {
      docId = `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const { key } = await documents.saveDocument({
        id: docId, userId, name, mimeType, bytes: buffer, folderPath: 'receipts',
        tags: match ? { txnId: match.id } : {},
      });
      filePath = key;
    } catch (e) { console.error('[receipt-ingest] R2 store failed, falling back to disk:', e.message); docId = null; }
  }
  if (!docId) {
    const dir = path.join(io.dir, 'receipts');
    fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
    fs.writeFileSync(filePath, buffer);
  }

  // 4. Persist the receipt row (txn_id may be NULL — standalone).
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO receipts (id, user_id, txn_id, file_path, doc_id, original_name, mime_type, ocr_data, match_status, match_flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, userId, match ? match.id : null, filePath, docId, name, mimeType,
     JSON.stringify(ocrData), cmp ? cmp.status : (match ? 'matched' : 'unreviewed'), JSON.stringify(cmp ? cmp.flags : [])]);

  // 5. Remodel write-flow (receipt_items + source_transactions + structured columns + link).
  try {
    const matchScore = cmp ? (cmp.status === 'matched' ? 1 : cmp.status === 'partial' ? 0.5 : 0.1) : null;
    await recordReceiptRemodel(query, { userId, receiptId: id, txnId: match ? match.id : null, txn: match || null, ocrData, matchScore });
  } catch (e) { console.error('[receipt-ingest/remodel]', e.message); }

  return { id, ocr: ocrData, matched: match ? { id: match.id, desc: match.desc, date: match.date } : null };
}

module.exports = { ingestReceipt, findMatch, shouldAccept };
