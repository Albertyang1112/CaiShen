'use strict';
/**
 * banking/routes.js — HTTP routes for the Banking page.
 *
 * Mounted at /api by server/index.js. Covers the data the Banking UI reads/writes:
 *   • Accounts        GET/POST/PATCH/DELETE /api/accounts
 *   • Transactions    GET/POST/PATCH/DELETE /api/transactions
 *   • Tx overrides    PATCH /api/tx-overrides/:id     (sync-safe per-tx edits)
 *   • Categorization  GET/POST/DELETE /api/categorization-rules (+ /suggest, /apply)
 *
 * Other banking-domain concerns live in sibling files:
 *   plaid.js (sync), statements.js, reconciler.js + reconcile-routes.js,
 *   receipt-routes.js, categorize.js (rule engine), notifier.js, neon-mirror.js.
 *
 * Storage is the per-user JSON store; index.js injects readData/writeData so this
 * module stays decoupled from the filesystem layout.
 */
const express = require('express');
const { applyRules: applyCatRules, suggestKeyword: suggestCatKeyword } = require('./categorize');
const { guessCategory, resolveCtx } = require('./auto-categorize');
const { setVendorAndLearn } = require('./vendor-learn');
const store = require('../core/banking-store');   // DB-backed reads for accounts/transactions

