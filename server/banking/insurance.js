'use strict';
/**
 * banking/insurance.js — record a parsed insurance bill into the insurance domain.
 *
 *   upsertInsurancePolicy(query, userId, info) → insurancePolicyId
 *   recordInsuranceStatement(query, io, userId, { policyId, documentId, parsed, carrier })
 *       → { insuranceStatementId, paymentId, matchedTxnId, alerts }
 *   matchPendingPremiums(query, io, userId) → count   (retro paid-detection on Plaid sync)
 *
 * Mirrors banking/mortgage.js: idempotent (deterministic ids; ON CONFLICT upserts),
 * COALESCE-merges so a statement import and any later source land on one policy row,
 * matches the premium payment to a Plaid bank debit, and emits alerts to per-user
 * insurance_alerts.json. Paid = insurance_payments.matched_transaction_id set — the
 * Insurance page's green flag and the reminder engine's silence both derive from it.
 */
const crypto = require('crypto');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'x';
const ym   = (d) => (d ? String(d).slice(0, 7).replace('-', '') : '000000');
const fmt  = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const MON  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fdate = (d) => d ? `${MON[Number(String(d).slice(5, 7)) - 1]} ${Number(String(d).slice(8, 10))}, ${String(d).slice(0, 4)}` : '?';

function insurancePolicyId(userId, { carrier, policyMask, coverageType } = {}) {
  return `ins_${userId}_${slug(carrier)}_${slug(policyMask || coverageType || 'policy')}`;
}

