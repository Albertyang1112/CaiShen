'use strict';
/**
 * dateProbe.test.js — content-based statement date detection + property address
 * extraction (server/core/pdf-parser.js). Covers the mortgage-statement flow:
 * explicit range strings ("Payment history (04/03/2026 - 05/11/2026)"), word
 * months (Jan/January), date clustering with due-date outlier exclusion, and
 * "Property Address" detection.
 */

const {
  extractPeriod, extractDateRange, collectDates, clusterDates, periodFromRange,
  inferYearFromText, findPropertyAddress, extractPropertyAddress, looksLikeStreet,
  assemblePages,
} = require('../core/pdf-parser');

// ── Explicit range strings ────────────────────────────────────────────────────

describe('extractDateRange', () => {
  it('reads the parenthesised numeric range from a payment-history header', () => {
    const r = extractDateRange('Payment history (04/03/2026 - 05/11/2026)');
    expect(r).toEqual({
      start: { year: 2026, month: 4, day: 3 },
      end:   { year: 2026, month: 5, day: 11 },
    });
  });

  it('reads abbreviated word-month ranges', () => {
    const r = extractDateRange('Statement period: Apr 16, 2026 through May 15, 2026');
    expect(r.start).toEqual({ year: 2026, month: 4, day: 16 });
    expect(r.end).toEqual({ year: 2026, month: 5, day: 15 });
  });

  it('reads full word-month ranges', () => {
    const r = extractDateRange('Activity from January 1, 2026 to January 31, 2026');
    expect(r.start).toEqual({ year: 2026, month: 1, day: 1 });
    expect(r.end).toEqual({ year: 2026, month: 1, day: 31 });
  });

  it('handles a shared trailing year and rolls the start year back across Dec → Jan', () => {
    const r = extractDateRange('Billing cycle Dec 16 - Jan 15, 2027');
    expect(r.start).toEqual({ year: 2026, month: 12, day: 16 });
    expect(r.end).toEqual({ year: 2027, month: 1, day: 15 });
  });

  it('handles numeric dates with a shared trailing year', () => {
    const r = extractDateRange('Service period 04/16 to 05/15/2026');
    expect(r.start).toEqual({ year: 2026, month: 4, day: 16 });
    expect(r.end).toEqual({ year: 2026, month: 5, day: 15 });
  });

  it('rejects implausibly long ranges (annual disclosures)', () => {
    expect(extractDateRange('rates apply from 01/01/2026 - 12/31/2026 per terms')).toBeNull();
  });

  it('prefers a labeled statement range over an earlier unlabeled one', () => {
    const text = 'posted 03/02/2026 - 03/05/2026 ok. Statement period 04/01/2026 to 04/30/2026';
    const r = extractDateRange(text);
    expect(r.end).toEqual({ year: 2026, month: 4, day: 30 });
  });

  it('rejects impossible calendar dates', () => {
    expect(extractDateRange('period 04/31/2026 - 05/15/2026')).toBeNull();
  });
});

// ── Period naming rule ────────────────────────────────────────────────────────

describe('periodFromRange', () => {
  it('names a mid-month close (>=15th) after the closing month', () => {
    expect(periodFromRange({ start: { year: 2026, month: 4, day: 16 }, end: { year: 2026, month: 5, day: 15 } }))
      .toEqual({ year: 2026, month: 5 });
  });
  it('names an early close (<15th) after the opening month', () => {
    expect(periodFromRange({ start: { year: 2026, month: 4, day: 3 }, end: { year: 2026, month: 5, day: 11 } }))
      .toEqual({ year: 2026, month: 4 });
  });
});

// ── Date collection + clustering ──────────────────────────────────────────────

