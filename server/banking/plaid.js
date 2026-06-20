const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
const express = require('express');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const csv     = require('../core/csv');
const { applyRules } = require('./categorize');
const { guessCategory, resolveCtx } = require('./auto-categorize');
const { verifyUser } = require('../core/verify');
const plaidItems = require('../core/plaid-items');   // Plaid connections live in the DB (encrypted), not connections.json

const PLAID_CAT_MAP = {
  FOOD_AND_DRINK:           'Dining',
  GROCERIES:                'Groceries',
  TRANSPORTATION:           'Transport',
  TRAVEL:                   'Travel',
  ENTERTAINMENT:            'Entertainment',
  RECREATION:               'Entertainment',
  GENERAL_MERCHANDISE:      'Shopping',
  CLOTHING_AND_ACCESSORIES: 'Shopping',
  HOME_IMPROVEMENT:         'Shopping',
  MEDICAL:                  'Health',
  PERSONAL_CARE:            'Health',
  RENT_AND_UTILITIES:       'Utilities',
  INCOME:                   'Income',
  TRANSFER_IN:              'Transfer',
  TRANSFER_OUT:             'Transfer',
};

// ── CSV staging layer ─────────────────────────────────────────────────
// Every Plaid sync stages its full pull to a per-user .csv file (raw bank
// columns only), then re-reads that file as a table and imports it into
// transactions.json. The CSV is an auditable snapshot of the bank data; the
// user's own fields (categorization, notes, splits) are NOT stored in it —
// they live on the transaction and are re-applied on import, keyed by Plaid id,
// so a re-sync never wipes them.
const PLAID_CSV   = 'plaid_transactions.csv';
// Full bank columns carried onto each imported transaction (these flow into transactions.json):
// month feeds grouping, pending drives the Banking "Pending/Posted" badge, source marks Plaid rows.
const RAW_COLUMNS = ['id', 'date', 'month', 'desc', 'amount', 'category', 'plaidCategory', 'account', 'institution', 'pending', 'source', 'lastUpdated'];
// Slim columns for the stored audit CSV — drops 'month' (= date's YYYY-MM), 'pending'
// (transient), and 'source' (always 'plaid' here) as redundant/noise for a CSV view.
const CSV_COLUMNS = ['id', 'date', 'desc', 'amount', 'category', 'plaidCategory', 'account', 'institution', 'lastUpdated'];
const KEEP        = ['coaId', 'coaAuto', 'capital', 'note', 'reconciled', 'isSplit', 'splitOf', 'splitNote', 'propertyId', 'approved', 'categorizedBy', 'verification', 'taxCategory', 'bucket', 'attachments', 'notified'];

const rawRow    = t => { const o = {}; for (const c of RAW_COLUMNS) o[c] = t[c]; return o; };
const coerceRow = r => ({ ...r, amount: r.amount === '' || r.amount == null ? 0 : Number(r.amount), pending: r.pending === 'true' || r.pending === true });

/**
 * Stage the Plaid pull to CSV, read it back as a table, and merge into the
 * existing transactions. Pure except for the CSV read/write it is handed.
 *   - This institution's fresh pull replaces its own rows (matched by id).
 *   - Every other Plaid row (other institutions + this one's out-of-window
 *     history) and all non-Plaid rows carry forward untouched.
 *   - User-owned KEEP fields are re-applied by id so categorization survives.
 *   - A settled charge supersedes its pending row: Plaid re-issues it with a new
 *     id whose pending_transaction_id points back at the pending one, so we drop
 *     the stale pending twin and move its edits onto the posted row.
 * Returns the new transactions array to persist.
 */
