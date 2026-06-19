'use strict';
// Tests for the auto-learned merchant alias rules (reconciler.js):
//   aliasToken — derives the canonical merchant token saved when the user
//                manually matches a pair (POST /api/reconcile/match)
//   aliasMatch — applies learned rules inside matchOne on every reconcile run
//   nameSim    — the shared-token gate; a rule is only learned when it's 0
const { aliasToken, aliasMatch, nameSim } = require('../banking/reconciler');

describe('aliasToken — merchant token derivation', () => {
  test('clean single merchant name', () => {
    expect(aliasToken('Walmart')).toBe('walmart');
  });

  test('keeps two words when contiguous in the text', () => {
    expect(aliasToken('WM SUPERCENTER #2403')).toBe('wm supercenter');
    expect(aliasToken("Dave's Hot Chicken")).toBe('daves hot');
  });

  test('falls back to one word when the next meaningful word is not adjacent', () => {
    // "steamgames wa" is not contiguous (".com 425-952-2985" sits between)
    expect(aliasToken('Steamgames.com 425-952-2985 WA')).toBe('steamgames');
  });

  test('skips noise words (pos/purchase/debit/com…)', () => {
    expect(aliasToken('POS PURCHASE WALMART')).toBe('walmart');
    expect(aliasToken('Steamgames.com')).toBe('steamgames');
  });

  test('empty when nothing meaningful remains', () => {
    expect(aliasToken('1234 5678')).toBe('');
    expect(aliasToken('')).toBe('');
    expect(aliasToken(null)).toBe('');
  });
});

describe('aliasMatch — applying learned rules', () => {
  const rules = [{ plaid: 'walmart', statement: 'wm supercenter', enabled: true }];

  test('learned pair matches future differently-named rows', () => {
    expect(aliasMatch('Walmart', 'WM SUPERCENTER #9912 PURCHASE 04/27', rules)).toBe(true);
  });

  test('both sides must hit', () => {
    expect(aliasMatch('Walmart', 'TARGET T-1234', rules)).toBe(false);
    expect(aliasMatch('Costco', 'WM SUPERCENTER #9912', rules)).toBe(false);
  });

  test('case/punctuation-insensitive', () => {
    expect(aliasMatch('WALMART.COM', 'Wm-Supercenter 0042', rules)).toBe(true);
  });

  test('disabled rules are ignored', () => {
    expect(aliasMatch('Walmart', 'WM SUPERCENTER', [{ ...rules[0], enabled: false }])).toBe(false);
  });

  test('word boundaries respected — no mid-word hits', () => {
    expect(aliasMatch('Stewart', 'WM SUPERCENTER', [{ plaid: 'art', statement: 'wm supercenter' }])).toBe(false);
  });

  test('no rules → no match', () => {
    expect(aliasMatch('Walmart', 'WM SUPERCENTER', [])).toBe(false);
  });
});

describe('nameSim — the learn-only-when-needed gate', () => {
  test('shared token → fuzzy matcher already handles it, no rule learned', () => {
    expect(nameSim('Chipotle', 'CHIPOTLE 2207 ONLINE')).toBeGreaterThan(0);
  });

  test('walmart vs wm supercenter shares no token → rule gets learned', () => {
    expect(nameSim('Walmart', 'WM SUPERCENTER')).toBe(0);
  });

  test('steam vs steamgames shares no token → rule gets learned', () => {
    expect(nameSim('Steam', 'Steamgames.com 425-952-2985 WA')).toBe(0);
  });
});
