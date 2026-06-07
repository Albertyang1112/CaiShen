'use strict';
/**
 * tax-history.js — Saved calculations, tax transactions, and AI session log
 *
 * Exports three factory functions (each returns an Express Router):
 *   makeCalculationsRouter()   → mounts at /api/tax-history
 *   makeTransactionsRouter()   → mounts at /api/tax-transactions
 *   makeAISessionsRouter()     → mounts at /api/ai-sessions
 *
 * Also exports TAX_CATEGORIES for use by the advisor and engine.
 */

const express = require('express');
const crypto  = require('crypto');
const { query } = require('./db');

// ─── Tax category definitions ─────────────────────────────────────────────────
const TAX_CATEGORIES = {
  // Income
  wages:                 { label: 'Wages / Salary',                  schedule: null, form: '1040 Line 1a' },
  interest_taxable:      { label: 'Taxable Interest (1099-INT)',      schedule: 'B',  form: '1040 Line 2b' },
  interest_exempt:       { label: 'Tax-Exempt Interest',              schedule: 'B',  form: '1040 Line 2a' },
  dividends_qualified:   { label: 'Qualified Dividends (1099-DIV)',   schedule: 'B',  form: '1040 Line 3a' },
  dividends_ordinary:    { label: 'Ordinary Dividends (1099-DIV)',    schedule: 'B',  form: '1040 Line 3b' },
  ira_distribution:      { label: 'IRA / Pension Distribution',       schedule: null, form: '1040 Line 4b/5b' },
  social_security:       { label: 'Social Security Benefits',         schedule: null, form: '1040 Line 6b' },
  capital_gain_lt:       { label: 'Long-Term Capital Gain',           schedule: 'D',  form: '1040 Line 7' },
  capital_gain_st:       { label: 'Short-Term Capital Gain',          schedule: 'D',  form: '1040 Line 7' },
  rental_income:         { label: 'Rental Income',                    schedule: 'E',  form: 'Sch E Line 3' },
  business_income:       { label: 'Business Income (Sch C)',          schedule: 'C',  form: 'Sch C Line 1' },
  other_income:          { label: 'Other Income',                     schedule: '1',  form: 'Sch 1 Line 8' },
  // Above-the-line adjustments
  se_health_insurance:   { label: 'SE Health Insurance Deduction',    schedule: null, form: 'Sch 1 Line 17' },
  retirement_contrib:    { label: 'Retirement Contributions (IRA/SEP/SIMPLE)', schedule: null, form: 'Sch 1 Line 16/20' },
  student_loan_interest: { label: 'Student Loan Interest',            schedule: null, form: 'Sch 1 Line 21' },
  hsa_contribution:      { label: 'HSA Contribution',                 schedule: null, form: 'Form 8889' },
  educator_expense:      { label: 'Educator Expenses',                schedule: null, form: 'Sch 1 Line 11' },
  // Itemized deductions (Schedule A)
  mortgage_interest:     { label: 'Mortgage Interest (1098)',         schedule: 'A',  form: 'Sch A Line 8a' },
  property_tax:          { label: 'Property Tax (SALT)',               schedule: 'A',  form: 'Sch A Line 5b' },
  state_income_tax:      { label: 'State Income Tax (SALT)',           schedule: 'A',  form: 'Sch A Line 5a' },
  charitable_cash:       { label: 'Charitable Contribution (cash)',    schedule: 'A',  form: 'Sch A Line 11' },
  charitable_noncash:    { label: 'Charitable Contribution (non-cash)',schedule: 'A',  form: 'Sch A Line 12' },
  medical_expense:       { label: 'Medical / Dental Expense',          schedule: 'A',  form: 'Sch A Line 1' },
  investment_interest:   { label: 'Investment Interest Expense',       schedule: 'A',  form: 'Sch A Line 9' },
  // Business expenses (Schedule C)
  business_advertising:  { label: 'Advertising',                      schedule: 'C',  form: 'Sch C Line 8',   deductPct: 1.0 },
  business_car:          { label: 'Car & Truck Expenses',              schedule: 'C',  form: 'Sch C Line 9',   deductPct: 1.0 },
  business_commissions:  { label: 'Commissions & Fees',               schedule: 'C',  form: 'Sch C Line 10',  deductPct: 1.0 },
  business_insurance:    { label: 'Business Insurance',               schedule: 'C',  form: 'Sch C Line 15',  deductPct: 1.0 },
  business_legal:        { label: 'Legal & Professional Services',     schedule: 'C',  form: 'Sch C Line 17',  deductPct: 1.0 },
  business_meals:        { label: 'Business Meals (50% deductible)',   schedule: 'C',  form: 'Sch C Line 24b', deductPct: 0.5 },
  business_office:       { label: 'Office Expense',                   schedule: 'C',  form: 'Sch C Line 18',  deductPct: 1.0 },
  business_rent:         { label: 'Rent / Lease (Business)',          schedule: 'C',  form: 'Sch C Line 20',  deductPct: 1.0 },
  business_supplies:     { label: 'Supplies',                         schedule: 'C',  form: 'Sch C Line 22',  deductPct: 1.0 },
  business_travel:       { label: 'Business Travel',                  schedule: 'C',  form: 'Sch C Line 24a', deductPct: 1.0 },
  business_utilities:    { label: 'Utilities (Business)',             schedule: 'C',  form: 'Sch C Line 25',  deductPct: 1.0 },
  business_wages:        { label: 'Wages Paid to Employees',          schedule: 'C',  form: 'Sch C Line 26',  deductPct: 1.0 },
  business_other:        { label: 'Other Business Expense',           schedule: 'C',  form: 'Sch C Line 27a', deductPct: 1.0 },
  home_office:           { label: 'Home Office Deduction',            schedule: 'C',  form: 'Form 8829',      deductPct: 1.0 },
  depreciation:          { label: 'Depreciation (Sec 179 / MACRS)',   schedule: 'C',  form: 'Sch C Line 13 / Form 4562', deductPct: 1.0 },
  // Rental expenses (Schedule E)
  rental_advertising:    { label: 'Rental Advertising',               schedule: 'E',  form: 'Sch E Line 5' },
  rental_auto:           { label: 'Auto & Travel (Rental)',           schedule: 'E',  form: 'Sch E Line 6' },
  rental_cleaning:       { label: 'Cleaning & Maintenance',           schedule: 'E',  form: 'Sch E Line 7' },
  rental_commissions:    { label: 'Rental Commissions',               schedule: 'E',  form: 'Sch E Line 8' },
  rental_insurance:      { label: 'Rental Insurance',                 schedule: 'E',  form: 'Sch E Line 9' },
  rental_legal:          { label: 'Legal & Professional (Rental)',    schedule: 'E',  form: 'Sch E Line 10' },
  rental_management:     { label: 'Management Fees',                  schedule: 'E',  form: 'Sch E Line 11' },
  rental_mortgage_int:   { label: 'Mortgage Interest (Rental)',       schedule: 'E',  form: 'Sch E Line 12' },
  rental_repairs:        { label: 'Repairs',                          schedule: 'E',  form: 'Sch E Line 14' },
  rental_supplies:       { label: 'Supplies (Rental)',                schedule: 'E',  form: 'Sch E Line 15' },
  rental_taxes:          { label: 'Taxes (Rental Property)',          schedule: 'E',  form: 'Sch E Line 16' },
  rental_utilities:      { label: 'Utilities (Rental)',               schedule: 'E',  form: 'Sch E Line 17' },
  rental_depreciation:   { label: 'Depreciation (Rental)',            schedule: 'E',  form: 'Sch E Line 18' },
  rental_other:          { label: 'Other Rental Expense',             schedule: 'E',  form: 'Sch E Line 19' },
  // Payments
  estimated_tax_payment: { label: 'Estimated Tax Payment (1040-ES)',  schedule: null, form: '1040 Line 26' },
  w2_withholding:        { label: 'Federal Withholding (W-2)',        schedule: null, form: '1040 Line 25a' },
  // Non-deductible
  personal:              { label: 'Personal (non-deductible)',        schedule: null, form: null },
  non_deductible:        { label: 'Non-Deductible',                   schedule: null, form: null },
  needs_review:          { label: 'Needs Review',                     schedule: null, form: null },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const newId = () => crypto.randomUUID();
const owned = (row, uid) => row && row.user_id === uid;

// ═══════════════════════════════════════════════════════════════════════════════
// Router 1: Saved Calculations   →   /api/tax-history
// ═══════════════════════════════════════════════════════════════════════════════

function makeCalculationsRouter() {
  const router = express.Router();

  // GET /api/tax-history/categories  — full category reference for UI + AI
  router.get('/categories', (_req, res) => {
    res.json({ categories: TAX_CATEGORIES });
  });

  // GET /api/tax-history?year=2024&limit=20&offset=0
  router.get('/', async (req, res) => {
    const uid    = req.user.id;
    const year   = req.query.year   ? parseInt(req.query.year)  : null;
    const limit  = Math.min(parseInt(req.query.limit  || 20), 100);
    const offset = parseInt(req.query.offset || 0);
    try {
      let sql = `SELECT id, tax_year, filing_status, label, source,
                        agi, total_liability, balance_due,
                        effective_rate, marginal_rate, engine_version, created_at
                 FROM   tax_calculations WHERE user_id=$1`;
      const p = [uid];
      if (year) { p.push(year); sql += ` AND tax_year=$${p.length}`; }
      sql += ` ORDER BY created_at DESC LIMIT $${p.length+1} OFFSET $${p.length+2}`;
      p.push(limit, offset);
      const { rows } = await query(sql, p);
      res.json({ calculations: rows, limit, offset });
    } catch (e) {
      console.error('[TaxHistory] List:', e.message);
      res.status(500).json({ error: 'Failed to list calculations' });
    }
  });

  // GET /api/tax-history/:id  — full record with steps
  router.get('/:id', async (req, res) => {
    const uid = req.user.id;
    try {
      const { rows } = await query(
        'SELECT * FROM tax_calculations WHERE id=$1', [req.params.id]
      );
      if (!rows.length || !owned(rows[0], uid))
        return res.status(404).json({ error: 'Not found' });
      res.json({ calculation: rows[0] });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load' });
    }
  });

  // POST /api/tax-history  — save a calculation
  router.post('/', async (req, res) => {
    const uid = req.user.id;
    const { taxYear, filingStatus, label, source, input, result } = req.body;
    if (!taxYear || !filingStatus || !input || !result)
      return res.status(400).json({ error: 'taxYear, filingStatus, input, and result are required' });
    const id = newId();
    try {
      await query(
        `INSERT INTO tax_calculations
           (id,user_id,tax_year,filing_status,label,source,
            agi,total_liability,balance_due,effective_rate,marginal_rate,
            input_snapshot,result_snapshot,engine_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, uid, taxYear, filingStatus,
         label || null, source || 'manual',
         result.agi || null, result.totalLiability || null, result.balanceDue || null,
         result.effectiveRate || null, result.marginalRate || null,
         JSON.stringify(input), JSON.stringify(result),
         result.engineVersion || '1.0']
      );
      res.status(201).json({ id, saved: true });
    } catch (e) {
      console.error('[TaxHistory] Save:', e.message);
      res.status(500).json({ error: 'Failed to save' });
    }
  });

  // PATCH /api/tax-history/:id/label
  router.patch('/:id/label', async (req, res) => {
    const uid = req.user.id;
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    try {
      const { rows } = await query(
        'SELECT user_id FROM tax_calculations WHERE id=$1', [req.params.id]
      );
      if (!rows.length || !owned(rows[0], uid))
        return res.status(404).json({ error: 'Not found' });
      await query('UPDATE tax_calculations SET label=$1 WHERE id=$2', [label, req.params.id]);
      res.json({ updated: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to rename' });
    }
  });

  // DELETE /api/tax-history/:id
  router.delete('/:id', async (req, res) => {
    const uid = req.user.id;
    try {
      const { rows } = await query(
        'SELECT user_id FROM tax_calculations WHERE id=$1', [req.params.id]
      );
      if (!rows.length || !owned(rows[0], uid))
        return res.status(404).json({ error: 'Not found' });
      await query('DELETE FROM tax_calculations WHERE id=$1', [req.params.id]);
      res.json({ deleted: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete' });
    }
  });

  return router;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Router 2: Tax Transactions   →   /api/tax-transactions
// ═══════════════════════════════════════════════════════════════════════════════

function makeTransactionsRouter() {
  const router = express.Router();

  // GET /api/tax-transactions/summary/:year
  // MUST be before /:id to avoid being swallowed by the param route
  router.get('/summary/:year', async (req, res) => {
    const uid  = req.user.id;
    const year = parseInt(req.params.year);
    if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });
    try {
      const { rows } = await query(
        `SELECT
           tax_category,
           schedule,
           COUNT(*)::int                                              AS count,
           SUM(amount)::float                                         AS total_amount,
           SUM(amount * deductibility_pct * business_use_pct)::float AS deductible_amount,
           BOOL_AND(user_verified)                                    AS all_verified
         FROM   tax_transactions
         WHERE  user_id=$1 AND tax_year=$2
         GROUP  BY tax_category, schedule
         ORDER  BY deductible_amount DESC NULLS LAST`,
        [uid, year]
      );
      const totalDeductible = rows.reduce((s, r) => s + (r.deductible_amount || 0), 0);
      const incomeCategories = new Set(['wages','rental_income','business_income',
        'other_income','interest_taxable','dividends_ordinary','capital_gain_lt','capital_gain_st']);
      const totalIncome = rows
        .filter(r => incomeCategories.has(r.tax_category))
        .reduce((s, r) => s + (r.total_amount || 0), 0);
      res.json({
        year, byCategory: rows,
        totals: {
          deductible: Math.round(totalDeductible),
          income:     Math.round(totalIncome),
          count:      rows.reduce((s, r) => s + r.count, 0),
        },
        unverifiedCount: rows.reduce((s, r) => s + (r.all_verified ? 0 : r.count), 0),
      });
    } catch (e) {
      console.error('[TaxTxn] Summary:', e.message);
      res.status(500).json({ error: 'Failed to summarize' });
    }
  });

  // GET /api/tax-transactions?year=2024&category=business_meals&schedule=C
  router.get('/', async (req, res) => {
    const uid      = req.user.id;
    const year     = req.query.year     ? parseInt(req.query.year)  : null;
    const category = req.query.category || null;
    const schedule = req.query.schedule || null;
    const verified = req.query.verified !== undefined
      ? req.query.verified === 'true' : null;
    const limit    = Math.min(parseInt(req.query.limit  || 100), 500);
    const offset   = parseInt(req.query.offset || 0);
    try {
      let sql = `SELECT * FROM tax_transactions WHERE user_id=$1`;
      const p = [uid];
      if (year)            { p.push(year);     sql += ` AND tax_year=$${p.length}`; }
      if (category)        { p.push(category); sql += ` AND tax_category=$${p.length}`; }
      if (schedule)        { p.push(schedule); sql += ` AND schedule=$${p.length}`; }
      if (verified !== null) { p.push(verified); sql += ` AND user_verified=$${p.length}`; }
      sql += ` ORDER BY date DESC NULLS LAST, created_at DESC
               LIMIT $${p.length+1} OFFSET $${p.length+2}`;
      p.push(limit, offset);
      const { rows } = await query(sql, p);
      res.json({ transactions: rows, limit, offset });
    } catch (e) {
      console.error('[TaxTxn] List:', e.message);
      res.status(500).json({ error: 'Failed to list' });
    }
  });

  // POST /api/tax-transactions  — add or upsert
  router.post('/', async (req, res) => {
    const uid = req.user.id;
    const {
      taxYear, sourceId, sourceType, sourceAccount,
      date, amount, description,
      taxCategory, deductibilityPct = 1.0, businessUsePct = 1.0,
      schedule, formLine, normalizedBy = 'user', aiConfidence,
      userVerified = false, notes, rawData,
    } = req.body;
    if (!taxYear || amount === undefined)
      return res.status(400).json({ error: 'taxYear and amount are required' });
    if (taxCategory && !TAX_CATEGORIES[taxCategory])
      return res.status(400).json({ error: `Unknown category: ${taxCategory}` });
    try {
      // Upsert by source key if provided
      if (sourceId && sourceType) {
        const ex = await query(
          'SELECT id FROM tax_transactions WHERE user_id=$1 AND source_type=$2 AND source_id=$3',
          [uid, sourceType, sourceId]
        );
        if (ex.rows.length) {
          await query(
            `UPDATE tax_transactions SET
               tax_category=$1,deductibility_pct=$2,business_use_pct=$3,
               schedule=$4,form_line=$5,normalized_by=$6,ai_confidence=$7,
               user_verified=$8,notes=$9,updated_at=NOW()
             WHERE id=$10`,
            [taxCategory||null, deductibilityPct, businessUsePct,
             schedule||null, formLine||null, normalizedBy,
             aiConfidence||null, userVerified, notes||null, ex.rows[0].id]
          );
          return res.json({ id: ex.rows[0].id, updated: true });
        }
      }
      const id = newId();
      await query(
        `INSERT INTO tax_transactions
           (id,user_id,tax_year,source_id,source_type,source_account,
            date,amount,description,tax_category,deductibility_pct,
            business_use_pct,schedule,form_line,normalized_by,ai_confidence,
            user_verified,notes,raw_data)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, uid, taxYear,
         sourceId||null, sourceType||null, sourceAccount||null,
         date||null, amount, description||null,
         taxCategory||null, deductibilityPct, businessUsePct,
         schedule||null, formLine||null, normalizedBy,
         aiConfidence||null, userVerified, notes||null,
         rawData ? JSON.stringify(rawData) : null]
      );
      res.status(201).json({ id, created: true });
    } catch (e) {
      console.error('[TaxTxn] Save:', e.message);
      res.status(500).json({ error: 'Failed to save' });
    }
  });

  // PATCH /api/tax-transactions/:id
  router.patch('/:id', async (req, res) => {
    const uid = req.user.id;
    const {
      taxCategory, deductibilityPct, businessUsePct,
      schedule, formLine, userVerified, notes,
    } = req.body;
    if (taxCategory && !TAX_CATEGORIES[taxCategory])
      return res.status(400).json({ error: `Unknown category: ${taxCategory}` });
    try {
      const { rows } = await query(
        'SELECT user_id FROM tax_transactions WHERE id=$1', [req.params.id]
      );
      if (!rows.length || !owned(rows[0], uid))
        return res.status(404).json({ error: 'Not found' });
      const updates = [], p = [];
      const set = (col, val) => {
        if (val !== undefined) { p.push(val); updates.push(`${col}=$${p.length}`); }
      };
      set('tax_category',    taxCategory);
      set('deductibility_pct', deductibilityPct);
      set('business_use_pct',  businessUsePct);
      set('schedule',        schedule);
      set('form_line',       formLine);
      set('user_verified',   userVerified);
      set('notes',           notes);
      if (!updates.length)
        return res.status(400).json({ error: 'No fields to update' });
      p.push(req.params.id);
      await query(
        `UPDATE tax_transactions SET ${updates.join(',')},updated_at=NOW() WHERE id=$${p.length}`,
        p
      );
      res.json({ updated: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update' });
    }
  });

  // DELETE /api/tax-transactions/:id
  router.delete('/:id', async (req, res) => {
    const uid = req.user.id;
    try {
      const { rows } = await query(
        'SELECT user_id FROM tax_transactions WHERE id=$1', [req.params.id]
      );
      if (!rows.length || !owned(rows[0], uid))
        return res.status(404).json({ error: 'Not found' });
      await query('DELETE FROM tax_transactions WHERE id=$1', [req.params.id]);
      res.json({ deleted: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete' });
    }
  });

  return router;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Router 3: AI Session Log   →   /api/ai-sessions
// ═══════════════════════════════════════════════════════════════════════════════

function makeAISessionsRouter() {
  const router = express.Router();

  // GET /api/ai-sessions?year=2024&limit=20&offset=0
  router.get('/', async (req, res) => {
    const uid    = req.user.id;
    const year   = req.query.year  ? parseInt(req.query.year) : null;
    const limit  = Math.min(parseInt(req.query.limit  || 20), 100);
    const offset = parseInt(req.query.offset || 0);
    try {
      let sql = `SELECT id, tax_year, filing_status, user_question, model_used,
                        risk_flags, validation_passed, escalated,
                        disclaimer_shown, tokens_used, latency_ms, created_at
                 FROM   ai_tax_sessions WHERE user_id=$1`;
      const p = [uid];
      if (year) { p.push(year); sql += ` AND tax_year=$${p.length}`; }
      sql += ` ORDER BY created_at DESC LIMIT $${p.length+1} OFFSET $${p.length+2}`;
      p.push(limit, offset);
      const { rows } = await query(sql, p);
      res.json({ sessions: rows, limit, offset });
    } catch (e) {
      console.error('[AISessions] List:', e.message);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // GET /api/ai-sessions/:id  — full detail
  router.get('/:id', async (req, res) => {
    const uid = req.user.id;
    try {
      const { rows } = await query(
        'SELECT * FROM ai_tax_sessions WHERE id=$1', [req.params.id]
      );
      if (!rows.length || !owned(rows[0], uid))
        return res.status(404).json({ error: 'Not found' });
      res.json({ session: rows[0] });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load session' });
    }
  });

  // POST /api/ai-sessions  — save a completed advisor turn
  // Called server-side by advisor.js after composing + validating the response.
  router.post('/', async (req, res) => {
    const uid = req.user.id;
    const {
      taxYear, filingStatus,
      userQuestion, conversationHistory,
      modelUsed, retrievedSourceIds, retrievedExcerpts,
      calculationId, userDataSnapshot,
      finalAnswer, citations, assumptions,
      riskFlags, validationPassed, validationDetails,
      disclaimerShown, escalated, escalationReason,
      tokensUsed, latencyMs,
    } = req.body;
    if (!userQuestion)
      return res.status(400).json({ error: 'userQuestion is required' });
    const id = newId();
    try {
      await query(
        `INSERT INTO ai_tax_sessions
           (id,user_id,tax_year,filing_status,
            user_question,conversation_history,
            model_used,retrieved_source_ids,retrieved_excerpts,
            calculation_id,user_data_snapshot,
            final_answer,citations,assumptions,
            risk_flags,validation_passed,validation_details,
            disclaimer_shown,escalated,escalation_reason,
            tokens_used,latency_ms)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [id, uid, taxYear||null, filingStatus||null,
         userQuestion,
         conversationHistory ? JSON.stringify(conversationHistory) : null,
         modelUsed||null,
         retrievedSourceIds  ? JSON.stringify(retrievedSourceIds)  : null,
         retrievedExcerpts   ? JSON.stringify(retrievedExcerpts)   : null,
         calculationId||null,
         userDataSnapshot    ? JSON.stringify(userDataSnapshot)    : null,
         finalAnswer||null,
         citations           ? JSON.stringify(citations)           : null,
         assumptions         ? JSON.stringify(assumptions)         : null,
         riskFlags           ? JSON.stringify(riskFlags)           : null,
         validationPassed !== undefined ? validationPassed : null,
         validationDetails   ? JSON.stringify(validationDetails)   : null,
         disclaimerShown||false, escalated||false, escalationReason||null,
         tokensUsed||null, latencyMs||null]
      );
      res.status(201).json({ id, saved: true });
    } catch (e) {
      console.error('[AISessions] Save:', e.message);
      res.status(500).json({ error: 'Failed to save session' });
    }
  });

  return router;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  makeCalculationsRouter,
  makeTransactionsRouter,
  makeAISessionsRouter,
  TAX_CATEGORIES,
};
