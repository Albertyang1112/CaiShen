'use strict';
// Tests for banking/categorizer-core.js — the transport-free categorizer brain.
// No real DB/network: `query` and `io` are tiny in-memory fakes, and the Groq parser
// is injected as a stub. Category ids come from the real hierarchical chart.

const {
  money, dateShort, isConfirm, isSkip, coaPath, coaScope, dominantBucket, merchantKey,
  suggestionFor, recordConfirmation, enqueueQuestions, handleReply,
  matchCategories, isTransferIntent,
} = require('../banking/categorizer-core');
const { buildDefaultChart, idForPath } = require('../accounting/categories');

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// ── a minimal in-memory stand-in for core/db.query ───────────────────────────
function makeDb(seed = {}) {
  const db = {
    txn_messages: (seed.txn_messages || []).map((m, i) => ({ created_at: i, ...m })),
    categorization_memory: seed.categorization_memory || [],
    users: seed.users || [],
  };
  let seq = db.txn_messages.length;
  const calls = [];
  async function query(sql, params = []) {
    const S = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: S, params });

    if (S.startsWith('SELECT display_name, username FROM users')) {
      const u = db.users.find(x => x.id === params[0]);
      return { rows: u ? [clone(u)] : [] };
    }
    if (S.startsWith('SELECT * FROM txn_messages') && S.includes("state IN ('open','asked')")) {
      const row = db.txn_messages
        .filter(m => m.user_id === params[0] && ['open', 'asked'].includes(m.state))
        .sort((a, b) => a.created_at - b.created_at)[0];
      return { rows: row ? [clone(row)] : [] };
    }
    if (S.startsWith('SELECT transaction_id FROM txn_messages')) {
      return { rows: db.txn_messages.filter(m => m.user_id === params[0]).map(m => ({ transaction_id: m.transaction_id })) };
    }
    if (S.startsWith('INSERT INTO txn_messages')) {
      db.txn_messages.push({ id: params[0], user_id: params[1], transaction_id: params[2], channel: params[3],
        kind: 'confirm', state: 'open', payload: params[4], created_at: seq++ });
      return { rows: [] };
    }
    if (S.startsWith("UPDATE txn_messages SET state='asked'")) {
      const m = db.txn_messages.find(x => x.id === params[0]); if (m) m.state = 'asked';
      return { rows: [] };
    }
    if (S.startsWith('UPDATE txn_messages SET state=COALESCE')) {
      const m = db.txn_messages.find(x => x.id === params[0]);
      if (m) { if (params[1] != null) m.state = params[1]; if (params[2] != null) m.payload = params[2]; }
      return { rows: [] };
    }
    if (S.startsWith('SELECT bucket, SUM(times_confirmed)')) {
      const rows = db.categorization_memory.filter(m => m.user_id === params[0] && m.account === params[1]);
      const agg = {}; for (const r of rows) agg[r.bucket] = (agg[r.bucket] || 0) + (r.times_confirmed || 0);
      return { rows: Object.entries(agg).map(([bucket, n]) => ({ bucket, n })) };
    }
    if (S.startsWith('SELECT * FROM categorization_memory')) {   // memoryLookup
      const [uid, acct, desc] = params;
      const rows = db.categorization_memory.filter(m =>
        m.user_id === uid && m.account === acct &&
        String(desc).toUpperCase().includes(String(m.merchant_pattern).toUpperCase()));
      rows.sort((a, b) => (b.times_confirmed || 0) - (a.times_confirmed || 0));
      return { rows: rows.length ? [clone(rows[0])] : [] };
    }
    if (S.startsWith('SELECT id FROM categorization_memory')) {  // recordConfirmation existing
      const [uid, acct, pat, coa] = params;
      const m = db.categorization_memory.find(x =>
        x.user_id === uid && (x.account || null) === (acct || null) && x.merchant_pattern === pat && x.coa_id === coa);
      return { rows: m ? [{ id: m.id }] : [] };
    }
    if (S.startsWith('UPDATE categorization_memory SET times_confirmed=times_confirmed+1')) {
      const m = db.categorization_memory.find(x => x.id === params[0]);
      if (m) { m.times_confirmed = (m.times_confirmed || 0) + 1; m.bucket = params[1]; m.category = params[2]; }
      return { rows: [] };
    }
    if (S.startsWith('INSERT INTO categorization_memory')) {
      db.categorization_memory.push({ id: params[0], user_id: params[1], account: params[2], merchant_pattern: params[3],
        bucket: params[4], category: params[5], coa_id: params[6], times_confirmed: 1 });
      return { rows: [] };
    }
    return { rows: [] };
  }
  query.db = db; query.calls = calls;
  return query;
}

