'use strict';
/**
 * banking/categorizer-core.js — transport-free brain for the conversational
 * transaction categorizer. Knows NOTHING about Discord/SMS: it reads/writes the Neon
 * tables + the per-user store and returns plain text for a transport to deliver. A
 * Discord adapter today, a Twilio adapter later, both drive this exact module.
 *
 * Flow:
 *   1. enqueueQuestions()  — open one txn_messages row per new, unconfirmed transaction,
 *                            snapshotting the txn + a suggested category into its payload.
 *   2. composeQuestion()   — render a pending row as a plain-text question (SMS-safe).
 *   3. handleReply()       — interpret a free-text reply (confirm / correct / new
 *                            category / skip), apply it to the transaction, learn the
 *                            pattern, and tee up the next question.
 *
 * Always-ask: even a high-confidence guess is only ever *suggested*; nothing is applied
 * until the user confirms. Learning changes the suggestion, never the gate.
 *
 * Conventions reused from the codebase:
 *   • DB helpers take `query` (core/db.query) as their first arg — testable with a fake.
 *   • Per-user data via `io` = makeIO(userId) { read, write }.
 *   • Category ids are the hierarchical slugs from accounting/categories.js.
 */
const crypto = require('crypto');
const { guessCategory, resolveCtx, isTransfer } = require('./auto-categorize');
const { suggestKeyword } = require('./categorize');
const { buildDefaultChart, idForPath } = require('../accounting/categories');
const { MON_ABBR } = require('./periods');
const { parseCategoryReply } = require('./categorize-ai');

// How many confirmed *business* categorizations on an account before a brand-new merchant
// on that account is guessed as business by default. The one tunable Albert deferred —
// isolated here so changing it touches neither schema nor flow.
const ACCOUNT_BUSINESS_MIN = 2;

// Section root each (type, scope) pair hangs a brand-new user category under.
const SECTION_FOR = {
  'expense|business': 'Business Expenses', 'income|business': 'Business Revenue',
  'expense|personal': 'Personal Expenses', 'income|personal': 'Personal Income',
  'asset|business':   'Business Assets',   'asset|personal':   'Personal Assets',
  'liability|business': 'Business Liabilities', 'liability|personal': 'Personal Liabilities',
};

// ── pure helpers ─────────────────────────────────────────────────────────────
const abs2  = (n) => Math.abs(Number(n) || 0).toFixed(2);
const money = (n) => (Number(n) < 0 ? `$${abs2(n)}` : `+$${abs2(n)}`);

function dateShort(d) {
  if (!d) return '';
  const s = String(d), m = Number(s.slice(5, 7)), day = Number(s.slice(8, 10));
  return (m >= 1 && m <= 12 && day) ? `${MON_ABBR[m - 1]} ${day}` : s;
}

const isConfirm = (t) => /^\s*(confirm|yes|y|yep|yeah|correct|ok|okay|👍)\s*$/i.test(t || '');
const isSkip    = (t) => /^\s*(skip|pass|later|ignore|no thanks)\s*$/i.test(t || '');
const merchantKey = (desc) => suggestKeyword(desc);   // reuse the noisy-desc → keyword heuristic

function chartFrom(io) {
  const c = io.read('chart_of_accounts.json');
  return (Array.isArray(c) && c.length) ? c : buildDefaultChart();
}
function accountsById(io) {
  const m = new Map();
  for (const a of (io.read('accounts.json') || [])) if (a && a.id) m.set(a.id, a);
  return m;
}
function coaNode(coaId, chart) { return chart.find(n => n.id === coaId) || null; }
function coaName(coaId, chart) { const n = coaNode(coaId, chart); return n ? n.name : coaId; }
function coaScope(coaId, chart) { const n = coaNode(coaId, chart); return n && n.scope === 'business' ? 'business' : 'personal'; }

