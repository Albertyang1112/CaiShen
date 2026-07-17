'use strict';
// Route tests for /api/insurance (+ /api/tax-schedule) — mounted on a bare Express app
// with stubbed auth and a mocked DB, extractedRoutes.test.js style.
const express = require('express');
const request = require('supertest');

// insurance-routes and tax/schedule pull query from core/db at module load — mock it.
let mockRowsByPattern = [];
jest.mock('../core/db', () => ({
  query: (sql, params) => {
    for (const [re, rows] of mockRowsByPattern) if (re.test(sql)) return Promise.resolve({ rows: typeof rows === 'function' ? rows(params) : rows });
    return Promise.resolve({ rows: [] });
  },
}));

function appWith(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });   // stub auth
  app.use('/api', router);
  return app;
}
function stubMakeIO(store = {}) {
  const io = { read: (f) => (f in store ? store[f] : null), write: (f, v) => { store[f] = v; } };
  return () => io;
}

beforeEach(() => { mockRowsByPattern = []; });

describe('GET /api/insurance', () => {
  test('empty DB → []', async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });
    app.use('/api/insurance', require('../banking/insurance-routes')(stubMakeIO()));
    const r = await request(app).get('/api/insurance');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  test('policy + paid latest statement → paidCurrentCycle true', async () => {
    mockRowsByPattern = [
      [/FROM insurance_policies WHERE user_id/, [{ id: 'pol1', carrier: 'GeoVera', coverage_type: 'earthquake', next_due_date: '2027-08-01' }]],
      [/FROM insurance_statements s/, [{ id: 'istmt_1', due_date: '2026-08-01', amount_due: '412.00', matched_transaction_id: 't9', payment_date: '2026-07-28' }]],
    ];
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });
    app.use('/api/insurance', require('../banking/insurance-routes')(stubMakeIO()));
    const r = await request(app).get('/api/insurance');
    expect(r.body).toHaveLength(1);
    expect(r.body[0].paidCurrentCycle).toBe(true);
    expect(r.body[0].paidDate).toBe('2026-07-28');
    expect(r.body[0].latestStatement.id).toBe('istmt_1');
  });

  test('alerts come from insurance_alerts.json; unknown policy id → 404 statements', async () => {
    const store = { 'insurance_alerts.json': [{ id: 'a1', kind: 'premium_paid', message: 'paid' }] };
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });
    app.use('/api/insurance', require('../banking/insurance-routes')(stubMakeIO(store)));
    expect((await request(app).get('/api/insurance/alerts')).body).toHaveLength(1);
    expect((await request(app).get('/api/insurance/nope/statements')).status).toBe(404);
  });
});

describe('GET /api/tax-schedule', () => {
  test('returns schedule rows for the user', async () => {
    mockRowsByPattern = [
      [/FROM tax_payment_schedule WHERE user_id/, [{ id: 'txsch_1', kind: 'property_tax', status: 'unpaid', due_date: '2026-12-10' }]],
    ];
    const app = appWith(require('../tax/schedule').router());
    const r = await request(app).get('/api');
    expect(r.status).toBe(200);
    expect(r.body[0].kind).toBe('property_tax');
  });
});
