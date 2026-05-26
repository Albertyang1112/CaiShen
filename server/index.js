require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const cron    = require('node-cron');
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Static client files ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client-dist')));

// ── Directory setup ───────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, '../data');
const USERS_DIR  = path.join(__dirname, '../data/users');   // per-user data lives here
const BACKUP_DIR = path.join(__dirname, '../backups');
const VAULT_DIR  = path.join(__dirname, '../vault');

[DATA_DIR, USERS_DIR, BACKUP_DIR, VAULT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// Default content for each per-user file
const defaultUserFiles = {
  'accounts.json':          [],
  'transactions.json':      [],
  'properties.json':        [],
  'tax_years.json':         [],
  'connections.json':       { plaid: [], quickbooks: null },
  'insights.json':          { insights: [], generatedAt: null },
  'chart_of_accounts.json': [],
  'invoices.json':          [],
  'bills.json':             [],
  'vendors.json':           [],
  'journal_entries.json':   [],
  'vault.json':             { folders: [], files: [] },
  'crypto_txns.json':       [],
  'wallets.json':           [],
  'memory.json':            {},
};

// Global files (not per-user)
const defaultGlobalFiles = {
  'users.json': [],
  'settings.json': {
    autoSyncInterval: parseInt(process.env.AUTO_SYNC_INTERVAL) || 60,
    theme: 'dark',
    masterPasswordSet: false
  }
};
Object.entries(defaultGlobalFiles).forEach(([file, defaultVal]) => {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, JSON.stringify(defaultVal, null, 2));
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Create default data files for a new user */
function ensureUserDataDir(userId) {
  const dir = path.join(USERS_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(VAULT_DIR, 'users', userId), { recursive: true });
  Object.entries(defaultUserFiles).forEach(([file, defaultVal]) => {
    const fp = path.join(dir, file);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, JSON.stringify(defaultVal, null, 2));
  });
}

/** Read a file — userId=null reads from global DATA_DIR */
function readData(file, userId = null) {
  const dir = userId ? path.join(USERS_DIR, userId) : DATA_DIR;
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
  catch (e) { return null; }
}

/** Write a file with auto-backup */
function writeData(file, data, userId = null) {
  const dir    = userId ? path.join(USERS_DIR, userId) : DATA_DIR;
  const bakDir = userId ? path.join(BACKUP_DIR, 'users', userId) : BACKUP_DIR;
  try {
    fs.mkdirSync(dir,    { recursive: true });
    fs.mkdirSync(bakDir, { recursive: true });
    const src = path.join(dir, file);
    if (fs.existsSync(src)) {
      const ts  = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = path.join(bakDir, `${file}.${ts}.bak`);
      fs.copyFileSync(src, bak);
      const baks = fs.readdirSync(bakDir).filter(f => f.startsWith(file)).sort();
      if (baks.length > 30) baks.slice(0, baks.length - 30).forEach(f => fs.unlinkSync(path.join(bakDir, f)));
    }
    fs.writeFileSync(src, JSON.stringify(data, null, 2));
    return true;
  } catch (e) { console.error(`Error writing ${file}:`, e.message); return false; }
}

/** Returns user-scoped read/write helpers */
function makeIO(userId) {
  return {
    read:  (file) => readData(file, userId),
    write: (file, data) => writeData(file, data, userId)
  };
}

// ── Migrate existing admin data into per-user directory ───────────────
// Runs once: if admin user (id=1) has no per-user dir, copy root data/ files there.
function migrateAdminData() {
  const adminDir = path.join(USERS_DIR, '1');
  if (fs.existsSync(adminDir)) return; // already migrated
  const hasOldData = Object.keys(defaultUserFiles).some(f => fs.existsSync(path.join(DATA_DIR, f)));
  if (!hasOldData) return;
  console.log('[Migration] Moving existing data → data/users/1/ ...');
  fs.mkdirSync(adminDir, { recursive: true });
  fs.mkdirSync(path.join(VAULT_DIR, 'users', '1'), { recursive: true });
  Object.keys(defaultUserFiles).forEach(f => {
    const src = path.join(DATA_DIR, f);
    const dst = path.join(adminDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  });
  // Migrate vault files and metadata
  const oldVaultMeta = path.join(DATA_DIR, 'vault.json');
  if (fs.existsSync(oldVaultMeta)) {
    const dst = path.join(adminDir, 'vault.json');
    if (!fs.existsSync(dst)) fs.copyFileSync(oldVaultMeta, dst);
  }
  // Copy physical vault files to users/1/ (everything except _deleted)
  const oldVaultDir = VAULT_DIR;
  const newVaultDir = path.join(VAULT_DIR, 'users', '1');
  try {
    const entries = fs.readdirSync(oldVaultDir);
    for (const entry of entries) {
      if (entry === 'users' || entry === '_deleted') continue;
      const src = path.join(oldVaultDir, entry);
      const dst = path.join(newVaultDir, entry);
      if (!fs.existsSync(dst)) {
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, dst, { recursive: true });
        } else {
          fs.copyFileSync(src, dst);
        }
      }
    }
  } catch (e) { console.error('[Migration] Vault copy error:', e.message); }
  console.log('[Migration] Done — admin data available at data/users/1/');
}
migrateAdminData();