// Walk parentId to the root → "Business Expenses › Supplies › General Supplies".
function coaPath(coaId, chart) {
  const byId = new Map(chart.map(n => [n.id, n]));
  const names = []; let cur = byId.get(coaId), guard = 0;
  while (cur && guard++ < 12) { names.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  return names.join(' › ');
}

function acctLabel(tx, byId) {
  const a = byId.get(tx.account);
  return a ? (a.name + (a.last4 ? ` ••${a.last4}` : '')) : (tx.institution || tx.account || 'unknown account');
}

// rows: [{ bucket, n }]. Dominant bucket per the threshold, else null (not yet decided).
function dominantBucket(rows) {
  let biz = 0, per = 0;
  for (const r of rows || []) {
    const n = Number(r.n) || 0;
    if (r.bucket === 'business') biz += n; else if (r.bucket === 'personal') per += n;
  }
  if (biz >= ACCOUNT_BUSINESS_MIN && biz > per) return 'business';
  if (per >= ACCOUNT_BUSINESS_MIN && per > biz) return 'personal';
  return null;
}

function formatQuestion({ userName, tx, suggestionLabel, accountLabel }) {
  const greet = userName ? `Hi ${userName} 👋` : 'Hi 👋';
  return [
    `${greet} New transaction to categorize:`,
    `${tx.desc || 'Transaction'} · ${money(tx.amount)} · ${dateShort(tx.date)} · ${accountLabel}`,
    suggestionLabel ? `Suggested: ${suggestionLabel}` : `I'm not sure how to file this one.`,
    `Reply OK to confirm, or tell me the right category.`,
  ].join('\n');
}

function snapshotTx(tx) {
  return { id: tx.id, account: tx.account, date: tx.date, amount: tx.amount,
           desc: tx.desc, category: tx.category, institution: tx.institution };
}

// ── learning store (categorization_memory) ───────────────────────────────────
async function accountBucket(query, userId, account) {
  if (!account) return null;
  const r = await query(
    `SELECT bucket, SUM(times_confirmed)::int AS n FROM categorization_memory
       WHERE user_id=$1 AND account=$2 GROUP BY bucket`, [userId, account]);
  return dominantBucket(r.rows);
}

async function memoryLookup(query, userId, account, desc) {
  if (!account || !desc) return null;
  const r = await query(
    `SELECT * FROM categorization_memory
       WHERE user_id=$1 AND account=$2 AND $3 ILIKE '%' || merchant_pattern || '%'
       ORDER BY times_confirmed DESC, last_used DESC LIMIT 1`, [userId, account, desc]);
  return r.rows[0] || null;
}

async function recordConfirmation(query, userId, { account, pattern, bucket, category, coaId }) {
  if (!coaId) return;
  const existing = await query(
    `SELECT id FROM categorization_memory
       WHERE user_id=$1 AND account IS NOT DISTINCT FROM $2 AND merchant_pattern=$3 AND coa_id=$4 LIMIT 1`,
    [userId, account || null, pattern || '', coaId]);
  if (existing.rows[0]) {
    await query(
      `UPDATE categorization_memory SET times_confirmed=times_confirmed+1, bucket=$2, category=$3, last_used=NOW()
         WHERE id=$1`, [existing.rows[0].id, bucket || null, category || null]);
  } else {
    await query(
      `INSERT INTO categorization_memory (id,user_id,account,merchant_pattern,bucket,category,coa_id,confidence,times_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1.0,1)`,
      [`cm_${crypto.randomBytes(6).toString('hex')}`, userId, account || null, pattern || '', bucket || null, category || null, coaId]);
  }
}

// ── suggestion = learned memory first, then the rule-based guess ──────────────
async function suggestionFor(query, io, userId, tx) {
  const chart = chartFrom(io);
  const byId  = accountsById(io);

  // 1. Exact learned memory for this account + merchant.
  const mem = await memoryLookup(query, userId, tx.account, tx.desc || '');
  if (mem && mem.coa_id) {
    return { coaId: mem.coa_id, label: coaPath(mem.coa_id, chart) || mem.category,
             bucket: mem.bucket || coaScope(mem.coa_id, chart), source: 'memory' };
  }

  // 2. Rule-based guess, using the account's learned bucket as context when known.
  const learned = await accountBucket(query, userId, tx.account);
  const ctx = learned
    ? { business: learned === 'business', propertyId: (byId.get(tx.account) || {}).propertyId || null }
    : resolveCtx(tx, {}, byId);
  const g = guessCategory(tx, ctx);
  if (!g) return null;   // transfer / non-categorizable
  return { coaId: g.coaId, label: coaPath(g.coaId, chart), bucket: coaScope(g.coaId, chart),
           source: 'guess', capital: !!g.capital };
}

// ── question queue (txn_messages) ────────────────────────────────────────────
// One question per new, unconfirmed, non-transfer transaction. Skips any txn that
// already has a message (any state) so re-runs never double-ask. Newest first, capped.
// `onlyIds` (when provided) restricts candidates to those transaction ids — the Plaid
// hook passes the genuinely-new ids so we ask only about freshly-pulled transactions, not
// the historical backlog. Omitting it falls back to "newest unapproved" (manual/test use).
async function enqueueQuestions(query, io, userId, { limit = 25, channel = null, onlyIds = null } = {}) {
  const txs = io.read('transactions.json') || [];
  const ex  = await query(`SELECT transaction_id FROM txn_messages WHERE user_id=$1`, [userId]);
  const seen = new Set(ex.rows.map(r => r.transaction_id));
  const only = onlyIds ? new Set(onlyIds) : null;

  const pending = txs
    .filter(t => t && t.id && !t.excluded && !t.approved && !seen.has(t.id)
                 && typeof t.amount === 'number' && t.amount !== 0 && !isTransfer(t)
                 && (!only || only.has(t.id)))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, limit);

  let created = 0;
  for (const tx of pending) {
    const suggestion = await suggestionFor(query, io, userId, tx);
    const payload = { stage: 'await_first', tx: snapshotTx(tx), suggestion };
    await query(
      `INSERT INTO txn_messages (id,user_id,transaction_id,channel,kind,state,payload)
       VALUES ($1,$2,$3,$4,'confirm','open',$5)`,
      [`txm_${crypto.randomBytes(6).toString('hex')}`, userId, tx.id, channel, JSON.stringify(payload)]);
    created++;
  }
  return created;
}

