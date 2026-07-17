'use strict';
/**
 * banking/re-suggest.js — surface property addresses found on ingested documents.
 *
 * Mortgage statements (mortgage_accounts.property_street, or an address-like property_id
 * string the statement import stored) and insurance policies (insurance_policies
 * .insured_address) carry printed property addresses. When one doesn't match any property
 * in the user's portfolio (properties.json), the Real Estate → Properties tab offers to
 * add it. Dismissals persist per-user (re_dismissed_addresses.json) so a suggestion never
 * nags twice; accepting links the source rows' property_id to the new property so the
 * Mortgage/Insurance tabs label by property name from then on.
 *
 *   GET  /api/re/address-suggestions          → [{ key, address, sources:[{type,label}],
 *                                                  mortgageAccountIds:[], policyIds:[] }]
 *   POST /api/re/address-suggestions/dismiss  { key }
 *   POST /api/re/address-suggestions/link     { propertyId, mortgageAccountIds, policyIds }
 */
const express = require('express');
const { query } = require('../core/db');

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// First line/segment of an address = the street — the stable key for matching + dedup.
const streetOf = s => norm(String(s || '').split(/[\n,]/)[0]);

// Address matches a portfolio property when either street contains the other — the same
// conservative overlap rule banking/liabilities.js uses (a wrong match is worse than none).
// Properties created in the UI store the address as `addr`; older data may use `address`.
function matchesProperty(street, properties) {
  if (!street) return true;   // nothing usable — never suggest it
  for (const p of properties || []) {
    const pStreet = streetOf(p.addr || p.address || '');
    const pName   = norm(p.name || '');
    if (pStreet && (street.includes(pStreet) || pStreet.includes(street))) return true;
    if (pName && (street.includes(pName) || pName.includes(street))) return true;
  }
  return false;
}

module.exports = function (makeIO) {
  const router = express.Router();

  router.get('/address-suggestions', async (req, res) => {
    try {
      const uid = req.user.id;
      const io = makeIO(uid);
      const properties = io.read('properties.json') || [];
      const propIds = new Set(properties.map(p => p.id));
      const dismissed = new Set(io.read('re_dismissed_addresses.json') || []);

      const found = new Map();   // street key → suggestion
      const add = (address, source, ids = {}) => {
        const key = streetOf(address);
        if (!key || dismissed.has(key) || matchesProperty(key, properties)) return;
        const cur = found.get(key) || { key, address, sources: [], mortgageAccountIds: [], policyIds: [] };
        cur.sources.push(source);
        if (ids.mortgageAccountId) cur.mortgageAccountIds.push(ids.mortgageAccountId);
        if (ids.policyId) cur.policyIds.push(ids.policyId);
        found.set(key, cur);
      };

      const morts = (await query(
        `SELECT id, servicer, loan_number_mask, property_id, property_street, property_city,
                property_region, property_postal_code
           FROM mortgage_accounts WHERE user_id=$1`, [uid])).rows;
      for (const m of morts) {
        if (m.property_id && propIds.has(m.property_id)) continue;   // already linked
        // Prefer the Plaid Liabilities columns; else an address-like property_id string from
        // the statement import (a vault folder name, not a portfolio id — must contain a digit).
        const full = m.property_street
          ? [m.property_street, [m.property_city, m.property_region, m.property_postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ')
          : (m.property_id && /\d/.test(m.property_id) ? m.property_id : null);
        if (!full) continue;
        add(full,
          { type: 'mortgage', label: `${m.servicer || 'mortgage'}${m.loan_number_mask ? ` ••••${m.loan_number_mask}` : ''} statement` },
          { mortgageAccountId: m.id });
      }

      const pols = (await query(
        `SELECT id, carrier, coverage_type, property_id, insured_address
           FROM insurance_policies WHERE user_id=$1 AND insured_address IS NOT NULL`, [uid])).rows;
      for (const p of pols) {
        if (p.property_id && propIds.has(p.property_id)) continue;
        add(p.insured_address,
          { type: 'insurance', label: `${p.carrier || 'insurance'}${p.coverage_type ? ` ${p.coverage_type}` : ''} policy` },
          { policyId: p.id });
      }

      res.json([...found.values()]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/address-suggestions/dismiss', (req, res) => {
    const io = makeIO(req.user.id);
    const key = streetOf((req.body || {}).key || (req.body || {}).address);
    if (!key) return res.status(400).json({ error: 'key required' });
    const list = io.read('re_dismissed_addresses.json') || [];
    if (!list.includes(key)) io.write('re_dismissed_addresses.json', [...list, key]);
    res.json({ dismissed: key });
  });

  // After the user accepts (the property now exists), link the source rows to it.
  router.post('/address-suggestions/link', async (req, res) => {
    try {
      const uid = req.user.id;
      const { propertyId, mortgageAccountIds = [], policyIds = [] } = req.body || {};
      if (!propertyId) return res.status(400).json({ error: 'propertyId required' });
      let linked = 0;
      for (const id of mortgageAccountIds) {
        const r = await query(`UPDATE mortgage_accounts SET property_id=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`, [propertyId, id, uid]);
        linked += r.rowCount || 0;
      }
      for (const id of policyIds) {
        const r = await query(`UPDATE insurance_policies SET property_id=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`, [propertyId, id, uid]);
        linked += r.rowCount || 0;
      }
      res.json({ linked });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
