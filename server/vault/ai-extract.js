'use strict';
/**
 * vault/ai-extract.js — Groq-backed transaction extraction from a statement PDF.
 *
 * Replaces the brittle column-position heuristic (`parsePDFTransactions`) for
 * computing a statement's income/spending. That parser mis-read some real Chase
 * layouts (0 transactions for one month, $0 income despite deposits on others)
 * because it guesses columns from X-coordinates. Groq reads the statement's text
 * and returns a clean transaction list with correct debit/credit signs.
 *
 * Pure module: `extractTransactions(buffer, { year })` → { transactions, ... }.
 * PDFs are read via the text layer (pdf-parser.extractRawText); scanned/textless
 * PDFs return [] with needsOcr (caller records $0 rather than misreporting).
 */
const { extractRawText } = require('../core/pdf-parser');

const { groqChat } = require('./groq-client');   // shared rate-limit-aware gateway
const TEXT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const SYSTEM = `You extract EVERY transaction from a bank or credit-card statement's text. Respond with ONLY a JSON object, no prose, no markdown:
{"transactions":[{"date":"YYYY-MM-DD","desc":"merchant or description","amount":-12.34}]}
Rules:
- One entry per POSTED transaction: deposits, withdrawals, card purchases, ACH/electronic payments, checks, fees, interest. SKIP summary, subtotal, "total", "beginning/ending balance", and running-balance lines.
- amount SIGN is critical: NEGATIVE for money OUT (debit, withdrawal, purchase, payment, fee, transfer out). POSITIVE for money IN (deposit, credit, refund, interest earned, transfer in).
- date = the transaction's date as YYYY-MM-DD. Statement dates are often "MM/DD"; use the statement year given below. If the period spans a year boundary (e.g. Dec→Jan), choose the correct year per date.
- Capture ALL transactions, however many. If there are genuinely none, return {"transactions":[]}.
- Never invent transactions and never copy balance figures as amounts.`;

