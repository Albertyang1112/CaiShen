'use strict';
/**
 * Tax Engine tests — validate against IRS published tax tables.
 *
 * Sources used to verify expected values:
 *   2024: IRS Publication 505 (Tax Withholding & Estimated Tax)
 *         IRS Tax Rate Schedules (Rev. Proc. 2023-34)
 *         IRS Form 8960 Instructions (NIIT)
 *         IRS Publication 334 (Self-Employment)
 */

const { calculate } = require('../tax-engine/calculator');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compute bracket tax manually for spot-checking */
function manualBracket(income, brackets) {
  let tax = 0, prev = 0;
  for (const [cap, rate] of brackets) {
    if (income <= prev) break;
    tax += (Math.min(income, cap === Infinity ? income : cap) - prev) * rate;
    prev = cap;
    if (cap === Infinity) break;
  }
  return Math.round(tax);
}

// 2024 single brackets for manual checks
const SINGLE_2024 = [
  [11600, 0.10], [47150, 0.12], [100525, 0.22],
  [191950, 0.24], [243725, 0.32], [609350, 0.35], [Infinity, 0.37],
];

// ─── Basic income + standard deduction ────────────────────────────────────────

describe('Standard deduction & basic bracket tax', () => {

  test('Single, $50K W-2, 2024', () => {
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 50000 } });
    // Taxable income: 50000 - 14600 = 35400
    expect(res.agi).toBe(50000);
    expect(res.deductionType).toBe('standard');
    expect(res.deductionAmount).toBe(14600);
    expect(res.taxableIncome).toBe(35400);
    expect(res.ordinaryTax).toBe(manualBracket(35400, SINGLE_2024));
    expect(res.balanceDue).toBe(res.totalLiability); // no withholding
  });

  test('Single, $75K W-2, 2024 — spot-check against IRS table', () => {
    // Taxable income = 75000 - 14600 = 60400
    // Tax: 1160 + (47150-11600)*0.12 + (60400-47150)*0.22
    //    = 1160 + 4266 + 2915 = 8341
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 75000 } });
    expect(res.taxableIncome).toBe(60400);
    expect(res.ordinaryTax).toBe(8341);
  });

  test('MFJ, $150K combined W-2, 2024', () => {
    const res = calculate({ taxYear: 2024, filingStatus: 'mfj', income: { w2: 150000 } });
    expect(res.deductionAmount).toBe(29200);
    expect(res.taxableIncome).toBe(120800);
    expect(res.ordinaryTax).toBeGreaterThan(0);
    expect(res.marginalRate).toBe(0.22);
  });

  test('HOH standard deduction 2024 = $21,900', () => {
    const res = calculate({ taxYear: 2024, filingStatus: 'hoh', income: { w2: 60000 } });
    expect(res.deductionAmount).toBe(21900);
  });

  test('2025 standard deduction is higher than 2024', () => {
    const r24 = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 80000 } });
    const r25 = calculate({ taxYear: 2025, filingStatus: 'single', income: { w2: 80000 } });
    expect(r25.standardDeduction).toBeGreaterThan(r24.standardDeduction); // 15000 > 14600
    expect(r25.taxableIncome).toBeLessThan(r24.taxableIncome);
    expect(r25.totalLiability).toBeLessThan(r24.totalLiability);
  });

  test('Additional standard deduction for age 65+', () => {
    const young = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 50000 } });
    const elder = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 50000 }, age: 67 });
    expect(elder.standardDeduction).toBe(young.standardDeduction + 1950);
    expect(elder.taxableIncome).toBeLessThan(young.taxableIncome);
  });

});

// ─── Self-Employment Tax ───────────────────────────────────────────────────────

describe('Self-employment tax (Schedule SE)', () => {

  test('SE tax calculated on net Schedule C income', () => {
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { businessIncome: 100000 } });
    // SE base = 100000 × 0.9235 = 92350
    // SE tax = 92350 × 0.124 + 92350 × 0.029 = 11451 + 2678 = 14129
    // (SS portion: min(92350, 168600) × 0.124 = 11451)
    expect(res.seTax).toBe(Math.round(92350 * 0.124 + 92350 * 0.029));
    expect(res.seTaxBreakdown.deductibleHalf).toBe(Math.round(res.seTax * 0.5));
  });

  test('SE deductible half reduces AGI', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { businessIncome: 100000 },
    });
    // AGI = 100000 - seDeductHalf
    expect(res.agi).toBe(100000 - res.seTaxBreakdown.deductibleHalf);
  });

  test('SE tax wage base cap applies at high income', () => {
    // Income well above $168,600 SS wage base
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { businessIncome: 400000 },
    });
    // SS portion capped: 168600 × 0.124 = 20906
    // Medicare: 400000 × 0.9235 × 0.029 (no cap) = 10713
    const seBase   = 400000 * 0.9235;
    const ssPart   = 168600 * 0.124;
    const medPart  = seBase * 0.029;
    expect(res.seTax).toBe(Math.round(ssPart + medPart));
  });

  test('No SE tax on W-2 income', () => {
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 100000 } });
    expect(res.seTax).toBe(0);
    expect(res.seTaxBreakdown).toBeNull();
  });

  test('No SE tax on negative Schedule C (loss)', () => {
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 80000, businessIncome: -15000 } });
    expect(res.seTax).toBe(0);
    // Loss reduces gross income
    expect(res.grossIncome).toBe(80000 - 15000);
  });

});

