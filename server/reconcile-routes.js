'use strict';
/**
 * Reconciliation API routes
 * Mounted at /api/reconcile by server/index.js
 *
 * Reconciliation is automatic — triggered by the bank scraper (after PDF download)
 * and by Plaid sync (re-matches new transactions against existing statement data).
 * No manual upload required.
 *
 * GET  /api/reconcile/status      — summary stats + statement file list
 * GET  /api/reconcile/flagged     — flagged rows (?status=stmt_only|plaid_only|conflict)
 * GET  /api/reconcile/txn-flags   — {plaid_txn_id → status} map for inline Banking display
 * POST /api/reconcile/run         — re-run reconciliation on existing data (?year=2026)
 */

const express = require('express');
const { query } = require('./db');
const { reconcileUser, getStatus, getFlagged } = require('./reconciler');

module.exports = function makeReconcileRouter(makeIO) {
  const router = express.Router();

  // GET /status
  router.get('/status', async (req, res) => {
    try {
      res.json(await getStatus(query, req.user.id));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /flagged?status=stmt_only|plaid_only|conflict
  router.get('/flagged', async (req, res) => {
    try {
      res.json(await getFlagged(query, req.user.id, req.query.status));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /txn-flags — lightweight map for inline transaction-row badges
  // Returns: { [plaid_txn_id]: 'matched' | 'conflict' | 'plaid_only' }
  router.get('/txn-flags', async (req, res) => {
    try {
      const r = await query(
        `SELECT plaid_txn_id, status
           FROM statement_matches
          WHERE user_id = $1
            AND plaid_txn_id IS NOT NULL
          ORDER BY period_year DESC`,
        [req.user.id]
      );
      // One entry per Plaid txn — prefer conflict > plaid_only > matched if dupes
      const priority = { conflict: 3, plaid_only: 2, matched: 1, stmt_only: 0 };
      const map = {};
      for (const row of r.rows) {
        const cur = map[row.plaid_txn_id];
        if (!cur || (priority[row.status] || 0) > (priority[cur] || 0)) {
          map[row.plaid_txn_id] = row.status;
        }
      }
      res.json(map);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /run — re-reconcile without re-uploading
  router.post('/run', async (req, res) => {
    try {
      const io      = makeIO(req.user.id);
      const year    = req.body?.year ? parseInt(req.body.year) : null;
      const summary = await reconcileUser(query, req.user.id, io, year);
      res.json({ ok: true, ...summary });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
