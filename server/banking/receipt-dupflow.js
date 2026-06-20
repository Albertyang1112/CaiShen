'use strict';
/**
 * receipt-dupflow.js — the duplicate-resolution conversation (text-only, SMS/Discord).
 * Owns the audit log (receipt_duplicate_checks), the "same/separate/unsure" reply handling,
 * and the three outcomes: reject-as-duplicate, finalize-as-separate, mark-needs-review.
 */
const crypto = require('crypto');
const { classifyDedupReply } = require('./receipt-dedup');
const { recordReceiptRemodel } = require('./receipt-store');

// "Walmart, 2026-06-15 at 15:42, $43.91, card ••2210"
function receiptLine(ocr) {
  ocr = ocr || {};
  const bits = [];
  if (ocr.merchant) bits.push(ocr.merchant);
  const when = [ocr.date, ocr.time].filter(Boolean).join(' at ');
  if (when) bits.push(when);
  if (ocr.total != null) bits.push('$' + Number(ocr.total).toFixed(2));
  if (ocr.card_last4) bits.push('card ••' + ocr.card_last4);
  return bits.join(', ') || 'receipt';
}

// ── messages (plain text, no buttons) ──
function possibleDuplicateMessage(newOcr, existingOcr) {
  return [
    'This looks similar to a receipt already saved.', '',
    `Existing: ${receiptLine(existingOcr)}`,
    `New: ${receiptLine(newOcr)}`, '',
    'Reply "same" if this is the same purchase. Reply "separate" and include what makes it different, like a different receipt/order number, time, card, items, store, or bank transaction.',
  ].join('\n');
}
function hardDuplicateMessage(existingOcr) {
  existingOcr = existingOcr || {};
  const m = existingOcr.merchant || 'that merchant';
  const d = existingOcr.date || 'that day';
  const t = existingOcr.total != null ? '$' + Number(existingOcr.total).toFixed(2) : 'that amount';
  return `This looks like the same receipt already saved for ${m} on ${d} for ${t}. I won't save a second copy, but the original receipt will stay attached to that purchase.`;
}

