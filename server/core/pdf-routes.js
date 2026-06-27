'use strict';
/**
 * core/pdf-routes.js — extracted from index.js. Two multipart PDF endpoints:
 *   POST /api/parse-statement — Claude Vision extracts transactions from a statement PDF
 *   POST /api/pdf-render      — pdf2json raw-text extraction (client PDF preview text layer)
 * Mounted at /api. Owns its own in-memory multer (no app-level coupling).
 */
const express = require('express');
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage() });

module.exports = function makePdfRoutes() {
  const router = express.Router();

  router.post('/parse-statement', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const axios = require('axios');
      const base64 = req.file.buffer.toString('base64');
      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-opus-4-7', max_tokens: 2000,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Extract all transactions from this bank statement. Return ONLY a JSON array with objects: { date: "YYYY-MM-DD", desc: "merchant name", amount: -123.45 }. Negative amounts for expenses, positive for deposits. No markdown, no explanation, just the JSON array.' },
        ] }],
      }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
      const text = response.data.content[0].text;
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      const transactions = parsed.map((t, i) => {
        const date = new Date(t.date);
        return { id: `pdf_${i}_${Date.now()}`, date: t.date, desc: t.desc, amount: t.amount, category: 'Other', source: 'pdf', month: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` };
      });
      res.json({ transactions });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/pdf-render', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const PDFParser = require('pdf2json');
      const parser = new PDFParser();
      await new Promise((resolve, reject) => {
        parser.on('pdfParser_dataReady', resolve);
        parser.on('pdfParser_dataError', reject);
        parser.parseBuffer(req.file.buffer);
      });
      res.json({ text: parser.getRawTextContent(), pages: parser.data?.Pages?.length || 0 });
    } catch (e) { res.status(500).json({ error: e.message, text: '', pages: 0 }); }
  });

  return router;
};
