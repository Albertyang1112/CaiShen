'use strict';
/**
 * Mortgage API — read-only surface over the mortgage domain (writes happen during the
 * scraper import via banking/mortgage.js). Mounted at /api/mortgage by server/index.js.
 *
 *   GET /api/mortgage                  — loan accounts + each one's latest statement
 *   GET /api/mortgage/alerts           — payment/escrow change + unmatched alerts
 *   GET /api/mortgage/:id/statements   — statements for one loan, with payment + escrow detail
 */
const express = require('express');
const { query } = require('../core/db');

module.exports = function makeMortgageRouter(makeIO) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const accts = (await query(`SELECT * FROM mortgage_accounts WHERE user_id=$1 ORDER BY created_at`, [req.user.id])).rows;
      const out = [];
      for (const a of accts) {
        const latest = (await query(
          `SELECT * FROM mortgage_statements WHERE mortgage_account_id=$1 ORDER BY statement_date DESC NULLS LAST LIMIT 1`, [a.id])).rows[0] || null;
        out.push({ ...a, latestStatement: latest });
      }
      res.json(out);
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
