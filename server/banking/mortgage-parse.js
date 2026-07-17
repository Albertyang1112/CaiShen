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

// $ is REQUIRED: the label-gap path can cross letters, and a bare number regex grabs things
// like the "2.99" of "2.999%" — statement dollar figures always carry the $ sign.
const MONEY = '\\$\\s*(-?[\\d,]+\\.\\d{2})';
// pdftotext -layout output (Rocket et al.) right-aligns values behind a wide run of spaces
// ("Escrow balance:            $0.00"). This gap allows only colon + horizontal whitespace,
// SAME LINE only — crossing a newline here grabs the neighbouring column's value on merged
// two-column lines, so cross-line label→value resolution goes through grabByColumn instead,
// which verifies the value actually sits in the label's column.
const SL_GAP = ':?[^\\S\\n]{0,80}';
// First $amount appearing within ~40 non-numeric chars after any of `labels`.
function grabMoney(text, labels) {
  for (const l of labels) {
    for (const gap of ['[^\\d$\\n]{0,40}?', SL_GAP]) {
      const m = text.match(new RegExp(l + gap + MONEY, 'i'));
      if (m) return toNum(m[1]);
    }
  }
  return null;
}
function grabDate(text, labels) {
  const DATE = '((?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4})|(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4}))';
  for (const l of labels) {
    // Gap allows spaces/punctuation (e.g. ": ") but NOT letters/digits, so it can't skip
    // across another word or number to a far-away date.
    for (const gap of ['[^\\dA-Za-z]{0,15}?', SL_GAP]) {
      const m = text.match(new RegExp(l + gap + DATE, 'i'));
      if (m) { const d = normDate(m[1]); if (d) return d; }
    }
  }
  return null;
}
function grabRate(text) {
  let m = text.match(/Interest\s*Rate[^\d%]{0,20}(\d{1,2}\.\d{1,4})\s*%?/i);
  // Wide-column layout fallback: require the % sign so a loose gap can't grab a stray number.
  if (!m) m = text.match(new RegExp('Interest\\s*Rate' + SL_GAP + '(\\d{1,2}\\.\\d{1,4})\\s*%', 'i'));
  return m ? toNum(m[1]) : null;
}
// Full loan number (masked to last-4 for display; the UI eye toggle shows the whole thing).
// First match wins — the page-1 header is authoritative (embedded sample pages come later).
function grabLoanNumber(text) {
  const m = text.match(new RegExp('Loan\\s*number' + SL_GAP + '(\\d{6,14})', 'i'));
  if (m) return m[1];
  const n = grabByColumn(text, ['LOAN\\s+NUMBER'], 'loan');
  return n != null ? String(n) : null;
}

// ── Column-aware fallback ────────────────────────────────────────────────────────
// Some servicer layouts (e.g. Mr. Cooper) print a label and its value in the same visual
// column with the OTHER column's text interleaved on the lines between — no single-line
// regex can bridge that. Find the label's column offset, then scan the next few lines for
// a value that starts within ±tol characters of it.
const COL_VALUE = {
  money: '\\$\\s*(-?[\\d,]+\\.\\d{2})',
  date:  '(\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4})',
  rate:  '(\\d{1,2}\\.\\d{1,4})\\s*%',
  loan:  '(\\d{6,14})',
};
function grabByColumn(text, labels, kind, { maxDown = 4, tol = 20 } = {}) {
  const lines = String(text).split(/\r?\n/);
  for (const l of labels) {
    const labelRe = new RegExp(l, 'i');
    for (let i = 0; i < lines.length; i++) {
      const lm = labelRe.exec(lines[i]);
      if (!lm) continue;
      for (let j = i + 1; j <= Math.min(i + maxDown, lines.length - 1); j++) {
        const re = new RegExp(COL_VALUE[kind], 'g');
        let m;
        while ((m = re.exec(lines[j])) !== null) {
          if (Math.abs(m.index - lm.index) <= tol) {
            if (kind === 'date') { const d = normDate(m[1]); if (d) return d; continue; }
            if (kind === 'loan') return m[1];
            return toNum(m[1]);
          }
        }
      }
    }
  }
  return null;
}

