'use strict';
/**
 * tax-normalize/index.js — Normalization orchestration + engine bridge + router
 *
 * Turns the user's raw transactions (transactions.json / Plaid / scrapers) into
 * categorized tax_transactions rows, then rolls those into an engine TaxInput so
 * the deterministic calculator — and the advisor — can reason over real accounts.
 *
 * Flow:
 *   normalizeYear → rules classify → (optional AI pass on leftovers) → upsert rows
 *   buildTaxInputForYear → read stored rows → aggregator → TaxInput
 *   /calculate → TaxInput → tax-engine.calculate → TaxResult
 *
 * Routes (under /api/tax-normalize), all per-user:
 *   POST /:year              run normalization      { useAI?, provider? }
 *   GET  /:year/tax-input    build TaxInput from stored rows
 *   POST /:year/calculate    build TaxInput + run the engine
 *   GET  /:year/summary      data summary for the advisor (text + breakdown)
 */

const express = require('express');
const crypto  = require('crypto');

const { classifyBatch }   = require('./rules');
const { classifyByCoa }   = require('./coa-map');
const { buildTaxInput }   = require('./aggregator');
const { calculate }       = require('../tax-engine');
const { TAX_CATEGORIES }  = require('../tax-history');
const { query }           = require('../db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function txnYear(txn) {
  const d = String(txn.date || '');
  if (/^\d{4}/.test(d)) return parseInt(d.slice(0, 4), 10);
  const dt = new Date(txn.date);
  return isNaN(dt) ? null : dt.getFullYear();
}

function txnSourceId(txn) {
  if (txn.id) return String(txn.id);
  const h = crypto.createHash('sha1')
    .update(`${txn.date}|${txn.desc || txn.description || ''}|${txn.amount}`)
    .digest('hex');
  return `tx-${h.slice(0, 20)}`;
}

