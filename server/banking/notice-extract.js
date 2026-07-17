'use strict';
/**
 * banking/notice-extract.js — Groq extraction for ACTION LETTERS from financial
 * institutions: unclaimed/abandoned-property (escheatment) notices, account-closure
 * warnings, address-confirmation demands — any letter that names an account, an amount,
 * and something the user must DO by a deadline.
 *
 * Generalized (no carrier/broker hardcoding). Vision for photographed letters, text model
 * for PDFs, both through the shared rate gateway. Callers pre-gate on cheap keywords so
 * ordinary disclosures (privacy notices, fee schedules) don't burn a call.
 */
const { groqChat } = require('../vault/groq-client');

const MODEL        = process.env.GROQ_MODEL        || 'openai/gpt-oss-120b';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

// Cheap pre-gate: does this disclosure/letter look like it demands ACTION?
const ACTION_GATE = /unclaimed|abandoned\s+property|escheat|respond\s+within|action\s+required|contact\s+us\s+within|will\s+be\s+(?:closed|transferred|reported)|deadline|must\s+(?:respond|reply|confirm)/i;

const SYSTEM = `You extract structured data from a LETTER/NOTICE sent by a financial institution (bank, brokerage, insurer, exchange).
Respond with ONLY JSON, no prose:
{"isActionNotice":boolean,          // true if the letter demands the recipient DO something (respond, confirm, claim) — not a mere informational disclosure
 "noticeKind":"unclaimed_property"|"address_confirmation"|"account_closure"|"other",
 "institution":string|null,         // the sender's brand only, e.g. "eToro", "Chase"
 "accountMask":string|null,         // last 4 of the referenced account number (digits only)
 "accountKind":"investment"|"bank"|"crypto"|"retirement"|"insurance"|"other"|null,
 "reportedAmount":number|null,      // dollar amount of the account/property the letter references
 "amountAsOf":string|null,          // YYYY-MM-DD the amount/activity date refers to, if printed
 "assetNote":string|null,           // what the amount is, as printed (e.g. "Virtual Currency") — even if vague
 "actionRequired":string|null,      // ONE sentence: what the recipient must do (e.g. "check a box, sign and return the form, or call to confirm the address")
 "respondBy":string|null,           // YYYY-MM-DD explicit response deadline; if "within N days of <letter date>", compute it
 "consequenceDate":string|null,     // YYYY-MM-DD when the stated consequence happens (e.g. funds reported/escheated to the state)
 "consequence":string|null,         // ONE sentence: what happens if ignored
 "contactPhone":string|null,
 "letterDate":string|null}          // YYYY-MM-DD
Rules: null when not clearly present. Never invent values. Dates YYYY-MM-DD. accountMask digits only.`;

function tolerantJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
const isDate  = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const normStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const normNum = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v
  : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(/[$,]/g, ''))) ? Number(v.replace(/[$,]/g, '')) : null);

function normalize(j) {
  if (!j) return null;
  const out = {
    isActionNotice: j.isActionNotice === true,
    noticeKind: ['unclaimed_property', 'address_confirmation', 'account_closure'].includes(j.noticeKind) ? j.noticeKind : 'other',
    institution: normStr(j.institution),
    accountMask: j.accountMask != null ? (String(j.accountMask).replace(/\D/g, '').slice(-4) || null) : null,
    accountKind: ['investment', 'bank', 'crypto', 'retirement', 'insurance', 'other'].includes(j.accountKind) ? j.accountKind : null,
    reportedAmount: normNum(j.reportedAmount),
    amountAsOf: isDate(j.amountAsOf) ? j.amountAsOf : null,
    assetNote: normStr(j.assetNote),
    actionRequired: normStr(j.actionRequired),
    respondBy: isDate(j.respondBy) ? j.respondBy : null,
    consequenceDate: isDate(j.consequenceDate) ? j.consequenceDate : null,
    consequence: normStr(j.consequence),
    contactPhone: normStr(j.contactPhone),
    letterDate: isDate(j.letterDate) ? j.letterDate : null,
  };
  return out;
}

async function run(messages, model) {
  const res = await groqChat({ model, temperature: 0, max_tokens: 500, messages }, { timeout: 45000 });
  return normalize(tolerantJson(res?.data?.choices?.[0]?.message?.content));
}

/** Extract from letter TEXT. Returns the normalized shape or null. */
async function extractNotice(text) {
  if (!process.env.GROQ_API_KEY || !text) return null;
  return run([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(text).slice(0, 12000) },
  ], MODEL);
}

/** Vision variant for photographed letters. */
async function extractNoticeFromImage(buffer, mimeType = 'image/jpeg') {
  if (!process.env.GROQ_API_KEY || !buffer) return null;
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  return run([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: 'Extract the notice data from this letter image.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] },
  ], VISION_MODEL);
}

module.exports = { extractNotice, extractNoticeFromImage, ACTION_GATE, _normalize: normalize };
