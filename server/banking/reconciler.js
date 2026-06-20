'use strict';
/**
 * Phase 3 — Statement Reconciliation Engine
 *
 * parseStatement(buffer, filename)
 *   → [{date:'YYYY-MM-DD', amount:Number, desc:String}]
 *   Supports PDF (via pdf-parser) and CSV (Chase, BofA, generic column-detect).
 *
 * mirrorStatement(query, userId, rows, sourceFile)
 *   Upserts parsed rows into source_transactions (source='statement').
 *   Returns count of rows inserted.
 *
 * reconcileUser(query, userId, io, year?)
 *   Matches statement rows vs Plaid transactions loaded via io, in three passes:
 *   manual links → EXACT (same day + exact amount, unique on both sides — no name
 *   needed) → fuzzy fallback (±$0.01, ±4 days, shared name token or learned alias).
 *   Writes results to statement_matches atomically (clears old run for that
 *   user/year first). Returns { matched, stmtOnly, plaidOnly, conflicts }.
 *
 * getStatus(query, userId)
 *   Returns { stats:{matched,stmt_only,plaid_only,conflict}, files:[{source_file,period_year}] }.
 */

const crypto = require('crypto');
// PDF transactions are parsed in a CHILD PROCESS (pdf-parse-worker.js) for fresh
// pdf2json state per file — see parsePDFInWorker below. No in-process parse here:
// parsing many statements back-to-back in one process bleeds pdf2json's global
// state and returns 0 rows ~20% of the time.
// extractStatementMeta is used ONLY to classify a 0-transaction result (genuine
// no-activity month vs. a real parse miss) — that path is reached only for files
// the worker found no transactions in, i.e. real bank PDFs, never generated ones.
const { extractStatementMeta } = require('../core/pdf-parser');
const { findOrCreatePeriod } = require('./periods');

// ── Text normalisation for name similarity ────────────────────────────────────
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(t => t.length >= 3 && !/^\d+$/.test(t));

function nameSim(a, b) {
  const ta = new Set(toks(a)), tb = new Set(toks(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

const dDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

// ── CSV parser — handles Chase, BofA, and generic date/desc/amount layouts ───
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (lines.length < 2) return [];

  // Minimal CSV splitter that respects quoted fields
  const splitRow = line => {
    const out = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out.map(c => c.replace(/^"|"$/g, '').trim());
  };

  const headers = splitRow(lines[0]).map(h => h.toLowerCase());

  // Find column indices
  const col = (...names) => names.reduce((found, n) => found >= 0 ? found : headers.findIndex(h => h === n || h.includes(n)), -1);
  const dateIdx   = col('transaction date', 'posted date', 'date', 'post date');
  const descIdx   = col('description', 'desc', 'payee', 'merchant', 'narrative', 'memo');
  const amtIdx    = col('amount');
  const debitIdx  = col('debit', 'withdrawal', 'charge', 'money out');
  const creditIdx = col('credit', 'deposit', 'money in');

  if (dateIdx < 0 || descIdx < 0) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const get = idx => (idx >= 0 && idx < cells.length) ? cells[idx] : '';

    // Parse date — handles MM/DD/YYYY, YYYY-MM-DD, MM-DD-YYYY
    const dateRaw = get(dateIdx);
    let dateStr = null;
    const m1 = dateRaw.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
    const m2 = dateRaw.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/);
    if (m1) dateStr = `${m1[3]}-${m1[1].padStart(2,'0')}-${m1[2].padStart(2,'0')}`;
    else if (m2) dateStr = `${m2[1]}-${m2[2].padStart(2,'0')}-${m2[3].padStart(2,'0')}`;
    if (!dateStr || isNaN(new Date(dateStr).getTime())) continue;

    const desc = get(descIdx);
    if (!desc) continue;

    // Parse amount — single column or split debit/credit
    let amount = null;
    if (amtIdx >= 0) {
      const raw = get(amtIdx).replace(/[$,\s]/g, '');
      if (raw !== '') amount = parseFloat(raw);
    } else if (debitIdx >= 0 || creditIdx >= 0) {
      const d = parseFloat(get(debitIdx).replace(/[$,]/g, '') || '0');
      const c = parseFloat(get(creditIdx).replace(/[$,]/g, '') || '0');
      if (!isNaN(d) && d !== 0) amount = d;         // debit → positive (money out)
      else if (!isNaN(c) && c !== 0) amount = -c;   // credit → negative (money in)
    }
    if (amount === null || isNaN(amount)) continue;

    rows.push({ date: dateStr, desc, amount });
  }
  return rows;
}

