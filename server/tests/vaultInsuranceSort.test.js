'use strict';
// Vault classification of insurance / disclosure documents: the pure reconcile() filing
// branches + the parser-sort insurance guard (the "escrow trap" — a homeowner bill that
// mentions escrow must NOT be deterministically filed as a mortgage).

const { reconcile, indexFolders, matchUserProperty } = require('../vault/ai-sort');
const { looksInsurance, hasStrongMortgage } = require('../vault/parser-sort');

const PROPS = [
  { id: 'p1', name: 'Alcita', address: '654 Alcita Ct, Orange County, CA' },
  { id: 'p2', name: 'Haas',   address: '123 Haas Ave, LA, CA' },
];

describe('reconcile — insurance_statement filing', () => {
  test('files under the matched user property name, filename carrier+coverage+month', () => {
    const idx = indexFolders([], PROPS);
    const d = reconcile({
      docType: 'insurance_statement', institution: 'GeoVera', propertyAddress: '654 ALCITA CT',
      coverageType: 'earthquake', policyNumber: 'GH-1234567-8', dueDate: '2026-08-01', amountDue: 412,
      year: 2026, month: 8,
    }, idx, 'upload.pdf');
    expect(d.docType).toBe('insurance_statement');
    expect(d.folder).toBe('Insurance/Alcita/2026');
    expect(d.filename).toBe('GeoVera Earthquake 5678 Aug 2026.pdf');   // policy last4 prevents collisions
    expect(d.propertyAddress).toBe('Alcita');            // snapped to the property name
    expect(d.dueDate).toBe('2026-08-01');
    expect(d.amountDue).toBe(412);
    expect(d.policyNumber).toBe('GH-1234567-8');
  });

  test('missing year/month derive from the due date; folder keeps its slashes', () => {
    // The CEA-photo regression: vision returned no year → the old fallback filed to a
    // slash-stripped junk folder ("InsuranceCEA2026").
    const d = reconcile({
      docType: 'insurance_statement', institution: 'CEA', coverageType: 'earthquake',
      policyNumber: 'D636987491', dueDate: '2026-07-18', amountDue: 751,
      folder: 'Insurance/CEA/2026', filename: 'CEA earthquake.pdf',
    }, indexFolders([], []), 'photo.pdf');
    expect(d.folder).toBe('Insurance/CEA/2026');          // derived from dueDate
    expect(d.year).toBe(2026);
    expect(d.month).toBe(7);
    expect(d.filename).toBe('CEA Earthquake 7491 Jul 2026.pdf');
  });

  test('no year anywhere → files under the carrier without a year folder, never junk', () => {
    const d = reconcile({
      docType: 'insurance_statement', institution: 'CEA', coverageType: 'earthquake',
      folder: 'Insurance/CEA/2026', filename: 'x.pdf',
    }, indexFolders([], []), 'photo.pdf');
    expect(d.folder).toBe('Insurance/CEA');
    expect(d.folder).toContain('/');                      // sanitizePath preserved the slash
  });

  test('no property match → files under the carrier; reuses an existing Insurance folder', () => {
    const idx = indexFolders([{ path: 'Insurance/Mercury/2025' }], []);
    const d = reconcile({
      docType: 'insurance_statement', institution: 'MERCURY', coverageType: 'auto',
      year: 2026, month: 3,
    }, idx, 'upload.pdf');
    expect(d.folder).toBe('Insurance/Mercury/2026');     // "MERCURY" snapped to existing "Mercury"
    expect(d.filename).toBe('MERCURY Auto Mar 2026.pdf');   // no policy number → no last4 segment
  });

  test('disclosure files under Disclosures/{institution}/{year}', () => {
    const d = reconcile({ docType: 'disclosure', institution: 'Chase', year: 2026, month: 5 },
      indexFolders([], []), 'notice.pdf');
    expect(d.folder).toBe('Disclosures/Chase/2026');
    expect(d.filename).toBe('Chase Disclosure May 2026.pdf');
  });

  test('disclosure without a year still files under the issuer', () => {
    const d = reconcile({ docType: 'disclosure', institution: 'Schwab' }, indexFolders([], []), 'privacy.pdf');
    expect(d.folder).toBe('Disclosures/Schwab');
  });
});

describe('matchUserProperty', () => {
  test('matches by house number + street token, returns the display name', () => {
    expect(matchUserProperty('654 Alcita Ct', PROPS)).toBe('Alcita');
    expect(matchUserProperty('The Haas property', PROPS)).toBe('Haas');
    expect(matchUserProperty('999 Nowhere Rd', PROPS)).toBeNull();
    expect(matchUserProperty(null, PROPS)).toBeNull();
  });
});

describe('parser-sort insurance guard (escrow trap)', () => {
  const HOMEOWNER_BILL = `
    FARMERS INSURANCE
    Homeowners Premium Statement
    Policy Number: 92573-88-01
    Total Premium Due $1,284.50
    Coverage Period: 07/15/2026 to 07/15/2027
    Your bill may be sent to your mortgage escrow account.
  `;
  const MORTGAGE_STMT = `
    ROCKET MORTGAGE  Mortgage Statement
    Outstanding Principal Balance $312,500.00
    Escrow Balance $4,200.50
  `;
  test('a homeowner bill mentioning escrow looks like insurance, not mortgage', () => {
    expect(hasStrongMortgage(HOMEOWNER_BILL)).toBe(true);   // the trap: escrow keyword hits
    expect(looksInsurance(HOMEOWNER_BILL)).toBe(true);      // …but the guard catches it first
  });
  test('a real mortgage statement is NOT deferred (principal balance present)', () => {
    expect(looksInsurance(MORTGAGE_STMT)).toBe(false);
  });
});
