'use strict';
/**
 * Phase 4 — Receipt routes
 * Mounted at /api/receipts by server/index.js
 *
 * POST   /api/receipts/attach/:txnId   — upload receipt → OCR → compare → store
 * GET    /api/receipts/counts          — { txnId → receipt count } (table 📎 indicator)
 * GET    /api/receipts/mismatches      — all flagged receipts for the user
 * GET    /api/receipts/file/:id        — serve the receipt bytes (R2; disk fallback)
 * GET    /api/receipts/:txnId          — get receipts for a transaction
 * DELETE /api/receipts/:id             — delete a receipt record + file
 *
 * Storage (Phase 5): bytes go to R2 via core/documents (doc_id links the
 * documents row); local disk is only a fallback when R2 isn't configured,
 * plus read/delete support for legacy rows that pre-date the migration.
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { query } = require('../core/db');
const r2        = require('../core/r2');
const documents = require('../core/documents');
const { ocrReceipt, compareToTxn } = require('./receipt-ocr');
const { recordReceiptRemodel } = require('./receipt-store');

const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];

module.exports = function makeReceiptRouter(makeIO, DATA_DIR) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, SUPPORTED.includes(file.mimetype)),
  });

  function receiptsDir(userId) {
    const d = path.join(DATA_DIR, 'users', userId, 'receipts');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  const rowShape = (row) => ({
    ...row,
    ocr_data:    typeof row.ocr_data    === 'string' ? JSON.parse(row.ocr_data)    : row.ocr_data,
    match_flags: typeof row.match_flags === 'string' ? JSON.parse(row.match_flags) : row.match_flags,
  });

  // POST /attach/:txnId
  router.post('/attach/:txnId', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file or unsupported type. Supported: JPEG, PNG, WebP, GIF, PDF.' });
    const userId = req.user.id;
    const txnId  = req.params.txnId;
    const io     = makeIO(userId);

    try {
      // 1. OCR the receipt
      let ocrData = null, compareResult = null;
      try {
        ocrData = await ocrReceipt(req.file.buffer, req.file.mimetype);
      } catch (e) {
        console.error('[receipt-ocr] OCR failed:', e.message);
        ocrData = { merchant: null, total: null, date: null, items: [] };
      }

      // 2. Find the transaction and compare
      const txns = io.read('transactions.json') || [];
      const txn  = txns.find(t => t.id === txnId);
      if (txn) compareResult = compareToTxn(ocrData, txn);

      // 3. Store bytes — R2 + documents row; disk only if R2 is unavailable.
      const ext  = path.extname(req.file.originalname) || (req.file.mimetype === 'application/pdf' ? '.pdf' : '.png');
      const name = req.file.originalname || `receipt${ext}`;
      let docId = null, filePath = null;
      if (r2.configured) {
        try {
          docId = `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const { key } = await documents.saveDocument({
            id: docId, userId, name, mimeType: req.file.mimetype, bytes: req.file.buffer,
            folderPath: 'receipts', tags: { txnId },
          });
          filePath = key;   // R2 object key (file_path is NOT NULL; doc_id marks R2 rows)
        } catch (e) {
          console.error('[receipt/attach] R2 store failed, falling back to disk:', e.message);
          docId = null;
        }
      }
      if (!docId) {
        const filename = `${txnId}_${crypto.randomBytes(4).toString('hex')}${ext}`;
        filePath = path.join(receiptsDir(userId), filename);
        fs.writeFileSync(filePath, req.file.buffer);
      }

      // 4. Persist to Neon
      const id = crypto.randomUUID();
      await query(
        `INSERT INTO receipts (id, user_id, txn_id, file_path, doc_id, original_name, mime_type, ocr_data, match_status, match_flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id, userId, txnId, filePath, docId, name, req.file.mimetype,
          JSON.stringify(ocrData),
          compareResult?.status || 'unreviewed',
          JSON.stringify(compareResult?.flags || []),
        ]
      );

      // 5. Remodel write-flow (best-effort): receipt_items + source_transactions +
      //    period + the receipt→transaction evidence link. Never fails the upload.
      try {
        const matchScore = compareResult
          ? (compareResult.status === 'matched' ? 1 : compareResult.status === 'partial' ? 0.5 : 0.1)
          : null;
        await recordReceiptRemodel(query, { userId, receiptId: id, txnId, txn, ocrData, matchScore });
      } catch (e) { console.error('[receipt/remodel]', e.message); }

      res.json({ ok: true, id, ocrData, match: compareResult });
    } catch (e) {
      console.error('[receipt/attach]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /counts — { txnId → receipt count } for the transactions-table 📎 indicator.
  // Declared before /:txnId so the literal path isn't captured by the param route.
  router.get('/counts', async (req, res) => {
    try {
      const r = await query(
        `SELECT txn_id, COUNT(*)::int AS n FROM receipts WHERE user_id=$1 GROUP BY txn_id`,
        [req.user.id]
      );
      res.json(Object.fromEntries(r.rows.map(row => [row.txn_id, row.n])));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /mismatches — all flagged receipts for the user.
  // Must also precede /:txnId (it used to sit after it and was unreachable).
  router.get('/mismatches', async (req, res) => {
    try {
      const r = await query(
        `SELECT id, txn_id, original_name, mime_type, ocr_data, match_status, match_flags, created_at
           FROM receipts WHERE user_id=$1 AND match_status IN ('mismatch','partial')
           ORDER BY created_at DESC LIMIT 100`,
        [req.user.id]
      );
      res.json(r.rows.map(rowShape));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /file/:id — the receipt bytes themselves (image/PDF preview + download).
  // R2 for migrated/new rows (doc_id set); disk for legacy rows. Auth comes from
  // the /api JWT middleware — the client fetches with the token and shows a blob.
  router.get('/file/:id', async (req, res) => {
    try {
      const r = await query(
        `SELECT file_path, doc_id, mime_type, original_name FROM receipts WHERE id=$1 AND user_id=$2`,
        [req.params.id, req.user.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const { file_path, doc_id, mime_type, original_name } = r.rows[0];
      res.setHeader('Content-Type', mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${(original_name || 'receipt').replace(/["\r\n]/g, '')}"`);
      if (doc_id) {
        try {
          const bytes = await documents.getDocumentBytes(req.user.id, doc_id);
          if (bytes) return res.send(bytes);
        } catch (e) { /* fall through to disk */ }
      }
      if (file_path && !file_path.startsWith(`${req.user.id}/`) && fs.existsSync(file_path)) {
        return res.sendFile(file_path);
      }
      res.status(404).json({ error: 'File missing' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /:txnId — receipts for one transaction
  router.get('/:txnId', async (req, res) => {
    try {
      const r = await query(
        `SELECT id, txn_id, original_name, mime_type, match_status, match_flags, ocr_data, created_at
           FROM receipts WHERE user_id=$1 AND txn_id=$2 ORDER BY created_at DESC`,
        [req.user.id, req.params.txnId]
      );
      res.json(r.rows.map(rowShape));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /:id
  router.delete('/:id', async (req, res) => {
    try {
      const r = await query(
        `DELETE FROM receipts WHERE id=$1 AND user_id=$2 RETURNING file_path, doc_id`,
        [req.params.id, req.user.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const { file_path, doc_id } = r.rows[0];
      if (doc_id) {
        try { await documents.deleteDocument(req.user.id, doc_id); } catch (e) { /* row gone; orphan object is harmless */ }
      } else {
        try { fs.unlinkSync(file_path); } catch {}
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
