'use strict';
// receipt-hash.js — the three dedup hashes + a Hamming-distance helper.
//   • fileSha256     — exact-file duplicate (byte-identical re-upload).
//   • perceptualHash — near-image duplicate (recompressed/cropped same photo), aHash via sharp.
//   • ocrTextHash    — exact-content duplicate (same merchant/total/date/items text).
const crypto = require('crypto');
const sharp = require('sharp');

const fileSha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Average hash: 8×8 greyscale → 1 bit per pixel vs the mean → 16 hex chars (64-bit).
async function perceptualHash(buffer, mimeType) {
  if (!/^image\//.test(mimeType || '')) return null;   // images only (PDFs fall back to other signals)
  try {
    const px = await sharp(buffer).greyscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
    let sum = 0; for (let i = 0; i < 64; i++) sum += px[i];
    const mean = sum / 64;
    let bits = 0n;
    for (let i = 0; i < 64; i++) bits = (bits << 1n) | (px[i] >= mean ? 1n : 0n);
    return bits.toString(16).padStart(16, '0');
  } catch { return null; }
}

// Bit-difference between two equal-length hex hashes (Infinity if incomparable).
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

// Hash of the meaningful OCR content — exact equality ⇒ identical receipt text.
function ocrTextHash(ocr) {
  if (!ocr) return null;
  const items = (Array.isArray(ocr.items) ? ocr.items : [])
    .map(i => String((i && i.desc) || '').toLowerCase().trim()).filter(Boolean).sort();
  const norm = [String(ocr.merchant || '').toLowerCase().trim(), ocr.total, ocr.date, ...items].join('|');
  return crypto.createHash('sha256').update(norm).digest('hex');
}

module.exports = { fileSha256, perceptualHash, hamming, ocrTextHash };
