/**
 * bank-scraper.js
 * Opens a real browser, lets the user log in + handle MFA,
 * then automatically downloads every statement PDF into the vault.
 */

const { chromium } = require('playwright');
const express       = require('express');
const path          = require('path');
const fs            = require('fs');

// ── In-memory session store ───────────────────────────────────────────
const sessions = {};  // sessionId → { status, log[], downloaded[], error }

// ── Bank definitions ─────────────────────────────────────────────────
// Each entry describes how to detect login and scrape statements.
// Selectors are kept in one place so they're easy to update if a bank
// changes their page structure.
const BANKS = {
  chase: {
    label:    'Chase',
    loginUrl: 'https://www.chase.com',

    isLoggedIn: (url) =>
      url.includes('chase.com/digital') && !url.includes('sign-in') && !url.includes('logon'),

    statementsUrl: 'https://www.chase.com/digital/documents/statements',

    // Returns an array of { label, selector } year-tab strategies
    yearTabSelectors: [
      '[data-testid*="year"]',
      'button[role="tab"]',
      '.year-tab',
      'a[role="tab"]',
    ],

    // Selectors tried in order to find individual download buttons
    downloadButtonSelectors: [
      '[data-testid*="download"]',
      'button[aria-label*="Download"]',
      'a[aria-label*="Download"]',
      'button:has-text("Download")',
      'a:has-text("Download")',
      '[class*="download"]:not([class*="disabled"])',
    ],

    // Optional: if the page has an account switcher before statements
    accountDropdownSelector: '[data-testid*="account-selector"], select[name*="account"]',
  },

  bofa: {
    label:    'Bank of America',
    loginUrl: 'https://www.bankofamerica.com',

    isLoggedIn: (url) =>
      url.includes('bankofamerica.com/myaccounts') ||
      url.includes('bankofamerica.com/online-banking'),

    statementsUrl: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?target=documents',

    yearTabSelectors: ['select[name*="year"]', 'button[role="tab"]', '.year-selector'],

    downloadButtonSelectors: [
      'a[href$=".pdf"]',
      'button:has-text("Download")',
      'a:has-text("Download")',
      '[data-track*="download"]',
    ],

    accountDropdownSelector: 'select[name*="account"], #acctselecteddropdown',
  },

  wellsfargo: {
    label:    'Wells Fargo',
    loginUrl: 'https://www.wellsfargo.com',

    isLoggedIn: (url) =>
      url.includes('wellsfargo.com/jump/') ||
      url.includes('connect.secure.wellsfargo.com'),

    statementsUrl: 'https://connect.secure.wellsfargo.com/auth/login/present?flow=qbo',

    yearTabSelectors: ['[data-testid*="year"]', 'select[name*="year"]'],

    downloadButtonSelectors: [
      'a[href$=".pdf"]',
      'button:has-text("PDF")',
      'a:has-text("Statement")',
    ],

    accountDropdownSelector: 'select[name*="account"]',
  },
};