function fakeIO(seed = {}) {
  const store = { ...seed };
  return { read: (f) => (f in store ? store[f] : null), write: (f, d) => { store[f] = d; return true; }, store };
}

const COFFEE    = idForPath(['Personal Expenses', 'Food & Dining', 'Coffee Shops']);
const BIZ_SUP   = idForPath(['Business Expenses', 'Supplies', 'General Supplies']);
const BIZ_APPL  = idForPath(['Business Expenses', 'Supplies', 'Home Appliances']);
const GROCERIES = idForPath(['Personal Expenses', 'Food & Dining', 'Groceries']);
const GYM       = idForPath(['Personal Expenses', 'Personal Care', 'Gym & Fitness']);

describe('pure helpers', () => {
  test('money formats spend vs income', () => {
    expect(money(-84.2)).toBe('$84.20');
    expect(money(100)).toBe('+$100.00');
  });
  test('dateShort renders Mon D', () => expect(dateShort('2026-06-15')).toBe('Jun 15'));
  test('isConfirm / isSkip', () => {
    expect(isConfirm('ok')).toBe(true);
    expect(isConfirm('yes')).toBe(true);
    expect(isConfirm('home appliances')).toBe(false);
    expect(isSkip('skip')).toBe(true);
  });
  test('coaPath builds the hierarchy label', () => {
    expect(coaPath(BIZ_APPL, buildDefaultChart())).toBe('Business Expenses › Supplies › Home Appliances');
  });
  test('coaScope reads the section scope', () => {
    const chart = buildDefaultChart();
    expect(coaScope(BIZ_APPL, chart)).toBe('business');
    expect(coaScope(COFFEE, chart)).toBe('personal');
  });
  test('dominantBucket respects the ≥2 threshold', () => {
    expect(dominantBucket([{ bucket: 'business', n: 3 }, { bucket: 'personal', n: 1 }])).toBe('business');
    expect(dominantBucket([{ bucket: 'business', n: 1 }])).toBeNull();
    expect(dominantBucket([])).toBeNull();
  });
  test('merchantKey strips noise', () => expect(merchantKey('WALMART #123 LOS ANGELES CA')).toBe('WALMART'));
});

describe('suggestionFor', () => {
  const chart = buildDefaultChart();
  test('prefers learned memory for the account+merchant', async () => {
    const db = makeDb({ categorization_memory: [
      { id: 'm1', user_id: 'u1', account: 'a1', merchant_pattern: 'BLUE BOTTLE', bucket: 'personal', category: 'Coffee Shops', coa_id: COFFEE, times_confirmed: 4 },
    ] });
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'a1', name: 'Personal' }] });
    const s = await suggestionFor(db, io, 'u1', { id: 't', account: 'a1', desc: 'SQ *BLUE BOTTLE COFFEE', amount: -6 });
    expect(s.coaId).toBe(COFFEE);
    expect(s.source).toBe('memory');
  });
  test('falls back to the rule-based guess', async () => {
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'a1', name: 'Personal' }] });
    const s = await suggestionFor(makeDb(), io, 'u1', { id: 't', account: 'a1', desc: 'STARBUCKS STORE 123', amount: -5 });
    expect(s.coaId).toBe(COFFEE);
    expect(s.source).toBe('guess');
  });
  test('a business-leaning account makes a NEW merchant guess business (IKEA on Haas)', async () => {
    const db = makeDb({ categorization_memory: [
      { id: 'm1', user_id: 'u1', account: 'haas', merchant_pattern: 'HOME DEPOT', bucket: 'business', category: 'Repairs', coa_id: 'cat_x', times_confirmed: 3 },
    ] });
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'haas', name: 'Haas Ave' }] });
    const s = await suggestionFor(db, io, 'u1', { id: 't', account: 'haas', desc: 'IKEA BURBANK', amount: -220 });
    expect(s.bucket).toBe('business');
    expect(s.coaId).toBe(BIZ_APPL);
  });
});

