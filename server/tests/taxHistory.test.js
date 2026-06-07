'use strict';
/**
 * Tax History / Transactions / AI Sessions — unit tests
 *
 * Database is mocked via jest.mock() with a self-contained implementation.
 * All helpers and state live inside the factory (Jest rule: no outer scope refs).
 * Tests control seeded data via require('../db').__state.rows[table] = [...].
 */

// ── DB mock: must be entirely self-contained ──────────────────────────────────
jest.mock('../db', () => {
  // Shared in-memory state — exposed as __state for test access
  const state = { rows: {}, calls: [] };

  function extractTable(sql) {
    const m = sql.match(/(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i);
    return m ? m[1] : 'unknown';
  }

  // Very simple WHERE parser: col=$N conditions joined by AND
  function rowMatches(sql, params, row) {
    const m = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s*$)/i);
    if (!m) return true;
    for (const cond of m[1].split(/\s+AND\s+/i)) {
      const cm = cond.match(/(\w+)\s*=\s*\$(\d+)/);
      if (!cm) continue;
      const col = cm[1], val = params[parseInt(cm[2]) - 1];
      if (val !== undefined && row[col] !== undefined &&
          String(row[col]) !== String(val)) return false;
    }
    return true;
  }

  function buildRow(sql, params) {
    const cm = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (!cm) return {};
    const cols = cm[1].split(',').map(c => c.trim());
    const row  = {};
    cols.forEach((col, i) => { row[col] = params[i]; });
    return row;
  }

  const query = jest.fn(async (sql, params = []) => {
    state.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

    if (/^CREATE/i.test(sql)) return { rows: [] };

    const tbl = extractTable(sql);

    if (/^SELECT/i.test(sql)) {
      const rows = (state.rows[tbl] || []).filter(row => rowMatches(sql, params, row));
      return { rows };
    }
    if (/^INSERT/i.test(sql)) {
      const row = buildRow(sql, params);
      if (!state.rows[tbl]) state.rows[tbl] = [];
      state.rows[tbl].push(row);
      return { rows: [row] };
    }
    if (/^UPDATE/i.test(sql)) return { rows: [] };
    if (/^DELETE/i.test(sql)) {
      const id = params[params.length - 1];
      if (state.rows[tbl]) state.rows[tbl] = state.rows[tbl].filter(r => r.id !== id);
      return { rows: [] };
    }
    return { rows: [] };
  });

  return { query, initSchema: jest.fn(), __state: state };
});

// ── Test imports (after mock is registered) ───────────────────────────────────
const express   = require('express');
const supertest = require('supertest');

const {
  makeCalculationsRouter,
  makeTransactionsRouter,
  makeAISessionsRouter,
  TAX_CATEGORIES,
} = require('../tax-history');

const db = require('../db');  // the mocked version

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp(userId = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  app.use('/api/tax-history',      makeCalculationsRouter());
  app.use('/api/tax-transactions', makeTransactionsRouter());
  app.use('/api/ai-sessions',      makeAISessionsRouter());
  return app;
}

