'use strict';
/**
 * banking/statement-reminder.js — proactively warn a user when a bank statement is overdue.
 *
 * Statements are tracked per CALENDAR MONTH per account (bank_statements, id
 * bstmt_{user}_{last4}_{YYYYMM}, statement_start_date = first of that month). A month-M
 * statement typically becomes available on a bank-specific CLOSE DAY (e.g. Chase ~the 15th).
 * Groq estimates that close-day from the institution name (cached per process). If the most
 * recent month whose close-day passed more than `grace` days ago has NO uploaded statement, we
 * DM the user once (deduped in statement_reminders by account + close-date).
 *
 * Only accounts the user already keeps statements for (≥1 prior bank_statement) are nagged, so
 * we never pester about accounts they don't track by statement.
 */
const axios   = require('axios');
const crypto  = require('crypto');
const { listAccounts } = require('../core/banking-store');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pad2 = (n) => String(n).padStart(2, '0');
const GRACE_DEFAULT = Number(process.env.STATEMENT_LATE_GRACE_DAYS) || 4;

const ordinal = (n) => { const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const lastDayOfMonth = (year, month1) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
function dateForDay(year, month1, day) {
  const d = Math.min(Math.max(1, day), lastDayOfMonth(year, month1));
  return `${year}-${pad2(month1)}-${pad2(d)}`;
}
const daysBetween = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

// The most recent month whose statement close-date (closeDay of that month) is ≥ grace days
// before `today` (YYYY-MM-DD). Returns { year, month1, closeDate, monthFirst, label } | null.
function mostRecentOverdueMonth(closeDay, today, grace = GRACE_DEFAULT) {
  let year = Number(today.slice(0, 4)), month1 = Number(today.slice(5, 7));
  for (let i = 0; i < 14; i++) {
    const closeDate = dateForDay(year, month1, closeDay);
    if (daysBetween(today, closeDate) >= grace) {
      return { year, month1, closeDate, monthFirst: `${year}-${pad2(month1)}-01`, label: `${MON[month1 - 1]} ${year}` };
    }
    month1--; if (month1 < 1) { month1 = 12; year--; }
  }
  return null;
}

// ── Groq: estimate the statement close-day for an institution (cached per process) ──
const _closeDayCache = new Map();
async function groqCloseDay(institution, type, deps = {}) {
  const ask = deps.groqAsk || _groqAsk;
  const cacheKey = `${(institution || '').toLowerCase()}|${(type || '').toLowerCase()}`;
  if (_closeDayCache.has(cacheKey)) return _closeDayCache.get(cacheKey);
  let day = null;
  try { day = await ask(institution, type); } catch { day = null; }
  if (!(day >= 1 && day <= 31)) day = null;
  _closeDayCache.set(cacheKey, day);
  return day;
}
async function _groqAsk(institution, type) {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here' || !institution) return null;
  const resp = await axios.post(GROQ_URL,
    { model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', max_tokens: 6, temperature: 0,
      messages: [{ role: 'user', content: `Around what day of the month does a ${type || 'bank'} account statement typically CLOSE at "${institution}"? Many cards close mid-month. Reply with ONLY a number 1-31 (best general estimate).` }] },
    { headers: { Authorization: 'Bearer ' + key }, timeout: 12000 });
  const n = Number((resp.data?.choices?.[0]?.message?.content || '').match(/\d+/)?.[0]);
  return Number.isFinite(n) ? n : null;
}

// Resolve the close-day for an account: Groq estimate, else fall back to ~month-end.
async function closeDayFor(account, deps = {}) {
  const g = await groqCloseDay(account.institution, account.type, deps);
  return g || 28;   // conservative fallback when Groq can't say → only nags after month-end+grace
}

let _schemaReady = false;
async function ensureSchema(query) {
  if (_schemaReady) return;
  await query(`CREATE TABLE IF NOT EXISTS statement_reminders (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT, close_date DATE,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_stmt_reminder ON statement_reminders(user_id, account_id, close_date)`);
  _schemaReady = true;
}

function formatReminder(it) {
  const who = `${it.institution || 'your bank'}${it.last4 ? ' ••' + it.last4 : ''}`;
  return `📅 Heads up — your ${who} ${it.monthLabel} statement looks overdue. It usually closes around the ${ordinal(it.closeDay)}, and it's been ${it.daysLate} day${it.daysLate === 1 ? '' : 's'} with no upload. Drop the PDF into CaiShen → Data Vault when you get a chance so I can reconcile it.`;
}

// The single most-recent overdue, not-yet-uploaded statement for one account (or null).
async function lateStatementForAccount(query, userId, account, today, deps = {}) {
  const grace = deps.grace != null ? deps.grace : GRACE_DEFAULT;
  const closeDay = await closeDayFor(account, deps);
  const m = mostRecentOverdueMonth(closeDay, today, grace);
  if (!m) return null;
  // Match by the deterministic statement id (works even when account_id wasn't resolved at index
  // time) OR by account_id + month for rows indexed with an account.
  const stmtId = `bstmt_${userId}_${account.last4 || 'noacct'}_${m.year}${pad2(m.month1)}`;
  const exists = await query(
    `SELECT 1 FROM bank_statements WHERE user_id=$1 AND (id=$2 OR (account_id=$3 AND statement_start_date=$4)) LIMIT 1`,
    [userId, stmtId, account.id, m.monthFirst]);
  if (exists.rows.length) return null;   // already uploaded for this month
  return { accountId: account.id, institution: account.institution, last4: account.last4, name: account.name,
    closeDay, monthLabel: m.label, closeDate: m.closeDate, daysLate: daysBetween(today, m.closeDate) };
}

// Check every eligible account for the user and SEND a (deduped) reminder for each overdue one.
// `send(text)` delivers one message. Returns the number of reminders sent.
async function sendReminders(query, userId, send, today, deps = {}) {
  await ensureSchema(query);
  // Eligible = connected accounts that get monthly statements (checking/savings + cards).
  const listAcc = deps.listAccounts || listAccounts;
  const accounts = (await listAcc(userId)).filter(a => a.accountClass === 'bank' || a.accountClass === 'card');
  if (!accounts.length) return 0;
  let sent = 0;
  for (const acct of accounts) {
    try {
      const late = await lateStatementForAccount(query, userId, acct, today, deps);
      if (!late) continue;
      const ins = await query(
        `INSERT INTO statement_reminders (id, user_id, account_id, close_date) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, account_id, close_date) DO NOTHING RETURNING id`,
        [`srem_${crypto.randomBytes(6).toString('hex')}`, userId, acct.id, late.closeDate]);
      if (!ins.rows.length) continue;   // already reminded for this account + close-date
      await send(formatReminder(late));
      sent++;
    } catch (e) { console.error('[stmt-reminder] account', acct.id, e.message); }
  }
  return sent;
}

module.exports = {
  mostRecentOverdueMonth, dateForDay, groqCloseDay, closeDayFor, lateStatementForAccount,
  sendReminders, formatReminder, ensureSchema, ordinal,
};
