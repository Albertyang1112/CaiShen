'use strict';
// Action-letter (notice) domain: manual account creation with the unconfirmed flag,
// action items, "done" completion, and the always-remind cadence.

const { _normalize } = require('../banking/notice-extract');
const notices = require('../banking/notices');
const { sendPaymentReminders } = require('../banking/payment-reminders');

const ETORO = {
  isActionNotice: true, noticeKind: 'unclaimed_property', institution: 'eToro',
  accountMask: '4794', accountKind: 'investment', reportedAmount: 330.01,
  amountAsOf: '2020-02-10', assetNote: 'Virtual Currency',
  actionRequired: 'Check the address-confirmation box, sign and return the letter (or call)',
  respondBy: '2026-05-29', consequenceDate: '2026-10-31',
  consequence: 'Funds will be reported to the State of California as unclaimed property',
  contactPhone: '888-271-8365', letterDate: '2026-04-29',
};

function mkIO(store = {}) {
  return { read: (f) => (f in store ? store[f] : null), write: (f, v) => { store[f] = v; }, _store: store };
}

describe('notice-extract normalization', () => {
  test('coerces amounts/masks, drops junk dates and unknown kinds', () => {
    const n = _normalize({ isActionNotice: true, noticeKind: 'weird', institution: ' eToro ',
      accountMask: 'XXXX4794', reportedAmount: '$330.01', respondBy: 'soon', letterDate: '2026-04-29' });
    expect(n.noticeKind).toBe('other');
    expect(n.institution).toBe('eToro');
    expect(n.accountMask).toBe('4794');
    expect(n.reportedAmount).toBe(330.01);
    expect(n.respondBy).toBeNull();
    expect(n.letterDate).toBe('2026-04-29');
  });
});

describe('recordNotice', () => {
  test('creates a manual investment account (unconfirmed) + an urgent action item', () => {
    const io = mkIO({ 'accounts.json': [], 'action_items.json': [] });
    const { accountId, actionId } = notices.recordNotice(io, 'u1', ETORO, { fileId: 'file_letter' });

    const acct = io._store['accounts.json'][0];
    expect(accountId).toBe('manual_etoro_4794');
    expect(acct).toMatchObject({ id: 'manual_etoro_4794', source: 'manual', institution: 'eToro',
      last4: '4794', type: 'investment', subtype: 'brokerage', balance: 330.01, unconfirmed: true });
    expect(acct.unconfirmedNote).toContain('Virtual Currency');

    const item = io._store['action_items.json'][0];
    expect(actionId).toBe(item.id);
    expect(item.status).toBe('open');
    expect(item.title).toContain('eToro');
    expect(item.title).toContain('••4794');
    expect(item.dueDate).toBe('2026-10-31');            // consequence date wins over the passed respond-by
    expect(item.urgent).toBe(true);                      // the 30-day window already passed
    expect(item.detail).toContain('respond ASAP');
    expect(item.detail).toContain('888-271-8365');
  });

  test('re-submitting the same letter upserts — no duplicate account or item', () => {
    const io = mkIO({ 'accounts.json': [], 'action_items.json': [] });
    notices.recordNotice(io, 'u1', ETORO, { fileId: 'f1' });
    notices.recordNotice(io, 'u1', ETORO, { fileId: 'f1' });
    expect(io._store['accounts.json']).toHaveLength(1);
    expect(io._store['action_items.json']).toHaveLength(1);
  });

  test('a done item stays done when the letter is re-parsed', () => {
    const io = mkIO({ 'accounts.json': [], 'action_items.json': [] });
    notices.recordNotice(io, 'u1', ETORO, {});
    notices.markDone(io, 'etoro');
    notices.recordNotice(io, 'u1', ETORO, {});
    expect(io._store['action_items.json'][0].status).toBe('done');
  });

  test('never touches Plaid accounts; informational letters record nothing', () => {
    const plaid = { id: 'plaid_x', source: 'plaid', institution: 'eToro', last4: '4794', balance: 5000 };
    const io = mkIO({ 'accounts.json': [plaid], 'action_items.json': [] });
    notices.recordNotice(io, 'u1', ETORO, {});
    expect(io._store['accounts.json'].find(a => a.id === 'plaid_x').balance).toBe(5000);   // untouched
    expect(io._store['accounts.json']).toHaveLength(2);                                    // manual added alongside

    const io2 = mkIO({ 'accounts.json': [], 'action_items.json': [] });
    const r = notices.recordNotice(io2, 'u1', { ..._nonAction() }, {});
    expect(r).toEqual({ accountId: null, actionId: null });
    function _nonAction() { return { ...ETORO, isActionNotice: false }; }
  });
});

