'use strict';
/**
 * calculator.js — Deterministic federal income tax calculator
 *
 * DESIGN PRINCIPLE: The AI advisor NEVER does arithmetic.
 * Every number shown to the user originates here. The AI only reads
 * the `steps[]` array and narrates what happened in plain English.
 *
 * Coverage (federal only, 2024–2025):
 *   ✓ Gross income aggregation (W-2, interest, dividends, IRA, SS, LTCG/STCG,
 *     Schedule C, Schedule E, other income)
 *   ✓ Social Security benefit taxability (IRC §86)
 *   ✓ Self-employment tax — Schedule SE (IRC §1401)
 *   ✓ Above-the-line adjustments → AGI
 *   ✓ Standard deduction (incl. age 65+/blind additional)
 *   ✓ Itemized deductions (SALT cap, mortgage interest, charitable, medical)
 *   ✓ QBI deduction — §199A (simplified; W-2 wage limitation flagged as assumption)
 *   ✓ Federal income tax via bracket calculation
 *   ✓ Long-term capital gains / qualified dividend preferential rates (stack method)
 *   ✓ Net Investment Income Tax — Form 8960 (IRC §1411)
 *   ✓ Additional Medicare Tax — Form 8959 (IRC §3103)
 *   ✓ Child Tax Credit + Additional Child Tax Credit (ACTC) — Form 8812
 *   ✓ Other credits (pass-through)
 *   ✓ Withholding + estimated payments → balance due / refund
 *   ✓ Estimated tax safe harbor check — Form 2210 (IRC §6654)
 *   ✓ Full calculation steps[] for AI explanation + audit trail
 *
 * NOT covered (flagged for professional referral):
 *   - AMT (Form 6251)
 *   - EITC (requires IRS tables; too complex for deterministic engine without them)
 *   - Depreciation recapture (§1250/§1245)
 *   - Passive activity loss limitations (PAL)
 *   - State income taxes
 *   - Foreign income / FBAR / FATCA
 *   - Crypto-specific rules
 */

const TAX_DATA = require('./data');

// ─── Tiny utilities ───────────────────────────────────────────────────────────

/** Round to nearest dollar */
const r   = n => Math.round(n || 0);

/** Clamp to ≥ 0 */
const pos = n => Math.max(0, n || 0);

/** Format a dollar amount as a readable string */
const fmt = n => `$${r(n).toLocaleString()}`;

/**
 * Build one entry in the steps[] audit trail.
 * @param {string}      label   - Human-readable label shown in UI
 * @param {number}      value   - Dollar amount (rounded)
 * @param {string|null} formula - How the number was derived (optional)
 * @param {string|null} irsRef  - Form / line / code section reference
 * @param {string|null} note    - Extra context or warning
 */
function mkStep(label, value, formula = null, irsRef = null, note = null) {
  return { label, value: r(value), formula, irsRef, note };
}

// ─── Bracket arithmetic ───────────────────────────────────────────────────────

/**
 * Apply a bracket table to a taxable income amount.
 * Returns { tax, breakdown[] } where breakdown shows tax owed in each bracket.
 */
function bracketTax(income, brackets) {
  if (income <= 0) return { tax: 0, breakdown: [] };
  let tax = 0, prev = 0;
  const breakdown = [];
  for (const [cap, rate] of brackets) {
    if (income <= prev) break;
    const chunk = Math.min(income, cap === Infinity ? income : cap) - prev;
    const bracketAmt = chunk * rate;
    breakdown.push({
      from:  r(prev),
      to:    cap === Infinity ? null : r(cap),
      rate,
      taxable: r(chunk),
      tax:     r(bracketAmt),
    });
    tax += bracketAmt;
    prev = cap;
    if (cap === Infinity) break;
  }
  return { tax: r(tax), breakdown };
}

/** Get the marginal rate for a given income level. */
function marginalRate(income, brackets) {
  if (income <= 0) return brackets[0][1];
  let prev = 0;
  for (const [cap, rate] of brackets) {
    if (income <= cap || cap === Infinity) return rate;
    prev = cap;
  }
  return brackets[brackets.length - 1][1];
}

// ─── Social Security taxability ───────────────────────────────────────────────

/**
 * Calculate how much of gross Social Security benefits is taxable.
 * Based on "combined income" = AGI (ex-SS) + nontaxable interest + ½ SS.
 * IRC §86 — "provisional income" test.
 */
function ssTaxable(ssGross, agiExSS, filingStatus, d) {
  if (!ssGross) return 0;
  const thresh = d.ssTaxability[filingStatus] || d.ssTaxability.single;

  // MFS: up to 85% always taxable (unless lived apart all year — edge case, not modeled)
  if (filingStatus === 'mfs') return r(ssGross * 0.85);

  const provisional = agiExSS + ssGross * 0.5;

  if (provisional <= thresh.lower) return 0;
  if (provisional <= thresh.upper) {
    // Up to 50% of SS taxable
    return r(Math.min(0.50 * (provisional - thresh.lower), 0.50 * ssGross));
  }
  // Above upper: up to 85% taxable
  const tier1 = Math.min(0.50 * (thresh.upper - thresh.lower), 0.50 * ssGross);
  const tier2 = 0.85 * (provisional - thresh.upper);
  return r(Math.min(tier1 + tier2, 0.85 * ssGross));
}

// ─── Main calculate() ────────────────────────────────────────────────────────

