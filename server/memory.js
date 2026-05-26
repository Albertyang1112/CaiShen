/**
 * memory.js — per-user persistent memory / preferences / notes store
 *
 * Routes:
 *   GET  /api/memory          — load full memory object
 *   POST /api/memory          — deep-merge update (nested keys preserved)
 *   PUT  /api/memory/:key     — set one top-level key  { value: ... }
 *   DEL  /api/memory/:key     — remove one top-level key
 *
 * Stored in data/users/{id}/memory.json
 * Schema is open — any JSON-serialisable shape is accepted.
 */
const express = require('express');

module.exports = function(makeIO) {
  const router = express.Router();

  // ── Load ──────────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    const mem = makeIO(req.user.id).read('memory.json') || {};
    res.json(mem);
  });

  // ── Deep-merge update ─────────────────────────────────────────────────
  router.post('/', (req, res) => {
    const io  = makeIO(req.user.id);
    const mem = io.read('memory.json') || {};
    const updated = deepMerge(mem, req.body || {});
    io.write('memory.json', updated);
    res.json(updated);
  });

  // ── Set a single top-level key ────────────────────────────────────────
  router.put('/:key', (req, res) => {
    const io  = makeIO(req.user.id);
    const mem = io.read('memory.json') || {};
    mem[req.params.key] = req.body?.value;
    io.write('memory.json', mem);
    res.json({ key: req.params.key, value: mem[req.params.key] });
  });

  // ── Delete a top-level key ────────────────────────────────────────────
  router.delete('/:key', (req, res) => {
    const io  = makeIO(req.user.id);
    const mem = io.read('memory.json') || {};
    delete mem[req.params.key];
    io.write('memory.json', mem);
    res.json({ ok: true });
  });

  return { router };
};

// ── Helpers ───────────────────────────────────────────────────────────────
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
