'use strict';
/**
 * banking/mortgage.js — record a parsed mortgage statement into the mortgage domain.
 *
 *   upsertMortgageAccount(query, userId, info) → mortgageAccountId
 *   recordMortgageStatement(query, io, userId, { mortgageAccountId, documentId, parsed, … })
 *       → { mortgageStatementId, paymentId, matchedTxnId, alerts }
 *
 * Idempotent (deterministic ids; ON CONFLICT upserts). Updates the account's rolling
 * current_principal / escrow_balance / monthly_payment / next_due_date, tries to match the
 * payment to a Plaid bank debit, and emits alerts (payment changed, escrow changed, payment
 * unmatched) to per-user mortgage_alerts.json. Best-effort: callers wrap in try/catch.
 */
const crypto = require('crypto');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'x';
const ym   = (d) => (d ? String(d).slice(0, 7).replace('-', '') : '000000');
const fmt  = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function mortgageAccountId(userId, { servicer, propertyId, loanMask } = {}) {
  return `mort_${userId}_${slug(servicer)}_${slug(propertyId || loanMask || 'loan')}`;
}

async function upsertMortgageAccount(query, userId, info = {}) {
  const id = mortgageAccountId(userId, info);
  let accountId = null;
  if (info.accountId) {
    const a = await query(`SELECT 1 FROM accounts WHERE id=$1 AND user_id=$2`, [info.accountId, userId]);
    if (a.rows.length) accountId = info.accountId;
  }
  await query(
    `INSERT INTO mortgage_accounts (id,user_id,account_id,property_id,servicer,loan_number_mask,interest_rate,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       account_id=COALESCE(EXCLUDED.account_id, mortgage_accounts.account_id),
       property_id=COALESCE(EXCLUDED.property_id, mortgage_accounts.property_id),
       servicer=COALESCE(EXCLUDED.servicer, mortgage_accounts.servicer),
       loan_number_mask=COALESCE(EXCLUDED.loan_number_mask, mortgage_accounts.loan_number_mask),
       interest_rate=COALESCE(EXCLUDED.interest_rate, mortgage_accounts.interest_rate), updated_at=NOW()`,
    [id, userId, accountId, info.propertyId || null, info.servicer || null, info.loanMask || null, info.interestRate ?? null]
  );
  return id;
}

