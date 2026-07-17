'use strict';
/**
 * imports/routes.js — the spreadsheet-import API.
 *
 *   POST /api/import/spreadsheets            multipart, field "files" (up to 12)
 *   POST /api/import/spreadsheets?dryRun=1   parse + plan + verify, write nothing
 *   GET  /api/import/batches                 past import batch records
 *
 * multer memoryStorage on purpose: the uploaded workbooks live only in RAM for the
 * duration of the request — never the vault, never disk. Only extracted data persists.
 */
const express = require('express');
const multer = require('multer');
const { runImport } = require('./importer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 12, fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(xlsx|csv)$/i.test(file.originalname)),
});

module.exports = function makeImportRoutes(makeIO, notifyClients = () => {}) {
  const router = express.Router();

  router.post('/import/spreadsheets', upload.array('files', 12), async (req, res) => {
    const files = (req.files || []).map(f => ({ name: f.originalname, buffer: f.buffer }));
    if (!files.length) return res.status(400).json({ error: 'No .xlsx/.csv files uploaded' });
    try {
      const summary = await runImport(files, {
        userId: req.user.id,
        io: makeIO(req.user.id),
        dryRun: req.query.dryRun === '1' || req.query.dryRun === 'true',
      });
      if (!summary.dryRun) notifyClients();   // SSE → every open tab refetches accounts + txns
      res.json(summary);
    } catch (e) {
      console.error('[import] failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/import/batches', (req, res) => {
    const { read } = makeIO(req.user.id);
    res.json(read('qb_import_batches.json') || []);
  });

  return router;
};
