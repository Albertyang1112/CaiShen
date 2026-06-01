'use strict';
/**
 * crypto-reports.js — report builders (JS port of cryptotax/reports/*).
 *
 * Ports writer.py (money/qty + CSV), form8949.py, schedule_d.py, income.py, summary.py.
 * CSV output is sanitized against formula injection (Excel/Sheets execute a cell that
 * begins with = + - @ tab CR), while *exempting* plain numbers so signed dollar amounts
 * like "-2052.00" pass through unmangled.
 *
 * NOT tax advice — every summary carries a disclaimer for the user to confirm with a CPA.
 */

const { utcParts, fmtQty } = require('./crypto-engine');

// ── Formatting ───────────────────────────────────────────────────────
// USD to 2dp, half-up away from zero. Blank for null/empty. The tiny epsilon counters
// binary-float representation error (e.g. a true X.XX5 stored as X.XX4999…) so ties round up.
function money(x) {
  if (x === null || x === undefined || x === '') return '';
  const n = Number(x);
  if (!Number.isFinite(n)) return '';
  const sign = n < 0 ? -1 : 1;
  const cents = Math.round(Math.abs(n) * 100 + 1e-9);
  if (cents === 0) return '0.00';
  return (sign * cents / 100).toFixed(2);
}

// Crypto quantity without scientific notation or trailing-zero noise.
const qty = fmtQty;