function stageAndImport({ existing, plaidTxs, readText, writeText, csvFile = PLAID_CSV }) {
  // Pending → posted settlement. When a pending charge settles, Plaid re-issues it as a
  // posted transaction with a NEW transaction_id whose pending_transaction_id references
  // the now-gone pending row. Left unhandled, the stale pending row lingers beside its
  // posted twin (the visible duplicate). Build the old→new link to resolve it.
  const supersededIds       = new Set();   // pending ids replaced by a posted txn this pull
  const pendingIdByPostedId = new Map();   // posted txn id -> pending id it replaced
  for (const p of plaidTxs) if (p.pendingTransactionId) {
    supersededIds.add(p.pendingTransactionId);
    pendingIdByPostedId.set(p.id, p.pendingTransactionId);
  }
  // If a single pull carries both the pending row and the posted txn replacing it, keep
  // only the posted one.
  const livePlaidTxs = plaidTxs.filter(p => !supersededIds.has(p.id));

  const prevById   = new Map(existing.map(t => [t.id, t]));
  const pulledIds  = new Set(livePlaidTxs.map(p => p.id));
  // Carry forward other plaid rows (other institutions + out-of-window history), minus any
  // pending row a posted txn now supersedes.
  const otherPlaid = existing.filter(t => t.source === 'plaid' && !pulledIds.has(t.id) && !supersededIds.has(t.id));
  const allRaw     = [...otherPlaid, ...livePlaidTxs].map(rawRow);

  // Store a slim, human-readable audit snapshot (CSV_COLUMNS subset of the raw rows).
  writeText(csvFile, csv.stringify(allRaw, CSV_COLUMNS));
  // Build the import table from the FULL rows — not re-read from the slim CSV — so
  // month/pending/source still flow onto the transaction.
  const table = allRaw.map(coerceRow);

  const imported = table.map(r => {                                 // table  -> transactions
    // Re-pulled row matches its prior self by id; a freshly-posted row (new id) falls back
    // to the pending row it superseded, so categorization/notes survive settlement.
    const old = prevById.get(r.id) || prevById.get(pendingIdByPostedId.get(r.id));
    if (!old) return r;
    const carry = {};
    for (const k of KEEP) if (old[k] !== undefined) carry[k] = old[k];
    return { ...r, ...carry };
  });
  const importedIds = new Set(imported.map(r => r.id));
  // Drop superseded pending rows from the carry-forward too, so they never reappear.
  return [...existing.filter(t => !importedIds.has(t.id) && !supersededIds.has(t.id)), ...imported];
}