module.exports = function makeBankingRouter({ readData, writeData }) {
  const router = express.Router();

  // ── Accounts ──────────────────────────────────────────────────────────
  // Read straight from the structured accounts table (indexed, scalable) — the
  // table is kept current by writeData's write-through mirror.
  router.get('/accounts', async (req, res) => {
    try { res.json(await store.listAccounts(req.user?.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/accounts', (req, res) => {
    const uid = req.user.id;
    const accounts = readData('accounts.json', uid) || [];
    const account = {
      id:          `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name:        req.body.name        || 'Account',
      institution: req.body.institution || req.body.name || 'Unknown',
      type:        req.body.type        || 'depository',
      subtype:     req.body.subtype     || 'checking',
      balance:     Number(req.body.balance) || 0,
      last4:       req.body.last4       || null,
      source:      'manual',
      lastUpdated: new Date().toISOString(),
      createdAt:   new Date().toISOString(),
    };
    accounts.push(account);
    writeData('accounts.json', accounts, uid);
    res.json(account);
  });

  router.patch('/accounts/:id', (req, res) => {
    const uid = req.user.id;
    const accounts = readData('accounts.json', uid) || [];
    const idx = accounts.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    accounts[idx] = { ...accounts[idx], ...req.body, lastUpdated: new Date().toISOString() };
    writeData('accounts.json', accounts, uid);
    res.json(accounts[idx]);
  });

  router.delete('/accounts/:id', (req, res) => {
    const uid = req.user.id;
    const accounts = readData('accounts.json', uid) || [];
    if (!accounts.find(a => a.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
    writeData('accounts.json', accounts.filter(a => a.id !== req.params.id), uid);
    res.json({ success: true });
  });

  // ── Transactions ──────────────────────────────────────────────────────
  // GET merges per-transaction user overrides onto the synced transactions.
  // Overrides live in a separate store so a Plaid re-sync (which replaces plaid
  // txs) never wipes the user's edits.
  router.get('/transactions', async (req, res) => {
    try {
      const uid = req.user?.id;
      const txs = await store.listTransactions(uid);          // from the transactions table
      const ov  = readData('tx_overrides.json', uid) || {};   // user edits stay in the kv store
      res.json(txs.map(t => {
        const o = ov[t.id];
        if (!o) return t;
        return {
          ...t,
          ...(o.category    !== undefined ? { category:    o.category }    : {}),
          ...(o.excluded    !== undefined ? { excluded:    o.excluded }    : {}),
          ...(o.attachments !== undefined ? { attachments: o.attachments } : {}),
        };
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/transactions', (req, res) => {
    const uid  = req.user.id;
    const txs  = readData('transactions.json', uid) || [];
    const newTx = { id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...req.body, source: req.body.source || 'manual', createdAt: new Date().toISOString() };
    txs.push(newTx);
    writeData('transactions.json', txs, uid);
    res.json(newTx);
  });

  router.patch('/transactions/:id', (req, res) => {
    const uid = req.user.id;
    const txs = readData('transactions.json', uid) || [];
    const idx = txs.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    txs[idx] = { ...txs[idx], ...req.body, updatedAt: new Date().toISOString() };
    writeData('transactions.json', txs, uid);
    res.json(txs[idx]);
  });

  router.delete('/transactions/:id', (req, res) => {
    const uid = req.user.id;
    const txs = readData('transactions.json', uid) || [];
    if (!txs.find(t => t.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
    writeData('transactions.json', txs.filter(t => t.id !== req.params.id), uid);
    res.json({ success: true });
  });

  // ── From/To (vendor / counterparty) ────────────────────────────────────
  // The user types who a transaction was paid to / received from. We mark it as a manual
  // value, learn the merchant pattern, and back-fill every other matching transaction so
  // labeling a merchant once applies everywhere (past + future). Cleared (empty) value
  // forgets the pattern. Reports read this first (accounting cleanMerchant), Plaid desc
  // is the fallback. See banking/vendor-learn.js.
  router.patch('/transactions/:id/vendor', (req, res) => {
    const uid = req.user.id;
    const txs = readData('transactions.json', uid) || [];
    if (!txs.find(t => t.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
    const mem = readData('vendor_memory.json', uid) || {};
    const r = setVendorAndLearn(txs, req.params.id, (req.body || {}).vendor, mem);
    writeData('transactions.json', r.transactions, uid);
    writeData('vendor_memory.json', r.memory, uid);
    res.json({ updated: r.updated, transactions: r.transactions });
  });

  // Per-transaction overrides (sync-safe; never wiped by Plaid re-sync).
  // Body may include: category, excluded, attachments (full array),
  // or addAttachment / removeAttachment (vault file id helpers).
  // (From/To lives on the transaction itself — see PATCH /transactions/:id/vendor.)
  router.patch('/tx-overrides/:id', (req, res) => {
    const uid = req.user.id;
    const ov  = readData('tx_overrides.json', uid) || {};
    const next = { ...(ov[req.params.id] || {}) };
    const b = req.body || {};
    if (b.category    !== undefined) next.category    = b.category;
    if (b.excluded    !== undefined) next.excluded    = !!b.excluded;
    if (b.attachments !== undefined) next.attachments = b.attachments;
    if (b.addAttachment)    next.attachments = [...new Set([...(next.attachments || []), b.addAttachment])];
    if (b.removeAttachment) next.attachments = (next.attachments || []).filter(x => x !== b.removeAttachment);
    // Prune an override that no longer carries anything, to keep the store tidy.
    if (next.category === undefined && !next.excluded && !(next.attachments && next.attachments.length)) {
      delete ov[req.params.id];
    } else {
      ov[req.params.id] = next;
    }
    writeData('tx_overrides.json', ov, uid);
    res.json({ id: req.params.id, override: ov[req.params.id] || null });
  });

  // ── Auto-categorization rules (description → Chart-of-Accounts) ────────
  router.get('/categorization-rules', (req, res) => {
    res.json(readData('categorization_rules.json', req.user?.id) || []);
  });

  router.get('/categorization-rules/suggest', (req, res) => {
    res.json({ keyword: suggestCatKeyword(req.query.desc || '') });
  });

  router.post('/categorization-rules', (req, res) => {
    const uid = req.user.id;
    const b = req.body || {};
    if (!b.value || !b.coaId) return res.status(400).json({ error: 'value and coaId are required' });
    const rules = readData('categorization_rules.json', uid) || [];
    const rule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      field: b.field || 'desc', op: b.op || 'contains',
      value: b.value, coaId: b.coaId, enabled: b.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    rules.push(rule);
    writeData('categorization_rules.json', rules, uid);
    // Optionally back-fill existing uncategorized transactions right away.
    let applied = 0;
    if (b.applyNow) {
      const txs = readData('transactions.json', uid) || [];
      const r = applyCatRules(txs, [rule]);
      if (r.count) { writeData('transactions.json', r.transactions, uid); applied = r.count; }
    }
    res.json({ rule, applied });
  });

  router.delete('/categorization-rules/:id', (req, res) => {
    const uid = req.user.id;
    const rules = readData('categorization_rules.json', uid) || [];
    writeData('categorization_rules.json', rules.filter(r => r.id !== req.params.id), uid);
    res.json({ success: true });
  });

  router.post('/categorization-rules/apply', (req, res) => {
    const uid = req.user.id;
    const txs   = readData('transactions.json', uid) || [];
    const rules = readData('categorization_rules.json', uid) || [];
    const r = applyCatRules(txs, rules, { overwrite: !!(req.body && req.body.overwrite) });
    if (r.count) writeData('transactions.json', r.transactions, uid);
    res.json({ count: r.count, byRule: r.byRule });
  });

  // Auto-categorize: precedence is manual > user rule > built-in guesser. A manual pick
  // is a coaId WITHOUT the coaAuto flag and is never touched. Auto picks land as
  // { coaAuto:true, approved:false }; business-account purchases route to business leaves,
  // and big equipment/furniture buys are capitalized ({ capital:true }) so they show on the
  // Balance Sheet instead of the P&L. Re-runnable after each sync.
  router.post('/transactions/auto-categorize', async (req, res) => {
    const uid = req.user.id;
    let txs = readData('transactions.json', uid) || [];
    const rules = readData('categorization_rules.json', uid) || [];
    const settings = readData('account_settings.json', uid) || {};
    let accountsById = new Map();
    try { accountsById = new Map((await store.listAccounts(uid)).map(a => [a.id, a])); } catch {}

    // 1. Drop prior auto-guesses (incl. capitalized fixed-asset picks) so rules / a refreshed
    //    guesser re-evaluate them. Manual + rule-set coaIds (no coaAuto flag) are left intact.
    txs = txs.map(t => { if (t.coaAuto) { const { coaId, coaAuto, capital, ...rest } = t; return rest; } return t; });

    // 2. User rules fill anything uncategorized.
    const ruleRes = applyCatRules(txs, rules);
    txs = ruleRes.transactions;

    // 3. Built-in business-aware guesser fills whatever's still uncategorized.
    let auto = 0, capital = 0;
    txs = txs.map(t => {
      if (t.excluded || t.coaId) return t;       // excluded, manual, or rule-set
      const g = guessCategory(t, resolveCtx(t, settings, accountsById));
      if (!g) return t;                           // transfer → stays uncategorized
      auto++; if (g.capital) capital++;
      return { ...t, coaId: g.coaId, coaAuto: true, approved: false, ...(g.capital ? { capital: true } : {}) };
    });

    writeData('transactions.json', txs, uid);
    // Return the updated set so the client can render it directly (no DB re-read while
    // the async mirror is still committing).
    res.json({ rules: ruleRes.count, auto, capital, total: ruleRes.count + auto, transactions: txs });
  });

  // Revert ONE transaction to its automatic category — same precedence as the bulk
  // endpoint above (user rule first, then the built-in guesser), falling back to
  // uncategorized when neither applies (e.g. transfers). Powers the Banking table's
  // category revert, so undoing a manual pick restores the auto suggestion instead
  // of leaving a hole. Always returns to Pending (approved:false).
  router.post('/transactions/:id/auto-categorize', async (req, res) => {
    const uid = req.user.id;
    const txs = readData('transactions.json', uid) || [];
    const idx = txs.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const { coaId, coaAuto, capital, ...bare } = txs[idx];
    let next = { ...bare, approved: false };

    const rules = readData('categorization_rules.json', uid) || [];
    const ruled = applyCatRules([next], rules).transactions[0];
    if (ruled.coaId) {
      next = ruled;                                    // rule-set: coaId without coaAuto, like the bulk pass
    } else {
      const settings = readData('account_settings.json', uid) || {};
      let accountsById = new Map();
      try { accountsById = new Map((await store.listAccounts(uid)).map(a => [a.id, a])); } catch {}
      const g = guessCategory(next, resolveCtx(next, settings, accountsById));
      if (g) next = { ...next, coaId: g.coaId, coaAuto: true, ...(g.capital ? { capital: true } : {}) };
    }

    next.updatedAt = new Date().toISOString();
    txs[idx] = next;
    writeData('transactions.json', txs, uid);
    res.json(next);
  });

  // ── Per-account settings (business flag + property tag) ────────────────
  // Kept separate from accounts.json so a Plaid re-sync never wipes them.
  // Shape: { [accountId]: { business: bool, propertyId: string|null } }.
  router.get('/account-settings', (req, res) => {
    res.json(readData('account_settings.json', req.user?.id) || {});
  });

  router.put('/account-settings/:id', (req, res) => {
    const uid = req.user.id;
    const all = readData('account_settings.json', uid) || {};
    const cur = all[req.params.id] || {};
    const b = req.body || {};
    const next = { ...cur };
    if (b.business   !== undefined) next.business   = !!b.business;
    if (b.propertyId !== undefined) next.propertyId = b.propertyId || null;
    if (!next.business && !next.propertyId) delete all[req.params.id];   // prune empty
    else all[req.params.id] = next;
    writeData('account_settings.json', all, uid);
    res.json({ id: req.params.id, setting: all[req.params.id] || null });
  });

  return router;
};
