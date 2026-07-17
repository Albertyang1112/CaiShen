// ── Silence dotenvx injection banner ─────────────────────────────────────
// Filter stdout before dotenv loads so the "◇ injected env" line never prints
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function(data, ...rest) {
  const s = typeof data === 'string' ? data : data.toString();
  if (s.includes('injected env') || s.includes('dotenvx.com') || s.includes('tip:')) return true;
  return _origStdoutWrite(data, ...rest);
};
process.env.DOTENV_QUIET = 'true';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
// Dev-only override: a gitignored .env.local (if present) wins — e.g. a local
// DATABASE_URL pointing at local Postgres. Absent in production, so Neon is used there.
require('dotenv').config({ path: require('path').join(__dirname, '../.env.local'), override: true });
// Restore stdout (let the tee stream take over below)
process.stdout.write = _origStdoutWrite;

// ── Filter raw stderr to suppress the pg SSL-mode deprecation block ───────
const _origStderrWrite = process.stderr.write.bind(process.stderr);
let   _skipUntilBlank  = false;
process.stderr.write = function(data, ...rest) {
  const s = typeof data === 'string' ? data : data.toString();
  if (s.includes('SSL modes') || s.includes('pg-connection-string') || s.includes('uselibpqcompat')) {
    _skipUntilBlank = true; return true;
  }
  if (_skipUntilBlank) {
    if (s.trim() === '') { _skipUntilBlank = false; } return true;
  }
  return _origStderrWrite(data, ...rest);
};

// ── Tee console output to server/logs/server.log ─────────────────────────
const _path      = require('path');
const _fs        = require('fs');
const _logDir    = _path.join(__dirname, 'logs');
_fs.mkdirSync(_logDir, { recursive: true });
const _logStream = _fs.createWriteStream(_path.join(_logDir, 'server.log'), { flags: 'a' });
const _ts        = () => new Date().toISOString().slice(0,19).replace('T',' ');
const _write     = (...args) => _logStream.write(`[${_ts()}] ${args.join(' ')}\n`);
const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origErr   = console.error.bind(console);
console.log   = (...a) => { _origLog(...a);  _write(...a); };
console.warn  = (...a) => { _origWarn(...a); _write('[WARN]', ...a); };
console.error = (...a) => { _origErr(...a);  _write('[ERR]',  ...a); };

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const cron    = require('node-cron');
// (multer now lives in the route modules that need it — core/pdf-routes.js, etc.)

const app = express();
app.use(cors());
// Capture the raw body too — the Plaid webhook signature is checked against its SHA-256.
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

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
  'tx_overrides.json':      {},   // per-tx user edits: { [txId]: {category,excluded,vendor,attachments} }
  'properties.json':        [],
  'tax_years.json':         [],
  'connections.json':       { plaid: [], quickbooks: null },
  'insights.json':          { insights: [], generatedAt: null },
  'chart_of_accounts.json': [],
  'invoices.json':          [],
  'bills.json':             [],
  'vendors.json':           [],
  'journal_entries.json':   [],
  'categorization_rules.json': [],   // auto-categorization rules: [{ id, field, op, value, coaId, enabled }]
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

const dataStore = require('./core/store');   // DB-backed per-user data layer (cache + persist)

/** Read per-user data from the DB store (cache); global (no userId) config from file. */
function readData(file, userId = null) {
  if (userId) return dataStore.read(file, userId);
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch (e) { return null; }
}

/** Write per-user data to the DB (no local file); global config to file. */
function writeData(file, data, userId = null) {
  if (userId) return dataStore.write(file, data, userId);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); return true; }
  catch (e) { console.error(`Error writing ${file}:`, e.message); return false; }
}

/** User-scoped read/write helpers. `dir` is kept for genuine file artifacts
 *  (receipts/vault PDFs) until those move to R2; JSON/CSV go through the DB store. */
