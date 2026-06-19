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
 * GET  /api/reconcile/txn/:id     — match detail + unmatched-statement candidates for one txn
 * POST /api/reconcile/run         — re-run reconciliation on existing data (?year=2026)
 * POST /api/reconcile/match       — manually pair a statement row with a Plaid txn;
 *                                   auto-learns the merchant name pairing as an alias rule
 * GET/DELETE /api/reconcile/aliases — list / remove learned merchant alias rules
 * DELETE /api/reconcile/manual/:id — undo a manual pair
 */

const express = require('express');
const crypto = require('crypto');
const { query } = require('../core/db');
const { reconcileUser, getStatus, getFlagged, aliasToken, nameSim } = require('./reconciler');

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
  // • conflict  — amount/date matched a statement row but merchant names differ
  // • matched   — fully verified against a statement row
  // • plaid_only — in Plaid but never verified by any statement (untracked or unmatched)
  router.get('/txn-flags', async (req, res) => {
    try {
      const uid = req.user.id;

      // 1. All match-table entries for this user
      const matchRows = await query(
        `SELECT plaid_txn_id, status
           FROM statement_matches
          WHERE user_id = $1
            AND plaid_txn_id IS NOT NULL`,
        [uid]
      );

      // Priority: conflict beats matched beats plaid_only
      // (if ANY period matched it, show green; only amber when truly unmatched everywhere)
      const priority = { conflict: 3, matched: 2, plaid_only: 1, stmt_only: 0 };
      const map = {};
      for (const row of matchRows.rows) {
        const cur = map[row.plaid_txn_id];
        if (!cur || (priority[row.status] || 0) > (priority[cur] || 0)) {
          map[row.plaid_txn_id] = row.status;
        }
      }

      // 2. Any Plaid transaction with NO entry at all → amber (unverified)
      const allPlaid = await query(
        `SELECT id FROM source_transactions WHERE user_id = $1 AND source = 'plaid'`,
        [uid]
      );
      for (const row of allPlaid.rows) {
        if (!map[row.id]) map[row.id] = 'plaid_only';
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

  // ── Manual matching + learned merchant alias rules ───────────────────────────
  // Fixes for matches the fuzzy engine missed:
  //   • manual links — explicitly pair one statement row with one Plaid transaction
  //   • alias rules  — name equivalences (Walmart ↔ WM SUPERCENTER), learned
  //     AUTOMATICALLY from each manual match; GET/DELETE manage them
  // Both persist per-user (reconcile_manual.json / reconcile_aliases.json) and are
  // re-applied by reconcileUser on every run.

  // GET /txn/:id — match detail for ONE Plaid transaction; powers the "Statement
  // match" panel in the Banking transaction popup. Returns:
  //   status       — 'matched' | 'conflict' | 'plaid_only' | null (never reconciled)
  //   matchedStmt  — the statement row it verified against (when matched/conflict)
  //   manualLinkId — id of the manual link backing this match (so it can be undone)
  //   candidates   — unmatched statement rows the user can pair it with (when unmatched)
  router.get('/txn/:id', async (req, res) => {
    try {
      const uid   = req.user.id;
      const txnId = req.params.id;

      const m = await query(
        `SELECT sm.status, sm.flag_reason, sm.stmt_source_id,
                st.txn_date::text AS stmt_date, st.description AS stmt_desc,
                st.amount::float AS stmt_amount, st.source_file
           FROM statement_matches sm
           LEFT JOIN source_transactions st ON st.id = sm.stmt_source_id AND st.user_id = sm.user_id
          WHERE sm.user_id = $1 AND sm.plaid_txn_id = $2
          ORDER BY CASE sm.status WHEN 'conflict' THEN 3 WHEN 'matched' THEN 2 ELSE 1 END DESC
          LIMIT 1`, [uid, txnId]);
      const row    = m.rows[0] || null;
      const status = row ? row.status : null;

      const links = makeIO(uid).read('reconcile_manual.json') || [];
      const link  = links.find(l => l && l.plaidTxnId === txnId) || null;

      let candidates = [], stmtRowCount = 0;
      if (status !== 'matched' && status !== 'conflict') {
        // stmtRowCount lets the UI distinguish "this account has no statement data at
        // all" from "statements exist but none are unmatched near this date".
        const cnt = await query(
          `SELECT COUNT(*)::int AS c FROM source_transactions WHERE user_id=$1 AND source='statement'`, [uid]);
        stmtRowCount = cnt.rows[0].c;
        if (stmtRowCount > 0) {
          // Window candidates to the txn's own date ±4 days (the engine's range) —
          // a bare recency LIMIT crowded out the window for older transactions.
          const txnRes  = await query(
            `SELECT txn_date::text AS d FROM transactions WHERE user_id=$1 AND id=$2`, [uid, txnId]);
          const txnDate = txnRes.rows[0]?.d || null;
          const dateFilter = txnDate ? `AND st.txn_date BETWEEN $2::date - 4 AND $2::date + 4` : '';
          const c = await query(
            `SELECT st.id AS stmt_source_id, st.txn_date::text AS date, st.description AS desc,
                    st.amount::float AS amount, st.source_file
               FROM statement_matches sm
               JOIN source_transactions st ON st.id = sm.stmt_source_id AND st.user_id = sm.user_id
              WHERE sm.user_id = $1 AND sm.status = 'stmt_only' ${dateFilter}
              ORDER BY st.txn_date DESC
              LIMIT 200`,
            txnDate ? [uid, txnDate] : [uid]);
          candidates = c.rows;
        }
      }

      res.json({
        status,
        flagReason:   row ? row.flag_reason : null,
        manualLinkId: link ? link.id : null,
        matchedStmt:  row && row.stmt_source_id
          ? { date: row.stmt_date, desc: row.stmt_desc, amount: row.stmt_amount, sourceFile: row.source_file }
          : null,
        candidates,
        stmtRowCount,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /aliases — list saved merchant alias rules
  router.get('/aliases', (req, res) => {
    res.json(makeIO(req.user.id).read('reconcile_aliases.json') || []);
  });

  // DELETE /aliases/:id — remove a rule, then re-run so matches it caused revert
  router.delete('/aliases/:id', async (req, res) => {
    try {
      const io = makeIO(req.user.id);
      const aliases = io.read('reconcile_aliases.json') || [];
      io.write('reconcile_aliases.json', aliases.filter(a => a.id !== req.params.id));
      const summary = await reconcileUser(query, req.user.id, io);
      res.json({ ok: true, ...summary });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /manual/:id — drop a manual link, then re-run so the pair frees up
  router.delete('/manual/:id', async (req, res) => {
    try {
      const io = makeIO(req.user.id);
      const links = io.read('reconcile_manual.json') || [];
      io.write('reconcile_manual.json', links.filter(l => l.id !== req.params.id));
      const summary = await reconcileUser(query, req.user.id, io);
      res.json({ ok: true, ...summary });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /match — pair a statement row with a Plaid txn (body: { stmtSourceId,
  // plaidTxnId }), then AUTO-LEARN the merchant name pairing as an alias rule
  // (e.g. Plaid "Walmart" ↔ statement "WM SUPERCENTER") so every future pair with
  // these names matches on its own. The engine still verifies amount and date, so
  // repeat purchases pair with the correct occurrence. Re-runs reconciliation,
  // which immediately applies the new rule to all other unmatched rows.
  router.post('/match', async (req, res) => {
    try {
      const uid = req.user.id;
      const io  = makeIO(uid);
      const plaidTxnId   = String(req.body?.plaidTxnId   || '').trim();
      const stmtSourceId = String(req.body?.stmtSourceId || '').trim();
      if (!plaidTxnId || !stmtSourceId) return res.status(400).json({ error: 'plaidTxnId and stmtSourceId are required' });

      // One statement row ↔ one Plaid txn — drop any prior link on either side first.
      const links = io.read('reconcile_manual.json') || [];
      const next = links.filter(l => l.stmtSourceId !== stmtSourceId && l.plaidTxnId !== plaidTxnId);
      next.push({ id: crypto.randomUUID(), stmtSourceId, plaidTxnId, createdAt: new Date().toISOString() });
      io.write('reconcile_manual.json', next);

      // Auto-learn the pairing — only when the two names share no significant token
      // (otherwise the fuzzy matcher already handles them), and only once per
      // distinct token pair. Non-fatal: the manual link above stands regardless.
      let rule = null;
      try {
        const stmtRes   = await query(`SELECT description FROM source_transactions WHERE user_id=$1 AND id=$2`, [uid, stmtSourceId]);
        const stmtDesc  = stmtRes.rows[0]?.description || '';
        const txns      = await require('../core/banking-store').listTransactions(uid) || [];
        const plaidDesc = (txns.find(t => t.id === plaidTxnId) || {}).desc || '';
        const ap = aliasToken(plaidDesc), as = aliasToken(stmtDesc);
        if (ap && as && nameSim(plaidDesc, stmtDesc) <= 0) {
          const aliases = io.read('reconcile_aliases.json') || [];
          rule = aliases.find(a => a && aliasToken(a.plaid) === ap && aliasToken(a.statement) === as) || null;
          if (!rule) {
            rule = { id: crypto.randomUUID(), plaid: ap, statement: as, auto: true, enabled: true, createdAt: new Date().toISOString() };
            aliases.push(rule);
            io.write('reconcile_aliases.json', aliases);
          }
        }
      } catch (e) { console.error('[reconcile] auto-alias learn failed:', e.message); }

      const summary = await reconcileUser(query, uid, io);
      res.json({ ok: true, rule, ...summary });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