/**
 * Calculate federal tax liability.
 *
 * @param {object}  input
 * @param {number}  input.taxYear            - 2024 | 2025 (default: 2024)
 * @param {string}  input.filingStatus       - 'single'|'mfj'|'mfs'|'hoh'|'qss'
 * @param {number}  [input.age]              - taxpayer age (additional std deduction if ≥ 65)
 * @param {number}  [input.spouseAge]        - spouse age
 * @param {boolean} [input.blind]            - taxpayer blind (additional std deduction)
 * @param {boolean} [input.spouseBlind]      - spouse blind
 *
 * @param {object}  input.income
 *   .w2                   Wages, salaries, tips (W-2 Box 1)
 *   .taxableInterest       1099-INT
 *   .qualifiedDividends    1099-DIV Box 1b
 *   .ordinaryDividends     1099-DIV Box 1a (includes qualified)
 *   .iraDistributions      Taxable portion of IRA / pension distributions
 *   .pensionsAnnuities     Taxable pensions / annuities
 *   .socialSecurity        Gross SS benefits received (Box 5 of SSA-1099)
 *   .ltcg                  Net long-term capital gain (Schedule D)
 *   .stcg                  Net short-term capital gain (Schedule D)
 *   .scheduleEIncome       Net rental / pass-through income (Schedule E, can be negative)
 *   .businessIncome        Net Schedule C profit/loss (can be negative)
 *   .otherIncome           Alimony received (pre-2019), gambling, prizes, etc.
 *
 * @param {object}  input.adjustments        (all above-the-line; Schedule 1 Part II)
 *   .selfEmployedHealthInsurance
 *   .selfEmployedRetirement      SEP-IRA, SIMPLE, Solo 401k contributions
 *   .iraDeduction
 *   .studentLoanInterest
 *   .educatorExpenses
 *   .hsaDeduction
 *   .alimonyPaid                 Pre-2019 divorce agreements only
 *   .other
 *
 * @param {object}  input.deductions
 *   .type                  'standard' | 'itemized' | 'auto' (default: auto = pick best)
 *   .stateAndLocalTax       SALT paid (capped at $10k)
 *   .mortgageInterest       Home mortgage interest (Form 1098)
 *   .investmentInterest     Investment interest expense
 *   .charitableContributions Cash + non-cash charitable donations
 *   .medicalExpenses        Total medical/dental paid (threshold auto-applied)
 *   .casualtyLosses         Federally declared disaster losses
 *   .otherItemized
 *
 * @param {object}  input.credits
 *   .qualifyingChildren          Count of qualifying children under 17
 *   .otherDependents             Count of other qualifying dependents ($500 credit each)
 *   .childCareCredit             Form 2441 calculated amount
 *   .educationCredits            AOC / LLC calculated amount
 *   .retirementSaversCredit      Form 8880 calculated amount
 *   .foreignTaxCredit            Form 1116 calculated amount
 *   .energyCredits               Form 5695 calculated amount
 *   .otherCredits                Other non-refundable credits
 *   .otherRefundableCredits      Other refundable credits (excluding CTC/ACTC)
 *   .w2FederalWithholding        W-2 Box 2 (total all W-2s)
 *   .w2SocialSecurityWithholding W-2 Box 4
 *   .w2MedicareWithholding       W-2 Box 6
 *
 * @param {Array}   input.estimatedPayments  [{quarter:'Q1', date:'2024-04-15', amount:5000}, ...]
 * @param {number}  [input.priorYearTax]     Total tax from prior year return (for safe harbor)
 * @param {number}  [input.priorYearAGI]     Prior year AGI (for 110% high-earner rule)
 *
 * @returns {TaxResult}
 */
