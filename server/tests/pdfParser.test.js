'use strict';

/**
 * pdfParser.test.js — tests for pdf-parser.js that don't depend on a generated PDF.
 *
 * CaiShen no longer generates statement PDFs (statements are upload-only), so the old
 * fixture that built a pdfkit statement to feed the parser is gone. pdf2json also can't
 * parse pdfkit output (the "Invalid XRef stream header" incompatibility), so those
 * parse-the-generated-PDF assertions were skipped in CI anyway. Real downloaded
 * statements parse fine in production, and the parser's pure functions are covered
 * here and in dateProbe.test.js. What remains: parser error-handling + account typing.
 */

const { parsePDFTransactions, guessAccountTypeSubtype } = require('../core/pdf-parser');

// ─────────────────────────────────────────────────────────────────────────────

describe('parsePDFTransactions — error handling', () => {
  it('returns [] or throws for a non-PDF buffer (does not hang)', async () => {
    const garbage = Buffer.from('this is definitely not a pdf at all');
    let threw = false, result = null;
    try { result = await parsePDFTransactions(garbage); } catch { threw = true; }
    expect(threw || Array.isArray(result)).toBe(true);
  }, 10_000);

  it('handles an empty buffer gracefully (does not hang)', async () => {
    const empty = Buffer.alloc(0);
    let threw = false, result = null;
    try { result = await parsePDFTransactions(empty); } catch { threw = true; }
    expect(threw || Array.isArray(result)).toBe(true);
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('guessAccountTypeSubtype', () => {
  it('classifies a checking account correctly', () => {
    const r = guessAccountTypeSubtype('Chase', 'TOTAL CHECKING');
    expect(r.type).toBe('depository');
    expect(r.subtype).toBe('checking');
  });

  it('classifies a savings account correctly', () => {
    const r = guessAccountTypeSubtype('Ally Bank', 'HIGH YIELD SAVINGS');
    expect(r.type).toBe('depository');
    expect(r.subtype).toBe('savings');
  });

  it('classifies a Roth IRA correctly', () => {
    const r = guessAccountTypeSubtype('Fidelity', 'ROTH IRA');
    expect(r.type).toBe('investment');
    expect(r.subtype).toBe('roth');
  });

  it('classifies a 401k correctly', () => {
    const r = guessAccountTypeSubtype('Fidelity', '401(K)');
    expect(r.type).toBe('investment');
    expect(r.subtype).toBe('401k');
  });

  it('classifies a brokerage account correctly', () => {
    const r = guessAccountTypeSubtype('Fidelity', 'INDIVIDUAL BROKERAGE');
    expect(r.type).toBe('investment');
    expect(r.subtype).toBe('brokerage');
  });

  it('classifies a credit card correctly', () => {
    const r = guessAccountTypeSubtype('American Express', 'CREDIT CARD');
    expect(r.type).toBe('credit');
    expect(r.subtype).toBe('credit card');
  });

  it('classifies a money market account correctly', () => {
    const r = guessAccountTypeSubtype('Chase', 'MONEY MARKET');
    expect(r.type).toBe('depository');
    expect(r.subtype).toBe('money market');
  });

  it('classifies a mortgage correctly', () => {
    const r = guessAccountTypeSubtype('Wells Fargo', 'MORTGAGE');
    expect(r.type).toBe('loan');
    expect(r.subtype).toBe('mortgage');
  });

  it('classifies a brokerage by institution name (Fidelity)', () => {
    const r = guessAccountTypeSubtype('Fidelity', 'unknown account type');
    expect(r.type).toBe('investment');
    expect(r.subtype).toBe('brokerage');
  });

  it('classifies crypto exchange correctly', () => {
    const r = guessAccountTypeSubtype('Coinbase', 'account');
    expect(r.type).toBe('investment');
    expect(r.subtype).toBe('crypto exchange');
  });

  it('defaults to checking for unknown accounts', () => {
    const r = guessAccountTypeSubtype('Unknown Bank', 'Unknown Account');
    expect(r.type).toBe('depository');
    expect(r.subtype).toBe('checking');
  });

  it('handles null/undefined inputs gracefully', () => {
    expect(() => guessAccountTypeSubtype(null, null)).not.toThrow();
    expect(() => guessAccountTypeSubtype(undefined, undefined)).not.toThrow();
  });
});
