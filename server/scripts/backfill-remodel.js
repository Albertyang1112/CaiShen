'use strict';
/**
 * scripts/backfill-remodel.js — Increment 2 of the DB Remodel Roadmap.
 *
 * Populates the new structural tables from existing data, WITHOUT touching the live
 * `transactions` display layer. Idempotent + reversible. Dry-run by default.
 *
 *   node server/scripts/backfill-remodel.js            # DRY RUN — reports, writes nothing
 *   APPLY=1 node server/scripts/backfill-remodel.js    # APPLY — commits the changes
 *
 * What it does (per user, all users):
 *   1. bank_account_periods   — one per (account, statement year+month), from statement
 *                               documents ∪ distinct statement source_files.
 *   2. bank_statements        — one per (account, year, month) statement, linked to its
 *                               documents row (the PDF) when one exists.
 *   3. source_transactions    — stamp provenance/links that were previously implicit:
 *        • plaid     : external_transaction_id = id (enables the dedup index); account_id
 *                      = account when it matches a real accounts row.
 *        • statement : account_id via last4 (source_file → accounts.mask); link to its
 *                      bank_account_period_id + bank_statement_id.
 *
 * Deliberately NOT done here (kept for Increment 3, to avoid retroactive hash collisions
 * on historical same-day/same-amount rows): source_hash, and monthly periods for
 * Plaid-only accounts. Those are computed at ingest going forward.
 *
 * Reversal (if ever needed):
 *   UPDATE source_transactions SET bank_account_period_id=NULL, bank_statement_id=NULL,
 *          account_id=NULL, external_transaction_id=NULL;   -- (or scope to source/user)
 *   DELETE FROM bank_statements; DELETE FROM bank_account_periods;
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query, withTransaction } = require('../core/db');

const APPLY = process.env.APPLY === '1';
const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const MON_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pad2 = (n) => String(n).padStart(2, '0');
const monthStart = (y, m) => `${y}-${pad2(m)}-01`;
const monthEnd   = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

// "9092 Statement Jan 2021.pdf" → { last4:'9092', month:1, year:2021 }  (null if unparseable)
function parseStmtFilename(name) {
  if (!name) return null;
  const m = /(\d{3,4})\s+Statement\s+([A-Za-z]{3,})\s+(\d{4})/i.exec(name);
  if (!m) return null;
  const month = MON[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return { last4: m[1], month, year: Number(m[3]) };
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('NO DATABASE_URL'); process.exit(2); }
  console.log(`\n=== Remodel backfill (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  // ── Load the inputs (read-only) ──────────────────────────────────────────────
  const accounts = (await query(`SELECT id, user_id, mask FROM accounts`)).rows;
  const acctByUserMask  = new Map();   // `${user}|${last4}` → account_id (first wins)
  const acctsByUser     = new Map();   // user → [account, …]
  for (const a of accounts) {
    if (a.mask) { const k = `${a.user_id}|${a.mask}`; if (!acctByUserMask.has(k)) acctByUserMask.set(k, a.id); }
    (acctsByUser.get(a.user_id) || acctsByUser.set(a.user_id, []).get(a.user_id)).push(a);
  }
  // Unambiguous fallback: a user with exactly one account → that account, used when a
  // statement carries no last4 (e.g. "2026-02 TOTAL CHECKING Statement.pdf", tags.last4 null).
  const singleAcct = new Map();
  for (const [u, list] of acctsByUser) if (list.length === 1) singleAcct.set(u, list[0]);
  const resolveAccount = (user, last4Hint) => {
    let id = last4Hint ? (acctByUserMask.get(`${user}|${last4Hint}`) || null) : null;
    let last4 = last4Hint || null;
    if (!id && singleAcct.has(user)) { const a = singleAcct.get(user); id = a.id; last4 = last4 || a.mask; }
    return { id, last4 };
  };

  const stmtDocs = (await query(
    `SELECT id, user_id, original_name, period_year, period_month, tags->>'last4' AS last4, uploaded_at
       FROM documents WHERE doc_type='statement'`)).rows;
  const stmtFiles = (await query(
    `SELECT DISTINCT user_id, source_file, period_year
       FROM source_transactions WHERE source='statement' AND source_file IS NOT NULL`)).rows;

  // ── Build the statement registry: key = `${user}|${last4}|${year}|${month}` ───
  const statements = new Map();
  const addStmt = (user, last4Hint, year, month, docId, uploadedAt) => {
    if (!year || !month) return false;
    const { id: accountId, last4 } = resolveAccount(user, last4Hint);
    const keyId = accountId || last4;
    if (!keyId) return false;                          // no account and no last4 → can't place it
    const key = `${user}|${keyId}|${year}|${month}`;
    const cur = statements.get(key) || { user, accountId, last4, year, month, docId: null, uploadedAt: null };
    if (docId && !cur.docId) { cur.docId = docId; cur.uploadedAt = uploadedAt; }
    statements.set(key, cur);
    return true;
  };

  let docUnparsed = 0, fileUnparsed = 0;
  for (const d of stmtDocs) {
    const last4 = d.last4 || (parseStmtFilename(d.original_name) || {}).last4;
    if (!addStmt(d.user_id, last4, d.period_year, d.period_month, d.id, d.uploaded_at)) docUnparsed++;
  }
  for (const f of stmtFiles) {
    const p = parseStmtFilename(f.source_file);
    if (!p) { fileUnparsed++; continue; }
    addStmt(f.user_id, p.last4, p.period_year || f.period_year, p.month, null, null);
  }

  // ── Derive periods + bank_statements (deterministic ids → idempotent) ─────────
  const periods = new Map();   // periodId → row
  const bstmts  = [];          // bank_statement rows
  let stmtNoAccount = 0;
  for (const s of statements.values()) {
    const accountId = s.accountId;
    if (!accountId) stmtNoAccount++;
    const periodId = `per_${s.user}_${accountId || 'noacct'}_${s.year}${pad2(s.month)}`;
    if (!periods.has(periodId)) {
      periods.set(periodId, {
        id: periodId, user: s.user, accountId, year: s.year, month: s.month,
        start: monthStart(s.year, s.month), end: monthEnd(s.year, s.month),
        label: `${MON_ABBR[s.month - 1]} ${s.year}`,
      });
    }
    bstmts.push({
      id: `bstmt_${s.user}_${s.last4 || accountId || 'noacct'}_${s.year}${pad2(s.month)}`,
      user: s.user, accountId, periodId, docId: s.docId,
      start: monthStart(s.year, s.month), end: monthEnd(s.year, s.month),
      parsedAt: s.uploadedAt,
    });
  }

  // ── Report the plan ──────────────────────────────────────────────────────────
  console.log(`Inputs:   ${accounts.length} accounts, ${stmtDocs.length} statement docs, ${stmtFiles.length} distinct statement files`);
  console.log(`Derived:  ${statements.size} statements → ${periods.size} periods, ${bstmts.length} bank_statements`);
  console.log(`Unresolved: ${stmtNoAccount} statements with no matching account (last4); ${docUnparsed} docs + ${fileUnparsed} files unparseable\n`);

  // ── Write (or dry-run via forced rollback) ───────────────────────────────────
  const counts = {};
  const DRY_DONE = Symbol('dry');
  try {
    await withTransaction(async (c) => {
      // 1. periods
      let nPer = 0;
      for (const p of periods.values()) {
        const r = await c.query(
          `INSERT INTO bank_account_periods (id,user_id,account_id,start_date,end_date,label,status)
           VALUES ($1,$2,$3,$4,$5,$6,'finalized') ON CONFLICT (id) DO NOTHING`,
          [p.id, p.user, p.accountId, p.start, p.end, p.label]);
        nPer += r.rowCount;
      }
      counts.periodsInserted = nPer;

      // 2. bank_statements
      let nBs = 0;
      for (const b of bstmts) {
        const r = await c.query(
          `INSERT INTO bank_statements
             (id,user_id,account_id,bank_account_period_id,document_id,statement_start_date,statement_end_date,parser_status,parsed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'migrated',$8) ON CONFLICT (id) DO NOTHING`,
          [b.id, b.user, b.accountId, b.periodId, b.docId, b.start, b.end, b.parsedAt]);
        nBs += r.rowCount;
      }
      counts.bankStatementsInserted = nBs;

      // 3a. plaid: external_transaction_id = id  (the row id IS the Plaid txn id)
      counts.plaidExternalId = (await c.query(
        `UPDATE source_transactions SET external_transaction_id = id
          WHERE source='plaid' AND external_transaction_id IS NULL`)).rowCount;

      // 3b. plaid: account_id where it matches a real account
      counts.plaidAccountId = (await c.query(
        `UPDATE source_transactions st SET account_id = st.account
           FROM accounts a
          WHERE st.source='plaid' AND st.account_id IS NULL
            AND a.id = st.account AND a.user_id = st.user_id`)).rowCount;

      // 3c. statement: account_id via last4 (first token of source_file) → accounts.mask
      counts.stmtAccountId = (await c.query(
        `UPDATE source_transactions st SET account_id = a.id
           FROM accounts a
          WHERE st.source='statement' AND st.account_id IS NULL
            AND a.user_id = st.user_id AND a.mask = split_part(st.source_file, ' ', 1)`)).rowCount;

      // 3d. statement: link period + bank_statement, one targeted UPDATE per file
      let nLink = 0;
      for (const f of stmtFiles) {
        const p = parseStmtFilename(f.source_file);
        if (!p) continue;
        const { id: accountId, last4 } = resolveAccount(f.user_id, p.last4);
        const yr = p.year || f.period_year;
        const periodId  = `per_${f.user_id}_${accountId || 'noacct'}_${yr}${pad2(p.month)}`;
        const bstmtId   = `bstmt_${f.user_id}_${last4 || accountId || 'noacct'}_${yr}${pad2(p.month)}`;
        const r = await c.query(
          `UPDATE source_transactions
              SET bank_account_period_id = $1, bank_statement_id = $2
            WHERE user_id = $3 AND source='statement' AND source_file = $4
              AND (bank_account_period_id IS DISTINCT FROM $1 OR bank_statement_id IS DISTINCT FROM $2)`,
          [periodId, bstmtId, f.user_id, f.source_file]);
        nLink += r.rowCount;
      }
      counts.stmtRowsLinked = nLink;

      if (!APPLY) throw DRY_DONE;   // force ROLLBACK — nothing persists in dry run
    });
  } catch (e) {
    if (e !== DRY_DONE) throw e;
  }

  console.log(`${APPLY ? 'Applied' : 'Would apply'}:`);
  console.log(`  periods inserted ............ ${counts.periodsInserted}`);
  console.log(`  bank_statements inserted .... ${counts.bankStatementsInserted}`);
  console.log(`  plaid external_id stamped ... ${counts.plaidExternalId}`);
  console.log(`  plaid account_id stamped .... ${counts.plaidAccountId}`);
  console.log(`  statement account_id stamped  ${counts.stmtAccountId}`);
  console.log(`  statement rows linked ....... ${counts.stmtRowsLinked}`);
  console.log(`\n${APPLY ? '✓ Committed.' : '(dry run — re-run with APPLY=1 to commit)'}\n`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