async function openQuestionFor(query, userId) {
  const r = await query(
    `SELECT * FROM txn_messages WHERE user_id=$1 AND state IN ('open','asked')
       ORDER BY created_at ASC LIMIT 1`, [userId]);
  const row = r.rows[0];
  if (row && typeof row.payload === 'string') row.payload = JSON.parse(row.payload);
  return row || null;
}

async function markAsked(query, id) { await query(`UPDATE txn_messages SET state='asked' WHERE id=$1`, [id]); }

async function updateMessage(query, id, { state, payload } = {}) {
  await query(`UPDATE txn_messages SET state=COALESCE($2,state), payload=COALESCE($3,payload) WHERE id=$1`,
    [id, state || null, payload ? JSON.stringify(payload) : null]);
}

async function userName(query, userId) {
  try {
    const r = await query(`SELECT display_name, username FROM users WHERE id=$1`, [userId]);
    const u = r.rows[0];
    return u ? (u.display_name || u.username) : null;
  } catch { return null; }
}

// Render a pending message row as the outbound question text.
async function composeQuestion(query, io, userId, msg) {
  const byId = accountsById(io);
  const tx   = (msg.payload && msg.payload.tx) || {};
  const sug  = msg.payload && msg.payload.suggestion;
  return formatQuestion({
    userName: await userName(query, userId),
    tx, suggestionLabel: sug ? sug.label : null, accountLabel: acctLabel(tx, byId),
  });
}

// The next pending question (marked 'asked'), or null when the queue is drained.
async function nextPrompt(query, io, userId) {
  const msg = await openQuestionFor(query, userId);
  if (!msg) return null;
  await markAsked(query, msg.id);
  return composeQuestion(query, io, userId, msg);
}

