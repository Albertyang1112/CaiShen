'use strict';
/**
 * banking/liabilities.js — pulls Plaid Liabilities (mortgage detail) into the mortgage tables.
 *
 * Called best-effort from every Plaid sync (banking/plaid.js syncUser). For each mortgage on
 * the item it upserts one mortgage_accounts row (rate, term, escrow, payoff, YTD interest —
 * the snapshot Plaid provides) and records the last payment as a mortgage_payments row.
 * Plaid only ever reports the MOST RECENT payment, so payment history accumulates one row
 * per new payment across syncs; the principal/interest/escrow split stays NULL here (that
 * comes from statement PDFs via banking/mortgage.js — the two sources complement each other).
 *
 * Items without liabilities consent return ADDITIONAL_CONSENT_REQUIRED — reported back as
 * { needsConsent: true } so the sync log can point at the "Loan data" button, never thrown.
 */
const { query } = require('../core/db');

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Best-effort: link a Plaid mortgage to one of the user's properties by street/name overlap.
// Conservative — returns null unless something clearly matches (a wrong link is worse than none).
function matchPropertyId(properties, addr) {
  if (!addr) return null;
  const street = norm(addr.street);
  if (!street) return null;
  for (const p of properties || []) {
    const pStreet = norm((p.address || '').split(',')[0]);
    const pName   = norm(p.name || '');
    if (pStreet && (street.includes(pStreet) || pStreet.includes(street))) return p.id;
    if (pName && street.includes(pName)) return p.id;
  }
  return null;
}

async function syncItemLiabilities(plaidClient, userId, connection, io) {
  const { access_token, institution_name } = connection;
  let resp;
  try {
    resp = await plaidClient.liabilitiesGet({ access_token });
  } catch (e) {
    const code = e.response?.data?.error_code || '';
    // Not consented / not supported on this item — a normal state, not an error.
    if (['ADDITIONAL_CONSENT_REQUIRED', 'INVALID_PRODUCT', 'PRODUCTS_NOT_SUPPORTED', 'PRODUCT_NOT_READY'].includes(code)) {
      return { needsConsent: code === 'ADDITIONAL_CONSENT_REQUIRED', skipped: code };
    }
    throw e;
  }

  const mortgages = resp.data.liabilities?.mortgage || [];
  if (!mortgages.length) return { mortgages: 0, payments: 0 };

  const accountsById = new Map((resp.data.accounts || []).map(a => [a.account_id, a]));
  const properties   = io.read('properties.json') || [];
  // FK guard: mortgage_accounts.account_id references accounts(id) — only link if mirrored.
  const acctRes    = await query(`SELECT id FROM accounts WHERE user_id = $1`, [userId]);
  const validAccts = new Set(acctRes.rows.map(r => r.id));

  let payments = 0;
  for (const m of mortgages) {
    const acct = accountsById.get(m.account_id) || {};
    const addr = m.property_address || {};
    const mask = (m.account_number || '').slice(-4) || null;
    // Merge with a row the statement-import path already created for this loan (matched by
    // linked account or loan last-4) instead of inserting a duplicate ma_plaid_* row.
    let id = `ma_plaid_${m.account_id}`;
    const existing = await query(
      `SELECT id FROM mortgage_accounts WHERE user_id=$1
        AND (account_id=$2 OR ($3::text IS NOT NULL AND loan_number_mask=$3)) LIMIT 1`,
      [userId, m.account_id, mask]);
    if (existing.rows.length) id = existing.rows[0].id;

    await query(
      `INSERT INTO mortgage_accounts
         (id, user_id, account_id, property_id, servicer, loan_number_mask,
          original_principal, interest_rate, current_principal, escrow_balance,
          monthly_payment, next_due_date, rate_type, loan_term, loan_type,
          origination_date, maturity_date, has_pmi, has_prepayment_penalty,
          past_due_amount, current_late_fee, ytd_interest_paid, ytd_principal_paid,
          property_street, property_city, property_region, property_postal_code, loan_number, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
       ON CONFLICT (id) DO UPDATE SET
         account_id=EXCLUDED.account_id, servicer=EXCLUDED.servicer, loan_number_mask=EXCLUDED.loan_number_mask,
         loan_number=COALESCE(EXCLUDED.loan_number, mortgage_accounts.loan_number),
         original_principal=EXCLUDED.original_principal, interest_rate=EXCLUDED.interest_rate,
         current_principal=EXCLUDED.current_principal, escrow_balance=EXCLUDED.escrow_balance,
         monthly_payment=EXCLUDED.monthly_payment, next_due_date=EXCLUDED.next_due_date,
         rate_type=EXCLUDED.rate_type, loan_term=EXCLUDED.loan_term, loan_type=EXCLUDED.loan_type,
         origination_date=EXCLUDED.origination_date, maturity_date=EXCLUDED.maturity_date,
         has_pmi=EXCLUDED.has_pmi, has_prepayment_penalty=EXCLUDED.has_prepayment_penalty,
         past_due_amount=EXCLUDED.past_due_amount, current_late_fee=EXCLUDED.current_late_fee,
         ytd_interest_paid=EXCLUDED.ytd_interest_paid, ytd_principal_paid=EXCLUDED.ytd_principal_paid,
         property_street=EXCLUDED.property_street, property_city=EXCLUDED.property_city,
         property_region=EXCLUDED.property_region, property_postal_code=EXCLUDED.property_postal_code,
         property_id=COALESCE(mortgage_accounts.property_id, EXCLUDED.property_id),  -- a manual link always wins
         updated_at=NOW()`,
      [id, userId,
       validAccts.has(m.account_id) ? m.account_id : null,
       matchPropertyId(properties, addr),
       institution_name || null,
       mask,
       m.origination_principal_amount ?? null,
       m.interest_rate?.percentage ?? null,
       acct.balances?.current ?? null,
       m.escrow_balance ?? null,
       m.next_monthly_payment ?? null,
       m.next_payment_due_date || null,
       m.interest_rate?.type || null,
       m.loan_term || null,
       m.loan_type_description || null,
       m.origination_date || null,
       m.maturity_date || null,
       m.has_pmi ?? null,
       m.has_prepayment_penalty ?? null,
       m.past_due_amount ?? null,
       m.current_late_fee ?? null,
       m.ytd_interest_paid ?? null,
       m.ytd_principal_paid ?? null,
       addr.street || null, addr.city || null, addr.region || null, addr.postal_code || null,
       m.account_number || null]
    );

    // Plaid reports only the latest payment; a deterministic id makes re-syncs idempotent
    // and each genuinely-new payment date adds one new row over time.
    if (m.last_payment_date) {
      const r = await query(
        `INSERT INTO mortgage_payments (id, user_id, mortgage_account_id, payment_date, total_paid)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [`mp_plaid_${m.account_id}_${m.last_payment_date}`, userId, id, m.last_payment_date, m.last_payment_amount ?? null]
      );
      payments += r.rowCount || 0;
    }
  }
  return { mortgages: mortgages.length, payments };
}

module.exports = { syncItemLiabilities, matchPropertyId };
