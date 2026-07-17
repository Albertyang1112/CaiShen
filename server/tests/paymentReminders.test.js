'use strict';
// Payment reminder engine: pure cadence/bucket rules + a simulated date sweep proving the
// user's spec — silent >30d out, weekly <1 month, daily ≤1 week (overriding weekly),
// silence once paid, dedup within a bucket, weekly degrade for stale overdue items.

const { cadenceFor, bucketFor, isoWeek, sendPaymentReminders, formatPaymentReminder } = require('../banking/payment-reminders');

describe('cadenceFor', () => {
  test.each([
    [45, null],        // far out → silent
    [31, null],
    [30, 'weekly'],    // <1 month → weekly
    [8, 'weekly'],
    [7, 'daily'],      // ≤1 week → daily (overrides weekly)
    [1, 'daily'],
    [0, 'daily'],      // due today
    [-5, 'daily'],     // overdue → still daily
    [-30, 'daily'],
    [-31, 'weekly'],   // stale overdue → degrade to weekly
    [null, null],
  ])('daysUntilDue=%p → %p', (days, expected) => {
    expect(cadenceFor(days)).toBe(expected);
  });
});

describe('bucketFor / isoWeek', () => {
  test('daily bucket = calendar date; weekly bucket = ISO week', () => {
    expect(bucketFor('daily', '2026-07-06')).toBe('d2026-07-06');
    expect(bucketFor('weekly', '2026-07-06')).toBe('w' + isoWeek('2026-07-06'));
  });
  test('two days in the same week share the weekly bucket; a new week rolls it', () => {
    expect(bucketFor('weekly', '2026-07-06')).toBe(bucketFor('weekly', '2026-07-08'));   // Mon & Wed
    expect(bucketFor('weekly', '2026-07-06')).not.toBe(bucketFor('weekly', '2026-07-13'));
  });
});

describe('sendPaymentReminders — simulated date sweep', () => {
  // In-memory dedup log standing in for payment_reminders_log.
  const makeQuery = (log) => (sql, params) => {
    if (/CREATE TABLE|CREATE UNIQUE INDEX/.test(sql)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO payment_reminders_log/.test(sql)) {
      const key = params.slice(1, 6).join('|');
      if (log.has(key)) return Promise.resolve({ rows: [] });
      log.add(key);
      return Promise.resolve({ rows: [{ id: params[0] }] });
    }
    return Promise.resolve({ rows: [] });
  };

  // Sweep a date range daily (like the 12h loop, collapsed to one tick per day).
  async function sweep(from, to, itemsAt) {
    const log = new Set();
    const query = makeQuery(log);
    const sent = [];   // [date, message]
    let d = new Date(from + 'T12:00:00Z');
    const end = new Date(to + 'T12:00:00Z');
    while (d <= end) {
      const today = d.toISOString().slice(0, 10);
      await sendPaymentReminders(query, 'u1', (msg) => sent.push([today, msg]), today,
        { collectDueItems: async () => itemsAt(today) });
      d = new Date(d.getTime() + 86400000);
    }
    return sent;
  }

  test('weekly at 8-30 days, daily ≤7 days, silence after paid', async () => {
    const DUE = '2026-08-01';
    let paidOn = '2026-07-30';   // payment matches 2 days before due
    const itemsAt = (today) => today >= paidOn ? [] : [
      { itemKind: 'insurance', itemId: 'istmt_x', dueDate: DUE, amount: 412, label: 'GeoVera earthquake' },
    ];
    const sent = await sweep('2026-06-25', '2026-08-10', itemsAt);

    const before = sent.filter(([d]) => d < '2026-07-02');            // >30d out
    expect(before.length).toBe(0);

    const weekly = sent.filter(([d]) => d >= '2026-07-02' && d <= '2026-07-24');   // 30..8 days out
    expect(weekly.length).toBeGreaterThanOrEqual(3);                  // ~one per ISO week
    expect(weekly.length).toBeLessThanOrEqual(5);

    const daily = sent.filter(([d]) => d >= '2026-07-25' && d < paidOn);           // ≤7d → daily
    expect(daily.length).toBe(5);                                     // Jul 25..29, one per day
    expect(daily.every(([, m]) => m.includes('GeoVera'))).toBe(true);

    const after = sent.filter(([d]) => d >= paidOn);                  // paid → silence
    expect(after.length).toBe(0);
  });

  test('same-day double tick (12h loop) sends only once', async () => {
    const log = new Set();
    const query = makeQuery(log);
    const sent = [];
    const deps = { collectDueItems: async () => [{ itemKind: 'tax', itemId: 't1', dueDate: '2026-07-08', amount: 5000, label: '1st installment — LA County' }] };
    await sendPaymentReminders(query, 'u1', (m) => sent.push(m), '2026-07-06', deps);
    await sendPaymentReminders(query, 'u1', (m) => sent.push(m), '2026-07-06', deps);   // second 12h tick
    expect(sent.length).toBe(1);
  });

  test('stale overdue item degrades from daily back to weekly', async () => {
    const itemsAt = () => [{ itemKind: 'tax', itemId: 't2', dueDate: '2026-05-01', amount: 3000, label: 'Property tax' }];
    const sent = await sweep('2026-06-10', '2026-06-23', itemsAt);    // 40-53 days overdue
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThanOrEqual(3);                       // weekly-ish, NOT 14 dailies
  });
});

describe('formatPaymentReminder', () => {
  const io = { read: (f) => f === 'properties.json' ? [{ id: 'p1', name: 'Alcita' }] : null };
  test('names the bill, property, amount, and urgency', () => {
    const msg = formatPaymentReminder(
      { itemKind: 'insurance', label: 'GeoVera earthquake', amount: 412, dueDate: '2026-08-01', propertyId: 'p1' }, 5, io);
    expect(msg).toContain('GeoVera earthquake');
    expect(msg).toContain('(Alcita)');
    expect(msg).toContain('$412.00');
    expect(msg).toContain('5 days away');
    expect(msg).toContain('daily');
  });
  test('overdue wording', () => {
    const msg = formatPaymentReminder({ itemKind: 'tax', label: '1st installment', amount: 5000, dueDate: '2026-07-01' }, -3, io);
    expect(msg).toContain('3 days overdue');
  });
});