function calculate(input) {
  const {
    taxYear       = 2024,
    filingStatus  = 'single',
    age           = 0,
    spouseAge     = 0,
    blind         = false,
    spouseBlind   = false,
    income        = {},
    adjustments   = {},
    deductions    = {},
    credits       = {},
    estimatedPayments = [],
    priorYearTax  = 0,
    priorYearAGI  = 0,
  } = input;

  const d        = TAX_DATA[taxYear] || TAX_DATA[2025];
  const brackets = d.brackets[filingStatus] || d.brackets.single;
  const steps    = [];   // full audit trail — AI reads these to explain
  const warnings = [];   // items flagged for professional review
  const assumptions = []; // simplifications that may not match complex scenarios

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1 — Gross Income
  // ═══════════════════════════════════════════════════════════════════════════

  const w2               = pos(income.w2);
  const taxableInterest  = pos(income.taxableInterest);
  const qualDividends    = pos(income.qualifiedDividends);
  const ordDividends     = pos(income.ordinaryDividends);   // total; includes qualified
  const nonQualDividends = pos(ordDividends - qualDividends);
  const iraDistrib       = pos(income.iraDistributions);
  const pensionAnnuity   = pos(income.pensionsAnnuities);
  const ssGross          = pos(income.socialSecurity);
  const ltcg             = pos(income.ltcg);
  const stcg             = pos(income.stcg);
  const schedE           = income.scheduleEIncome || 0;    // can be negative (rental loss)
  const schedC           = income.businessIncome  || 0;    // can be negative (business loss)
  const otherIncome      = income.otherIncome     || 0;

  // Social Security: compute taxable portion using rough AGI (excluding SS itself)
  const agiExSS = w2 + taxableInterest + nonQualDividends + iraDistrib +
                  pensionAnnuity + stcg + schedE + schedC + otherIncome;
  const ssTax = ssTaxable(ssGross, agiExSS, filingStatus, d);

  // Ordinary gross income (subject to bracket tax)
  const ordinaryGross = w2 + taxableInterest + nonQualDividends + iraDistrib +
                        pensionAnnuity + ssTax + stcg + schedE + schedC + otherIncome;

  // Preferred-rate income (LTCG + qualified dividends)
  const prefIncome = ltcg + qualDividends;

  const grossIncome = ordinaryGross + prefIncome;

  // Log individual income lines (only those with values)
  if (w2)             steps.push(mkStep('W-2 Wages',                         w2,             null, 'Form 1040, Line 1a'));
  if (taxableInterest)steps.push(mkStep('Taxable Interest (1099-INT)',         taxableInterest,null, 'Form 1040, Line 2b'));
  if (qualDividends)  steps.push(mkStep('Qualified Dividends (1099-DIV)',      qualDividends,  null, 'Form 1040, Line 3a'));
  if (nonQualDividends)steps.push(mkStep('Ordinary Dividends (non-qualified)', nonQualDividends,null,'Form 1040, Line 3b'));
  if (iraDistrib)     steps.push(mkStep('IRA / Pension Distributions',         iraDistrib,     null, 'Form 1040, Line 4b / 5b'));
  if (ssTax > 0)      steps.push(mkStep(
    `Social Security Benefits (taxable — ${r(ssTax / ssGross * 100)}% of ${fmt(ssGross)})`,
    ssTax, `Up to 85% of SS benefits may be taxable based on combined income (IRC §86)`,
    'Form 1040, Line 6b'));
  if (ltcg)           steps.push(mkStep('Long-Term Capital Gains',            ltcg,           null, 'Form 1040, Line 7 / Schedule D'));
  if (stcg)           steps.push(mkStep('Short-Term Capital Gains',           stcg,           null, 'Schedule D, Line 7'));
  if (schedE !== 0)   steps.push(mkStep('Schedule E — Net Rental / Pass-Through', schedE,     null, 'Schedule E, Line 26'));
  if (schedC !== 0)   steps.push(mkStep('Schedule C — Net Business Profit',   schedC,         null, 'Schedule C, Line 31'));
  if (otherIncome)    steps.push(mkStep('Other Income',                        otherIncome,    null, 'Schedule 1, Line 8'));
  steps.push(mkStep('Gross Income', grossIncome, null, 'Form 1040 (above Line 11)'));

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2 — Self-Employment Tax (must come before AGI; half is deductible)
  // ═══════════════════════════════════════════════════════════════════════════

  let seTaxTotal = 0, seDeductHalf = 0, seTaxBreakdown = null;
  const netSE = pos(schedC);  // SE tax only applies to positive Schedule C income

  if (netSE > 0) {
    const seBase    = netSE * d.seNiiFactor;
    const wageBase  = d.seWageBase;
    const ssPortion = Math.min(seBase, wageBase) * d.seRates.ss;
    const medPortion = seBase * d.seRates.medicare;
    seTaxTotal   = r(ssPortion + medPortion);
    seDeductHalf = r(seTaxTotal * 0.5);
    seTaxBreakdown = {
      netSEIncome:    r(netSE),
      seBase:         r(seBase),
      ssTax:          r(ssPortion),
      medicareTax:    r(medPortion),
      total:          seTaxTotal,
      deductibleHalf: seDeductHalf,
    };
    steps.push(mkStep(
      'Self-Employment Tax (Schedule SE)',
      seTaxTotal,
      `${fmt(netSE)} net SE × ${d.seNiiFactor} = ${fmt(seBase)} base; ` +
      `SS: ${d.seRates.ss * 100}% × ${fmt(Math.min(seBase, wageBase))} = ${fmt(ssPortion)}; ` +
      `Medicare: ${d.seRates.medicare * 100}% × ${fmt(seBase)} = ${fmt(medPortion)}`,
      'Schedule SE / Form 1040, Line 15 (Schedule 2)',
      `${fmt(seDeductHalf)} (50%) is deductible as an above-the-line adjustment`
    ));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3 — Adjustments → AGI
  // ═══════════════════════════════════════════════════════════════════════════

  const seHalfAdj   = seDeductHalf;
  const selfEmpHI   = pos(adjustments.selfEmployedHealthInsurance);
  const seRetire    = pos(adjustments.selfEmployedRetirement);
  const iraDeduct   = pos(adjustments.iraDeduction);
  const studentLoan = Math.min(pos(adjustments.studentLoanInterest), d.studentLoanCap);
  const educator    = Math.min(
    pos(adjustments.educatorExpenses),
    filingStatus === 'mfj' ? d.educatorCap.mfj : d.educatorCap.single
  );
  const hsaDeduct   = pos(adjustments.hsaDeduction);
  const alimonyPaid = pos(adjustments.alimonyPaid);
  const otherAdj    = pos(adjustments.other);

  const totalAdj = seHalfAdj + selfEmpHI + seRetire + iraDeduct +
                   studentLoan + educator + hsaDeduct + alimonyPaid + otherAdj;
  const agi = grossIncome - totalAdj;

  if (seHalfAdj)   steps.push(mkStep('Deductible Half of SE Tax',                  seHalfAdj,   `${fmt(seTaxTotal)} × 50%`,  'Schedule 1, Line 15'));
  if (selfEmpHI)   steps.push(mkStep('Self-Employed Health Insurance Deduction',    selfEmpHI,   null, 'Schedule 1, Line 17'));
  if (seRetire)    steps.push(mkStep('SE Retirement Contributions (SEP/SIMPLE)',    seRetire,    null, 'Schedule 1, Line 16'));
  if (iraDeduct)   steps.push(mkStep('IRA Deduction',                               iraDeduct,   null, 'Schedule 1, Line 20'));
  if (adjustments.studentLoanInterest > d.studentLoanCap)
    steps.push(mkStep('Student Loan Interest (capped at $2,500)',  studentLoan,
      `Paid ${fmt(adjustments.studentLoanInterest)}, capped at ${fmt(d.studentLoanCap)}`, 'Schedule 1, Line 21'));
  else if (studentLoan)
    steps.push(mkStep('Student Loan Interest Deduction',           studentLoan,    null, 'Schedule 1, Line 21'));
  if (educator)    steps.push(mkStep('Educator Expenses',                           educator,    null, 'Schedule 1, Line 11'));
  if (hsaDeduct)   steps.push(mkStep('HSA Deduction',                               hsaDeduct,   null, 'Schedule 1, Line 13'));
  if (alimonyPaid) steps.push(mkStep('Alimony Paid (pre-2019 agreements only)',     alimonyPaid, null, 'Schedule 1, Line 19a',
    'TCJA: alimony deduction only applies to divorce/separation agreements executed before 12/31/2018'));
  if (otherAdj)    steps.push(mkStep('Other Adjustments',                           otherAdj,    null, 'Schedule 1'));

  steps.push(mkStep('Adjusted Gross Income (AGI)', agi,
    `${fmt(grossIncome)} gross income − ${fmt(totalAdj)} adjustments`,
    'Form 1040, Line 11'));

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4 — Deductions (Standard vs Itemized)
  // ═══════════════════════════════════════════════════════════════════════════

  // Additional standard deduction: each qualifying condition adds an amount
  // Conditions: age ≥ 65, blind (per person; spouse adds another for MFJ/QSS)
  let addlCount = 0;
  if (age >= 65 || blind) addlCount++;
  if ((spouseAge >= 65 || spouseBlind) && (filingStatus === 'mfj' || filingStatus === 'qss')) addlCount++;
  const addlPer = d.additionalStdDed[filingStatus] || 0;
  const totalStdDed = (d.standardDeduction[filingStatus] || d.standardDeduction.single)
                    + addlCount * addlPer;

  // ── Itemized ──────────────────────────────────────────────────────────────
  const saltPaid   = pos(deductions.stateAndLocalTax);
  const saltCap    = filingStatus === 'mfs' ? d.saltCapMFS : d.saltCap;
  const saltCapped = Math.min(saltPaid, saltCap);

  const mortgageInt    = pos(deductions.mortgageInterest);
  const investInt      = pos(deductions.investmentInterest);

  const charitablePaid = pos(deductions.charitableContributions);
  const charitableCap  = r(agi * d.charitableCashPct);  // simplified: 60% of AGI
  const charitableDed  = Math.min(charitablePaid, charitableCap);

  const medicalPaid  = pos(deductions.medicalExpenses);
  const medicalFloor = r(agi * d.medicalPct);
  const medicalDed   = pos(medicalPaid - medicalFloor);

  const casualtyLoss  = pos(deductions.casualtyLosses);
  const otherItemized = pos(deductions.otherItemized);

  const totalItemized = saltCapped + mortgageInt + investInt +
                        charitableDed + medicalDed + casualtyLoss + otherItemized;

  // Auto-select: pick whichever is larger (user can override with deductions.type)
  const forceItemized = deductions.type === 'itemized';
  const forceStandard = deductions.type === 'standard';
  const useItemized   = forceItemized || (!forceStandard && totalItemized > totalStdDed);
  const deductionAmt  = useItemized ? totalItemized : totalStdDed;
  const deductionType = useItemized ? 'itemized' : 'standard';

  if (useItemized) {
    if (saltPaid) steps.push(mkStep(
      `State & Local Taxes (SALT) — capped at ${fmt(saltCap)}`,
      saltCapped,
      saltPaid > saltCap ? `Paid ${fmt(saltPaid)}, capped at ${fmt(saltCap)} per TCJA §11042` : null,
      'Schedule A, Line 5e'));
    if (mortgageInt)  steps.push(mkStep('Mortgage Interest',              mortgageInt,  null, 'Schedule A, Line 8a',
      'Deductible on acquisition debt up to $750,000 (post-2017 mortgages)'));
    if (investInt)    steps.push(mkStep('Investment Interest Expense',    investInt,    null, 'Schedule A, Line 9'));
    if (charitablePaid) steps.push(mkStep(
      'Charitable Contributions',
      charitableDed,
      charitablePaid > charitableCap ? `Paid ${fmt(charitablePaid)}, limited to 60% of AGI (${fmt(charitableCap)})` : null,
      'Schedule A, Lines 11–14'));
    if (medicalPaid) steps.push(mkStep(
      `Medical & Dental Expenses (above 7.5% of AGI)`,
      medicalDed,
      `Paid ${fmt(medicalPaid)} − ${fmt(medicalFloor)} floor (7.5% × ${fmt(agi)} AGI)`,
      'Schedule A, Line 4',
      medicalDed === 0 ? 'No deduction: payments did not exceed the 7.5% AGI threshold' : null));
    if (casualtyLoss) steps.push(mkStep('Casualty & Theft Losses',       casualtyLoss, null, 'Schedule A, Line 20',
      'Only losses from federally declared disasters are deductible post-TCJA'));
    if (otherItemized)steps.push(mkStep('Other Itemized Deductions',      otherItemized,null, 'Schedule A, Line 16'));
    steps.push(mkStep('Total Itemized Deductions', totalItemized, null, 'Schedule A, Line 17',
      totalItemized < totalStdDed
        ? `Note: Standard deduction (${fmt(totalStdDed)}) is actually higher — consider switching to standard`
        : null));
  } else {
    steps.push(mkStep(
      `Standard Deduction (${filingStatus.toUpperCase()})`,
      totalStdDed,
      addlCount > 0
        ? `${fmt(d.standardDeduction[filingStatus])} base + ${fmt(addlCount * addlPer)} additional (age ≥ 65 / blind)`
        : null,
      'Form 1040, Line 12',
      totalItemized > 0 && totalItemized < totalStdDed
        ? `Your itemized deductions (${fmt(totalItemized)}) are lower than standard — standard is the better choice`
        : null));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5 — Taxable Income (before QBI)
  // ═══════════════════════════════════════════════════════════════════════════

  const taxableIncomePreQBI = pos(agi - deductionAmt);
  steps.push(mkStep(
    'Taxable Income (before QBI deduction)',
    taxableIncomePreQBI,
    `${fmt(agi)} AGI − ${fmt(deductionAmt)} ${deductionType} deduction`,
    'Form 1040, Line 15 (pre-QBI)'));

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6 — QBI Deduction (§199A)
  // ═══════════════════════════════════════════════════════════════════════════

  let qbiDeduction = 0, qbiNote = null;
  const qualBizIncome = pos(schedC); // Schedule C; Schedule E rental may qualify — flagged below

  if (qualBizIncome > 0) {
    const phaseout = d.qbiPhaseout[filingStatus] || d.qbiPhaseout.single;

    // Base QBI deduction: 20% of qualified business income
    const baseQBI = qualBizIncome * d.qbiRate;

    // Overall cap: cannot exceed 20% of (taxable income − net capital gains − qual divs)
    const capBase  = pos(taxableIncomePreQBI - ltcg - qualDividends);
    const cappedQBI = Math.min(baseQBI, capBase * d.qbiRate);

    if (taxableIncomePreQBI <= phaseout.start) {
      qbiDeduction = r(cappedQBI);
      qbiNote = 'Full QBI deduction — taxable income is below the phase-out range';

    } else if (taxableIncomePreQBI >= phaseout.end) {
      qbiDeduction = 0;
      qbiNote = `QBI deduction fully phased out. At incomes above ${fmt(phaseout.end)}, ` +
                `the W-2 wage and qualified property basis limitation applies. ` +
                `A tax professional can determine whether you qualify for any QBI benefit.`;
      warnings.push('QBI deduction phased out — professional review recommended for W-2 wage limitation analysis (IRC §199A)');

    } else {
      // Linear phase-out (simplified — actual calc requires W-2 wages paid by the business)
      const phaseRatio = (taxableIncomePreQBI - phaseout.start) / (phaseout.end - phaseout.start);
      qbiDeduction = r(cappedQBI * (1 - phaseRatio));
      qbiNote = `Partial QBI deduction (${r((1 - phaseRatio) * 100)}% of ${fmt(cappedQBI)} base). ` +
                `Taxable income is within the phase-out range (${fmt(phaseout.start)}–${fmt(phaseout.end)}).`;
      assumptions.push('QBI deduction uses simplified linear phase-out. Actual deduction depends on W-2 wages paid and qualified property basis. A CPA should verify this amount.');
    }

    steps.push(mkStep(
      'QBI Deduction (§199A — 20% of qualified business income)',
      qbiDeduction,
      qbiDeduction > 0 ? `20% × ${fmt(qualBizIncome)} qualified business income` : 'Phased out',
      'Form 8995 / Form 8995-A',
      qbiNote));

    if (schedE > 0) {
      assumptions.push('Schedule E rental income may also qualify for the QBI deduction under certain conditions (triple net lease exclusion, 250-hour safe harbor). This is not calculated here — consult IRS Publication 535 or a tax professional.');
    }
  }

  const taxableIncome = pos(taxableIncomePreQBI - qbiDeduction);
  if (qbiDeduction > 0) {
    steps.push(mkStep(
      'Taxable Income (after QBI deduction)',
      taxableIncome,
      `${fmt(taxableIncomePreQBI)} − ${fmt(qbiDeduction)} QBI deduction`,
      'Form 1040, Line 15'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 7 — Federal Income Tax on Ordinary Income
  // ═══════════════════════════════════════════════════════════════════════════

  // LTCG + qualified dividends are taxed at preferential rates, not bracket rates.
  // "Stack" method: ordinary income sits at the bottom of the brackets; preferential
  // income stacks on top and is taxed at LTCG rates.
  const ordinaryTaxable = pos(taxableIncome - prefIncome);
  const { tax: ordinaryTax, breakdown: ordinaryBreakdown } = bracketTax(ordinaryTaxable, brackets);

  steps.push(mkStep(
    'Federal Income Tax (ordinary income)',
    ordinaryTax,
    `Bracket calculation on ${fmt(ordinaryTaxable)} ordinary taxable income`,
    'Form 1040, Line 16 (Tax Table / Rate Schedules)'));

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 8 — Capital Gains / Qualified Dividend Tax (preferential rates)
  // ═══════════════════════════════════════════════════════════════════════════

  let capitalGainsTax = 0;
  const ltcgBreakdown = [];
  const ltcgBrackets = d.ltcgBrackets[filingStatus] || d.ltcgBrackets.single;

  if (prefIncome > 0) {
    // Stacking: ordinary income "fills" the bottom of the LTCG brackets first.
    // Preferential income is taxed starting where ordinary income left off.
    let remaining = prefIncome;
    let stackedBelow = ordinaryTaxable;   // ordinary income already occupying lower brackets

    let prevThresh = 0;
    for (const [thresh, rate] of ltcgBrackets) {
      if (remaining <= 0) break;
      // For the top (Infinity) bracket, use a large finite size so ordinary income
      // can properly "consume" part of it without capping the available space for LTCG.
      const bracketSize  = thresh === Infinity ? (remaining + stackedBelow + 1) : pos(thresh - prevThresh);
      const usedByOrd    = pos(Math.min(stackedBelow, bracketSize));
      const availForPref = bracketSize - usedByOrd;
      const incomeHere   = Math.min(remaining, availForPref);

      if (incomeHere > 0) {
        const taxHere = incomeHere * rate;
        ltcgBreakdown.push({ rate, income: r(incomeHere), tax: r(taxHere) });
        capitalGainsTax += taxHere;
        remaining -= incomeHere;
      }

      stackedBelow = pos(stackedBelow - bracketSize);
      prevThresh   = thresh === Infinity ? prevThresh : thresh;
    }
    capitalGainsTax = r(capitalGainsTax);

    const prefParts = [];
    if (ltcg)         prefParts.push(`LTCG ${fmt(ltcg)}`);
    if (qualDividends)prefParts.push(`Qualified Dividends ${fmt(qualDividends)}`);
    steps.push(mkStep(
      'Capital Gains / Qualified Dividend Tax (0% / 15% / 20%)',
      capitalGainsTax,
      `${prefParts.join(' + ')} taxed at preferential rates using the "stacking" method`,
      'Form 1040, Line 16 (Schedule D Tax Worksheet)'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 9 — Net Investment Income Tax (NIIT, 3.8%) — Form 8960
  // ═══════════════════════════════════════════════════════════════════════════

  let niit = 0;
  const niitThresh = d.niitThreshold[filingStatus] || 200000;
  const netInvIncome = pos(ltcg + qualDividends + nonQualDividends + taxableInterest + pos(schedE));

  if (agi > niitThresh && netInvIncome > 0) {
    const niitBase = Math.min(netInvIncome, agi - niitThresh);
    niit = r(niitBase * d.niitRate);
    steps.push(mkStep(
      'Net Investment Income Tax (NIIT, 3.8%) — Form 8960',
      niit,
      `3.8% × ${fmt(niitBase)} (lesser of: NII ${fmt(netInvIncome)} or AGI over threshold ${fmt(agi - niitThresh)})`,
      'Form 8960 / IRC §1411'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 10 — Additional Medicare Tax (0.9%) — Form 8959
  // ═══════════════════════════════════════════════════════════════════════════

  let addlMedicare = 0;
  const amtThresh = d.addlMedicareThreshold[filingStatus] || 200000;
  const wagesAndSE = w2 + pos(schedC);

  if (wagesAndSE > amtThresh) {
    addlMedicare = r((wagesAndSE - amtThresh) * d.addlMedicareRate);
    steps.push(mkStep(
      'Additional Medicare Tax (0.9%) — Form 8959',
      addlMedicare,
      `0.9% × (${fmt(wagesAndSE)} wages + SE − ${fmt(amtThresh)} threshold)`,
      'Form 8959 / IRC §3103'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 11 — Credits
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Child Tax Credit (CTC) + Additional Child Tax Credit (ACTC) ──────────
  const numKids    = Math.max(0, Math.floor(credits.qualifyingChildren || 0));
  const numDeps    = Math.max(0, Math.floor(credits.otherDependents    || 0));
  const ctcD       = d.ctc;
  let ctcAmt = 0, actcAmt = 0;

  if (numKids > 0) {
    const phaseoutStart = ctcD.phaseoutStart[filingStatus] || 200000;
    const rawCTC        = numKids * ctcD.amountPerChild;
    const overThreshold = pos(agi - phaseoutStart);
    const reduction     = Math.ceil(overThreshold / 1000) * ctcD.phaseoutPer;
    ctcAmt = pos(rawCTC - reduction);

    // ACTC (refundable) = 15% of earned income above $2,500, up to refundableMax per child
    if (ctcAmt > 0) {
      const earnedIncome = w2 + pos(schedC);
      const actcBase     = pos(earnedIncome - ctcD.actcEarnedBase) * ctcD.actcRate;
      actcAmt = Math.min(actcBase, numKids * ctcD.refundableMax);
    }

    steps.push(mkStep(
      `Child Tax Credit (${numKids} qualifying child${numKids > 1 ? 'ren' : ''})`,
      ctcAmt,
      overThreshold > 0
        ? `${fmt(rawCTC)} − ${fmt(reduction)} phase-out (AGI exceeds ${fmt(phaseoutStart)} by ${fmt(overThreshold)})`
        : null,
      'Form 8812 / IRC §24'));
    if (actcAmt > 0) {
      steps.push(mkStep(
        'Additional Child Tax Credit (refundable)',
        actcAmt,
        `15% of earned income above $2,500, up to ${fmt(ctcD.refundableMax)} per child`,
        'Form 8812, Part II'));
    }
  }

  // Other dependent credit ($500 each, non-refundable, phases out with CTC)
  const depCredit = numDeps * 500;
  if (depCredit > 0) {
    steps.push(mkStep(
      `Other Dependent Credit (${numDeps} dependent${numDeps > 1 ? 's' : ''})`,
      depCredit, `${numDeps} × $500`, 'Form 8812'));
  }

  // ── Other credits (passed through from input — user / upstream calculation) ─
  const childCareCredit  = pos(credits.childCareCredit);
  const educationCredit  = pos(credits.educationCredits);
  const saversCredit     = pos(credits.retirementSaversCredit);
  const foreignTaxCredit = pos(credits.foreignTaxCredit);
  const energyCredit     = pos(credits.energyCredits);
  const otherCredits     = pos(credits.otherCredits);
  const otherRefundable  = pos(credits.otherRefundableCredits);

  if (childCareCredit)  steps.push(mkStep('Child & Dependent Care Credit',           childCareCredit,  null, 'Form 2441'));
  if (educationCredit)  steps.push(mkStep('Education Credits (AOC / Lifetime Learning)', educationCredit, null, 'Form 8863'));
  if (saversCredit)     steps.push(mkStep("Retirement Saver's Credit",               saversCredit,     null, 'Form 8880'));
  if (foreignTaxCredit) steps.push(mkStep('Foreign Tax Credit',                      foreignTaxCredit, null, 'Form 1116'));
  if (energyCredit)     steps.push(mkStep('Residential Clean Energy / Energy Efficient Home Credit', energyCredit, null, 'Form 5695'));
  if (otherCredits)     steps.push(mkStep('Other Non-Refundable Credits',            otherCredits,     null, 'Schedule 3, Part I'));
  if (otherRefundable)  steps.push(mkStep('Other Refundable Credits',                otherRefundable,  null, 'Schedule 3, Part II'));

  const totalNonRefundable = ctcAmt + depCredit + childCareCredit + educationCredit +
                              saversCredit + foreignTaxCredit + energyCredit + otherCredits;
  const totalRefundable    = actcAmt + otherRefundable;

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 12 — Total Tax Liability
  // ═══════════════════════════════════════════════════════════════════════════

  const taxBeforeCredits    = ordinaryTax + capitalGainsTax + seTaxTotal + niit + addlMedicare;
  // Non-refundable credits reduce tax but cannot create a refund by themselves
  const taxAfterNonRefund   = pos(taxBeforeCredits - totalNonRefundable);
  const totalTaxLiability   = taxAfterNonRefund;  // refundable credits handled in payments

  steps.push(mkStep(
    'Total Tax Before Credits',
    taxBeforeCredits,
    [
      ordinaryTax      ? `${fmt(ordinaryTax)} income tax` : null,
      capitalGainsTax  ? `${fmt(capitalGainsTax)} cap gains` : null,
      seTaxTotal       ? `${fmt(seTaxTotal)} SE tax` : null,
      niit             ? `${fmt(niit)} NIIT` : null,
      addlMedicare     ? `${fmt(addlMedicare)} add. Medicare` : null,
    ].filter(Boolean).join(' + '),
    'Form 1040, Line 17'));

  if (totalNonRefundable > 0) {
    steps.push(mkStep('Non-Refundable Credits', totalNonRefundable, null, 'Schedule 3'));
  }
  steps.push(mkStep('Total Tax Liability', totalTaxLiability, null, 'Form 1040, Line 24'));

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 13 — Payments, Withholding, Balance Due
  // ═══════════════════════════════════════════════════════════════════════════

  const w2Withholding = pos(credits.w2FederalWithholding);
  const estPaidTotal  = r(estimatedPayments.reduce((s, p) => s + pos(p.amount), 0));
  const totalPayments = w2Withholding + estPaidTotal + totalRefundable;

  if (w2Withholding) steps.push(mkStep('Federal Tax Withheld (W-2)',         w2Withholding, null, 'Form 1040, Line 25a'));
  if (estPaidTotal)  steps.push(mkStep(
    'Estimated Tax Payments (Form 1040-ES)',
    estPaidTotal,
    estimatedPayments.map(p => `${p.quarter || p.date || '?'}: ${fmt(pos(p.amount))}`).join(', '),
    'Form 1040, Line 26'));
  if (totalRefundable > 0) steps.push(mkStep('Refundable Credits', totalRefundable, null, 'Form 1040, Lines 27–29'));

  const balanceDue = totalTaxLiability - totalPayments; // positive = owe; negative = refund
  steps.push(mkStep(
    balanceDue > 0 ? 'Balance Due (you owe)' : 'Refund',
    Math.abs(balanceDue),
    `${fmt(totalTaxLiability)} liability − ${fmt(totalPayments)} total payments`,
    balanceDue > 0 ? 'Form 1040, Line 37' : 'Form 1040, Line 35a'));

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 14 — Safe Harbor / Underpayment Check (Form 2210)
  // ═══════════════════════════════════════════════════════════════════════════

  let safeHarbor = null;

  if (priorYearTax > 0 && totalTaxLiability > 0) {
    const highEarner     = priorYearAGI > d.safeHarborHighEarnerAGI;
    const priorYearSH    = r(priorYearTax * (highEarner ? d.safeHarborHighPct : d.safeHarborPct));
    const currentYearSH  = r(totalTaxLiability * d.safeHarborCurrentPct);
    const required       = Math.min(priorYearSH, currentYearSH);
    const shortfall      = r(required - totalPayments);

    safeHarbor = {
      method:       highEarner ? `110% of prior year tax (AGI > $150K rule)` : `100% of prior year tax`,
      priorYearTax: r(priorYearTax),
      priorYearSH,
      currentYearSH,
      required,
      paid:         r(totalPayments),
      shortfall:    pos(shortfall),
      met:          shortfall <= 0,
    };

    if (shortfall > 0) {
      steps.push(mkStep(
        'Estimated Tax Underpayment (safe harbor NOT met)',
        shortfall,
        `Required ${fmt(required)} (lesser of: ${fmt(priorYearSH)} prior-year method or ${fmt(currentYearSH)} 90%-current-year method) — paid only ${fmt(totalPayments)}`,
        'Form 2210 / IRC §6654',
        `An underpayment penalty may apply. Consider making additional estimated payments before the next deadline.`));
      warnings.push('Estimated tax underpayment — penalty may apply (Form 2210). Review quarterly payment schedule.');
    } else {
      steps.push(mkStep(
        'Estimated Tax Safe Harbor — met ✓',
        0, null, 'Form 2210',
        `Payments of ${fmt(totalPayments)} meet the safe harbor requirement of ${fmt(required)}`));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary rates
  // ═══════════════════════════════════════════════════════════════════════════

  const effectiveRate     = grossIncome > 0 ? totalTaxLiability / grossIncome : 0;
  const effectiveRateAll  = grossIncome > 0 ? (totalTaxLiability + seTaxTotal) / grossIncome : 0;
  const marginalRateOrd   = marginalRate(ordinaryTaxable, brackets);

  // ── Warnings for complex/high-risk scenarios not handled here ─────────────
  if (income.socialSecurity && filingStatus === 'mfs')
    warnings.push('MFS + Social Security: SS is almost always 85% taxable for MFS filers. Consider consulting a tax professional about filing status optimization.');
  if (pos(schedE) > 50000)
    warnings.push('Significant Schedule E income: passive activity loss rules, depreciation recapture, and QBI eligibility should be reviewed by a tax professional.');
  if (income.otherIncome && income.otherIncome > 10000)
    warnings.push('Significant "other income" — verify proper categorization (gambling, prize income, debt cancellation, etc.) as different rules may apply.');

  // ═══════════════════════════════════════════════════════════════════════════
  // Return
  // ═══════════════════════════════════════════════════════════════════════════

  return {
    // ── Input echo ────────────────────────────────────────────────────────
    taxYear,
    filingStatus,

    // ── Income ────────────────────────────────────────────────────────────
    grossIncome:      r(grossIncome),
    ordinaryIncome:   r(ordinaryGross),
    preferredIncome:  r(prefIncome),
    ssTaxableAmt:     r(ssTax),

    // ── Adjustments ───────────────────────────────────────────────────────
    totalAdjustments: r(totalAdj),
    agi:              r(agi),

    // ── Deductions ────────────────────────────────────────────────────────
    deductionType,
    deductionAmount:  r(deductionAmt),
    standardDeduction:r(totalStdDed),
    itemizedTotal:    r(totalItemized),
    itemizedDetail: {
      salt:       r(saltCapped),    saltPaid: r(saltPaid),
      mortgage:   r(mortgageInt),
      investment: r(investInt),
      charitable: r(charitableDed),charitablePaid: r(charitablePaid),
      medical:    r(medicalDed),    medicalPaid: r(medicalPaid), medicalFloor: r(medicalFloor),
      casualty:   r(casualtyLoss),
      other:      r(otherItemized),
    },

    // ── QBI ───────────────────────────────────────────────────────────────
    qbiDeduction:     r(qbiDeduction),
    taxableIncome:    r(taxableIncome),

    // ── Tax components ────────────────────────────────────────────────────
    ordinaryTax:      r(ordinaryTax),
    capitalGainsTax:  r(capitalGainsTax),
    seTax:            r(seTaxTotal),
    seTaxBreakdown,
    niit:             r(niit),
    additionalMedicare: r(addlMedicare),
    taxBeforeCredits: r(taxBeforeCredits),

    // ── Credits ───────────────────────────────────────────────────────────
    ctcAmount:           r(ctcAmt),
    actcAmount:          r(actcAmt),
    otherDependentCredit:r(depCredit),
    nonRefundableCredits:r(totalNonRefundable),
    refundableCredits:   r(totalRefundable),

    // ── Final ─────────────────────────────────────────────────────────────
    totalLiability:   r(totalTaxLiability),
    w2Withholding:    r(w2Withholding),
    estimatedPaid:    r(estPaidTotal),
    totalPayments:    r(totalPayments),
    balanceDue:       r(balanceDue),      // positive = owe, negative = refund

    // ── Rates ─────────────────────────────────────────────────────────────
    effectiveRate:    parseFloat(effectiveRate.toFixed(4)),
    effectiveRateAll: parseFloat(effectiveRateAll.toFixed(4)),  // incl. SE tax
    marginalRate:     marginalRateOrd,

    // ── Safe harbor ───────────────────────────────────────────────────────
    safeHarbor,

    // ── Audit trail (AI reads this to explain the calculation) ───────────
    steps,
    warnings,
    assumptions,
    bracketBreakdown: {
      ordinary:     ordinaryBreakdown,
      capitalGains: ltcgBreakdown,
    },
  };
}

module.exports = { calculate };
