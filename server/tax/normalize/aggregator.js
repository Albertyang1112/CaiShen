'use strict';
/**
 * aggregator.js — Roll categorized transactions into an engine TaxInput
 *
 * Pure logic, no I/O — fully unit-testable.
 *
 * Takes an array of categorized items and produces:
 *   { taxInput, breakdown }
 * where taxInput is consumable by tax-engine.calculate() and breakdown explains
 * how each engine field was derived (for the UI + the advisor's data summary).
 *
 * Item shape (works for both freshly-classified items and stored tax_transactions):
 *   { taxCategory, amount, deductibilityPct?, businessUsePct? }
 *   amount sign follows transactions.json: >0 income, <0 expense.
 *   The aggregator uses magnitudes; the category decides where it lands.
 */

// Map a tax category → how it contributes to the engine input.
// kind: 'income' | 'deduction' | 'adjustment' | 'credit' | 'payment'
//        | 'rental_income' | 'rental_expense' | 'business_income' | 'business_expense'
// path: dot-path into the TaxInput object (for income/deduction/adjustment/credit)
const CATEGORY_MAP = {
  // Income
  wages:               { kind: 'income', path: 'income.w2' },
  interest_taxable:    { kind: 'income', path: 'income.taxableInterest' },
  dividends_qualified: { kind: 'income', path: 'income.qualifiedDividends' },
  dividends_ordinary:  { kind: 'income', path: 'income.ordinaryDividends' },
  ira_distribution:    { kind: 'income', path: 'income.iraDistributions' },
  social_security:     { kind: 'income', path: 'income.socialSecurity' },
  capital_gain_lt:     { kind: 'income', path: 'income.ltcg' },
  capital_gain_st:     { kind: 'income', path: 'income.stcg' },
  other_income:        { kind: 'income', path: 'income.otherIncome' },

  // Net-income activities (income minus their own expenses)
  rental_income:       { kind: 'rental_income' },
  business_income:     { kind: 'business_income' },

  // Schedule C business expenses (reduce businessIncome)
  business_advertising:{ kind: 'business_expense' },
  business_car:        { kind: 'business_expense' },
  business_commissions:{ kind: 'business_expense' },
  business_insurance:  { kind: 'business_expense' },
  business_legal:      { kind: 'business_expense' },
  business_meals:      { kind: 'business_expense' },   // deductibilityPct (0.5) applied per-item
  business_office:     { kind: 'business_expense' },
  business_rent:       { kind: 'business_expense' },
  business_supplies:   { kind: 'business_expense' },
  business_travel:     { kind: 'business_expense' },
  business_utilities:  { kind: 'business_expense' },
  business_wages:      { kind: 'business_expense' },
  business_other:      { kind: 'business_expense' },
  home_office:         { kind: 'business_expense' },
  depreciation:        { kind: 'business_expense' },

  // Schedule E rental expenses (reduce scheduleEIncome)
  rental_advertising:  { kind: 'rental_expense' },
  rental_auto:         { kind: 'rental_expense' },
  rental_cleaning:     { kind: 'rental_expense' },
  rental_commissions:  { kind: 'rental_expense' },
  rental_insurance:    { kind: 'rental_expense' },
  rental_legal:        { kind: 'rental_expense' },
  rental_management:   { kind: 'rental_expense' },
  rental_mortgage_int: { kind: 'rental_expense' },
  rental_repairs:      { kind: 'rental_expense' },
  rental_supplies:     { kind: 'rental_expense' },
  rental_taxes:        { kind: 'rental_expense' },
  rental_utilities:    { kind: 'rental_expense' },
  rental_depreciation: { kind: 'rental_expense' },
  rental_other:        { kind: 'rental_expense' },

  // Above-the-line adjustments
  se_health_insurance:   { kind: 'adjustment', path: 'adjustments.selfEmployedHealthInsurance' },
  retirement_contrib:    { kind: 'adjustment', path: 'adjustments.retirementContributions' },
  student_loan_interest: { kind: 'adjustment', path: 'adjustments.studentLoanInterest' },
  hsa_contribution:      { kind: 'adjustment', path: 'adjustments.hsaDeduction' },
  educator_expense:      { kind: 'adjustment', path: 'adjustments.educatorExpenses' },

  // Itemized deductions
  mortgage_interest:   { kind: 'deduction', path: 'deductions.mortgageInterest' },
  property_tax:        { kind: 'deduction', path: 'deductions.stateAndLocalTax' },
  state_income_tax:    { kind: 'deduction', path: 'deductions.stateAndLocalTax' },
  charitable_cash:     { kind: 'deduction', path: 'deductions.charitableContributions' },
  charitable_noncash:  { kind: 'deduction', path: 'deductions.charitableContributions' },
  medical_expense:     { kind: 'deduction', path: 'deductions.medicalExpenses' },
  investment_interest: { kind: 'deduction', path: 'deductions.investmentInterest' },

  // Payments / withholding
  estimated_tax_payment: { kind: 'payment_estimated' },
  w2_withholding:        { kind: 'credit', path: 'credits.w2FederalWithholding' },

  // Non-deductible / review — ignored by the aggregator
  personal:       { kind: 'ignore' },
  non_deductible: { kind: 'ignore' },
  needs_review:   { kind: 'ignore' },
};