function clearDB() {
  const s = db.__state;
  Object.keys(s.rows).forEach(k => { s.rows[k] = []; });
  s.calls.length = 0;
  db.query.mockClear();
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Tax categories', () => {
  const app = buildApp();

  test('GET /api/tax-history/categories returns full map', async () => {
    const res = await supertest(app).get('/api/tax-history/categories');
    expect(res.status).toBe(200);
    expect(res.body.categories.wages).toBeDefined();
    expect(res.body.categories.business_meals.deductPct).toBe(0.5);
    expect(res.body.categories.mortgage_interest.schedule).toBe('A');
  });

  test('Every category has a non-empty label', () => {
    for (const [key, val] of Object.entries(TAX_CATEGORIES)) {
      expect(typeof val.label).toBe('string');
      expect(val.label.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Saved calculations', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(clearDB);

  const sampleInput  = { taxYear: 2024, filingStatus: 'single', income: { w2: 80000 } };
  const sampleResult = {
    agi: 80000, totalLiability: 10000, balanceDue: 2000,
    effectiveRate: 0.125, marginalRate: 0.22,
    steps: [{ label: 'W-2 Wages', value: 80000 }],
  };

  test('POST saves a calculation', async () => {
    const res = await supertest(app).post('/api/tax-history').send({
      taxYear: 2024, filingStatus: 'single',
      input: sampleInput, result: sampleResult,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.saved).toBe(true);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tax_calculations'),
      expect.any(Array)
    );
  });

  test('POST requires taxYear, filingStatus, input, result', async () => {
    const res = await supertest(app).post('/api/tax-history').send({ taxYear: 2024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('GET / returns only current user rows', async () => {
    db.__state.rows['tax_calculations'] = [
      { id: 'c1', user_id: 'user-1', tax_year: 2024, filing_status: 'single' },
      { id: 'c2', user_id: 'user-2', tax_year: 2024, filing_status: 'mfj' },
    ];
    const res = await supertest(app).get('/api/tax-history');
    expect(res.status).toBe(200);
    expect(res.body.calculations.map(c => c.id)).toContain('c1');
    expect(res.body.calculations.map(c => c.id)).not.toContain('c2');
  });

  test('GET /:id returns record for owner', async () => {
    db.__state.rows['tax_calculations'] = [
      { id: 'calc-abc', user_id: 'user-1', tax_year: 2024 },
    ];
    const res = await supertest(app).get('/api/tax-history/calc-abc');
    expect(res.status).toBe(200);
    expect(res.body.calculation.id).toBe('calc-abc');
  });

  test('GET /:id returns 404 for wrong user', async () => {
    db.__state.rows['tax_calculations'] = [
      { id: 'calc-other', user_id: 'user-99', tax_year: 2024 },
    ];
    const res = await supertest(app).get('/api/tax-history/calc-other');
    expect(res.status).toBe(404);
  });

  test('DELETE removes owned calculation', async () => {
    db.__state.rows['tax_calculations'] = [
      { id: 'calc-del', user_id: 'user-1', tax_year: 2024 },
    ];
    const res = await supertest(app).delete('/api/tax-history/calc-del');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  test('DELETE returns 404 for another user\'s record', async () => {
    db.__state.rows['tax_calculations'] = [
      { id: 'c-other', user_id: 'user-99', tax_year: 2024 },
    ];
    const res = await supertest(app).delete('/api/tax-history/c-other');
    expect(res.status).toBe(404);
  });

  test('PATCH /label renames calculation', async () => {
    db.__state.rows['tax_calculations'] = [
      { id: 'c-rename', user_id: 'user-1', tax_year: 2024 },
    ];
    const res = await supertest(app).patch('/api/tax-history/c-rename/label').send({ label: '2024 Final' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
  });

  test('PATCH /label returns 400 without label', async () => {
    db.__state.rows['tax_calculations'] = [
      { id: 'c-x', user_id: 'user-1', tax_year: 2024 },
    ];
    const res = await supertest(app).patch('/api/tax-history/c-x/label').send({});
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Tax transactions', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(clearDB);

  const validTxn = {
    taxYear: 2024, amount: -250.00, description: 'Team lunch',
    taxCategory: 'business_meals', deductibilityPct: 0.5,
    sourceType: 'plaid', sourceId: 'plaid-123',
    date: '2024-03-15',
  };

  test('POST creates a transaction', async () => {
    const res = await supertest(app).post('/api/tax-transactions').send(validTxn);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.created).toBe(true);
  });

  test('POST requires taxYear and amount', async () => {
    const res = await supertest(app).post('/api/tax-transactions').send({ description: 'nope' });
    expect(res.status).toBe(400);
  });

  test('POST rejects unknown tax category', async () => {
    const res = await supertest(app)
      .post('/api/tax-transactions')
      .send({ taxYear: 2024, amount: -100, taxCategory: 'not_real' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown category/);
  });

  test('POST upserts when source key already exists', async () => {
    db.__state.rows['tax_transactions'] = [
      { id: 'txn-existing', user_id: 'user-1', source_type: 'plaid', source_id: 'plaid-123' },
    ];
    const res = await supertest(app)
      .post('/api/tax-transactions')
      .send({ ...validTxn, taxCategory: 'business_travel' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.id).toBe('txn-existing');
  });

  test('GET lists transactions filtered by year', async () => {
    db.__state.rows['tax_transactions'] = [
      { id: 't1', user_id: 'user-1', tax_year: 2024, tax_category: 'business_meals' },
      { id: 't2', user_id: 'user-1', tax_year: 2023, tax_category: 'wages' },
      { id: 't3', user_id: 'user-2', tax_year: 2024, tax_category: 'wages' },
    ];
    const res = await supertest(app).get('/api/tax-transactions?year=2024');
    expect(res.status).toBe(200);
    const ids = res.body.transactions.map(t => t.id);
    expect(ids).toContain('t1');
    expect(ids).not.toContain('t2'); // wrong year
    expect(ids).not.toContain('t3'); // wrong user
  });

  test('GET /summary/:year returns structured response', async () => {
    const res = await supertest(app).get('/api/tax-transactions/summary/2024');
    expect(res.status).toBe(200);
    expect(res.body.year).toBe(2024);
    expect(Array.isArray(res.body.byCategory)).toBe(true);
    expect(res.body.totals).toHaveProperty('deductible');
    expect(res.body.totals).toHaveProperty('income');
    expect(res.body.totals).toHaveProperty('count');
  });

  test('GET /summary/:year returns 400 for non-numeric year', async () => {
    const res = await supertest(app).get('/api/tax-transactions/summary/badyear');
    expect(res.status).toBe(400);
  });

  test('PATCH updates category', async () => {
    db.__state.rows['tax_transactions'] = [
      { id: 'txn-p', user_id: 'user-1', tax_category: 'needs_review' },
    ];
    const res = await supertest(app)
      .patch('/api/tax-transactions/txn-p')
      .send({ taxCategory: 'business_meals', userVerified: true });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
  });

  test('PATCH returns 400 for unknown category', async () => {
    db.__state.rows['tax_transactions'] = [
      { id: 'txn-b', user_id: 'user-1' },
    ];
    const res = await supertest(app)
      .patch('/api/tax-transactions/txn-b')
      .send({ taxCategory: 'fake' });
    expect(res.status).toBe(400);
  });

  test('PATCH returns 404 for another user\'s transaction', async () => {
    db.__state.rows['tax_transactions'] = [
      { id: 'txn-o', user_id: 'user-99' },
    ];
    const res = await supertest(app)
      .patch('/api/tax-transactions/txn-o')
      .send({ taxCategory: 'wages' });
    expect(res.status).toBe(404);
  });

  test('PATCH returns 400 with no update fields', async () => {
    db.__state.rows['tax_transactions'] = [
      { id: 'txn-empty', user_id: 'user-1' },
    ];
    const res = await supertest(app)
      .patch('/api/tax-transactions/txn-empty')
      .send({});
    expect(res.status).toBe(400);
  });

  test('DELETE removes owned transaction', async () => {
    db.__state.rows['tax_transactions'] = [
      { id: 'txn-del', user_id: 'user-1' },
    ];
    const res = await supertest(app).delete('/api/tax-transactions/txn-del');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  test('DELETE returns 404 for another user\'s transaction', async () => {
    db.__state.rows['tax_transactions'] = [
      { id: 'txn-other', user_id: 'user-99' },
    ];
    const res = await supertest(app).delete('/api/tax-transactions/txn-other');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AI session log', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(clearDB);

  const sampleSession = {
    taxYear: 2024, filingStatus: 'single',
    userQuestion: 'Can I deduct my home office?',
    modelUsed: 'groq/llama-3.3-70b',
    finalAnswer: 'Yes, if you use it regularly and exclusively for business...',
    riskFlags: ['home_office'],
    validationPassed: true,
    disclaimerShown: true,
    escalated: false,
    tokensUsed: 842,
    latencyMs: 1250,
  };

  test('POST saves an AI session', async () => {
    const res = await supertest(app).post('/api/ai-sessions').send(sampleSession);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.saved).toBe(true);
  });

  test('POST requires userQuestion', async () => {
    const res = await supertest(app).post('/api/ai-sessions').send({ taxYear: 2024 });
    expect(res.status).toBe(400);
  });

  test('GET / lists only current user sessions', async () => {
    db.__state.rows['ai_tax_sessions'] = [
      { id: 's1', user_id: 'user-1', tax_year: 2024, user_question: 'q1', created_at: new Date().toISOString() },
      { id: 's2', user_id: 'user-2', tax_year: 2024, user_question: 'q2', created_at: new Date().toISOString() },
    ];
    const res = await supertest(app).get('/api/ai-sessions');
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map(s => s.id);
    expect(ids).toContain('s1');
    expect(ids).not.toContain('s2');
  });

  test('GET /:id returns full detail for owner', async () => {
    db.__state.rows['ai_tax_sessions'] = [
      { id: 'sess-1', user_id: 'user-1', user_question: 'test', final_answer: 'Yes' },
    ];
    const res = await supertest(app).get('/api/ai-sessions/sess-1');
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe('sess-1');
  });

  test('GET /:id returns 404 for wrong user', async () => {
    db.__state.rows['ai_tax_sessions'] = [
      { id: 'sess-o', user_id: 'user-99', user_question: 'test' },
    ];
    const res = await supertest(app).get('/api/ai-sessions/sess-o');
    expect(res.status).toBe(404);
  });

  test('POST with all optional fields saves without error', async () => {
    const res = await supertest(app).post('/api/ai-sessions').send({
      ...sampleSession,
      conversationHistory:  [{ role: 'user', content: 'prior' }],
      retrievedSourceIds:   ['src-1', 'src-2'],
      retrievedExcerpts:    [{ sourceId: 'src-1', text: 'excerpt', relevanceScore: 0.9 }],
      calculationId:        'calc-abc',
      userDataSnapshot:     { agi: 100000 },
      citations:            [{ source: 'IRS Pub 587', section: 'Home Office' }],
      assumptions:          ['Exclusive and regular use assumed'],
      validationDetails:    { hasCitations: true, numbersFromEngine: true },
    });
    expect(res.status).toBe(201);
  });
});
