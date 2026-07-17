'use strict';
/**
 * Insurance API — read surface over the insurance domain (statement writes happen in
 * banking/insurance.js via the vault/chatbot ingestion hooks). Mounted at /api/insurance
 * by server/index.js.
 *
 *   GET /api/insurance                 — policies + latest statement + derived paid status
 *   GET /api/insurance/alerts          — premium change / paid / unmatched alerts
 *   GET /api/insurance/:id/statements  — statements for one policy, with payment detail
 *
 * Paid is DERIVED (insurance_payments.matched_transaction_id set for the current cycle's
 * bill), never stored as a flag — the page's green pill and the reminder engine's silence
 * both read the same fact.
 */
const express = require('express');
const { query } = require('../core/db');

module.exports = function makeInsuranceRouter(makeIO) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const uid = req.user.id;
      const pols = (await query(`SELECT * FROM insurance_policies WHERE user_id=$1 ORDER BY created_at`, [uid])).rows;
      const out = [];
      for (const p of pols) {
        const latest = (await query(
          `SELECT s.*, pay.matched_transaction_id, pay.payment_date
             FROM insurance_statements s
             LEFT JOIN insurance_payments pay ON pay.insurance_statement_id = s.id
            WHERE s.insurance_policy_id=$1
            ORDER BY s.due_date DESC NULLS LAST, s.statement_date DESC NULLS LAST LIMIT 1`, [p.id])).rows[0] || null;
        out.push({
          ...p,
          latestStatement: latest,
          paidCurrentCycle: !!(latest && latest.matched_transaction_id),
          paidDate: latest && latest.matched_transaction_id ? latest.payment_date : null,
        });
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/alerts', (req, res) => {
    res.json(makeIO(req.user.id).read('insurance_alerts.json') || []);
  });

  router.get('/:id/statements', async (req, res) => {
    try {
      const uid = req.user.id, id = req.params.id;
      const owns = await query(`SELECT 1 FROM insurance_policies WHERE id=$1 AND user_id=$2`, [id, uid]);
      if (!owns.rows.length) return res.status(404).json({ error: 'Policy not found' });
      const [stmts, pays] = await Promise.all([
        query(`SELECT * FROM insurance_statements WHERE user_id=$1 AND insurance_policy_id=$2 ORDER BY due_date DESC NULLS LAST, statement_date DESC NULLS LAST`, [uid, id]),
        query(`SELECT * FROM insurance_payments   WHERE user_id=$1 AND insurance_policy_id=$2`, [uid, id]),
      ]);
      const payByStmt = {};
      for (const p of pays.rows) (payByStmt[p.insurance_statement_id] = payByStmt[p.insurance_statement_id] || []).push(p);
      res.json(stmts.rows.map(s => ({ ...s, payments: payByStmt[s.id] || [] })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
