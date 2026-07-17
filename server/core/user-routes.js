'use strict';
/**
 * core/user-routes.js — small per-user JSON CRUD endpoints extracted out of index.js:
 *   GET/POST/PUT/DELETE /api/properties   (real estate portfolio)
 *   GET/POST            /api/tax-years     (saved tax-year baselines)
 *
 * Faithful move of the former inline handlers: readData/writeData(file, uid) became
 * makeIO(uid).read/write(file). Mounted at /api (after the auth guard) by index.js.
 */
const express = require('express');
const { query } = require('./db');
const { deriveProperties } = require('./property-derive');

module.exports = function makeUserRoutes(makeIO) {
  const router = express.Router();
  const io = (req) => makeIO(req.user.id);

  // ── Properties ──────────────────────────────────────────────────────────────
  // The stored record holds only user-known facts (name, address, color); mortgage
  // balance / rate / payment / monthly expenses are derived live from the linked
  // mortgage, insurance, and tax rows (core/property-derive.js). DB down → raw records.
  router.get('/properties', async (req, res) => {
    const props = io(req).read('properties.json') || [];
    try { res.json(await deriveProperties(query, req.user.id, props)); }
    catch { res.json(props); }
  });

  router.post('/properties', (req, res) => {
    const x = io(req);
    const props = x.read('properties.json') || [];
    const newProp = { id: Date.now().toString(), ...req.body };
    props.push(newProp);
    x.write('properties.json', props);
    res.json(newProp);
  });

  router.put('/properties/:id', (req, res) => {
    const x = io(req);
    const props = x.read('properties.json') || [];
    const idx = props.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    props[idx] = { ...props[idx], ...req.body };
    x.write('properties.json', props);
    res.json(props[idx]);
  });

  router.delete('/properties/:id', (req, res) => {
    const x = io(req);
    x.write('properties.json', (x.read('properties.json') || []).filter(p => p.id !== req.params.id));
    res.json({ success: true });
  });

  // ── Tax-year baselines ──────────────────────────────────────────────────────
  router.get('/tax-years', (req, res) => res.json(io(req).read('tax_years.json')));

  router.post('/tax-years', (req, res) => {
    const x = io(req);
    const years = x.read('tax_years.json') || [];
    const entry = { ...req.body, savedAt: new Date().toISOString() };
    const idx = years.findIndex(y => y.year === entry.year);
    if (idx >= 0) years[idx] = entry; else years.push(entry);
    years.sort((a, b) => b.year - a.year);
    x.write('tax_years.json', years);
    res.json(entry);
  });

  return router;
};
