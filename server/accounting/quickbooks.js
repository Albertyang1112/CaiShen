const express = require('express');
const OAuthClient = require('intuit-oauth');
const axios = require('axios');

module.exports = function(makeIO) {
  const authRouter = express.Router();
  const apiRouter  = express.Router();

  // Inject per-user IO into apiRouter handlers
  apiRouter.use((req, res, next) => {
    const { read, write } = makeIO(req.user.id);
    req.read = read; req.write = write;
    next();
  });

  const qbConfigured = process.env.QB_CLIENT_ID &&
    process.env.QB_CLIENT_ID !== 'paste_your_qb_client_id_here';

  let oauthClient = null;
  if (qbConfigured) {
    oauthClient = new OAuthClient({
      clientId:     process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      environment:  'production',
      redirectUri:  process.env.QB_REDIRECT_URI,
    });
    console.log('✓ QuickBooks OAuth client initialized');
  } else {
    console.log('⚠ QuickBooks not configured — add keys to .env to enable');
  }

  // ── Step 1: Redirect user to QuickBooks login ─────────────────────────
  authRouter.get('/connect', (req, res) => {
    if (!oauthClient) return res.status(400).json({ error: 'QuickBooks not configured' });
    const authUri = oauthClient.authorizeUri({
      scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
      state: `caishen-qb-${req.user.id}`
    });
    res.redirect(authUri);
  });

  // ── Step 2: Handle OAuth callback (no user JWT — userId in state) ─────
  authRouter.get('/callback', async (req, res) => {
    if (!oauthClient) return res.status(400).send('QuickBooks not configured');
    try {
      const state  = req.query.state || '';
      const userId = state.startsWith('caishen-qb-') ? state.slice('caishen-qb-'.length) : '1';
      const io     = makeIO(userId);

      const authResponse = await oauthClient.createToken(req.url);
      const token = oauthClient.getToken();
      const connections = io.read('connections.json') || { plaid: [] };
      connections.quickbooks = {
        access_token:  token.access_token,
        refresh_token: token.refresh_token,
        realm_id:      req.query.realmId,
        connectedAt:   new Date().toISOString(),
        lastSync:      null
      };
      io.write('connections.json', connections);

      await syncQuickBooks(oauthClient, connections.quickbooks, io);

      res.redirect('http://localhost:5173/?qb=connected');
    } catch (e) {
      console.error('QB callback error:', e.message);
      res.redirect('http://localhost:5173/?qb=error');
    }
  });

  // ── Get QB connection status ──────────────────────────────────────────
  apiRouter.get('/status', (req, res) => {
    const connections = req.read('connections.json') || { plaid: [] };
    if (!connections.quickbooks) return res.json({ connected: false });
    res.json({
      connected:   true,
      connectedAt: connections.quickbooks.connectedAt,
      lastSync:    connections.quickbooks.lastSync,
      realmId:     connections.quickbooks.realm_id
    });
  });

  // ── Manual sync ───────────────────────────────────────────────────────
  apiRouter.post('/sync', async (req, res) => {
    if (!oauthClient) return res.status(400).json({ error: 'QuickBooks not configured' });
    const connections = req.read('connections.json') || { plaid: [] };
    if (!connections.quickbooks) return res.status(400).json({ error: 'QuickBooks not connected' });
    try {
      oauthClient.setToken(connections.quickbooks);
      if (oauthClient.isAccessTokenValid() === false) {
        const refreshed = await oauthClient.refresh();
        connections.quickbooks = { ...connections.quickbooks, ...refreshed.getToken() };
        req.write('connections.json', connections);
      }
      const result = await syncQuickBooks(oauthClient, connections.quickbooks, { read: req.read, write: req.write });
      connections.quickbooks.lastSync = new Date().toISOString();
      req.write('connections.json', connections);
      res.json({ success: true, ...result });
    } catch (e) {
      console.error('QB sync error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  apiRouter.post('/disconnect', (req, res) => {
    const connections = req.read('connections.json') || { plaid: [] };
    connections.quickbooks = null;
    req.write('connections.json', connections);
    res.json({ success: true });
  });

  return { authRouter, apiRouter };
};

// ── QB Sync helper ────────────────────────────────────────────────────
async function syncQuickBooks(oauthClient, qbConn, io) {
  const { read, write } = io;
  const { realm_id } = qbConn;
  const baseUrl = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;
  const headers = { Authorization: `Bearer ${qbConn.access_token}`, Accept: 'application/json' };

  const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const query = `SELECT * FROM Purchase WHERE TxnDate >= '${startDate}' MAXRESULTS 1000`;

  const txResp = await axios.get(`${baseUrl}/query?query=${encodeURIComponent(query)}`, { headers });
  const purchases = txResp.data?.QueryResponse?.Purchase || [];

  const qbTxs = purchases.map(p => ({
    id:          `qb_${p.Id}`,
    date:        p.TxnDate,
    desc:        p.EntityRef?.name || p.PrivateNote || 'QuickBooks Transaction',
    amount:      -Math.abs(p.TotalAmt),
    category:    p.AccountRef?.name || 'Business Expense',
    account:     p.AccountRef?.name || 'QuickBooks',
    source:      'quickbooks',
    docNumber:   p.DocNumber,
    lastUpdated: new Date().toISOString()
  }));

  const plResp = await axios.get(
    `${baseUrl}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${new Date().toISOString().split('T')[0]}`,
    { headers }
  ).catch(() => ({ data: null }));

  const existingTxs = read('transactions.json') || [];
  write('transactions.json', [
    ...existingTxs.filter(t => t.source !== 'quickbooks' || !qbTxs.find(q => q.id === t.id)),
    ...qbTxs
  ]);

  if (plResp.data) {
    const settings = read('settings.json') || {};
    settings.qbLastPL = { data: plResp.data, fetchedAt: new Date().toISOString() };
    write('settings.json', settings);
  }

  return { transactions: qbTxs.length, plReport: !!plResp.data };
}