describe('collectDates / clusterDates', () => {
  const HISTORY = `
    Payment history
    04/03/2026 payment received 1,712.00
    04/15/2026 escrow disbursement 312.55
    04/28/2026 county tax paid 850.00
    05/02/2026 payment received 1,712.00
    05/11/2026 statement generated
    Payment due date: 06/01/2026
    If payment received after 06/16/2026 a fee applies
  `;

  it('collects every date and flags due-context dates', () => {
    const dates = collectDates(HISTORY);
    expect(dates).toHaveLength(7);
    expect(dates.filter(d => d.due).map(d => `${d.month}/${d.day}`).sort()).toEqual(['6/1', '6/16']);
  });

  it('clusters the concentrated range and drops due-date outliers', () => {
    const c = clusterDates(collectDates(HISTORY));
    expect(c.start).toEqual({ year: 2026, month: 4, day: 3 });
    expect(c.end).toEqual({ year: 2026, month: 5, day: 11 });
  });

  it('reads word-month rows (abbreviated and full)', () => {
    const t = 'Apr 3, 2026 payment · April 15, 2026 escrow · May 2, 2026 payment · May 11, 2026 close';
    const c = clusterDates(collectDates(t));
    expect(periodFromRange(c)).toEqual({ year: 2026, month: 4 });
  });

  it('dates no-year rows from the dominant year on the page', () => {
    const t = 'Statement 2026. 04/03 payment · 04/15 escrow · 05/02 payment · 05/11 generated';
    const dates = collectDates(t, inferYearFromText(t));
    const c = clusterDates(dates);
    expect(c.start).toEqual({ year: 2026, month: 4, day: 3 });
    expect(c.end).toEqual({ year: 2026, month: 5, day: 11 });
  });

  it('returns null when there is no concentration', () => {
    expect(clusterDates(collectDates('01/05/2024 then 07/22/2025 then 11/30/2026'))).toBeNull();
  });
});

// ── End-to-end period extraction ──────────────────────────────────────────────

describe('extractPeriod', () => {
  it('uses the screenshot-style payment-history range', () => {
    expect(extractPeriod('Payment history (04/03/2026 - 05/11/2026)'))
      .toEqual({ year: 2026, month: 4 });
  });

  it('falls back to clustering when no explicit range exists', () => {
    const t = `
      Mortgage statement
      04/03/2026 payment received
      04/15/2026 escrow disbursement
      05/02/2026 payment received
      05/11/2026 statement generated
      Payment due date: 06/01/2026
    `;
    expect(extractPeriod(t)).toEqual({ year: 2026, month: 4 });
  });

  it('still resolves a lone "Month YYYY" mention (abbreviations included)', () => {
    expect(extractPeriod('Statement for Mar 2026')).toEqual({ year: 2026, month: 3 });
    expect(extractPeriod('Statement for March 2026')).toEqual({ year: 2026, month: 3 });
  });
});

// ── Property address detection ────────────────────────────────────────────────

