// vendor-ai.js — Groq-backed (free, fast) cleaner that turns noisy bank/credit-card
// descriptions into short, human "From/To" names (the payee/payer). Mirrors
// categorize-ai.js: OpenAI-compatible Groq endpoint via axios (no new dep), gated on
// GROQ_API_KEY, and best-effort — any failure returns {} so a sync never breaks.
const axios = require('axios');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const SYS = `You clean noisy bank/credit-card transaction descriptions into the short real-world name of the merchant or counterparty — who the money was paid to, or received from.
Rules:
- Return the brand / company / person name only. Drop store numbers, locations, city/state codes, payment-processor prefixes (SQ*, TST*, PP*, PAYPAL*), reference ids, and URLs.
- Use Title Case and keep it short (usually 1-3 words).
- Examples: "Audible*8D5QA2TN3 Amzn.com/billNJ" -> "Audible"; "SQ *OCTOPUS CLEANING SERVgosq.com CA" -> "Octopus Cleaning"; "SPECTRUM 855-707-7328 MO" -> "Spectrum"; "LOWES #01555* HAWTHORNE CA" -> "Lowe's".
- If you genuinely cannot tell, use "".
Respond with ONLY a JSON object mapping each input id to its cleaned name, e.g. {"<id>":"<name>"}. No prose, no markdown.`;

// items: [{ id, desc }] -> { [id]: cleanName }. Caps the batch so the prompt stays well
// under Groq's free-tier token limit; the caller additionally caps how many it sends.
async function suggestVendorNames(items) {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here') return {};
  const list = (items || []).filter(i => i && i.id && i.desc).slice(0, 60);
  if (!list.length) return {};

  const userMsg = 'DESCRIPTIONS:\n' + list.map(i => `${i.id} | ${i.desc}`).join('\n');
  let resp;
  try {
    resp = await axios.post(GROQ_URL, {
      model: MODEL,
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: userMsg }],
      max_tokens: 1024,
      temperature: 0,
    }, { headers: { Authorization: 'Bearer ' + key }, timeout: 20000 });
  } catch (e) {
    console.error('[vendor-ai] groq request failed:', e.response?.data?.error?.message || e.message);
    return {};
  }

  const text = resp.data?.choices?.[0]?.message?.content || '';
  let obj = null;
  try { obj = JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch {} } }
  if (!obj || typeof obj !== 'object') return {};

  const out = {};
  for (const { id } of list) {
    const v = obj[id];
    if (typeof v === 'string' && v.trim()) out[id] = v.trim();
  }
  return out;
}

module.exports = { suggestVendorNames };
