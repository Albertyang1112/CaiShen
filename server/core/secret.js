'use strict';
/**
 * core/secret.js — field-level encryption for secrets at rest (Plaid access tokens,
 * and any PII we choose to protect). AES-256-GCM with a key from FIELD_ENCRYPTION_KEY.
 *
 * Stored format (BYTEA): [12-byte IV][16-byte GCM auth tag][ciphertext].
 * GCM gives us authenticated encryption — tampering with the ciphertext fails decryption.
 *
 * The key lives in .env (gitignored). This seam upgrades cleanly to a managed KMS later
 * by swapping getKey() for a KMS call — call sites don't change.
 */
const crypto = require('crypto');

function getKey() {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) throw new Error('FIELD_ENCRYPTION_KEY not set in .env (need a 32-byte base64 or 64-hex key)');
  const buf = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), 'hex')
    : Buffer.from(raw.trim(), 'base64');
  if (buf.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return buf;
}

/** Encrypt a UTF-8 string → Buffer (store as BYTEA). */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** Decrypt a Buffer (from BYTEA) → UTF-8 string. */
function decrypt(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const iv  = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const ct  = b.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
