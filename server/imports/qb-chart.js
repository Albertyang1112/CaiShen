'use strict';
/**
 * imports/qb-chart.js — turn the QB report exports into an account + chart plan.
 *
 *   Trial Balance  → the authoritative flat account list (colon paths) + balances.
 *   Balance Sheet  → section context: WHICH accounts are real bank/credit-card accounts
 *                    (sections "Bank Accounts" / "Credit Cards") vs asset/liability/equity
 *                    categories. P&L does the same for income vs expense.
 *
 * Output plan:
 *   financial: [{ path, name, kind bank|card, last4, institution, balance }]
 *              → become rows in accounts.json (real accounts, itemized on the BS by class)
 *   coa:       [{ path:[segments], type, scope, balance }]
 *              → become system:false chart nodes under the matching default section root;
 *                asset/liability/equity balances land in category_balances.json.
 *
 * Everything here is pure (rows in, plan out) so it unit-tests without a DB.
 */
const { cellStr, cellNum } = require('./xlsx-parse');

const seg  = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const qbId = (pathArr) => 'cat_qb_' + pathArr.map(seg).join('__');

const isFooterRow = (s) => /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),/i.test(s) || /accrual basis|cash basis/i.test(s);

// ── Hierarchy walk (Balance Sheet / P&L): indentation = 3 spaces per level ──────────
// Rows with a value are accounts; rows without are section headers; "Total …" rows close.
function walkHierarchyReport(rows, headerRowIndex) {
  const out = [];   // { path:[names incl. sections], value }
  const stack = [];
  for (let i = (headerRowIndex ?? 4) + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const raw = row[0] == null ? '' : String(row[0]);
    const label = raw.trim();
    if (!label || isFooterRow(label)) continue;
    if (/^total\b/i.test(label)) continue;                       // subtotal — recomputed, not read
    const depth = Math.floor((raw.length - raw.trimStart().length) / 3);
    stack.length = Math.min(stack.length, depth);
    const value = cellNum(row[1]);
    out.push({ path: [...stack, label], value });
    stack.push(label);                                           // children (if any) sit one level deeper
  }
  return out;
}

// Deepest-first section classification from a BS/P&L path. QB's "Other Income" /
// "Other Expenses" / "COGS" sections come back as a `group` so the imported chart keeps
// them as real group nodes — the P&L page then sections exactly like the spreadsheet.
function typeFromPath(path) {
  for (let i = path.length - 1; i >= 0; i--) {
    const s = path[i].toLowerCase();
    if (/^bank accounts$/.test(s)) return { type: 'asset', kind: 'bank' };
    if (/^credit cards$/.test(s)) return { type: 'liability', kind: 'card' };
    if (/^equity$/.test(s)) return { type: 'equity' };
    if (/liabilit(y|ies)$/.test(s) && !/equity/.test(s)) return { type: 'liability' };
    if (/^assets?$|assets$/.test(s)) return { type: 'asset' };
    if (/^other income$/.test(s)) return { type: 'income', group: 'Other Income' };
    if (/^other expenses?$/.test(s)) return { type: 'expense', group: 'Other Expenses' };
    if (/^cost of goods sold$/.test(s)) return { type: 'expense', group: 'Cost of Goods Sold' };
    if (/income$/.test(s)) return { type: 'income' };
    if (/^expenses?$/.test(s)) return { type: 'expense' };
  }
  return null;
}

// Generic QB section headers that are report STRUCTURE, not ledger accounts. Used to
// strip section levels off a BS/P&L path so what remains aligns with TB colon paths.
const SECTION_RE = /^(assets|current assets|fixed assets|other assets|other current assets|bank accounts|accounts receivable|liabilities and equity|liabilities|current liabilities|long-term liabilities|other current liabilities|credit cards|accounts payable|equity|income|expenses|other income|other expenses|cost of goods sold|gross profit)$/i;
const accountPathOf = (path) => path.filter(p => !SECTION_RE.test(p.trim()));

/** Build suffix → {type,kind} index from BS + P&L account rows. */
function buildTypeIndex(hierRows) {
  const idx = new Map();
  for (const r of hierRows) {
    const t = typeFromPath(r.path);
    if (!t) continue;
    const acctPath = accountPathOf(r.path);
    if (!acctPath.length) continue;
    for (let n = 1; n <= acctPath.length; n++) {
      const key = acctPath.slice(-n).map(s => s.trim().toLowerCase()).join(':');
      if (!idx.has(key) || n > 1) idx.set(key, t);   // longer suffixes overwrite (more specific)
    }
  }
  return idx;
}

function lookupType(idx, tbPath) {
  const parts = tbPath.map(s => s.trim().toLowerCase());
  for (let n = parts.length; n >= 1; n--) {
    const hit = idx.get(parts.slice(-n).join(':'));
    if (hit) return hit;
  }
  return null;
}

// ── Trial Balance: flat colon paths + debit/credit ─────────────────────────────────
function parseTrialBalance(rows, header) {
  const hi = header?.rowIndex ?? 4;
  const dCol = header?.cols?.debit ?? 1, cCol = header?.cols?.credit ?? 2;
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const label = cellStr(row[0]);
    if (!label || isFooterRow(label) || /^total$/i.test(label)) continue;
    const debit = cellNum(row[dCol]), credit = cellNum(row[cCol]);
    if (debit === null && credit === null) continue;
    out.push({ path: label.split(':').map(s => s.trim()), debit: debit || 0, credit: credit || 0 });
  }
  return out;
}

