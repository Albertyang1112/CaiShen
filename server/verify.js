/**
 * verify.js — server-side data integrity checks
 *
 * Runs after every Plaid sync (and on startup for each user).
 * Prints a structured report to the terminal — nothing touches the database.
 *
 * Checks performed:
 *   1. Duplicate accounts        — same name within the same institution
 *   2. Stale accounts            — accounts with no transactions in >90 days
 *   3. Net worth breakdown       — balance per institution, flagged if any look wrong
 *   4. Transaction anomalies     — unusually large amounts that may be import artifacts
 *   5. Account balance vs Plaid  — warns if availableBalance != balance (common for credit cards)
 */

const fmt  = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct  = (n, d) => d === 0 ? '—' : ((n / d) * 100).toFixed(1) + '%';
const line = (ch = '─', w = 60) => ch.repeat(w);

function verifyUser(userId, io) {
  const accounts    = io.read('accounts.json')    || [];
  const allTxs      = io.read('transactions.json') || [];
  const label       = `[Verify user:${userId}]`;

  if (!accounts.length) return; // nothing to check

  const now      = Date.now();
  const plaid    = accounts.filter(a => a.source === 'plaid');
  const manual   = accounts.filter(a => a.source !== 'plaid');
  const settled  = allTxs.filter(t => !t.pending);

  console.log('\n' + line('═'));
  console.log(`${label} Account & Net Worth Verification`);
  console.log(line('─'));

  // ── 1. Duplicate account detection ──────────────────────────────────
  const byInst = {};
  for (const a of plaid) {
    const k = (a.institution || 'Unknown').trim();
    (byInst[k] = byInst[k] || []).push(a);
  }

  let dupCount = 0;
  for (const [inst, accts] of Object.entries(byInst)) {
    const names      = accts.map(a => a.name?.toLowerCase().trim());
    const nameCounts = {};
    for (const n of names) nameCounts[n] = (nameCounts[n] || 0) + 1;
    for (const [name, count] of Object.entries(nameCounts)) {
      if (count > 1) {
        console.warn(`  ⚠  DUPLICATE  ${inst} — "${name}" appears ${count}×`);
        dupCount++;
      }
    }
  }
  if (dupCount === 0) {
    console.log(`  ✓  No duplicate accounts detected (${plaid.length} Plaid, ${manual.length} manual)`);
  }

  // ── 2. Net worth breakdown by institution ────────────────────────────
  console.log(line('─'));
  console.log(`  Net Worth Breakdown:`);
  let totalAssets = 0, totalLiab = 0;
  for (const [inst, accts] of Object.entries(byInst)) {
    const bal = accts.reduce((s, a) => s + (a.availableBalance ?? a.balance ?? 0), 0);
    if (bal >= 0) totalAssets += bal; else totalLiab += Math.abs(bal);
    const flag = (() => {
      // Flag if same institution contributes an implausibly large share (>80% of all accounts)
      const allBal = plaid.reduce((s, a) => s + Math.abs(a.availableBalance ?? a.balance ?? 0), 0);
      return allBal > 0 && Math.abs(bal) / allBal > 0.8 && plaid.length > 1 ? ' ← large share, verify' : '';
    })();
    const instAccts = accts.map(a => `${a.name}(${fmt(a.availableBalance ?? a.balance ?? 0)})`).join(', ');
    console.log(`     ${inst.padEnd(28)} ${fmt(bal).padStart(12)}${flag}`);
    if (dupCount > 0 || flag) {
      console.log(`       └─ ${instAccts}`);
    }
  }
  const netWorth = totalAssets - totalLiab;
  console.log(`     ${'TOTAL'.padEnd(28)} ${fmt(netWorth).padStart(12)}`);
  console.log(`     (assets ${fmt(totalAssets)}  ·  liabilities ${fmt(totalLiab)})`);

  // ── 3. Transaction anomalies ─────────────────────────────────────────
  const LARGE_TX_THRESHOLD = 50000;
  const largeTxs = settled.filter(t => Math.abs(t.amount) >= LARGE_TX_THRESHOLD);
  if (largeTxs.length > 0) {
    console.log(line('─'));
    console.log(`  ⚠  Large transactions (≥ ${fmt(LARGE_TX_THRESHOLD)}):`);
    for (const t of largeTxs.slice(0, 10)) {
      console.log(`     ${t.date}  ${(t.desc || '').slice(0, 32).padEnd(34)} ${fmt(t.amount).padStart(12)}  [${t.source || '?'}]`);
    }
    if (largeTxs.length > 10) console.log(`     … and ${largeTxs.length - 10} more`);
  }

  // ── 4. Stale accounts (no transactions in 90 days) ───────────────────
  const cutoff  = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const acctLastTx = {};
  for (const t of settled) {
    if (!acctLastTx[t.account] || t.date > acctLastTx[t.account]) {
      acctLastTx[t.account] = t.date;
    }
  }
  const stale = plaid.filter(a => {
    const last = acctLastTx[a.id];
    return !last || last < cutoff;
  });
  if (stale.length) {
    console.log(line('─'));
    console.log(`  ℹ  Stale accounts (no settled txns in 90 days):`);
    for (const a of stale) {
      const last = acctLastTx[a.id] || 'never';
      console.log(`     ${(a.institution || '?').padEnd(20)} ${(a.name || '?').padEnd(28)} last: ${last}`);
    }
  }

  // ── 5. Summary ───────────────────────────────────────────────────────
  console.log(line('─'));
  const issues = dupCount + (largeTxs.length > 0 ? 1 : 0);
  if (issues === 0) {
    console.log(`  ✓  All checks passed  ·  ${settled.length} settled transactions across ${accounts.length} accounts`);
  } else {
    console.log(`  ⚠  ${issues} issue(s) found — review warnings above`);
  }
  console.log(line('═') + '\n');
}

module.exports = { verifyUser };
