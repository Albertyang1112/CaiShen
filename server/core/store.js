'use strict';
/**
 * core/store.js — DB-backed per-user data layer with a synchronous interface.
 *
 * Why this shape: the app reads/writes its per-user "files" synchronously in ~200
 * places. Rather than rewrite all of them async, we preload each user's working set
 * into memory at startup; reads are sync (from cache), writes update the cache and
 * persist to the DB. No local file I/O for per-user data.
 *
 * Persistence targets:
 *   • accounts.json / transactions.json → structured tables (via banking-store)
 *   • everything else (+ CSV/text)      → user_kv
 *
 * Durability: writes persist asynchronously and are tracked; flush() drains them on
 * graceful shutdown. A hard crash can lose the last in-flight write (sub-second
 * window) — acceptable here, and the pre-flip JSON files remain as a recovery point
 * until we delete them. Global (non-user) config still uses files in index.js.
 *
 * Scale note: the cache holds the working set in RAM (fine at current scale; the
 * Banking hot path already uses async indexed queries via banking-store). The path
 * to large scale is paginating the few background readers off the cache.
 */
const { query } = require('./db');
const bank = require('./banking-store');

const cache = new Map();              // userId -> Map(docKey -> value)
const _pending = new Set();           // in-flight persist promises (drained by flush)

function bucket(uid) { if (!cache.has(uid)) cache.set(uid, new Map()); return cache.get(uid); }
function track(p) { _pending.add(p); Promise.resolve(p).finally(() => _pending.delete(p)); return p; }

/** Load every user's working set from the DB into memory. Call once at startup. */
async function preloadAll() {
  cache.clear();
  const users = await query('SELECT id FROM users');
  for (const { id } of users.rows) {
    const b = bucket(id);
    const kv = await query('SELECT doc_key, text_data FROM user_kv WHERE user_id = $1', [id]);
    for (const r of kv.rows) {
      b.set(r.doc_key, r.doc_key.endsWith('.json') && r.text_data != null ? JSON.parse(r.text_data) : r.text_data);
    }
    b.set('accounts.json', await bank.listAccounts(id));
    b.set('transactions.json', await bank.listTransactions(id));
  }
  console.log(`✓ Data layer preloaded from DB (${cache.size} user(s), in-memory cache)`);
}

function read(file, uid) {
  if (!uid) return null;
  const b = cache.get(uid);
  return b && b.has(file) ? b.get(file) : null;
}

function write(file, data, uid) {
  if (!uid) return false;
  bucket(uid).set(file, data);
  let p;
  if (file === 'accounts.json')          p = bank.mirrorAccounts(uid, data);
  else if (file === 'transactions.json') p = bank.mirrorTransactions(uid, data);
  else p = query(
    `INSERT INTO user_kv (user_id, doc_key, text_data, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, doc_key) DO UPDATE SET text_data = EXCLUDED.text_data, data = NULL, updated_at = NOW()`,
    [uid, file, JSON.stringify(data)]
  );
  // The chart of accounts also mirrors into its relational table (JSON above stays source).
  if (file === 'chart_of_accounts.json') {
    track(require('./coa-store').mirrorChartOfAccounts(uid, data).catch(e => console.error('[store] coa mirror:', e.message)));
  }
  track(Promise.resolve(p).catch(e => console.error(`[store] persist ${file}:`, e.message)));
  return true;
}

function readText(file, uid) {
  if (!uid) return null;
  const b = cache.get(uid);
  const v = b && b.has(file) ? b.get(file) : null;
  return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));
}

function writeText(file, text, uid) {
  if (!uid) return false;
  bucket(uid).set(file, text);
  track(query(
    `INSERT INTO user_kv (user_id, doc_key, text_data, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, doc_key) DO UPDATE SET text_data = EXCLUDED.text_data, data = NULL, updated_at = NOW()`,
    [uid, file, text]
  ).catch(e => console.error(`[store] persistText ${file}:`, e.message)));
  return true;
}

/** Await all in-flight persists — call on graceful shutdown. */
async function flush() { await Promise.allSettled([..._pending]); }

module.exports = { preloadAll, read, write, readText, writeText, flush };
