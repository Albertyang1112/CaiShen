'use strict';
/**
 * coa-map.js — Map a Chart-of-Accounts account to a tax classification.
 *
 * When a user assigns a transaction to a COA account (tx.coaId), that explicit
 * choice should drive its tax treatment — it's more reliable than a regex on the
 * description. The account's TYPE (income/expense/asset/liability/equity) and
 * SUBTYPE decide the tax category, schedule, and form line. A `propertyId` marks
 * a rental property (Schedule E) vs a personal residence (Schedule A / personal).
 *
 * Returns a rules-engine-compatible classification, or null when the account
 * doesn't imply a tax treatment (so the description rules get a chance instead).
 */
const { TAX_CATEGORIES } = require('../tax-history');

function make(taxCategory, deductibilityPct) {
  const meta = TAX_CATEGORIES[taxCategory] || {};
  let schedule = meta.schedule != null ? meta.schedule : null;
  if (schedule == null) {                                  // fallbacks for categories
    if (taxCategory.startsWith('rental_'))   schedule = 'E';   // not in TAX_CATEGORIES
    else if (taxCategory.startsWith('business_')) schedule = 'C';
  }
  return {
    taxCategory,
    deductibilityPct: deductibilityPct != null ? deductibilityPct
                      : (meta.deductPct != null ? meta.deductPct : 1.0),
    businessUsePct: 1.0,
    schedule,
    formLine: meta.form != null ? meta.form : null,
    normalizedBy: 'coa',
    confidence: 1.0,
  };
}

function classifyByCoa(account) {
  if (!account) return null;
  const t  = account.type;
  const st = String(account.subtype || '').toLowerCase();
  const isRental = !!account.propertyId;   // property-linked → rental (Schedule E)

  if (t === 'income') {
    if (st === 'wage')     return make('wages');
    if (st === 'rental')   return make('rental_income');
    if (st === 'interest') return make('interest_taxable');
    if (st === 'dividend') return make('dividends_ordinary');
    return make('other_income');           // RSU/stock/other income → Schedule 1
  }

  if (t === 'expense') {
    if (isRental) {                          // rental-property expenses → Schedule E
      if (st === 'mortgage')    return make('rental_mortgage_int');
      if (st === 'tax')         return make('rental_taxes');
      if (st === 'insurance')   return make('rental_insurance');
      if (st === 'management')  return make('rental_management');
      if (st === 'maintenance') return make('rental_repairs');
      if (st === 'utilities')   return make('rental_utilities');
      return make('rental_other');
    }
    if (st === 'mortgage') return make('mortgage_interest');  // primary-residence interest → Sch A
    if (st === 'tax')      return make('property_tax');       // SALT → Sch A
    // Personal living expenses — explicitly non-deductible for an individual,
    // so they're recorded as 'personal' (ignored by the aggregator) rather than
    // left as review noise.
    if (['personal', 'subscription', 'hoa', 'maintenance', 'utilities', 'management', 'professional', 'insurance', 'other'].includes(st))
      return make('personal');
    return null;  // unknown expense subtype → let the description rules try
  }

  // Asset / liability / equity = a balance-sheet movement (transfer between your
  // own accounts, debt paydown, capital contribution) — not income or a deduction.
  // Exclude it from tax explicitly so it doesn't sit in "needs review".
  if (t === 'asset' || t === 'liability' || t === 'equity') return make('personal');

  return null;
}

module.exports = { classifyByCoa };
