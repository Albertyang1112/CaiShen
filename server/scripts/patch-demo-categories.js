'use strict';
// Demo helper: set the stored category of specific transactions THROUGH the running server
// (PATCH /api/transactions/:id) so the server cache + DB + web UI all stay consistent — then
// the bot visibly changes them when you reply. Usage: node server/scripts/patch-demo-categories.js
require('./_env');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { query } = require('../core/db');
const { idForPath } = require('../accounting/categories');

const USER = process.argv[2] || '1779502545957';
const JWT_SECRET = process.env.JWT_SECRET || 'caishen-local-jwt-secret-change-me';
const BASE = process.env.DEMO_BASE || 'http://localhost:3001';

// [search, category path] — match the suggestions the bot is showing for the demo.
const PATCHES = [
  ['chipotle',     ['Personal Expenses', 'Food & Dining', 'Fast Food']],
  ['pf inglewood', ['Personal Expenses', 'Health & Medical']],
];

(async () => {
  const token = jwt.sign({ id: USER, role: 'admin' }, JWT_SECRET, { expiresIn: '10m' });
  const headers = { Authorization: `Bearer ${token}` };
  for (const [search, catPath] of PATCHES) {
    const coaId = idForPath(catPath);
    const r = await query(`SELECT id, description FROM transactions WHERE user_id=$1 AND description ILIKE $2 LIMIT 1`, [USER, `%${search}%`]);
    if (!r.rows[0]) { console.log(`SKIP — no txn for "${search}"`); continue; }
    const { id, description } = r.rows[0];
    try {
      const resp = await axios.patch(`${BASE}/api/transactions/${encodeURIComponent(id)}`,
        { coaId, approved: true, coaAuto: false }, { headers });
      console.log(`PATCHED "${description}" → ${catPath.join(' › ')}  (coaId=${resp.data.coaId})`);
    } catch (e) { console.error(`FAIL "${description}":`, e.response?.status, e.response?.data?.error || e.message); }
  }
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
