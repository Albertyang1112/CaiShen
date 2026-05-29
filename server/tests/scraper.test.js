'use strict';

/**
 * scraper.test.js
 *
 * Tests for bank-scraper.js routes and middleware behaviour.
 * Uses a mock Express app — no real Playwright browser, no real vault on disk.
 */

const request  = require('supertest');
const express  = require('express');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

// ── Minimal mock IO (avoids hitting the real vault directory) ─────────────────
function makeMockIO() {
  const store = {};
  return (_userId) => ({
    read:  (key)        => store[key] || null,
    write: (key, value) => { store[key] = value; return true; },
  });
}

// ── Build a minimal Express app that wires up the scraper router ──────────────
// overrideHostname lets us pretend the request came from any hostname without
// actually changing DNS — used to exercise the localhostOnly gate.
function buildApp(overrideHostname) {
  const app = express();
  app.use(express.json());

  // Mock auth: inject a test user on every request
  app.use((req, _res, next) => {
    req.user = { id: 'test_user_001' };
    next();
  });

  // Replicate the same localhostOnly middleware from server/index.js
  function localhostOnly(req, res, next) {
    const h = overrideHostname || req.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return next();
    return res.status(403).json({ error: 'This feature is only available when running CaiShen locally.' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caishen-scraper-test-'));
  const scraperRouter = require('../bank-scraper')(makeMockIO(), tmpDir);

  app.use('/api/scraper', localhostOnly, scraperRouter);

  // Expose cleanup so tests can remove the temp dir
  app._cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('BANKS definition', () => {
  // Load the BANKS object by requiring bank-scraper as a plain module
  // and inspecting what GET /banks returns.
  let app;
  beforeAll(() => { app = buildApp('localhost'); });
  afterAll (() => { app._cleanup(); });

  it('returns all four banks from GET /banks', async () => {
    const res = await request(app).get('/api/scraper/banks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);
  });

  it('includes chase, bofa, wellsfargo, citi with id and label', async () => {
    const res = await request(app).get('/api/scraper/banks');
    const ids = res.body.map(b => b.id);
    expect(ids).toContain('chase');
    expect(ids).toContain('bofa');
    expect(ids).toContain('wellsfargo');
    expect(ids).toContain('citi');
    for (const bank of res.body) {
      expect(typeof bank.id).toBe('string');
      expect(typeof bank.label).toBe('string');
      expect(bank.label.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/scraper/fixtures', () => {
  let app;
  beforeAll(() => { app = buildApp('localhost'); });
  afterAll (() => { app._cleanup(); });

  it('returns 200 with boolean flags for each bank', async () => {
    const res = await request(app).get('/api/scraper/fixtures');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    for (const key of ['chase', 'bofa', 'wellsfargo', 'citi']) {
      expect(Object.prototype.hasOwnProperty.call(res.body, key)).toBe(true);
      expect(typeof res.body[key]).toBe('boolean');
    }
  });

  it('reports false for a bank with no HAR fixture on disk', async () => {
    const res = await request(app).get('/api/scraper/fixtures');
    // In a clean test environment no HAR files exist yet
    expect(res.body.chase).toBe(false);
    expect(res.body.bofa).toBe(false);
    expect(res.body.wellsfargo).toBe(false);
    expect(res.body.citi).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/scraper/start — validation', () => {
  let app;
  beforeAll(() => { app = buildApp('localhost'); });
  afterAll (() => { app._cleanup(); });

  it('returns 400 for an unsupported bank', async () => {
    const res = await request(app)
      .post('/api/scraper/start')
      .send({ bank: 'hsbc', mode: 'live' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported bank/i);
  });

  it('returns 400 for an invalid mode', async () => {
    const res = await request(app)
      .post('/api/scraper/start')
      .send({ bank: 'chase', mode: 'turbo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid mode/i);
  });

  it('accepts replay mode for a supported bank and returns a sessionId', async () => {
    // replay doesn't open a real browser — but it DOES fail quickly because
    // there's no HAR fixture, which means runScraper fires an error async.
    // The /start response itself should still be 200 with a sessionId.
    const res = await request(app)
      .post('/api/scraper/start')
      .send({ bank: 'chase', mode: 'replay' });
    expect(res.status).toBe(200);
    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.sessionId).toMatch(/^scrape_/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/scraper/progress/:sessionId', () => {
  let app;
  beforeAll(() => { app = buildApp('localhost'); });
  afterAll (() => { app._cleanup(); });

  it('returns 404 for an unknown sessionId', async () => {
    const res = await request(app).get('/api/scraper/progress/nonexistent_session_123');
    expect(res.status).toBe(404);
  });

  it('returns an SSE stream for a valid sessionId', async () => {
    // Start a replay session (no HAR → fails fast, which is fine here)
    const startRes = await request(app)
      .post('/api/scraper/start')
      .send({ bank: 'chase', mode: 'replay' });
    const { sessionId } = startRes.body;

    // Wait a moment for the async error to be recorded
    await new Promise(r => setTimeout(r, 600));

    // SSE endpoint should respond 200 with text/event-stream
    const res = await request(app)
      .get(`/api/scraper/progress/${sessionId}`)
      .buffer(false)   // don't buffer the SSE stream
      .timeout({ response: 3000, deadline: 5000 });

    expect([200, 206]).toContain(res.status);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/scraper/cancel/:sessionId', () => {
  let app;
  beforeAll(() => { app = buildApp('localhost'); });
  afterAll (() => { app._cleanup(); });

  it('returns { ok: true } for an unknown sessionId (idempotent)', async () => {
    const res = await request(app)
      .post('/api/scraper/cancel/totally_made_up_id')
      .send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('localhostOnly middleware', () => {
  it('allows requests from localhost', async () => {
    const app = buildApp('localhost');
    const res = await request(app).get('/api/scraper/banks');
    expect(res.status).toBe(200);
    app._cleanup();
  });

  it('allows requests from 127.0.0.1', async () => {
    const app = buildApp('127.0.0.1');
    const res = await request(app).get('/api/scraper/banks');
    expect(res.status).toBe(200);
    app._cleanup();
  });

  it('allows requests from ::1', async () => {
    const app = buildApp('::1');
    const res = await request(app).get('/api/scraper/banks');
    expect(res.status).toBe(200);
    app._cleanup();
  });

  it('blocks requests from a public hostname (mycaishen.ai)', async () => {
    const app = buildApp('mycaishen.ai');
    const res = await request(app).get('/api/scraper/banks');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only available when running.*locally/i);
    app._cleanup();
  });

  it('blocks requests from an arbitrary external hostname', async () => {
    const app = buildApp('attacker.example.com');
    const res = await request(app).post('/api/scraper/start').send({ bank: 'chase', mode: 'live' });
    expect(res.status).toBe(403);
    app._cleanup();
  });
});
