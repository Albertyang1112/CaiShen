'use strict';
// Smoke-test Groq receipt OCR + the is_receipt gatekeeper end-to-end. Renders a real
// receipt and a non-receipt image and checks classification + extraction.
// Usage: node server/scripts/test-groq-vision.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const sharp = require('sharp');
const { ocrReceipt, pickProvider } = require('../banking/receipt-ocr');

const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

const RECEIPT = `<svg width="420" height="280" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="white"/>
  <text x="24" y="52"  font-size="30" font-family="monospace" fill="black">WALMART</text>
  <text x="24" y="104" font-size="22" font-family="monospace" fill="black">Date: 2026-06-15</text>
  <text x="24" y="150" font-size="22" font-family="monospace" fill="black">Milk        3.50</text>
  <text x="24" y="186" font-size="22" font-family="monospace" fill="black">Bread       2.99</text>
  <text x="24" y="240" font-size="28" font-family="monospace" fill="black">TOTAL   $14.99</text>
</svg>`;

const NOT_RECEIPT = `<svg width="420" height="280" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#cfe8ff"/>
  <text x="30" y="70"  font-size="34" font-family="sans-serif" fill="#003">My Travel Bucket List</text>
  <text x="30" y="130" font-size="26" font-family="sans-serif" fill="#003">1. Paris</text>
  <text x="30" y="172" font-size="26" font-family="sans-serif" fill="#003">2. Tokyo</text>
  <text x="30" y="214" font-size="26" font-family="sans-serif" fill="#003">3. Rome</text>
</svg>`;

(async () => {
  console.log('provider:', pickProvider(), '| model:', process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct');
  for (const [label, svg] of [['RECEIPT', RECEIPT], ['NOT a receipt', NOT_RECEIPT]]) {
    try {
      const r = await ocrReceipt(await png(svg), 'image/png');
      console.log(`\n[${label}] is_receipt=${r.is_receipt} doc_type=${r.doc_type} merchant=${r.merchant} total=${r.total}`);
    } catch (e) { console.error(`[${label}] ERROR:`, e.response?.data?.error?.message || e.message); }
  }
  process.exit(0);
})();