describe('recordConfirmation', () => {
  test('inserts the first time, then increments times_confirmed', async () => {
    const db = makeDb();
    const row = { account: 'a1', pattern: 'WALMART', bucket: 'business', category: 'Supplies', coaId: BIZ_SUP };
    await recordConfirmation(db, 'u1', row);
    await recordConfirmation(db, 'u1', row);
    expect(db.db.categorization_memory).toHaveLength(1);
    expect(db.db.categorization_memory[0].times_confirmed).toBe(2);
  });
});

describe('enqueueQuestions', () => {
  test('opens one row per new categorizable txn; skips seen/approved/excluded/transfers', async () => {
    const db = makeDb({ txn_messages: [{ id: 'old', user_id: 'u1', transaction_id: 't_seen', state: 'answered', payload: '{}' }] });
    const io = fakeIO({
      'chart_of_accounts.json': buildDefaultChart(),
      'accounts.json': [{ id: 'a1', name: 'Personal' }],
      'transactions.json': [
        { id: 't1', account: 'a1', desc: 'STARBUCKS', amount: -5, date: '2026-06-15' },
        { id: 't_seen', account: 'a1', desc: 'X', amount: -9, date: '2026-06-14' },
        { id: 't2', account: 'a1', desc: 'PAYMENT THANK YOU', amount: -50, date: '2026-06-13' },
        { id: 't3', account: 'a1', desc: 'OLD', amount: -7, date: '2026-06-12', approved: true },
        { id: 't4', account: 'a1', desc: 'EXC', amount: -7, date: '2026-06-11', excluded: true },
      ],
    });
    const created = await enqueueQuestions(db, io, 'u1');
    expect(created).toBe(1);
    const open = db.db.txn_messages.filter(m => m.state === 'open');
    expect(open).toHaveLength(1);
    expect(open[0].transaction_id).toBe('t1');
  });

  test('onlyIds restricts to genuinely-new transactions (the Plaid-sync path)', async () => {
    const db = makeDb();
    const io = fakeIO({
      'chart_of_accounts.json': buildDefaultChart(),
      'accounts.json': [{ id: 'a1', name: 'Personal' }],
      'transactions.json': [
        { id: 'tNew', account: 'a1', desc: 'STARBUCKS', amount: -5, date: '2026-06-17' },
        { id: 'tOld', account: 'a1', desc: 'CHIPOTLE',  amount: -9, date: '2026-06-10' },
      ],
    });
    const created = await enqueueQuestions(db, io, 'u1', { onlyIds: ['tNew'] });
    expect(created).toBe(1);
    expect(db.db.txn_messages.filter(m => m.state === 'open').map(m => m.transaction_id)).toEqual(['tNew']);
  });
});

describe('matchCategories (local, no LLM)', () => {
  const chart = buildDefaultChart();
  test('a distinctive word resolves confidently', () => {
    expect(matchCategories('gym', chart).best.id).toBe(GYM);
    expect(matchCategories('groceries', chart).best.id).toBe(GROCERIES);
  });
  test('a bucket hint disambiguates same-named leaves (business vs personal)', () => {
    expect(matchCategories('home appliances', chart, { bucketHint: 'business' }).best.id).toBe(BIZ_APPL);
  });
  test('an ambiguous word yields a shortlist, not a single best', () => {
    const r = matchCategories('meal', chart);
    expect(r.best).toBeNull();
    expect(r.candidates.length).toBeGreaterThan(1);
  });
  test('gibberish matches nothing', () => {
    expect(matchCategories('qwzzx', chart).candidates).toHaveLength(0);
  });
});

