'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// IRS tax data — brackets, rates, thresholds for 2024 and 2025
//
// Sources:
//   2024: IRS Rev. Proc. 2023-34, IR-2023-208
//   2025: IRS Rev. Proc. 2024-40, IR-2024-273
//
// UPDATE THIS FILE every December when IRS publishes the following year's numbers.
// All other calculation logic lives in calculator.js and never needs to change
// for annual inflation adjustments.
//
// Filing status keys:
//   'single' | 'mfj' (married filing jointly) | 'mfs' (married filing separately)
//   'hoh' (head of household) | 'qss' (qualifying surviving spouse)
// ─────────────────────────────────────────────────────────────────────────────

const TAX_DATA = {

  // ── 2024 ───────────────────────────────────────────────────────────────────
  2024: {

    // Standard deductions (Rev. Proc. 2023-34, §3.13)
    standardDeduction: {
      single: 14600,
      mfj:    29200,
      mfs:    14600,
      hoh:    21900,
      qss:    29200,
    },

    // Additional standard deduction for taxpayer/spouse age ≥ 65 OR blind
    // (per qualifying person, per condition — e.g. both 65+ = 2× for each spouse on MFJ)
    additionalStdDed: {
      single: 1950,
      mfj:    1550,  // per qualifying person
      mfs:    1550,
      hoh:    1950,
      qss:    1550,
    },

    // Ordinary income brackets — [ceiling, marginalRate]
    // Infinity = top bracket (no ceiling)
    // Source: Rev. Proc. 2023-34, §3.01
    brackets: {
      single: [
        [11600,    0.10],
        [47150,    0.12],
        [100525,   0.22],
        [191950,   0.24],
        [243725,   0.32],
        [609350,   0.35],
        [Infinity, 0.37],
      ],
      mfj: [
        [23200,    0.10],
        [94300,    0.12],
        [201050,   0.22],
        [383900,   0.24],
        [487450,   0.32],
        [731200,   0.35],
        [Infinity, 0.37],
      ],
      mfs: [
        [11600,    0.10],
        [47150,    0.12],
        [100525,   0.22],
        [191950,   0.24],
        [243725,   0.32],
        [304675,   0.35],
        [Infinity, 0.37],
      ],
      hoh: [
        [16550,    0.10],
        [63100,    0.12],
        [100500,   0.22],
        [191950,   0.24],
        [243700,   0.32],
        [609350,   0.35],
        [Infinity, 0.37],
      ],
      qss: [  // same thresholds as MFJ
        [23200,    0.10],
        [94300,    0.12],
        [201050,   0.22],
        [383900,   0.24],
        [487450,   0.32],
        [731200,   0.35],
        [Infinity, 0.37],
      ],
    },

    // Long-term capital gains / qualified dividends — preferential rates
    // Threshold = *total* taxable income (stacked on top of ordinary income)
    // Source: Rev. Proc. 2023-34, §3.03
    ltcgBrackets: {
      single: [[47025,   0.00], [518900,  0.15], [Infinity, 0.20]],
      mfj:    [[94050,   0.00], [583750,  0.15], [Infinity, 0.20]],
      mfs:    [[47025,   0.00], [291850,  0.15], [Infinity, 0.20]],
      hoh:    [[63000,   0.00], [551350,  0.15], [Infinity, 0.20]],
      qss:    [[94050,   0.00], [583750,  0.15], [Infinity, 0.20]],
    },

    // Self-employment tax — Schedule SE
    seWageBase:  168600,   // SS wage base (IRC §3121(a)(1))
    seRates:     { ss: 0.124, medicare: 0.029 },   // employee + employer combined
    seNiiFactor: 0.9235,   // net SE income × this = SE tax base

    // Net Investment Income Tax — Form 8960 (IRC §1411)
    // Thresholds are NOT inflation-adjusted
    niitRate:      0.038,
    niitThreshold: { single: 200000, mfj: 250000, mfs: 125000, hoh: 200000, qss: 250000 },

    // Additional Medicare Tax — Form 8959 (IRC §3103)
    // Thresholds are NOT inflation-adjusted
    addlMedicareRate:      0.009,
    addlMedicareThreshold: { single: 200000, mfj: 250000, mfs: 125000, hoh: 200000, qss: 250000 },

    // QBI deduction (§199A) — simplified phase-out range
    // Above phaseout.end: W-2/property wage limitation applies (not calculated here)
    qbiRate:      0.20,
    qbiPhaseout: {
      single: { start: 191950, end: 241950 },
      mfj:    { start: 383900, end: 433900 },
      mfs:    { start: 191950, end: 241950 },
      hoh:    { start: 191950, end: 241950 },
      qss:    { start: 383900, end: 433900 },
    },

    // Child Tax Credit — Form 8812 (IRC §24)
    ctc: {
      amountPerChild:  2000,
      refundableMax:   1700,   // Additional CTC per child (ACTC)
      actcEarnedBase:  2500,   // 15% of earned income above this
      actcRate:        0.15,
      phaseoutStart:   { single: 200000, mfj: 400000, mfs: 200000, hoh: 200000, qss: 400000 },
      phaseoutPer:     50,     // $50 reduction per $1,000 (or fraction) over threshold
    },

    // SALT cap (TCJA, not inflation-adjusted — expires after 2025)
    saltCap:    10000,
    saltCapMFS: 5000,

    // Medical expense threshold (7.5% of AGI — IRC §213(a))
    medicalPct: 0.075,

    // Charitable contribution limits (simplified)
    charitableCashPct:    0.60,   // cash contributions: 60% of AGI
    charitableNonCashPct: 0.30,   // non-cash: 30% of AGI

    // Social Security benefit taxability thresholds (IRC §86)
    ssTaxability: {
      single:  { lower: 25000, upper: 34000 },
      mfj:     { lower: 32000, upper: 44000 },
      mfs:     { lower: 0,     upper: 0 },     // MFS: always up to 85% taxable
      hoh:     { lower: 25000, upper: 34000 },
      qss:     { lower: 32000, upper: 44000 },
    },

    // Student loan interest deduction cap (IRC §221)
    studentLoanCap: 2500,

    // Educator expense deduction cap (IRC §62(a)(2)(D))
    educatorCap: { single: 300, mfj: 600 },

    // Estimated tax underpayment — safe harbor thresholds (IRC §6654)
    safeHarborHighEarnerAGI: 150000,   // prior year AGI above which 110% rule applies
    safeHarborPct:           1.00,     // 100% of prior year tax (standard)
    safeHarborHighPct:       1.10,     // 110% of prior year tax (high earner)
    safeHarborCurrentPct:    0.90,     // OR 90% of current year tax
  },

  // ── 2025 ───────────────────────────────────────────────────────────────────
  2025: {
    standardDeduction: {
      single: 15000,
      mfj:    30000,
      mfs:    15000,
      hoh:    22500,
      qss:    30000,
    },
    additionalStdDed: {
      single: 2000,
      mfj:    1600,
      mfs:    1600,
      hoh:    2000,
      qss:    1600,
    },
    brackets: {
      single: [
        [11925,    0.10],
        [48475,    0.12],
        [103350,   0.22],
        [197300,   0.24],
        [250525,   0.32],
        [626350,   0.35],
        [Infinity, 0.37],
      ],
      mfj: [
        [23850,    0.10],
        [96950,    0.12],
        [206700,   0.22],
        [394600,   0.24],
        [501050,   0.32],
        [751600,   0.35],
        [Infinity, 0.37],
      ],
      mfs: [
        [11925,    0.10],
        [48475,    0.12],
        [103350,   0.22],
        [197300,   0.24],
        [250525,   0.32],
        [375800,   0.35],
        [Infinity, 0.37],
      ],
      hoh: [
        [17000,    0.10],
        [64850,    0.12],
        [103350,   0.22],
        [197300,   0.24],
        [250500,   0.32],
        [626350,   0.35],
        [Infinity, 0.37],
      ],
      qss: [
        [23850,    0.10],
        [96950,    0.12],
        [206700,   0.22],
        [394600,   0.24],
        [501050,   0.32],
        [751600,   0.35],
        [Infinity, 0.37],
      ],
    },
    ltcgBrackets: {
      single: [[48350,   0.00], [533400,  0.15], [Infinity, 0.20]],
      mfj:    [[96700,   0.00], [600050,  0.15], [Infinity, 0.20]],
      mfs:    [[48350,   0.00], [300000,  0.15], [Infinity, 0.20]],
      hoh:    [[64750,   0.00], [566700,  0.15], [Infinity, 0.20]],
      qss:    [[96700,   0.00], [600050,  0.15], [Infinity, 0.20]],
    },
    seWageBase:  176100,
    seRates:     { ss: 0.124, medicare: 0.029 },
    seNiiFactor: 0.9235,
    niitRate:      0.038,
    niitThreshold: { single: 200000, mfj: 250000, mfs: 125000, hoh: 200000, qss: 250000 },
    addlMedicareRate:      0.009,
    addlMedicareThreshold: { single: 200000, mfj: 250000, mfs: 125000, hoh: 200000, qss: 250000 },
    qbiRate:      0.20,
    qbiPhaseout: {
      single: { start: 197300, end: 247300 },
      mfj:    { start: 394600, end: 444600 },
      mfs:    { start: 197300, end: 247300 },
      hoh:    { start: 197300, end: 247300 },
      qss:    { start: 394600, end: 444600 },
    },
    ctc: {
      amountPerChild:  2000,
      refundableMax:   1800,
      actcEarnedBase:  2500,
      actcRate:        0.15,
      phaseoutStart:   { single: 200000, mfj: 400000, mfs: 200000, hoh: 200000, qss: 400000 },
      phaseoutPer:     50,
    },
    saltCap:    10000,
    saltCapMFS: 5000,
    medicalPct: 0.075,
    charitableCashPct:    0.60,
    charitableNonCashPct: 0.30,
    ssTaxability: {
      single:  { lower: 25000, upper: 34000 },
      mfj:     { lower: 32000, upper: 44000 },
      mfs:     { lower: 0,     upper: 0 },
      hoh:     { lower: 25000, upper: 34000 },
      qss:     { lower: 32000, upper: 44000 },
    },
    studentLoanCap: 2500,
    educatorCap: { single: 300, mfj: 600 },
    safeHarborHighEarnerAGI: 150000,
    safeHarborPct:           1.00,
    safeHarborHighPct:       1.10,
    safeHarborCurrentPct:    0.90,
  },
};

// Placeholder for 2026 — use 2025 data until IRS publishes Rev. Proc. 2025-xx
TAX_DATA[2026] = TAX_DATA[2025];

module.exports = TAX_DATA;
