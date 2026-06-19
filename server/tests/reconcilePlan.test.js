'use strict';
// Tests for planMatches (reconciler.js) — the tiered matching engine:
//   manual links → EXACT same-day+amount (unique both sides, names irrelevant)
//   → fuzzy fallback (shared name token / learned alias, ±$0.01, ±4 days).
const { planMatches } = require('../banking/reconciler');

const P = (id, date, desc, amount) => ({ id, date, desc, amount });
const S = (id, date, desc, amount) => ({ id, date, desc, amount });

// decisions keyed by statement id for easy lookup
function plan(stmt, plaid, opts) {
  const { decisions } = planMatches(stmt, plaid, opts);
  const byId = {};
  for (const d of decisions) byId[d.s.id] = d;
  return byId;
}

describe('exact pass — same day + exact amount, unique on both sides', () => {
  test('pairs differently-named merchants with no teaching (Walmart ↔ Wm Supercenter)', () => {
    const plaid = [P('p1', '2026-04-27', 'Walmart', -16.68), P('p2', '2026-04-15', 'Steam', -12.49)];
    const stmt  = [
      S('s1', '2026-04-27', 'Card Purchase With Pin 04/27 Wm Supercenter #5156', 16.68),
      S('s2', '2026-04-15', 'Steamgames.com 425-952-2985 WA', 12.49),
    ];
    const d = plan(stmt, plaid);
    expect(d.s1.m.p.id).toBe('p1');
    expect(d.s1.m.exact).toBe(true);
    expect(d.s2.m.p.id).toBe('p2');
    expect(d.s2.m.exact).toBe(true);
  });

  test('sign conventions ignored (statement positive vs Plaid negative)', () => {
    const d = plan([S('s1', '2026-04-27', 'WM SUPERCENTER', 3)], [P('p1', '2026-04-27', 'Walmart', -3)]);
    expect(d.s1.m.p.id).toBe('p1');
    expect(d.s1.m.exact).toBe(true);
  });

  test('different day → no exact match (names share nothing → unmatched)', () => {
    const d = plan([S('s1', '2026-04-28', 'WM SUPERCENTER', 16.68)], [P('p1', '2026-04-27', 'Walmart', -16.68)]);
    expect(d.s1.m).toBeNull();
  });

  test('different cents → no exact match', () => {
    const d = plan([S('s1', '2026-04-27', 'WM SUPERCENTER', 16.69)], [P('p1', '2026-04-27', 'Walmart', -16.68)]);
    expect(d.s1.m).toBeNull();
  });
});

describe('ambiguity — duplicates of (day, amount) fall back to the name system', () => {
  test('two same-day same-amount purchases pair by name, not arbitrarily', () => {
    const plaid = [P('p1', '2026-04-27', 'Starbucks', -5), P('p2', '2026-04-27', 'Dunkin', -5)];
    const stmt  = [
      S('s1', '2026-04-27', 'DUNKIN #341 BEAUMONT CA', 5),
      S('s2', '2026-04-27', 'STARBUCKS STORE 12208', 5),
    ];
    const d = plan(stmt, plaid);
    expect(d.s1.m.p.id).toBe('p2');           // Dunkin ↔ Dunkin
    expect(d.s2.m.p.id).toBe('p1');           // Starbucks ↔ Starbucks
    expect(d.s1.m.exact).toBeUndefined();     // fuzzy, not exact
  });

  test('ambiguous on the plaid side + no shared name → left unmatched for the popup', () => {
    const plaid = [P('p1', '2026-04-27', 'Walmart', -5), P('p2', '2026-04-27', 'Target', -5)];
    const d = plan([S('s1', '2026-04-27', 'WM SUPERCENTER', 5)], plaid);
    expect(d.s1.m).toBeNull();
  });

  test('learned alias resolves a same-day ambiguity', () => {
    const plaid   = [P('p1', '2026-04-27', 'Walmart', -5), P('p2', '2026-04-27', 'Target', -5)];
    const aliases = [{ plaid: 'walmart', statement: 'wm supercenter', enabled: true }];
    const d = plan([S('s1', '2026-04-27', 'WM SUPERCENTER', 5)], plaid, { aliases });
    expect(d.s1.m.p.id).toBe('p1');
    expect(d.s1.m.alias).toBe(true);
  });
});

describe('fuzzy fallback — date drift still works', () => {
  test('statement posts two days late, shared token matches', () => {
    const d = plan([S('s1', '2026-04-29', 'CHIPOTLE 2207 ONLINE', 11.2)], [P('p1', '2026-04-27', 'Chipotle', -11.2)]);
    expect(d.s1.m.p.id).toBe('p1');
    expect(d.s1.m.dd).toBe(2);
  });

  test('statement posts late + learned alias (no shared token)', () => {
    const aliases = [{ plaid: 'walmart', statement: 'wm supercenter', enabled: true }];
    const d = plan([S('s1', '2026-04-29', 'WM SUPERCENTER #5156', 16.68)], [P('p1', '2026-04-27', 'Walmart', -16.68)], { aliases });
    expect(d.s1.m.p.id).toBe('p1');
    expect(d.s1.m.alias).toBe(true);
  });
});

describe('phase ordering', () => {
  test('a fuzzy near-date claim cannot steal an exact same-day pair', () => {
    // s1 (4-26 Walmart) would fuzzy-claim p1 (4-27) if processed first; the exact
    // phase must give p1 to s2 (same day, exact amount) before fuzzy runs.
    const plaid = [P('p1', '2026-04-27', 'Walmart', -5)];
    const stmt  = [
      S('s1', '2026-04-26', 'WALMART STORE 99', 5),
      S('s2', '2026-04-27', 'WM SUPERCENTER', 5),
    ];
    const d = plan(stmt, plaid);
    expect(d.s2.m.p.id).toBe('p1');
    expect(d.s2.m.exact).toBe(true);
    expect(d.s1.m).toBeNull();
  });

  test('a manual link beats the exact pass', () => {
    const plaid = [P('p1', '2026-04-27', 'Walmart', -5), P('p2', '2026-04-25', 'Refund', 5)];
    const stmt  = [S('s1', '2026-04-27', 'WM SUPERCENTER', 5)];
    const manualPlaidFor = new Map([['s1', 'p2']]);
    const d = plan(stmt, plaid, { manualPlaidFor });
    expect(d.s1.m.p.id).toBe('p2');
    expect(d.s1.manual).toBe(true);
  });
});
