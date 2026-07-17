'use strict';
/**
 * banking/doc-ingest.js — the chatbot's document dispatcher.
 *
 *   ingestAttachment(query, io, userId, { buffer, mimeType, originalName }, deps)
 *
 * One attachment in a DM can be many things. Receipts keep their existing pipeline
 * (OCR → dedup → match → cash question). Everything the receipt gate REJECTS now routes
 * by the doc type its OCR model already classified:
 *
 *   check               → stored via the receipt machinery (doc_kind='check'), matched to
 *                         the bank debit by check number / amount / payee, evidence-linked
 *                         (role 'check'), and — if that debit pays an insurance bill —
 *                         flips the bill paid in the same pass.
 *   insurance_statement,
 *   tax_form, disclosure,
 *   bank_statement      → classified + filed into the Data Vault through the SAME code as
 *                         browser uploads (classifyDocument + registerVaultFile), then the
 *                         domain recorder runs (insurance rows / tax schedule).
 *   other               → rejected, same reply as before.
 *
 * Results are tagged { kind } so messaging-bot can format replies + follow-ups.
 */
const { ingestReceipt, storeBytes } = require('./receipt-ingest');
const { fileSha256 } = require('./receipt-hash');
const crypto = require('crypto');

const ymd = (d) => (d ? String(d).slice(0, 10) : null);

