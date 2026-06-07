'use strict';
/**
 * Phase 3 — Reconciliation API routes
 * Mounted at /api/reconcile by server/index.js
 *
 * POST /api/reconcile/upload   — upload statement file → parse → mirror → reconcile
 * GET  /api/reconcile/status   — summary stats + uploaded file list
 * GET  /api/reconcile/flagged  — unmatched / conflict rows (?status=stmt_only|plaid_only|conflict)
 * POST /api/reconcile/run      — re-run reconciliation on already-uploaded data (?year=2026)
 */

const express  = require('express');
const multer   = require('multer');
const { query } = require('./db');
const { parseStatement, mirrorStatement, reconcileUser, getStatus, getFlagged } = require('./reconciler');

module.exports = function makeReconcileRouter(makeIO) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

  // POST /upload — parse + mirror + reconcile in one shot
  router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const userId   = req.user.id;
    const filename = req.file.originalname;
    const io       = makeIO(userId);

    try {
      const rows = await parseStatement(req.file.buffer, filename);
      if (!rows.length) {
        return res.status(422).json({
          error: 'No transactions found. Supported formats: PDF bank statements and CSV files with date, description, and amount columns (Chase, BofA, or generic).'
        });
      }

      const mirrored = await mirrorStatement(query, userId, rows, filename);

      const yearMatch = filename.match(/20\d{2}/);
      const year      = yearMatch ? parseInt(yearMatch[0]) : null;
      const summary   = await reconcileUser(query, userId, io, year);

      res.json({ ok: true, parsed: rows.length, mirrored, filename, ...summary });
    } catch (e) {
      console.error('[reconcile/upload]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

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