// ── Heuristics for when only some report files are present ─────────────────────────
const FINANCIAL_FALLBACK = [
  [/checking|savings|bus checking/i, 'bank'],
  [/credit card|\bcc\b|chase (united|freedom|amazon)|costco citi/i, 'card'],
];
function fallbackType(path) {
  const joined = path.join(':');
  for (const [re, kind] of FINANCIAL_FALLBACK) if (re.test(joined)) return { type: kind === 'card' ? 'liability' : 'asset', kind };
  if (/income$/i.test(path[0]) || /^(rental income|late fee|refunds to customers)$/i.test(path[0])) return { type: 'income' };
  if (/mortgage|security deposit|payable|reserve/i.test(joined)) return { type: 'liability' };
  if (/escrow|receivable|loans to others|equipment|tesla|buildings/i.test(joined)) return { type: 'asset' };
  if (/owner|equity|opening balance|investment/i.test(joined)) return { type: 'equity' };
  return { type: 'expense' };
}

function institutionOf(name) {
  if (/boa|bank of america/i.test(name)) return 'Bank of America';
  if (/chase/i.test(name)) return 'Chase';
  if (/citi/i.test(name)) return 'Citi';
  if (/blockfi/i.test(name)) return 'BlockFi';
  return '';
}
const last4Of = (name) => { const m = String(name).match(/\b(\d{4})\b/); return m ? m[1] : null; };

// Scope: the ENTIRE QB chart imports as 'business' — the spreadsheet is one set of books
// with a single Income and a single Expenses section ("Personal expenses" is just a
// subtree inside Expenses), and the P&L page must mirror that layout. CaiShen's Personal
// section stays reserved for native personal spending (e.g. live Chase transactions).
const scopeOf = () => 'business';

/**
 * Compose the plan from whichever reports the batch contains.
 * @param {object} parts  { trialBalance?: rows+header, balanceSheet?: …, profitLoss?: …, journalAccounts?: string[] }
 */
function buildChartPlan(parts) {
  const hier = [];
  if (parts.balanceSheet) hier.push(...walkHierarchyReport(parts.balanceSheet.rows, parts.balanceSheet.header?.rowIndex));
  if (parts.profitLoss)   hier.push(...walkHierarchyReport(parts.profitLoss.rows,   parts.profitLoss.header?.rowIndex));
  const typeIdx = buildTypeIndex(hier);

  // Account universe: trial balance rows, else BS/P&L account rows, else journal leg names.
  let universe;
  if (parts.trialBalance) {
    universe = parseTrialBalance(parts.trialBalance.rows, parts.trialBalance.header);
  } else if (hier.length) {
    universe = hier.filter(r => r.value !== null && accountPathOf(r.path).length)
                   .map(r => ({ path: accountPathOf(r.path), debit: Math.max(r.value, 0), credit: Math.max(-r.value, 0) }));
  } else {
    universe = (parts.journalAccounts || []).map(a => ({ path: a.split(':').map(s => s.trim()), debit: 0, credit: 0 }));
  }

  const financial = [], coa = [];
  for (const row of universe) {
    const t = lookupType(typeIdx, row.path) || fallbackType(row.path);
    const name = row.path[row.path.length - 1];
    if (t.kind === 'bank' || t.kind === 'card') {
      // Signed balance: TB debit-normal. Banks stay signed (overdraft = negative asset);
      // cards flip to "amount owed" positive, matching Plaid's convention.
      const signed = row.debit - row.credit;
      financial.push({
        path: row.path.join(':'), name, kind: t.kind,
        last4: last4Of(name), institution: institutionOf(name),
        balance: t.kind === 'card' ? -signed : signed,
      });
    } else {
      // Natural-positive balances by type; equity stays credit-normal signed so
      // Owner draws (debit) reads negative exactly like the QB balance sheet.
      const balance = t.type === 'asset' ? row.debit - row.credit : row.credit - row.debit;
      // idPath = where the node LIVES in the chart: an "Other Income"/"Other Expenses"/
      // "COGS" account nests under a group node named after its QB section.
      const idPath = t.group ? [t.group, ...row.path] : row.path;
      coa.push({ path: row.path, idPath, type: t.type, scope: scopeOf(row.path[0]), balance });
    }
  }
  return { financial, coa };
}

/** COA plan rows → concrete chart nodes (ancestors included, ids deterministic). */
function planToChartNodes(coaPlan, idForPath) {
  const ROOT_BY = {
    'income:personal': ['Personal Income'],   'income:business': ['Business Revenue'],
    'expense:personal': ['Personal Expenses'], 'expense:business': ['Business Expenses'],
    'asset:personal': ['Personal Assets'],     'asset:business': ['Business Assets'],
    'liability:personal': ['Personal Liabilities'], 'liability:business': ['Business Liabilities'],
    'equity:personal': ['Personal Net Worth'], 'equity:business': ['Business Equity'],
  };
  const nodes = new Map();          // id → node
  const balances = {};              // id → signed balance (asset/liability/equity only)
  for (const row of coaPlan) {
    const rootId = idForPath(ROOT_BY[`${row.type}:${row.scope}`]);
    const idPath = row.idPath || row.path;
    let parentId = rootId;
    for (let d = 0; d < idPath.length; d++) {
      const sub = idPath.slice(0, d + 1);
      const id = qbId(sub);
      if (!nodes.has(id)) nodes.set(id, { id, name: idPath[d], parentId, type: row.type, scope: row.scope, active: true, system: false, qb: true });
      parentId = id;
    }
    if (['asset', 'liability', 'equity'].includes(row.type) && row.balance) {
      balances[qbId(idPath)] = (balances[qbId(idPath)] || 0) + row.balance;
    }
  }
  return { nodes: [...nodes.values()], balances };
}

module.exports = { buildChartPlan, planToChartNodes, parseTrialBalance, walkHierarchyReport, typeFromPath, accountPathOf, qbId, seg, institutionOf, last4Of };