function safeJson(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

function normalize(t, year) {
  if (!t || t.amount == null) return null;
  const amount = Number(String(t.amount).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000) return null;
  let date = String(t.date || '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date))) {
    date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  } else if ((m = /^(\d{1,2})[/\-](\d{1,2})$/.exec(date)) && year) {
    date = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  } else {
    const d = new Date(date);
    if (isNaN(d)) return null;
    date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return { date, month: date.slice(0, 7), desc: String(t.desc || t.description || '').slice(0, 100), amount: +amount.toFixed(2), source: 'pdf_import' };
}

/**
 * Extract transactions from a statement PDF using Groq.
 * @param {Buffer} buffer
 * @param {{ year?: string|number }} [opts]
 * @returns {Promise<{ transactions: Array, textChars: number, needsOcr?: boolean, usage?: any }>}
 */
async function extractTransactions(buffer, { year } = {}) {
  let text = '';
  try { text = (await extractRawText(buffer) || '').trim(); } catch {}
  if (!text || text.length < 20) return { transactions: [], textChars: text.length, needsOcr: true };

  // A real statement's text is full of money amounts (e.g. "1,234.56"). If it clearly
  // is one but Groq returns nothing, that's an LLM flake — it occasionally returns an
  // empty list — NOT a genuinely empty statement. Retry a few times and keep the best
  // (most-transactions) result so a single bad roll can't store a false $0.
  const looksLikeStatement = (text.match(/\d[\d,]*\.\d{2}/g) || []).length >= 5;
  let best = [], lastUsage = null;
  const maxTries = looksLikeStatement ? 3 : 1;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const resp = await groqChat({
      model: TEXT_MODEL, temperature: 0, max_tokens: 6000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Extract all transactions from this statement.${year ? ` The statement year is ${year}.` : ''}\n\nSTATEMENT TEXT:\n${text.slice(0, 12000)}` },
      ],
    });
    lastUsage = resp.data?.usage || lastUsage;
    const parsed = safeJson(resp.data?.choices?.[0]?.message?.content || '');
    const arr = Array.isArray(parsed?.transactions) ? parsed.transactions : (Array.isArray(parsed) ? parsed : []);
    const txns = arr.map(t => normalize(t, year)).filter(Boolean);
    if (txns.length > best.length) best = txns;
    if (best.length > 0) break;            // got transactions → good
  }
  // "suspicious" = looks like a statement but came back empty after retries → the
  // caller should NOT cache this as $0 (leave it to retry) rather than misreport.
  const suspicious = looksLikeStatement && best.length === 0;
  return { transactions: best, textChars: text.length, usage: lastUsage, suspicious };
}

// ── Statement summary totals (reliable income/spending) ──────────────────────
// Summing individual transactions via an LLM is non-deterministic — it can miss a
// line or misread a balance as a transaction, so the totals wobble between runs.
// Banks STATE the period totals (Beginning Balance, Deposits & Additions, Ending
// Balance). Reading those few labeled numbers is far steadier, and they self-check
// against the balance equation: beginning + deposits − withdrawals = ending. We
// accept a result only when that holds (±$0.02), retrying otherwise.
const SUMMARY_SYSTEM = `You read a bank/credit-card statement's ACCOUNT SUMMARY and return its period totals as JSON only — no prose:
{"beginningBalance": <number|null>, "deposits": <number|null>, "withdrawals": <number|null>, "endingBalance": <number|null>}
- beginningBalance / endingBalance: the starting and ending balance for the statement period.
- deposits: TOTAL money IN for the period (e.g. the "Deposits and Additions" total). Positive.
- withdrawals: TOTAL money OUT for the period (sum of every withdrawal / payment / fee category). Report as a POSITIVE number.
- Take these from the SUMMARY section, not by adding up individual lines. They should satisfy: beginningBalance + deposits − withdrawals = endingBalance. Use null for anything not shown.`;

const _num = (x) => { if (x == null) return null; const n = Number(String(x).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const toResult = (beginning, deposits, ending, source) => {
  const income   = +deposits.toFixed(2);
  const net      = +(ending - beginning).toFixed(2);
  const spending = +(net - income).toFixed(2);          // total money out, as a negative number
  return { income, spending, net, beginning, deposits, ending, source };
};

// Deterministic parse of a printed statement summary (no LLM). Chase-style layout:
// "CHECKING SUMMARY … Beginning Balance $X … Deposits and Additions Y … Ending Balance $W".
// The balance equation (begin + deposits − withdrawals = ending) lets us derive
// spending from begin/deposits/ending without re-adding individual transactions.
function parseSummaryText(text) {
  const m = text.match(/(?:CHECKING|SAVINGS|ACCOUNT)\s+SUMMARY([\s\S]{0,700}?)(?:TRANSACTION\s+DETAIL|\*start\*|$)/i);
  const block = m ? m[1] : text.slice(0, 900);
  const grab = (re) => { const x = block.match(re); return x ? Number(x[1].replace(/,/g, '')) : null; };
  const beginning = grab(/Beginning Balance\s+\$?\s*(-?[\d,]+\.\d{2})/i);
  const ending    = grab(/Ending Balance\s+\$?\s*(-?[\d,]+\.\d{2})/i);
  if (beginning == null || ending == null) return null;            // both balances must be present
  const deposits = grab(/Deposits?(?:\s+and\s+Additions)?\s+\$?\s*(-?[\d,]+\.\d{2})/i) ?? 0;  // line absent → no deposits that period
  const r = toResult(beginning, deposits, ending, 'parsed');
  // Sanity: money out can't be positive. If the balance grew by MORE than deposits
  // explain, we must have missed an income line — defer to Groq rather than guess.
  if (r.spending > 0.02) return null;
  return r;
}

/**
 * A statement's income/spending/net for the period — the reliable way (read the
 * stated totals, not by summing transactions).
 * @returns {Promise<{income,spending,net,source}|{needsOcr:true}|{source:'none'}>}
 */
async function extractSummary(buffer, { year } = {}) {
  let text = '';
  try { text = (await extractRawText(buffer) || '').trim(); } catch {}
  if (!text || text.length < 20) return { needsOcr: true, textChars: text.length };

  // 1. Deterministic (printed summary labels) — exact, free, no rate limit.
  const det = parseSummaryText(text);
  if (det) return { ...det, textChars: text.length };

  // 2. Fallback for layouts the regex doesn't know: ask Groq for the 4 summary
  //    numbers and accept only a balance-equation-consistent answer.
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await groqChat({
      model: TEXT_MODEL, temperature: 0, max_tokens: 400,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Read this statement's summary totals.${year ? ` Year ${year}.` : ''}\n\nSTATEMENT TEXT:\n${text.slice(0, 12000)}` },
      ],
    });
    const o = safeJson(resp.data?.choices?.[0]?.message?.content || '') || {};
    const b = _num(o.beginningBalance), d = _num(o.deposits), w = _num(o.withdrawals), e = _num(o.endingBalance);
    if (b != null && d != null && w != null && e != null && Math.abs(b + d - w - e) <= 0.02)
      return { ...toResult(b, d, e, 'groq'), textChars: text.length };       // self-consistent → trust
    if (!best && d != null && e != null && b != null) best = toResult(b, d, e, 'groq');
  }
  return best ? { ...best, textChars: text.length } : { source: 'none', textChars: text.length };
}

module.exports = { extractTransactions, extractSummary, parseSummaryText };
