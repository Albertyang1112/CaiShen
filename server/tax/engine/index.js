'use strict';
/**
 * tax-engine/index.js — Express router + public API
 *
 * Routes:
 *   POST /api/tax-engine/calculate   — run a full federal tax calculation
 *   GET  /api/tax-engine/brackets    — return bracket/deduction data for a year + status
 *   GET  /api/tax-engine/years       — list supported tax years
 */

const express  = require('express');
const { calculate } = require('./calculator');
const TAX_DATA = require('./data');

function makeRouter() {
  const router = express.Router();

  // ── POST /calculate ────────────────────────────────────────────────────────
  // Full deterministic tax calculation.
  // Body: TaxInput object (see calculator.js JSDoc for schema)
  // Returns: TaxResult object including steps[] for AI explanation
  router.post('/calculate', (req, res) => {
    try {
      const result = calculate(req.body);
      res.json({ success: true, result });
    } catch (err) {
      console.error('[TaxEngine] Calculation error:', err.message);
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ── GET /brackets?year=2024&status=single ──────────────────────────────────
  // Return bracket and deduction reference data for a year + filing status.
  // Used by the UI to render bracket tables and by the AI advisor for context.
  router.get('/brackets', (req, res) => {
    const year   = parseInt(req.query.year)   || 2024;
    const status = req.query.status           || 'single';
    const data   = TAX_DATA[year];
    if (!data) return res.status(404).json({ error: `No data for tax year ${year}` });
    const brackets = data.brackets[status];
    if (!brackets) return res.status(400).json({ error: `Unknown filing status: ${status}` });
    res.json({
      year,
      filingStatus:         status,
      brackets,
      ltcgBrackets:         data.ltcgBrackets[status],
      standardDeduction:    data.standardDeduction[status],
      additionalStdDed:     data.additionalStdDed[status],
      saltCap:              data.saltCap,
      seWageBase:           data.seWageBase,
      niitThreshold:        data.niitThreshold[status],
      qbiPhaseout:          data.qbiPhaseout[status],
      ctcPhaseoutStart:     data.ctc.phaseoutStart[status],
    });
  });

  // ── GET /years ─────────────────────────────────────────────────────────────
  router.get('/years', (_req, res) => {
    res.json({ supportedYears: Object.keys(TAX_DATA).map(Number).sort((a, b) => b - a) });
  });

  return router;
}

module.exports = { makeRouter, calculate };
