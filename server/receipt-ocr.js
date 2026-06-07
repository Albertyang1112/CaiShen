'use strict';
/**
 * Phase 4 — Receipt OCR via Claude vision
 *
 * ocrReceipt(buffer, mimeType)
 *   Sends the image/PDF to Claude and extracts { merchant, total, date, items }.
 *
 * compareToTxn(ocrData, txn)
 *   Fuzzy-compares OCR result against a Plaid transaction.
 *   Returns { status: 'matched'|'mismatch'|'partial', flags: string[] }
 */

const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM = `You are a receipt parser. Extract transaction data from the image or PDF of a receipt.
Return ONLY valid JSON — no markdown, no explanation — in this exact shape:
{
  "merchant": "string — store/restaurant/vendor name",
  "total":    number  — final charged amount (positive, in dollars, e.g. 14.99),
  "date":     "YYYY-MM-DD" — transaction date on the receipt,
  "items":    [ { "desc": "string", "amount": number } ]  — line items if visible, else []
}
If a field cannot be determined, use null. Always return valid JSON.`;

async function ocrReceipt(buffer, mimeType) {
  // Supported image types for Claude vision
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const isImage = imageTypes.includes(mimeType);
  const isPDF   = mimeType === 'application/pdf';

  if (!isImage && !isPDF) throw new Error(`Unsupported file type: ${mimeType}`);

  const base64 = buffer.toString('base64');
  const source = isPDF
    ? { type: 'base64', media_type: 'application/pdf', data: base64 }
    : { type: 'base64', media_type: mimeType, data: base64 };

  const contentBlock = isPDF
    ? { type: 'document', source }
    : { type: 'image',    source };

  const msg = await getClient().messages.create({
    model:      'claude-opus-4-5',   // vision-capable, best for receipts
    max_tokens: 512,
    system:     SYSTEM,
    messages:   [{ role: 'user', content: [contentBlock, { type: 'text', text: 'Extract the receipt data.' }] }],
  });

  const raw = msg.content[0]?.text || '{}';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { merchant: null, total: null, date: null, items: [] };
  }
}

// ── Comparison helpers ────────────────────────────────────────────────────────
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(t => t.length >= 3 && !/^\d+$/.test(t));
function nameSim(a, b) {
  const ta = new Set(toks(a)), tb = new Set(toks(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

function compareToTxn(ocrData, txn) {
  const flags = [];
  let mismatches = 0;

  // Amount: receipt total vs |txn.amount| (Plaid amounts are negative for debits)
  if (ocrData.total != null && txn.amount != null) {
    const diff = Math.abs(Math.abs(txn.amount) - ocrData.total);
    if (diff > 0.01) {
      flags.push(`Amount mismatch: receipt $${ocrData.total.toFixed(2)} vs Plaid $${Math.abs(txn.amount).toFixed(2)}`);
      mismatches++;
    }
  }

  // Date: receipt date vs txn.date (allow ±1 day — post-date vs charge-date)
  if (ocrData.date && txn.date) {
    const dd = Math.abs((new Date(ocrData.date) - new Date(txn.date)) / 86400000);
    if (dd > 1) {
      flags.push(`Date mismatch: receipt ${ocrData.date} vs Plaid ${txn.date} (${Math.round(dd)} day gap)`);
      mismatches++;
    }
  }

  // Merchant name similarity
  if (ocrData.merchant && txn.desc) {
    const sim = nameSim(ocrData.merchant, txn.desc);
    if (sim < 0.2) {
      flags.push(`Merchant mismatch: receipt "${ocrData.merchant}" vs Plaid "${txn.desc}" (similarity ${(sim * 100).toFixed(0)}%)`);
      mismatches++;
    }
  }

  const status = mismatches === 0 ? 'matched' : mismatches === 1 ? 'partial' : 'mismatch';
  return { status, flags };
}

module.exports = { ocrReceipt, compareToTxn };
