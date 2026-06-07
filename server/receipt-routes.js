'use strict';
/**
 * Phase 4 — Receipt routes
 * Mounted at /api/receipts by server/index.js
 *
 * POST   /api/receipts/attach/:txnId   — upload receipt → OCR → compare → store
 * GET    /api/receipts/:txnId          — get receipts for a transaction
 * GET    /api/receipts/mismatches      — all flagged receipts for the user
 * DELETE /api/receipts/:id             — delete a receipt record + file
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { query } = require('./db');
const { ocrReceipt, compareToTxn } = require('./receipt-ocr');

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

      // 2. Find the transaction from local JSON and compare
      const txns = io.read('transactions.json') || [];
      const txn  = txns.find(t => t.id === txnId);
      if (txn) compareResult = compareToTxn(ocrData, txn);

      // 3. Save file to disk
      const ext      = path.extname(req.file.originalname) || (req.file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
      const filename = `${txnId}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      const filepath = path.join(receiptsDir(userId), filename);
      fs.writeFileSync(filepath, req.file.buffer);

      // 4. Persist to Neon
      const id = crypto.randomUUID();
      await query(
        `INSERT INTO receipts (id, user_id, txn_id, file_path, original_name, mime_type, ocr_data, match_status, match_flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id, userId, txnId, filepath, req.file.originalname, req.file.mimetype,
          JSON.stringify(ocrData),
          compareResult?.status || 'unreviewed',
          JSON.stringify(compareResult?.flags || []),
        ]
      );

      res.json({ ok: true, id, ocrData, match: compareResult });
    } catch (e) {
      console.error('[receipt/attach]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /:txnId — receipts for one transaction
  router.get('/:txnId', async (req, res) => {
    try {
      const r = await query(
        `SELECT id, txn_id, original_name, mime_type, ocr_data, match_status, match_flags, created_at
           FROM receipts WHERE user_id=$1 AND txn_id=$2 ORDER BY created_at DESC`,
        [req.user.id, req.params.txnId]
      );
      res.json(r.rows.map(row => ({
        ...row,
        ocr_data:    typeof row.ocr_data    === 'string' ? JSON.parse(row.ocr_data)    : row.ocr_data,
        match_flags: typeof row.match_flags === 'string' ? JSON.parse(row.match_flags) : row.match_flags,
      })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /mismatches — all flagged receipts for the user
  router.get('/mismatches', async (req, res) => {
    try {
      const r = await query(
        `SELECT id, txn_id, original_name, mime_type, ocr_data, match_status, match_flags, created_at
           FROM receipts WHERE user_id=$1 AND match_status IN ('mismatch','partial')
           ORDER BY created_at DESC LIMIT 100`,
        [req.user.id]
      );
      res.json(r.rows.map(row => ({
        ...row,
        ocr_data:    typeof row.ocr_data    === 'string' ? JSON.parse(row.ocr_data)    : row.ocr_data,
        match_flags: typeof row.match_flags === 'string' ? JSON.parse(row.match_flags) : row.match_flags,
      })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /:id
  router.delete('/:id', async (req, res) => {
    try {
      const r = await query(
        `DELETE FROM receipts WHERE id=$1 AND user_id=$2 RETURNING file_path`,
        [req.params.id, req.user.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      try { fs.unlinkSync(r.rows[0].file_path); } catch {}
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