describe('isTransferIntent', () => {
  test('flags transfers/reimbursements, not real categories', () => {
    expect(isTransferIntent('transferred money from a friend')).toBe(true);
    expect(isTransferIntent('venmo from a friend')).toBe(true);
    expect(isTransferIntent('groceries')).toBe(false);
    expect(isTransferIntent('business home appliances')).toBe(false);
  });
});

describe('handleReply', () => {
  const chart = buildDefaultChart();
  const noGroq = () => { throw new Error('Groq should not be called'); };
  function seedOpen(tx, suggestion) {
    const payload = JSON.stringify({ stage: 'await_first', tx, suggestion });
    return {
      txn_messages: [{ id: 'txm1', user_id: 'u1', transaction_id: tx.id, state: 'asked', payload }],
      users: [{ id: 'u1', display_name: 'Albert' }],
    };
  }

  test('OK confirms the suggestion → applies, learns, closes', async () => {
    const tx = { id: 't1', account: 'haas', desc: 'WALMART #123', amount: -84.2, date: '2026-06-15' };
    const db = makeDb(seedOpen(tx, { coaId: BIZ_SUP, label: coaPath(BIZ_SUP, chart), bucket: 'business' }));
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'haas', name: 'Haas Ave', last4: '1234' }], 'transactions.json': [clone(tx)] });

    const res = await handleReply(db, io, 'u1', 'ok');
    expect(res.applied).toBe(true);
    expect(res.reply).toContain('Filed under');
    expect(io.store['transactions.json'][0].coaId).toBe(BIZ_SUP);
    expect(io.store['transactions.json'][0].approved).toBe(true);
    expect(db.db.categorization_memory[0].coa_id).toBe(BIZ_SUP);
    expect(db.db.categorization_memory[0].bucket).toBe('business');
    expect(db.db.txn_messages[0].state).toBe('answered');
    expect(res.next).toBeNull();
  });

  test('a category-word reply resolves locally (no Groq) and OK finalizes it', async () => {
    const tx = { id: 't1', account: 'a1', desc: 'WHOLE FOODS', amount: -40, date: '2026-06-15' };
    const db = makeDb(seedOpen(tx, { coaId: BIZ_SUP, label: 'x', bucket: 'personal' }));
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'a1', name: 'Checking' }], 'transactions.json': [clone(tx)] });

    const r1 = await handleReply(db, io, 'u1', 'groceries', { parseReply: noGroq });
    expect(r1.applied).toBe(false);
    expect(JSON.parse(db.db.txn_messages[0].payload).proposal.coaId).toBe(GROCERIES);

    const r2 = await handleReply(db, io, 'u1', 'ok', { parseReply: noGroq });
    expect(r2.applied).toBe(true);
    expect(io.store['transactions.json'][0].coaId).toBe(GROCERIES);
  });

  test('an ambiguous reply shows a shortlist; a number applies it (no Groq)', async () => {
    const tx = { id: 't1', account: 'a1', desc: 'SOME PLACE', amount: -30, date: '2026-06-15' };
    const db = makeDb(seedOpen(tx, { coaId: BIZ_SUP, label: 'x', bucket: 'personal' }));
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'a1', name: 'Checking' }], 'transactions.json': [clone(tx)] });

    const r1 = await handleReply(db, io, 'u1', 'meal', { parseReply: noGroq });
    expect(r1.applied).toBe(false);
    expect(r1.options.length).toBeGreaterThan(1);

    const r2 = await handleReply(db, io, 'u1', '1', { parseReply: noGroq });
    expect(r2.applied).toBe(true);
    expect(io.store['transactions.json'][0].coaId).toBe(r1.options[0].coaId);
  });

  test('a transfer phrase excludes the transaction instead of categorizing it', async () => {
    const tx = { id: 't1', account: 'a1', desc: 'ZELLE', amount: 60, date: '2026-06-17' };
    const db = makeDb(seedOpen(tx, { coaId: idForPath(['Personal Income', 'Other Income', 'Refunds']), label: 'x', bucket: 'personal' }));
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'a1', name: 'Checking' }], 'transactions.json': [clone(tx)] });

    const r = await handleReply(db, io, 'u1', 'transferred money from a friend', { parseReply: noGroq });
    expect(r.applied).toBe(true);
    expect(io.store['transactions.json'][0].excluded).toBe(true);
    expect(io.store['transactions.json'][0].coaId).toBeUndefined();
  });

  test('genuinely fuzzy text falls back to Groq with a SMALL candidate list', async () => {
    const tx = { id: 't1', account: 'a1', desc: 'XYZ STORE', amount: -200, date: '2026-06-15' };
    const db = makeDb(seedOpen(tx, { coaId: BIZ_SUP, label: 'x', bucket: 'business' }));
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'a1', name: 'Haas' }], 'transactions.json': [clone(tx)] });
    let sawCoaLen = null;
    const parseReply = async ({ coa }) => { sawCoaLen = coa.length; return { coaId: BIZ_APPL, isNew: false, accountName: 'Home Appliances' }; };

    await handleReply(db, io, 'u1', 'the couch for staging', { parseReply });
    expect(sawCoaLen).toBeGreaterThan(0);
    expect(sawCoaLen).toBeLessThanOrEqual(30);   // not the full 200+ chart
    expect(JSON.parse(db.db.txn_messages[0].payload).proposal.coaId).toBe(BIZ_APPL);
  });

  test('a Groq failure degrades to a friendly shortlist (no raw error or URL)', async () => {
    const tx = { id: 't1', account: 'a1', desc: 'XYZ', amount: -10, date: '2026-06-15' };
    const db = makeDb(seedOpen(tx, { coaId: BIZ_SUP, label: 'x', bucket: 'personal' }));
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'a1', name: 'Checking' }], 'transactions.json': [clone(tx)] });
    const parseReply = async () => { throw new Error('Rate limit reached https://console.groq.com/billing'); };

    const r = await handleReply(db, io, 'u1', 'qwzzx flumph', { parseReply });
    expect(r.reply).not.toMatch(/http|groq|rate limit/i);
    expect(r.options.length).toBeGreaterThan(0);
  });

  test('a brand-new category (via Groq) is created under the right section and applied', async () => {
    const tx = { id: 't1', account: 'haas', desc: 'NICHE VENDOR', amount: -50, date: '2026-06-15' };
    const db = makeDb(seedOpen(tx, null));
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'haas', name: 'Haas Ave' }], 'transactions.json': [clone(tx)] });
    const parseReply = async () => ({ coaId: null, isNew: true, newAccount: { name: 'Staging Supplies', type: 'expense' }, interpretation: 'x' });

    await handleReply(db, io, 'u1', 'business zorptang', { parseReply });   // no local match → Groq
    const r2 = await handleReply(db, io, 'u1', 'ok', { parseReply });
    expect(r2.applied).toBe(true);
    const created = io.store['chart_of_accounts.json'].find(n => n.name === 'Staging Supplies');
    expect(created).toBeTruthy();
    expect(created.scope).toBe('business');
    expect(io.store['transactions.json'][0].coaId).toBe(created.id);
  });

  test('skip closes the question without applying', async () => {
    const tx = { id: 't1', account: 'haas', desc: 'WHATEVER', amount: -9, date: '2026-06-15' };
    const db = makeDb(seedOpen(tx, { coaId: BIZ_SUP, label: 'x', bucket: 'business' }));
    const io = fakeIO({ 'chart_of_accounts.json': chart, 'accounts.json': [{ id: 'haas', name: 'Haas Ave' }], 'transactions.json': [clone(tx)] });
    const res = await handleReply(db, io, 'u1', 'skip');
    expect(res.applied).toBe(false);
    expect(db.db.txn_messages[0].state).toBe('closed');
    expect(io.store['transactions.json'][0].coaId).toBeUndefined();
  });
});