// ── Core scraper ──────────────────────────────────────────────────────
async function runScraper(sessionId, bankKey, userId, makeIO, BASE_VAULT_DIR) {
  const session = sessions[sessionId];
  const bank    = BANKS[bankKey];
  const io      = makeIO(userId);
  const log     = (msg, type = 'info') => {
    console.log(`[scraper:${sessionId}] ${msg}`);
    session.log.push({ type, msg, ts: Date.now() });
  };

  const vaultDir  = path.join(BASE_VAULT_DIR, 'users', userId);
  const stmtDir   = path.join(vaultDir, 'Bank Statements', bank.label);
  fs.mkdirSync(stmtDir, { recursive: true });

  // Detect headless server environment (Linux without a display)
  const isHeadlessServer = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (isHeadlessServer) {
    session.status = 'error';
    session.error  = 'This feature requires running CaiShen locally on your own computer — it cannot open a browser window on a remote server. Download the CaiShen server, run it locally with `npm start`, and access it at http://localhost:3001.';
    log(session.error, 'error');
    return;
  }

  let browser, context;
  try {
    browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext({
      acceptDownloads: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // ── Step 1: Open login page ──────────────────────────────────────
    log(`Opening ${bank.label} login page…`);
    await page.goto(bank.loginUrl, { waitUntil: 'domcontentloaded' });

    session.status = 'waiting_login';
    log('Waiting for you to log in (including any MFA)…', 'prompt');

    // Poll until logged-in URL is detected (up to 10 minutes)
    let loggedIn = false;
    for (let i = 0; i < 600; i++) {
      if (session.status === 'cancelled') { await browser.close(); return; }
      await page.waitForTimeout(1000);
      if (bank.isLoggedIn(page.url())) { loggedIn = true; break; }
    }
    if (!loggedIn) throw new Error('Login timeout — browser closed without detecting a successful login.');

    log('✓ Login detected. Navigating to Statements & Documents…');
    session.status = 'scraping';

    // ── Step 2: Navigate to statements page ──────────────────────────
    await page.goto(bank.statementsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // ── Step 3: Discover accounts (if the bank has a switcher) ───────
    const accountsToProcess = await discoverAccounts(page, bank, log);

    // ── Step 4: For each account, download all available statements ───
    for (const acct of accountsToProcess) {
      if (session.status === 'cancelled') break;
      await downloadStatementsForAccount(page, bank, acct, stmtDir, session, io, vaultDir, log);
    }

    log(`Done. ${session.downloaded.length} PDFs saved to vault.`, 'done');
    session.status = 'done';

  } catch (err) {
    log(`Error: ${err.message}`, 'error');
    session.status  = 'error';
    session.error   = err.message;
  } finally {
    try { await browser?.close(); } catch {}
  }

  // Persist updated vault meta
  try { await finaliseVaultMeta(io, vaultDir, bank.label, session.downloaded, log); }
  catch (e) { log(`Vault update warning: ${e.message}`, 'warn'); }
}

// ── Discover accounts on the statements page ──────────────────────────
async function discoverAccounts(page, bank, log) {
  // Try to find an account dropdown/selector
  const dropdownEl = await page.$(bank.accountDropdownSelector || '__none__').catch(() => null);
  if (dropdownEl) {
    const options = await dropdownEl.evaluate(el => {
      if (el.tagName === 'SELECT') return Array.from(el.options).map(o => ({ value: o.value, label: o.text.trim() }));
      return [];
    });
    if (options.length > 0) {
      log(`Found ${options.length} account(s) to process.`);
      return options;
    }
  }
  // Default: single account on this page
  return [{ value: null, label: 'Primary Account' }];
}

// ── Download all statement PDFs for one account ───────────────────────
async function downloadStatementsForAccount(page, bank, acct, stmtDir, session, io, vaultDir, log) {
  if (acct.value) {
    log(`Switching to account: ${acct.label}`);
    const sel = await page.$(bank.accountDropdownSelector).catch(() => null);
    if (sel) await sel.selectOption(acct.value).catch(() => {});
    await page.waitForTimeout(2000);
  }

  log(`Scanning statements for ${acct.label}…`);

  // Try clicking year tabs to expose older statements
  const yearTabsSeen = new Set();
  for (const tabSel of bank.yearTabSelectors) {
    const tabs = await page.$$(tabSel).catch(() => []);
    for (const tab of tabs) {
      const text = (await tab.textContent().catch(() => '')).trim();
      if (/^\d{4}$/.test(text) && !yearTabsSeen.has(text)) {
        yearTabsSeen.add(text);
        log(`  → Opening year ${text}`);
        await tab.click().catch(() => {});
        await page.waitForTimeout(1500);
        await downloadVisibleStatements(page, bank, acct.label, stmtDir, session, log);
      }
    }
  }

  // Also grab whatever is currently visible (covers single-page layouts)
  await downloadVisibleStatements(page, bank, acct.label, stmtDir, session, log);
}

// ── Click every download button currently visible and save the PDF ────
async function downloadVisibleStatements(page, bank, acctLabel, stmtDir, session, log) {
  let buttons = [];
  for (const sel of bank.downloadButtonSelectors) {
    const found = await page.$$(sel).catch(() => []);
    if (found.length > 0) { buttons = found; break; }
  }

  if (buttons.length === 0) {
    // Fallback: look for any link ending in .pdf
    buttons = await page.$$('a[href$=".pdf"]').catch(() => []);
  }

  log(`  Found ${buttons.length} download button(s) on this view.`);

  for (const btn of buttons) {
    if (session.status === 'cancelled') return;

    const label = (await btn.textContent().catch(() => '')).trim() || 'statement';

    try {
      // Intercept the download
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        btn.click(),
      ]);

      const suggested = download.suggestedFilename() || `${acctLabel}_${label}_${Date.now()}.pdf`;
      // Sanitise filename
      const safe = suggested.replace(/[<>:"/\\|?*]/g, '').trim() || `statement_${Date.now()}.pdf`;
      const dest  = path.join(stmtDir, safe);

      await download.saveAs(dest);
      session.downloaded.push({ path: dest, name: safe, account: acctLabel });
      log(`  ✓ Saved: ${safe}`);

    } catch (e) {
      // Some "download" buttons open a new tab instead — handle that
      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null),
        btn.click().catch(() => {}),
      ]);
      if (newPage) {
        await newPage.waitForLoadState('domcontentloaded').catch(() => {});
        const pdfUrl = newPage.url();
        if (pdfUrl.includes('.pdf') || pdfUrl.includes('download')) {
          const safe = `${acctLabel}_${Date.now()}.pdf`;
          const dest  = path.join(stmtDir, safe);
          const body  = await newPage.evaluate(() => {
            // Try to get PDF buffer via fetch
            return fetch(window.location.href).then(r => r.arrayBuffer()).then(b => Array.from(new Uint8Array(b)));
          }).catch(() => null);
          if (body) {
            fs.writeFileSync(dest, Buffer.from(body));
            session.downloaded.push({ path: dest, name: safe, account: acctLabel });
            log(`  ✓ Saved (new-tab): ${safe}`);
          }
        }
        await newPage.close().catch(() => {});
      }
    }
  }
}