// Advance a due date by the policy's billing frequency (annual default — most property
// policies bill yearly). Keeps the day-of-month; JS Date rolls month-end overflow forward.
function addFrequency(date, frequency) {
  if (!date) return null;
  const months = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }[frequency] || 12;
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Resolve which property a bill insures: fuzzy-match the printed address (or the folder's
// property tag) against the user's properties.json — house number + a street token, or the
// property's name appearing in the text. Nothing hardcoded. Returns property id or null.
function resolvePropertyId(io, address) {
  if (!address) return null;
  const props = (io && typeof io.read === 'function' && io.read('properties.json')) || [];
  const norm  = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const a     = norm(address);
  if (!a) return null;
  const aNum  = (a.match(/\b\d{1,6}\b/) || [])[0] || null;
  for (const p of props) {
    if (!p) continue;
    const name = norm(p.name);
    if (name && a.includes(name)) return p.id;
    const pa = norm(p.address);
    if (!pa) continue;
    const pNum = (pa.match(/\b\d{1,6}\b/) || [])[0] || null;
    if (aNum && pNum && aNum === pNum) {
      // House numbers agree — corroborate with any non-numeric street token.
      const streetTokens = pa.split(' ').filter(t => t.length >= 3 && !/^\d+$/.test(t));
      if (streetTokens.some(t => a.includes(t))) return p.id;
    }
  }
  return null;
}

async function upsertInsurancePolicy(query, userId, info = {}) {
  let id = insurancePolicyId(userId, info);
  // Merge with a row an earlier import already created for this policy — matched by policy
  // last-4 (and carrier when the mask alone is ambiguous) — so one physical policy never
  // splits into two rows even if the carrier renames itself on the bill.
  if (info.policyMask) {
    const existing = await query(
      `SELECT id, carrier FROM insurance_policies WHERE user_id=$1 AND policy_number_mask=$2`,
      [userId, info.policyMask]);
    if (existing.rows.length === 1) id = existing.rows[0].id;
    else if (existing.rows.length > 1) {
      const hit = existing.rows.find(r => slug(r.carrier) === slug(info.carrier));
      if (hit) id = hit.id;
    }
  }
  await query(
    `INSERT INTO insurance_policies
       (id,user_id,property_id,carrier,policy_number,policy_number_mask,coverage_type,premium_amount,billing_frequency,
        period_start,period_end,next_due_date,carrier_phone,carrier_email,carrier_website,carrier_address,insured_address,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       property_id=COALESCE(EXCLUDED.property_id, insurance_policies.property_id),
       carrier=COALESCE(EXCLUDED.carrier, insurance_policies.carrier),
       policy_number=COALESCE(EXCLUDED.policy_number, insurance_policies.policy_number),
       policy_number_mask=COALESCE(EXCLUDED.policy_number_mask, insurance_policies.policy_number_mask),
       coverage_type=COALESCE(EXCLUDED.coverage_type, insurance_policies.coverage_type),
       premium_amount=COALESCE(EXCLUDED.premium_amount, insurance_policies.premium_amount),
       billing_frequency=COALESCE(EXCLUDED.billing_frequency, insurance_policies.billing_frequency),
       period_start=COALESCE(EXCLUDED.period_start, insurance_policies.period_start),
       period_end=COALESCE(EXCLUDED.period_end, insurance_policies.period_end),
       next_due_date=COALESCE(EXCLUDED.next_due_date, insurance_policies.next_due_date),
       carrier_phone=COALESCE(EXCLUDED.carrier_phone, insurance_policies.carrier_phone),
       carrier_email=COALESCE(EXCLUDED.carrier_email, insurance_policies.carrier_email),
       carrier_website=COALESCE(EXCLUDED.carrier_website, insurance_policies.carrier_website),
       carrier_address=COALESCE(EXCLUDED.carrier_address, insurance_policies.carrier_address),
       insured_address=COALESCE(EXCLUDED.insured_address, insurance_policies.insured_address),
       updated_at=NOW()`,
    [id, userId, info.propertyId || null, info.carrier || null, info.policyNumber || null, info.policyMask || null,
     info.coverageType || null, info.premiumAmount ?? null, info.billingFrequency || null,
     info.periodStart || null, info.periodEnd || null, info.nextDueDate || null,
     info.carrierPhone || null, info.carrierEmail || null, info.carrierWebsite || null, info.carrierAddress || null,
     info.insuredAddress || null]
  );
  return id;
}

// Find the Plaid bank debit that paid this premium: amount within $1, date within ±10 days
// of the due date (premiums are often paid early), and either the carrier name or an
// insurance keyword in the description. Amount-only is too weak to claim a match.
function matchPremiumToBankTxn(io, { date, total, carrier } = {}) {
  if (total == null) return null;
  const txns = (io && typeof io.read === 'function' && io.read('transactions.json')) || [];
  const key  = slug(carrier).slice(0, 6);
  let best = null, bestScore = -1;
  for (const t of txns) {
    if (!t || t.source === 'cash') continue;
    const amt   = Math.abs(Number(t.amount) || 0);
    const exact = Math.abs(amt - Math.abs(total)) <= 0.02;
    if (!exact && Math.abs(amt - Math.abs(total)) > 1.0) continue;
    const dd = (date && t.date) ? Math.abs((new Date(t.date) - new Date(date)) / 86400000) : 99;
    if (dd > 10) continue;
    const desc    = String(t.desc || '').toLowerCase();
    const nameHit = (key && key.length >= 3 && desc.includes(key)) || /insurance|\bins\b|\bins\s|premium/.test(desc);
    if (!nameHit && !exact) continue;
    const score = (nameHit ? 2 : 0) + (exact ? 1 : 0) + (1 - dd / 11);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best ? best.id : null;
}

const mkAlert = (kind, insurancePolicyId, message, data) =>
  ({ id: `ialert_${crypto.randomBytes(5).toString('hex')}`, kind, insurancePolicyId, message, data, createdAt: new Date().toISOString() });

// Append alerts with dedup: re-recording the same bill (repair scripts, re-uploads,
// idempotent replays) must not stack identical alerts. An identical message for the same
// policy replaces the old copy; a premium_paid clears that policy's stale
// payment_unmatched noise (the bill is paid — "no matching transaction" is obsolete).
function appendAlerts(io, alerts) {
  if (!io || typeof io.write !== 'function' || !alerts.length) return;
  let prev = (typeof io.read === 'function' && io.read('insurance_alerts.json')) || [];
  for (const a of alerts) {
    prev = prev.filter(p => !(p.insurancePolicyId === a.insurancePolicyId && p.kind === a.kind && p.message === a.message));
    if (a.kind === 'payment_unmatched')   // one unmatched alert per bill, newest wins
      prev = prev.filter(p => !(p.insurancePolicyId === a.insurancePolicyId && p.kind === 'payment_unmatched'
                                && (p.data?.dueDate || null) === (a.data?.dueDate || null)));
    if (a.kind === 'premium_paid')
      prev = prev.filter(p => !(p.insurancePolicyId === a.insurancePolicyId && p.kind === 'payment_unmatched'));
  }
  io.write('insurance_alerts.json', [...alerts, ...prev].slice(0, 200));   // newest first, capped
}

async function recordInsuranceStatement(query, io, userId, { policyId, documentId, parsed, carrier } = {}) {
  const p = parsed || {};
  const keyDate = p.dueDate || p.statementDate || null;
  const stmtId  = `istmt_${policyId}_${ym(keyDate)}`;

  const prior = (await query(
    `SELECT premium_amount, billing_frequency, policy_number_mask, coverage_type FROM insurance_policies WHERE id=$1`,
    [policyId])).rows[0] || {};
  const billLabel   = keyDate ? `${MON[Number(String(keyDate).slice(5, 7)) - 1]} ${String(keyDate).slice(0, 4)} bill` : 'latest bill';
  const policyLabel = `${carrier || 'carrier'}${prior.coverage_type ? ` ${prior.coverage_type}` : ''}${prior.policy_number_mask ? ` ••••${prior.policy_number_mask}` : ''}`;

  let docId = documentId || null;
  if (docId) { const d = await query(`SELECT 1 FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId]); if (!d.rows.length) docId = null; }

  await query(
    `INSERT INTO insurance_statements
       (id,user_id,insurance_policy_id,document_id,statement_date,due_date,amount_due,period_start,period_end,parser_status,parser_confidence,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       document_id=COALESCE(EXCLUDED.document_id, insurance_statements.document_id),
       statement_date=EXCLUDED.statement_date, due_date=EXCLUDED.due_date, amount_due=EXCLUDED.amount_due,
       period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
       parser_status=EXCLUDED.parser_status, parser_confidence=EXCLUDED.parser_confidence, updated_at=NOW()`,
    [stmtId, userId, policyId, docId, p.statementDate || null, p.dueDate || null, p.amountDue ?? null,
     p.periodStart || null, p.periodEnd || null, p.parserStatus || 'parsed', p.confidence ?? null]
  );

  // One payment slot per bill; try to match it to the bank debit right away.
  const payId = `ipay_${stmtId}`;
  let matchedTxnId = null;
  try { matchedTxnId = matchPremiumToBankTxn(io, { date: p.dueDate || p.statementDate, total: p.amountDue, carrier }); } catch {}
  await query(
    `INSERT INTO insurance_payments
       (id,user_id,insurance_policy_id,insurance_statement_id,payment_date,amount,matched_transaction_id,method,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       amount=EXCLUDED.amount,
       matched_transaction_id=COALESCE(EXCLUDED.matched_transaction_id, insurance_payments.matched_transaction_id),
       updated_at=NOW()`,
    [payId, userId, policyId, stmtId, matchedTxnId ? (p.dueDate || p.statementDate || null) : null,
     p.amountDue ?? null, matchedTxnId, matchedTxnId ? 'bank' : null]
  );

  // Roll the policy's current figures forward. The bill's due date is authoritative for
  // next_due_date — unless this bill is already paid, in which case advance by frequency.
  const freq = p.billingFrequency || prior.billing_frequency || 'annual';
  const nextDue = matchedTxnId ? addFrequency(p.dueDate, freq) : (p.dueDate || null);
  await query(
    `UPDATE insurance_policies SET
       premium_amount=COALESCE($2, premium_amount),
       next_due_date=COALESCE($3, next_due_date),
       period_start=COALESCE($4, period_start), period_end=COALESCE($5, period_end), updated_at=NOW()
     WHERE id=$1`,
    [policyId, p.amountDue ?? null, nextDue, p.periodStart || null, p.periodEnd || null]
  );

  const alerts = [];
  const changed = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) > 0.01;
  if (changed(prior.premium_amount, p.amountDue))
    alerts.push(mkAlert('premium_changed', policyId, `Premium changed from $${fmt(prior.premium_amount)} to $${fmt(p.amountDue)} on the ${billLabel} (${policyLabel}).`, { from: Number(prior.premium_amount), to: Number(p.amountDue), statementDate: p.statementDate || null }));
  if (matchedTxnId)
    alerts.push(mkAlert('premium_paid', policyId, `The $${fmt(p.amountDue)} ${billLabel} (${policyLabel}) is paid — matched to a bank transaction.`, { amount: Number(p.amountDue), transactionId: matchedTxnId }));
  else if (p.amountDue != null)
    alerts.push(mkAlert('payment_unmatched', policyId, `The $${fmt(p.amountDue)} ${billLabel} (${policyLabel}, due ${fdate(p.dueDate)}) has no matching bank transaction yet.`, { amount: Number(p.amountDue), dueDate: p.dueDate || null }));
  appendAlerts(io, alerts);

  return { insuranceStatementId: stmtId, paymentId: payId, matchedTxnId, alerts };
}

// Retro paid-detection: on every Plaid sync, try to match still-unpaid premiums against the
// (possibly newly arrived) bank feed. On a match the bill flips paid, the policy's
// next_due_date advances a cycle, and the reminder engine goes quiet — all derived, no flags.
async function matchPendingPremiums(query, io, userId) {
  const { rows } = await query(
    `SELECT pay.id AS payment_id, pay.amount, s.due_date, s.statement_date,
            pol.id AS policy_id, pol.carrier, pol.billing_frequency, pol.next_due_date
       FROM insurance_payments pay
       JOIN insurance_statements s   ON s.id = pay.insurance_statement_id
       JOIN insurance_policies  pol  ON pol.id = pay.insurance_policy_id
      WHERE pay.user_id=$1 AND pay.matched_transaction_id IS NULL AND pay.amount IS NOT NULL`,
    [userId]);
  let matched = 0;
  for (const r of rows) {
    const due = r.due_date ? String(r.due_date).slice(0, 10) : (r.statement_date ? String(r.statement_date).slice(0, 10) : null);
    let txnId = null;
    try { txnId = matchPremiumToBankTxn(io, { date: due, total: Number(r.amount), carrier: r.carrier }); } catch {}
    if (!txnId) continue;
    await query(
      `UPDATE insurance_payments SET matched_transaction_id=$2, payment_date=COALESCE(payment_date,$3), method=COALESCE(method,'bank'), updated_at=NOW() WHERE id=$1`,
      [r.payment_id, txnId, due]);
    // Advance the cycle only if this bill's due date is the one the policy is waiting on.
    const nd = r.next_due_date ? String(r.next_due_date).slice(0, 10) : null;
    if (due && (!nd || due >= nd)) {
      await query(`UPDATE insurance_policies SET next_due_date=$2, updated_at=NOW() WHERE id=$1`,
        [r.policy_id, addFrequency(due, r.billing_frequency || 'annual')]);
    }
    appendAlerts(io, [mkAlert('premium_paid', r.policy_id,
      `The $${fmt(r.amount)} ${r.carrier || 'insurance'} bill due ${fdate(due)} is paid — matched to a bank transaction.`,
      { amount: Number(r.amount), transactionId: txnId })]);
    matched++;
  }
  return matched;
}

module.exports = { insurancePolicyId, upsertInsurancePolicy, recordInsuranceStatement,
                   matchPremiumToBankTxn, matchPendingPremiums, resolvePropertyId, addFrequency };
