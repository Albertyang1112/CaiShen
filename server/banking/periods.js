'use strict';
/**
 * banking/periods.js — find-or-create a bank_account_period (one statement cycle /
 * calendar month per account). Shared by every ingest path (Plaid sync, statement
 * upload, receipt upload) so they all bucket activity into the SAME period rows.
 *
 * The period id is deterministic — `per_{user}_{account|noacct}_{YYYYMM}` — and
 * matches the ids the Increment-2 backfill created. So live Plaid activity merges into
 * the very period a statement already established for that month, and ON CONFLICT DO
 * NOTHING never downgrades an existing 'finalized' statement period back to 'open'.
 */
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' (or any leading 'YYYY-MM…') → { year, month } | null
function ymOf(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr);
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  if (!year || !month || month < 1 || month > 12) return null;
  return { year, month };
}

/** Deterministic period id for (account, date) — pure, no DB. Null if date unusable. */
function periodIdFor(userId, accountId, dateStr) {
  const ym = ymOf(dateStr);
  return ym ? `per_${userId}_${accountId || 'noacct'}_${ym.year}${pad2(ym.month)}` : null;
}

/** Full period row fields (id + calendar-month bounds + label) — pure, no DB. */
function periodFields(userId, accountId, dateStr) {
  const ym = ymOf(dateStr);
  if (!ym) return null;
  const { year, month } = ym;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();   // month is 1-based → last day
  return {
    id: `per_${userId}_${accountId || 'noacct'}_${year}${pad2(month)}`,
    start: `${year}-${pad2(month)}-01`,
    end: `${year}-${pad2(month)}-${pad2(lastDay)}`,
    label: `${MON_ABBR[month - 1]} ${year}`,
  };
}

/**
 * Ensure the period for (account, date) exists; returns its id (null if date unusable).
 * New periods are created 'open'; an existing period (e.g. a finalized statement cycle
 * from the backfill) is left untouched. `query` is the db.query function (or a client's).
 */
async function findOrCreatePeriod(query, userId, accountId, dateStr) {
  const p = periodFields(userId, accountId, dateStr);
  if (!p) return null;
  await query(
    `INSERT INTO bank_account_periods (id, user_id, account_id, start_date, end_date, label, status)
     VALUES ($1,$2,$3,$4,$5,$6,'open') ON CONFLICT (id) DO NOTHING`,
    [p.id, userId, accountId, p.start, p.end, p.label]
  );
  return p.id;
}

module.exports = { periodIdFor, periodFields, findOrCreatePeriod, ymOf, MON_ABBR };
