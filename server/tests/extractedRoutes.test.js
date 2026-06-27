'use strict';
// Integration test for the routes extracted out of index.js in the #6 decomposition.
// Mounts each router on a bare Express app (stubbed auth + IO/data) and exercises it,
// so the path strings + handler logic are verified without the real server or DB.
const express = require('express');
const request = require('supertest');

function appWith(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });   // stub auth
  app.use('/api', router);
  return app;
}
function stubMakeIO() {
  const store = {};
  const io = { read: (f) => (f in store ? store[f] : null), write: (f, v) => { store[f] = v; } };
  return () => io;   // makeIO(uid) → io
}

describe('crypto/wallet-routes', () => {
  test('crypto transactions CRUD round-trip', async () => {
    const app = appWith(require('../crypto/wallet-routes')(stubMakeIO()));
    expect((await request(app).get('/api/crypto/transactions')).body).toEqual([]);
    const created = await request(app).post('/api/crypto/transactions').send({ asset: 'BTC', type: 'buy', quantity: 1 });
    expect(created.body.id).toMatch(/^ctx_/);
    expect((await request(app).get('/api/crypto/transactions')).body).toHaveLength(1);
  });
  test('wallets default to [] and lookup rejects a bad address', async () => {
    const app = appWith(require('../crypto/wallet-routes')(stubMakeIO()));
    expect((await request(app).get('/api/wallets')).body).toEqual([]);
    expect((await request(app).get('/api/wallet-lookup?address=notanaddress')).status).toBe(400);
  });
});

describe('tax/estimate-routes', () => {
  test('returns the estimate envelope with empty data', async () => {
    const app = appWith(require('../tax/estimate-routes')(stubMakeIO()));
    const r = await request(app).get('/api/tax-estimate?year=2025');
    expect(r.body.year).toBe('2025');
    expect(r.body.estimates).toHaveProperty('w2');
    expect(r.body.estimates.capitalGains.value).toBe(0);
  });
});

describe('core/backup-routes', () => {
  function stubData() {
    const store = {};
    return { readData: (f) => (f in store ? store[f] : null), writeData: (f, v) => { store[f] = v; }, store };
  }
  test('backup returns an export envelope', async () => {
    const { readData, writeData } = stubData();
    const app = appWith(require('../core/backup-routes')({ readData, writeData }));
    const r = await request(app).get('/api/backup');
    expect(r.body).toHaveProperty('exportedAt');
    expect(r.body).toHaveProperty('version', '1.0.0');
  });
  test('import preview reports new vs duplicate', async () => {
    const { readData, writeData, store } = stubData();
    store['transactions.json'] = [{ date: '2026-01-01', amount: -5, desc: 'Coffee shop' }];
    const app = appWith(require('../core/backup-routes')({ readData, writeData }));
    const r = await request(app).post('/api/import-history/preview').send({
      transactions: [
        { date: '2026-01-01', amount: -5, desc: 'Coffee shop' },   // duplicate
        { date: '2026-01-02', amount: -9, desc: 'Lunch place' },   // new
      ],
    });
    expect(r.body.new).toBe(1);
    expect(r.body.duplicates).toBe(1);
  });
});

describe('core/pdf-routes', () => {
  test('parse-statement 400s with no file', async () => {
    const app = appWith(require('../core/pdf-routes')());
    expect((await request(app).post('/api/parse-statement')).status).toBe(400);
  });
});