function pad2(n) { return String(n).padStart(2, '0'); }
function mmddyyyy(d) { const p = utcParts(d); return `${pad2(p.m)}/${pad2(p.d)}/${p.y}`; }
function ymd(d) { const p = utcParts(d); return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`; }

// ── CSV serialization (returns a string; no filesystem write) ────────
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Formula-injection guard — but never mangle a plain (possibly negative) number.
  if (s !== '' && !/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(fields, rows) {
  const lines = [fields.map(csvCell).join(',')];
  for (const row of rows) lines.push(fields.map((f) => csvCell(row[f])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ── Form 8949 (one line per disposed lot) ────────────────────────────
const FORM_8949_FIELDS = ['part', 'box', 'description', 'date_acquired', 'date_sold',
  'proceeds', 'cost_basis', 'code', 'adjustment', 'gain'];

function form8949Rows(disposals) {
  const sorted = disposals.slice().sort((a, b) => {
    const at = a.term !== 'short' ? 1 : 0;
    const bt = b.term !== 'short' ? 1 : 0;
    if (at !== bt) return at - bt;
    return a.disposed_at.getTime() - b.disposed_at.getTime();
  });
  return sorted.map((d) => {
    const short = d.term === 'short';
    return {
      part: short ? 'I' : 'II',
      box: short ? 'C' : 'F',
      description: `${qty(d.amount)} ${d.asset}`,
      date_acquired: mmddyyyy(d.acquired_at),
      date_sold: mmddyyyy(d.disposed_at),
      proceeds: money(d.proceeds),
      cost_basis: money(d.cost_basis),
      code: d.code,
      adjustment: d.code ? money(0) : '',
      gain: money(d.gain),
    };
  });
}

// ── Schedule D totals ────────────────────────────────────────────────
const SCHEDULE_D_FIELDS = ['line', 'transactions', 'proceeds', 'cost_basis', 'gain'];

function _agg(disposals, term) {
  let proceeds = 0, cost = 0, gain = 0, count = 0;
  for (const d of disposals) {
    if (d.term !== term) continue;
    proceeds += d.proceeds; cost += d.cost_basis; gain += d.gain; count++;
  }
  return { proceeds, cost_basis: cost, gain, count };
}

function scheduleDTotals(disposals) {
  const s = _agg(disposals, 'short');
  const l = _agg(disposals, 'long');
  return { short_term: s, long_term: l, net_gain: s.gain + l.gain };
}

function scheduleDRows(disposals) {
  const t = scheduleDTotals(disposals);
  const s = t.short_term, l = t.long_term;
  return [
    { line: 'Short-term (Part I, line 3)', transactions: s.count, proceeds: money(s.proceeds), cost_basis: money(s.cost_basis), gain: money(s.gain) },
    { line: 'Long-term (Part II, line 10)', transactions: l.count, proceeds: money(l.proceeds), cost_basis: money(l.cost_basis), gain: money(l.gain) },
    { line: 'Net capital gain/(loss) (line 16)', transactions: s.count + l.count, proceeds: '', cost_basis: '', gain: money(t.net_gain) },
  ];
}

// ── Ordinary income (staking/mining/interest/rewards/airdrops) ───────
const INCOME_FIELDS = ['date', 'kind', 'asset', 'amount', 'value_usd', 'account', 'note'];

function incomeByKind(income) {
  const agg = {};
  for (const i of income) agg[i.kind] = (agg[i.kind] || 0) + i.value_usd;
  return agg;
}

function incomeTotal(income) {
  let t = 0;
  for (const i of income) t += i.value_usd;
  return t;
}

function incomeRows(income) {
  return income.slice().sort((a, b) => a.received_at.getTime() - b.received_at.getTime()).map((i) => ({
    date: mmddyyyy(i.received_at),
    kind: i.kind,
    asset: i.asset,
    amount: qty(i.amount),
    value_usd: money(i.value_usd),
    account: i.account,
    note: i.note,
  }));
}

// ── Gains detail ledger ──────────────────────────────────────────────
const GAIN_FIELDS = ['asset', 'amount', 'term', 'date_acquired', 'date_sold',
  'proceeds', 'cost_basis', 'gain', 'method', 'account', 'tx_id', 'note'];

function gainsDetailRows(disposals) {
  return disposals.slice().sort((a, b) => a.disposed_at.getTime() - b.disposed_at.getTime()).map((d) => ({
    asset: d.asset,
    amount: qty(d.amount),
    term: d.term,
    date_acquired: ymd(d.acquired_at),
    date_sold: ymd(d.disposed_at),
    proceeds: money(d.proceeds),
    cost_basis: money(d.cost_basis),
    gain: money(d.gain),
    method: d.method,
    account: d.account,
    tx_id: d.disposal_tx_id,
    note: d.note,
  }));
}

// ── Portfolio (holdings + unrealized P&L) ────────────────────────────
const PORTFOLIO_FIELDS = ['asset', 'amount', 'cost_basis', 'unit_cost', 'frozen_amount',
  'price', 'market_value', 'unrealized'];

function portfolioRows(holdings) {
  return holdings.map((h) => ({
    asset: h.asset,
    amount: qty(h.amount),
    cost_basis: money(h.cost_basis),
    unit_cost: money(h.unit_cost),
    frozen_amount: qty(h.frozen_amount),
    price: h.price != null ? money(h.price) : '',
    market_value: h.market_value != null ? money(h.market_value) : '',
    unrealized: h.unrealized != null ? money(h.unrealized) : '',
  }));
}

// ── Year summary (JSON, with disclaimer) ─────────────────────────────
const DISCLAIMER = 'NOT tax advice. Verify against your records and a tax professional (CPA).';

function buildSummary(label, disposals, income, warnings) {
  const td = scheduleDTotals(disposals);
  const inc = incomeByKind(income);
  const byKind = {};
  for (const k of Object.keys(inc)) byKind[k] = money(inc[k]);
  return {
    period: label,
    capital_gains: {
      short_term: money(td.short_term.gain),
      long_term: money(td.long_term.gain),
      net: money(td.net_gain),
      proceeds: money(td.short_term.proceeds + td.long_term.proceeds),
      cost_basis: money(td.short_term.cost_basis + td.long_term.cost_basis),
      disposals: td.short_term.count + td.long_term.count,
    },
    ordinary_income: {
      total: money(incomeTotal(income)),
      by_kind: byKind,
      events: income.length,
    },
    warnings: warnings || [],
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  money,
  qty,
  mmddyyyy,
  ymd,
  csvCell,
  toCsv,
  DISCLAIMER,
  FORM_8949_FIELDS,
  form8949Rows,
  SCHEDULE_D_FIELDS,
  scheduleDTotals,
  scheduleDRows,
  INCOME_FIELDS,
  incomeByKind,
  incomeTotal,
  incomeRows,
  GAIN_FIELDS,
  gainsDetailRows,
  PORTFOLIO_FIELDS,
  portfolioRows,
  buildSummary,
};