function setPath(obj, path, addValue) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  cur[leaf] = (cur[leaf] || 0) + addValue;
}

/**
 * @param {Array} items  categorized items: { taxCategory, amount, deductibilityPct?, businessUsePct? }
 * @param {object} opts   { taxYear, filingStatus, dependents?, qualifyingChildren?, ...passthrough }
 * @returns {{ taxInput: object, breakdown: object }}
 */
function buildTaxInput(items, opts = {}) {
  const taxInput = {
    taxYear:      opts.taxYear || 2024,
    filingStatus: opts.filingStatus || 'single',
    income:       {},
    adjustments:  {},
    deductions:   {},
    credits:      {},
    estimatedPayments: [],
  };

  // Net activity accumulators
  let rentalIncome = 0, rentalExpense = 0;
  let bizIncome = 0,    bizExpense = 0;
  let estimatedTotal = 0;

  // breakdown[category] = { total, count, kind }
  const breakdown = {};
  const track = (cat, kind, value) => {
    if (!breakdown[cat]) breakdown[cat] = { kind, total: 0, count: 0 };
    breakdown[cat].total += value;
    breakdown[cat].count += 1;
  };

  for (const it of items) {
    const cat = it.taxCategory;
    const map = CATEGORY_MAP[cat];
    if (!map || map.kind === 'ignore') { if (cat) track(cat, 'ignore', 0); continue; }

    const magnitude = Math.abs(Number(it.amount) || 0);
    const deduct    = it.deductibilityPct != null ? Number(it.deductibilityPct) : 1.0;
    const bizUse    = it.businessUsePct   != null ? Number(it.businessUsePct)   : 1.0;

    switch (map.kind) {
      case 'income':
        setPath(taxInput, map.path, magnitude);
        track(cat, 'income', magnitude);
        break;
      case 'deduction':
      case 'adjustment':
      case 'credit': {
        const v = magnitude * deduct * bizUse;
        setPath(taxInput, map.path, v);
        track(cat, map.kind, v);
        break;
      }
      case 'payment_estimated':
        estimatedTotal += magnitude;
        track(cat, 'payment', magnitude);
        break;
      case 'rental_income':
        rentalIncome += magnitude; track(cat, 'rental_income', magnitude); break;
      case 'rental_expense': {
        const v = magnitude * deduct * bizUse;
        rentalExpense += v; track(cat, 'rental_expense', v); break;
      }
      case 'business_income':
        bizIncome += magnitude; track(cat, 'business_income', magnitude); break;
      case 'business_expense': {
        const v = magnitude * deduct * bizUse;
        bizExpense += v; track(cat, 'business_expense', v); break;
      }
    }
  }

  // Net rental → Schedule E; net business → Schedule C (can be negative = loss)
  if (rentalIncome || rentalExpense) taxInput.income.scheduleEIncome = round(rentalIncome - rentalExpense);
  if (bizIncome    || bizExpense)    taxInput.income.businessIncome  = round(bizIncome - bizExpense);

  if (estimatedTotal > 0) {
    taxInput.estimatedPayments.push({ quarter: 'aggregated', amount: round(estimatedTotal) });
  }

  // Round all income/deduction/adjustment/credit leaves
  for (const group of ['income', 'adjustments', 'deductions', 'credits']) {
    for (const k of Object.keys(taxInput[group])) {
      taxInput[group][k] = round(taxInput[group][k]);
    }
  }

  // Pass through non-transaction inputs the caller supplied
  if (opts.qualifyingChildren != null) {
    taxInput.credits.qualifyingChildren = opts.qualifyingChildren;
  }
  if (opts.otherDependents != null) {
    taxInput.credits.otherDependents = opts.otherDependents;
  }
  if (opts.priorYearTax != null) taxInput.priorYearTax = opts.priorYearTax;
  if (opts.priorYearAGI != null) taxInput.priorYearAGI = opts.priorYearAGI;
  if (opts.age != null)          taxInput.age          = opts.age;

  return {
    taxInput,
    breakdown: {
      byCategory: breakdown,
      rentalNet:   round(rentalIncome - rentalExpense),
      businessNet: round(bizIncome - bizExpense),
      estimatedPaymentsTotal: round(estimatedTotal),
    },
  };
}

function round(n) { return Math.round(n || 0); }

module.exports = { buildTaxInput, CATEGORY_MAP };