describe('markDone', () => {
  test('token match, single-item shortcut, and ambiguity', () => {
    const io = mkIO({ 'action_items.json': [
      { id: 'a1', status: 'open', title: 'Respond to eToro unclaimed property notice (••4794)', detail: '' },
      { id: 'a2', status: 'open', title: 'Respond to Chase account closure notice', detail: '' },
    ] });
    expect(notices.markDone(io, 'etoro').done).toBe(true);
    expect(io._store['action_items.json'].find(i => i.id === 'a1').status).toBe('done');
    // one left → bare "done" completes it
    expect(notices.markDone(io, '').done).toBe(true);
    expect(notices.markDone(io, '').reason).toBe('none_open');
  });
  test('ambiguous text → options, nothing marked', () => {
    const io = mkIO({ 'action_items.json': [
      { id: 'a1', status: 'open', title: 'Respond to eToro notice', detail: '' },
      { id: 'a2', status: 'open', title: 'Respond to eToro closure', detail: '' },
    ] });
    const r = notices.markDone(io, 'etoro');
    expect(r.done).toBe(false);
    expect(r.options).toHaveLength(2);
  });
});

describe('action-item reminders', () => {
  const mkQuery = (log) => (sql, params) => {
    if (/CREATE TABLE|CREATE UNIQUE INDEX/.test(sql)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO payment_reminders_log/.test(sql)) {
      const key = params.slice(1, 6).join('|');
      if (log.has(key)) return Promise.resolve({ rows: [] });
      log.add(key);
      return Promise.resolve({ rows: [{ id: params[0] }] });
    }
    return Promise.resolve({ rows: [] });   // no insurance/tax rows in this test
  };

  test('nags weekly even with a far deadline (alwaysRemind); stops after done', async () => {
    const io = mkIO({ 'action_items.json': [], 'accounts.json': [] });
    notices.recordNotice(io, 'u1', ETORO, {});
    const log = new Set();
    const sent = [];
    const deps = {
      io,
      collectDueItems: async () => notices.listOpen(io).map(a => ({
        itemKind: 'action', itemId: a.id, dueDate: a.dueDate, amount: a.amount,
        label: a.title, detail: a.detail, alwaysRemind: true,
      })),
    };
    // Deadline 2026-10-31 is ~4 months out from 2026-07-07 — payment cadence would be
    // SILENT here; action items must still remind weekly.
    await sendPaymentReminders(mkQuery(log), 'u1', (m) => sent.push(m), '2026-07-07', deps);
    await sendPaymentReminders(mkQuery(log), 'u1', (m) => sent.push(m), '2026-07-08', deps);   // same ISO week → deduped
    await sendPaymentReminders(mkQuery(log), 'u1', (m) => sent.push(m), '2026-07-14', deps);   // next week → sends
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Action needed');
    expect(sent[0]).toContain('eToro');
    expect(sent[0]).toContain('reply "done"'.replace('reply', 'Reply'));

    notices.markDone(io, 'etoro');
    await sendPaymentReminders(mkQuery(log), 'u1', (m) => sent.push(m), '2026-07-21', deps);
    expect(sent).toHaveLength(2);                          // silence after done
  });
});
