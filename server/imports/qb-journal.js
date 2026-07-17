'use strict';
/**
 * imports/qb-journal.js — the QB Journal export → CaiShen data, pure logic.
 *
 * The Journal is the ONE transaction source (the General Ledger repeats every txn once
 * per account it touches and is used only as a verification answer key). Sheet layout:
 * an entry starts on a row with a Date, its remaining legs follow on date-less rows,
 * and a label-less row carrying only the debit+credit totals closes it.
 *
 * Conversion rule ("a display transaction exists for every leg on a real bank/CC
 * account; the opposite leg supplies the category"):
 *   • 1 financial leg           → one txn per category leg (QB splits stay exact),
 *                                 coaId = that category's chart node.
 *   • ≥2 financial legs         → a linked transfer pair: one txn per financial leg,
 *                                 category 'Transfer' + NO coaId, which the report layer
 *                                 already excludes (auto-categorize.isTransfer).
 *   • 0 financial legs          → an accounting journal entry (journal_entries.json) so
 *                                 pure adjustments still reach the P&L / balance sheet.
 *
 * Signs: leg amount = debit − credit. On a bank account a deposit is a debit (+) and a
 * payment a credit (−); on a credit card a purchase is a credit (−) — all matching the
 * app's Plaid display convention without special-casing.
 *
 * Ids are content hashes (date|account|amount|memo|occurrence) — re-importing the same
 * file yields byte-identical ids, so the whole import is idempotent by construction.
 */
const crypto = require('crypto');
const { isBlankRow, cellStr, cellNum } = require('./xlsx-parse');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);

function toIsoDate(v) {
  if (v == null || v === '') return null;
  const s = cellStr(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** Journal sheet rows → grouped entries [{date, txnType, num, name, memo, legs:[{account, debit, credit, memo, name}]}] */
function groupJournalEntries(rows, header) {
  const hi = header?.rowIndex ?? 4;
  const c = { date: 1, txnType: 2, num: 3, name: 4, memo: 5, account: 6, debit: 7, credit: 8, ...(header?.cols || {}) };
  const entries = [];
  let cur = null;
  for (let i = hi + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (isBlankRow(row)) continue;
    const date = toIsoDate(row[c.date]);
    const account = cellStr(row[c.account]);
    if (date) {                                        // new entry begins
      if (cur && cur.legs.length) entries.push(cur);
      cur = {
        date, txnType: cellStr(row[c.txnType]), num: cellStr(row[c.num]),
        name: cellStr(row[c.name]), memo: cellStr(row[c.memo]), legs: [],
      };
    }
    if (!cur) continue;                                // banner/footer noise before first entry
    if (account) {
      cur.legs.push({
        account, debit: cellNum(row[c.debit]) || 0, credit: cellNum(row[c.credit]) || 0,
        memo: cellStr(row[c.memo]) || cur.memo, name: cellStr(row[c.name]) || cur.name,
      });
    }
    // account-less row with numbers = the entry's total line → close it
    else if (!date && (cellNum(row[c.debit]) !== null || cellNum(row[c.credit]) !== null)) {
      if (cur.legs.length) entries.push(cur);
      cur = null;
    }
  }
  if (cur && cur.legs.length) entries.push(cur);
  return entries;
}

/**
 * Entries → { txns, journalEntries, transferGroups }.
 * @param {Map} financialByPath  QB account path (exact string) → { accountId, institution }
 * @param {Map} coaIdByPath      QB account path → chart node id (for category + JE legs)
 * @param {function} ensureCoaId called for a path with no node yet (creates on the fly)
 */
function convertEntries(entries, { financialByPath, coaIdByPath, ensureCoaId, coaNameById = new Map() }) {
  const txns = [], journalEntries = [];
  const seen = new Map();                               // fingerprint → occurrence counter
  const nextId = (parts) => {
    const fp = parts.join('|');
    const n = (seen.get(fp) || 0) + 1;
    seen.set(fp, n);
    return `qb_${sha(`${fp}|${n}`)}`;
  };
  const leafName = (coaId) => coaNameById.get(coaId) || null;
  let transferGroups = 0;

  for (const e of entries) {
    const fin = [], cat = [];
    for (const leg of e.legs) (financialByPath.has(leg.account) ? fin : cat).push(leg);

    if (!fin.length) {
      // Pure adjustment — becomes an accounting journal entry on chart nodes.
      const lines = e.legs.map(l => ({ accountId: coaIdByPath.get(l.account) || ensureCoaId(l.account), debit: l.debit || 0, credit: l.credit || 0 }));
      journalEntries.push({
        id: `je_${sha(`${e.date}|${e.txnType}|${e.memo}|${e.legs.map(l => `${l.account}:${l.debit}:${l.credit}`).join(';')}`)}`,
        date: e.date, description: e.memo || e.name || e.txnType || 'QuickBooks entry',
        lines, source: 'quickbooks', createdAt: new Date().toISOString(),
      });
      continue;
    }

    const month = e.date.slice(0, 7);
    const base = (leg, amount) => {
      const acct = financialByPath.get(leg.account);
      return {
        date: e.date, month, amount: Math.round(amount * 100) / 100,
        desc: leg.memo || e.memo || e.name || e.txnType || leg.account,
        account: acct.accountId, institution: acct.institution || '',
        source: 'quickbooks', currency: 'USD',
        transactionType: e.txnType || '', checkNumber: e.num || '',
        merchantName: leg.name || e.name || '',
        ...(leg.name || e.name ? { vendor: leg.name || e.name, vendorAuto: false } : {}),
        lastUpdated: new Date().toISOString(),
      };
    };

    if (fin.length >= 2) {
      // Self-transfer: one txn per financial leg, linked, excluded from reports.
      transferGroups++;
      const group = `qbtr_${sha(`${e.date}|${fin.map(l => `${l.account}:${l.debit}:${l.credit}`).join(';')}`)}`;
      for (const leg of fin) {
        const amount = leg.debit - leg.credit;
        const other = fin.find(l => l !== leg);
        txns.push({
          ...base(leg, amount), category: 'Transfer', transferGroup: group,
          id: nextId([e.date, leg.account, amount, leg.memo || e.memo]),
          desc: leg.memo || e.memo || `Transfer ${amount >= 0 ? 'from' : 'to'} ${other ? other.account : 'account'}`,
        });
      }
      continue;
    }

    // One financial leg. One txn per category leg keeps QB splits exact; the category
    // leg's sign is inverted onto the bank side (bank credit 100 vs expense debits 60+40
    // → txns of −60 and −40). No category legs (rare) → single uncategorized txn.
    const leg = fin[0];
    if (!cat.length) {
      const amount = leg.debit - leg.credit;
      txns.push({ ...base(leg, amount), category: 'Other', id: nextId([e.date, leg.account, amount, leg.memo || e.memo]) });
      continue;
    }
    const split = cat.length > 1;
    for (const cl of cat) {
      const amount = -(cl.debit - cl.credit);
      const coaId = coaIdByPath.get(cl.account) || ensureCoaId(cl.account);
      txns.push({
        ...base(leg, amount), coaId, coaAuto: false,
        category: leafName(coaId) || cl.account.split(':').pop(),
        desc: cl.memo || e.memo || e.name || cl.account,
        ...(split ? { isSplit: true, splitNote: `QB split (${cat.length} lines): ${e.memo || e.txnType}` } : {}),
        id: nextId([e.date, leg.account, amount, cl.account, cl.memo || e.memo]),
      });
    }
  }
  return { txns, journalEntries, transferGroups };
}

module.exports = { groupJournalEntries, convertEntries, toIsoDate };