// ── pdftotext fallback — for PDFs with XRef issues that pdf2json can't handle ─
async function parsePDFWithPdftotext(buffer, year) {
  const { execFile } = require('child_process');
  const os   = require('os');
  const fs2  = require('fs');
  const tmp  = require('path').join(os.tmpdir(), `caishen_stmt_${Date.now()}.pdf`);
  fs2.writeFileSync(tmp, buffer);
  try {
    const text = await new Promise((resolve, reject) => {
      execFile('pdftotext', ['-layout', tmp, '-'], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => { err ? reject(err) : resolve(stdout); });
    });
    return parsePdftotextLines(text, year);
  } finally {
    try { fs2.unlinkSync(tmp); } catch {}
  }
}

function parsePdftotextLines(text, year) {
  const rows = [];
  // Both CaiShen-generated and real Chase PDFs use MM/DD/YY or MM/DD/YYYY at line start.
  // Format: DATE  DESCRIPTION   [CATEGORY]   AMOUNT   [TYPE]
  // Columns are separated by 2+ spaces in -layout mode.
  const DATE_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s{2,}/;

  for (const line of text.split('\n')) {
    const dm = line.match(DATE_RE);
    if (!dm) continue;

    // Parse date — supports MM/DD/YY and MM/DD/YYYY
    const [rawM, rawD, rawY] = dm[1].split('/');
    const fullYear = rawY.length === 2 ? '20' + rawY : rawY;
    const dateStr  = `${fullYear}-${rawM.padStart(2,'0')}-${rawD.padStart(2,'0')}`;

    // Find the first dollar amount in the rest of the line
    const rest     = line.slice(dm[0].length);
    const amtMatch = rest.match(/(-?\$[\d,]+\.?\d*)/);
    if (!amtMatch) continue;
    const amtRaw   = amtMatch[1].replace(/[$,]/g, '');
    const amount   = Math.abs(parseFloat(amtRaw));  // always positive; reconciler uses Math.abs anyway
    if (isNaN(amount) || amount === 0) continue;

    // Description = text right after the date, up to first 2+-space gap (where category starts)
    const descMatch = rest.match(/^(.+?)(?:\s{2,}|\s*$)/);
    const desc      = (descMatch ? descMatch[1] : rest).trim();
    if (!desc) continue;

    rows.push({ date: dateStr, desc, amount });
  }
  return rows;
}

// ── PDF parse via child process — fresh pdf2json state per file ───────────────
// pdf2json keeps MODULE-LEVEL global state, so parsing many statements back-to-back
// in one process bleeds data between files and intermittently returns 0 rows (the
// documented bug in pdf-parser.js). The vault already isolates each parse in a child
// process (pdf-parse-worker.js); the reconciler now does too. That worker reads a
// FILE path, so we stage the buffer to a temp file (exactly as parsePDFWithPdftotext
// does), run the worker, and clean up. Resolves to the parsed rows (possibly []),
// or rejects on spawn failure / 30s timeout (a genuine hang) / bad worker output.
const PDF_WORKER_PATH = require('path').join(__dirname, '..', 'vault', 'pdf-parse-worker.js');
let _reconTmpSeq = 0;
function parsePDFInWorker(buffer, year, month) {
  const { execFile } = require('child_process');
  const os    = require('os');
  const fs2   = require('fs');
  const path2 = require('path');
  const tmp   = path2.join(os.tmpdir(), `caishen_recon_${process.pid}_${_reconTmpSeq++}.pdf`);
  fs2.writeFileSync(tmp, buffer);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [PDF_WORKER_PATH, tmp, String(year || ''), String(month || '')],
      { cwd: path2.dirname(PDF_WORKER_PATH), timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        try { fs2.unlinkSync(tmp); } catch {}
        if (err) return reject(err);
        // pdf2json prints "Warning: Setting up fake worker." before the JSON line;
        // take the last line that starts with '{' (matches the /verify route).
        const line = String(stdout).split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop() || '{}';
        let out;
        try { out = JSON.parse(line); }
        catch (e) { return reject(new Error('worker output not JSON: ' + e.message)); }
        if (out.error) return reject(new Error(out.error));
        resolve(out.transactions || []);
      }
    );
  });
}