async function upsertTaxTransaction(userId, txn, classification) {
  const sourceId   = txnSourceId(txn);
  const sourceType = txn.source || 'transactions';
  const year       = txnYear(txn);

  const existing = await query(
    'SELECT id FROM tax_transactions WHERE user_id=$1 AND source_type=$2 AND source_id=$3',
    [userId, sourceType, sourceId]
  );

  // Never clobber a user-verified row during an automated re-run.
  if (existing.rows.length) {
    const row = await query('SELECT user_verified FROM tax_transactions WHERE id=$1', [existing.rows[0].id]);
    if (row.rows[0]?.user_verified) return { id: existing.rows[0].id, skipped: 'user_verified' };
    await query(
      `UPDATE tax_transactions SET
         tax_category=$1, deductibility_pct=$2, business_use_pct=$3,
         schedule=$4, form_line=$5, normalized_by=$6, ai_confidence=$7,
         notes=$8, updated_at=NOW()
       WHERE id=$9`,
      [classification.taxCategory, classification.deductibilityPct, classification.businessUsePct,
       classification.schedule, classification.formLine, classification.normalizedBy,
       classification.confidence ?? null, classification.reviewHint || null, existing.rows[0].id]
    );
    return { id: existing.rows[0].id, updated: true };
  }

  const id = crypto.randomUUID();
  await query(
    `INSERT INTO tax_transactions
       (id,user_id,tax_year,source_id,source_type,source_account,
        date,amount,description,tax_category,deductibility_pct,
        business_use_pct,schedule,form_line,normalized_by,ai_confidence,
        user_verified,notes,raw_data)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [id, userId, year, sourceId, sourceType, txn.account || txn.institution || null,
     txn.date || null, Number(txn.amount) || 0, txn.desc || txn.description || null,
     classification.taxCategory, classification.deductibilityPct, classification.businessUsePct,
     classification.schedule, classification.formLine, classification.normalizedBy,
     classification.confidence ?? null, false, classification.reviewHint || null,
     JSON.stringify(txn)]
  );
  return { id, created: true };
}

// ─── AI pass (optional) ─────────────────────────────────────────────────────────

function buildCategoryList() {
  // Compact list grouped enough for the model to choose well.
  return Object.entries(TAX_CATEGORIES)
    .map(([key, v]) => `${key} — ${v.label}`)
    .join('\n');
}

/**
 * Ask the LLM to classify the transactions the rules couldn't.
 * Defensive: any parse/validation failure leaves a transaction as needs_review.
 * @returns {Map<number, classification>} keyed by index into `unmatched`
 */
async function classifyUnmatchedWithAI(unmatched, provider, taxYear) {
  if (!unmatched.length || !provider) return new Map();

  const list = unmatched.slice(0, 50).map((t, i) =>
    `${i}. ${t.date || ''} | ${(t.desc || t.description || '').slice(0, 60)} | ${Number(t.amount) || 0}`
  ).join('\n');

  const system =
    `You categorize personal/business financial transactions for US tax purposes (tax year ${taxYear}). ` +
    `Choose the single best category KEY from this list for each transaction. ` +
    `If a transaction is personal/non-deductible, or only partially deductible (e.g. a mortgage ` +
    `payment that mixes principal and interest), use "needs_review". Be conservative — never ` +
    `over-classify something as deductible.\n\nCATEGORIES:\n${buildCategoryList()}\n\n` +
    `Respond with ONLY a JSON array, no prose: [{"i":0,"category":"wages","confidence":0.9}, ...]`;

  let raw;
  try {
    const out = await provider.complete({
      system,
      messages: [{ role: 'user', content: `Transactions (index | date | description | amount):\n${list}` }],
      temperature: 0,
      maxTokens: 1500,
    });
    raw = out.text || '';
  } catch (_) {
    return new Map();
  }

  const parsed = safeParseJsonArray(raw);
  const result = new Map();
  for (const entry of parsed) {
    const i = Number(entry.i);
    const cat = entry.category;
    if (!Number.isInteger(i) || i < 0 || i >= unmatched.length) continue;
    if (!TAX_CATEGORIES[cat]) continue;
    const meta = TAX_CATEGORIES[cat];
    result.set(i, {
      taxCategory:      cat,
      deductibilityPct: meta.deductPct ?? 1.0,
      businessUsePct:   1.0,
      schedule:         meta.schedule ?? null,
      formLine:         meta.form ?? null,
      normalizedBy:     'ai',
      confidence:       clamp01(entry.confidence),
    });
  }
  return result;
}

function safeParseJsonArray(text) {
  if (!text) return [];
  // Strip code fences and grab the first [...] block
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end   = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try { const arr = JSON.parse(cleaned.slice(start, end + 1)); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

function clamp01(n) { const x = Number(n); return isNaN(x) ? null : Math.max(0, Math.min(1, x)); }

// ─── Orchestration ──────────────────────────────────────────────────────────────

/**
 * Normalize one year's transactions into tax_transactions rows.
 * @param {object} args
 * @param {string} args.userId
 * @param {number} args.year
 * @param {Array}  args.transactions  raw transactions (already the user's full list)
 * @param {boolean}[args.useAI=false]
 * @param {object} [args.provider]    LLM provider (from tax-advisor/providers)
 * @returns {Promise<object>} summary
 */
async function normalizeYear({ userId, year, transactions, coa = [], useAI = false, provider = null }) {
  const forYear = (transactions || []).filter(t => txnYear(t) === year);

  // COA-driven classification takes priority over description rules: a category
  // the user explicitly assigned (tx.coaId) is more reliable than a regex guess.
  const coaById = new Map((coa || []).map(a => [a.id, a]));
  const coaClassified = [], remaining = [];
  for (const txn of forYear) {
    const acct = txn.coaId ? coaById.get(txn.coaId) : null;
    const cls  = acct ? classifyByCoa(acct) : null;
    if (cls) coaClassified.push({ txn, classification: cls });
    else     remaining.push(txn);
  }

  const { classified, unmatched } = classifyBatch(remaining);

  let aiMap = new Map();
  if (useAI && provider && unmatched.length) {
    aiMap = await classifyUnmatchedWithAI(unmatched, provider, year);
  }

  let byCoa = 0, byRule = 0, byAI = 0, needsReview = 0;
  const byCategory = {};
  const bump = (cat) => { byCategory[cat] = (byCategory[cat] || 0) + 1; };

  // COA-classified (highest priority — the user's explicit category)
  for (const { txn, classification } of coaClassified) {
    await upsertTaxTransaction(userId, txn, classification);
    byCoa++; bump(classification.taxCategory);
    if (classification.taxCategory === 'needs_review') needsReview++;
  }

  // Rule-classified
  for (const { txn, classification } of classified) {
    await upsertTaxTransaction(userId, txn, classification);
    byRule++; bump(classification.taxCategory);
    if (classification.taxCategory === 'needs_review') needsReview++;
  }

  // AI-classified + remaining → needs_review
  for (let i = 0; i < unmatched.length; i++) {
    const ai = aiMap.get(i);
    if (ai) {
      await upsertTaxTransaction(userId, unmatched[i], ai);
      byAI++; bump(ai.taxCategory);
      if (ai.taxCategory === 'needs_review') needsReview++;
    } else {
      await upsertTaxTransaction(userId, unmatched[i], {
        taxCategory: 'needs_review', deductibilityPct: 1.0, businessUsePct: 1.0,
        schedule: null, formLine: null, normalizedBy: 'rule', confidence: 0,
      });
      needsReview++; bump('needs_review');
    }
  }

  return {
    year,
    totalForYear:      forYear.length,
    classifiedByCoa:   byCoa,
    classifiedByRule:  byRule,
    classifiedByAI:    byAI,
    needsReview,
    byCategory,
    aiUsed: useAI && !!provider,
  };
}

/** Read stored tax_transactions for a year and build an engine TaxInput. */
async function buildTaxInputForYear(userId, year, opts = {}) {
  const { rows } = await query(
    `SELECT tax_category, amount, deductibility_pct, business_use_pct
     FROM tax_transactions WHERE user_id=$1 AND tax_year=$2`,
    [userId, year]
  );
  const items = rows.map(r => ({
    taxCategory:      r.tax_category,
    amount:           Number(r.amount),
    deductibilityPct: r.deductibility_pct != null ? Number(r.deductibility_pct) : 1.0,
    businessUsePct:   r.business_use_pct  != null ? Number(r.business_use_pct)  : 1.0,
  }));
  return buildTaxInput(items, { taxYear: year, ...opts });
}

/** Human-readable summary of a year's tax data, for the advisor's userDataSummary. */
function buildDataSummary(taxInput, breakdown) {
  const usd = n => `$${Math.round(n || 0).toLocaleString()}`;
  const lines = [];
  const inc = taxInput.income || {};
  if (inc.w2)              lines.push(`W-2 wages: ${usd(inc.w2)}`);
  if (inc.taxableInterest) lines.push(`Taxable interest: ${usd(inc.taxableInterest)}`);
  if (inc.ordinaryDividends) lines.push(`Dividends: ${usd(inc.ordinaryDividends)} (qualified ${usd(inc.qualifiedDividends)})`);
  if (inc.ltcg)            lines.push(`Long-term capital gains: ${usd(inc.ltcg)}`);
  if (inc.scheduleEIncome) lines.push(`Net rental (Schedule E): ${usd(inc.scheduleEIncome)}`);
  if (inc.businessIncome)  lines.push(`Net business (Schedule C): ${usd(inc.businessIncome)}`);
  const ded = taxInput.deductions || {};
  if (ded.mortgageInterest)        lines.push(`Mortgage interest: ${usd(ded.mortgageInterest)}`);
  if (ded.stateAndLocalTax)        lines.push(`State & local taxes (SALT): ${usd(ded.stateAndLocalTax)}`);
  if (ded.charitableContributions) lines.push(`Charitable contributions: ${usd(ded.charitableContributions)}`);
  if (breakdown?.estimatedPaymentsTotal) lines.push(`Estimated tax paid: ${usd(breakdown.estimatedPaymentsTotal)}`);
  const reviewCount = breakdown?.byCategory?.needs_review?.count || 0;
  if (reviewCount) lines.push(`(${reviewCount} transaction(s) still need review and are not yet included)`);
  return lines.length ? lines.join('\n') : 'No categorized tax data for this year yet.';
}

// ─── Router ───────────────────────────────────────────────────────────────────

function makeRouter(makeIO) {
  const router = express.Router();

  // POST /api/tax-normalize/:year   { useAI?, provider? }
  router.post('/:year', async (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });
    const { useAI = false, provider: providerName } = req.body || {};
    try {
      const io = makeIO(req.user.id);
      const transactions = io.read('transactions.json') || [];
      const coa          = io.read('chart_of_accounts.json') || [];
      let provider = null;
      if (useAI) {
        try { provider = require('../tax-advisor/providers').getProvider(providerName); }
        catch (_) { /* no provider configured — leftovers stay needs_review */ }
      }
      const summary = await normalizeYear({ userId: req.user.id, year, transactions, coa, useAI, provider });
      res.json(summary);
    } catch (e) {
      console.error('[TaxNormalize] normalize error:', e.message);
      res.status(500).json({ error: 'Normalization failed', detail: e.message });
    }
  });

  // GET /api/tax-normalize/:year/tax-input?filingStatus=single
  router.get('/:year/tax-input', async (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });
    try {
      const { taxInput, breakdown } = await buildTaxInputForYear(req.user.id, year, {
        filingStatus: req.query.filingStatus || 'single',
      });
      res.json({ taxInput, breakdown });
    } catch (e) {
      res.status(500).json({ error: 'Failed to build tax input', detail: e.message });
    }
  });

  // POST /api/tax-normalize/:year/calculate
  // Body: { filingStatus?, qualifyingChildren?, otherDependents?, age?, priorYearTax?, priorYearAGI?, save? }
  router.post('/:year/calculate', async (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });
    try {
      const opts = {
        filingStatus:       req.body?.filingStatus || 'single',
        qualifyingChildren: req.body?.qualifyingChildren,
        otherDependents:    req.body?.otherDependents,
        age:                req.body?.age,
        priorYearTax:       req.body?.priorYearTax,
        priorYearAGI:       req.body?.priorYearAGI,
      };
      const { taxInput, breakdown } = await buildTaxInputForYear(req.user.id, year, opts);
      const result = calculate(taxInput);
      const summary = buildDataSummary(taxInput, breakdown);
      res.json({ taxInput, breakdown, result, dataSummary: summary });
    } catch (e) {
      console.error('[TaxNormalize] calculate error:', e.message);
      res.status(500).json({ error: 'Calculation failed', detail: e.message });
    }
  });

  // GET /api/tax-normalize/:year/summary
  router.get('/:year/summary', async (req, res) => {
    const year = parseInt(req.params.year);
    if (isNaN(year)) return res.status(400).json({ error: 'Invalid year' });
    try {
      const { taxInput, breakdown } = await buildTaxInputForYear(req.user.id, year, {
        filingStatus: req.query.filingStatus || 'single',
      });
      res.json({ dataSummary: buildDataSummary(taxInput, breakdown), breakdown });
    } catch (e) {
      res.status(500).json({ error: 'Failed to build summary', detail: e.message });
    }
  });

  return router;
}

module.exports = {
  makeRouter,
  normalizeYear,
  buildTaxInputForYear,
  buildDataSummary,
  classifyUnmatchedWithAI,
  safeParseJsonArray,
};
