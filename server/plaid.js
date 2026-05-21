const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
const express = require('express');

const PLAID_CAT_MAP = {
  FOOD_AND_DRINK:              'Dining',
  GROCERIES:                   'Groceries',
  TRANSPORTATION:              'Transport',
  TRAVEL:                      'Travel',
  ENTERTAINMENT:               'Entertainment',
  RECREATION:                  'Entertainment',
  GENERAL_MERCHANDISE:         'Shopping',
  CLOTHING_AND_ACCESSORIES:    'Shopping',
  HOME_IMPROVEMENT:            'Shopping',
  MEDICAL:                     'Health',
  PERSONAL_CARE:               'Health',
  RENT_AND_UTILITIES:          'Utilities',
  INCOME:                      'Income',
  TRANSFER_IN:                 'Transfer',
  TRANSFER_OUT:                'Transfer',
};

module.exports = function(readData, writeData, notifyClients = () => {}) {
  const router = express.Router();

  const plaidConfigured = process.env.PLAID_CLIENT_ID &&
    process.env.PLAID_CLIENT_ID !== 'paste_your_client_id_here';

  let plaidClient = null;
  if (plaidConfigured) {
    const config = new Configuration({
      basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
        },
      },
    });
    plaidClient = new PlaidApi(config);
    console.log(`Plaid initialized (${process.env.PLAID_ENV || 'sandbox'} mode)`);
  } else {
    console.log('Plaid not configured - add keys to .env to enable live bank connections');
  }

  // ── Core sync logic ───────────────────────────────────────────────────
  async function syncItem(connection) {
    const { access_token, institution_name } = connection;

    const accountsResp = await plaidClient.accountsGet({ access_token });
    const plaidAccounts = accountsResp.data.accounts.map(a => ({
      id: a.account_id,
      name: a.name,
      officialName: a.official_name,
      type: a.type,
      subtype: a.subtype,
      balance: a.balances.current,
      availableBalance: a.balances.available,
      institution: institution_name,
      last4: a.mask,
      currency: a.balances.iso_currency_code,
      source: 'plaid',
      lastUpdated: new Date().toISOString()
    }));

    const existingAccounts = readData('accounts.json') || [];
    writeData('accounts.json', [
      ...existingAccounts.filter(a => a.source !== 'plaid' || !plaidAccounts.find(p => p.id === a.id)),
      ...plaidAccounts
    ]);

    // Transactions may not be ready immediately after a new item is created
    let txCount = 0;
    try {
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const txResp = await plaidClient.transactionsGet({
        access_token,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500 }
      });

      const plaidTxs = txResp.data.transactions.map(t => {
        const plaidPrimary = t.personal_finance_category?.primary || t.category?.[0] || '';
        const amount = -t.amount; // Plaid positive = debit; flip so expenses are negative
        const category = amount > 0
          ? 'Income'
          : (PLAID_CAT_MAP[plaidPrimary] || 'Other');
        const [y, m] = t.date.split('-');
        return {
          id: t.transaction_id,
          date: t.date,
          month: `${y}-${m}`,
          desc: t.merchant_name || t.name,
          amount,
          category,
          plaidCategory: plaidPrimary,
          account: t.account_id,
          institution: institution_name,
          pending: t.pending,
          source: 'plaid',
          lastUpdated: new Date().toISOString()
        };
      });

      const existingTxs = readData('transactions.json') || [];
      writeData('transactions.json', [
        ...existingTxs.filter(t => t.source !== 'plaid' || !plaidTxs.find(p => p.id === t.id)),
        ...plaidTxs
      ]);
      txCount = plaidTxs.length;
    } catch (e) {
      if (e.response?.data?.error_code === 'PRODUCT_NOT_READY') {
        console.log(`[${institution_name}] Transactions initializing — will be ready shortly`);
      } else {
        throw e;
      }
    }

    return { accounts: plaidAccounts.length, transactions: txCount };
  }

  // ── Sync all connected items (called by cron + manual sync button) ────
  async function syncAll() {
    if (!plaidClient) return { skipped: true };
    const connections = readData('connections.json');
    const items = connections.plaid || [];
    if (!items.length) return { synced: 0 };

    const results = [];
    for (const conn of items) {
      try {
        const result = await syncItem(conn);
        results.push({ institution: conn.institution_name, ...result });
      } catch (e) {
        console.error(`Sync error [${conn.institution_name}]:`, e.response?.data || e.message);
        results.push({ institution: conn.institution_name, error: e.message });
      }
    }

    const updated = readData('connections.json');
    updated.plaid = updated.plaid.map(c => ({ ...c, lastSync: new Date().toISOString() }));
    writeData('connections.json', updated);

    notifyClients(); // Push refresh signal to all open browser tabs
    return { synced: results.length, results };
  }

  // ── Create Link Token ─────────────────────────────────────────────────
  router.post('/create-link-token', async (req, res) => {
    if (!plaidClient) {
      return res.status(400).json({ error: 'Plaid not configured. Add your API keys to .env' });
    }
    try {
      const tokenRequest = {
        user: { client_user_id: 'caishen-user' },
        client_name: 'CaiShen',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      };
      // Attach webhook URL if configured (requires a public HTTPS URL — use ngrok for local dev)
      if (process.env.PLAID_WEBHOOK_URL) {
        tokenRequest.webhook = process.env.PLAID_WEBHOOK_URL;
      }
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
    try {
      const response = await plaidClient.itemPublicTokenExchange({ public_token });
      const { access_token, item_id } = response.data;

      const connections = readData('connections.json');
      const existing = connections.plaid.findIndex(c => c.item_id === item_id);
      const connection = {
        item_id,
        access_token,
        institution_name: institution_name || 'Unknown Bank',
        connectedAt: new Date().toISOString(),
        lastSync: null
      };
      if (existing >= 0) {
        connections.plaid[existing] = connection;
      } else {
        connections.plaid.push(connection);
      }
      writeData('connections.json', connections);

      res.json({ success: true, institution: institution_name });

      // Sync in background — transactions may not be ready immediately
      syncItem(connection)
        .catch(e => console.error('Initial sync error:', e.response?.data || e.message));
    } catch (e) {
      console.error('Token exchange error:', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error_message || e.message });
    }
  });

  // ── Get connected institutions ────────────────────────────────────────
  router.get('/connections', (req, res) => {
    const connections = readData('connections.json');
    const safe = (connections.plaid || []).map(c => ({
      item_id: c.item_id,
      institution_name: c.institution_name,
      connectedAt: c.connectedAt,
      lastSync: c.lastSync
    }));
    res.json(safe);
  });

  // ── Manual sync all ───────────────────────────────────────────────────
  router.post('/sync', async (req, res) => {
    if (!plaidClient) return res.status(400).json({ error: 'Plaid not configured' });
    try {
      const result = await syncAll();
      res.json(result);
    } catch (e) {
      console.error('Manual sync error:', e.response?.data || e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Webhook handler ───────────────────────────────────────────────────
  // Plaid calls this URL in real-time when transactions change or statements arrive.
  // Requires PLAID_WEBHOOK_URL in .env pointing to a public HTTPS URL (use ngrok for local dev).
  // ngrok setup: ngrok http 3001  →  copy https URL  →  set PLAID_WEBHOOK_URL=https://xxxx.ngrok.io/api/plaid/webhook
  router.post('/webhook', async (req, res) => {
    res.json({ received: true }); // Acknowledge immediately so Plaid doesn't retry

    const { webhook_type, webhook_code, item_id } = req.body;
    console.log(`[Webhook] ${webhook_type}/${webhook_code} for item ${item_id}`);

    if (webhook_type === 'TRANSACTIONS') {
      // Fires when new transactions are available or a statement closes
      const connections = readData('connections.json');
      const conn = (connections.plaid || []).find(c => c.item_id === item_id);
      if (conn) {
        console.log(`[Webhook] Syncing ${conn.institution_name}...`);
        syncItem(conn)
          .then(r => {
            console.log(`[Webhook] Done — ${r.accounts} accounts, ${r.transactions} transactions`);
            const updated = readData('connections.json');
            const idx = updated.plaid.findIndex(c => c.item_id === item_id);
            if (idx >= 0) {
              updated.plaid[idx].lastSync = new Date().toISOString();
              writeData('connections.json', updated);
            }
            notifyClients();
          })
          .catch(e => console.error(`[Webhook] Sync error:`, e.response?.data || e.message));
      }
    }
  });

  // ── Remove connection ─────────────────────────────────────────────────
  router.delete('/connections/:itemId', async (req, res) => {
    const connections = readData('connections.json');
    const conn = connections.plaid.find(c => c.item_id === req.params.itemId);
    if (conn && plaidClient) {
      try { await plaidClient.itemRemove({ access_token: conn.access_token }); } catch(e) {}
    }
    connections.plaid = connections.plaid.filter(c => c.item_id !== req.params.itemId);
    writeData('connections.json', connections);
    res.json({ success: true });
  });

  return { router, syncAll };
};
