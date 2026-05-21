const express = require('express');
const OAuthClient = require('intuit-oauth');

module.exports = function(readData, writeData) {
  const router = express.Router();

  const qbConfigured = process.env.QB_CLIENT_ID &&
    process.env.QB_CLIENT_ID !== 'paste_your_qb_client_id_here';

  let oauthClient = null;
  if (qbConfigured) {
    oauthClient = new OAuthClient({
      clientId: process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      environment: 'production',
      redirectUri: process.env.QB_REDIRECT_URI,
    });
    console.log('✓ QuickBooks OAuth client initialized');
  } else {
    console.log('⚠ QuickBooks not configured — add keys to .env to enable');
  }

  // ── Step 1: Redirect user to QuickBooks login ─────────────────────────
  router.get('/connect', (req, res) => {
    if (!oauthClient) return res.status(400).json({ error: 'QuickBooks not configured' });
    const authUri = oauthClient.authorizeUri({
      scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
      state: 'caishen-qb-auth'
    });
    res.redirect(authUri);
  });

  // ── Step 2: Handle OAuth callback ────────────────────────────────────
  router.get('/callback', async (req, res) => {
    if (!oauthClient) return res.status(400).send('QuickBooks not configured');
    try {
      const authResponse = await oauthClient.createToken(req.url);
      const token = oauthClient.getToken();
      const connections = readData('connections.json');
      connections.quickbooks = {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        realm_id: req.query.realmId,
        connectedAt: new Date().toISOString(),
        lastSync: null
      };
      writeData('connections.json', connections);

      // Immediately do first sync
      await syncQuickBooks(oauthClient, connections.quickbooks, readData, writeData);

      res.redirect('http://localhost:3001/?qb=connected');
    } catch (e) {
      console.error('QB callback error:', e.message);
      res.redirect('http://localhost:3001/?qb=error');
    }
  });

  // ── Get QB connection status ──────────────────────────────────────────
  router.get('/status', (req, res) => {
    const connections = readData('connections.json');
    if (!connections.quickbooks) return res.json({ connected: false });
    res.json({
      connected: true,
      connectedAt: connections.quickbooks.connectedAt,
      lastSync: connections.quickbooks.lastSync,
      realmId: connections.quickbooks.realm_id
    });
  });

  // ── Manual sync ───────────────────────────────────────────────────────
  router.post('/sync', async (req, res) => {
    if (!oauthClient) return res.status(400).json({ error: 'QuickBooks not configured' });
    const connections = readData('connections.json');
    if (!connections.quickbooks) return res.status(400).json({ error: 'QuickBooks not connected' });
    try {
      oauthClient.setToken(connections.quickbooks);
      // Refresh token if needed
      if (oauthClient.isAccessTokenValid() === false) {
        const refreshed = await oauthClient.refresh();
        connections.quickbooks = { ...connections.quickbooks, ...refreshed.getToken() };
        writeData('connections.json', connections);
      }
      const result = await syncQuickBooks(oauthClient, connections.quickbooks, readData, writeData);
      connections.quickbooks.lastSync = new Date().toISOString();
      writeData('connections.json', connections);
      res.json({ success: true, ...result });
    } catch (e) {
      console.error('QB sync error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  router.post('/disconnect', (req, res) => {
    const connections = readData('connections.json');
    connections.quickbooks = null;
    writeData('connections.json', connections);
    res.json({ success: true });
  });

  return router;
};

// ── QB Sync helper ────────────────────────────────────────────────────
async function syncQuickBooks(oauthClient, qbConn, readData, writeData) {
  const { realm_id } = qbConn;
  const baseUrl = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;
  const headers = { Authorization: `Bearer ${qbConn.access_token}`, Accept: 'application/json' };
  const axios = require('axios');

  // Fetch transactions (last 365 days)
  const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const query = `SELECT * FROM Purchase WHERE TxnDate >= '${startDate}' MAXRESULTS 1000`;

  const txResp = await axios.get(`${baseUrl}/query?query=${encodeURIComponent(query)}`, { headers });
  const purchases = txResp.data?.QueryResponse?.Purchase || [];

  const qbTxs = purchases.map(p => ({
    id: `qb_${p.Id}`,
    date: p.TxnDate,
    desc: p.EntityRef?.name || p.PrivateNote || 'QuickBooks Transaction',
    amount: -Math.abs(p.TotalAmt),
    category: p.AccountRef?.name || 'Business Expense',
    account: p.AccountRef?.name || 'QuickBooks',
    source: 'quickbooks',
    docNumber: p.DocNumber,
    lastUpdated: new Date().toISOString()
  }));

  // Also fetch P&L report
  const plResp = await axios.get(
    `${baseUrl}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${new Date().toISOString().split('T')[0]}`,
    { headers }
  ).catch(() => ({ data: null }));

  // Merge QB transactions
  const existingTxs = readData('transactions.json') || [];
  const merged = [...existingTxs.filter(t => t.source !== 'quickbooks' || !qbTxs.find(q => q.id === t.id)), ...qbTxs];
  writeData('transactions.json', merged);

  // Store QB summary
  if (plResp.data) {
    const settings = readData('settings.json') || {};
    settings.qbLastPL = { data: plResp.data, fetchedAt: new Date().toISOString() };
    writeData('settings.json', settings);
  }

  return { transactions: qbTxs.length, plReport: !!plResp.data };
}