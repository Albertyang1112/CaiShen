const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
const express = require('express');
const path    = require('path');
const fs      = require('fs');

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
    const { read, write } = io;

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
      const start    = startDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const plaidTxs = await fetchAllTransactions(access_token, start, endDate, institution_name);
      const existing = read('transactions.json') || [];
      write('transactions.json', [
        ...existing.filter(t => t.source !== 'plaid' || !plaidTxs.find(p => p.id === t.id)),
        ...plaidTxs
      ]);
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
    notifyClients();
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
        })
        .catch(e => console.error(`[Webhook] Sync error:`, e.message));
      break;
    }
  });

  return { router, syncUser };
};