// ── Update vault.json with all downloaded PDFs ────────────────────────
async function finaliseVaultMeta(io, vaultDir, bankLabel, downloaded, log) {
  if (!downloaded.length) return;

  const meta = io.read('vault.json') || { folders: [], files: [] };
  const mkFolderId = () => `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const mkFileId   = () => `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const ensureFolder = (folderPath) => {
    const parts = folderPath.split('/').filter(Boolean);
    let parentId = null;
    for (let i = 0; i < parts.length; i++) {
      const fullPath = parts.slice(0, i + 1).join('/');
      let f = meta.folders.find(x => x.path === fullPath);
      if (!f) {
        f = { id: mkFolderId(), name: parts[i], path: fullPath, parentId, createdAt: new Date().toISOString(), tags: {} };
        meta.folders.push(f);
        fs.mkdirSync(path.join(vaultDir, fullPath), { recursive: true });
      }
      parentId = f.id;
    }
    return parentId;
  };

  for (const dl of downloaded) {
    const rel        = path.relative(vaultDir, dl.path).replace(/\\/g, '/');
    const folderPath = rel.split('/').slice(0, -1).join('/');
    const fileName   = path.basename(dl.path);
    const folderId   = ensureFolder(folderPath);

    // Skip if already registered
    if (meta.files.find(f => f.folderId === folderId && f.name === fileName)) continue;

    const stat = fs.statSync(dl.path);
    meta.files.push({
      id: mkFileId(), name: fileName, folderId, folderPath,
      size: stat.size, type: 'pdf', mimeType: 'application/pdf',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      version: 1, tags: { institution: bankLabel, account: dl.account },
    });
    log(`  Registered in vault: ${fileName}`);
  }

  io.write('vault.json', meta);
}

// ── Express router ────────────────────────────────────────────────────
module.exports = function (makeIO, BASE_VAULT_DIR) {
  const router = express.Router();

  // Start a scraping session
  router.post('/start', (req, res) => {
    const { bank = 'chase' } = req.body;
    if (!BANKS[bank]) return res.status(400).json({ error: `Unsupported bank: ${bank}` });

    const sessionId = `scrape_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    sessions[sessionId] = { status: 'starting', log: [], downloaded: [], error: null };

    runScraper(sessionId, bank, req.user.id, makeIO, BASE_VAULT_DIR);

    res.json({ sessionId });
  });

  // SSE progress stream
  router.get('/progress/:sessionId', (req, res) => {
    const session = sessions[req.params.sessionId];
    if (!session) return res.status(404).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let sent = 0;
    const flush = () => {
      const next = session.log.slice(sent);
      next.forEach(evt => res.write(`data: ${JSON.stringify(evt)}\n\n`));
      sent += next.length;

      if (session.status === 'done' || session.status === 'error' || session.status === 'cancelled') {
        res.write(`data: ${JSON.stringify({ type: 'end', status: session.status, count: session.downloaded.length, error: session.error })}\n\n`);
        clearInterval(timer);
        res.end();
      }
    };
    const timer = setInterval(flush, 500);
    req.on('close', () => clearInterval(timer));
    flush();
  });

  // Cancel a session
  router.post('/cancel/:sessionId', (req, res) => {
    const session = sessions[req.params.sessionId];
    if (session) session.status = 'cancelled';
    res.json({ ok: true });
  });

  // List supported banks
  router.get('/banks', (req, res) => {
    res.json(Object.entries(BANKS).map(([id, b]) => ({ id, label: b.label })));
  });

  return router;
};