// ── audit log ──
async function logCheck(query, o) {
  const id = `dchk_${crypto.randomBytes(6).toString('hex')}`;
  await query(
    `INSERT INTO receipt_duplicate_checks
       (id,user_id,bank_account_id,bank_account_period_id,new_file_id,new_receipt_id,possible_duplicate_receipt_id,
        duplicate_score,duplicate_reason,duplicate_signals_json,bot_message,final_decision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, o.userId, o.accountId ?? null, o.periodId ?? null, o.newFileId ?? null, o.newReceiptId ?? null,
     o.existingReceiptId ?? null, o.score ?? null, o.reason ?? null, JSON.stringify(o.signals || {}),
     o.botMessage ?? null, o.finalDecision ?? null]);
  return id;
}
const closeCheck = (query, checkId, { userResponse = null, explanation = null, finalDecision }) =>
  query(`UPDATE receipt_duplicate_checks SET user_response=$2, user_separate_explanation=$3, final_decision=$4, updated_at=NOW() WHERE id=$1`,
    [checkId, userResponse, explanation, finalDecision]);

// ── pending dedup question (txn_messages, kind='dedup') ──
async function createDedupQuestion(query, userId, { newReceiptId, existingReceiptId, checkId }) {
  await query(
    `INSERT INTO txn_messages (id,user_id,transaction_id,channel,kind,state,payload)
     VALUES ($1,$2,$3,'discord','dedup','asked',$4)`,
    [`txm_${crypto.randomBytes(6).toString('hex')}`, userId, null,
     JSON.stringify({ stage: 'await_decision', newReceiptId, existingReceiptId, checkId })]);
}
async function pendingDedupQuestion(query, userId) {
  const r = await query(`SELECT * FROM txn_messages WHERE user_id=$1 AND kind='dedup' AND state='asked' ORDER BY created_at DESC LIMIT 1`, [userId]);
  const row = r.rows[0];
  if (row && typeof row.payload === 'string') row.payload = JSON.parse(row.payload);
  return row || null;
}
const closeQuestion = (query, id) => query(`UPDATE txn_messages SET state='answered' WHERE id=$1`, [id]);

// ── outcomes ──
async function rejectAsDuplicate(query, userId, newReceiptId, existingReceiptId, response = 'same') {
  // Confirmed duplicate: never becomes an active receipt; no source_transaction was created.
  await query(`UPDATE receipts SET duplicate_status='confirmed_duplicate', review_status='rejected_duplicate',
                 duplicate_of_receipt_id=$3, user_duplicate_response=$4 WHERE id=$1 AND user_id=$2`,
    [newReceiptId, userId, existingReceiptId || null, response]);
}
async function finalizeAsSeparate(query, io, userId, newReceiptId, detail) {
  await query(`UPDATE receipts SET duplicate_status='confirmed_separate', review_status='user_confirmed',
                 user_duplicate_response='separate', user_separate_explanation=$3 WHERE id=$1 AND user_id=$2`,
    [newReceiptId, userId, detail || null]);
  // Promote to active: receipt_items + source_transaction + reconciliation evidence.
  const r = await query(`SELECT txn_id, ocr_data FROM receipts WHERE id=$1 AND user_id=$2`, [newReceiptId, userId]);
  const rec = r.rows[0];
  if (rec) {
    try { await recordReceiptRemodel(query, { userId, receiptId: newReceiptId, txnId: rec.txn_id || null, txn: null, ocrData: rec.ocr_data || {}, matchScore: null }); }
    catch (e) { console.error('[dupflow/finalize remodel]', e.message); }
  }
}
const markNeedsReview = (query, userId, newReceiptId) =>
  query(`UPDATE receipts SET duplicate_status='needs_review', review_status='needs_review' WHERE id=$1 AND user_id=$2`, [newReceiptId, userId]);

const SAVED_SEPARATE = "Thanks — I'll save this as a separate purchase and use that detail for reconciliation.";
const SAME           = "Got it — I'll treat this as the same purchase and won't save a duplicate receipt.";
const NEEDS_REVIEW   = "No problem — I'll mark this for review before using it for reconciliation.";
const ASK_PROOF      = 'What makes it separate? Please send one detail, like a different receipt/order number, purchase time, card, items, store, or matching bank transaction.';

// Handle one reply to a pending dedup question → { replies: string[] }.
async function handleDedupReply(query, io, userId, q, text, deps = {}) {
  const payload = q.payload || {};
  const { newReceiptId, existingReceiptId, checkId } = payload;

  // Follow-up stage: we already asked "what makes it separate?" — the reply IS the distinguishing
  // detail (free text), not another same/separate decision. Any substantive detail finalizes it.
  if (payload.stage === 'await_proof') {
    const t = String(text || '').trim();
    const noDetail = t.length < 3 || /^\s*(separate|different|not the same|no|idk|not\s*sure|unsure|maybe|i\s*don'?t\s*know|dunno|no idea)\s*$/i.test(t);
    if (!noDetail) {
      await finalizeAsSeparate(query, io, userId, newReceiptId, t);
      await closeQuestion(query, q.id);
      if (checkId) await closeCheck(query, checkId, { userResponse: 'separate', explanation: t, finalDecision: 'confirmed_separate' });
      return { replies: [SAVED_SEPARATE] };
    }
    await markNeedsReview(query, userId, newReceiptId);
    await closeQuestion(query, q.id);
    if (checkId) await closeCheck(query, checkId, { userResponse: t, finalDecision: 'needs_review' });
    return { replies: [NEEDS_REVIEW] };
  }

  const cls = await classifyDedupReply(text, deps);
  if (cls.decision === 'same') {
    await rejectAsDuplicate(query, userId, newReceiptId, existingReceiptId);
    await closeQuestion(query, q.id);
    if (checkId) await closeCheck(query, checkId, { userResponse: 'same', finalDecision: 'confirmed_duplicate' });
    return { replies: [SAME] };
  }
  if (cls.decision === 'unsure') {
    await markNeedsReview(query, userId, newReceiptId);
    await closeQuestion(query, q.id);
    if (checkId) await closeCheck(query, checkId, { userResponse: text, finalDecision: 'needs_review' });
    return { replies: [NEEDS_REVIEW] };
  }
  // separate — with proof → finalize; without proof → one short follow-up.
  if (cls.detail) {
    await finalizeAsSeparate(query, io, userId, newReceiptId, cls.detail);
    await closeQuestion(query, q.id);
    if (checkId) await closeCheck(query, checkId, { userResponse: 'separate', explanation: cls.detail, finalDecision: 'confirmed_separate' });
    return { replies: [SAVED_SEPARATE] };
  }
  await query(`UPDATE txn_messages SET payload=$2 WHERE id=$1`, [q.id, JSON.stringify({ ...payload, stage: 'await_proof' })]);
  return { replies: [ASK_PROOF] };
}

module.exports = {
  receiptLine, possibleDuplicateMessage, hardDuplicateMessage,
  logCheck, closeCheck, createDedupQuestion, pendingDedupQuestion, handleDedupReply,
  rejectAsDuplicate, finalizeAsSeparate, markNeedsReview,
  SAVED_SEPARATE, SAME, NEEDS_REVIEW, ASK_PROOF,
};
