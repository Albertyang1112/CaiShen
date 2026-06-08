// notifier.js — Phase 1: detect newly-synced transactions and push an alert to the
// user's chosen channel. Channel-agnostic core + Discord webhook transport +
// notifyNew() (the post-sync hook entrypoint).

// Un-notified transactions (no `notified` flag yet), capped so a big sync can't
// blast dozens of messages at once.
function pickNew(transactions, { limit = 12 } = {}) {
  const fresh = (transactions || []).filter(t => t && !t.notified);
  return limit > 0 ? fresh.slice(0, limit) : fresh;
}

// account-id -> account record, for resolving the friendly saved account name.
function accountsMap(accounts) {
  const m = {};
  for (const a of (accounts || [])) if (a && a.id) m[a.id] = a;
  return m;
}

// One human-readable alert line. Uses the CaiShen-saved account name (e.g.
// "TOTAL CHECKING ••9092"), falling back to institution if unknown.
function formatAlert(tx, accountsById = {}) {
  const amt = Number(tx.amount || 0);
  const money = (amt < 0 ? '-' : '+') + '$' +
    Math.abs(amt).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const acct = accountsById[tx.account];
  const acctLabel = acct ? (acct.name + (acct.last4 ? ` ••${acct.last4}` : '')) : (tx.institution || null);
  const bits = [acctLabel, tx.category, tx.pending ? 'pending' : null].filter(Boolean).join(' · ');
  return `💳 ${money} — ${tx.desc || 'Transaction'}` + (bits ? ` · ${bits}` : '') + ` · (${tx.date || '?'})`;
}

// Discord transport: POST to a channel webhook URL (axios lazy-loaded).
async function sendDiscord(webhookUrl, content) {
  if (!webhookUrl) return false;
  const axios = require('axios');
  await axios.post(webhookUrl, { content, allowed_mentions: { parse: [] } }, { timeout: 10000 });
  return true;
}

// Post-sync hook: alert on every un-notified transaction, then mark them notified.
// io is the per-user { read, write } from makeIO(userId). Returns # alerted.
async function notifyNew(io, webhookUrl, { limit = 12 } = {}) {
  if (!webhookUrl || !io) return 0;
  const txs = io.read('transactions.json') || [];
  const fresh = pickNew(txs, { limit });
  if (!fresh.length) return 0;
  const byId = accountsMap(io.read('accounts.json') || []);
  for (const t of fresh) { try { await sendDiscord(webhookUrl, formatAlert(t, byId)); } catch (e) { /* skip one, keep going */ } }
  const ids = new Set(fresh.map(t => t.id));
  io.write('transactions.json', txs.map(t => ids.has(t.id) ? { ...t, notified: true } : t));
  return fresh.length;
}

module.exports = { pickNew, accountsMap, formatAlert, sendDiscord, notifyNew };