function makeIO(userId) {
  const dir = userId ? path.join(USERS_DIR, userId) : DATA_DIR;
  return {
    read:  (file) => readData(file, userId),
    write: (file, data) => writeData(file, data, userId),
    dir,
    readText:  (file) => userId
      ? dataStore.readText(file, userId)
      : (() => { try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch (e) { return null; } })(),
    writeText: (file, text) => userId
      ? dataStore.writeText(file, text, userId)
      : (fs.mkdirSync(dir, { recursive: true }), fs.writeFileSync(path.join(dir, file), text), true),
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
  const { initSchema } = require('./core/db');
  await initSchema();

  // 1b. Warm the DB-backed per-user data layer (cache) before serving requests.
  await dataStore.preloadAll();

  // 2. Auth (now backed by DB, not users.json)
  const authMod = require('./core/auth');
  const { router: authRouter, verifyToken, requireAdmin } = authMod();
  await authMod.ensureDefaultAdmin(readData); // migrates users.json → DB on first run
  app.use('/api/auth', authRouter);

  // 3. Protect all /api routes (except the open ones)
  app.use('/api', (req, res, next) => {
    const open = ['/auth/login', '/auth/signup', '/auth/verify-2fa', '/auth/me', '/status', '/plaid/webhook', '/events', '/messaging/twilio/webhook'];
    // Exact match or a true sub-path (p + '/') — never a prefix like '/statusX' that would bypass auth.
    if (open.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
    verifyToken(req, res, (err) => {
      if (err) return;
      ensureUserDataDir(req.user.id);
      next();
    });
  });

  // 3a. Dev Assistant capture (LOCALHOST-ONLY, no-op off localhost). Records a
  // summary of every /api request+response into the dev-log ring buffer so the
  // Dev Assistant can answer "what did the backend just see when I did X?".
  // Mounted here — after auth (req.user populated), before the routes — so its
  // res.on('finish') hook sees fully-parsed multipart uploads (req.files).
  app.use('/api', require('./dev/dev-capture'));

// ── Routes: Global data (no userId) ──────────────────────────────────
app.get('/api/settings', (req, res) => res.json(readData('settings.json')));

// ── Routes: Banking (accounts, transactions, overrides, categorization) ──
// Extracted to banking/routes.js — see that file for the Banking page's API.
app.use('/api', require('./banking/routes')({ readData, writeData }));

// ── Routes: Properties (real estate) + tax-years — extracted to core/user-routes.js ──
app.use('/api', require('./core/user-routes')(makeIO));

// ── Routes: Vault (per-user) ──────────────────────────────────────────
app.use('/api/vault', require('./vault')(VAULT_DIR, makeIO));

// ── Localhost-only middleware (bank scraper) ──────────────────────────
// Blocks access from any origin that isn't the user's own machine.
// This ensures the scraper tab never appears or functions on mycaishen.ai.
function localhostOnly(req, res, next) {
  const h = req.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return next();
  return res.status(403).json({ error: 'This feature is only available when running CaiShen locally.' });
}

// ── Routes: Bank Scraper (localhost only) ─────────────────────────────
// Guarded require: bank-scraper.js is an optional local-only module that may
// not be present in every checkout. Skip-mount it when absent so the server
// still boots; behavior is identical to before when the real file is present.
if (fs.existsSync(path.join(__dirname, 'scrapers', 'bank-scraper.js'))) {
  app.use('/api/scraper', localhostOnly, require('./scrapers/bank-scraper')(makeIO, VAULT_DIR));
} else {
  console.warn('[scraper] server/bank-scraper.js not found — /api/scraper disabled for this run.');
}

// ── Routes: Imported Python scrapers bridge (localhost only) ──────────
// Guarded so the server still boots if the (gitignored) bridge file is absent.
try {
  app.use('/api/scrapers', localhostOnly, require('./scrapers/scraper-bridge')(makeIO, VAULT_DIR));
  console.log('✓ Scraper bridge loaded (chase, boa, amazon, mortgage)');
} catch (e) {
  console.log('⚠ Scraper bridge not loaded:', e.message);
}

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
const { router: plaidRouter, syncUser: plaidSyncUser } = require('./banking/plaid')(makeIO, notifyClients);
app.use('/api/plaid', plaidRouter);

// ── Statements: upload-only ──────────────────────────────────────────
// CaiShen no longer generates statement PDFs. All statements come from the
// user via Data Vault upload. The /api/statements generator was removed.

// ── Routes: Reconciliation (Phase 3) ─────────────────────────────────
app.use('/api/reconcile', require('./banking/reconcile-routes')(makeIO));

// ── Routes: Mortgage domain (read-only; written during scraper import) ──
app.use('/api/mortgage', require('./banking/mortgage-routes')(makeIO));

// ── Routes: Insurance domain + tax payment schedule (read-only; written by the
// vault/chatbot ingestion hooks) ──────────────────────────────────────────────
app.use('/api/insurance', require('./banking/insurance-routes')(makeIO));
app.use('/api/tax-schedule', require('./tax/schedule').router());

// ── Routes: Real-estate helpers — new-address suggestions from mortgage/insurance docs ──
app.use('/api/re', require('./banking/re-suggest')(makeIO));
// DEV-ONLY reconciliation verification (localhost only). These two files are gitignored, so a
// fresh clone/deploy may not have them — guard the require so the server still boots (mirrors
// the bank-scraper guard). Delete the file to remove the route.
if (fs.existsSync(_path.join(__dirname, 'banking', 'dev-verify.js'))) {
  app.use('/api/dev-verify', localhostOnly, require('./banking/dev-verify')(makeIO));
}

// ── Routes: Receipts / OCR (Phase 4) ─────────────────────────────────
app.use('/api/receipts', require('./banking/receipt-routes')(makeIO, DATA_DIR));

// ── Routes: Messaging (Discord/SMS categorizer linking) ───────────────
// Public Twilio inbound webhook (form-encoded, no JWT — verified by signature in the handler).
// Registered before the JWT-protected router so it matches first.
app.post('/api/messaging/twilio/webhook',
  express.urlencoded({ extended: false }),
  (req, res) => require('./banking/messaging-bot').twilioWebhook(req, res));
app.use('/api/messaging', require('./banking/messaging-routes')(makeIO));

// ── Routes: QuickBooks ────────────────────────────────────────────────
const { authRouter: qbAuth, apiRouter: qbApi } = require('./accounting/quickbooks')(makeIO);
app.use('/auth/quickbooks', qbAuth);
app.use('/api/quickbooks', qbApi);

// ── Routes: AI Advisor ────────────────────────────────────────────────
const { router: advisorRouter } = require('./advisor')(makeIO);
app.use('/api/advisor', advisorRouter);

// ── Routes: Dev Assistant (LOCALHOST-ONLY) ────────────────────────────
// Debugging chatbot that can describe what the frontend page and the backend
// just saw (reads the dev-log ring buffer populated by dev-capture above).
// Gated by localhostOnly so it never activates on prod.
app.use('/api/dev-chat', localhostOnly, require('./dev/dev-chat')());

// ── Routes: Accounting ────────────────────────────────────────────────
const { router: accountingRouter } = require('./accounting')(makeIO);
app.use('/api/accounting', accountingRouter);

// ── Routes: Memory ────────────────────────────────────────────────────
const { router: memoryRouter } = require('./core/memory')(makeIO);
app.use('/api/memory', memoryRouter);

// ── Routes: Tax Center ────────────────────────────────────────────────
app.use('/api/taxes', require('./tax/taxes')(makeIO, VAULT_DIR));

// ── Routes: Tax Calculation Engine ───────────────────────────────────
const { makeRouter: makeTaxEngineRouter } = require('./tax/engine');
app.use('/api/tax-engine', makeTaxEngineRouter());

// ── Routes: Tax History, Transactions, AI Session Log ────────────────
const taxHistoryMod = require('./tax/history');
app.use('/api/tax-history',      taxHistoryMod.makeCalculationsRouter());
app.use('/api/tax-transactions', taxHistoryMod.makeTransactionsRouter());
app.use('/api/ai-sessions',      taxHistoryMod.makeAISessionsRouter());

// ── Routes: RAG Tax-Law Retrieval ────────────────────────────────────
const { makeRouter: makeRagRouter } = require('./tax/rag');
app.use('/api/rag', makeRagRouter());

// ── Routes: Tax Advisor (RAG + engine + guardrails + audit) ──────────
const { makeRouter: makeTaxAdvisorRouter } = require('./tax/advisor');
app.use('/api/tax-advisor', makeTaxAdvisorRouter());

// ── Routes: Tax Normalization (transactions → categories → TaxInput) ──
const { makeRouter: makeTaxNormalizeRouter } = require('./tax/normalize');
app.use('/api/tax-normalize', makeTaxNormalizeRouter(makeIO));

// ── Routes extracted to modules: backup/restore + import-history(+preview), tax-estimate,
// crypto txns + wallets + wallet-lookup. crypto-wallet is mounted BEFORE the crypto report
// router below so /api/crypto/transactions resolves to the CRUD router. ──
app.use('/api', require('./core/backup-routes')({ readData, writeData }));
// Spreadsheet import (QuickBooks exports & clearly-labeled generic sheets): parsed fully
// in memory — the files are never stored, only extracted data + a sha256 batch record.
app.use('/api', require('./imports/routes')(makeIO, notifyClients));
app.use('/api', require('./tax/estimate-routes')(makeIO));
app.use('/api', require('./crypto/wallet-routes')(makeIO));

// ── Routes: Crypto tax report (read-only; cost-basis engine parity) ───
// Adds GET /api/crypto/report and /report/download only. The Crypto tab does not call these
// yet — they exist so the ported engine can be verified against the Python reference first.
app.use('/api/crypto', require('./crypto')(makeIO));

// ── Routes extracted to core/pdf-routes.js: parse-statement (Claude Vision), pdf-render ──
app.use('/api', require('./core/pdf-routes')());

// ── Routes: Status (public) ───────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running', version: '1.0.0',
    plaidConfigured:   !/^(1|true|yes)$/i.test(process.env.PLAID_DISABLED || '') && !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_CLIENT_ID !== 'paste_your_client_id_here'),
    plaidDisabled:     /^(1|true|yes)$/i.test(process.env.PLAID_DISABLED || ''),
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
  const { query: dbQuery } = require('./core/db');
  const intervalMinutes = parseInt(process.env.AUTO_SYNC_INTERVAL) || 5;
  cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
    const ts = new Date().toLocaleTimeString();
    const { rows: users } = await dbQuery('SELECT id, username FROM users').catch(() => ({ rows: [] }));
    for (const user of users) {
      try {
        // Plaid connections live in the DB (plaid_items), not connections.json.
        // syncUser is self-gating: {skipped} when Plaid is off, {synced:0} when this
        // user has no connections — so no stale-file precheck is needed (the old
        // `connections.json` gate was always empty after connections moved to the DB,
        // which silently disabled auto-sync for everyone).
        const result = await plaidSyncUser(user.id).catch(e => ({ error: e.message }));
        if (result.skipped || result.error) continue;
        for (const r of result.results || []) {
          if (r.error) console.log(`[${ts}] ${user.username}/${r.institution}: error — ${r.error}`);
          else console.log(`[${ts}] ${user.username}/${r.institution}: ${r.accounts} accounts, ${r.transactions} txs`);
        }
        // Statements are upload-only — CaiShen never auto-generates them.
      } catch (e) { console.error(`[${ts}] Cron error for ${user.username}:`, e.message); }
    }
  });

  // Categorizer bot (in-process, single-instance via a DB advisory lock so two server processes
  // can never both connect a Discord bot). Decoupled from the HTTP listener on purpose.
  try { require('./banking/messaging-bot').start({ makeIO, query: require('./core/db').query }); }
  catch (e) { console.error('[bot] start error:', e.message); }

  // ── Start ───────────────────────────────────────────────────────────
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, async () => {
    console.log(`\n✓ CaiShen server running at http://localhost:${PORT}`);
    console.log(`✓ Data directory: ${DATA_DIR}`);
    console.log(`✓ Auto-sync every ${intervalMinutes} minutes`);
    console.log(`\nOpen http://localhost:${PORT} in your browser\n`);
    try { require('open')(`http://localhost:${PORT}`); } catch(e) {}

    // Run startup verification for all existing users
    const { verifyUser } = require('./core/verify');
    try {
      const users = fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR) : [];
      for (const uid of users) {
        const io = makeIO(uid);
        const accts = await require('./core/banking-store').listAccounts(uid) || [];
        if (accts.length > 0) await verifyUser(uid, io);
      }
    } catch (e) { console.error('[Verify] Startup check error:', e.message); }
  });

})().catch(e => {
  console.error('\n✗ Fatal startup error:', e.message);
  process.exit(1);
});

// Drain any in-flight DB writes on graceful shutdown so no buffered write is lost.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { await require('./banking/messaging-bot').stop(); } catch (e) { /* best effort */ }
    try { await dataStore.flush(); } catch (e) { /* best effort */ }
    process.exit(0);
  });
}
