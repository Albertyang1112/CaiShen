const { ruleMatches, applyRules, suggestKeyword } = require('../categorize');

describe('ruleMatches', () => {
  const tx = { desc: 'SHELL OIL 12345 LA', vendor: 'Shell', plaidCategory: 'TRANSPORTATION' };
  test('contains (default), case-insensitive', () => {
    expect(ruleMatches(tx, { value: 'shell oil', coaId: 'x' })).toBe(true);
    expect(ruleMatches(tx, { value: 'CHEVRON',   coaId: 'x' })).toBe(false);
  });
  test('equals / startsWith', () => {
    expect(ruleMatches(tx, { field: 'vendor', op: 'equals', value: 'shell', coaId: 'x' })).toBe(true);
    expect(ruleMatches(tx, { op: 'startsWith', value: 'shell', coaId: 'x' })).toBe(true);
    expect(ruleMatches(tx, { op: 'startsWith', value: 'oil',   coaId: 'x' })).toBe(false);
  });
  test('disabled rule / empty value / missing coaId never match', () => {
    expect(ruleMatches(tx, { value: 'shell', coaId: 'x', enabled: false })).toBe(false);
    expect(ruleMatches(tx, { value: '',      coaId: 'x' })).toBe(false);
    expect(ruleMatches(tx, { value: 'shell' })).toBe(false);
  });
  test('can match the plaidCategory field', () => {
    expect(ruleMatches(tx, { field: 'plaidCategory', op: 'equals', value: 'transportation', coaId: 'x' })).toBe(true);
  });
});

describe('applyRules', () => {
  const rules = [
    { id: 'r1', value: 'shell',       coaId: 'x5040' },
    { id: 'r2', value: 'whole foods', coaId: 'x5110' },
  ];
  const txs = [
    { id: 't1', desc: 'SHELL OIL 123 LA', amount: -40 },                  // matches r1
    { id: 't2', desc: 'WHOLE FOODS MKT',  amount: -60, coaId: 'manual' }, // already categorized
    { id: 't3', desc: 'SHELL OIL 999',    amount: -30, excluded: true },  // excluded
    { id: 't4', desc: 'STARBUCKS',        amount: -5 },                   // no match
  ];
  test('fills only uncategorized, non-excluded txns; first match wins', () => {
    const { transactions, count, byRule } = applyRules(txs, rules);
    const byId = Object.fromEntries(transactions.map(t => [t.id, t]));
    expect(byId.t1.coaId).toBe('x5040');    // newly categorized
    expect(byId.t2.coaId).toBe('manual');   // untouched (already set)
    expect(byId.t3.coaId).toBeUndefined();  // excluded, untouched
    expect(byId.t4.coaId).toBeUndefined();  // no rule matched
    expect(count).toBe(1);
    expect(byRule).toEqual({ r1: 1 });
  });
  test('overwrite:true re-applies over an existing coaId', () => {
    const { transactions, count } = applyRules(
      [{ id: 'a', desc: 'WHOLE FOODS', coaId: 'old' }], rules, { overwrite: true });
    expect(transactions[0].coaId).toBe('x5110');
    expect(count).toBe(1);
  });
  test('no-op when coaId already equals the rule target', () => {
    const { count } = applyRules([{ id: 'a', desc: 'SHELL', coaId: 'x5040' }], rules, { overwrite: true });
    expect(count).toBe(0);
  });
});

describe('suggestKeyword', () => {
  test('extracts a stable merchant keyword from noisy descriptions', () => {
    expect(suggestKeyword('SHELL OIL 57444103 LOS ANGELES CA')).toBe('SHELL OIL');
    expect(suggestKeyword('WHOLE FOODS MKT #123 AUSTIN TX')).toBe('WHOLE FOODS');
    expect(suggestKeyword('SQ *BLUE BOTTLE COFFEE')).toBe('BLUE BOTTLE');
    expect(suggestKeyword('')).toBe('');
  });
});
