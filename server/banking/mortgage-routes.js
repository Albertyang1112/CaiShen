'use strict';
/**
 * Mortgage API — read surface over the mortgage domain (statement/Plaid writes happen in
 * banking/mortgage.js + banking/liabilities.js). Mounted at /api/mortgage by server/index.js.
 *
 *   GET /api/mortgage                  — loan accounts + latest statement + saved what-if payment
 *   GET /api/mortgage/alerts           — payment/escrow change + unmatched alerts
 *   GET /api/mortgage/market-rates     — live 30/15-yr market averages (FRED, server-cached)
 *   GET /api/mortgage/:id/statements   — statements for one loan, with payment + escrow detail
 *   PUT /api/mortgage/:id/whatif       — save {payment} as the loan's what-if scenario (null clears)
 */
const express = require('express');
const { query } = require('../core/db');
const { getMarketRates } = require('./market-rates');

module.exports = function makeMortgageRouter(makeIO) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const accts = (await query(`SELECT * FROM mortgage_accounts WHERE user_id=$1 ORDER BY created_at`, [req.user.id])).rows;
      const prefs = makeIO(req.user.id).read('mortgage_prefs.json') || {};
      const out = [];
      for (const a of accts) {
        const latest = (await query(
          `SELECT * FROM mortgage_statements WHERE mortgage_account_id=$1 ORDER BY statement_date DESC NULLS LAST LIMIT 1`, [a.id])).rows[0] || null;
        out.push({ ...a, latestStatement: latest, whatIfPayment: prefs[a.id]?.whatIfPayment ?? null });
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/market-rates', async (req, res) => {
    res.json(await getMarketRates());
  });

  // Save/clear a per-loan what-if monthly payment (a projection scenario, NOT the real
  // payment — the actual figure always comes from statements/Plaid).
  router.put('/:id/whatif', async (req, res) => {
    try {
      const uid = req.user.id, id = req.params.id;
      const owns = await query(`SELECT 1 FROM mortgage_accounts WHERE id=$1 AND user_id=$2`, [id, uid]);
      if (!owns.rows.length) return res.status(404).json({ error: 'Loan not found' });
      const payment = req.body?.payment;
      if (payment != null && (!Number.isFinite(Number(payment)) || Number(payment) <= 0))
        return res.status(400).json({ error: 'payment must be a positive number or null' });
      const io = makeIO(uid);
      const prefs = io.read('mortgage_prefs.json') || {};
      if (payment == null) delete prefs[id];
      else prefs[id] = { whatIfPayment: Number(payment), savedAt: new Date().toISOString() };
      io.write('mortgage_prefs.json', prefs);
      res.json({ ok: true, whatIfPayment: payment == null ? null : Number(payment) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/alerts', (req, res) => {
    res.json(makeIO(req.user.id).read('mortgage_alerts.json') || []);
  });

  router.get('/:id/statements', async (req, res) => {
    try {
      const uid = req.user.id, id = req.params.id;
      const [stmts, pays, esc] = await Promise.all([
        query(`SELECT * FROM mortgage_statements        WHERE user_id=$1 AND mortgage_account_id=$2 ORDER BY statement_date DESC NULLS LAST`, [uid, id]),
        query(`SELECT * FROM mortgage_payments          WHERE user_id=$1 AND mortgage_account_id=$2`, [uid, id]),
        query(`SELECT * FROM mortgage_escrow_transactions WHERE user_id=$1 AND mortgage_account_id=$2 ORDER BY date DESC NULLS LAST`, [uid, id]),
      ]);
      const payByStmt = {}, escByStmt = {};
      for (const p of pays.rows) (payByStmt[p.mortgage_statement_id] = payByStmt[p.mortgage_statement_id] || []).push(p);
      for (const e of esc.rows)  (escByStmt[e.mortgage_statement_id] = escByStmt[e.mortgage_statement_id] || []).push(e);
      res.json(stmts.rows.map(s => ({ ...s, payments: payByStmt[s.id] || [], escrow: escByStmt[s.id] || [] })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
