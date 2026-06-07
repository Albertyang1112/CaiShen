const { stageAndImport, PLAID_CSV } = require('../plaid');

// In-memory stand-in for the per-user raw-text I/O (makeIO's readText/writeText).
function fakeTextIO() {
  const store = {};
  return { store, readText: f => (f in store ? store[f] : null), writeText: (f, t) => { store[f] = t; } };
}

const plaidRow = (over = {}) => ({
  id: 'p1', date: '2024-01-01', month: '2024-01', desc: 'Coffee', amount: -5,
  category: 'Dining', plaidCategory: 'FOOD_AND_DRINK', account: 'a1',
  institution: 'Chase', pending: false, source: 'plaid', lastUpdated: 'old', ...over,
});

describe('Plaid CSV staging-layer import', () => {
  test('preserves user fields (coaId/note/reconciled) across re-sync, by id', () => {
    const io = fakeTextIO();
    const existing = [
      // already-categorized Plaid tx
      { ...plaidRow(), coaId: '5040', note: 'work expense', reconciled: true },
      // a manual tx that must be left completely alone
      { id: 'm1', date: '2024-01-02', desc: 'Manual entry', amount: 100, source: 'manual', coaId: '4000' },
    ];
    // Fresh pull: p1 comes back with updated amount + desc (and NO user fields)
    const plaidTxs = [plaidRow({ amount: -5.25, desc: 'Coffee Shop', lastUpdated: 'new' })];

    const result = stageAndImport({ existing, plaidTxs, readText: io.readText, writeText: io.writeText });
    const byId = Object.fromEntries(result.map(t => [t.id, t]));

    // Plaid refreshed the bank-owned fields...
    expect(byId.p1.amount).toBeCloseTo(-5.25);
    expect(byId.p1.desc).toBe('Coffee Shop');
    // ...but the user-owned fields survived the round-trip.
    expect(byId.p1.coaId).toBe('5040');
    expect(byId.p1.note).toBe('work expense');
    expect(byId.p1.reconciled).toBe(true);
    // Manual tx untouched.
    expect(byId.m1).toMatchObject({ source: 'manual', amount: 100, coaId: '4000' });
    // No duplicates introduced.
    expect(result).toHaveLength(2);
  });

  test('writes the CSV with only raw columns (no user fields leak into the file)', () => {
    const io = fakeTextIO();
    const existing = [{ ...plaidRow(), coaId: '5040', note: 'secret' }];
    const plaidTxs = [plaidRow()];

    stageAndImport({ existing, plaidTxs, readText: io.readText, writeText: io.writeText });
    const text = io.store[PLAID_CSV];

    expect(text).toBeTruthy();
    expect(text.split('\n')[0]).toBe('id,date,month,desc,amount,category,plaidCategory,account,institution,pending,source,lastUpdated');
    expect(text).not.toContain('coaId');   // user fields are never serialized to CSV
    expect(text).not.toContain('secret');
  });

  test('coerces amount->number and pending->boolean after the CSV round-trip', () => {
    const io = fakeTextIO();
    const plaidTxs = [plaidRow({ id: 'p2', amount: -12.5, pending: true })];

    const [tx] = stageAndImport({ existing: [], plaidTxs, readText: io.readText, writeText: io.writeText });

    expect(typeof tx.amount).toBe('number');
    expect(tx.amount).toBeCloseTo(-12.5);
    expect(tx.pending).toBe(true);
  });

  test('descriptions with commas survive (the reason CSV quoting matters)', () => {
    const io = fakeTextIO();
    const plaidTxs = [plaidRow({ id: 'p3', desc: 'SQ *COFFEE, BAR & GRILL' })];

    const [tx] = stageAndImport({ existing: [], plaidTxs, readText: io.readText, writeText: io.writeText });

    expect(tx.desc).toBe('SQ *COFFEE, BAR & GRILL');
    expect(io.store[PLAID_CSV]).toContain('"SQ *COFFEE, BAR & GRILL"');
  });

  test('carries forward other institutions and out-of-window history', () => {
    const io = fakeTextIO();
    const existing = [
      plaidRow({ id: 'chase1', institution: 'Chase' }),
      plaidRow({ id: 'boa1',   institution: 'BOA', coaId: '6000' }),  // different institution
    ];
    // Re-sync of Chase only; its pull no longer includes chase1 (fell out of window).
    const plaidTxs = [plaidRow({ id: 'chase2', institution: 'Chase' })];

    const result = stageAndImport({ existing, plaidTxs, readText: io.readText, writeText: io.writeText });
    const ids = result.map(t => t.id).sort();

    // BOA tx kept (with its category), chase1 history kept, chase2 added — nothing lost.
    expect(ids).toEqual(['boa1', 'chase1', 'chase2']);
    expect(result.find(t => t.id === 'boa1').coaId).toBe('6000');
  });
});