// ── applying a confirmed category ────────────────────────────────────────────
// Write coaId onto the transaction THROUGH the per-user store (which mirrors to Neon),
// so the per-sync full-replace of `transactions` can't wipe it. approved:true marks it
// user-confirmed so enqueueQuestions never re-asks.
function applyCategory(io, txId, coaId, { capital = false } = {}) {
  const txs = io.read('transactions.json') || [];
  io.write('transactions.json', txs.map(t => t.id === txId
    ? { ...t, coaId, approved: true, categorizedBy: 'bot', coaAuto: false, ...(capital ? { capital: true } : {}) }
    : t));
}

// Add a brand-new user category leaf under the right section root. Idempotent by id.
function createCategory(io, newAccount, scope = 'personal') {
  const chart = chartFrom(io);
  const type  = ['asset', 'liability', 'equity', 'income', 'expense'].includes(newAccount.type) ? newAccount.type : 'expense';
  const sectionName = SECTION_FOR[`${type}|${scope}`] || 'Personal Expenses';
  const parentId = idForPath([sectionName]);
  const id = 'cat_user__' + scope + '__' + String(newAccount.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!chart.some(n => n.id === id)) {
    io.write('chart_of_accounts.json',
      [...chart, { id, name: newAccount.name, type, parentId, scope, active: true, system: false }]);
  }
  return { id, name: newAccount.name };
}

async function finalize(query, io, userId, msg, tx, proposal) {
  let coaId = proposal.coaId, name = proposal.name;
  if (proposal.isNew && proposal.newAccount) {
    const scope = proposal.scopeHint || await accountBucket(query, userId, tx.account) || 'personal';
    const made  = createCategory(io, proposal.newAccount, scope);
    coaId = made.id; name = made.name;
  }
  const chart = chartFrom(io);   // refreshed after any new-category write
  applyCategory(io, tx.id, coaId, { capital: !!proposal.capital });
  await recordConfirmation(query, userId, {
    account: tx.account, pattern: merchantKey(tx.desc), bucket: coaScope(coaId, chart), category: name, coaId,
  });
  await updateMessage(query, msg.id, { state: 'answered' });
  const learned = tx.account ? ` I'll remember "${merchantKey(tx.desc)}" on this account.` : '';
  return { handled: true, applied: true,
           reply: `✅ Filed under ${coaPath(coaId, chart) || name}.${learned}`,
           next: await nextPrompt(query, io, userId) };
}

// ── local category matching (avoids an LLM call for most replies) ────────────
// Bucket words ('business'/'personal') are stripped here — they're read as a bucket hint
// from the raw text, not matched as category-name tokens.
const STOP = new Set(('the a an my our your for on to of and or it this that is was are be i we no not yes '
  + 'please put file under as into category categories expense expenses income business personal').split(' '));
function stem(w) { return w.replace(/ies$/, 'y').replace(/(ses|xes|zes|ches|shes)$/, m => m.slice(0, -2)).replace(/s$/, ''); }
function toks(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w && !STOP.has(w)).map(stem);
}
const selectable = (chart) => chart.filter(n => n.parentId);   // exclude the 10 top-level sections

// Score chart leaves against a free-text reply. `best` is a confident single match worth
// proposing; `candidates` is a ranked shortlist to offer when nothing is clearly best.
function matchCategories(text, chart, { bucketHint = null, limit = 5 } = {}) {
  const rt = toks(text);
  if (!rt.length) return { best: null, candidates: [] };
  const rset = new Set(rt);
  const scored = [];
  for (const n of selectable(chart)) {
    const nt = toks(n.name);
    if (!nt.length) continue;
    const nameHits = nt.filter(w => rset.has(w)).length;
    if (!nameHits) continue;
    const replyHits = rt.filter(w => nt.includes(w)).length;
    let score = nameHits;
    if (nt.join(' ') === rt.join(' ')) score += 10;                 // exact name
    else if (replyHits === rt.length) score += 4;                   // name covers all the user's words
    score += 0.25 * toks(coaPath(n.id, chart)).filter(w => rset.has(w)).length;   // parent-path hits (weak)
    if (bucketHint && n.scope === bucketHint) score += 1.5;         // prefer the account's bucket
    scored.push({ id: n.id, name: n.name, path: coaPath(n.id, chart), score, replyHits, nameLen: nt.length });
  }
  scored.sort((a, b) => b.score - a.score || a.nameLen - b.nameLen);
  const candidates = scored.slice(0, limit);
  let best = null;
  if (candidates.length) {
    const top = candidates[0];
    const covers = top.replyHits === rt.length;                    // every word the user said is in this name
    const gap = candidates.length === 1 || (top.score - candidates[1].score) >= 1.5;
    if (covers && gap) best = top;
  }
  return { best, candidates };
}

