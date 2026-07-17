'use strict';
/**
 * tax/schedule.js — record extracted tax payment schedules + retro paid-detection.
 *
 *   recordTaxSchedule(query, io, userId, { documentId, extracted }) → { rows, refunds }
 *   matchPendingTaxPayments(query, io, userId) → count       (hooked into Plaid sync)
 *   router() — GET /api/tax-schedule (upcoming payments + expected refunds)
 *
 * Idempotent: row ids are deterministic per (document, installment label), so replaying a
 * document never duplicates. Refund rows get status='refund_expected' and are surfaced in
 * the UI but never nagged by the reminder engine.
 */
const crypto = require('crypto');
const express = require('express');
const { query: dbQuery } = require('../core/db');

const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const MON  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fdate = (d) => d ? `${MON[Number(String(d).slice(5, 7)) - 1]} ${Number(String(d).slice(8, 10))}, ${String(d).slice(0, 4)}` : '?';

// Same property-resolution heuristic the insurance domain uses.
const { resolvePropertyId } = require('../banking/insurance');

const KIND_BY_DOC = {
  property_tax_bill: 'property_tax',
  estimated_tax_voucher: 'estimated_tax',
  balance_due_notice: 'balance_due',
  tax_return: 'balance_due',
};

async function recordTaxSchedule(query, io, userId, { documentId, extracted } = {}) {
  const x = extracted || {};
  let docId = documentId || null;
  if (docId) { const d = await query(`SELECT 1 FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId]); if (!d.rows.length) docId = null; }
  const propertyId = resolvePropertyId(io, x.propertyAddress);
  const kind = KIND_BY_DOC[x.docKind] || 'balance_due';

  let rows = 0, refunds = 0;
  for (const inst of (x.installments || [])) {
    if (!inst.dueDate && inst.amount == null) continue;
    // Skip ancient installments — a years-old bill shouldn't spawn "overdue" nags.
    if (inst.dueDate && (Date.now() - Date.parse(inst.dueDate)) > 366 * 86400000) continue;
    const id = `txsch_${userId}_${sha8(`${docId || 'nodoc'}|${inst.label}|${inst.dueDate || ''}`)}`;
    await query(
      `INSERT INTO tax_payment_schedule
         (id,user_id,source_document_id,kind,label,authority,tax_year,due_date,amount,status,property_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unpaid',$10,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET
         due_date=EXCLUDED.due_date, amount=EXCLUDED.amount,
         authority=COALESCE(EXCLUDED.authority, tax_payment_schedule.authority),
         property_id=COALESCE(EXCLUDED.property_id, tax_payment_schedule.property_id), updated_at=NOW()`,
      [id, userId, docId, kind, inst.label, x.authority || null, x.taxYear || null,
       inst.dueDate || null, inst.amount ?? null, propertyId]
    );
    rows++;
  }
  if (x.refund && x.refund.expected) {
    const id = `txsch_${userId}_${sha8(`${docId || 'nodoc'}|refund|${x.taxYear || ''}`)}`;
    await query(
      `INSERT INTO tax_payment_schedule
         (id,user_id,source_document_id,kind,label,authority,tax_year,due_date,amount,status,property_id,created_at,updated_at)
       VALUES ($1,$2,$3,'refund',$4,$5,$6,NULL,$7,'refund_expected',NULL,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET
         amount=EXCLUDED.amount, authority=COALESCE(EXCLUDED.authority, tax_payment_schedule.authority), updated_at=NOW()`,
      [id, userId, `Expected refund${x.taxYear ? ` (${x.taxYear})` : ''}`, x.authority || null, x.taxYear || null, x.refund.amount ?? null]
    );
    refunds++;
  }
  return { rows, refunds, propertyId };
}

// Find the bank debit that paid a tax installment: amount within $1 (county bills are
// exact), date −10/+5 days around due, and a tax-authority keyword in the description.
function matchTaxToBankTxn(io, { dueDate, amount, authority } = {}) {
  if (amount == null) return null;
  const txns = (io && typeof io.read === 'function' && io.read('transactions.json')) || [];
  const authKey = String(authority || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 6);
  let best = null, bestScore = -1;
  for (const t of txns) {
    if (!t || t.source === 'cash') continue;
    const amt = Math.abs(Number(t.amount) || 0);
    const exact = Math.abs(amt - Math.abs(amount)) <= 0.02;
    if (!exact && Math.abs(amt - Math.abs(amount)) > 1.0) continue;
    const dd = (dueDate && t.date) ? (new Date(t.date) - new Date(dueDate)) / 86400000 : 99;
    if (dd < -10 || dd > 5) continue;
    const desc = String(t.desc || '').toLowerCase();
    const nameHit = (authKey.length >= 3 && desc.replace(/[^a-z0-9]+/g, '').includes(authKey))
                 || /\btax\b|county|irs|us\s*treasury|\bftb\b|franchise/.test(desc);
    if (!nameHit && !exact) continue;
    const score = (nameHit ? 2 : 0) + (exact ? 1 : 0) + (1 - Math.abs(dd) / 11);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best ? best.id : null;
}

// Retro paid-detection on every Plaid sync — flips installments to 'paid' so the reminder
// engine goes quiet. Idempotent; safe under the multi-instance cron.
async function matchPendingTaxPayments(query, io, userId) {
  const { rows } = await query(
    `SELECT id, due_date, amount, authority FROM tax_payment_schedule
      WHERE user_id=$1 AND status='unpaid' AND amount IS NOT NULL`, [userId]);
  let matched = 0;
  for (const r of rows) {
    const due = r.due_date ? String(r.due_date).slice(0, 10) : null;
    let txnId = null;
    try { txnId = matchTaxToBankTxn(io, { dueDate: due, amount: Number(r.amount), authority: r.authority }); } catch {}
    if (!txnId) continue;
    await query(`UPDATE tax_payment_schedule SET status='paid', matched_transaction_id=$2, updated_at=NOW() WHERE id=$1`, [r.id, txnId]);
    matched++;
  }
  return matched;
}

// GET /api/tax-schedule — upcoming/unpaid payments + expected refunds, soonest first.
function router() {
  const r = express.Router();
  r.get('/', async (req, res) => {
    try {
      const { rows } = await dbQuery(
        `SELECT * FROM tax_payment_schedule WHERE user_id=$1
          ORDER BY (status='unpaid') DESC, due_date ASC NULLS LAST, created_at DESC`, [req.user.id]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return r;
}

module.exports = { recordTaxSchedule, matchPendingTaxPayments, matchTaxToBankTxn, router, _fdate: fdate };
