'use strict';
// Overdue-statement reminder logic (banking/statement-reminder.js). No network/DB: the query,
// Groq close-day, and listAccounts are all injected/faked.
const r = require('../banking/statement-reminder');

describe('mostRecentOverdueMonth', () => {
  test("the user's example: as of 7/19 with a 15th close + 4d grace → July is overdue", () => {
    expect(r.mostRecentOverdueMonth(15, '2026-07-19', 4)).toMatchObject({
      year: 2026, month1: 7, closeDate: '2026-07-15', monthFirst: '2026-07-01', label: 'July 2026',
    });
  });
  test('exactly at grace vs one short', () => {
    expect(r.mostRecentOverdueMonth(15, '2026-07-19', 4).month1).toBe(7);   // 4 days past 7/15
    expect(r.mostRecentOverdueMonth(15, '2026-07-18', 4).month1).toBe(6);   // only 3 days past → June
  });
  test('before this month closes → the prior month', () => {
    expect(r.mostRecentOverdueMonth(15, '2026-07-10', 4).label).toBe('June 2026');
  });
  test('rolls across the year boundary', () => {
    expect(r.mostRecentOverdueMonth(15, '2026-01-03', 4).label).toBe('December 2025');
  });
});

describe('dateForDay clamps to the month length', () => {
  test('day 31 in February (non-leap) → the 28th', () => { expect(r.dateForDay(2026, 2, 31)).toBe('2026-02-28'); });
  test('day 31 in April → the 30th', () => { expect(r.dateForDay(2026, 4, 31)).toBe('2026-04-30'); });
  test('a normal day passes through', () => { expect(r.dateForDay(2026, 7, 15)).toBe('2026-07-15'); });
});

describe('sendReminders', () => {
  const cardAcct = [{ id: 'acc1', institution: 'Chase', last4: '1234', name: 'Chase', type: 'credit', accountClass: 'card' }];
  function fakeDb({ uploadedMonths = [] }) {
    const reminded = new Set();
    return async (sql, params = []) => {
      const S = String(sql).replace(/\s+/g, ' ').trim();
      if (S.startsWith('CREATE TABLE') || S.startsWith('CREATE UNIQUE INDEX')) return { rows: [] };
      if (S.includes('FROM bank_statements WHERE user_id=$1 AND (id=$2 OR (account_id=$3 AND statement_start_date=$4))'))
        return { rows: uploadedMonths.includes(params[3]) ? [{ ok: 1 }] : [] };   // $4 = monthFirst
      if (S.startsWith('INSERT INTO statement_reminders')) {
        const key = `${params[2]}|${params[3]}`;
        if (reminded.has(key)) return { rows: [] };       // dedup
        reminded.add(key); return { rows: [{ id: params[0] }] };
      }
      return { rows: [] };
    };
  }
  const deps = (over = {}) => ({ listAccounts: async () => cardAcct, groqAsk: async () => 15, grace: 4, ...over });

  test('overdue + not uploaded → sends once, then dedups on a repeat run', async () => {
    const db = fakeDb({ uploadedMonths: [] });
    const sent = [];
    expect(await r.sendReminders(db, 'u1', t => sent.push(t), '2026-07-19', deps())).toBe(1);
    expect(sent[0]).toMatch(/Chase ••1234 July 2026 statement looks overdue/);
    expect(sent[0]).toMatch(/4 days/);
    expect(await r.sendReminders(db, 'u1', t => sent.push(t), '2026-07-19', deps())).toBe(0);   // same close-date → deduped
  });
  test('statement already uploaded → no reminder', async () => {
    const db = fakeDb({ uploadedMonths: ['2026-07-01'] });
    expect(await r.sendReminders(db, 'u1', () => {}, '2026-07-19', deps())).toBe(0);
  });
  test('no checking/savings/card accounts → nothing checked', async () => {
    const db = fakeDb({ uploadedMonths: [] });
    const investmentOnly = async () => [{ id: 'x', accountClass: 'investment' }];
    expect(await r.sendReminders(db, 'u1', () => {}, '2026-07-19', deps({ listAccounts: investmentOnly }))).toBe(0);
  });
});
