const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const csv     = require('./csv');
const { applyRules } = require('./categorize');
const { verifyUser } = require('./verify');

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
const CSV_COLUMNS = ['id', 'date', 'month', 'desc', 'amount', 'category', 'plaidCategory', 'account', 'institution', 'pending', 'source', 'lastUpdated'];
const KEEP        = ['coaId', 'note', 'reconciled', 'isSplit', 'splitOf', 'splitNote', 'propertyId'];

const rawRow    = t => { const o = {}; for (const c of CSV_COLUMNS) o[c] = t[c]; return o; };
const coerceRow = r => ({ ...r, amount: r.amount === '' || r.amount == null ? 0 : Number(r.amount), pending: r.pending === 'true' || r.pending === true });

/**
 * Stage the Plaid pull to CSV, read it back as a table, and merge into the
 * existing transactions. Pure except for the CSV read/write it is handed.
 *   - This institution's fresh pull replaces its own rows (matched by id).
 *   - Every other Plaid row (other institutions + this one's out-of-window
 *     history) and all non-Plaid rows carry forward untouched.
 *   - User-owned KEEP fields are re-applied by id so categorization survives.
 * Returns the new transactions array to persist.
 */
function stageAndImport({ existing, plaidTxs, readText, writeText, csvFile = PLAID_CSV }) {
  const prevById   = new Map(existing.map(t => [t.id, t]));
  const pulledIds  = new Set(plaidTxs.map(p => p.id));
  const otherPlaid = existing.filter(t => t.source === 'plaid' && !pulledIds.has(t.id));
  const allRaw     = [...otherPlaid, ...plaidTxs].map(rawRow);

  writeText(csvFile, csv.stringify(allRaw, CSV_COLUMNS));            // Plaid  -> CSV file
  const table = csv.parse(readText(csvFile) || '').map(coerceRow);  // CSV    -> table

  const imported = table.map(r => {                                 // table  -> transactions
    const old = prevById.get(r.id);
    if (!old) return r;
    const carry = {};
    for (const k of KEEP) if (old[k] !== undefined) carry[k] = old[k];
    return { ...r, ...carry };
  });
  const importedIds = new Set(imported.map(r => r.id));
  return [...existing.filter(t => !importedIds.has(t.id)), ...imported];
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

  async function syncItem(connection, io, startDate = null) {
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
    try {
      const endDate  = new Date().toISOString().split('T')[0];
      const start    = startDate || new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const plaidTxs = await fetchAllTransactions(access_token, start, endDate, institution_name);
      const existing = read('transactions.json') || [];
      // Stage the pull to a CSV file, then import that file back into the table.
      // stageAndImport preserves user-owned fields (categorization, notes, splits)
      // by Plaid id, so a re-sync never wipes them.
      write('transactions.json', stageAndImport({ existing, plaidTxs, readText, writeText }));
      txCount = plaidTxs.length;
    } catch (e) {
      if (e.response?.data?.error_code === 'PRODUCT_NOT_READY') {
        console.log(`[${institution_name}] Transactions initializing — will be ready shortly`);
      } else { throw e; }
    }
    return { accounts: plaidAccounts.length, transactions: txCount };
  }

  // ── Sync all items for a given user (used by cron and sync-history) ───
  async function syncUser(userId, startDate = null) {
    if (!plaidClient) return { skipped: true };
    const io          = makeIO(userId);
    const connections = io.read('connections.json') || { plaid: [] };
    const items       = connections.plaid || [];
    if (!items.length) return { synced: 0 };

    const results = [];
    for (const conn of items) {
      try {
        results.push({ institution: conn.institution_name, ...await syncItem(conn, io, startDate) });
      } catch (e) {
        console.error(`Sync error [${conn.institution_name}]:`, e.response?.data || e.message);
        results.push({ institution: conn.institution_name, error: e.message });
      }
    }
    const updated = io.read('connections.json') || { plaid: [] };
    updated.plaid = updated.plaid.map(c => ({ ...c, lastSync: new Date().toISOString() }));
    io.write('connections.json', updated);
    // Auto-categorize freshly-synced transactions against the user's saved rules.
    try {
      const rules = io.read('categorization_rules.json') || [];
      if (rules.length) {
        const { transactions, count } = applyRules(io.read('transactions.json') || [], rules);
        if (count) { io.write('transactions.json', transactions); console.log(`[Auto-cat] user ${userId}: ${count} txns categorized by rule`); }
      }
    } catch (e) { console.error('[Auto-cat] error:', e.message); }
    notifyClients();
    // Run verification checks and print report to server terminal
    try { verifyUser(userId, io); } catch (e) { console.error('[Verify] Error:', e.message); }
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
      const connections = io.read('connections.json') || { plaid: [] };
      const existing = connections.plaid.findIndex(c => c.item_id === item_id);
      const connection = { item_id, access_token, institution_name: institution_name || 'Unknown Bank', connectedAt: new Date().toISOString(), lastSync: null };
      if (existing >= 0) connections.plaid[existing] = connection;
      else connections.plaid.push(connection);
      io.write('connections.json', connections);
      res.json({ success: true, institution: institution_name });
      syncItem(connection, io).catch(e => console.error('Initial sync error:', e.response?.data || e.message));
    } catch (e) {
      console.error('Token exchange error:', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error_message || e.message });
    }
  });

  // ── Get connections ───────────────────────────────────────────────────
  router.get('/connections', (req, res) => {
    const connections = makeIO(req.user.id).read('connections.json') || { plaid: [] };
    res.json((connections.plaid || []).map(c => ({
      item_id: c.item_id, institution_name: c.institution_name,
      connectedAt: c.connectedAt, lastSync: c.lastSync
    })));
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
    const io    = makeIO(req.user.id);
    const conns = io.read('connections.json') || { plaid: [] };
    if (!(conns.plaid || []).length) return res.status(400).json({ error: 'No Plaid connections found' });
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
    const io          = makeIO(req.user.id);
    const connections = io.read('connections.json') || { plaid: [] };
    const conn        = connections.plaid.find(c => c.item_id === req.params.itemId);
    if (conn && plaidClient) {
      try { await plaidClient.itemRemove({ access_token: conn.access_token }); } catch(e) {}
    }
    const institutionName = conn?.institution_name;
    connections.plaid = connections.plaid.filter(c => c.item_id !== req.params.itemId);
    io.write('connections.json', connections);
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
  router.post('/webhook', async (req, res) => {
    res.json({ received: true });
    const { webhook_type, item_id } = req.body;
    console.log(`[Webhook] ${webhook_type} for item ${item_id}`);
    if (webhook_type !== 'TRANSACTIONS') return;

    // Find which user owns this item_id
    const usersDir = path.join(__dirname, '../data/users');
    const userIds  = fs.existsSync(usersDir) ? fs.readdirSync(usersDir) : [];
    for (const uid of userIds) {
      const io    = makeIO(uid);
      const conns = io.read('connections.json') || { plaid: [] };
      const conn  = (conns.plaid || []).find(c => c.item_id === item_id);
      if (!conn) continue;
      syncItem(conn, io)
        .then(r => {
          console.log(`[Webhook] ${conn.institution_name} (user ${uid}): ${r.transactions} txs`);
          const updated = io.read('connections.json') || { plaid: [] };
          const idx = updated.plaid.findIndex(c => c.item_id === item_id);
          if (idx >= 0) { updated.plaid[idx].lastSync = new Date().toISOString(); io.write('connections.json', updated); }
          notifyClients();
          try { verifyUser(uid, io); } catch (e) { console.error('[Verify] Error:', e.message); }
        })
        .catch(e => console.error(`[Webhook] Sync error:`, e.message));
      break;
    }
  });

  return { router, syncUser };
};

// Exposed for unit testing the CSV staging-layer import in isolation.
module.exports.stageAndImport = stageAndImport;
module.exports.PLAID_CSV      = PLAID_CSV;
