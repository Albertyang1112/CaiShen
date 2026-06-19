'use strict';
/**
 * banking/messaging-store.js — DB helpers for the channel-generic messaging identity:
 *   • messaging_links       — an external chat identity (Discord user, SMS phone) ↔ user
 *   • messaging_link_codes  — the short-lived code that powers the link handshake
 *
 * All take `query` (core/db.query) as the first arg so they're testable with a fake.
 * Channel-agnostic on purpose: 'discord' today, 'sms' (Twilio) later with no changes here.
 */
const crypto = require('crypto');

// Unambiguous code alphabet (no 0/O/1/I) so codes are easy to read + retype.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(len = 6) {
  const b = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

// "link ABC123" or "/link ABC123" → "ABC123" (uppercased); else null.
const LINK_RE = /^\s*\/?link\s+([A-Za-z0-9]{4,12})\s*$/i;
function parseLinkCommand(text) {
  const m = LINK_RE.exec(text || '');
  return m ? m[1].toUpperCase() : null;
}

async function createLinkCode(query, userId, { channel = null } = {}) {
  const code = genCode();
  await query(
    `INSERT INTO messaging_link_codes (code, user_id, channel, expires_at)
     VALUES ($1,$2,$3, NOW() + INTERVAL '15 minutes')`,
    [code, userId, channel]);
  return code;
}

// Exchange a still-valid code for a link. Returns { ok, userId? }. Re-binds on conflict
// (an external identity already linked just points at the new user).
async function redeemLinkCode(query, code, { channel, externalId, displayName = null }) {
  const norm = String(code || '').toUpperCase();
  const r = await query(
    `SELECT user_id FROM messaging_link_codes WHERE code=$1 AND used=FALSE AND expires_at > NOW() LIMIT 1`,
    [norm]);
  if (!r.rows[0]) return { ok: false };
  const userId = r.rows[0].user_id;
  await query(
    `INSERT INTO messaging_links (id, user_id, channel, external_id, display_name)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel, external_id)
       DO UPDATE SET user_id=EXCLUDED.user_id, display_name=EXCLUDED.display_name, linked_at=NOW()`,
    [`mlk_${crypto.randomBytes(6).toString('hex')}`, userId, channel, externalId, displayName]);
  await query(`UPDATE messaging_link_codes SET used=TRUE WHERE code=$1`, [norm]);
  return { ok: true, userId };
}

async function userForExternal(query, channel, externalId) {
  const r = await query(
    `SELECT user_id FROM messaging_links WHERE channel=$1 AND external_id=$2 LIMIT 1`, [channel, externalId]);
  return r.rows[0] ? r.rows[0].user_id : null;
}

async function listLinks(query, userId) {
  const r = await query(
    `SELECT channel, external_id, display_name, linked_at FROM messaging_links WHERE user_id=$1 ORDER BY linked_at DESC`,
    [userId]);
  return r.rows;
}

async function unlink(query, userId, channel) {
  await query(`DELETE FROM messaging_links WHERE user_id=$1 AND channel=$2`, [userId, channel]);
  return { ok: true };
}

module.exports = { genCode, parseLinkCommand, createLinkCode, redeemLinkCode, userForExternal, listLinks, unlink };
