// categorize-ai.js — Groq-backed (free, fast) parser that maps a user's short
// free-text category reply to an account in their chart of accounts (coaId), or
// proposes a new account. Uses Groq's OpenAI-compatible API via axios (no new dep).
// Channel-agnostic: the Discord bot calls this; it has no Discord dependency.
const axios = require('axios');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const SYS = `You categorize a personal-finance transaction into the user's chart of accounts.
You are given the chart of accounts (id | type/subtype | name), the transaction, and the user's short free-text reply describing the category.
Pick the SINGLE best-matching existing account id. If nothing fits well, propose a NEW account instead.
Accounting guidance: for a rental/business property, furniture, appliances, and improvements are CAPITAL expenditures (an asset / fixed_asset, depreciated — not a regular expense). Meals are an expense (business meals ~50% deductible). "capex"/"capital" => a fixed_asset/capital account.
Respond with ONLY a JSON object (no prose, no markdown) of exactly this shape:
{"coaId": "<existing id, or null if proposing a new account>", "isNew": true|false, "newAccount": {"name":"...","type":"asset|liability|equity|income|expense","subtype":"..."} or null, "accountName": "<the human account name you chose>", "confidence": 0.0-1.0, "interpretation": "<one short sentence to confirm with the user>"}`;

// { replyText, tx, coa } -> parsed object (see SYS) or { error }
async function parseCategoryReply({ replyText, tx, coa }) {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here') return { error: 'GROQ_API_KEY not configured' };
  const accounts = (coa || [])
    .filter(a => a.active !== false)
    .map(a => `${a.id} | ${a.type}${a.subtype ? '/' + a.subtype : ''} | ${a.name}`)
    .join('\n');
  const userMsg =
    `CHART OF ACCOUNTS:\n${accounts}\n\n` +
    `TRANSACTION: "${tx.desc}" | amount ${tx.amount} | on account: ${tx.accountName || tx.account}\n\n` +
    `USER REPLY: "${replyText}"`;
  let resp;
  try {
    resp = await axios.post(GROQ_URL, {
      model: MODEL,
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: userMsg }],
      max_tokens: 1024,
      temperature: 0,
    }, { headers: { Authorization: 'Bearer ' + key }, timeout: 20000 });
  } catch (e) {
    return { error: 'groq request failed: ' + (e.response?.data?.error?.message || e.message) };
  }
  const text = resp.data?.choices?.[0]?.message?.content || '';
  try { return JSON.parse(text); }
  catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return { error: 'bad JSON from model', raw: text };
  }
}

module.exports = { parseCategoryReply };