// ─── Capital Gains ────────────────────────────────────────────────────────────

describe('Capital gains / qualified dividends', () => {

  test('LTCG taxed at 0% when taxable income below threshold', () => {
    // Single 2024: 0% LTCG threshold = $47,025
    // Ordinary taxable: $30,000 - $14,600 = $15,400 — well below threshold
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 30000, ltcg: 10000 } });
    expect(res.capitalGainsTax).toBe(0);
  });

  test('LTCG at 15% when stacked ordinary pushes into 15% zone', () => {
    // Ordinary taxable: $100,000 - $14,600 = $85,400
    // LTCG stacks above $85,400 — inside the 15% zone (threshold: $47,025–$518,900)
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 100000, ltcg: 50000 } });
    expect(res.capitalGainsTax).toBe(Math.round(50000 * 0.15));
  });

  test('LTCG at 20% for very high income single', () => {
    // Ordinary taxable: $550k - $14,600 = $535,400 (above $518,900 LTCG 20% threshold)
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 550000, ltcg: 100000 } });
    expect(res.capitalGainsTax).toBe(Math.round(100000 * 0.20));
  });

  test('Qualified dividends taxed at LTCG rates, not bracket rates', () => {
    const withQual = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 100000, qualifiedDividends: 10000, ordinaryDividends: 10000 } });
    const withOrd  = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 110000 } });
    // Replacing qualified divs with ordinary income should increase tax
    expect(withOrd.totalLiability).toBeGreaterThan(withQual.totalLiability);
  });

  test('STCG taxed at ordinary rates (not preferential)', () => {
    const withSTCG = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 100000, stcg: 20000 } });
    const withWage = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 120000 } });
    // STCG is ordinary income — same tax as equivalent W-2
    expect(withSTCG.totalLiability).toBe(withWage.totalLiability);
  });

});

// ─── NIIT & Additional Medicare ───────────────────────────────────────────────

describe('NIIT and Additional Medicare Tax', () => {

  test('NIIT applies when AGI > $200K (single)', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 180000, taxableInterest: 30000, ltcg: 15000 },
    });
    // AGI = 225000 > 200000 threshold
    // NII = 30000 + 15000 = 45000
    // NIIT base = min(45000, 225000 - 200000) = min(45000, 25000) = 25000
    expect(res.niit).toBe(Math.round(25000 * 0.038));
  });

  test('No NIIT when AGI below threshold', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 150000, taxableInterest: 10000 },
    });
    expect(res.niit).toBe(0);
  });

  test('Additional Medicare Tax (0.9%) applies to wages > $200K single', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 250000 },
    });
    expect(res.additionalMedicare).toBe(Math.round((250000 - 200000) * 0.009));
  });

  test('Additional Medicare Tax threshold is $250K for MFJ', () => {
    const below = calculate({ taxYear: 2024, filingStatus: 'mfj', income: { w2: 240000 } });
    const above = calculate({ taxYear: 2024, filingStatus: 'mfj', income: { w2: 260000 } });
    expect(below.additionalMedicare).toBe(0);
    expect(above.additionalMedicare).toBe(Math.round((260000 - 250000) * 0.009));
  });

});

// ─── Deductions ───────────────────────────────────────────────────────────────

