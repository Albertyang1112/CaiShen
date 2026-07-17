'use strict';
/**
 * banking/property-link.js — "is this a new property?" conversational flow.
 *
 * When an insurance bill's insured address doesn't match any of the user's properties,
 * the recorder queues a question instead of silently leaving the policy unlinked:
 *
 *   "This CEA earthquake bill covers 654 Alcita Ct, which isn't one of your properties.
 *    Reply with a name to add it (e.g. 'Alcita'), 'yes' to use the address as the name,
 *    or 'no' to leave it unassigned."
 *
 * On a name/yes: create the property in properties.json, link the policy
 * (insurance_policies.property_id), and move the filed bill from Insurance/{carrier}/…
 * to Insurance/{property name}/…. Rides the txn_messages queue (kind='property') like the
 * cash/dedup questions; the categorizer never sees it (it filters kind='confirm').
 */
const crypto = require('crypto');

const normAddr = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function questionText(p) {
  const what = [p.carrier, p.coverageType].filter(Boolean).join(' ') || 'insurance';
  return `🏠 This ${what} bill covers ${p.address}, which isn't one of your properties yet. `
       + `Reply with a name to add it (e.g. 'Alcita'), 'yes' to use the address as the name, or 'no' to leave it unassigned.`;
}

/**
 * Queue the question (state 'open' → the bot's delivery loop sends it; chat-originated
 * callers can inline-ask and then markAsked). Deduped per normalized address across
 * open/asked property questions. Returns { id, text } or null when deduped.
 */
async function createPropertyQuestion(query, userId, { policyId, address, carrier, coverageType, fileId, year }) {
  if (!address) return null;
  const open = await query(
    `SELECT payload FROM txn_messages WHERE user_id=$1 AND kind='property' AND state IN ('open','asked')`, [userId]);
  for (const r of open.rows) {
    const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
    if (normAddr(p.address) === normAddr(address)) return null;   // already being asked
  }
  const id = `txm_${crypto.randomBytes(6).toString('hex')}`;
  const payload = { policyId, address, carrier: carrier || null, coverageType: coverageType || null,
                    fileId: fileId || null, year: year || null };
  await query(
    `INSERT INTO txn_messages (id,user_id,transaction_id,channel,kind,state,payload)
     VALUES ($1,$2,NULL,'discord','property','open',$3)`, [id, userId, JSON.stringify(payload)]);
  return { id, text: questionText(payload) };
}

async function markAsked(query, id) {
  await query(`UPDATE txn_messages SET state='asked' WHERE id=$1`, [id]);
}

// The question this user is currently being asked (for inbound reply routing).
async function pendingPropertyQuestion(query, userId) {
  const r = await query(
    `SELECT * FROM txn_messages WHERE user_id=$1 AND kind='property' AND state='asked' ORDER BY created_at DESC LIMIT 1`, [userId]);
  const row = r.rows[0];
  if (row && typeof row.payload === 'string') row.payload = JSON.parse(row.payload);
  return row || null;
}

// Oldest queued question → mark asked + return its text (for the bot's delivery loop).
async function nextOpenPropertyQuestion(query, userId) {
  const r = await query(
    `SELECT * FROM txn_messages WHERE user_id=$1 AND kind='property' AND state='open' ORDER BY created_at ASC LIMIT 1`, [userId]);
  const row = r.rows[0];
  if (!row) return null;
  await markAsked(query, row.id);
  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  return questionText(p);
}

// Metadata-only vault move (R2 bytes are keyed by file id) — same semantics as /api/vault/move.
function moveVaultFile(io, fileId, targetPath) {
  const meta = io.read('vault.json');
  if (!meta || !Array.isArray(meta.files)) return false;
  const f = meta.files.find(x => x.id === fileId);
  if (!f) return false;
  const parts = String(targetPath).split('/').filter(Boolean);
  let parentId = null, folderId = null;
  for (let i = 0; i < parts.length; i++) {
    const fullPath = parts.slice(0, i + 1).join('/');
    let folder = meta.folders.find(x => x.path === fullPath);
    if (!folder) {
      folder = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                 name: parts[i], path: fullPath, parentId, createdAt: new Date().toISOString(), tags: {} };
      meta.folders.push(folder);
    }
    parentId = folder.id; folderId = folder.id;
  }
  f.folderPath = parts.join('/');
  f.folderId = folderId;
  f.updatedAt = new Date().toISOString();
  io.write('vault.json', meta);
  return true;
}

const NO_RE  = /^\s*(no|n|nope|skip|leave it|cancel|don'?t)\s*\.?\s*$/i;
const YES_RE = /^\s*(yes|y|yeah|yep|add|add it|sure|ok|okay)\s*\.?\s*$/i;

// Handle the user's reply → { replies }. A bare "yes" names the property by its address;
// any other text (2–40 chars) becomes the property's name.
async function handlePropertyAnswer(query, io, userId, q, text) {
  const p = q.payload || {};
  if (NO_RE.test(text)) {
    await query(`UPDATE txn_messages SET state='answered' WHERE id=$1`, [q.id]);
    return { replies: ["👍 Left unassigned — you can add properties in the Real Estate tab anytime, and I'll re-link on the next bill."] };
  }
  let name = YES_RE.test(text) ? String(p.address || '').trim() : String(text || '').trim();
  if (!name || name.length < 2 || name.length > 40) {
    return { replies: [`Reply with a short name for ${p.address} (e.g. 'Alcita'), 'yes' to use the address, or 'no' to skip.`] };
  }

  // If a matching property appeared meanwhile (added in the UI), reuse it instead of duplicating.
  const { resolvePropertyId } = require('./insurance');
  const props = io.read('properties.json') || [];
  let propId = resolvePropertyId(io, p.address);
  if (!propId) {
    const prop = { id: Date.now().toString(), name, address: p.address, createdAt: new Date().toISOString() };
    io.write('properties.json', [...props, prop]);
    propId = prop.id;
  } else {
    name = (props.find(x => x.id === propId) || {}).name || name;
  }

  if (p.policyId) {
    await query(`UPDATE insurance_policies SET property_id=$2, updated_at=NOW() WHERE id=$1 AND user_id=$3`,
      [p.policyId, propId, userId]);
  }
  // Refile the bill under the property's name so the vault tree reads by property.
  let moved = false;
  if (p.fileId) {
    const folder = p.year ? `Insurance/${name}/${p.year}` : `Insurance/${name}`;
    try { moved = moveVaultFile(io, p.fileId, folder); } catch { moved = false; }
  }
  await query(`UPDATE txn_messages SET state='answered' WHERE id=$1`, [q.id]);
  const covLabel = [p.carrier, p.coverageType].filter(Boolean).join(' ') || 'insurance';
  return { replies: [`✅ Added ${name} (${p.address}) and linked your ${covLabel} policy.`
    + (moved ? ` Filed the bill under Insurance/${name}${p.year ? `/${p.year}` : ''}.` : '')] };
}

module.exports = { createPropertyQuestion, pendingPropertyQuestion, nextOpenPropertyQuestion,
                   handlePropertyAnswer, moveVaultFile, markAsked, questionText };