// ── Main parse dispatcher ─────────────────────────────────────────────────────
async function parseStatement(buffer, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return parseCSV(buffer.toString('utf8'));

  // PDF path — parse in a child process (fresh pdf2json state). Validation gate:
  // a clean parse should return rows; if it returns 0 or errors, retry ONCE in a
  // second fresh process, then fall back to pdftotext, then report unparsed ([]).
  const yearMatch  = (filename || '').match(/20\d{2}/);
  const year       = yearMatch ? yearMatch[0] : String(new Date().getFullYear());
  const monthMatch = (filename || '').match(/Statement\s+([A-Za-z]{3})/i);   // "9092 Statement May 2026.pdf"
  const month      = monthMatch ? (STMT_MON[monthMatch[1].toLowerCase()] || '') : '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const rows = await parsePDFInWorker(buffer, year, month);
      if (rows.length > 0) return rows;
      console.warn(`[reconciler] worker returned 0 rows (attempt ${attempt}/2) for "${filename}"`);
    } catch (e) {
      console.warn(`[reconciler] worker parse failed (attempt ${attempt}/2) for "${filename}":`, e.message || String(e));
    }
  }

  // Fallback: pdftotext (separate binary; handles XRef variants pdf2json can't —
  // but isn't installed on every machine, so it's a last resort, not the primary).
  console.warn(`[reconciler] falling back to pdftotext for "${filename}"`);
  try {
    const rows = await parsePDFWithPdftotext(buffer, year);
    if (rows.length > 0) return rows;
    console.error(`[reconciler] pdftotext also returned 0 rows for "${filename}"`);
  } catch (e2) {
    console.error(`[reconciler] pdftotext fallback failed for "${filename}":`, e2.message);
  }
  return [];
}

// ── Statement classification for ingestion ────────────────────────────────────
// parseStatement returning 0 rows is ambiguous: a dormant account's no-activity
// month legitimately has zero transactions, while a real statement the parser
// choked on ALSO yields zero. Treating both as "failed" cries wolf (most of a long
// history is quiet months). This decides which it is. Returns { rows, kind }:
//   'ok'         — transactions parsed (rows.length > 0)
//   'empty'      — readable statement, NO activity (begin==end balance, no
//                  transaction-detail section): nothing to mirror, NOT a failure
//   'unparsed'   — readable statement WITH activity/detail but 0 rows parsed
//                  (a genuine parser miss → candidate for the Groq fallback)
//   'unreadable' — no extractable text at all (scanned/corrupt → Groq vision)
const STMT_BAL_RE = (label) => new RegExp(label + '\\s+Balance\\s+\\$?([\\d,]+\\.\\d{2})', 'i');
const STMT_DETAIL_RE = /TRANSACTION\s+DETAIL|DEPOSITS\s+AND\s+ADDITIONS|ATM\s*&?\s*DEBIT|ELECTRONIC\s+WITHDRAWAL|CHECKS\s+PAID/i;
// opts.groqFallback (default false): when the deterministic parser misses a PDF that
// clearly HAS activity ('unparsed'), recover it with the Groq text extractor. The
// caller gates this on a per-run budget so a bulk upload can't drain the token cap.
// Result may include method ('parser'|'groq') and groqTried (Groq was attempted).
async function classifyStatement(buffer, filename, { groqFallback = false } = {}) {
  const rows = await parseStatement(buffer, filename);
  if (rows.length > 0) return { rows, kind: 'ok', method: 'parser' };

  // CSV/TXT have no balance summary to corroborate against — a 0-row parse there
  // is a real miss (bad columns / empty file), not a quiet bank month. (The Groq
  // fallback reads PDF text layers, so it can't recover a CSV either.)
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return { rows: [], kind: 'unparsed' };

  let text = '';
  try { text = (await extractStatementMeta(buffer)).text || ''; } catch { /* no text → unreadable below */ }
  if (text.replace(/\s/g, '').length < 50) return { rows: [], kind: 'unreadable' };  // scanned → needs vision, not text Groq

  const begM = text.match(STMT_BAL_RE('Beginning')), endM = text.match(STMT_BAL_RE('Ending'));
  const beg = begM ? begM[1] : null, end = endM ? endM[1] : null;
  const hasDetail = STMT_DETAIL_RE.test(text);
  const txnish = (text.match(/\b\d{1,2}\/\d{1,2}\b[^\n]*\$?\d[\d,]*\.\d{2}/g) || []).length;
  // No-activity month: balances present and equal, no detail section, no txn lines.
  if (beg && end && beg === end && !hasDetail && txnish <= 1) return { rows: [], kind: 'empty' };

  // Genuine miss: the statement HAS activity (text layer present) but the positional
  // parser couldn't read its layout (e.g. a split "- 32.66" sign token). This is the
  // one case the Groq fallback is for — gated by the caller's per-run budget.
  if (groqFallback) {
    try {
      const { extractTransactions } = require('../vault/ai-extract');   // Groq, rate-limited via groq-client
      const year  = (filename || '').match(/20\d{2}/)?.[0];
      const out   = await extractTransactions(buffer, { year });
      const grows = (out.transactions || []).map(t => ({ date: t.date, desc: t.desc, amount: t.amount }));
      if (grows.length > 0) return { rows: grows, kind: 'ok', method: 'groq', groqTried: true };
      console.warn(`[reconciler] groq fallback found no transactions for "${filename}"${out.suspicious ? ' (suspicious — looks like a statement)' : ''}`);
    } catch (e) { console.warn(`[reconciler] groq fallback failed for "${filename}":`, e.message); }
    return { rows: [], kind: 'unparsed', groqTried: true };
  }
  return { rows: [], kind: 'unparsed' };
}