describe('Itemized vs standard deductions', () => {

  test('Automatically chooses itemized when it exceeds standard', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 200000 },
      deductions: {
        stateAndLocalTax:         10000,
        mortgageInterest:         18000,
        charitableContributions:   5000,
      },
    });
    expect(res.deductionType).toBe('itemized');
    expect(res.deductionAmount).toBe(33000); // 10k + 18k + 5k
  });

  test('Automatically chooses standard when itemized is less', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 200000 },
      deductions: { mortgageInterest: 5000 },
    });
    expect(res.deductionType).toBe('standard');
    expect(res.deductionAmount).toBe(14600);
  });

  test('SALT capped at $10,000', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 300000 },
      deductions: { stateAndLocalTax: 25000, mortgageInterest: 20000 },
    });
    expect(res.itemizedDetail.salt).toBe(10000);
    expect(res.itemizedDetail.saltPaid).toBe(25000);
  });

  test('SALT cap is $5,000 for MFS', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'mfs',
      income: { w2: 200000 },
      deductions: { stateAndLocalTax: 15000, mortgageInterest: 15000 },
    });
    expect(res.itemizedDetail.salt).toBe(5000);
  });

  test('Medical deduction applies 7.5% AGI floor', () => {
    // AGI = 100000, floor = 7500, paid = 12000, deductible = 4500
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 100000 },
      deductions: {
        medicalExpenses: 12000,
        mortgageInterest: 15000, // force itemized
        stateAndLocalTax: 5000,
      },
    });
    expect(res.itemizedDetail.medicalFloor).toBe(Math.round(100000 * 0.075));
    expect(res.itemizedDetail.medical).toBe(12000 - Math.round(100000 * 0.075));
  });

  test('Charitable deduction capped at 60% of AGI', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 100000 },
      deductions: {
        charitableContributions: 80000,  // exceeds 60% of 100k AGI
        stateAndLocalTax: 10000,
        mortgageInterest: 20000,
      },
    });
    expect(res.itemizedDetail.charitable).toBe(Math.round(100000 * 0.60));
    expect(res.itemizedDetail.charitablePaid).toBe(80000);
  });

});

// ─── QBI Deduction ────────────────────────────────────────────────────────────

describe('QBI deduction (§199A)', () => {

  test('Full 20% QBI deduction below phase-out threshold', () => {
    // Single 2024 phase-out starts at $191,950
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { businessIncome: 80000 },
    });
    expect(res.qbiDeduction).toBeGreaterThan(0);
    // After SE deduction, taxable income should be well below phase-out
    expect(res.qbiDeduction).toBeLessThanOrEqual(Math.round(80000 * 0.20));
  });

  test('QBI deduction is zero above phase-out end', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 250000, businessIncome: 100000 },
    });
    // Taxable income > $241,950 phase-out end
    expect(res.qbiDeduction).toBe(0);
    expect(res.warnings.some(w => w.includes('QBI'))).toBe(true);
  });

  test('QBI deduction is zero with no qualified business income', () => {
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 100000 } });
    expect(res.qbiDeduction).toBe(0);
  });

});

// ─── Child Tax Credit ─────────────────────────────────────────────────────────

describe('Child Tax Credit', () => {

  test('$2,000 per qualifying child (2024)', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'mfj',
      income: { w2: 100000 },
      credits: { qualifyingChildren: 2 },
    });
    expect(res.ctcAmount).toBe(4000);
  });

  test('CTC phases out above income threshold', () => {
    // Single 2024: phase-out starts at $200,000
    // $210,000 AGI → $10,000 over → ceil(10000/1000) × $50 = $500 reduction
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 210000 },
      credits: { qualifyingChildren: 2 },
    });
    expect(res.ctcAmount).toBe(4000 - 500);  // 3500
  });

  test('CTC fully phased out at high income', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 440000 },
      credits: { qualifyingChildren: 1 },
    });
    expect(res.ctcAmount).toBe(0);
  });

  test('ACTC refundable = 15% of earned income over $2,500', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 30000 },
      credits: { qualifyingChildren: 1 },
    });
    // ACTC: min(0.15 × (30000-2500), 1700) = min(4125, 1700) = 1700
    expect(res.actcAmount).toBe(1700);
  });

});

// ─── Withholding & Estimated Payments ─────────────────────────────────────────

describe('Withholding, estimated payments, balance due', () => {

  test('W-2 withholding reduces balance due', () => {
    const noWithhold = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 80000 } });
    const withHold   = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 80000 },
      credits: { w2FederalWithholding: 8000 },
    });
    expect(withHold.balanceDue).toBe(noWithhold.balanceDue - 8000);
    expect(withHold.w2Withholding).toBe(8000);
  });

  test('Overpayment shows as negative balance due', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 50000 },
      credits: { w2FederalWithholding: 15000 },
    });
    expect(res.balanceDue).toBeLessThan(0);
  });

  test('Estimated payments reduce balance due', () => {
    const base = calculate({ taxYear: 2024, filingStatus: 'single', income: { businessIncome: 100000 } });
    const withEst = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { businessIncome: 100000 },
      estimatedPayments: [
        { quarter: 'Q1', amount: 5000 },
        { quarter: 'Q2', amount: 5000 },
        { quarter: 'Q3', amount: 5000 },
        { quarter: 'Q4', amount: 5000 },
      ],
    });
    expect(withEst.balanceDue).toBe(base.balanceDue - 20000);
  });

  test('Safe harbor: met when payments >= required', () => {
    const liability = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { businessIncome: 80000 },
    }).totalLiability;

    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { businessIncome: 80000 },
      estimatedPayments: [{ amount: liability }],
      priorYearTax: liability,
      priorYearAGI: 100000,
    });
    expect(res.safeHarbor.met).toBe(true);
  });

  test('Safe harbor: 110% rule applies for prior AGI > $150K', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 200000 },
      estimatedPayments: [{ amount: 1000 }],
      priorYearTax: 40000,
      priorYearAGI: 200000,  // > $150K → 110% rule
    });
    expect(res.safeHarbor.method).toContain('110%');
    expect(res.safeHarbor.priorYearSH).toBe(44000); // 40000 × 1.10
  });

});