describe('findPropertyAddress', () => {
  it('prefers the labeled property address over the mailing block', () => {
    const page = 'ALBERT YANG 999 Home Ct Los Angeles CA 90001 ... Property Address: 4501 Haas Ave Los Angeles CA';
    const a = findPropertyAddress([page]);
    expect(a.address).toBe('4501 Haas Ave');
    expect(a.streetName).toBe('Haas Ave');
  });

  it('normalizes ALL-CAPS addresses and multi-word street names', () => {
    const a = findPropertyAddress(['Subject Property: 789 BAY HILL DR SAN FRANCISCO CA']);
    expect(a.address).toBe('789 Bay Hill Dr');
    expect(a.streetName).toBe('Bay Hill Dr');
  });

  it('prefers the address repeated on multiple pages over a one-off servicer line', () => {
    const p1 = 'Mr Cooper 8950 Cypress Waters Blvd Coppell TX 75019 customer service ... 4501 Haas Ave Los Angeles CA 90001';
    const p2 = 'page 2 · 4501 Haas Ave Los Angeles CA 90001 · activity continued';
    const a = findPropertyAddress([p1, p2]);
    expect(a.address).toBe('4501 Haas Ave');
  });

  it('rejects remittance addresses even with full city/state/zip', () => {
    const p = 'Send payment to 8950 Cypress Waters Blvd Coppell TX 75019 ... property at 4501 Haas Ave Los Angeles CA 90001';
    const a = findPropertyAddress([p]);
    expect(a.address).toBe('4501 Haas Ave');
  });

  // The real-world bug: pdf2json split "Statement" into "St"+"atement" and the old
  // detector matched "<number> Mortgage Loan St" as an address.
  it('rejects document-title junk like "9175 Mortgage Loan St"', () => {
    expect(findPropertyAddress([
      'Loan Number 1234567890 9175 Mortgage Loan St atement Date 01/15/2026 Total Amount Due $1,712.00',
    ])).toBeNull();
  });

  it('rejects a ZIP code masquerading as a house number ("OH 44181 Ostal Road")', () => {
    expect(findPropertyAddress([
      'Payment Processing Center Cleveland OH 44181 Ostal Road Suite 100',
    ])).toBeNull();
  });

  it('rejects street names containing stray single-letter fragments ("K Obe")', () => {
    expect(findPropertyAddress([
      'records for 8962 K Obe Pl Los Angeles CA 90001 follow',
    ])).toBeNull();
  });

  it('rejects an address-shaped match with no corroborating signals', () => {
    expect(findPropertyAddress([
      'this document relates to the loan secured by 4501 Haas Ave per the agreement terms stated herein',
    ])).toBeNull();
  });

  it('returns null when no address is present', () => {
    expect(findPropertyAddress(['no addresses here, just totals 1,234.56'])).toBeNull();
  });

  it('extractPropertyAddress assembles pages from positioned items', () => {
    const items = [
      { text: 'Property Address:', x: 2, y: 4, page: 0 },
      { text: '654 Alcita Ct',     x: 8, y: 4, page: 0 },
      { text: 'Orange County CA',  x: 2, y: 5, page: 0 },
    ];
    expect(extractPropertyAddress(items).address).toBe('654 Alcita Ct');
  });

  it('glues split-word fragments back together using glyph positions', () => {
    // "Kobe" arrives from pdf2json as "…K" + "obe…" with zero gap between them.
    const items = [
      { text: 'Property Address:',    x: 2,   y: 4, w: 3,   page: 0 },
      { text: '8962 K',               x: 6,   y: 4, w: 1.2, page: 0 },
      { text: 'obe Pl',               x: 7.2, y: 4, w: 1.2, page: 0 },
      { text: 'Los Angeles CA 90001', x: 2,   y: 5, w: 5,   page: 0 },
    ];
    const a = extractPropertyAddress(items);
    expect(a.address).toBe('8962 Kobe Pl');
    expect(a.streetName).toBe('Kobe Pl');
  });
});

describe('assemblePages column handling', () => {
  it('does not glue across column boundaries even when widths over-report', () => {
    // Real Mr. Cooper layout: the address column touches the notice column, and
    // city/state/zip touches the late-fee text. Gluing here hid the real address.
    const items = [
      { text: '8962 KOBE PL',              x: 2, y: 4, w: 3,   page: 0 },
      { text: 'If payment is received on', x: 5, y: 4, w: 4,   page: 0 }, // zero gap, UPPER→Upper
      { text: 'SAN DIEGO, CA 92123',       x: 2, y: 5, w: 4,   page: 0 },
      { text: 'or after 01/17/2026, a',    x: 6, y: 5, w: 3,   page: 0 }, // zero gap, digit→lower
    ];
    const page = assemblePages(items)[0];
    expect(page).toContain('8962 KOBE PL If payment');
    expect(page).toContain('CA 92123 or after');
    // …and the address still detects, with the state+zip on the next line corroborating
    const a = findPropertyAddress([page]);
    expect(a.address).toBe('8962 Kobe Pl');
  });

  it('still glues genuine word fragments', () => {
    const items = [
      { text: 'Woodw', x: 2,   y: 4, w: 1.5, page: 0 },
      { text: 'ard',   x: 3.5, y: 4, w: 0.8, page: 0 },  // zero gap, lower→lower
    ];
    expect(assemblePages(items)[0]).toContain('Woodward');
  });
});

describe('looksLikeStreet', () => {
  it('accepts believable street addresses', () => {
    expect(looksLikeStreet('8962 Kobe Pl')).toBe(true);
    expect(looksLikeStreet('4501 Haas Ave')).toBe(true);
    expect(looksLikeStreet('123 N Main St')).toBe(true);
  });
  it('rejects document-vocabulary and fragment junk', () => {
    expect(looksLikeStreet('9175 Mortgage Loan Statement St')).toBe(false);
    expect(looksLikeStreet('8962 K Obe Pl')).toBe(false);
    expect(looksLikeStreet('TOTAL CHECKING')).toBe(false);
    expect(looksLikeStreet(null)).toBe(false);
  });
});
