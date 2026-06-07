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
 *   Fuzzy-matches statement rows vs Plaid transactions loaded via io.
 *   Writes results to statement_matches (clears old run for that user/year first).
 *   Returns { matched, stmtOnly, plaidOnly, conflicts }.
 *
 * getStatus(query, userId)
 *   Returns { stats:{matched,stmt_only,plaid_only,conflict}, files:[{source_file,period_year}] }.
 */

const crypto = require('crypto');
const { parsePDFTransactions } = require('./pdf-parser');

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

// ── Main parse dispatcher ─────────────────────────────────────────────────────
async function parseStatement(buffer, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return parseCSV(buffer.toString('utf8'));

  // PDF path
  const yearMatch = (filename || '').match(/20\d{2}/);
  const year = yearMatch ? yearMatch[0] : String(new Date().getFullYear());
  try {
    return await parsePDFTransactions(buffer, { year });
  } catch (e) {
    console.error('[reconciler] PDF parse failed:', e.message);
    return [];
  }
}

// ── Mirror statement rows into source_transactions ────────────────────────────
async function mirrorStatement(query, userId, rows, sourceFile) {
  const year = parseInt((sourceFile || '').match(/20\d{2}/)?.[0] || new Date().getFullYear());
  let inserted = 0;
  for (const row of rows) {
    // Deterministic ID so re-uploading the same file is idempotent
    const id = 'stmt_' + crypto.createHash('sha1')
      .update(`${userId}|${sourceFile}|${row.date}|${row.amount}|${row.desc}`)
      .digest('hex').slice(0, 20);

    await query(
      `INSERT INTO source_transactions
         (id, user_id, source, source_file, period_year, txn_date, description, amount, raw)
       VALUES ($1,$2,'statement',$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [id, userId, sourceFile, year, row.date, row.desc, row.amount, JSON.stringify(row)]
    );
    inserted++;
  }
  return inserted;
}

// ── Best-match finder (amount exact ±$0.01, date ±4 days, name Jaccard) ─────
function matchOne(s, plaid, used) {
  let best = null, bestScore = -1;
  for (let i = 0; i < plaid.length; i++) {
    if (used.has(i)) continue;
    const p = plaid[i];
    // Use absolute values — sign conventions can differ between Plaid and statements
    if (Math.abs(Math.abs(Number(p.amount)) - Math.abs(Number(s.amount))) > 0.01) continue;
    const dd = dDiff(p.date, s.date);
    if (dd > 4) continue;
    const sim = nameSim(p.desc, s.desc);
    const score = sim * 2 + (1 - dd / 5);   // weight name match more than date proximity
    if (score > bestScore) { bestScore = score; best = { i, p, sim, dd, score }; }
  }
  return (best && bestScore >= 0) ? best : null;
}

// ── Core reconciliation run ───────────────────────────────────────────────────
async function reconcileUser(query, userId, io, year) {
  // Load Plaid transactions from local per-user JSON
  const allTxns = io.read('transactions.json') || [];
  const plaid = allTxns.filter(t => !t.source || t.source === 'plaid');

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

  // Wipe and re-run (idempotent on re-upload)
  await query(
    `DELETE FROM statement_matches WHERE user_id=$1 ${year ? 'AND period_year=$2' : ''}`,
    year ? [userId, year] : [userId]
  );

  const used = new Set(), matchedPlaidIdx = new Set();
  let matched = 0, conflicts = 0;

  // Pass 1 — match each statement row against Plaid
  for (const s of stmtRows) {
    const m = matchOne(s, plaid, used);
    const rowYear = year || parseInt(s.date.slice(0, 4));

    if (m) {
      used.add(m.i);
      matchedPlaidIdx.add(m.i);
      matched++;
      // Flag if names are very dissimilar despite amount+date match (possible mislabelling)
      const isConflict = m.sim < 0.15 && m.dd > 2;
      if (isConflict) conflicts++;
      await query(
        `INSERT INTO statement_matches
           (id,user_id,stmt_source_id,plaid_txn_id,match_score,date_delta_days,name_sim,status,flag_reason,period_year)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          crypto.randomUUID(), userId, s.id, m.p.id,
          m.score.toFixed(4), m.dd, m.sim.toFixed(4),
          isConflict ? 'conflict' : 'matched',
          isConflict ? `Name mismatch despite amount+date match (sim=${m.sim.toFixed(2)})` : null,
          rowYear
        ]
      );
    } else {
      // Statement-only — fills pre-90-day gap or catches a missing Plaid pull
      await query(
        `INSERT INTO statement_matches
           (id,user_id,stmt_source_id,plaid_txn_id,match_score,date_delta_days,name_sim,status,flag_reason,period_year)
         VALUES ($1,$2,$3,NULL,0,NULL,0,'stmt_only','No matching Plaid transaction found',$4)`,
        [crypto.randomUUID(), userId, s.id, parseInt(s.date.slice(0, 4))]
      );
    }
  }

  // Pass 2 — find Plaid rows in the statement's date window with no match
  let plaidOnly = 0;
  if (stmtRows.length) {
    const minDate = stmtRows.reduce((m, r) => r.date < m ? r.date : m, stmtRows[0].date);
    const maxDate = stmtRows.reduce((m, r) => r.date > m ? r.date : m, stmtRows[0].date);
    for (let i = 0; i < plaid.length; i++) {
      if (matchedPlaidIdx.has(i)) continue;
      const p = plaid[i];
      if (!p.date || p.date < minDate || p.date > maxDate) continue;
      plaidOnly++;
      const rowYear = year || parseInt((p.date || '2026').slice(0, 4));
      await query(
        `INSERT INTO statement_matches
           (id,user_id,stmt_source_id,plaid_txn_id,match_score,date_delta_days,name_sim,status,flag_reason,period_year)
         VALUES ($1,$2,NULL,$3,0,NULL,0,'plaid_only','Transaction in Plaid not found in statement',$4)`,
        [crypto.randomUUID(), userId, p.id, rowYear]
      );
    }
  }

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

module.exports = { parseStatement, mirrorStatement, reconcileUser, getStatus, getFlagged };
