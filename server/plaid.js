const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
const express = require('express');

module.exports = function(readData, writeData) {
  const router = express.Router();

  // Only initialize Plaid if keys are configured
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

  // ── Create Link Token (starts the Plaid OAuth flow) ──────────────────
  router.post('/create-link-token', async (req, res) => {
    if (!plaidClient) {
      return res.status(400).json({ error: 'Plaid not configured. Add your API keys to .env' });
    }
    try {
      const response = await plaidClient.linkTokenCreate({
        user: { client_user_id: 'caishen-user' },
        client_name: 'CaiShen',
        products: ['transactions', 'balances', 'investments'],
        country_codes: ['US'],
        language: 'en',
      });
      res.json({ link_token: response.data.link_token });
    } catch (e) {
      console.error('Plaid link token error:', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error_message || e.message });
    }
  });

  // ── Exchange public token for access token ────────────────────────────
  router.post('/exchange-token', async (req, res) => {
    if (!plaidClient) return res.status(400).json({ error: 'Plaid not configured' });
    const { public_token, institution_name } = req.body;
    try {
      const response = await plaidClient.itemPublicTokenExchange({ public_token });
      const { access_token, item_id } = response.data;

      // Save connection locally (encrypted in production — stored plaintext for now)
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

      // Immediately fetch accounts and transactions
      await syncPlaidItem(plaidClient, connection, readData, writeData);

      res.json({ success: true, institution: institution_name });
    } catch (e) {
      console.error('Token exchange error:', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error_message || e.message });
    }
  });

  // ── Get connected institutions ────────────────────────────────────────
  router.get('/connections', (req, res) => {
    const connections = readData('connections.json');
    // Strip access tokens from response
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
    const connections = readData('connections.json');
    const results = [];
    for (const conn of connections.plaid || []) {
      try {
        const result = await syncPlaidItem(plaidClient, conn, readData, writeData);
        results.push({ institution: conn.institution_name, ...result });
      } catch (e) {
        results.push({ institution: conn.institution_name, error: e.message });
      }
    }
    // Update lastSync timestamps
    const updated = readData('connections.json');
    updated.plaid = updated.plaid.map(c => ({ ...c, lastSync: new Date().toISOString() }));
    writeData('connections.json', updated);
    res.json({ synced: results.length, results });
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

  return router;
};

// ── Sync helper ───────────────────────────────────────────────────────
async function syncPlaidItem(plaidClient, connection, readData, writeData) {
  const { access_token, institution_name } = connection;

  // Fetch accounts
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

  // Merge into accounts.json
  const existingAccounts = readData('accounts.json') || [];
  const merged = [...existingAccounts.filter(a => a.source !== 'plaid' || !plaidAccounts.find(p => p.id === a.id)), ...plaidAccounts];
  writeData('accounts.json', merged);

  // Fetch transactions (last 90 days)
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const txResp = await plaidClient.transactionsGet({
    access_token,
    start_date: startDate,
    end_date: endDate,
    options: { count: 500 }
  });

  const plaidTxs = txResp.data.transactions.map(t => ({
    id: t.transaction_id,
    date: t.date,
    desc: t.merchant_name || t.name,
    amount: -t.amount, // Plaid uses positive for debits; flip for display
    category: t.personal_finance_category?.primary || (t.category?.[0] || 'Uncategorized'),
    subcategory: t.personal_finance_category?.detailed || (t.category?.[1] || ''),
    account: t.account_id,
    institution: institution_name,
    pending: t.pending,
    source: 'plaid',
    lastUpdated: new Date().toISOString()
  }));

  // Merge transactions
  const existingTxs = readData('transactions.json') || [];
  const mergedTxs = [...existingTxs.filter(t => t.source !== 'plaid' || !plaidTxs.find(p => p.id === t.id)), ...plaidTxs];
  writeData('transactions.json', mergedTxs);

  return {
    accounts: plaidAccounts.length,
    transactions: plaidTxs.length
  };
}