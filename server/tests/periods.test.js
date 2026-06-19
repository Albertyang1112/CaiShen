const { periodIdFor, periodFields, ymOf } = require('../banking/periods');

describe('banking/periods — deterministic period derivation', () => {
  test('periodIdFor builds per_{user}_{account}_{YYYYMM}', () => {
    expect(periodIdFor('u1', 'acc1', '2026-05-24')).toBe('per_u1_acc1_202605');
    expect(periodIdFor('1779502545957', 'pJKb', '2026-02-07')).toBe('per_1779502545957_pJKb_202602');
  });

  test('periodIdFor falls back to "noacct" when there is no account', () => {
    expect(periodIdFor('u1', null, '2026-05-24')).toBe('per_u1_noacct_202605');
    expect(periodIdFor('u1', undefined, '2026-05-24')).toBe('per_u1_noacct_202605');
  });

  test('periodIdFor returns null for an unusable date', () => {
    expect(periodIdFor('u1', 'acc1', null)).toBeNull();
    expect(periodIdFor('u1', 'acc1', '')).toBeNull();
    expect(periodIdFor('u1', 'acc1', 'not-a-date')).toBeNull();
    expect(periodIdFor('u1', 'acc1', '2026-13-01')).toBeNull();   // month out of range
  });

  test('the live period id matches the Increment-2 backfill id scheme (so they merge)', () => {
    // Backfill created `per_{user}_{account}_{YYYY}{MM}` for statement months; a Plaid
    // txn in the same month must resolve to the exact same id.
    expect(periodIdFor('1779502545957', 'pJKb', '2026-05-15'))
      .toBe('per_1779502545957_pJKb_202605');
  });

  test('periodFields returns calendar-month bounds + label', () => {
    expect(periodFields('u1', 'acc1', '2026-02-15')).toEqual({
      id: 'per_u1_acc1_202602', start: '2026-02-01', end: '2026-02-28', label: 'Feb 2026',
    });
  });

  test('periodFields handles leap February and December correctly', () => {
    expect(periodFields('u1', 'acc1', '2024-02-10').end).toBe('2024-02-29'); // leap year
    expect(periodFields('u1', 'acc1', '2026-12-31')).toEqual({
      id: 'per_u1_acc1_202612', start: '2026-12-01', end: '2026-12-31', label: 'Dec 2026',
    });
  });

  test('ymOf parses the leading YYYY-MM and rejects junk', () => {
    expect(ymOf('2026-07-04')).toEqual({ year: 2026, month: 7 });
    expect(ymOf('2026-00-04')).toBeNull();
    expect(ymOf(null)).toBeNull();
  });
});