// ── Strip PDF column-noise from Chase/BofA statement descriptions ─────────────
// Chase PDFs concatenate merchant + category + type into one string, e.g.:
//   "Dave's Hot Chicken Dining Debit"  →  "Dave's Hot Chicken"
//   "REMOTE ONLINE DEPOSIT # 1 Income Credit"  →  "REMOTE ONLINE DEPOSIT # 1"
const STMT_SUFFIX_RE = /\s+(Dining|Shopping|Entertainment|Health|Travel|Other|Income|Transfer|ATM)\s+(Debit|Credit|Withdrawal|Deposit)$/i;
function cleanStmtDesc(desc) {
  return (desc || '').replace(STMT_SUFFIX_RE, '').trim();
}

// ── Mirror statement rows into source_transactions ────────────────────────────
// "9092 Statement Apr 2021.pdf" → {last4,month,year}; also "2026-02 NAME Statement.pdf".
const STMT_MON = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
function parseStmtMeta(name) {
  if (!name) return null;
  let m = /(\d{3,4})\s+Statement\s+([A-Za-z]{3,})\s+(\d{4})/i.exec(name);
  if (m) { const mo = STMT_MON[m[2].slice(0, 3).toLowerCase()]; if (mo) return { last4: m[1], month: mo, year: Number(m[3]) }; }
  m = /(20\d{2})-(\d{2})/.exec(name);
  if (m) return { last4: null, month: Number(m[2]), year: Number(m[1]) };
  return null;
}
const pad2s = (n) => String(n).padStart(2, '0');

