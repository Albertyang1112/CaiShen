'use strict';
/**
 * taxes.js — Tax Center backend
 *
 * Stores a per-user, per-year tax return worksheet in `tax_return_{year}.json`.
 * Merges in any projection data already saved via the Projections tab
 * (`tax_years.json`) so the user doesn't have to re-enter W-2, RSU, etc.
 *
 * Routes:
 *   GET  /api/taxes/:year          — load worksheet for a year
 *   POST /api/taxes/:year          — save/update worksheet
 *   GET  /api/taxes/:year/documents — list vault files tagged to this year
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');

// ── Filing status options ─────────────────────────────────────────────
const FILING_STATUSES = [
  { id: 'single',             label: 'Single' },
  { id: 'mfj',                label: 'Married Filing Jointly' },
  { id: 'mfs',                label: 'Married Filing Separately' },
  { id: 'hoh',                label: 'Head of Household' },
  { id: 'qss',                label: 'Qualifying Surviving Spouse' },
];

// ── 2024 standard deduction amounts ──────────────────────────────────
const STD_DEDUCTION = {
  single: 14600, mfj: 29200, mfs: 14600, hoh: 21900, qss: 29200,
};

// ── Build an empty worksheet for a year ──────────────────────────────
function emptyWorksheet(year) {
  return {
    year,
    filingStatus:  'single',
    dependents:    0,
    // ── Income (Form 1040, Lines 1–8) ──────────────────────────────
    income: {
      w2:                  0,   // Line 1a  — Wages, salaries, tips (W-2)
      taxExemptInterest:   0,   // Line 2a  — Tax-exempt interest
      taxableInterest:     0,   // Line 2b  — Taxable interest (1099-INT)
      qualifiedDividends:  0,   // Line 3a  — Qualified dividends (1099-DIV)
      ordinaryDividends:   0,   // Line 3b  — Ordinary dividends (1099-DIV)
      iraDistributions:    0,   // Line 4b  — Taxable IRA distributions
      pensionsAnnuities:   0,   // Line 5b  — Taxable pensions/annuities
      socialSecurity:      0,   // Line 6b  — Taxable Social Security
      capitalGains:        0,   // Line 7   — Capital gain/loss (Schedule D / 1099-B)
      scheduleEIncome:     0,   // Line 5 (Sch E) — Rental income net
      businessIncome:      0,   // Line 3 (Sch C) — Net profit/loss
      otherIncome:         0,   // Line 8   — Other income
    },
    // ── Adjustments to income (Schedule 1, Part II) ────────────────
    adjustments: {
      studentLoanInterest:         0,
      educatorExpenses:            0,
      hsaDeduction:                0,
      selfEmployedHealthInsurance: 0,
      selfEmployedSEI:             0,   // SE tax deductible half
      retirementContributions:     0,   // IRA, SEP, SIMPLE
      alimonyPaid:                 0,
      other:                       0,
    },
    // ── Deductions ─────────────────────────────────────────────────
    deductions: {
      type: 'standard',   // 'standard' | 'itemized'
      itemized: {
        stateAndLocalTax:          0,   // Capped at $10k (SALT)
        mortgageInterest:          0,
        investmentInterest:        0,
        charitableContributions:   0,
        medicalExpenses:           0,   // Above 7.5% AGI
        casualtyLosses:            0,
        otherItemized:             0,
      },
    },
    // ── Non-refundable credits ──────────────────────────────────────
    credits: {
      childTaxCredit:              0,
      childCareCredit:             0,
      educationCredits:            0,   // AOC / Lifetime Learning
      retirementSaversCredit:      0,
      foreignTaxCredit:            0,
      energyCredits:               0,
      otherCredits:                0,
    },
    // ── Other taxes ────────────────────────────────────────────────
    otherTaxes: {
      selfEmploymentTax:           0,   // Schedule SE
      netInvestmentIncomeTax:      0,   // 3.8% NIIT (Form 8960)
      additionalMedicareTax:       0,   // 0.9% on wages > $200k
      amt:                         0,   // Alternative Minimum Tax (Form 6251)
      otherTaxes:                  0,
    },
    // ── Payments ───────────────────────────────────────────────────
    payments: {
      w2FederalWithholding:        0,   // Box 2 on W-2(s)
      w2SocialSecurityWithholding: 0,   // Box 4
      w2MedicareWithholding:       0,   // Box 6
      estimatedTaxPayments:        0,   // 1040-ES payments made
      earnedIncomeCredit:          0,   // Refundable EIC
      childTaxCreditRefundable:    0,
      otherRefundableCredits:      0,
    },
    // ── Notes ──────────────────────────────────────────────────────
    notes: '',
    savedAt: null,
  };
}

// ── Merge projection data from tax_years.json into the worksheet ──────
// The Projections tab saves slider values in $K (e.g. w2:320 = $320,000).
// TaxCenter stores actual dollars. Multiply by 1000 when merging.
// Only fills fields that are still zero (never overwrites user-entered data).
function mergeProjectionData(worksheet, projEntry) {
  if (!projEntry) return worksheet;
  const inc = worksheet.income;
  const K   = 1000; // slider unit → actual dollars
  // W-2 wages (include RSU vesting, which is taxed as ordinary/W-2 income)
  if (!inc.w2 && (projEntry.w2 || projEntry.rsu))
    inc.w2 = ((projEntry.w2 || 0) + (projEntry.rsu || 0)) * K;
  // Long-term capital gains → Schedule D
  if (!inc.capitalGains  && projEntry.ltcg)     inc.capitalGains    = projEntry.ltcg    * K;
  // Real estate net income → Schedule E
  if (!inc.scheduleEIncome && projEntry.reIncome) inc.scheduleEIncome = projEntry.reIncome * K;
  return worksheet;
}

// ─────────────────────────────────────────────────────────────────────

module.exports = function (makeIO, VAULT_DIR) {
  const router = express.Router();

  // ── GET /api/taxes/:year ─────────────────────────────────────────
  router.get('/:year', (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: 'Invalid year' });
    }
    const io = makeIO(req.user.id);

    // Load saved worksheet (if any)
    let worksheet = (io.read(`tax_return_${year}.json`) || emptyWorksheet(year));

    // NOTE: Projection data is intentionally NOT merged here.
    // Tax Center values should only come from actual documents (vault / Plaid).
    // Use the "Fill from data" button to populate fields from bank statement data.

    // Attach computed helpers the UI needs
    const stdDed = STD_DEDUCTION[worksheet.filingStatus] || 14600;
    res.json({ worksheet, stdDeduction: stdDed, filingStatuses: FILING_STATUSES });
  });

  // ── POST /api/taxes/:year ────────────────────────────────────────
  router.post('/:year', (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: 'Invalid year' });
    }
    const io = makeIO(req.user.id);
    const worksheet = { ...req.body, year, savedAt: new Date().toISOString() };
    io.write(`tax_return_${year}.json`, worksheet);
    const stdDed = STD_DEDUCTION[worksheet.filingStatus] || 14600;
    res.json({ worksheet, stdDeduction: stdDed, filingStatuses: FILING_STATUSES });
  });

  // ── GET /api/taxes/:year/documents ──────────────────────────────
  // Returns vault files that appear to be tax documents for the given year
  router.get('/:year/documents', (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });

    const io   = makeIO(req.user.id);
    const meta = io.read('vault.json') || { folders: [], files: [] };

    // Match files by: (a) name contains the year, or (b) tags.year === year,
    // AND name/folder suggests a tax document
    const TAX_PATTERNS = /W-?2|1099|1098|W2|schedule[-_ ]?[abcde]/i;
    const YEAR_STR = String(year);

    const docs = (meta.files || []).filter(f => {
      const inYear    = (f.name || '').includes(YEAR_STR) ||
                        String(f.tags?.year) === YEAR_STR ||
                        (f.folderPath || '').includes(YEAR_STR);
      const isTaxDoc  = TAX_PATTERNS.test(f.name || '') ||
                        TAX_PATTERNS.test(f.folderPath || '') ||
                        (f.tags?.docType || '').toLowerCase().includes('tax') ||
                        (f.folderPath || '').toLowerCase().includes('tax');
      return inYear || isTaxDoc;
    }).map(f => ({
      id:         f.id,
      name:       f.name,
      folderPath: f.folderPath,
      type:       f.type,
      size:       f.size,
      tags:       f.tags || {},
    }));

    res.json(docs);
  });

  // ── GET /api/taxes/:year/vault-forms ────────────────────────────
  // Lists vault files that look like tax forms for this year.
  // Returns taxFormData (cached Claude extraction) if available so the
  // UI can show which forms have already been extracted vs. need extraction.
  router.get('/:year/vault-forms', (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });

    const io      = makeIO(req.user.id);
    const meta    = io.read('vault.json') || { folders: [], files: [] };
    const YEAR_STR = String(year);

    const TAX_FORM_TYPES = new Set([
      'W-2', '1099-INT', '1099-DIV', '1099-B', '1099-NEC',
      '1099-MISC', '1099-R', 'SSA-1099', '1098', '1098-E', '1099',
    ]);
    const TAX_NAME_PATTERN = /W-?2|1099|1098|SSA-1099/i;

    const forms = (meta.files || []).filter(f => {
      // Must look like a tax form (by tagged type or filename)
      const hasTaxType = TAX_FORM_TYPES.has(f.tags?.taxFormType);
      const nameIsTax  = TAX_NAME_PATTERN.test(f.name || '');
      if (!hasTaxType && !nameIsTax) return false;
      // Must match the requested year (by tag, filename, or folder)
      const inYear =
        String(f.tags?.year)        === YEAR_STR ||
        (f.name       || '').includes(YEAR_STR)  ||
        (f.folderPath || '').includes(YEAR_STR);
      return inYear;
    }).map(f => ({
      id:          f.id,
      name:        f.name,
      folderPath:  f.folderPath,
      formType:    f.tags?.taxFormType || null,
      year:        f.tags?.year        || null,
      taxFormData: f.tags?.taxFormData || null,
      extractedAt: f.tags?.taxFormExtractedAt || null,
    }));

    // Sort: already-extracted first, then by form type
    forms.sort((a, b) => {
      if (!!a.taxFormData !== !!b.taxFormData) return a.taxFormData ? -1 : 1;
      return (a.formType || '').localeCompare(b.formType || '');
    });

    const apiConfigured = !!(
      process.env.ANTHROPIC_API_KEY &&
      process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here'
    );

    res.json({ forms, apiConfigured });
  });

  return router;
};
