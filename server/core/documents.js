'use strict';
/**
 * core/documents.js — document storage: bytes in R2, metadata in the `documents`
 * table. This is the single entry point the vault/receipt flows use so files never
 * touch local disk. Downloads go through short-lived signed URLs.
 */
const crypto = require('crypto');
const r2 = require('./r2');
const { query } = require('./db');

function classify(folderPath, tags) {
  const p = (folderPath || '').toLowerCase();
  if (p.includes('bank statement') || tags?.institution) return 'statement';
  if (p.includes('tax'))      return 'tax_form';
  if (p.includes('mortgage')) return 'mortgage';
  if (p.includes('receipt'))  return 'receipt';
  return 'other';
}

/** Store bytes in R2 + upsert a documents row. Returns { id, key }. */
async function saveDocument({ id, userId, accountId = null, name, mimeType, bytes,
                              folderPath = '', tags = {}, periodYear = null, periodMonth = null, uploadedAt = null }) {
  const docId = id || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const key   = `${userId}/${docId}/${name}`;
  const sha   = crypto.createHash('sha256').update(bytes).digest('hex');
  await r2.putObject(key, bytes, mimeType || 'application/octet-stream');
  await query(
    `INSERT INTO documents (id,user_id,account_id,doc_type,storage_key,storage_bucket,original_name,mime_type,size_bytes,sha256,period_year,period_month,tags,uploaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO UPDATE SET storage_key=EXCLUDED.storage_key, size_bytes=EXCLUDED.size_bytes,
       sha256=EXCLUDED.sha256, tags=EXCLUDED.tags, mime_type=EXCLUDED.mime_type`,
    [docId, userId, accountId, classify(folderPath, tags), key, r2.BUCKET, name, mimeType,
     bytes.length, sha, periodYear, periodMonth, JSON.stringify(tags || {}), uploadedAt || new Date().toISOString()]
  );
  return { id: docId, key };
}

async function getDocumentBytes(userId, docId) {
  const r = await query(`SELECT storage_key FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId]);
  return r.rows.length ? r2.getObject(r.rows[0].storage_key) : null;
}

/** Short-lived signed download URL (files are never public). */
async function signedUrl(userId, docId, expiresIn = 300) {
  const r = await query(`SELECT storage_key FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId]);
  return r.rows.length ? r2.signedDownloadUrl(r.rows[0].storage_key, expiresIn) : null;
}

async function listDocuments(userId) {
  const r = await query(
    `SELECT id, doc_type, original_name, mime_type, size_bytes, period_year, period_month, tags, uploaded_at
       FROM documents WHERE user_id=$1 ORDER BY uploaded_at DESC`, [userId]);
  return r.rows;
}

async function deleteDocument(userId, docId) {
  const r = await query(`SELECT storage_key FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId]);
  if (r.rows.length) { try { await r2.deleteObject(r.rows[0].storage_key); } catch (e) { /* leave orphan rather than fail */ } }
  await query(`DELETE FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId]);
}

/**
 * Rename a document's display name (metadata only). The R2 object is addressed by
 * the stored `storage_key` (which embeds the id), so the bytes never move — only
 * `original_name` changes. Used by vault auto-organize to canonicalise filenames.
 */
async function renameDocument(userId, docId, newName) {
  await query(`UPDATE documents SET original_name=$1 WHERE id=$2 AND user_id=$3`, [newName, docId, userId]);
}

/** Cheap existence check (no R2 round-trip) — does a documents row exist for this id? */
async function documentExists(userId, docId) {
  const r = await query(`SELECT 1 FROM documents WHERE id=$1 AND user_id=$2`, [docId, userId]);
  return r.rows.length > 0;
}

module.exports = { saveDocument, getDocumentBytes, signedUrl, listDocuments, deleteDocument, renameDocument, documentExists, classify };
