'use strict';
/**
 * Tax Normalization tests — rule classifier, aggregator (both pure), the AI-pass
 * JSON parsing, and normalizeYear orchestration with a mocked DB.
 */

// DB mock (self-contained) for the orchestration tests
jest.mock('../db', () => {
  const state = { rows: {}, calls: [] };
  const query = jest.fn(async (sql, params = []) => {
    state.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/^SELECT/i.test(sql)) {
      // user_verified lookups and existing-row lookups return empty by default
      const tbl = (sql.match(/FROM\s+(\w+)/i) || [])[1];
      const rows = (state.rows[tbl] || []).filter(r => {
        // crude WHERE match on source_id if present
        const m = sql.match(/source_id=\$(\d+)/i);
        if (m) return r.source_id === params[parseInt(m[1]) - 1];
        return true;
      });
      return { rows };
    }
    return { rows: [] };
  });
  return { query, initSchema: jest.fn(), __state: state };
});

const { classifyTransaction, classifyBatch } = require('../tax-normalize/rules');
const { buildTaxInput } = require('../tax-normalize/aggregator');
const norm = require('../tax-normalize');
const { calculate } = require('../tax-engine');
const db = require('../db');

// ════════════════════════════════════════════════════════════════════════════════
// RULES
// ════════════════════════════════════════════════════════════════════════════════

