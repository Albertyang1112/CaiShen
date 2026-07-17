'use strict';
/**
 * banking/notices.js — turn an extracted action letter into live records:
 *
 *   • a MANUAL account in accounts.json (source 'manual' — Plaid syncs never touch it),
 *     carrying the letter's reported amount with unconfirmed:true when the letter doesn't
 *     say what the asset actually is ("Virtual Currency" on an escheatment notice);
 *   • an ACTION ITEM in per-user action_items.json — the reminder engine nags on it
 *     (weekly always, daily in the last week before the consequence date) until the user
 *     replies "done" to the bot.
 *
 * Idempotent: deterministic ids keyed by institution+mask (account) and notice content
 * (action item), so re-submitting the same letter upserts instead of duplicating.
 */
const crypto = require('crypto');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'x';
const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

const KIND_TYPE = {   // accountKind → accounts.json {type, subtype} (drives the UI class)
  investment: { type: 'investment', subtype: 'brokerage' },
  crypto:     { type: 'investment', subtype: 'crypto exchange' },
  retirement: { type: 'investment', subtype: 'ira' },
  bank:       { type: 'depository', subtype: 'checking' },
};

// Upsert a manual account from a notice. Merge-by (institution, last4); never overwrites
// a Plaid account. Returns the account id.
function upsertManualAccount(io, { institution, mask, accountKind, amount, amountAsOf, assetNote, noticeDocId }) {
  const accounts = io.read('accounts.json') || [];
  const id = `manual_${slug(institution)}_${mask || 'x'}`;
  const shape = KIND_TYPE[accountKind] || KIND_TYPE.investment;
  const existing = accounts.find(a => a && (a.id === id ||
    (a.source === 'manual' && slug(a.institution) === slug(institution) && (a.last4 || a.mask) === mask)));
  const entry = {
    ...(existing || {}),
    id: existing ? existing.id : id,
    source: 'manual',
    name: existing?.name || `${institution || 'Account'}${assetNote ? ` (${assetNote})` : ''}`,
    institution: institution || existing?.institution || null,
    last4: mask || existing?.last4 || null,
    type: existing?.type || shape.type,
    subtype: existing?.subtype || shape.subtype,
    balance: amount ?? existing?.balance ?? null,
    availableBalance: null,
    currency: existing?.currency || 'USD',
    // The letter reports a value but not what the asset IS — flag it so the UI warns.
    unconfirmed: true,
    unconfirmedNote: `Amount from ${institution || 'a'} notice${amountAsOf ? ` (as of ${amountAsOf})` : ''}${assetNote ? ` — "${assetNote}"` : ''}; actual holdings unconfirmed.`,
    noticeDocId: noticeDocId || existing?.noticeDocId || null,
    lastUpdated: new Date().toISOString(),
  };
  io.write('accounts.json', existing
    ? accounts.map(a => (a === existing ? entry : a))
    : [...accounts, entry]);
  return entry.id;
}

// Create/refresh an action item. Keyed by institution+mask+noticeKind so the same letter
// re-submitted (or re-parsed) updates rather than duplicates.
function upsertActionItem(io, userId, n, { accountId, fileId } = {}) {
  const items = io.read('action_items.json') || [];
  const id = `act_${sha8(`${userId}|${slug(n.institution)}|${n.accountMask || ''}|${n.noticeKind}`)}`;
  const dueDate = n.consequenceDate || n.respondBy || null;
  const overdueWindow = n.respondBy && n.respondBy < new Date().toISOString().slice(0, 10);
  const existing = items.find(i => i && i.id === id);
  if (existing && existing.status === 'done') return existing.id;   // user already handled it
  const entry = {
    ...(existing || {}),
    id,
    status: 'open',
    kind: n.noticeKind,
    title: `Respond to ${n.institution || 'institution'} ${String(n.noticeKind).replace(/_/g, ' ')} notice${n.accountMask ? ` (••${n.accountMask})` : ''}`,
    detail: [
      n.actionRequired,
      overdueWindow ? `the ${n.letterDate ? `letter's (${n.letterDate}) ` : ''}response window has already passed — respond ASAP` : null,
      n.consequence ? `${n.consequence}${n.consequenceDate ? ` (by ${n.consequenceDate})` : ''}` : null,
      n.contactPhone ? `contact: ${n.contactPhone}` : null,
    ].filter(Boolean).join('. '),
    dueDate,
    urgent: !!overdueWindow,
    accountId: accountId || existing?.accountId || null,
    fileId: fileId || existing?.fileId || null,
    amount: n.reportedAmount ?? existing?.amount ?? null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  io.write('action_items.json', existing ? items.map(i => (i.id === id ? entry : i)) : [...items, entry]);
  return id;
}

// Record a fully-extracted notice. Returns { accountId, actionId } (either may be null).
function recordNotice(io, userId, n, { fileId } = {}) {
  if (!n || !n.isActionNotice) return { accountId: null, actionId: null };
  let accountId = null;
  if (n.institution && (n.reportedAmount != null || n.accountMask)) {
    accountId = upsertManualAccount(io, {
      institution: n.institution, mask: n.accountMask, accountKind: n.accountKind,
      amount: n.reportedAmount, amountAsOf: n.amountAsOf, assetNote: n.assetNote, noticeDocId: fileId || null,
    });
  }
  const actionId = (n.actionRequired || n.respondBy || n.consequenceDate)
    ? upsertActionItem(io, userId, n, { accountId, fileId })
    : null;
  return { accountId, actionId };
}

// ── "done" completion (bot command) ───────────────────────────────────────────
function listOpen(io) {
  return (io.read('action_items.json') || []).filter(i => i && i.status === 'open');
}

// Mark the best-matching open item done. `text` is whatever followed "done" in the DM
// ("done etoro", "done"). Returns { done, item?, options? }.
function markDone(io, text) {
  const open = listOpen(io);
  if (!open.length) return { done: false, reason: 'none_open' };
  const q = String(text || '').toLowerCase().trim();
  let hit = null;
  if (!q && open.length === 1) hit = open[0];
  else if (q) {
    const toks = q.split(/\s+/).filter(Boolean);
    const scored = open.map(i => ({ i, s: toks.filter(t => `${i.title} ${i.detail}`.toLowerCase().includes(t)).length }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) hit = scored[0].i;
  }
  if (!hit) return { done: false, reason: 'ambiguous', options: open.map(i => i.title) };
  const items = io.read('action_items.json') || [];
  io.write('action_items.json', items.map(i => (i.id === hit.id ? { ...i, status: 'done', doneAt: new Date().toISOString() } : i)));
  return { done: true, item: hit };
}

module.exports = { recordNotice, upsertManualAccount, upsertActionItem, listOpen, markDone };
