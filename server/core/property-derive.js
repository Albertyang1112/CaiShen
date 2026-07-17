'use strict';
/**
 * core/property-derive.js — overlay live, document-derived numbers onto portfolio
 * properties. The property record stores only what the user knows (name, address,
 * color); the financial fields are READ from the linked mortgage/insurance/tax rows
 * at request time — a newly ingested statement updates the Properties page with no
 * write-backs and nothing to go stale.
 *
 * Derived per property (rows linked by their .property_id soft ref):
 *   mortgage        Σ current_principal of linked mortgage_accounts
 *   rate            interest_rate of the largest linked loan
 *   monthlyPayment  Σ monthly_payment of linked loans
 *   exp             latest escrow portion per loan (mortgage_payments)
 *                   + standalone insurance premiums monthly-ized by billing_frequency
 *                   + property-tax bills monthly-ized (skipped when escrow exists —
 *                     an escrowed loan already pays tax+insurance through the payment)
 * Stored legacy values remain the fallback when nothing is linked.
 */

const FREQ_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round(v * 100) / 100;

async function deriveProperties(query, userId, props) {
  if (!Array.isArray(props) || !props.length) return props || [];

  const [morts, escrows, pols, taxes] = await Promise.all([
    query(`SELECT id, property_id, current_principal, interest_rate, monthly_payment
             FROM mortgage_accounts WHERE user_id=$1 AND property_id IS NOT NULL`, [userId]),
    query(`SELECT DISTINCT ON (mortgage_account_id) mortgage_account_id, escrow_portion
             FROM mortgage_payments WHERE user_id=$1
            ORDER BY mortgage_account_id, payment_date DESC NULLS LAST`, [userId]),
    query(`SELECT property_id, premium_amount, billing_frequency
             FROM insurance_policies
            WHERE user_id=$1 AND property_id IS NOT NULL AND premium_amount IS NOT NULL`, [userId]),
    query(`SELECT property_id, tax_year, SUM(amount) AS total
             FROM tax_payment_schedule
            WHERE user_id=$1 AND kind='property_tax' AND property_id IS NOT NULL AND amount IS NOT NULL
            GROUP BY property_id, tax_year`, [userId]),
  ]);

  const escrowByLoan = new Map(escrows.rows.map(e => [e.mortgage_account_id, num(e.escrow_portion)]));
  // Most recent tax year's total per property → monthly equivalent.
  const taxByProp = new Map();
  for (const t of taxes.rows) {
    const cur = taxByProp.get(t.property_id);
    if (!cur || Number(t.tax_year) > cur.year) taxByProp.set(t.property_id, { year: Number(t.tax_year), total: num(t.total) });
  }

  return props.map(p => {
    const loans    = morts.rows.filter(m => m.property_id === p.id);
    const policies = pols.rows.filter(x => x.property_id === p.id);
    const mortgage = loans.reduce((s, m) => s + num(m.current_principal), 0);
    const biggest  = loans.reduce((a, b) => (a && num(a.current_principal) >= num(b.current_principal) ? a : b), loans[0] || null);
    const monthlyPayment = loans.reduce((s, m) => s + num(m.monthly_payment), 0);
    const escrowMo    = loans.reduce((s, m) => s + (escrowByLoan.get(m.id) || 0), 0);
    const insuranceMo = policies.reduce((s, x) => s + num(x.premium_amount) / (FREQ_MONTHS[x.billing_frequency] || 12), 0);
    const taxMo       = escrowMo > 0 ? 0 : (taxByProp.get(p.id) ? taxByProp.get(p.id).total / 12 : 0);
    const anyDerived  = loans.length > 0 || policies.length > 0 || taxMo > 0;
    return {
      ...p,
      mortgage: loans.length ? r2(mortgage) : num(p.mortgage),
      rate:     biggest && biggest.interest_rate != null ? Number(biggest.interest_rate) : num(p.rate),
      monthlyPayment: monthlyPayment ? r2(monthlyPayment) : undefined,
      exp: anyDerived ? r2(escrowMo + insuranceMo + taxMo) : num(p.exp),
      derived: anyDerived
        ? { loans: loans.length, policies: policies.length, escrowMo: r2(escrowMo), insuranceMo: r2(insuranceMo), taxMo: r2(taxMo) }
        : undefined,
    };
  });
}

module.exports = { deriveProperties, FREQ_MONTHS };
