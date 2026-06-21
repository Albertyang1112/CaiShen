'use strict';
// Pure parsing/normalization + image-preprocessing tests for banking/receipt-ocr.js (no network).
const { parseOcrJson, normalizeOcr, preprocessImage } = require('../banking/receipt-ocr');
const sharp = require('sharp');

describe('receipt OCR parsing', () => {
  test('parseOcrJson handles fenced, bare, and embedded JSON', () => {
    expect(parseOcrJson('```json\n{"total": 5}\n```')).toEqual({ total: 5 });
    expect(parseOcrJson('here you go: {"total": 9} thanks')).toEqual({ total: 9 });
    expect(parseOcrJson('not json at all')).toEqual({});
  });

  const DUP = { time: null, receipt_number: null, order_number: null, invoice_number: null, card_last4: null, rotate_cw_to_upright: 0 };

  test('normalizeOcr coerces money strings, supports name/desc, keeps the gate + dedup fields', () => {
    expect(normalizeOcr({ is_receipt: true, doc_type: 'receipt', merchant: 'Walmart', total: '$14.99', date: '2026-06-15', card_last4: 'xxxx2210', items: [{ name: 'Milk', amount: '3.50' }] }))
      .toEqual({ is_receipt: true, doc_type: 'receipt', merchant: 'Walmart', total: 14.99, date: '2026-06-15', ...DUP, card_last4: '2210', items: [{ desc: 'Milk', amount: 3.5 }] });
  });

  test('normalizeOcr defaults missing fields (is_receipt null when unclassified)', () => {
    expect(normalizeOcr({})).toEqual({ is_receipt: null, doc_type: null, merchant: null, total: null, date: null, ...DUP, items: [] });
    expect(normalizeOcr({ is_receipt: false, doc_type: 'other', total: 'N/A' }))
      .toEqual({ is_receipt: false, doc_type: 'other', merchant: null, total: null, date: null, ...DUP, items: [] });
  });

  test('normalizeOcr coerces rotate_cw_to_upright to a 90° multiple (default 0)', () => {
    expect(normalizeOcr({ rotate_cw_to_upright: 180 }).rotate_cw_to_upright).toBe(180);
    expect(normalizeOcr({ rotate_cw_to_upright: '90' }).rotate_cw_to_upright).toBe(90);
    expect(normalizeOcr({ rotate_cw_to_upright: 45 }).rotate_cw_to_upright).toBe(0);
    expect(normalizeOcr({}).rotate_cw_to_upright).toBe(0);
  });
});

describe('preprocessImage (sharp normalization before OCR)', () => {
  // solid-color test images; orient lets us stamp an EXIF orientation tag.
  const img = (w, h, orient) => {
    let s = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 200, b: 200 } } });
    if (orient) s = s.withMetadata({ orientation: orient });
    return s.jpeg().toBuffer();
  };

  test('re-encodes images to JPEG', async () => {
    const { buffer, mimeType } = await preprocessImage(await img(800, 600), 'image/png');
    expect(mimeType).toBe('image/jpeg');
    expect((await sharp(buffer).metadata()).format).toBe('jpeg');
  });

  test('applies EXIF orientation — a sideways (orient 6) shot comes out upright', async () => {
    // orientation 6 = display rotated 90°, so a 400×200 frame should render as 200×400.
    const { buffer } = await preprocessImage(await img(400, 200, 6), 'image/jpeg');
    const meta = await sharp(buffer).metadata();
    expect([meta.width, meta.height]).toEqual([200, 400]);
    expect(meta.orientation == null || meta.orientation === 1).toBe(true);  // tag baked in + cleared
  });

  test('caps the long edge at 2048px (downscales oversized photos)', async () => {
    const { buffer } = await preprocessImage(await img(3000, 200), 'image/jpeg');
    expect((await sharp(buffer).metadata()).width).toBe(2048);              // aspect preserved
  });

  test('does not enlarge small images', async () => {
    const { buffer } = await preprocessImage(await img(120, 80), 'image/jpeg');
    expect((await sharp(buffer).metadata()).width).toBe(120);
  });

  test('passes non-images through untouched', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake');
    expect(await preprocessImage(pdf, 'application/pdf')).toEqual({ buffer: pdf, mimeType: 'application/pdf' });
  });

  test('falls back to the raw bytes when sharp cannot decode (never worse than raw)', async () => {
    const junk = Buffer.from('definitely not an image');
    const res = await preprocessImage(junk, 'image/jpeg');
    expect(res.buffer).toBe(junk);                                          // same reference returned
    expect(res.mimeType).toBe('image/jpeg');
  });
});

describe('orientation sweep (layer 2)', () => {
  const { isEmptyRead, rotateJpeg, sweepRotations } = require('../banking/receipt-ocr');
  const dims = async (buf) => { const m = await sharp(buf).metadata(); return [m.width, m.height]; };

  test('isEmptyRead flags reads with no merchant and no total', () => {
    expect(isEmptyRead(null)).toBe(true);
    expect(isEmptyRead({ merchant: null, total: null })).toBe(true);
    expect(isEmptyRead({ merchant: 'Walmart', total: null })).toBe(false);
    expect(isEmptyRead({ merchant: null, total: 5 })).toBe(false);
  });

  test('rotateJpeg swaps dimensions at 90°, preserves them at 180°', async () => {
    const img = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
    expect(await dims(await rotateJpeg(img, 90))).toEqual([200, 400]);
    expect(await dims(await rotateJpeg(img, 180))).toEqual([400, 200]);
  });

  test('sweep returns the first angle that reads and stops early', async () => {
    const tried = [];
    const rotate = async (_b, deg) => { tried.push(deg); return Buffer.from('x'); };
    const visionOCR = async () => (tried[tried.length - 1] === 90 ? { merchant: 'Cane', total: 21.59 } : { merchant: null, total: null });
    const r = await sweepRotations(Buffer.from('pre'), visionOCR, { rotate });
    expect(tried).toEqual([180, 90]);          // 270 never tried
    expect(r._rotated).toBe(90);
    expect(r.merchant).toBe('Cane');
  });

  test('sweep returns null when every rotation is still empty', async () => {
    let calls = 0;
    const r = await sweepRotations(Buffer.from('pre'),
      async () => { calls++; return { merchant: null, total: null }; },
      { rotate: async () => Buffer.from('x') });
    expect(r).toBeNull();
    expect(calls).toBe(3);
  });

  test('sweep skips an angle whose OCR throws and keeps going', async () => {
    const visionOCR = async (buf) => { if (String(buf) === 'boom') throw new Error('nope'); return { merchant: 'Target', total: 9 }; };
    const rotate = async (_b, deg) => Buffer.from(deg === 180 ? 'boom' : 'ok');
    const r = await sweepRotations(Buffer.from('pre'), visionOCR, { rotate });
    expect(r._rotated).toBe(90);               // 180 threw, 90 succeeded
  });

  test('correctiveRotation reads the model orientation hint (else 0)', () => {
    const { correctiveRotation } = require('../banking/receipt-ocr');
    expect(correctiveRotation({ rotate_cw_to_upright: 180 })).toBe(180);
    expect(correctiveRotation({ rotate_cw_to_upright: 0 })).toBe(0);
    expect(correctiveRotation({ rotate_cw_to_upright: 45 })).toBe(0);   // invalid → 0
    expect(correctiveRotation(null)).toBe(0);
  });
});
