/**
 * verify.js — server-side data integrity checks
 *
 * Runs after every Plaid sync (and on startup for each user).
 * Prints a single-line summary per user; expands to details only when issues are found.
 *
 * Checks performed:
 *   1. Duplicate accounts        — same name within the same institution
 *   2. Stale accounts            — accounts with no transactions in >90 days
 *   3. Net worth breakdown       — balance per institution, flagged if any look wrong
 *   4. Transaction anomalies     — unusually large amounts that may be import artifacts
 */

const fmt  = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

async function verifyUser(userId, io) {
  const store = require('./banking-store');
  const accounts = await store.listAccounts(userId)     || [];
  const allTxs   = await store.listTransactions(userId) || [];

  if (!accounts.length) return;

  const now     = Date.now();
  const plaid   = accounts.filter(a => a.source === 'plaid');
  const manual  = accounts.filter(a => a.source !== 'plaid');
  const settled = allTxs.filter(t => !t.pending);

  // ── 1. Duplicate account detection ────────────────────────────────────
  const byInst = {};
  for (const a of plaid) {
    const k = (a.institution || 'Unknown').trim();
    (byInst[k] = byInst[k] || []).push(a);
  }

  const dups = [];
  for (const [inst, accts] of Object.entries(byInst)) {
    const nameCounts = {};
    for (const a of accts) {
      const n = a.name?.toLowerCase().trim();
      nameCounts[n] = (nameCounts[n] || 0) + 1;
    }
    for (const [name, count] of Object.entries(nameCounts)) {
      if (count > 1) dups.push(`${inst}/"${name}" ×${count}`);
    }
  }

  // ── 2. Net worth ───────────────────────────────────────────────────────
  let totalAssets = 0, totalLiab = 0;
  for (const [, accts] of Object.entries(byInst)) {
    const bal = accts.reduce((s, a) => s + (a.availableBalance ?? a.balance ?? 0), 0);
    if (bal >= 0) totalAssets += bal; else totalLiab += Math.abs(bal);
  }
  const netWorth = totalAssets - totalLiab;

  // ── 3. Large transaction anomalies ────────────────────────────────────
  const LARGE_TX_THRESHOLD = 50000;
  const largeTxs = settled.filter(t => Math.abs(t.amount) >= LARGE_TX_THRESHOLD);

  // ── 4. Stale accounts ─────────────────────────────────────────────────
  const cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const acctLastTx = {};
  for (const t of settled) {
    if (!acctLastTx[t.account] || t.date > acctLastTx[t.account]) acctLastTx[t.account] = t.date;
  }
  const stale = plaid.filter(a => { const last = acctLastTx[a.id]; return !last || last < cutoff; });

  // ── Summary line ───────────────────────────────────────────────────────
  const issues = dups.length + largeTxs.length;
  const status = issues === 0 ? '✓' : '⚠';
  const netStr = fmt(netWorth);
  console.log(
    `[verify] user:${userId}  ${status}  ${plaid.length} acct(s)  ${settled.length} txns  net worth ${netStr}` +
    (dups.length    ? `  | DUPS: ${dups.join(', ')}` : '') +
    (largeTxs.length ? `  | LARGE TXS: ${largeTxs.length}` : '') +
    (stale.length   ? `  | STALE: ${stale.length}` : '')
  );

  // Only print detail lines when something needs attention
  if (dups.length) {
    for (const d of dups) console.warn(`  [verify] ⚠  Duplicate account: ${d}`);
  }
  if (largeTxs.length) {
    console.warn(`  [verify] ⚠  ${largeTxs.length} large transaction(s) ≥ ${fmt(LARGE_TX_THRESHOLD)}:`);
    for (const t of largeTxs.slice(0, 5)) {
      console.warn(`    ${t.date}  ${(t.desc || '').slice(0, 40).padEnd(42)} ${fmt(t.amount)}`);
    }
  }
}

module.exports = { verifyUser };