describe('rule classifier', () => {
  test('payroll deposit → wages', () => {
    const c = classifyTransaction({ desc: 'PAYROLL DIRECT DEP ACME CORP', amount: 5000 });
    expect(c.taxCategory).toBe('wages');
    expect(c.normalizedBy).toBe('rule');
  });

  test('payroll requires positive amount (sign guard)', () => {
    const c = classifyTransaction({ desc: 'PAYROLL', amount: -5000 });
    expect(c).toBeNull();
  });

  test('property tax → property_tax (SALT)', () => {
    const c = classifyTransaction({ desc: 'COUNTY PROPERTY TAX PYMT', amount: -4200 });
    expect(c.taxCategory).toBe('property_tax');
    expect(c.schedule).toBe('A');
  });

  test('charitable donation → charitable_cash', () => {
    const c = classifyTransaction({ desc: 'DONATION RED CROSS', amount: -250 });
    expect(c.taxCategory).toBe('charitable_cash');
  });

  test('IRS estimated payment → estimated_tax_payment', () => {
    const c = classifyTransaction({ desc: 'IRS USATAXPYMT 1040ES', amount: -8000 });
    expect(c.taxCategory).toBe('estimated_tax_payment');
  });

  test('mortgage payment → needs_review with a hint (never auto-deducted)', () => {
    const c = classifyTransaction({ desc: 'ROCKET MORTGAGE PAYMENT', amount: -3200 });
    expect(c.taxCategory).toBe('needs_review');
    expect(c.reviewHint).toMatch(/interest/i);
  });

  test('student loan payment → needs_review (only interest deductible)', () => {
    const c = classifyTransaction({ desc: 'NELNET STUDENT LOAN', amount: -400 });
    expect(c.taxCategory).toBe('needs_review');
  });

  test('unrecognized transaction → null', () => {
    expect(classifyTransaction({ desc: 'STARBUCKS #123', amount: -6.50 })).toBeNull();
  });

  test('classifyBatch splits classified vs unmatched', () => {
    const { classified, unmatched } = classifyBatch([
      { desc: 'PAYROLL DD', amount: 5000 },
      { desc: 'STARBUCKS', amount: -6 },
      { desc: 'PROPERTY TAX', amount: -4000 },
    ]);
    expect(classified).toHaveLength(2);
    expect(unmatched).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// AGGREGATOR
// ════════════════════════════════════════════════════════════════════════════════

describe('aggregator buildTaxInput', () => {
  test('income categories land in the right engine fields', () => {
    const { taxInput } = buildTaxInput([
      { taxCategory: 'wages',            amount: 120000 },
      { taxCategory: 'interest_taxable', amount: 1500 },
      { taxCategory: 'capital_gain_lt',  amount: 20000 },
    ], { taxYear: 2024, filingStatus: 'single' });
    expect(taxInput.income.w2).toBe(120000);
    expect(taxInput.income.taxableInterest).toBe(1500);
    expect(taxInput.income.ltcg).toBe(20000);
  });

  test('expense amounts use magnitude regardless of sign', () => {
    const { taxInput } = buildTaxInput([
      { taxCategory: 'charitable_cash', amount: -5000 },
      { taxCategory: 'property_tax',    amount: -8000 },
    ], {});
    expect(taxInput.deductions.charitableContributions).toBe(5000);
    expect(taxInput.deductions.stateAndLocalTax).toBe(8000);
  });

  test('property tax and state income tax both add to SALT', () => {
    const { taxInput } = buildTaxInput([
      { taxCategory: 'property_tax',     amount: -6000 },
      { taxCategory: 'state_income_tax', amount: -7000 },
    ], {});
    expect(taxInput.deductions.stateAndLocalTax).toBe(13000);
  });

  test('business meals apply 50% deductibility', () => {
    const { taxInput } = buildTaxInput([
      { taxCategory: 'business_income', amount: 50000 },
      { taxCategory: 'business_meals',  amount: -1000, deductibilityPct: 0.5 },
    ], {});
    // net business = 50000 - (1000 * 0.5) = 49500
    expect(taxInput.income.businessIncome).toBe(49500);
  });

  test('rental net = income minus rental expenses', () => {
    const { taxInput, breakdown } = buildTaxInput([
      { taxCategory: 'rental_income',     amount: 36000 },
      { taxCategory: 'rental_repairs',    amount: -4000 },
      { taxCategory: 'rental_management', amount: -3600 },
    ], {});
    expect(taxInput.income.scheduleEIncome).toBe(36000 - 4000 - 3600);
    expect(breakdown.rentalNet).toBe(28400);
  });

  test('estimated payments are aggregated into estimatedPayments[]', () => {
    const { taxInput } = buildTaxInput([
      { taxCategory: 'estimated_tax_payment', amount: -5000 },
      { taxCategory: 'estimated_tax_payment', amount: -5000 },
    ], {});
    expect(taxInput.estimatedPayments).toHaveLength(1);
    expect(taxInput.estimatedPayments[0].amount).toBe(10000);
  });

  test('w2 withholding maps to credits', () => {
    const { taxInput } = buildTaxInput([
      { taxCategory: 'w2_withholding', amount: -25000 },
    ], {});
    expect(taxInput.credits.w2FederalWithholding).toBe(25000);
  });

  test('needs_review and personal are ignored in the engine input', () => {
    const { taxInput } = buildTaxInput([
      { taxCategory: 'needs_review', amount: -3200 },
      { taxCategory: 'personal',     amount: -50 },
      { taxCategory: 'wages',        amount: 80000 },
    ], {});
    expect(taxInput.income.w2).toBe(80000);
    expect(Object.keys(taxInput.deductions)).toHaveLength(0);
  });

  test('passes through non-transaction inputs (children, prior year)', () => {
    const { taxInput } = buildTaxInput([{ taxCategory: 'wages', amount: 100000 }], {
      filingStatus: 'mfj', qualifyingChildren: 2, priorYearTax: 12000, priorYearAGI: 110000,
    });
    expect(taxInput.credits.qualifyingChildren).toBe(2);
    expect(taxInput.priorYearTax).toBe(12000);
  });

  test('output feeds the real engine end-to-end', () => {
    const { taxInput } = buildTaxInput([
      { taxCategory: 'wages',            amount: 120000 },
      { taxCategory: 'mortgage_interest',amount: -18000 },
      { taxCategory: 'property_tax',     amount: -9000 },
      { taxCategory: 'charitable_cash',  amount: -6000 },
      { taxCategory: 'w2_withholding',   amount: -20000 },
    ], { taxYear: 2024, filingStatus: 'single' });
    const result = calculate(taxInput);
    expect(result.agi).toBe(120000);
    expect(result.deductionType).toBe('itemized'); // 18k + 10k(SALT cap) + 6k = 34k > 14.6k
    expect(result.totalLiability).toBeGreaterThan(0);
    expect(result.balanceDue).toBe(result.totalLiability - 20000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// AI-pass JSON parsing
// ════════════════════════════════════════════════════════════════════════════════

describe('safeParseJsonArray', () => {
  test('parses a clean array', () => {
    expect(norm.safeParseJsonArray('[{"i":0,"category":"wages"}]')).toHaveLength(1);
  });
  test('strips code fences', () => {
    const r = norm.safeParseJsonArray('```json\n[{"i":1,"category":"personal"}]\n```');
    expect(r[0].category).toBe('personal');
  });
  test('extracts array embedded in prose', () => {
    const r = norm.safeParseJsonArray('Here you go: [{"i":0,"category":"wages"}] hope that helps');
    expect(r).toHaveLength(1);
  });
  test('returns [] on garbage', () => {
    expect(norm.safeParseJsonArray('not json at all')).toEqual([]);
    expect(norm.safeParseJsonArray('')).toEqual([]);
  });
});

describe('classifyUnmatchedWithAI', () => {
  test('maps valid AI categories and rejects unknown ones', async () => {
    const provider = {
      complete: jest.fn(async () => ({
        text: '[{"i":0,"category":"business_supplies","confidence":0.8},' +
              '{"i":1,"category":"NOT_A_CATEGORY","confidence":0.9},' +
              '{"i":2,"category":"personal","confidence":0.95}]',
      })),
    };
    const unmatched = [
      { desc: 'STAPLES', amount: -120 },
      { desc: 'MYSTERY', amount: -50 },
      { desc: 'NETFLIX', amount: -15 },
    ];
    const map = await norm.classifyUnmatchedWithAI(unmatched, provider, 2024);
    expect(map.get(0).taxCategory).toBe('business_supplies');
    expect(map.get(0).normalizedBy).toBe('ai');
    expect(map.has(1)).toBe(false);          // unknown category rejected
    expect(map.get(2).taxCategory).toBe('personal');
  });

  test('provider failure → empty map (all stay needs_review)', async () => {
    const provider = { complete: jest.fn(async () => { throw new Error('LLM down'); }) };
    const map = await norm.classifyUnmatchedWithAI([{ desc: 'x', amount: -1 }], provider, 2024);
    expect(map.size).toBe(0);
  });

  test('no provider → empty map', async () => {
    const map = await norm.classifyUnmatchedWithAI([{ desc: 'x', amount: -1 }], null, 2024);
    expect(map.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// normalizeYear orchestration (mocked DB)
// ════════════════════════════════════════════════════════════════════════════════

describe('normalizeYear', () => {
  beforeEach(() => { db.query.mockClear(); db.__state.rows = {}; db.__state.calls = []; });

  test('filters to the requested year and classifies via rules', async () => {
    const transactions = [
      { id: 't1', date: '2024-01-15', desc: 'PAYROLL DD',        amount: 5000 },
      { id: 't2', date: '2024-03-01', desc: 'COUNTY PROPERTY TAX', amount: -4000 },
      { id: 't3', date: '2023-12-01', desc: 'PAYROLL DD',        amount: 5000 }, // wrong year
      { id: 't4', date: '2024-04-10', desc: 'STARBUCKS',         amount: -6 },   // unmatched
    ];
    const summary = await norm.normalizeYear({ userId: 'u1', year: 2024, transactions });
    expect(summary.totalForYear).toBe(3);          // t3 excluded
    expect(summary.classifiedByRule).toBe(2);      // payroll + property tax
    expect(summary.needsReview).toBe(1);           // starbucks → needs_review
    expect(summary.byCategory.wages).toBe(1);
    expect(summary.byCategory.property_tax).toBe(1);
  });

  test('uses the AI pass for unmatched when a provider is supplied', async () => {
    const provider = {
      complete: jest.fn(async () => ({ text: '[{"i":0,"category":"business_supplies","confidence":0.7}]' })),
    };
    const transactions = [
      { id: 'a', date: '2024-02-02', desc: 'OFFICE DEPOT', amount: -300 },
    ];
    const summary = await norm.normalizeYear({ userId: 'u1', year: 2024, transactions, useAI: true, provider });
    expect(summary.classifiedByAI).toBe(1);
    expect(summary.byCategory.business_supplies).toBe(1);
    expect(summary.aiUsed).toBe(true);
  });

  test('without AI, unmatched become needs_review', async () => {
    const transactions = [{ id: 'b', date: '2024-05-05', desc: 'RANDOM VENDOR', amount: -99 }];
    const summary = await norm.normalizeYear({ userId: 'u1', year: 2024, transactions, useAI: false });
    expect(summary.needsReview).toBe(1);
    expect(summary.classifiedByAI).toBe(0);
  });

  test('empty transactions → zero summary', async () => {
    const summary = await norm.normalizeYear({ userId: 'u1', year: 2024, transactions: [] });
    expect(summary.totalForYear).toBe(0);
    expect(summary.classifiedByRule).toBe(0);
  });
});
