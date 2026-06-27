'use strict';
/**
 * banking/mortgage-parse.js — best-effort extractor for mortgage-statement TEXT.
 *
 * parseMortgageStatement(text) → {
 *   statementDate, dueDate, amountDue, principalBalance, escrowBalance,
 *   principalPaid, interestPaid, escrowPaid, totalPaid, interestRate,
 *   confidence (0..1), parserStatus ('parsed'|'partial'|'failed')
 * }
 *
 * PURE (text → object), so it's unit-testable without a PDF or DB. Servicer statements
 * vary, so this is label-driven and heuristic — it captures the common Rocket/Chase/Wells/
 * BoA/Mr-Cooper field labels and grades its own confidence. Never throws; unknown fields
 * come back null. Refine the label lists against real statements as you collect them.
 */

const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,
                 jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };

const toNum = (s) => { if (s == null) return null; const n = Number(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };

function normDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (m) { let [, mo, d, y] = m; if (y.length === 2) y = '20' + y; return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) { const mo = MONTHS[m[1].toLowerCase()]; if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
  return null;
}

const MONEY = '\\$?\\s*(-?[\\d,]+\\.\\d{2})';
// First $amount appearing within ~40 non-numeric chars after any of `labels`.
function grabMoney(text, labels) {
  for (const l of labels) {
    const m = text.match(new RegExp(l + '[^\\d$\\n]{0,40}?' + MONEY, 'i'));
    if (m) return toNum(m[1]);
  }
  return null;
}
function grabDate(text, labels) {
  const DATE = '((?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4})|(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4}))';
  for (const l of labels) {
    // Gap allows spaces/punctuation (e.g. ": ") but NOT letters/digits, so it can't skip
    // across another word or number to a far-away date.
    const m = text.match(new RegExp(l + '[^\\dA-Za-z]{0,15}?' + DATE, 'i'));
    if (m) { const d = normDate(m[1]); if (d) return d; }
  }
  return null;
}
function grabRate(text) {
  const m = text.match(/Interest\s*Rate[^\d%]{0,20}(\d{1,2}\.\d{1,4})\s*%?/i);
  return m ? toNum(m[1]) : null;
}

function parseMortgageStatement(text) {
  text = String(text || '');
  const out = {
    statementDate:    grabDate(text, ['Statement\\s*Date']),
    dueDate:          grabDate(text, ['Payment\\s*Due\\s*Date', 'Due\\s*Date']),
    amountDue:        grabMoney(text, ['Total\\s*Amount\\s*Due', 'Current\\s*Payment\\s*Due', 'Total\\s*Payment\\s*Due', 'Regular\\s*Monthly\\s*Payment', 'Total\\s*Monthly\\s*Payment', 'Amount\\s*Due']),
    principalBalance: grabMoney(text, ['Outstanding\\s*Principal\\s*(?:Balance)?', 'Unpaid\\s*Principal\\s*Balance', 'Current\\s*Principal\\s*Balance', 'Principal\\s*Balance']),
    escrowBalance:    grabMoney(text, ['Escrow\\s*(?:Account\\s*)?Balance', 'Current\\s*Escrow\\s*Balance']),
    // Breakdown (negative lookaheads keep "Principal Balance" / "Interest Rate" / "Escrow Balance" out).
    principalPaid:    grabMoney(text, ['Principal(?!\\s*Balance)']),
    interestPaid:     grabMoney(text, ['Interest(?!\\s*Rate)']),
    escrowPaid:       grabMoney(text, ['Escrow\\s*(?:\\(Taxes[^)]*\\))?(?!\\s*(?:Account\\s*)?Balance)']),
    interestRate:     grabRate(text),
  };
  // totalPaid: prefer amountDue; else the sum of any breakdown portions.
  const portions = [out.principalPaid, out.interestPaid, out.escrowPaid].filter(v => v != null);
  out.totalPaid = out.amountDue != null ? out.amountDue : (portions.length ? portions.reduce((a, b) => a + b, 0) : null);

  // Confidence = fraction of the three CORE fields found (what makes a statement usable).
  const core = [out.statementDate, out.amountDue, out.principalBalance];
  out.confidence = Number((core.filter(v => v != null).length / core.length).toFixed(4));
  out.parserStatus = out.confidence >= 0.66 ? 'parsed' : out.confidence > 0 ? 'partial' : 'failed';
  return out;
}

module.exports = { parseMortgageStatement, normDate, _toNum: toNum };