// A reimbursement / money-movement phrase — not a spending category → exclude from reports.
const TRANSFER_RE = /\b(transfer(red|s)?|reimburse(d|ment)?|venmo|zelle|cash ?app|paid me back|pay(ing)? back|from a friend|to a friend|between (my )?accounts?|moved? money|not income|isn'?t income|my own money)\b/i;
const isTransferIntent = (text) => TRANSFER_RE.test(String(text || ''));

// A few everyday leaves so the (now rare) Groq fallback always has something to map to.
const COMMON_FALLBACK = [
  ['Personal Expenses', 'Food & Dining', 'Groceries'], ['Personal Expenses', 'Food & Dining', 'Restaurants'],
  ['Personal Expenses', 'Shopping', 'General Shopping'], ['Personal Expenses', 'Transportation', 'Gas & Fuel'],
  ['Personal Expenses', 'Utilities', 'Electricity'], ['Personal Expenses', 'Personal Care', 'Gym & Fitness'],
  ['Business Expenses', 'Supplies', 'General Supplies'], ['Business Expenses', 'Repair & Maintenance', 'General Repairs & Maintenance'],
].map(p => idForPath(p));

// Small candidate set (≤30) for the Groq fallback — loose local matches + common leaves — so
// the prompt is ~10× smaller than the full chart (which was blowing Groq's free-tier TPM cap).
function candidatePool(text, chart) {
  const ids = new Set(matchCategories(text, chart, { limit: 20 }).candidates.map(c => c.id));
  for (const id of COMMON_FALLBACK) ids.add(id);
  const byId = new Map(chart.map(n => [n.id, n]));
  return [...ids].map(id => byId.get(id)).filter(Boolean).slice(0, 30);
}

function applyExclude(io, txId) {
  const txs = io.read('transactions.json') || [];
  io.write('transactions.json', txs.map(t => t.id === txId
    ? { ...t, excluded: true, approved: true, categorizedBy: 'bot' } : t));
}

// Present a numbered shortlist and stash it in the payload so a numeric reply maps back.
async function presentShortlist(query, io, msg, payload, candidates, lead) {
  const chart = chartFrom(io);
  const options = candidates.slice(0, 5).map(c => ({ coaId: c.id, label: coaPath(c.id, chart) || c.name || c.id }));
  await updateMessage(query, msg.id, { state: 'asked', payload: { ...payload, stage: 'await_choice', options, proposal: null } });
  const lines = [lead, ...options.map((o, i) => `  ${i + 1}) ${o.label}`), 'Reply a number, or describe it in your own words.'];
  return { handled: true, applied: false, reply: lines.join('\n'), options };
}

/**
 * Interpret one inbound reply against the user's current open question. Resolves locally
 * whenever possible — numeric pick, confirm, transfer, or a confident category-name match —
 * and only falls back to the Groq parser (with a SMALL candidate list) for genuinely fuzzy
 * phrasing. Returns { handled, applied, reply, next?, options? }.
 */
async function handleReply(query, io, userId, text, deps = {}) {
  const parseReply = deps.parseReply || parseCategoryReply;
  const msg = await openQuestionFor(query, userId);
  if (!msg) return { handled: false, reply: "You're all caught up — nothing to categorize right now." };

  const chart = chartFrom(io);
  const byId  = accountsById(io);
  const payload = msg.payload || {};
  const tx = payload.tx || {};
  const t = String(text || '').trim();

  if (isSkip(t)) {
    await updateMessage(query, msg.id, { state: 'closed' });
    return { handled: true, applied: false, reply: '⏭️ Skipped.', next: await nextPrompt(query, io, userId) };
  }

  // Numeric pick from a shortlist we showed → apply it directly.
  if (Array.isArray(payload.options) && payload.options.length && /^\d+$/.test(t)) {
    const choice = payload.options[Number(t) - 1];
    if (choice && choice.coaId) return finalize(query, io, userId, msg, tx, { coaId: choice.coaId, name: coaName(choice.coaId, chart) });
    return { handled: true, applied: false, reply: `Reply 1–${payload.options.length}, or describe the category.` };
  }

  // Confirm the current proposal (or the original suggestion). A new-category proposal is
  // valid even though its coaId is null until created.
  if (isConfirm(t)) {
    const proposal = payload.proposal || payload.suggestion;
    const valid = proposal && (proposal.coaId || (proposal.isNew && proposal.newAccount));
    if (!valid) return { handled: true, applied: false, reply: "I didn't have a category to confirm — tell me what it should be." };
    return finalize(query, io, userId, msg, tx, proposal);
  }

  // Transfer / reimbursement → exclude from reports (it isn't a spending category).
  if (isTransferIntent(t)) {
    applyExclude(io, tx.id);
    await updateMessage(query, msg.id, { state: 'answered' });
    return { handled: true, applied: true, reply: '✅ Marked as a transfer — excluded from reports.', next: await nextPrompt(query, io, userId) };
  }

  // Free text → match locally first (no LLM).
  const bucketHint = /\bbusiness\b/i.test(t) ? 'business'
    : /\bpersonal\b/i.test(t) ? 'personal'
    : await accountBucket(query, userId, tx.account);
  const { best, candidates } = matchCategories(t, chart, { bucketHint });

  if (best) {
    await updateMessage(query, msg.id, { state: 'asked', payload: { ...payload, stage: 'await_confirm', proposal: { coaId: best.id, name: best.name }, options: null } });
    return { handled: true, applied: false, reply: `→ ${best.path}? Reply OK to confirm, or pick another.` };
  }
  if (candidates.length) {
    return presentShortlist(query, io, msg, payload, candidates, 'Closest matches:');
  }

  // No local match → Groq, but with a small candidate list (not the whole chart).
  let p = null;
  try { p = await parseReply({ replyText: t, tx: { ...tx, accountName: acctLabel(tx, byId) }, coa: candidatePool(t, chart) }); }
  catch { p = null; }
  if (p && !p.error && (p.coaId || (p.isNew && p.newAccount))) {
    const proposal = (p.isNew && p.newAccount)
      ? { isNew: true, newAccount: p.newAccount, name: p.newAccount.name, coaId: null, scopeHint: bucketHint }
      : { isNew: false, coaId: p.coaId, name: p.accountName || coaName(p.coaId, chart) };
    await updateMessage(query, msg.id, { state: 'asked', payload: { ...payload, stage: 'await_confirm', proposal, options: null } });
    const label = proposal.isNew ? `new category "${proposal.name}"` : (coaPath(proposal.coaId, chart) || proposal.name);
    return { handled: true, applied: false, reply: `→ Categorize as ${label}? Reply OK, or pick another.` };
  }

  // Still nothing → a friendly shortlist (never a raw error or URL).
  const loose = matchCategories(t, chart, { bucketHint, limit: 5 }).candidates;
  const pool = loose.length ? loose : candidatePool(t, chart).map(n => ({ id: n.id, name: n.name }));
  return presentShortlist(query, io, msg, payload, pool, "I couldn't place that — did you mean:");
}

module.exports = {
  // pure
  money, dateShort, isConfirm, isSkip, merchantKey, coaPath, coaName, coaScope,
  dominantBucket, formatQuestion, acctLabel, snapshotTx, createCategory, applyCategory,
  matchCategories, isTransferIntent, candidatePool, toks,
  // db / io
  accountBucket, memoryLookup, recordConfirmation, suggestionFor,
  enqueueQuestions, openQuestionFor, markAsked, composeQuestion, nextPrompt, handleReply, applyExclude,
  // constants
  ACCOUNT_BUSINESS_MIN, SECTION_FOR,
};