// Find the Plaid bank debit that paid this mortgage: amount within $1 (servicers round),
// date within ±7 days, and either the servicer name or a mortgage/loan keyword in the desc.
// Returns transactions.id or null. Pure read of io's transactions.json (exported for tests).
function matchPaymentToBankTxn(io, { date, total, servicer } = {}) {
  if (total == null) return null;
  const txns = (io && typeof io.read === 'function' && io.read('transactions.json')) || [];
  const key  = slug(servicer).slice(0, 5);
  let best = null, bestScore = -1;
  for (const t of txns) {
    if (!t || t.source === 'cash') continue;
    const amt   = Math.abs(Number(t.amount) || 0);
    const exact = Math.abs(amt - Math.abs(total)) <= 0.02;
    if (!exact && Math.abs(amt - Math.abs(total)) > 1.0) continue;
    const dd = (date && t.date) ? Math.abs((new Date(t.date) - new Date(date)) / 86400000) : 99;
    if (dd > 7) continue;
    const desc    = String(t.desc || '').toLowerCase();
    const nameHit = (key && key.length >= 3 && desc.includes(key)) || /mortgage|home\s*loan|loan\s*pmt|\bloan\b/.test(desc);
    if (!nameHit && !exact) continue;                       // amount-only is too weak to claim a match
    const score = (nameHit ? 2 : 0) + (exact ? 1 : 0) + (1 - dd / 8);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best ? best.id : null;
}

const mkAlert = (kind, mortgageAccountId, message, data) =>
  ({ id: `malert_${crypto.randomBytes(5).toString('hex')}`, kind, mortgageAccountId, message, data, createdAt: new Date().toISOString() });

function appendAlerts(io, alerts) {
  if (!io || typeof io.write !== 'function' || !alerts.length) return;
  const prev = (typeof io.read === 'function' && io.read('mortgage_alerts.json')) || [];
  io.write('mortgage_alerts.json', [...alerts, ...prev].slice(0, 200));   // newest first, capped
}

async function recordMortgageStatement(query, io, userId, { mortgageAccountId, documentId, parsed, servicer } = {}) {
  const p = parsed || {};
  const sDate  = p.statementDate || null;
  const stmtId = `mstmt_${mortgageAccountId}_${ym(sDate)}`;

  const prior = (await query(`SELECT monthly_payment, escrow_balance FROM mortgage_accounts WHERE id=$1`, [mortgageAccountId])).rows[0] || {};

  let docId = documentId || null;
  if (docId) { const d = await query(`SELECT 1 FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId]); if (!d.rows.length) docId = null; }

  await query(
    `INSERT INTO mortgage_statements
       (id,user_id,mortgage_account_id,document_id,statement_date,due_date,amount_due,principal_balance,escrow_balance,parser_status,parser_confidence,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       document_id=COALESCE(EXCLUDED.document_id, mortgage_statements.document_id),
       statement_date=EXCLUDED.statement_date, due_date=EXCLUDED.due_date, amount_due=EXCLUDED.amount_due,
       principal_balance=EXCLUDED.principal_balance, escrow_balance=EXCLUDED.escrow_balance,
       parser_status=EXCLUDED.parser_status, parser_confidence=EXCLUDED.parser_confidence, updated_at=NOW()`,
    [stmtId, userId, mortgageAccountId, docId, sDate, p.dueDate || null, p.amountDue ?? null,
     p.principalBalance ?? null, p.escrowBalance ?? null, p.parserStatus || 'parsed', p.confidence ?? null]
  );

  // One payment per statement; try to match it to the bank debit.
  const payId     = `mpay_${stmtId}`;
  const totalPaid = p.totalPaid ?? p.amountDue ?? null;
  let matchedTxnId = null;
  try { matchedTxnId = matchPaymentToBankTxn(io, { date: p.dueDate || sDate, total: totalPaid, servicer }); } catch {}
  await query(
    `INSERT INTO mortgage_payments
       (id,user_id,mortgage_account_id,mortgage_statement_id,payment_date,total_paid,principal_portion,interest_portion,escrow_portion,matched_transaction_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       payment_date=EXCLUDED.payment_date, total_paid=EXCLUDED.total_paid,
       principal_portion=EXCLUDED.principal_portion, interest_portion=EXCLUDED.interest_portion,
       escrow_portion=EXCLUDED.escrow_portion,
       matched_transaction_id=COALESCE(EXCLUDED.matched_transaction_id, mortgage_payments.matched_transaction_id), updated_at=NOW()`,
    [payId, userId, mortgageAccountId, stmtId, p.dueDate || sDate || null, totalPaid,
     p.principalPaid ?? null, p.interestPaid ?? null, p.escrowPaid ?? null, matchedTxnId]
  );

  // Escrow activity for this statement (rebuilt by statement id).
  await query(`DELETE FROM mortgage_escrow_transactions WHERE mortgage_statement_id=$1`, [stmtId]);
  for (const e of (Array.isArray(p.escrowActivity) ? p.escrowActivity : [])) {
    await query(
      `INSERT INTO mortgage_escrow_transactions (id,user_id,mortgage_account_id,mortgage_statement_id,date,type,description,amount,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [`mesc_${stmtId}_${crypto.randomBytes(3).toString('hex')}`, userId, mortgageAccountId, stmtId, e.date || sDate || null, e.type || null, e.desc || null, e.amount ?? null]
    );
  }

  // Roll the account's current figures forward.
  await query(
    `UPDATE mortgage_accounts SET
       current_principal=COALESCE($2, current_principal), escrow_balance=COALESCE($3, escrow_balance),
       monthly_payment=COALESCE($4, monthly_payment), next_due_date=COALESCE($5, next_due_date), updated_at=NOW()
     WHERE id=$1`,
    [mortgageAccountId, p.principalBalance ?? null, p.escrowBalance ?? null, p.amountDue ?? null, p.dueDate ?? null]
  );

  // Alerts.
  const alerts = [];
  const changed = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) > 0.01;
  if (changed(prior.monthly_payment, p.amountDue))
    alerts.push(mkAlert('payment_changed', mortgageAccountId, `Monthly payment changed from $${fmt(prior.monthly_payment)} to $${fmt(p.amountDue)}.`, { from: Number(prior.monthly_payment), to: Number(p.amountDue) }));
  if (changed(prior.escrow_balance, p.escrowBalance))
    alerts.push(mkAlert('escrow_changed', mortgageAccountId, `Escrow balance changed from $${fmt(prior.escrow_balance)} to $${fmt(p.escrowBalance)}.`, { from: Number(prior.escrow_balance), to: Number(p.escrowBalance) }));
  if (totalPaid != null && !matchedTxnId)
    alerts.push(mkAlert('payment_unmatched', mortgageAccountId, `Mortgage payment of $${fmt(totalPaid)} (${servicer || 'servicer'}) has no matching bank transaction yet.`, { amount: Number(totalPaid) }));
  appendAlerts(io, alerts);

  return { mortgageStatementId: stmtId, paymentId: payId, matchedTxnId, alerts };
}

module.exports = { mortgageAccountId, upsertMortgageAccount, recordMortgageStatement, matchPaymentToBankTxn };
