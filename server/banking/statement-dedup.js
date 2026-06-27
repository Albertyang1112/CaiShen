'use strict';
/**
 * banking/statement-dedup.js — decide what to do when a bank statement is re-ingested for an
 * (account, period) that already has parsed rows from a DIFFERENT file. Without this, a
 * re-scan saved under a new filename produces a fresh set of source_transactions ids
 * (the id includes the source_file) and DOUBLE-COUNTS the period; a tampered re-upload
 * would silently replace the original.
 *
 * Reuses the vault's fudge heuristic: for each new row find same-date rows in the prior
 * set; if the closest amount differs by > $0.02 it's a "fudge"; >= 20% of date-matched
 * rows fudged (with >= 2 compared) ⇒ possible tampering.
 *
 * decide(newRows, priorRows) → { decision, fudgeCount, dateMatched, sameRatio }
 *   'new'       — no prior rows (first statement for the period)
 *   'duplicate' — every new row already exists (same date+amount) ⇒ idempotent re-upload
 *   'changed'   — differs but looks like a correction (low fudge ratio) ⇒ supersede
 *   'fudge'     — high same-date amount-mismatch ratio ⇒ flag, keep the original
 *
 * Pure — no DB. rows: [{ date, amount }].
 */
const CENTS = 0.02;
const amtKey = (r) => `${r.date}|${Math.abs(Number(r.amount)).toFixed(2)}`;

function decide(newRows, priorRows) {
  newRows = Array.isArray(newRows) ? newRows : [];
  priorRows = Array.isArray(priorRows) ? priorRows : [];
  if (!priorRows.length) return { decision: 'new', fudgeCount: 0, dateMatched: 0, sameRatio: 0 };

  const priorKeys = new Set(priorRows.map(amtKey));
  const byDate = new Map();
  for (const r of priorRows) {
    const d = String(r.date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(Math.abs(Number(r.amount)));
  }

  let exactSame = 0, dateMatched = 0, fudgeCount = 0;
  for (const r of newRows) {
    const amt = Math.abs(Number(r.amount));
    if (priorKeys.has(amtKey(r))) exactSame++;
    const sameDate = byDate.get(String(r.date));
    if (sameDate && sameDate.length) {
      dateMatched++;
      const minDiff = Math.min(...sameDate.map(a => Math.abs(a - amt)));
      if (minDiff > CENTS) fudgeCount++;
    }
  }

  const sameRatio = newRows.length ? exactSame / newRows.length : 0;
  if (sameRatio >= 0.999) return { decision: 'duplicate', fudgeCount, dateMatched, sameRatio };
  const isFudge = dateMatched >= 2 && (fudgeCount / dateMatched) >= 0.20;
  return { decision: isFudge ? 'fudge' : 'changed', fudgeCount, dateMatched, sameRatio };
}

module.exports = { decide };