// ── Async startup (DB init → auth → routes → listen) ─────────────────
(async () => {
  // 1. Connect to database and create schema
  const { initSchema } = require('./db');
  await initSchema();

  // 2. Auth (now backed by DB, not users.json)
  const authMod = require('./auth');
  const { router: authRouter, verifyToken, requireAdmin } = authMod();
  await authMod.ensureDefaultAdmin(readData); // migrates users.json → DB on first run
  app.use('/api/auth', authRouter);

  // 3. Protect all /api routes (except the open ones)
  app.use('/api', (req, res, next) => {
    const open = ['/auth/login', '/auth/signup', '/auth/verify-2fa', '/auth/me', '/status', '/plaid/webhook', '/events'];
    if (open.some(p => req.path === p || req.path.startsWith(p))) return next();
    verifyToken(req, res, (err) => {
      if (err) return;
      ensureUserDataDir(req.user.id);
      next();
    });
  });

// ── Routes: Global data (no userId) ──────────────────────────────────
app.get('/api/settings', (req, res) => res.json(readData('settings.json')));

// ── Routes: User-scoped data ──────────────────────────────────────────
app.get('/api/accounts',    (req, res) => res.json(readData('accounts.json', req.user?.id)));
app.post('/api/accounts', (req, res) => {
  const uid = req.user.id;
  const accounts = readData('accounts.json', uid) || [];
  const account = {
    id:          `manual_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
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
app.patch('/api/accounts/:id', (req, res) => {
  const uid = req.user.id;
  const accounts = readData('accounts.json', uid) || [];
  const idx = accounts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  accounts[idx] = { ...accounts[idx], ...req.body, lastUpdated: new Date().toISOString() };
  writeData('accounts.json', accounts, uid);
  res.json(accounts[idx]);
});
app.delete('/api/accounts/:id', (req, res) => {
  const uid = req.user.id;
  const accounts = readData('accounts.json', uid) || [];
  if (!accounts.find(a => a.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
  writeData('accounts.json', accounts.filter(a => a.id !== req.params.id), uid);
  res.json({ success: true });
});
app.get('/api/transactions', (req, res) => res.json(readData('transactions.json', req.user?.id)));
app.get('/api/properties',  (req, res) => res.json(readData('properties.json', req.user?.id)));
app.get('/api/tax-years',   (req, res) => res.json(readData('tax_years.json', req.user?.id)));

app.post('/api/properties', (req, res) => {
  const uid  = req.user.id;
  const props = readData('properties.json', uid) || [];
  const newProp = { id: Date.now().toString(), ...req.body };
  props.push(newProp);
  writeData('properties.json', props, uid);
  res.json(newProp);
});
app.put('/api/properties/:id', (req, res) => {
  const uid  = req.user.id;
  const props = readData('properties.json', uid) || [];
  const idx  = props.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  props[idx] = { ...props[idx], ...req.body };
  writeData('properties.json', props, uid);
  res.json(props[idx]);
});
app.delete('/api/properties/:id', (req, res) => {
  const uid = req.user.id;
  writeData('properties.json', (readData('properties.json', uid) || []).filter(p => p.id !== req.params.id), uid);
  res.json({ success: true });
});

// ── Routes: Transactions CRUD ─────────────────────────────────────────
app.post('/api/transactions', (req, res) => {
  const uid  = req.user.id;
  const txs  = readData('transactions.json', uid) || [];
  const newTx = { id: `manual_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, ...req.body, source: req.body.source || 'manual', createdAt: new Date().toISOString() };
  txs.push(newTx);
  writeData('transactions.json', txs, uid);
  res.json(newTx);
});
app.patch('/api/transactions/:id', (req, res) => {
  const uid = req.user.id;
  const txs = readData('transactions.json', uid) || [];
  const idx = txs.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  txs[idx] = { ...txs[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeData('transactions.json', txs, uid);
  res.json(txs[idx]);
});
app.delete('/api/transactions/:id', (req, res) => {
  const uid = req.user.id;
  const txs = readData('transactions.json', uid) || [];
  if (!txs.find(t => t.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
  writeData('transactions.json', txs.filter(t => t.id !== req.params.id), uid);
  res.json({ success: true });
});

// ── Routes: Vault (per-user) ──────────────────────────────────────────
app.use('/api/vault', require('./vault')(VAULT_DIR, makeIO));

// ── Server-Sent Events ────────────────────────────────────────────────
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
function notifyClients() {
  for (const c of sseClients) c.write(`data: ${JSON.stringify({ type: 'data-updated' })}\n\n`);
}

// ── Routes: Plaid ─────────────────────────────────────────────────────
const { router: plaidRouter, syncUser: plaidSyncUser } = require('./plaid')(makeIO, notifyClients);
app.use('/api/plaid', plaidRouter);

// ── Routes: Statements ───────────────────────────────────────────────
const { router: stmtRouter, generateForUser } = require('./statements')(makeIO, VAULT_DIR);
app.use('/api/statements', stmtRouter);

// ── Routes: Bank scraper (Playwright-based PDF downloader) ────────────
const scraperRouter = require('./bank-scraper')(makeIO, VAULT_DIR);
app.use('/api/scraper', scraperRouter);

// ── Routes: QuickBooks ────────────────────────────────────────────────
const { authRouter: qbAuth, apiRouter: qbApi } = require('./quickbooks')(makeIO);
app.use('/auth/quickbooks', qbAuth);
app.use('/api/quickbooks', qbApi);

// ── Routes: AI Advisor ────────────────────────────────────────────────
const { router: advisorRouter } = require('./advisor')(makeIO);
app.use('/api/advisor', advisorRouter);

// ── Routes: Accounting ────────────────────────────────────────────────
const { router: accountingRouter } = require('./accounting')(makeIO);
app.use('/api/accounting', accountingRouter);

// ── Routes: Memory ────────────────────────────────────────────────────
const { router: memoryRouter } = require('./memory')(makeIO);
app.use('/api/memory', memoryRouter);

// ── Import preview — dry-run before actual import ─────────────────────
app.post('/api/import-history/preview', (req, res) => {
  const { transactions } = req.body;
  const uid = req.user.id;
  if (!Array.isArray(transactions) || !transactions.length)
    return res.status(400).json({ error: 'No transactions provided' });

  const existing = readData('transactions.json', uid) || [];

  // Build lookup maps
  const exactKeys  = new Set(
    existing.map(t => `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.desc||'').toLowerCase().slice(0,20)}`)
  );
  const descKeyMap = new Map(); // date|desc20 -> existing tx
  for (const t of existing) {
    const k = `${t.date}|${String(t.desc||'').toLowerCase().slice(0,20)}`;
    if (!descKeyMap.has(k)) descKeyMap.set(k, t);
  }

  const exactDuplicates = [], conflicts = [], newTxs = [];
  for (const t of transactions) {
    const eKey = `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.desc||'').toLowerCase().slice(0,20)}`;
    const dKey = `${t.date}|${String(t.desc||'').toLowerCase().slice(0,20)}`;
    if (exactKeys.has(eKey)) {
      exactDuplicates.push(t);
    } else if (descKeyMap.has(dKey)) {
      conflicts.push({ incoming: t, existing: descKeyMap.get(dKey) });
    } else {
      newTxs.push(t);
    }
  }

  res.json({
    new:              newTxs.length,
    duplicates:       exactDuplicates.length,
    conflicts:        conflicts.length,
    conflictDetails:  conflicts.slice(0, 15),
    duplicateDetails: exactDuplicates.slice(0, 10),
  });
});

// ── Import historical CSV transactions ───────────────────────────────
app.post('/api/import-history', (req, res) => {
  const { transactions, accountId } = req.body;
  const uid = req.user.id;
  if (!Array.isArray(transactions) || !transactions.length)
    return res.status(400).json({ error: 'No transactions provided' });

  const accounts = readData('accounts.json', uid) || [];
  const account  = accounts.find(a => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const existing    = readData('transactions.json', uid) || [];
  const existingKeys = new Set(
    existing.map(t => `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.desc||'').toLowerCase().slice(0,20)}`)
  );

  const toAdd = [];
  for (const t of transactions) {
    const key = `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.desc||'').toLowerCase().slice(0,20)}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    const [y, m] = t.date.split('-');
    toAdd.push({
      id: `csv_${t.date}_${String(t.desc||'').replace(/\W/g,'').slice(0,8).toLowerCase()}_${Math.random().toString(36).slice(2,6)}`,
      date: t.date, month: `${y}-${m}`, desc: t.desc || '',
      amount: t.amount, category: t.category || 'Other',
      account: accountId, institution: account.institution,
      pending: false, source: 'csv_import', lastUpdated: new Date().toISOString()
    });
  }

  writeData('transactions.json', [...existing, ...toAdd], uid);
  res.json({ imported: toAdd.length, skipped: transactions.length - toAdd.length });
});

// ── Routes: Tax Years ─────────────────────────────────────────────────
app.post('/api/tax-years', (req, res) => {
  const uid   = req.user.id;
  const years = readData('tax_years.json', uid) || [];
  const entry = { ...req.body, savedAt: new Date().toISOString() };
  const idx   = years.findIndex(y => y.year === entry.year);
  if (idx >= 0) years[idx] = entry; else years.push(entry);
  years.sort((a, b) => b.year - a.year);
  writeData('tax_years.json', years, uid);
  res.json(entry);
});

// ── Routes: Crypto transactions ───────────────────────────────────────
app.get('/api/crypto/transactions', (req, res) => {
  res.json(readData('crypto_txns.json', req.user.id) || []);
});
app.post('/api/crypto/transactions', (req, res) => {
  const uid  = req.user.id;
  const txns = readData('crypto_txns.json', uid) || [];
  const tx   = { ...req.body, id: `ctx_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, createdAt: new Date().toISOString() };
  txns.push(tx);
  writeData('crypto_txns.json', txns, uid);
  res.json(tx);
});
app.patch('/api/crypto/transactions/:id', (req, res) => {
  const uid  = req.user.id;
  const txns = readData('crypto_txns.json', uid) || [];
  const idx  = txns.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  txns[idx] = { ...txns[idx], ...req.body };
  writeData('crypto_txns.json', txns, uid);
  res.json(txns[idx]);
});
app.delete('/api/crypto/transactions/:id', (req, res) => {
  const uid = req.user.id;
  writeData('crypto_txns.json', (readData('crypto_txns.json', uid) || []).filter(t => t.id !== req.params.id), uid);
  res.json({ success: true });
});

// ── Routes: Wallets ───────────────────────────────────────────────────
app.get('/api/wallets', (req, res) => {
  res.json(readData('wallets.json', req.user.id) || []);
});
app.post('/api/wallets', (req, res) => {
  const uid     = req.user.id;
  const wallets = readData('wallets.json', uid) || [];
  const wallet  = { ...req.body, id: `wallet_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, createdAt: new Date().toISOString() };
  wallets.push(wallet);
  writeData('wallets.json', wallets, uid);
  res.json(wallet);
});
app.delete('/api/wallets/:id', (req, res) => {
  const uid = req.user.id;
  writeData('wallets.json', (readData('wallets.json', uid) || []).filter(w => w.id !== req.params.id), uid);
  res.json({ success: true });
});

// ── On-chain wallet lookup ─────────────────────────────────────────────
function detectChain(addr) {
  const a = addr.trim()
  if (/^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a) || /^bc1[ac-hj-np-z02-9]{6,87}$/i.test(a)) return 'BTC'
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'ETH'
  if (/^[LM][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(a) || /^ltc1[a-z0-9]{6,87}$/i.test(a)) return 'LTC'
  if (/^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/.test(a)) return 'DOGE'
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'SOL'
  return null
}

app.get('/api/wallet-lookup', async (req, res) => {
  const address = (req.query.address || '').trim();
  if (!address) return res.status(400).json({ error: 'Address required' });
  const chain = detectChain(address);
  if (!chain) return res.status(400).json({ error: 'Unrecognized address format. Supported: BTC, ETH, SOL, LTC, DOGE' });
  const ax = require('axios');
  try {
    if (chain === 'BTC') {
      const [infoRes, txRes] = await Promise.all([
        ax.get(`https://blockstream.info/api/address/${address}`),
        ax.get(`https://blockstream.info/api/address/${address}/txs`),
      ]);
      const d = infoRes.data;
      const balance = (d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum) / 1e8;
      const transactions = (txRes.data || []).slice(0, 25).map(tx => {
        const received = (tx.vout || []).filter(o => o.scriptpubkey_address === address).reduce((s, o) => s + (o.value || 0), 0);
        const sent = (tx.vin || []).filter(i => i.prevout?.scriptpubkey_address === address).reduce((s, i) => s + (i.prevout?.value || 0), 0);
        return { hash: tx.txid, date: tx.status.confirmed ? new Date(tx.status.block_time * 1000).toISOString().split('T')[0] : 'Pending', amount: (received - sent) / 1e8, confirmed: tx.status.confirmed };
      });
      return res.json({ chain, address, balance, transactions });
    }

    if (chain === 'ETH') {
      const key = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
      const base = 'https://api.etherscan.io/api';
      const [balRes, txRes] = await Promise.all([
        ax.get(`${base}?module=account&action=balance&address=${address}&apikey=${key}`),
        ax.get(`${base}?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=25&apikey=${key}`),
      ]);
      const balance = parseInt(balRes.data.result || '0') / 1e18;
      const rawTxs = Array.isArray(txRes.data.result) ? txRes.data.result : [];
      const transactions = rawTxs.slice(0, 25).map(tx => {
        const isSend = tx.from.toLowerCase() === address.toLowerCase();
        return { hash: tx.hash, date: new Date(parseInt(tx.timeStamp) * 1000).toISOString().split('T')[0], amount: (parseInt(tx.value || '0') / 1e18) * (isSend ? -1 : 1), confirmed: parseInt(tx.confirmations || '0') > 0, from: tx.from, to: tx.to };
      });
      return res.json({ chain, address, balance, transactions });
    }

    if (chain === 'SOL') {
      const rpc = 'https://api.mainnet-beta.solana.com';
      const [balRes, sigRes] = await Promise.all([
        ax.post(rpc, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
        ax.post(rpc, { jsonrpc: '2.0', id: 2, method: 'getSignaturesForAddress', params: [address, { limit: 25 }] }),
      ]);
      const balance = (balRes.data.result?.value || 0) / 1e9;
      const transactions = (sigRes.data.result || []).map(s => ({ hash: s.signature, date: s.blockTime ? new Date(s.blockTime * 1000).toISOString().split('T')[0] : 'Pending', amount: null, confirmed: !s.err }));
      return res.json({ chain, address, balance, transactions });
    }

    if (chain === 'LTC' || chain === 'DOGE') {
      const coin = chain === 'LTC' ? 'ltc' : 'doge';
      const [balRes, txRes] = await Promise.all([
        ax.get(`https://api.blockcypher.com/v1/${coin}/main/addrs/${address}/balance`),
        ax.get(`https://api.blockcypher.com/v1/${coin}/main/addrs/${address}/full?limit=25`),
      ]);
      const balance = (balRes.data.final_balance || 0) / 1e8;
      const transactions = (txRes.data.txs || []).slice(0, 25).map(tx => {
        const received = (tx.outputs || []).filter(o => (o.addresses || []).includes(address)).reduce((s, o) => s + (o.value || 0), 0);
        const sent = (tx.inputs || []).filter(i => (i.addresses || []).includes(address)).reduce((s, i) => s + (i.output_value || 0), 0);
        return { hash: tx.hash, date: tx.received ? tx.received.split('T')[0] : 'Pending', amount: (received - sent) / 1e8, confirmed: (tx.confirmations || 0) > 0 };
      });
      return res.json({ chain, address, balance, transactions });
    }

    res.status(400).json({ error: 'Chain not supported' });
  } catch (e) {
    console.error('Wallet lookup error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error_message || e.message });
  }
});

// ── Routes: Backup & Export ───────────────────────────────────────────
app.get('/api/backup', (req, res) => {
  const uid = req.user.id;
  const backup = { exportedAt: new Date().toISOString(), version: '1.0.0',
    accounts: readData('accounts.json', uid), transactions: readData('transactions.json', uid),
    properties: readData('properties.json', uid), taxYears: readData('tax_years.json', uid),
    settings: readData('settings.json'),
    invoices: readData('invoices.json', uid), bills: readData('bills.json', uid),
    vendors: readData('vendors.json', uid), journalEntries: readData('journal_entries.json', uid),
    chartOfAccounts: readData('chart_of_accounts.json', uid),
    cryptoTransactions: readData('crypto_txns.json', uid),
    wallets: readData('wallets.json', uid),
  };
  res.setHeader('Content-Disposition', `attachment; filename=caishen-backup-${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.json(backup);
});

app.post('/api/restore', (req, res) => {
  const uid = req.user.id;
  const { accounts, transactions, properties, taxYears, settings, invoices, bills, vendors, journalEntries, chartOfAccounts } = req.body;
  if (accounts)        writeData('accounts.json', accounts, uid);
  if (transactions)    writeData('transactions.json', transactions, uid);
  if (properties)      writeData('properties.json', properties, uid);
  if (taxYears)        writeData('tax_years.json', taxYears, uid);
  if (settings)        writeData('settings.json', settings);        // global
  if (invoices)        writeData('invoices.json', invoices, uid);
  if (bills)           writeData('bills.json', bills, uid);
  if (vendors)         writeData('vendors.json', vendors, uid);
  if (journalEntries)  writeData('journal_entries.json', journalEntries, uid);
  if (chartOfAccounts) writeData('chart_of_accounts.json', chartOfAccounts, uid);
  res.json({ success: true, restoredAt: new Date().toISOString() });
});

app.post('/api/parse-statement', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const axios = require('axios');
    const base64 = req.file.buffer.toString('base64');
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-7', max_tokens: 2000,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: 'Extract all transactions from this bank statement. Return ONLY a JSON array with objects: { date: "YYYY-MM-DD", desc: "merchant name", amount: -123.45 }. Negative amounts for expenses, positive for deposits. No markdown, no explanation, just the JSON array.' }
      ]}]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    const text = response.data.content[0].text;
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const transactions = parsed.map((t, i) => {
      const date = new Date(t.date);
      return { id: `pdf_${i}_${Date.now()}`, date: t.date, desc: t.desc, amount: t.amount, category: 'Other', source: 'pdf', month: `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}` };
    });
    res.json({ transactions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pdf-render', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const PDFParser = require('pdf2json');
    const parser = new PDFParser();
    await new Promise((resolve, reject) => {
      parser.on('pdfParser_dataReady', resolve);
      parser.on('pdfParser_dataError', reject);
      parser.parseBuffer(req.file.buffer);
    });
    res.json({ text: parser.getRawTextContent(), pages: parser.data?.Pages?.length || 0 });
  } catch (e) { res.status(500).json({ error: e.message, text: '', pages: 0 }); }
});

// ── Routes: Status (public) ───────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running', version: '1.0.0',
    plaidConfigured:   !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_CLIENT_ID !== 'paste_your_client_id_here'),
    qbConfigured:      !!(process.env.QB_CLIENT_ID && process.env.QB_CLIENT_SECRET && process.env.QB_CLIENT_ID !== 'paste_your_qb_client_id_here' && process.env.QB_CLIENT_SECRET !== 'paste_your_qb_client_secret_here' && process.env.QB_CLIENT_ID.length > 10 && process.env.QB_CLIENT_SECRET.length > 10),
    advisorConfigured: !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here'),
    dataDir: DATA_DIR, uptime: process.uptime()
  });
});

// ── Catch-all ─────────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  const indexPath = path.join(__dirname, '../client-dist/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f1117;color:#fff">
      <h2>CaiShen Server Running ✓</h2><p>Server is up on port ${process.env.PORT || 3001}</p>
      <p><a href="/api/status" style="color:#378ADD">Check API status</a></p>
    </body></html>`);
  }
});

  // ── Auto-sync scheduler (syncs all users with Plaid connections) ────
  const { query: dbQuery } = require('./db');
  const intervalMinutes = parseInt(process.env.AUTO_SYNC_INTERVAL) || 5;
  cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
    const ts = new Date().toLocaleTimeString();
    const { rows: users } = await dbQuery('SELECT id, username FROM users').catch(() => ({ rows: [] }));
    for (const user of users) {
      try {
        const { read } = makeIO(user.id);
        const conns = read('connections.json') || { plaid: [] };
        if (!(conns.plaid || []).length) continue;
        const result = await plaidSyncUser(user.id).catch(e => ({ error: e.message }));
        if (result.skipped || result.error) continue;
        for (const r of result.results || []) {
          if (r.error) console.log(`[${ts}] ${user.username}/${r.institution}: error — ${r.error}`);
          else console.log(`[${ts}] ${user.username}/${r.institution}: ${r.accounts} accounts, ${r.transactions} txs`);
        }
        await generateForUser(user.id).catch(e => console.error(`[${ts}] Statements error:`, e.message));
      } catch (e) { console.error(`[${ts}] Cron error for ${user.username}:`, e.message); }
    }
  });

  // ── Start ───────────────────────────────────────────────────────────
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`\n✓ CaiShen server running at http://localhost:${PORT}`);
    console.log(`✓ Data directory: ${DATA_DIR}`);
    console.log(`✓ Auto-sync every ${intervalMinutes} minutes`);
    console.log(`\nOpen http://localhost:${PORT} in your browser\n`);
    try { require('open')(`http://localhost:${PORT}`); } catch(e) {}
  });

})().catch(e => {
  console.error('\n✗ Fatal startup error:', e.message);
  process.exit(1);
});
