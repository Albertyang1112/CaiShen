'use strict';
/**
 * core/r2.js — Cloudflare R2 object storage (S3-compatible) for document files.
 *
 * Big binary files (statement PDFs, receipt images) live here, not in Postgres.
 * The `documents` table holds metadata + the object key; the bytes live in R2.
 * Credentials come from R2_* in .env (gitignored). Downloads use short-lived
 * signed URLs so files are never public.
 */
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET     = process.env.R2_BUCKET;
const configured = !!(ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && BUCKET);

let _client = null;
function client() {
  if (!configured) throw new Error('R2 not configured — set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET in .env');
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

async function putObject(key, body, contentType) {
  await client().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
  return key;
}

async function getObject(key) {
  const r = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}

async function deleteObject(key) {
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function exists(key) {
  try { await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

/** Short-lived (default 5 min) signed GET url so files are never public. */
async function signedDownloadUrl(key, expiresIn = 300) {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

module.exports = { configured, BUCKET, putObject, getObject, deleteObject, exists, signedDownloadUrl };
