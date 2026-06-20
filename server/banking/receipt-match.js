'use strict';
/**
 * receipt-match.js — cash-receipt handling + retroactive Plaid matching.
 *
 *   • Cash flow: a saved-but-unmatched receipt asks "was this cash?". yes → create a
 *     source='cash' transaction from the receipt + link it + categorize it; no → leave it
 *     pending so a later Plaid pull can match it.
 *   • matchPendingReceipts: on each Plaid sync, match unmatched non-cash receipts to newly
 *     pulled transactions by amount + date (±3d), with Groq confirming the merchant name.
 */
const crypto = require('crypto');
const axios = require('axios');
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const ymd = (d) => (d ? String(d).slice(0, 10) : null);
const daysBetween = (a, b) => (!a || !b ? Infinity : Math.abs((new Date(a) - new Date(b)) / 86400000));

// ── cash question (txn_messages, kind='cash') ──
async function createCashQuestion(query, userId, receiptId) {
  await query(`INSERT INTO txn_messages (id,user_id,transaction_id,channel,kind,state,payload)
     VALUES ($1,$2,$3,'discord','cash','asked',$4)`,
    [`txm_${crypto.randomBytes(6).toString('hex')}`, userId, null, JSON.stringify({ receiptId })]);
}
async function pendingCashQuestion(query, userId) {
  const r = await query(`SELECT * FROM txn_messages WHERE user_id=$1 AND kind='cash' AND state='asked' ORDER BY created_at DESC LIMIT 1`, [userId]);
  const row = r.rows[0];
  if (row && typeof row.payload === 'string') row.payload = JSON.parse(row.payload);
  return row || null;
}

// Create a source='cash' transaction from a receipt + link the receipt to it.
async function createCashTransaction(query, io, userId, receipt) {
  const ocr = receipt.ocr_data || {};
  const merchant = receipt.merchant_name || ocr.merchant || 'Cash purchase';
  const total = receipt.total_amount != null ? Number(receipt.total_amount) : (ocr.total != null ? Number(ocr.total) : 0);
  const date = ymd(receipt.receipt_date) || ocr.date || new Date().toISOString().slice(0, 10);
  const id = 'cash_' + crypto.randomBytes(8).toString('hex');
  const tx = {
    id, date, month: date.slice(0, 7), desc: merchant, amount: -Math.abs(total),
    category: 'Other', account: null, institution: null, source: 'cash',
    paymentMethod: 'cash', receiptId: receipt.id, pending: false, lastUpdated: new Date().toISOString(),
  };
  io.write('transactions.json', [...(io.read('transactions.json') || []), tx]);
  await query(`UPDATE receipts SET txn_id=$1, payment_method='cash', match_status='matched' WHERE id=$2 AND user_id=$3`, [id, receipt.id, userId]);
  await query(`INSERT INTO matched_transaction_sources (id,user_id,transaction_id,source_transaction_id,source_role,match_confidence)
     VALUES ($1,$2,$3,$4,'receipt',1.0) ON CONFLICT (transaction_id, source_transaction_id) DO UPDATE SET match_confidence=1.0, updated_at=NOW()`,
    [crypto.randomUUID(), userId, id, 'rcptxn_' + receipt.id]);
  return tx;
}

// Handle a "yes/no" answer to the cash question → { replies }.
async function handleCashAnswer(query, io, userId, q, text) {
  const yes = /^\s*(yes|yeah|yep|y|cash|it was cash|paid cash|correct)\s*$/i.test(text);
  const no  = /^\s*(no|nope|n|card|credit|debit|on card)\s*$/i.test(text);
  if (!yes && !no) return { replies: ['Was this a cash purchase? Please reply yes or no.'] };

  const r = await query(`SELECT id, ocr_data, merchant_name, receipt_date, total_amount FROM receipts WHERE id=$1 AND user_id=$2`, [q.payload.receiptId, userId]);
  const rec = r.rows[0];
  await query(`UPDATE txn_messages SET state='answered' WHERE id=$1`, [q.id]);
  if (!rec) return { replies: ['Hmm, I lost track of that receipt — try sending it again.'] };

  if (no) {
    await query(`UPDATE receipts SET payment_method='card' WHERE id=$1 AND user_id=$2`, [rec.id, userId]);
    return { replies: ["👍 Kept on file — I'll match it to your card transaction automatically when Plaid pulls it in."] };
  }
  const tx = await createCashTransaction(query, io, userId, rec);
  const core = require('./categorizer-core');
  await core.enqueueQuestions(query, io, userId, { channel: 'discord', onlyIds: [tx.id] });
  const next = await core.nextPrompt(query, io, userId);
  return { replies: [`✅ Logged ${tx.desc} $${Math.abs(tx.amount).toFixed(2)} as a cash expense.`, next].filter(Boolean) };
}