// Printed property address — "Property address" label, street + "CITY, ST 12345" on the
// following lines in the label's column. Returns { street, city, region, postalCode } or null.
function grabPropertyAddress(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lm = /PROPERTY\s+ADDRESS/i.exec(lines[i]);
    if (!lm) continue;
    const vals = [];
    for (let j = i + 1; j <= Math.min(i + 5, lines.length - 1) && vals.length < 2; j++) {
      const slice = lines[j].slice(Math.max(0, lm.index - 3), lm.index + 45);
      const v = slice.split(/\s{3,}/).map(s => s.trim()).find(s => /^[A-Za-z0-9]/.test(s));
      if (v) vals.push(v);
    }
    if (!vals.length) continue;
    const cm = vals[1] ? vals[1].match(/^(.*?),\s*([A-Z]{2})\s+([\d-]{5,10})/) : null;
    return { street: vals[0], city: cm ? cm[1] : null, region: cm ? cm[2] : null, postalCode: cm ? cm[3] : null };
  }
  return null;
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
    loanNumber:       grabLoanNumber(text),
  };
  out.loanNumberMask = out.loanNumber ? out.loanNumber.slice(-4) : null;
  // Anything the label-gap pass missed gets a second chance via column alignment.
  const colFill = (v, labels, kind) => (v != null ? v : grabByColumn(text, labels, kind));
  out.statementDate    = colFill(out.statementDate,    ['STATEMENT\\s+DATE'], 'date');
  out.dueDate          = colFill(out.dueDate,          ['PAYMENT\\s+DUE\\s+DATE', 'DUE\\s+DATE'], 'date');
  // ($0 too, not just null: autopay-era statements print "Total amount due: $0.00" in the
  // breakdown while the page-1 header carries the real monthly amount.)
  out.amountDue        = out.amountDue || grabByColumn(text, ['AMOUNT\\s+DUE', 'MONTHLY\\s+PAYMENT'], 'money') || out.amountDue;
  out.principalBalance = colFill(out.principalBalance, ['PRINCIPAL\\s+BALANCE'], 'money');
  out.escrowBalance    = colFill(out.escrowBalance,    ['ESCROW\\s+BALANCE'], 'money');
  out.interestRate     = colFill(out.interestRate,     ['INTEREST\\s+RATE'], 'rate');
  out.principalPaid    = colFill(out.principalPaid,    ['\\bPRINCIPAL\\b(?!\\s+BALANCE)'], 'money');
  out.interestPaid     = colFill(out.interestPaid,     ['\\bINTEREST\\b(?!\\s+(?:RATE|BEARING))'], 'money');
  out.escrowPaid       = colFill(out.escrowPaid,       ['\\bESCROW\\b(?!\\s+BALANCE)'], 'money');
  // totalPaid: prefer amountDue; else the sum of any breakdown portions.
  const portions = [out.principalPaid, out.interestPaid, out.escrowPaid].filter(v => v != null);
  out.totalPaid = out.amountDue != null ? out.amountDue : (portions.length ? portions.reduce((a, b) => a + b, 0) : null);

  // Confidence = fraction of the three CORE fields found (what makes a statement usable).
  const core = [out.statementDate, out.amountDue, out.principalBalance];
  out.confidence = Number((core.filter(v => v != null).length / core.length).toFixed(4));
  out.parserStatus = out.confidence >= 0.66 ? 'parsed' : out.confidence > 0 ? 'partial' : 'failed';
  return out;
}

module.exports = { parseMortgageStatement, grabPropertyAddress, normDate, _toNum: toNum,
                   // Generic label-driven extraction helpers, reused by insurance-parse.js
                   grabMoney, grabDate, grabByColumn };
