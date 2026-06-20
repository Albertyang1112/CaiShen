'use strict';
const { dedupeScore, classifyDedupReply } = require('../banking/receipt-dedup');
const { ocrTextHash, hamming, fileSha256 } = require('../banking/receipt-hash');

describe('dedupeScore — hard signals', () => {
  test('identical file hash → hard', () => {
    const r = { file_sha256: 'abc', ocr: {} };
    expect(dedupeScore(r, { file_sha256: 'abc', ocr: {} })).toMatchObject({ level: 'hard', reason: 'file_hash' });
  });
  test('same receipt number → hard (even if merchant/total differ)', () => {
    expect(dedupeScore({ ocr: { merchant: 'X', total: 1, receipt_number: '849202' } },
                       { ocr: { merchant: 'Y', total: 2, receipt_number: '849202' } }).reason).toBe('receipt_number');
  });
  test('same OCR text hash → hard', () => {
    expect(dedupeScore({ ocr_text_hash: 'h', ocr: {} }, { ocr_text_hash: 'h', ocr: {} }).reason).toBe('ocr_text');
  });
  test('near-identical perceptual hash → hard', () => {
    expect(dedupeScore({ perceptual_hash: 'ffffffffffffffff', ocr: {} },
                       { perceptual_hash: 'fffffffffffffffe', ocr: {} }).reason).toBe('image_perceptual');
  });
  test('merchant + time + total + card last4 → hard', () => {
    const a = { ocr: { merchant: 'Walmart', total: 43.91, date: '2026-06-15', time: '15:42', card_last4: '2210' } };
    const b = { ocr: { merchant: 'WALMART SUPERCENTER', total: 43.91, date: '2026-06-15', time: '15:42', card_last4: '2210' } };
    expect(dedupeScore(a, b).level).toBe('hard');
  });
});

describe('dedupeScore — possible / unique', () => {
  test('merchant + amount + date (no number/time/card) → possible', () => {
    const a = { ocr: { merchant: 'Walmart', total: 43.91, date: '2026-06-15' } };
    expect(dedupeScore(a, { ...a }).level).toBe('possible');
  });
  test('merchant + amount + similar items → possible', () => {
    const a = { ocr: { merchant: 'Cane\'s', total: 21.59, date: '2026-06-18', items: [{ desc: 'Caniac Combo' }, { desc: 'Lemonade' }] } };
    const b = { ocr: { merchant: 'Cane\'s', total: 21.59, date: '2026-06-20', items: [{ desc: 'Caniac Combo' }, { desc: 'Lemonade' }] } };
    expect(dedupeScore(a, b).level).toBe('possible');
  });
  test('different purchases → unique', () => {
    expect(dedupeScore({ ocr: { merchant: 'Walmart', total: 43.91, date: '2026-06-15' } },
                       { ocr: { merchant: 'Target', total: 10.0, date: '2026-06-10' } }).level).toBe('unique');
  });
});

describe('classifyDedupReply', () => {
  test('"same" / duplicate phrasing → same', async () => {
    expect((await classifyDedupReply('same')).decision).toBe('same');
    expect((await classifyDedupReply('yes same one')).decision).toBe('same');
  });
  test('"separate" alone → separate, no detail', async () => {
    const r = await classifyDedupReply('separate');
    expect(r).toEqual({ decision: 'separate', detail: null });
  });
  test('"separate" with proof → detail extracted (no Groq needed)', async () => {
    const r = await classifyDedupReply('separate, different receipt number 849202', { groqClassify: async () => null });
    expect(r.decision).toBe('separate');
    expect(r.detail).toMatch(/849202/);
  });
  test('unsure → unsure', async () => {
    expect((await classifyDedupReply('idk')).decision).toBe('unsure');
  });
  test('nuanced reply routes to the injected Groq classifier', async () => {
    const groqClassify = async () => ({ decision: 'separate', detail: 'paid at 4:12 PM' });
    const r = await classifyDedupReply('nah it was a little later', { groqClassify });
    expect(r).toEqual({ decision: 'separate', detail: 'paid at 4:12 PM' });
  });
});

describe('receipt-hash', () => {
  test('ocrTextHash is stable + item-order independent', () => {
    expect(ocrTextHash({ merchant: 'A', total: 5, date: '2026-01-01', items: [{ desc: 'x' }, { desc: 'y' }] }))
      .toBe(ocrTextHash({ merchant: 'a', total: 5, date: '2026-01-01', items: [{ desc: 'y' }, { desc: 'x' }] }));
  });
  test('hamming counts bit differences', () => {
    expect(hamming('ffffffffffffffff', 'fffffffffffffffe')).toBe(1);
    expect(hamming('0000000000000000', '0000000000000000')).toBe(0);
  });
  test('fileSha256 deterministic', () => {
    expect(fileSha256(Buffer.from('hello'))).toBe(fileSha256(Buffer.from('hello')));
  });
});