// ── retroactive matching ──
async function groqPickMatch(merchant, candidates) {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here' || !merchant || !candidates.length) return null;
  const list = candidates.map((t, i) => `${i + 1}. "${t.desc}" on ${t.date} for $${Math.abs(Number(t.amount)).toFixed(2)}`).join('\n');
  try {
    const resp = await axios.post(GROQ_URL,
      { model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', max_tokens: 8, temperature: 0,
        messages: [{ role: 'user', content: `A receipt is from merchant "${merchant}". Which ONE of these bank transactions is the same purchase (same merchant)? Reply with ONLY the number, or 0 if none match.\n${list}` }] },
      { headers: { Authorization: 'Bearer ' + key }, timeout: 15000 });
    const n = Number((resp.data?.choices?.[0]?.message?.content || '').match(/\d+/)?.[0] || 0);
    return (n >= 1 && n <= candidates.length) ? candidates[n - 1] : null;
  } catch { return null; }
}

// Match unmatched, non-cash, active receipts against current transactions. Returns # matched.
async function matchPendingReceipts(query, io, userId, deps = {}) {
  const groqPick = deps.groqPick || groqPickMatch;
  const pend = await query(
    `SELECT id, ocr_data, merchant_name, receipt_date, total_amount FROM receipts
      WHERE user_id=$1 AND txn_id IS NULL AND (payment_method IS NULL OR payment_method <> 'cash')
        AND (review_status IS NULL OR review_status IN ('auto_accepted','user_confirmed'))`, [userId]);
  if (!pend.rows.length) return 0;
  let txns = io.read('transactions.json') || [];
  let matched = 0, changed = false;
  for (const rec of pend.rows) {
    const ocr = rec.ocr_data || {};
    const total = rec.total_amount != null ? Number(rec.total_amount) : (ocr.total != null ? Number(ocr.total) : null);
    const date = ymd(rec.receipt_date) || ocr.date;
    if (total == null) continue;
    const cands = txns.filter(t => t && !t.receiptId && !t.excluded && t.source !== 'cash'
      && Math.abs(Math.abs(Number(t.amount) || 0) - total) <= 0.02 && (!date || daysBetween(t.date, date) <= 3));
    if (!cands.length) continue;
    const pick = cands.length === 1 ? cands[0]
      : (await groqPick(ocr.merchant || rec.merchant_name, cands)) || cands.slice().sort((a, b) => daysBetween(a.date, date) - daysBetween(b.date, date))[0];
    if (!pick) continue;
    await query(`UPDATE receipts SET txn_id=$1, match_status='matched' WHERE id=$2 AND user_id=$3`, [pick.id, rec.id, userId]);
    await query(`INSERT INTO matched_transaction_sources (id,user_id,transaction_id,source_transaction_id,source_role,match_confidence)
       VALUES ($1,$2,$3,$4,'receipt',0.9) ON CONFLICT (transaction_id, source_transaction_id) DO UPDATE SET match_confidence=0.9, updated_at=NOW()`,
      [crypto.randomUUID(), userId, pick.id, 'rcptxn_' + rec.id]);
    txns = txns.map(t => t.id === pick.id ? { ...t, receiptId: rec.id } : t);
    changed = true; matched++;
  }
  if (changed) io.write('transactions.json', txns);
  return matched;
}

module.exports = { createCashQuestion, pendingCashQuestion, handleCashAnswer, createCashTransaction, matchPendingReceipts, groqPickMatch };