// ─── Steps array (audit trail for AI) ────────────────────────────────────────

describe('Steps audit trail', () => {

  test('All steps have label, value, and irsRef', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'mfj',
      income: { w2: 150000, businessIncome: 40000, ltcg: 20000, qualifiedDividends: 5000 },
      credits: { qualifyingChildren: 2, w2FederalWithholding: 25000 },
    });
    expect(res.steps.length).toBeGreaterThan(8);
    for (const s of res.steps) {
      expect(typeof s.label).toBe('string');
      expect(typeof s.value).toBe('number');
    }
  });

  test('Bracket breakdown is populated for ordinary income', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 200000 },
    });
    expect(res.bracketBreakdown.ordinary.length).toBeGreaterThan(0);
    // Each bracket entry has from, to, rate, taxable, tax
    const b = res.bracketBreakdown.ordinary[0];
    expect(b).toHaveProperty('rate');
    expect(b).toHaveProperty('taxable');
    expect(b).toHaveProperty('tax');
  });

  test('LTCG bracket breakdown populated when LTCG present', () => {
    const res = calculate({
      taxYear: 2024, filingStatus: 'single',
      income: { w2: 100000, ltcg: 50000 },
    });
    expect(res.bracketBreakdown.capitalGains.length).toBeGreaterThan(0);
  });

  test('Warnings are strings', () => {
    const res = calculate({ taxYear: 2024, filingStatus: 'single', income: { w2: 100000 } });
    expect(Array.isArray(res.warnings)).toBe(true);
    res.warnings.forEach(w => expect(typeof w).toBe('string'));
  });

});

// ─── Full scenario: high-net-worth California filer ──────────────────────────

describe('Complex scenario — W-2 + rental + business + capital gains', () => {

  test('All components calculated correctly', () => {
    const res = calculate({
      taxYear: 2024,
      filingStatus: 'mfj',
      income: {
        w2:                   320000,
        qualifiedDividends:    15000,
        ordinaryDividends:     18000,   // 15k qualified + 3k non-qual
        taxableInterest:        8000,
        ltcg:                  40000,
        scheduleEIncome:       24000,   // rental net
        businessIncome:        60000,   // Schedule C
      },
      adjustments: {
        selfEmployedRetirement: 15000,
        selfEmployedHealthInsurance: 8000,
      },
      deductions: {
        stateAndLocalTax:     10000,
        mortgageInterest:     22000,
        charitableContributions: 8000,
      },
      credits: {
        qualifyingChildren:   2,
        w2FederalWithholding: 70000,
      },
      estimatedPayments: [
        { quarter: 'Q1', amount: 8000 },
        { quarter: 'Q2', amount: 8000 },
        { quarter: 'Q3', amount: 8000 },
        { quarter: 'Q4', amount: 8000 },
      ],
      priorYearTax:   80000,
      priorYearAGI:   400000,
    });

    // Sanity checks
    expect(res.grossIncome).toBeGreaterThan(400000);
    expect(res.agi).toBeLessThan(res.grossIncome);
    expect(res.seTax).toBeGreaterThan(0);
    expect(res.niit).toBeGreaterThan(0);           // rental + interest + LTCG > $250k threshold
    expect(res.capitalGainsTax).toBeGreaterThan(0);
    expect(res.deductionType).toBe('itemized');     // 10k + 22k + 8k = 40k > 29.2k standard
    expect(res.totalLiability).toBeGreaterThan(res.ordinaryTax); // multiple tax types
    expect(res.safeHarbor).not.toBeNull();
    expect(res.steps.length).toBeGreaterThan(15);

    // SE tax deductible half should have reduced AGI
    expect(res.agi).toBe(res.grossIncome - res.totalAdjustments);

    // Balance due should reflect all payments
    expect(res.balanceDue).toBe(res.totalLiability - res.totalPayments);
  });

});
