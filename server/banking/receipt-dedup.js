'use strict';
/**
 * receipt-dedup.js — duplicate scoring + the SMS reply classifier.
 *
 *   dedupeScore(neu, existing)  → { level:'hard'|'possible'|'unique', score, reason, signals }
 *   findDuplicate(query, userId, neu) → best match across the user's active receipts
 *   classifyDedupReply(text, deps)    → { decision:'same'|'separate'|'unsure', detail:string|null }
 *
 * `neu`/`existing` shape: { file_sha256, perceptual_hash, ocr_text_hash, ocr:{merchant,total,date,
 * time,receipt_number,order_number,invoice_number,card_last4,items[]} }. Scoring is deterministic
 * (hashes + structured fields) so it's fast + auditable; Groq is used only to read the user's reply.
 */
const axios = require('axios');
const { hamming } = require('./receipt-hash');

const GROQ_URL  = 'https://api.groq.com/openai/v1/chat/completions';
const PHASH_HARD = 6;   // hamming ≤ this ⇒ same image

const normName = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const amtEq = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= 0.01;
const strEq = (a, b) => !!(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function merchantSim(a, b) {
  const ta = new Set(normName(a).split(' ').filter(t => t.length >= 3));
  const tb = new Set(normName(b).split(' ').filter(t => t.length >= 3));
  if (!ta.size || !tb.size) return 0;
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}
function itemSim(ia, ib) {
  const A = new Set((ia || []).map(i => String((i && i.desc) || '').toLowerCase().trim()).filter(Boolean));
  const B = new Set((ib || []).map(i => String((i && i.desc) || '').toLowerCase().trim()).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);   // Jaccard
}

const hard     = (reason, signals) => ({ level: 'hard', score: 1.0, reason, signals });
const possible = (reason, score, signals) => ({ level: 'possible', score, reason, signals });
const unique   = () => ({ level: 'unique', score: 0, reason: null, signals: {} });

// Score the new receipt against ONE existing receipt.
function dedupeScore(neu, existing) {
  const a = neu.ocr || {}, b = existing.ocr || {};

  // ── hard signals ──
  if (neu.file_sha256 && existing.file_sha256 && neu.file_sha256 === existing.file_sha256)
    return hard('file_hash', { file_hash: true });
  if (strEq(a.receipt_number, b.receipt_number)) return hard('receipt_number', { receipt_number: a.receipt_number });
  if (strEq(a.order_number,   b.order_number))   return hard('order_number',   { order_number: a.order_number });
  if (strEq(a.invoice_number, b.invoice_number)) return hard('invoice_number', { invoice_number: a.invoice_number });
  if (neu.ocr_text_hash && existing.ocr_text_hash && neu.ocr_text_hash === existing.ocr_text_hash)
    return hard('ocr_text', { ocr_text: true });
  // Rotation-invariant: match the new upload's hash at ANY 90° rotation against the existing
  // (upright) hash — so the same photo flipped/rotated is still caught as the same image.
  const neuPhashes = (neu.perceptual_hashes && neu.perceptual_hashes.length)
    ? neu.perceptual_hashes : (neu.perceptual_hash ? [neu.perceptual_hash] : []);
  if (neuPhashes.length && existing.perceptual_hash) {
    let dist = Infinity, bestIdx = 0;
    for (let i = 0; i < neuPhashes.length; i++) {
      const d = hamming(neuPhashes[i], existing.perceptual_hash);
      if (d < dist) { dist = d; bestIdx = i; }
    }
    if (dist <= PHASH_HARD) return hard('image_perceptual', { phash_distance: dist, rotated_deg: [0, 90, 180, 270][bestIdx] });
  }
  const merchOk = merchantSim(a.merchant, b.merchant) >= 0.5;
  if (merchOk && amtEq(a.total, b.total) && strEq(a.date, b.date) && strEq(a.time, b.time) && strEq(a.card_last4, b.card_last4) && a.time && a.card_last4)
    return hard('merchant_time_total_card', { merchant: true, total: true, date: true, time: a.time, card_last4: a.card_last4 });

  // ── possible signals ──
  if (merchOk && amtEq(a.total, b.total) && strEq(a.date, b.date))
    return possible('merchant_amount_date', 0.75, { merchant: a.merchant, total: a.total, date: a.date });
  const isim = itemSim(a.items, b.items);
  if (merchOk && amtEq(a.total, b.total) && isim >= 0.6)
    return possible('merchant_amount_items', 0.6, { merchant: a.merchant, total: a.total, item_similarity: Number(isim.toFixed(2)) });

  return unique();
}

const rank = l => (l === 'hard' ? 2 : l === 'possible' ? 1 : 0);

// Best duplicate across the user's ACTIVE receipts (excludes rejected/hard-dupe rows + self).
async function findDuplicate(query, userId, neu, { excludeId = null } = {}) {
  const r = await query(
    `SELECT id, doc_id, file_sha256, perceptual_hash, ocr_text_hash, ocr_data, merchant_name, receipt_date, total_amount, created_at
       FROM receipts
      WHERE user_id=$1
        AND (review_status IS NULL OR review_status <> 'rejected_duplicate')
        AND (duplicate_status IS NULL OR duplicate_status NOT IN ('hard_duplicate','confirmed_duplicate'))
      ORDER BY created_at DESC LIMIT 300`, [userId]);
  let best = { ...unique(), matchedReceiptId: null, existing: null };
  for (const row of r.rows) {
    if (excludeId && row.id === excludeId) continue;
    const ex = { file_sha256: row.file_sha256, perceptual_hash: row.perceptual_hash, ocr_text_hash: row.ocr_text_hash, ocr: row.ocr_data || {} };
    const s = dedupeScore(neu, ex);
    if (rank(s.level) > rank(best.level) || (rank(s.level) === rank(best.level) && s.score > best.score)) {
      best = { ...s, matchedReceiptId: row.id, existing: row };
    }
    if (best.level === 'hard') break;
  }
  return best;
}

// ── reply classifier ──────────────────────────────────────────────────────
async function classifyDedupReply(text, deps = {}) {
  const t = String(text || '').trim();
  if (/^\s*(same|same purchase|duplicate|dupe|yes,?\s*same.*|that'?s the same.*)\s*$/i.test(t)) return { decision: 'same', detail: null };
  if (/^\s*(not\s*sure|idk|i\s*don'?t\s*know|unsure|maybe|dunno|no idea)\s*$/i.test(t))          return { decision: 'unsure', detail: null };
  if (/^\s*(separate|not the same|different|no,?\s*separate)\s*$/i.test(t))                       return { decision: 'separate', detail: null };

  const groq = deps.groqClassify || groqClassifyReply;
  try { const r = await groq(t); if (r) return r; } catch { /* fall through */ }

  if (/separate|different|not the same/i.test(t)) {
    const detail = t.replace(/^\s*(separate|different|not the same)[,.:\-\s]*/i, '').trim();
    return { decision: 'separate', detail: detail || null };
  }
  return { decision: 'unsure', detail: null };
}

async function groqClassifyReply(text) {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here') return null;
  const sys = `Classify an SMS reply about whether a newly uploaded receipt is the SAME purchase as one already saved, or a SEPARATE purchase. Reply with ONLY JSON: {"decision":"same"|"separate"|"unsure","detail":string|null}. If separate, "detail" = the distinguishing fact the user gave (a different receipt/order number, time, card, items, store, or matching bank transaction), else null.`;
  const resp = await axios.post(GROQ_URL,
    { model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', messages: [{ role: 'system', content: sys }, { role: 'user', content: text }], max_tokens: 200, temperature: 0 },
    { headers: { Authorization: 'Bearer ' + key }, timeout: 15000 });
  const raw = resp.data?.choices?.[0]?.message?.content || '{}';
  try {
    const o = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (['same', 'separate', 'unsure'].includes(o.decision)) return { decision: o.decision, detail: o.detail || null };
  } catch { /* ignore */ }
  return null;
}

module.exports = { dedupeScore, findDuplicate, classifyDedupReply, merchantSim, itemSim };