// ── Check → bank-transaction matching ────────────────────────────────────────
// Check number is the strongest signal (Plaid puts it on the transaction). Amount must
// agree tightly; the date window is wide (≤14 days AFTER the check date) because checks
// clear late. Payee tokens corroborate. Exported for tests.
function findCheckMatch(ocr, txns) {
  const amount = ocr && ocr.check_amount != null ? Number(ocr.check_amount) : null;
  if (amount == null) return null;
  const checkNo = ocr.check_number ? String(ocr.check_number).replace(/^0+/, '') : null;
  const date = ymd(ocr.check_date);
  const payeeToks = String(ocr.payee || '').toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  let best = null, bestScore = 0;
  for (const t of (txns || [])) {
    if (!t || t.excluded || t.source === 'cash' || t.receiptId) continue;
    if (Math.abs(Math.abs(Number(t.amount) || 0) - amount) > 0.02) continue;
    let dd = null;
    if (date && t.date) {
      dd = (new Date(t.date) - new Date(date)) / 86400000;   // txn clears AFTER the check is written
      if (dd < -2 || dd > 14) continue;
    }
    const tNo = t.checkNumber ? String(t.checkNumber).replace(/^0+/, '') : null;
    const noHit = !!(checkNo && tNo && checkNo === tNo);
    const desc = String(t.desc || '').toLowerCase();
    const payeeHit = payeeToks.some(tok => desc.includes(tok));
    const checkish = /check|chk/.test(desc);
    let score = 1 + (noHit ? 4 : 0) + (payeeHit ? 1.5 : 0) + (checkish ? 0.5 : 0) + (dd != null ? (14 - Math.abs(dd)) / 14 : 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// Store a check image as a receipts row (doc_kind='check') + match + evidence link.
async function ingestCheck(query, io, userId, { buffer, mimeType, originalName, ocr }) {
  const sha = fileSha256(buffer);
  const dup = await query(`SELECT id, payee, total_amount FROM receipts WHERE user_id=$1 AND file_sha256=$2 LIMIT 1`, [userId, sha]);
  if (dup.rows.length) return { kind: 'check', duplicate: true, existing: dup.rows[0] };

  const { docId, filePath, name } = await storeBytes(io, userId, buffer, mimeType, originalName);
  const match = findCheckMatch(ocr, io.read('transactions.json') || []);
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO receipts (id,user_id,txn_id,file_path,doc_id,original_name,mime_type,ocr_data,match_status,
        merchant_name,receipt_date,total_amount,parser_status,file_sha256,duplicate_status,review_status,
        doc_kind,check_number,payee)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'parsed',$13,'unique','auto_accepted','check',$14,$15)`,
    [id, userId, match ? match.id : null, filePath, docId, name, mimeType, JSON.stringify(ocr || {}),
     match ? 'matched' : 'unreviewed', ocr.payee || null, ymd(ocr.check_date), ocr.check_amount ?? null,
     sha, ocr.check_number || null, ocr.payee || null]);

  // Remodel wiring: source row + evidence link with role 'check'.
  try {
    const { recordReceiptRemodel } = require('./receipt-store');
    await recordReceiptRemodel(query, {
      userId, receiptId: id, txnId: match ? match.id : null, txn: match || null,
      ocrData: { merchant: ocr.payee, total: ocr.check_amount, date: ymd(ocr.check_date), items: [] },
      matchScore: match ? 0.9 : null, sourceRole: 'check',
    });
  } catch (e) { console.error('[doc-ingest/check remodel]', e.message); }

  // If the matched debit pays an insurance premium, flip that bill paid right now.
  let paidInsurance = 0;
  if (match) {
    try { paidInsurance = await require('./insurance').matchPendingPremiums(query, io, userId); } catch {}
    if (match.id) {
      const txns = (io.read('transactions.json') || []).map(t => t.id === match.id ? { ...t, receiptId: id } : t);
      io.write('transactions.json', txns);
    }
  }
  return { kind: 'check', id, ocr, matched: match ? { id: match.id, desc: match.desc, date: match.date } : null, paidInsurance };
}

// File a non-receipt document into the vault via the same classify+register path the
// browser upload/sort uses, then run the domain recorder (insurance / tax rows).
async function fileToVault(query, io, userId, { buffer, mimeType, originalName, gateDocType }) {
  const { classifyDocument } = require('../vault/ai-sort');
  const { registerVaultFile, decisionTags } = require('../vault/helpers');

  const meta = io.read('vault.json') || { folders: [], files: [] };
  const properties = io.read('properties.json') || [];
  let r = null;
  try { r = await classifyDocument({ buffer, filename: originalName || 'document', mimeType, folders: meta.folders, properties }); }
  catch (e) { console.error('[doc-ingest] classify failed:', e.message); }
  let d = r && r.decision;

  // Classifier came up empty → trust the gate's type and file to a holding folder so the
  // document is never lost; a later vault sort can refile it.
  if (!d || d.docType === 'other' || !d.folder || d.folder === 'Unsorted') {
    const fallbackFolder = { insurance_statement: 'Insurance/Unsorted', tax_form: 'Tax Documents/Unsorted',
                             disclosure: 'Disclosures/Unsorted', bank_statement: 'Uploads' }[gateDocType] || 'Uploads';
    d = { ...(d || {}), docType: gateDocType, folder: fallbackFolder, filename: originalName || 'document' };
  }

  const entry = await registerVaultFile(meta, {
    userId, buffer, name: d.filename || originalName, mimeType, folderPath: d.folder, tags: decisionTags(d),
  });
  io.write('vault.json', meta);

  let recorded = null;
  if (d.docType === 'insurance_statement' || d.docType === 'tax_form' || d.docType === 'disclosure') {
    try {
      const { runDomainRecorder } = require('../vault/domain-hooks');
      recorded = await runDomainRecorder(io, userId, { docType: d.docType, fileId: entry.id, buffer, text: r && r.text, decision: d });
      // Chat context: ask the "add this property?" question inline (mark asked so the
      // bot's delivery loop doesn't re-send it).
      if (recorded && recorded.propertyQuestion) {
        try { await require('./property-link').markAsked(query, recorded.propertyQuestion.id); } catch {}
      }
    } catch (e) { console.error('[doc-ingest] domain recorder:', e.message); }
  }
  return { kind: 'filed', docType: d.docType, folder: d.folder, filename: entry.name, fileId: entry.id, recorded };
}

// Doc types the vault path handles when the receipt gate rejects an attachment.
const VAULT_TYPES = new Set(['insurance_statement', 'tax_form', 'disclosure', 'bank_statement']);

/** Route one attachment. Returns the receipt result verbatim, or a { kind } tagged result. */
async function ingestAttachment(query, io, userId, { buffer, mimeType, originalName }, deps = {}) {
  const ingest = deps.ingestReceipt || ingestReceipt;
  const res = await ingest(query, io, userId, { buffer, mimeType, originalName });
  if (!res || !res.rejected) return res;                                    // real receipt → unchanged pipeline
  if (res.docType === 'check' && res.ocr) {
    return (deps.ingestCheck || ingestCheck)(query, io, userId, { buffer, mimeType, originalName, ocr: res.ocr });
  }
  if (VAULT_TYPES.has(res.docType)) {
    return (deps.fileToVault || fileToVault)(query, io, userId, { buffer, mimeType, originalName, gateDocType: res.docType });
  }
  return res;                                                               // genuinely unusable → same rejection
}

// ── Bot reply for the new result kinds (receipts still use formatReceiptReply) ──
const money = (v) => v != null ? `$${Number(v).toFixed(2)}` : '?';
const DOC_LABEL = { insurance_statement: 'insurance bill', tax_form: 'tax document', disclosure: 'disclosure', bank_statement: 'bank statement' };

function formatDocReply(r) {
  if (!r) return null;
  if (r.kind === 'check') {
    if (r.duplicate) return `🧾 That check is already on file${r.existing?.payee ? ` (to ${r.existing.payee})` : ''}.`;
    const o = r.ocr || {};
    const head = `🧾 Saved check${o.check_number ? ` #${o.check_number}` : ''}${o.payee ? ` to ${o.payee}` : ''} — ${money(o.check_amount)}${o.check_date ? ` · ${ymd(o.check_date)}` : ''}.`;
    if (!r.matched) return head + `\nNo matching bank transaction yet — I'll attach it automatically when it clears.`;
    let line = `\nMatched to: ${r.matched.desc} (${r.matched.date}).`;
    if (r.paidInsurance > 0) line += ` That pays your insurance bill ✓`;
    return head + line;
  }
  if (r.kind === 'filed') {
    const label = DOC_LABEL[r.docType] || 'document';
    const icons = { insurance_statement: '🏠', tax_form: '🧾', disclosure: '📑', bank_statement: '🏦' };
    let msg = `${icons[r.docType] || '📄'} Filed your ${label} under ${r.folder}.`;
    const rec = r.recorded;
    if (r.docType === 'insurance_statement' && rec && rec.recorded && rec.parsed) {
      const p = rec.parsed;
      const bits = [p.carrier, p.coverageType].filter(Boolean).join(' ');
      if (p.amountDue != null || p.dueDate) {
        msg += `\n${bits ? bits + ': ' : ''}${p.amountDue != null ? money(p.amountDue) : 'amount unknown'}${p.dueDate ? ` due ${p.dueDate}` : ''}.`;
        msg += rec.matchedTxnId ? ' Already paid ✓' : " I'll remind you before it's due.";
      }
    }
    if (r.docType === 'tax_form' && rec && rec.recorded) {
      if (rec.rows > 0) msg += `\nFound ${rec.rows} upcoming tax payment${rec.rows > 1 ? 's' : ''} — I'll remind you before each due date.`;
      if (rec.refunds > 0) msg += `\nLooks like a refund is coming your way 💰`;
    }
    if (r.docType === 'disclosure' && rec && rec.recorded && rec.notice) {
      const n = rec.notice;
      if (rec.accountId) msg += `\nAdded ${n.institution || 'the'}${n.accountMask ? ` ••${n.accountMask}` : ''} account${n.reportedAmount != null ? ` with ${money(n.reportedAmount)}` : ''} under your investments — ⚠ amount unconfirmed${n.assetNote ? ` ("${n.assetNote}")` : ''}.`;
      if (rec.actionId) msg += `\nAction needed: ${n.actionRequired || 'respond to the notice'}${n.consequenceDate ? ` before ${n.consequenceDate}` : ''}. I'll keep reminding you — reply "done" once you've handled it.`;
    }
    if (rec && rec.propertyQuestion) msg += `\n\n${rec.propertyQuestion.text}`;
    return msg;
  }
  return null;   // receipt results are formatted by messaging-bot's formatReceiptReply
}

module.exports = { ingestAttachment, ingestCheck, fileToVault, findCheckMatch, formatDocReply };
