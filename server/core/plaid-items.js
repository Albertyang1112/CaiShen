'use strict';
/**
 * core/plaid-items.js — the system of record for Plaid connections.
 * Replaces the plaintext `connections.json` plaid array. Tokens are encrypted at rest
 * (core/secret.js) and only ever decrypted in memory when a sync needs them.
 *
 * Returned item shape matches what the old connections.json entries provided, so
 * syncItem()/the routes keep working: { item_id, access_token, institution_name, ... }.
 */
const { query } = require('./db');
const { encrypt, decrypt } = require('./secret');

function rowToItem(r) {
  return {
    item_id:          r.item_id,
    access_token:     decrypt(r.access_token_enc),
    institution_id:   r.institution_id,
    institution_name: r.institution_name,
    status:           r.status,
    connectedAt:      r.connected_at,
    lastSync:         r.last_sync_at,
  };
}

/** All connections for a user, tokens decrypted. */
async function listItems(userId) {
  const r = await query(`SELECT * FROM plaid_items WHERE user_id = $1 ORDER BY connected_at`, [userId]);
  return r.rows.map(rowToItem);
}

/** Upsert a connection (encrypts the token). Keyed by Plaid item_id. */
async function saveItem(userId, { item_id, access_token, institution_id = null, institution_name = 'Unknown Bank' }) {
  await query(
    `INSERT INTO plaid_items (id, user_id, item_id, access_token_enc, institution_id, institution_name, status, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())
     ON CONFLICT (item_id) DO UPDATE SET
       access_token_enc = EXCLUDED.access_token_enc,
       institution_name = EXCLUDED.institution_name,
       institution_id   = EXCLUDED.institution_id,
       status           = 'active'`,
    [`pi_${item_id}`, userId, item_id, encrypt(access_token), institution_id, institution_name]
  );
}

async function removeItem(userId, item_id) {
  await query(`DELETE FROM plaid_items WHERE user_id = $1 AND item_id = $2`, [userId, item_id]);
}

/** Webhooks arrive with no user context — find who owns an item_id. */
async function findOwner(item_id) {
  const r = await query(`SELECT * FROM plaid_items WHERE item_id = $1 LIMIT 1`, [item_id]);
  return r.rows.length ? { userId: r.rows[0].user_id, item: rowToItem(r.rows[0]) } : null;
}

async function touchSync(item_id) {
  await query(`UPDATE plaid_items SET last_sync_at = NOW() WHERE item_id = $1`, [item_id]);
}

module.exports = { listItems, saveItem, removeItem, findOwner, touchSync };