module.exports = function(makeIO, notifyClients = () => {}) {
  const router = express.Router();

  const plaidConfigured = process.env.PLAID_CLIENT_ID &&
    process.env.PLAID_CLIENT_ID !== 'paste_your_client_id_here';

  let plaidClient = null;
  if (plaidConfigured) {
    plaidClient = new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
      baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
    }));
    console.log(`Plaid initialized (${process.env.PLAID_ENV || 'sandbox'} mode)`);
  } else {
    console.log('Plaid not configured — add keys to .env to enable live bank connections');
  }

  // ── Core helpers ──────────────────────────────────────────────────────
  function mapTransaction(t, institution_name) {
    const plaidPrimary = t.personal_finance_category?.primary || t.category?.[0] || '';
    const amount   = -t.amount;
    const category = amount > 0 ? 'Income' : (PLAID_CAT_MAP[plaidPrimary] || 'Other');
    const [y, m]   = t.date.split('-');
    return {
      id: t.transaction_id, date: t.date, month: `${y}-${m}`,
      desc: t.merchant_name || t.name, amount, category,
      plaidCategory: plaidPrimary, account: t.account_id,
      institution: institution_name, pending: t.pending,
      pendingTransactionId: t.pending_transaction_id || null,
      source: 'plaid', lastUpdated: new Date().toISOString()
    };
  }

  async function fetchAllTransactions(access_token, startDate, endDate, institution_name) {
    const all = []; let offset = 0; const COUNT = 500;
    while (true) {
      const resp  = await plaidClient.transactionsGet({ access_token, start_date: startDate, end_date: endDate, options: { count: COUNT, offset } });
      const batch = resp.data.transactions;
      all.push(...batch.map(t => mapTransaction(t, institution_name)));
      if (all.length >= resp.data.total_transactions || batch.length < COUNT) break;
      offset += COUNT;
      console.log(`[${institution_name}] Fetched ${all.length}/${resp.data.total_transactions} transactions...`);
    }
    return all;
  }

  async function syncItem(connection, io, userId, startDate = null) {
    const { access_token, institution_name } = connection;
    const { read, write, readText, writeText } = io;

    const accountsResp  = await plaidClient.accountsGet({ access_token });
    const plaidAccounts = accountsResp.data.accounts.map(a => ({
      id: a.account_id, name: a.name, officialName: a.official_name,
      type: a.type, subtype: a.subtype, balance: a.balances.current,
      availableBalance: a.balances.available, institution: institution_name,
      last4: a.mask, currency: a.balances.iso_currency_code,
      source: 'plaid', lastUpdated: new Date().toISOString()
    }));

    const existingAccounts = read('accounts.json') || [];
    // Replace ALL plaid accounts for this institution (handles reconnection with new account IDs)
    write('accounts.json', [
      ...existingAccounts.filter(a => a.source !== 'plaid' || a.institution !== institution_name),
      ...plaidAccounts
    ]);

    let txCount = 0;
    let supersededPendingIds = [];
    try {
      const endDate  = new Date().toISOString().split('T')[0];
      const start    = startDate || new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const plaidTxs = await fetchAllTransactions(access_token, start, endDate, institution_name);
      const existing = read('transactions.json') || [];
      // Stage the pull to a CSV file, then import that file back into the table.
      // stageAndImport preserves user-owned fields (categorization, notes, splits)
      // by Plaid id, so a re-sync never wipes them.
      write('transactions.json', stageAndImport({ existing, plaidTxs, readText, writeText }));
      // Pending ids that a posted txn in this pull replaced — pruned from the audit table in syncUser.
      supersededPendingIds = plaidTxs.map(p => p.pendingTransactionId).filter(Boolean);
      // Persist the raw Plaid pull CSV into the DB (auditable extracted-data snapshot).
      try { await require('../core/csv-store').saveCsv(userId, PLAID_CSV, readText(PLAID_CSV) || ''); }
      catch (e) { console.error('[csv-store] plaid:', e.message); }
      txCount = plaidTxs.length;
    } catch (e) {
      if (e.response?.data?.error_code === 'PRODUCT_NOT_READY') {
        console.log(`[${institution_name}] Transactions initializing — will be ready shortly`);
      } else { throw e; }
    }
    return { accounts: plaidAccounts.length, transactions: txCount, supersededPendingIds };
  }

  // ── Sync all items for a given user (used by cron and sync-history) ───
  async function syncUser(userId, startDate = null) {
    if (!plaidClient) return { skipped: true };
    const io    = makeIO(userId);
    const items = await plaidItems.listItems(userId);   // from DB (encrypted tokens), not connections.json
    if (!items.length) return { synced: 0 };

    // Snapshot existing transaction ids so we can tell which are genuinely new this sync.
    const beforeIds = new Set((io.read('transactions.json') || []).map(t => t.id));

    const results = [];
    for (const conn of items) {
      try {
        results.push({ institution: conn.institution_name, ...await syncItem(conn, io, userId, startDate) });
      } catch (e) {
        console.error(`Sync error [${conn.institution_name}]:`, e.response?.data || e.message);
        results.push({ institution: conn.institution_name, error: e.message });
      }
    }
    for (const it of items) { try { await plaidItems.touchSync(it.item_id); } catch {} }
    // Auto-categorize freshly-synced transactions: saved rules first, then the built-in
    // merchant/bucket guesser for anything still uncategorized. Only uncategorized txns
    // are touched, so manual picks and prior auto-guesses (preserved by Plaid id) survive.
    try {
      let txns = io.read('transactions.json') || [];
      const rules = io.read('categorization_rules.json') || [];
      const settings = io.read('account_settings.json') || {};
      let accountsById = new Map();
      try { accountsById = new Map((await require('../core/banking-store').listAccounts(userId)).map(a => [a.id, a])); } catch {}
      const r = applyRules(txns, rules);
      txns = r.transactions;
      let auto = 0, capital = 0;
      txns = txns.map(t => {
        if (t.excluded || t.coaId) return t;       // excluded, manual, rule-set, or prior auto
        const g = guessCategory(t, resolveCtx(t, settings, accountsById));
        if (!g) return t;                           // transfer → stays uncategorized
        auto++; if (g.capital) capital++;
        return { ...t, coaId: g.coaId, coaAuto: true, approved: false, ...(g.capital ? { capital: true } : {}) };
      });
      if (r.count || auto) { io.write('transactions.json', txns); console.log(`[Auto-cat] user ${userId}: ${r.count} by rule, ${auto} auto (${capital} capital)`); }
    } catch (e) { console.error('[Auto-cat] error:', e.message); }
    try { const m = await require('./neon-mirror').mirrorPlaid(userId, io.read('transactions.json') || []); console.log(`[Neon] user ${userId}: mirrored ${m} plaid rows`); } catch (e) { console.error('[Neon mirror] error:', e.message); }
    // Prune audit rows for pending charges that settled this sync — stageAndImport already
    // dropped them from transactions.json; clear the source_transactions twins too.
    try {
      const supersededPendingIds = [...new Set(results.flatMap(r => r.supersededPendingIds || []))];
      if (supersededPendingIds.length) {
        const d = await require('./neon-mirror').deleteSupersededPending(userId, supersededPendingIds);
        if (d) console.log(`[Neon] user ${userId}: pruned ${d} superseded pending row(s)`);
      }
    } catch (e) { console.error('[Neon prune] error:', e.message); }
    try { const _n = await require('./notifier').notifyNew(io, process.env.DISCORD_WEBHOOK_URL); if (_n) console.log(`[notify] user ${userId}: ${_n} Discord alert(s) sent`); } catch (e) { console.error('[notify] error', e.message); }
    // Queue conversational categorization questions — only for genuinely-new transactions
    // this sync (not the historical backlog), so the bot asks about fresh activity only.
    try {
      const { query } = require('../core/db');
      const after  = io.read('transactions.json') || [];
      const newIds = after.filter(t => !beforeIds.has(t.id)).map(t => t.id);
      const _q = await require('./categorizer-core').enqueueQuestions(query, io, userId, { channel: 'discord', onlyIds: newIds });
      if (_q) console.log(`[Categorizer] user ${userId}: queued ${_q} question(s) for ${newIds.length} new txn(s)`);
    } catch (e) { console.error('[Categorizer] enqueue error:', e.message); }
    // Retroactively match unmatched (non-cash) receipts to the transactions just pulled.
    try {
      const { query } = require('../core/db');
      const _rm = await require('./receipt-match').matchPendingReceipts(query, io, userId);
      if (_rm) console.log(`[Receipts] user ${userId}: matched ${_rm} pending receipt(s) to transactions`);
    } catch (e) { console.error('[Receipts match] error:', e.message); }
    // Auto-reconcile: re-match Plaid rows against any previously uploaded statement data
    try {
      const { query } = require('../core/db');
      const cnt = await query(`SELECT COUNT(*)::int AS c FROM source_transactions WHERE user_id=$1 AND source='statement'`, [userId]);
      if (cnt.rows[0].c > 0) {
        const r = await require('./reconciler').reconcileUser(query, userId, io);
        console.log(`[Reconcile] user ${userId}: ${r.matched} matched, ${r.conflicts} conflicts, ${r.stmtOnly} stmt-only, ${r.plaidOnly} Plaid-only`);
      }
    } catch (e) { console.error('[Reconcile] error:', e.message); }
    notifyClients();
    // Run verification checks and print report to server terminal
    try { await verifyUser(userId, io); } catch (e) { console.error('[Verify] Error:', e.message); }
    return { synced: results.length, results };
  }

  // ── Create Link Token ─────────────────────────────────────────────────
  router.post('/create-link-token', async (req, res) => {
    if (!plaidClient) return res.status(400).json({ error: 'Plaid not configured. Add your API keys to .env' });
    try {
      const tokenRequest = {
        user: { client_user_id: req.user.id },
        client_name: 'CaiShen', products: ['transactions'],
        country_codes: ['US'], language: 'en',
      };
      if (process.env.PLAID_WEBHOOK_URL) tokenRequest.webhook = process.env.PLAID_WEBHOOK_URL;
      const response = await plaidClient.linkTokenCreate(tokenRequest);
      res.json({ link_token: response.data.link_token });
    } catch (e) {
      console.error('Plaid link token error:', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error_message || e.message });
    }
  });

  // ── Exchange public token ─────────────────────────────────────────────
  router.post('/exchange-token', async (req, res) => {
    if (!plaidClient) return res.status(400).json({ error: 'Plaid not configured' });
    const { public_token, institution_name } = req.body;
    const io = makeIO(req.user.id);
    try {
      const response = await plaidClient.itemPublicTokenExchange({ public_token });
      const { access_token, item_id } = response.data;
      await plaidItems.saveItem(req.user.id, { item_id, access_token, institution_name: institution_name || 'Unknown Bank' });
      const connection = { item_id, access_token, institution_name: institution_name || 'Unknown Bank' };
      res.json({ success: true, institution: institution_name });
      syncItem(connection, io, req.user.id).catch(e => console.error('Initial sync error:', e.response?.data || e.message));
    } catch (e) {
      console.error('Token exchange error:', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error_message || e.message });
    }
  });

  // ── Get connections ───────────────────────────────────────────────────
  router.get('/connections', async (req, res) => {
    try {
      const items = await plaidItems.listItems(req.user.id);
      res.json(items.map(c => ({
        item_id: c.item_id, institution_name: c.institution_name,
        connectedAt: c.connectedAt, lastSync: c.lastSync
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Manual sync ───────────────────────────────────────────────────────
  router.post('/sync', async (req, res) => {
    if (!plaidClient) return res.status(400).json({ error: 'Plaid not configured' });
    try { res.json(await syncUser(req.user.id)); }
    catch (e) { console.error('Manual sync error:', e.response?.data || e.message); res.status(500).json({ error: e.message }); }
  });

  // ── Sync full 2-year history ──────────────────────────────────────────
  router.post('/sync-history', async (req, res) => {
    if (!plaidClient) return res.status(400).json({ error: 'Plaid not configured' });
    const items = await plaidItems.listItems(req.user.id);
    if (!items.length) return res.status(400).json({ error: 'No Plaid connections found' });
    res.json({ status: 'started' });

    const startDate = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    console.log(`[History] User ${req.user.id} — syncing from ${startDate}...`);
    try {
      await syncUser(req.user.id, startDate);
      console.log(`[History] User ${req.user.id} sync complete`);
    } catch (e) { console.error(`[History] Error:`, e.message); }
    notifyClients();
  });

  // ── Remove connection ─────────────────────────────────────────────────
  router.delete('/connections/:itemId', async (req, res) => {
    const io    = makeIO(req.user.id);
    const items = await plaidItems.listItems(req.user.id);
    const conn  = items.find(c => c.item_id === req.params.itemId);
    if (conn && plaidClient) {
      try { await plaidClient.itemRemove({ access_token: conn.access_token }); } catch(e) {}
    }
    const institutionName = conn?.institution_name;
    await plaidItems.removeItem(req.user.id, req.params.itemId);
    // Clean up accounts and transactions for this institution
    if (institutionName) {
      const accounts = io.read('accounts.json') || [];
      io.write('accounts.json', accounts.filter(a => a.source !== 'plaid' || a.institution !== institutionName));
      const txs = io.read('transactions.json') || [];
      io.write('transactions.json', txs.filter(t => t.source !== 'plaid' || t.institution !== institutionName));
    }
    res.json({ success: true });
  });

  // ── Webhook (no user context — Plaid calls this directly) ────────────
  // ── Plaid webhook signature verification ───────────────────────────────────
  // Plaid signs every webhook (a JWS in the `Plaid-Verification` header). We verify
  // the signature against Plaid's published key and check the request-body SHA-256,
  // so only genuine Plaid calls can trigger a sync (the endpoint is unauthenticated
  // by necessity — Plaid has no user session).
  const _webhookKeys = new Map();   // kid -> PEM (Plaid rotates keys; cache by kid)
  async function plaidWebhookKey(kid) {
    if (_webhookKeys.has(kid)) return _webhookKeys.get(kid);
    const resp = await plaidClient.webhookVerificationKeyGet({ key_id: kid });
    const pem  = crypto.createPublicKey({ key: resp.data.key, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    _webhookKeys.set(kid, pem);
    return pem;
  }
  async function verifyPlaidWebhook(req) {
    try {
      if (!plaidClient) return false;
      const token = req.headers['plaid-verification'];
      if (!token || !req.rawBody) return false;
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || decoded.header.alg !== 'ES256' || !decoded.header.kid) return false;
      const pem     = await plaidWebhookKey(decoded.header.kid);
      const payload = jwt.verify(token, pem, { algorithms: ['ES256'], maxAge: '5m' }); // bounds replay
      const want = Buffer.from(payload.request_body_sha256 || '', 'hex');
      const got  = crypto.createHash('sha256').update(req.rawBody).digest();
      return want.length === got.length && crypto.timingSafeEqual(want, got);
    } catch (e) {
      console.warn('[Webhook] signature verification failed:', e.message);
      return false;
    }
  }

  router.post('/webhook', async (req, res) => {
    // Reject anything not provably from Plaid before doing any work.
    if (!(await verifyPlaidWebhook(req))) return res.status(401).json({ error: 'Invalid webhook signature' });
    res.json({ received: true });
    const { webhook_type, item_id } = req.body;
    console.log(`[Webhook] ${webhook_type} for item ${item_id}`);
    if (webhook_type !== 'TRANSACTIONS') return;

    // Find which user owns this item_id (DB lookup — no filesystem scan)
    const owner = await plaidItems.findOwner(item_id);
    if (!owner) return;
    const { userId: uid, item: conn } = owner;
    const io = makeIO(uid);
    syncItem(conn, io, uid)
      .then(async r => {
        console.log(`[Webhook] ${conn.institution_name} (user ${uid}): ${r.transactions} txs`);
        await plaidItems.touchSync(item_id);
        notifyClients();
        try { await verifyUser(uid, io); } catch (e) { console.error('[Verify] Error:', e.message); }
      })
      .catch(e => console.error(`[Webhook] Sync error:`, e.message));
  });

  return { router, syncUser };
};

// Exposed for unit testing the CSV staging-layer import in isolation.
module.exports.stageAndImport = stageAndImport;
module.exports.PLAID_CSV      = PLAID_CSV;
