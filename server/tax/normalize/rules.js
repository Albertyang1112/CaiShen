'use strict';
/**
 * rules.js — Deterministic tax categorization rules
 *
 * Pure logic, no I/O — fully unit-testable.
 *
 * Philosophy: be CONSERVATIVE. Only auto-classify transactions that are both
 * unambiguous AND correctly valued at the transaction level. Anything where the
 * deductible amount differs from the transaction amount (mortgage payments mix
 * principal/interest/escrow; student-loan payments aren't all interest) is sent
 * to `needs_review` rather than guessed — overstating deductions is dangerous.
 *
 * Transaction shape (from transactions.json / Plaid):
 *   { date, desc, amount, category? }
 *   amount > 0  → money in (income / credit)
 *   amount < 0  → money out (expense / debit)
 *
 * Each rule returns a classification or null. First match wins.
 */

// A rule: { id, category, deductibilityPct, schedule, formLine, confidence, sign, match(desc, txn) }
//   sign: '+' requires income (amount>0), '-' requires expense (amount<0), null = either

const RULES = [
  // ── Income ───────────────────────────────────────────────────────────────────
  {
    id: 'payroll',
    category: 'wages', schedule: null, formLine: '1040 Line 1a',
    confidence: 0.95, sign: '+',
    match: (d) => /\b(payroll|direct dep(osit)?|salary|paycheck|adp|gusto|paychex|dir dep|payroll dd)\b/.test(d),
  },
  {
    id: 'interest_income',
    category: 'interest_taxable', schedule: 'B', formLine: '1040 Line 2b',
    confidence: 0.85, sign: '+',
    match: (d) => /\b(interest (earned|payment|paid|credit)|int(erest)? pymnt|annual percentage yield earned|apy earned)\b/.test(d),
  },
  {
    id: 'dividend_income',
    category: 'dividends_ordinary', schedule: 'B', formLine: '1040 Line 3b',
    confidence: 0.85, sign: '+',
    match: (d) => /\b(dividend|div reinvest|ordinary div|qualified div)\b/.test(d),
  },
  {
    id: 'rental_income',
    category: 'rental_income', schedule: 'E', formLine: 'Sch E Line 3',
    confidence: 0.7, sign: '+',
    match: (d) => /\b(rent (received|payment|income)|rental income|tenant|zillow rental|rent pmt)\b/.test(d),
  },

  // ── Clear, correctly-valued deductions / payments ─────────────────────────────
  {
    id: 'property_tax',
    category: 'property_tax', schedule: 'A', formLine: 'Sch A Line 5b',
    confidence: 0.9, sign: '-',
    match: (d) => /\b(property tax|prop tax|county tax(es)?|secured property|real estate tax|treasurer.tax)\b/.test(d),
  },
  {
    id: 'charitable',
    category: 'charitable_cash', schedule: 'A', formLine: 'Sch A Line 11',
    confidence: 0.8, sign: '-',
    match: (d) => /\b(donation|charit(y|able)|red cross|goodwill|salvation army|united way|\bgofundme\b|nonprofit|tithe|church)\b/.test(d),
  },
  {
    id: 'estimated_tax',
    category: 'estimated_tax_payment', schedule: null, formLine: '1040 Line 26',
    confidence: 0.92, sign: '-',
    match: (d) => /\b(irs ?usataxpymt|eftps|estimated tax|1040.?es|irs payment|franchise tax board|ftb (estimated|payment)|state estimated)\b/.test(d),
  },

  // ── Ambiguous / partial — send to review with a hint (never auto-deduct) ──────
  {
    id: 'mortgage_payment',
    category: 'needs_review', schedule: null, formLine: null,
    confidence: 0.4, sign: '-', reviewHint: 'Mortgage payment includes principal, interest, and escrow — only the interest (from Form 1098) is deductible. Enter the 1098 interest amount.',
    match: (d) => /\b(mortgage|mtg pmt|home loan|wells fargo home|rocket mortgage|loan ?payment|caliber home|mr cooper|loandepot)\b/.test(d),
  },
  {
    id: 'student_loan',
    category: 'needs_review', schedule: null, formLine: null,
    confidence: 0.4, sign: '-', reviewHint: 'Only the interest portion of a student-loan payment is deductible (from Form 1098-E), not the whole payment.',
    match: (d) => /\b(student loan|sallie mae|nelnet|navient|great lakes|mohela|fedloan|aidvantage)\b/.test(d),
  },
];

/**
 * Classify a single transaction.
 * @param {object} txn  { date, desc, amount, category? }
 * @returns {object|null} classification with normalizedBy:'rule', or null if no rule matched
 */
function classifyTransaction(txn) {
  if (!txn) return null;
  const desc = String(txn.desc || txn.description || txn.name || '').toLowerCase();
  if (!desc) return null;
  const amount = Number(txn.amount) || 0;

  for (const rule of RULES) {
    if (rule.sign === '+' && amount <= 0) continue;
    if (rule.sign === '-' && amount >= 0) continue;
    if (rule.match(desc, txn)) {
      return {
        taxCategory:      rule.category,
        deductibilityPct: rule.deductibilityPct ?? 1.0,
        businessUsePct:   1.0,
        schedule:         rule.schedule ?? null,
        formLine:         rule.formLine ?? null,
        normalizedBy:     'rule',
        confidence:       rule.confidence,
        ruleId:           rule.id,
        reviewHint:       rule.reviewHint || null,
      };
    }
  }
  return null;
}

/**
 * Classify a batch. Returns { classified: [{txn, classification}], unmatched: [txn] }.
 * Unmatched transactions are candidates for the AI pass or manual review.
 */
function classifyBatch(transactions) {
  const classified = [], unmatched = [];
  for (const txn of transactions) {
    const c = classifyTransaction(txn);
    if (c) classified.push({ txn, classification: c });
    else   unmatched.push(txn);
  }
  return { classified, unmatched };
}

module.exports = { classifyTransaction, classifyBatch, RULES };