// Increment 3 (remodel write-flow): besides upserting the parsed rows, resolve the
// statement's account (last4 from filename → accounts.mask; single-account fallback),
// find-or-create its month period, and create/link a typed bank_statements row (to the
// PDF's documents row via opts.documentId when known). Each row then carries account_id,
// the period, the bank_statement, and a content source_hash. Idempotent (deterministic
// ids; COALESCE keeps already-set fields). opts: { documentId }.
async function mirrorStatement(query, userId, rows, sourceFile, opts = {}) {
  const meta = parseStmtMeta(sourceFile);

  // Resolve account: last4 → accounts.mask; else the user's single account (unambiguous).
  const accts = (await query(`SELECT id, mask FROM accounts WHERE user_id=$1`, [userId])).rows;
  let accountId = null;
  if (meta?.last4) { const a = accts.find(x => x.mask === meta.last4); if (a) accountId = a.id; }
  if (!accountId && accts.length === 1) accountId = accts[0].id;
  const last4 = meta?.last4 || accts.find(a => a.id === accountId)?.mask || 'noacct';

  // Period + typed bank_statement for this file (one each), when the file is datable.
  let periodId = null, bankStatementId = null;
  if (meta?.year && meta?.month) {
    const firstOfMonth = `${meta.year}-${pad2s(meta.month)}-01`;
    try { periodId = await findOrCreatePeriod(query, userId, accountId, firstOfMonth); } catch {}
    // Link the PDF's documents row only when it really exists (keeps the FK safe).
    let docId = opts.documentId || null;
    if (docId && !(await query(`SELECT 1 FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId])).rows.length) docId = null;
    bankStatementId = `bstmt_${userId}_${last4}_${meta.year}${pad2s(meta.month)}`;
    const lastDay = new Date(Date.UTC(meta.year, meta.month, 0)).getUTCDate();
    try {
      await query(
        `INSERT INTO bank_statements
           (id,user_id,account_id,bank_account_period_id,document_id,statement_start_date,statement_end_date,parser_status,parsed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'parsed',NOW())
         ON CONFLICT (id) DO UPDATE SET
           account_id=COALESCE(EXCLUDED.account_id, bank_statements.account_id),
           bank_account_period_id=COALESCE(EXCLUDED.bank_account_period_id, bank_statements.bank_account_period_id),
           document_id=COALESCE(EXCLUDED.document_id, bank_statements.document_id),
           parser_status='parsed', updated_at=NOW()`,
        [bankStatementId, userId, accountId, periodId, docId, firstOfMonth, `${meta.year}-${pad2s(meta.month)}-${pad2s(lastDay)}`]
      );
    } catch (e) { bankStatementId = null; }   // never let a statement-record hiccup drop the rows
  }

  const year = meta?.year || parseInt((sourceFile || '').match(/20\d{2}/)?.[0] || new Date().getFullYear());
  let inserted = 0;
  for (const row of rows) {
    const cleanDesc = cleanStmtDesc(row.desc);
    // Deterministic ID so re-uploading the same file is idempotent.
    const id = 'stmt_' + crypto.createHash('sha1')
      .update(`${userId}|${sourceFile}|${row.date}|${row.amount}|${cleanDesc}`)
      .digest('hex').slice(0, 20);
    // source_hash includes the file, so it's unique wherever the id is (no dedup-index
    // collision on legit duplicate-looking rows) while still fingerprinting content.
    const sourceHash = crypto.createHash('sha256')
      .update(`${userId}|statement|${sourceFile}|${row.date}|${row.amount}|${cleanDesc}`)
      .digest('hex');

    await query(
      `INSERT INTO source_transactions
         (id, user_id, source, source_file, period_year, account_id, bank_account_period_id,
          bank_statement_id, txn_date, description, merchant_name, amount, source_hash, raw)
       VALUES ($1,$2,'statement',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         account_id=COALESCE(EXCLUDED.account_id, source_transactions.account_id),
         bank_account_period_id=COALESCE(EXCLUDED.bank_account_period_id, source_transactions.bank_account_period_id),
         bank_statement_id=COALESCE(EXCLUDED.bank_statement_id, source_transactions.bank_statement_id),
         source_hash=COALESCE(source_transactions.source_hash, EXCLUDED.source_hash)`,
      [id, userId, sourceFile, year, accountId, periodId, bankStatementId,
       row.date, cleanDesc, cleanDesc, row.amount, sourceHash, JSON.stringify(row)]
    );
    inserted++;
  }
  return inserted;
}

// ── Merchant alias rules ───────────────────────────────────────────────────────
// A learned equivalence: "this Plaid name and this statement name are the same
// merchant" (e.g. Plaid "Walmart" ↔ statement "WM SUPERCENTER"). Learned
// AUTOMATICALLY when the user manually matches a pair whose names share no
// significant token (reconcile-routes POST /match). A hit forces a name match the
// shared-token test would otherwise miss; the amount (±$0.01) and date (±4 days)
// gates still apply, so same-named purchases pair with the correct occurrence.
// Stored per-user in reconcile_aliases.json.
// Apostrophes are stripped (Dave's → daves) so possessives stay one word.
const aliasNorm = s => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function aliasMatch(plaidDesc, stmtDesc, aliases) {
  if (!aliases || !aliases.length) return false;
  // Word-boundary match on normalized text, so "art" never hits "Walmart".
  const pd = ' ' + aliasNorm(plaidDesc) + ' ';
  const sd = ' ' + aliasNorm(stmtDesc)  + ' ';
  for (const a of aliases) {
    if (!a || a.enabled === false) continue;
    const ap = aliasNorm(a.plaid), as = aliasNorm(a.statement);
    if (!ap || !as) continue;
    if (pd.includes(' ' + ap + ' ') && sd.includes(' ' + as + ' ')) return true;
  }
  return false;
}

// Canonical merchant token for auto-learning a rule from a description: the first
// one or two meaningful words, the two-word form kept only when it appears
// contiguously in the text. "WM SUPERCENTER #2403" → "wm supercenter";
// "Steamgames.com 425-952-2985 WA" → "steamgames" ("steamgames wa" isn't contiguous).
const ALIAS_NOISE = new Set(['com', 'co', 'inc', 'llc', 'llp', 'the', 'pos', 'purchase', 'debit', 'credit', 'card', 'payment', 'www']);
function aliasToken(desc) {
  const norm = aliasNorm(desc);
  const words = (norm.match(/[a-z]{2,}/g) || []).filter(w => !ALIAS_NOISE.has(w));
  if (!words.length) return '';
  if (words.length >= 2) {
    const two = words[0] + ' ' + words[1];
    if ((' ' + norm + ' ').includes(' ' + two + ' ')) return two;
  }
  return words[0];
}

// ── Fuzzy best-match finder — the FALLBACK pass ───────────────────────────────
// (amount ±$0.01, date ±4 days, shared name token or alias required). Runs only
// for rows the exact same-day pass in planMatches couldn't settle unambiguously.
function matchOne(s, plaid, used, aliases = []) {
  let best = null, bestScore = -1;
  for (let i = 0; i < plaid.length; i++) {
    if (used.has(i)) continue;
    const p = plaid[i];
    // Use absolute values — sign conventions can differ between Plaid and statements
    if (Math.abs(Math.abs(Number(p.amount)) - Math.abs(Number(s.amount))) > 0.01) continue;
    const dd = dDiff(p.date, s.date);
    if (dd > 4) continue;
    // A user alias rule (Walmart ↔ Wm Supercenter) counts as a definitive name match.
    const alias = aliasMatch(p.desc, s.desc, aliases);
    const sim = alias ? 1 : nameSim(p.desc, s.desc);
    // Confidence gate: require ≥1 shared significant name token (or an alias). Amount+
    // date alone is too weak — common amounts (9.99, 14.99, 3.97…) collide across
    // different merchants inside the ±4-day window (e.g. Walmart $3.97 ↔ "MONTHLY
    // SERVICE FEE" $3.97). No shared name token → leave it for review instead.
    if (sim <= 0) continue;
    const score = sim * 2 + (1 - dd / 5);   // weight name match more than date proximity
    if (score > bestScore) { bestScore = score; best = { i, p, sim, dd, score, alias }; }
  }
  return (best && bestScore >= 0) ? best : null;
}

// ── Match planning (pure — exported for tests) ────────────────────────────────
// Decides which Plaid transaction each statement row pairs with, in three phases
// (each phase completes for ALL rows before the next starts, so a fuzzy guess can
// never steal a transaction an exact pair owns):
//   1. MANUAL — pairs the user drew in the popup (always win).
//   2. EXACT  — same calendar day + exact dollar amount, where that (day, amount)
//      is unique on BOTH sides. The primary check: names play no part, so
//      "Walmart" ↔ "Wm Supercenter" pairs with no teaching needed.
//   3. FUZZY  — the fallback for what's left: several purchases sharing a day+amount,
//      or dates drifting because statements post late. matchOne requires a shared
//      name token or learned alias (amount ±$0.01, date ±4 days, closest date wins).
function planMatches(stmtRows, plaid, { aliases = [], manualPlaidFor = new Map() } = {}) {
  const used = new Set(), matchedPlaidIdx = new Set();
  const take = (i) => { used.add(i); matchedPlaidIdx.add(i); };

  // Exact-pass index. Ambiguity is judged on the ORIGINAL totals per (day, amount)
  // key — not on what's left unconsumed — so results don't depend on row order.
  const exactKey   = (date, amount) => `${date}|${Math.abs(Number(amount)).toFixed(2)}`;
  const plaidByKey = new Map();
  plaid.forEach((p, i) => {
    if (!p.date) return;
    const k = exactKey(p.date, p.amount);
    if (!plaidByKey.has(k)) plaidByKey.set(k, []);
    plaidByKey.get(k).push(i);
  });
  const stmtKeyCount = new Map();
  for (const s of stmtRows) {
    const k = exactKey(s.date, s.amount);
    stmtKeyCount.set(k, (stmtKeyCount.get(k) || 0) + 1);
  }

  const picks = new Array(stmtRows.length).fill(null);   // → { m, manual }

  // Phase 1 — manual links
  stmtRows.forEach((s, si) => {
    const forcedId = manualPlaidFor.get(s.id);
    if (!forcedId) return;
    const idx = plaid.findIndex((p, i) => !used.has(i) && p.id === forcedId);
    if (idx >= 0) {
      take(idx);
      picks[si] = { m: { i: idx, p: plaid[idx], sim: 1, dd: 0, score: 1 }, manual: true };
    }
  });

  // Phase 2 — exact same-day amount, unambiguous on both sides
  stmtRows.forEach((s, si) => {
    if (picks[si]) return;
    const k = exactKey(s.date, s.amount);
    const idxs = plaidByKey.get(k) || [];
    if (idxs.length === 1 && stmtKeyCount.get(k) === 1 && !used.has(idxs[0])) {
      const i = idxs[0];
      take(i);
      picks[si] = { m: { i, p: plaid[i], sim: nameSim(plaid[i].desc, s.desc), dd: 0, score: 3, exact: true }, manual: false };
    }
  });

  // Phase 3 — fuzzy fallback for everything still unpaired
  stmtRows.forEach((s, si) => {
    if (picks[si]) return;
    const m = matchOne(s, plaid, used, aliases);
    if (m) take(m.i);
    picks[si] = { m, manual: false };
  });

  return {
    decisions: stmtRows.map((s, si) => ({ s, m: picks[si].m, manual: picks[si].manual })),
    matchedPlaidIdx,
  };
}

// ── Core reconciliation run ───────────────────────────────────────────────────
async function reconcileUser(query, userId, io, year) {
  // Load Plaid transactions from the DB (transactions table via banking-store)
  const allTxns = await require('../core/banking-store').listTransactions(userId) || [];
  const plaid = allTxns.filter(t => !t.source || t.source === 'plaid');

  // User-taught matching, applied so re-runs stay stable:
  //   • alias rules  — name equivalences (Walmart ↔ Wm Supercenter), used by matchOne
  //   • manual links — explicit statement-row ↔ Plaid-txn pairs, applied before fuzzy
  let aliases = [], manualLinks = [];
  try {
    if (io && typeof io.read === 'function') {
      aliases     = io.read('reconcile_aliases.json') || [];
      manualLinks = io.read('reconcile_manual.json')  || [];
    }
  } catch { /* non-fatal — fall back to pure fuzzy matching */ }
  const manualPlaidFor = new Map();   // stmtSourceId → forced plaid_txn_id
  for (const l of manualLinks) if (l && l.stmtSourceId && l.plaidTxnId) manualPlaidFor.set(l.stmtSourceId, l.plaidTxnId);

  // Load statement rows from Neon for this user
  const stmtRes = await query(
    `SELECT id, txn_date::text AS date, description AS desc, amount::float AS amount
       FROM source_transactions
      WHERE user_id=$1 AND source='statement'
        ${year ? 'AND period_year=$2' : ''}
      ORDER BY txn_date`,
    year ? [userId, year] : [userId]
  );
  const stmtRows = stmtRes.rows;

  if (!stmtRows.length) return { matched: 0, stmtOnly: 0, plaidOnly: 0, conflicts: 0 };

  // Decide every pairing in memory (manual > exact > fuzzy), then swap the table
  // contents atomically below. Tuple order mirrors the INSERT column list.
  const { decisions, matchedPlaidIdx } = planMatches(stmtRows, plaid, { aliases, manualPlaidFor });

  let matched = 0, conflicts = 0;
  const pending = [];

  for (const { s, m, manual } of decisions) {
    const rowYear = year || parseInt(s.date.slice(0, 4));
    if (m) {
      matched++;
      // Flag if names are very dissimilar despite a fuzzy amount+date match (possible
      // mislabelling). Manual links, exact same-day hits, and alias hits are trusted.
      const isConflict = !manual && !m.exact && !m.alias && m.sim < 0.15 && m.dd > 2;
      if (isConflict) conflicts++;
      const reason = manual    ? 'Manually matched'
                   : m.exact   ? 'Exact amount + same-day match'
                   : m.alias   ? 'Matched via alias rule'
                   : isConflict ? `Name mismatch despite amount+date match (sim=${m.sim.toFixed(2)})`
                   : null;
      pending.push([
        crypto.randomUUID(), userId, s.id, m.p.id,
        Number(m.score).toFixed(4), m.dd, Number(m.sim).toFixed(4),
        isConflict ? 'conflict' : 'matched',
        reason,
        rowYear,
      ]);
    } else {
      // Statement-only — fills pre-90-day gap or catches a missing Plaid pull
      pending.push([
        crypto.randomUUID(), userId, s.id, null, 0, null, 0,
        'stmt_only', 'No matching Plaid transaction found', parseInt(s.date.slice(0, 4)),
      ]);
    }
  }

  // Pass 2 — find Plaid rows in the statement's date window with no match
  let plaidOnly = 0;
  {
    const minDate = stmtRows.reduce((m, r) => r.date < m ? r.date : m, stmtRows[0].date);
    const maxDate = stmtRows.reduce((m, r) => r.date > m ? r.date : m, stmtRows[0].date);
    for (let i = 0; i < plaid.length; i++) {
      if (matchedPlaidIdx.has(i)) continue;
      const p = plaid[i];
      if (!p.date || p.date < minDate || p.date > maxDate) continue;
      plaidOnly++;
      const rowYear = year || parseInt((p.date || '2026').slice(0, 4));
      pending.push([
        crypto.randomUUID(), userId, null, p.id, 0, null, 0,
        'plaid_only', 'Transaction in Plaid not found in statement', rowYear,
      ]);
    }
  }

  // Atomic swap — wipe + insert inside ONE transaction (chunked multi-row inserts)
  // so concurrent readers (txn-flags badges, the popup's /txn/:id, dev tools) never
  // see a half-rebuilt table. The old per-row awaits left the table empty/partial
  // for the whole rebuild, and this runs after every auto-sync (every few minutes).
  const { withTransaction } = require('../core/db');
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM statement_matches WHERE user_id=$1 ${year ? 'AND period_year=$2' : ''}`,
      year ? [userId, year] : [userId]
    );
    const CHUNK = 100;
    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk  = pending.slice(i, i + CHUNK);
      const values = chunk.map((_, r) =>
        `(${Array.from({ length: 10 }, (_, c) => '$' + (r * 10 + c + 1)).join(',')})`).join(',');
      await client.query(
        `INSERT INTO statement_matches
           (id,user_id,stmt_source_id,plaid_txn_id,match_score,date_delta_days,name_sim,status,flag_reason,period_year)
         VALUES ${values}`,
        chunk.flat()
      );
    }

    // Remodel evidence links (matched_transaction_sources): the generalized form of
    // the statement↔plaid matches above. transaction_id = the displayed Plaid txn
    // (transactions.id, which equals the plaid source_transactions.id), source = the
    // statement row, role 'bank_statement'. Scoped to THIS run's statement rows (year-
    // agnostic) so a single-year reconcile never wipes another year's links.
    const stmtIds = stmtRows.map(r => r.id);
    await client.query(
      `DELETE FROM matched_transaction_sources
        WHERE user_id=$1 AND source_role='bank_statement' AND source_transaction_id = ANY($2)`,
      [userId, stmtIds]
    );
    const mts = decisions
      .filter(d => d.m)
      .map(d => [crypto.randomUUID(), userId, d.m.p.id, d.s.id, 'bank_statement', Number(d.m.score).toFixed(4)]);
    for (let i = 0; i < mts.length; i += CHUNK) {
      const chunk  = mts.slice(i, i + CHUNK);
      const values = chunk.map((_, r) =>
        `(${Array.from({ length: 6 }, (_, c) => '$' + (r * 6 + c + 1)).join(',')})`).join(',');
      await client.query(
        `INSERT INTO matched_transaction_sources
           (id, user_id, transaction_id, source_transaction_id, source_role, match_confidence)
         VALUES ${values}
         ON CONFLICT (transaction_id, source_transaction_id) DO UPDATE SET
           source_role=EXCLUDED.source_role, match_confidence=EXCLUDED.match_confidence, updated_at=NOW()`,
        chunk.flat()
      );
    }
  });

  // Keep the auditable statements.csv in the DB current (extracted statement data).
  try { await require('../core/csv-store').refreshStatementsCsv(query, userId); }
  catch (e) { console.error('[csv-store] statements.csv:', e.message); }

  return { matched, stmtOnly: stmtRows.length - matched, plaidOnly, conflicts };
}

// ── Status summary ────────────────────────────────────────────────────────────
async function getStatus(query, userId) {
  const [statsRes, filesRes] = await Promise.all([
    query(
      `SELECT status, COUNT(*)::int AS count FROM statement_matches WHERE user_id=$1 GROUP BY status`,
      [userId]
    ),
    query(
      `SELECT DISTINCT source_file, period_year
         FROM source_transactions
        WHERE user_id=$1 AND source='statement'
        ORDER BY period_year DESC`,
      [userId]
    )
  ]);
  const stats = { matched: 0, stmt_only: 0, plaid_only: 0, conflict: 0 };
  for (const r of statsRes.rows) stats[r.status] = r.count;
  return { stats, files: filesRes.rows };
}

// ── Flagged / unmatched rows (for UI) ────────────────────────────────────────
async function getFlagged(query, userId, status) {
  const allowed = ['stmt_only', 'plaid_only', 'conflict'];
  const filter  = allowed.includes(status) ? `AND sm.status=$2` : `AND sm.status IN ('stmt_only','plaid_only','conflict')`;
  const params  = allowed.includes(status) ? [userId, status] : [userId];

  const res = await query(
    `SELECT sm.id, sm.status, sm.flag_reason, sm.match_score,
            sm.date_delta_days, sm.name_sim, sm.period_year, sm.reconciled_at,
            st.txn_date::text AS stmt_date, st.description AS stmt_desc,
            st.amount::float  AS stmt_amount, st.source_file
       FROM statement_matches sm
       LEFT JOIN source_transactions st ON st.id = sm.stmt_source_id
      WHERE sm.user_id=$1 ${filter}
      ORDER BY sm.period_year DESC, COALESCE(st.txn_date, NOW()::date) DESC
      LIMIT 200`,
    params
  );
  return res.rows;
}

module.exports = { parseStatement, classifyStatement, mirrorStatement, reconcileUser, getStatus, getFlagged, planMatches, aliasMatch, aliasToken, nameSim, parseStmtMeta };
