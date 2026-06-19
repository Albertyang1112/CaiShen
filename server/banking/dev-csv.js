'use strict';
/**
 * dev-csv.js — DEV-ONLY CSV inspector (mounted localhost-only in index.js).
 *
 * Lists every CSV blob stored in the database (user_kv.text_data) for the current
 * user, grouped into Plaid / Statement / Confirmed, with row counts + the raw text
 * for viewing. The "confirmed" CSV is (re)derived from the matched statement_matches
 * on each load, so it always reflects the current reconciliation state.
 *
 * Temporary debugging aid — delete this file + its mount line in index.js to remove.
 */
const express = require('express');
const { query } = require('../core/db');
const csv = require('../core/csv');
const { refreshConfirmedCsv } = require('../core/csv-store');

// Bucket a CSV doc_key into the three lists the dev page shows. 'confirmed' is
// checked first so it never falls through to plaid/statement.
function categorize(key) {
  const k = (key || '').toLowerCase();
  if (k.includes('confirm'))                       return 'confirmed';
  if (k.includes('plaid'))                         return 'plaid';
  if (k.includes('statement') || k.includes('stmt')) return 'statement';
  return 'other';
}

module.exports = function makeDevCsvRouter() {
  const router = express.Router();

  // GET /api/dev-csv — all CSV blobs for this user, grouped, with content.
  router.get('/', async (req, res) => {
    try {
      const uid = req.user.id;

      // Keep the derived "confirmed" CSV current before listing (non-fatal if it fails).
      let confirmedRows = 0;
      try { confirmedRows = await refreshConfirmedCsv(query, uid); } catch (e) { console.error('[dev-csv] confirmed:', e.message); }

      const r = await query(
        `SELECT doc_key, text_data, length(text_data) AS bytes, updated_at
           FROM user_kv WHERE user_id = $1 AND doc_key LIKE '%.csv'
          ORDER BY doc_key`, [uid]);

      const groups = { plaid: [], statement: [], confirmed: [], other: [] };
      for (const row of r.rows) {
        const text = row.text_data || '';
        let rows = 0;
        try { rows = csv.parse(text).length; } catch {}
        groups[categorize(row.doc_key)].push({
          key:       row.doc_key,
          bytes:     Number(row.bytes) || 0,
          rows,
          updatedAt: row.updated_at,
          text,
        });
      }

      res.json({ groups, confirmedRows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
