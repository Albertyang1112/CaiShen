'use strict';
// Pure parsing/normalization tests for banking/receipt-ocr.js (no network).
const { parseOcrJson, normalizeOcr } = require('../banking/receipt-ocr');

describe('receipt OCR parsing', () => {
  test('parseOcrJson handles fenced, bare, and embedded JSON', () => {
    expect(parseOcrJson('```json\n{"total": 5}\n```')).toEqual({ total: 5 });
    expect(parseOcrJson('here you go: {"total": 9} thanks')).toEqual({ total: 9 });
    expect(parseOcrJson('not json at all')).toEqual({});
  });

  test('normalizeOcr coerces money strings, supports name/desc, keeps the gate fields', () => {
    expect(normalizeOcr({ is_receipt: true, doc_type: 'receipt', merchant: 'Walmart', total: '$14.99', date: '2026-06-15', items: [{ name: 'Milk', amount: '3.50' }] }))
      .toEqual({ is_receipt: true, doc_type: 'receipt', merchant: 'Walmart', total: 14.99, date: '2026-06-15', items: [{ desc: 'Milk', amount: 3.5 }] });
  });

  test('normalizeOcr defaults missing fields (is_receipt null when unclassified)', () => {
    expect(normalizeOcr({})).toEqual({ is_receipt: null, doc_type: null, merchant: null, total: null, date: null, items: [] });
    expect(normalizeOcr({ is_receipt: false, doc_type: 'other', total: 'N/A' }))
      .toEqual({ is_receipt: false, doc_type: 'other', merchant: null, total: null, date: null, items: [] });
  });
});
