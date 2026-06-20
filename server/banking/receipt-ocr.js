'use strict';
/**
 * banking/receipt-ocr.js — extract { merchant, total, date, items } from a receipt.
 *
 *   ocrReceipt(buffer, mimeType)  → { merchant, total, date, items }
 *   compareToTxn(ocrData, txn)    → { status: 'matched'|'partial'|'mismatch', flags[] }
 *
 * Provider (auto-selected; override with RECEIPT_OCR_PROVIDER=groq|anthropic):
 *   • Groq (default when GROQ_API_KEY is set — free): a vision model reads photos/images;
 *     PDFs go through pdf2json's text layer → a Groq text model. No image OCR for scanned
 *     (textless) PDFs — those return blanks, which the caller handles gracefully.
 *   • Anthropic (fallback): Claude vision reads images AND PDFs (incl. scanned) natively.
 */
const axios = require('axios');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM = `You are a receipt parser with a gatekeeper step. FIRST decide whether the
image (or text) is a genuine PROOF OF PURCHASE — a store receipt, invoice, or order/purchase
confirmation. Anything else (a random photo, selfie, a screenshot of an app or website that
is not an order confirmation, a menu, a flyer, a meme) is NOT a proof of purchase.
Return ONLY valid JSON (no markdown, no prose) in exactly this shape:
{"is_receipt": boolean, "doc_type": "receipt"|"invoice"|"order_confirmation"|"other", "merchant": string, "total": number, "date": "YYYY-MM-DD", "time": "HH:MM", "receipt_number": string, "order_number": string, "invoice_number": string, "card_last4": string, "items": [{"desc": string, "amount": number}]}
Rules:
- is_receipt is true ONLY for a receipt, invoice, or order/purchase confirmation; otherwise false.
- If is_receipt is false, set every other field to null and items to [].
- total = the final charged amount in dollars (e.g. 14.99).
- time = 24-hour HH:MM if a purchase time is shown; card_last4 = the last 4 digits of the card if shown.
- receipt_number / order_number / invoice_number = the document's identifier if shown.
- Use null for anything you cannot determine. items may be []. Always return valid JSON.`;

// ── JSON helpers (exported for tests) ────────────────────────────────────────
function parseOcrJson(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(s); }
  catch { const m = s.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } } }
  return {};
}
function num(v) {
  if (v == null || v === '') return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;   // no digits → unknown
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function normalizeOcr(o) {
  o = o || {};
  const s = (v) => (v != null && String(v).trim() ? String(v).trim() : null);
  return {
    is_receipt: typeof o.is_receipt === 'boolean' ? o.is_receipt : null,   // null = model didn't classify
    doc_type: s(o.doc_type),
    merchant: s(o.merchant),
    total: num(o.total),
    date: s(o.date),
    time: s(o.time),
    receipt_number: s(o.receipt_number),
    order_number: s(o.order_number),
    invoice_number: s(o.invoice_number),
    card_last4: o.card_last4 != null ? (String(o.card_last4).replace(/\D/g, '').slice(-4) || null) : null,
    items: Array.isArray(o.items)
      ? o.items.map(it => ({ desc: (it && (it.desc ?? it.name)) ?? null, amount: num(it && it.amount) }))
      : [],
  };
}

// ── Provider selection ───────────────────────────────────────────────────────
const isReal = (k, placeholder) => !!k && k !== placeholder;
function pickProvider() {
  const override = (process.env.RECEIPT_OCR_PROVIDER || '').toLowerCase();
  if (override === 'groq' || override === 'anthropic') return override;
  if (isReal(process.env.GROQ_API_KEY, 'your_groq_api_key_here')) return 'groq';
  if (isReal(process.env.ANTHROPIC_API_KEY, 'your_anthropic_api_key_here')) return 'anthropic';
  return 'none';
}

async function ocrReceipt(buffer, mimeType) {
  const provider = pickProvider();
  if (provider === 'groq')      return ocrViaGroq(buffer, mimeType);
  if (provider === 'anthropic') return ocrViaAnthropic(buffer, mimeType);
  throw new Error('No receipt OCR provider configured — set GROQ_API_KEY (or ANTHROPIC_API_KEY) in .env');
}

// ── Groq (free): vision for images, pdf2json text → text model for PDFs ───────
async function groqChat(model, messages) {
  const resp = await axios.post(GROQ_URL,
    { model, messages, max_tokens: 1024, temperature: 0 },
    { headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY }, timeout: 30000 });
  return normalizeOcr(parseOcrJson(resp.data?.choices?.[0]?.message?.content || '{}'));
}

async function ocrViaGroq(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    let text = '';
    try { text = await require('../core/pdf-parser').extractRawText(buffer); } catch { /* no text layer */ }
    if (!text || text.trim().length < 10) return { merchant: null, total: null, date: null, items: [] };
    return groqChat(process.env.GROQ_MODEL || 'openai/gpt-oss-120b', [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: `Parse this receipt text:\n\n${text.slice(0, 8000)}` },
    ]);
  }
  if (!/^image\//.test(mimeType || '')) throw new Error(`Unsupported file type: ${mimeType}`);
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  return groqChat(process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct', [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: 'Extract the receipt data from this image.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] },
  ]);
}

// ── Anthropic (fallback): Claude vision reads images + PDFs natively ─────────
let _anthropic = null;
function anthropicClient() {
  if (!_anthropic) { const Anthropic = require('@anthropic-ai/sdk'); _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  return _anthropic;
}
async function ocrViaAnthropic(buffer, mimeType) {
  const isImage = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType);
  const isPDF   = mimeType === 'application/pdf';
  if (!isImage && !isPDF) throw new Error(`Unsupported file type: ${mimeType}`);
  const source = { type: 'base64', media_type: isPDF ? 'application/pdf' : mimeType, data: buffer.toString('base64') };
  const block  = isPDF ? { type: 'document', source } : { type: 'image', source };
  const msg = await anthropicClient().messages.create({
    model: 'claude-opus-4-5', max_tokens: 512, system: SYSTEM,
    messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extract the receipt data.' }] }],
  });
  return normalizeOcr(parseOcrJson(msg.content?.[0]?.text || '{}'));
}

// ── Comparison helpers (unchanged) ───────────────────────────────────────────
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

  if (ocrData.total != null && txn.amount != null) {
    const diff = Math.abs(Math.abs(txn.amount) - ocrData.total);
    if (diff > 0.01) {
      flags.push(`Amount mismatch: receipt $${ocrData.total.toFixed(2)} vs Plaid $${Math.abs(txn.amount).toFixed(2)}`);
      mismatches++;
    }
  }

  if (ocrData.date && txn.date) {
    const dd = Math.abs((new Date(ocrData.date) - new Date(txn.date)) / 86400000);
    if (dd > 1) {
      flags.push(`Date mismatch: receipt ${ocrData.date} vs Plaid ${txn.date} (${Math.round(dd)} day gap)`);
      mismatches++;
    }
  }

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

module.exports = { ocrReceipt, compareToTxn, parseOcrJson, normalizeOcr, pickProvider };
