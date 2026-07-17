'use strict';
// Insurance domain: the text parser (pure) + the recorder/matcher (mocked DB + io).

const { parseInsuranceStatement, grabCarrier, grabCoverageType } = require('../banking/insurance-parse');
const insurance = require('../banking/insurance');

// Typical single-column earthquake bill (GeoVera-style labels).
const EARTHQUAKE_BILL = `
GEOVERA INSURANCE COMPANY
Earthquake Premium Statement

Policy Number: GH-1234567-8
Statement Date: 06/20/2026
Payment Due Date: 08/01/2026
Total Amount Due $412.00
Policy Period: 08/01/2026 to 08/01/2027

Insured Location: 654 Alcita Ct
                  ORANGE COUNTY, CA 92868

Questions? Call customer service at (800) 555-0134
www.geovera.com
`;

// Two-column layout: values on the line below their label, columns side by side.
const TWO_COLUMN_BILL = [
  '                       FARMERS INSURANCE',
  '                       Homeowners Billing Statement',
  '',
  '   POLICY NUMBER                      AMOUNT DUE',
  '   92573-88-01                        $1,284.50',
  '',
  '   DUE DATE                           STATEMENT DATE',
  '   07/15/2026                         06/28/2026',
  '',
  '   Property Address',
  '   123 Haas Ave',
  '',
  '   Semi-Annual premium payment plan',
].join('\n');

describe('parseInsuranceStatement', () => {
  test('extracts core fields from a typical earthquake bill', () => {
    const p = parseInsuranceStatement(EARTHQUAKE_BILL);
    expect(p.carrier).toBe('GEOVERA');
    expect(p.coverageType).toBe('earthquake');
    expect(p.policyNumber).toBe('GH-1234567-8');
    expect(p.policyNumberMask).toBe('5678');
    expect(p.statementDate).toBe('2026-06-20');
    expect(p.dueDate).toBe('2026-08-01');
    expect(p.amountDue).toBe(412.00);
    expect(p.periodStart).toBe('2026-08-01');
    expect(p.periodEnd).toBe('2027-08-01');
    expect(p.billingFrequency).toBe('annual');           // inferred from the 12-month period
    expect(p.propertyAddress).toBe('654 Alcita Ct');
    expect(p.carrierPhone).toBe('(800) 555-0134');
    expect(p.carrierWebsite).toBe('www.geovera.com');
    expect(p.confidence).toBe(1);
    expect(p.parserStatus).toBe('parsed');
  });

  test('two-column layout resolves values by column alignment', () => {
    const p = parseInsuranceStatement(TWO_COLUMN_BILL);
    expect(p.carrier).toBe('FARMERS');
    expect(p.coverageType).toBe('homeowners');
    expect(p.policyNumber).toBe('92573-88-01');
    expect(p.policyNumberMask).toBe('8801');
    expect(p.dueDate).toBe('2026-07-15');
    expect(p.amountDue).toBe(1284.50);
    expect(p.propertyAddress).toBe('123 Haas Ave');
    expect(p.billingFrequency).toBe('semiannual');       // explicit wording beats inference
    expect(p.parserStatus).toBe('parsed');
  });

  test('empty text → failed, no throw', () => {
    const p = parseInsuranceStatement('');
    expect(p.parserStatus).toBe('failed');
    expect(p.confidence).toBe(0);
    expect(p.amountDue).toBeNull();
  });

  test('partial text grades confidence down', () => {
    const p = parseInsuranceStatement('Allstate Insurance Company\nSome body with no figures.');
    expect(p.carrier).toBe('Allstate');
    expect(p.amountDue).toBeNull();
    expect(p.confidence).toBeLessThan(0.6);
    expect(p.parserStatus).toBe('partial');
  });

  test('grabCarrier strips boilerplate lead-ins and prefers the shortest hit', () => {
    expect(grabCarrier('Thank you for choosing Mercury Insurance for your home.')).toBe('Mercury');
    expect(grabCarrier('Underwritten by Pacific Specialty')).toBe('Pacific Specialty');
    expect(grabCarrier('no carrier here')).toBeNull();
  });

  test('grabCoverageType: specific perils outrank generic homeowner wording', () => {
    expect(grabCoverageType('Homeowners policy with earthquake endorsement')).toBe('earthquake');
    expect(grabCoverageType("Homeowner's Declaration Page")).toBe('homeowners');
    expect(grabCoverageType('Personal umbrella liability policy')).toBe('umbrella');
    expect(grabCoverageType('nothing relevant')).toBeNull();
  });
});

describe('resolvePropertyId', () => {
  const io = {
    read: (f) => f === 'properties.json' ? [
      { id: 'p1', name: 'Alcita',  address: '654 Alcita Ct, Orange County, CA' },
      { id: 'p2', name: 'Haas',    address: '123 Haas Ave, LA, CA' },
    ] : null,
  };
  test('matches by house number + street token', () => {
    expect(insurance.resolvePropertyId(io, '654 ALCITA CT')).toBe('p1');
  });
  test('matches by property name appearing in the address', () => {
    expect(insurance.resolvePropertyId(io, 'The Haas rental')).toBe('p2');
  });
  test('no match → null, no throw', () => {
    expect(insurance.resolvePropertyId(io, '999 Nowhere Rd')).toBeNull();
    expect(insurance.resolvePropertyId(io, null)).toBeNull();
  });
});

describe('matchPremiumToBankTxn', () => {
  const io = {
    read: (f) => f === 'transactions.json' ? [
      { id: 't1', date: '2026-07-28', amount: -412.00, desc: 'GEOVERA INS PREM' },
      { id: 't2', date: '2026-07-28', amount: -50.00,  desc: 'Coffee' },
      { id: 't3', date: '2026-05-01', amount: -412.00, desc: 'GEOVERA INS PREM' },   // too far from due date
    ] : null,
  };
  test('matches by carrier name + amount + date (±10d window)', () => {
    expect(insurance.matchPremiumToBankTxn(io, { date: '2026-08-01', total: 412.00, carrier: 'GeoVera' })).toBe('t1');
  });
  test('no false match when nothing is close', () => {
    expect(insurance.matchPremiumToBankTxn(io, { date: '2026-08-01', total: 9999, carrier: 'GeoVera' })).toBeNull();
  });
});

describe('addFrequency', () => {
  test('advances by billing frequency, defaults to annual', () => {
    expect(insurance.addFrequency('2026-08-01', 'annual')).toBe('2027-08-01');
    expect(insurance.addFrequency('2026-08-01', 'semiannual')).toBe('2027-02-01');
    expect(insurance.addFrequency('2026-08-01', 'quarterly')).toBe('2026-11-01');
    expect(insurance.addFrequency('2026-08-01', 'monthly')).toBe('2026-09-01');
    expect(insurance.addFrequency('2026-08-01', null)).toBe('2027-08-01');
    expect(insurance.addFrequency(null, 'annual')).toBeNull();
  });
});

describe('recordInsuranceStatement', () => {
  const mkQuery = (calls, { prior = {}, unpaidRows = [] } = {}) => (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT premium_amount, billing_frequency, policy_number_mask, coverage_type FROM insurance_policies/.test(sql))
      return Promise.resolve({ rows: [prior] });
    if (/SELECT 1 FROM documents/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM insurance_payments pay/.test(sql)) return Promise.resolve({ rows: unpaidRows });
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  test('upserts statement+payment, raises change/unmatched alerts, rolls next_due_date', async () => {
    const calls = [];
    const query = mkQuery(calls, { prior: { premium_amount: 380, billing_frequency: 'annual', policy_number_mask: '5678', coverage_type: 'earthquake' } });
    const written = {};
    const io = { read: (f) => (f === 'transactions.json' ? [] : written[f] || null), write: (f, v) => { written[f] = v; } };
    const parsed = parseInsuranceStatement(EARTHQUAKE_BILL);

    const res = await insurance.recordInsuranceStatement(query, io, 'u1', {
      policyId: 'ins_u1_geovera_5678', documentId: null, parsed, carrier: 'GeoVera',
    });

    expect(res.insuranceStatementId).toBe('istmt_ins_u1_geovera_5678_202608');   // keyed by due date month
    expect(res.matchedTxnId).toBeNull();                                          // nothing to match against
    const kinds = res.alerts.map(a => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['premium_changed', 'payment_unmatched']));
    const unmatched = res.alerts.find(a => a.kind === 'payment_unmatched');
    expect(unmatched.message).toContain('Aug 2026 bill');
    expect(unmatched.message).toContain('••••5678');
    expect(written['insurance_alerts.json'].length).toBe(2);
    expect(calls.some(c => /INSERT INTO insurance_statements/.test(c.sql))).toBe(true);
    expect(calls.some(c => /INSERT INTO insurance_payments/.test(c.sql))).toBe(true);
    // Unpaid → next_due_date is the bill's due date, not advanced.
    const upd = calls.find(c => /UPDATE insurance_policies SET/.test(c.sql));
    expect(upd.params[2]).toBe('2026-08-01');
  });

  test('already-paid bill advances next_due_date by a cycle and emits premium_paid', async () => {
    const calls = [];
    const query = mkQuery(calls, { prior: { premium_amount: 412, billing_frequency: 'annual', policy_number_mask: '5678', coverage_type: 'earthquake' } });
    const written = {};
    const io = {
      read: (f) => f === 'transactions.json'
        ? [{ id: 't1', date: '2026-07-28', amount: -412.00, desc: 'GEOVERA INS PREM' }]
        : (written[f] || null),
      write: (f, v) => { written[f] = v; },
    };
    const res = await insurance.recordInsuranceStatement(query, io, 'u1', {
      policyId: 'ins_u1_geovera_5678', documentId: null,
      parsed: parseInsuranceStatement(EARTHQUAKE_BILL), carrier: 'GeoVera',
    });
    expect(res.matchedTxnId).toBe('t1');
    expect(res.alerts.map(a => a.kind)).toContain('premium_paid');
    const upd = calls.find(c => /UPDATE insurance_policies SET/.test(c.sql));
    expect(upd.params[2]).toBe('2027-08-01');   // advanced one annual cycle
  });
});

describe('alert dedup on re-record', () => {
  test('replaying the same bill does not stack duplicate alerts; premium_paid clears unmatched', async () => {
    const query = (sql) => {
      if (/SELECT premium_amount, billing_frequency, policy_number_mask, coverage_type FROM insurance_policies/.test(sql))
        return Promise.resolve({ rows: [{ premium_amount: 412, billing_frequency: 'annual', policy_number_mask: '5678', coverage_type: 'earthquake' }] });
      if (/SELECT 1 FROM documents/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const written = {};
    let txns = [];
    const io = { read: (f) => f === 'transactions.json' ? txns : (written[f] || null), write: (f, v) => { written[f] = v; } };
    const args = { policyId: 'ins_u1_geovera_5678', documentId: null, parsed: parseInsuranceStatement(EARTHQUAKE_BILL), carrier: 'GeoVera' };

    await insurance.recordInsuranceStatement(query, io, 'u1', args);   // upload
    await insurance.recordInsuranceStatement(query, io, 'u1', args);   // repair replay
    await insurance.recordInsuranceStatement(query, io, 'u1', args);   // another replay
    const unmatched = written['insurance_alerts.json'].filter(a => a.kind === 'payment_unmatched');
    expect(unmatched).toHaveLength(1);                                 // replaced, not stacked

    txns = [{ id: 't1', date: '2026-07-28', amount: -412.00, desc: 'GEOVERA INS PREM' }];
    await insurance.recordInsuranceStatement(query, io, 'u1', args);   // now it matches → paid
    const after = written['insurance_alerts.json'];
    expect(after.some(a => a.kind === 'premium_paid')).toBe(true);
    expect(after.some(a => a.kind === 'payment_unmatched')).toBe(false);   // stale noise cleared
  });
});

describe('matchPendingPremiums', () => {
  test('retro-matches an unpaid premium, advances the policy cycle', async () => {
    const calls = [];
    const query = (sql, params) => {
      calls.push({ sql, params });
      if (/FROM insurance_payments pay/.test(sql)) return Promise.resolve({ rows: [{
        payment_id: 'ipay_x', amount: '412.00', due_date: '2026-08-01', statement_date: '2026-06-20',
        policy_id: 'pol1', carrier: 'GeoVera', billing_frequency: 'annual', next_due_date: '2026-08-01',
      }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const written = {};
    const io = {
      read: (f) => f === 'transactions.json'
        ? [{ id: 't9', date: '2026-08-02', amount: -412.00, desc: 'GEOVERA INSURANCE' }]
        : (written[f] || null),
      write: (f, v) => { written[f] = v; },
    };
    const n = await insurance.matchPendingPremiums(query, io, 'u1');
    expect(n).toBe(1);
    expect(calls.some(c => /UPDATE insurance_payments SET matched_transaction_id/.test(c.sql) && c.params[1] === 't9')).toBe(true);
    const adv = calls.find(c => /UPDATE insurance_policies SET next_due_date/.test(c.sql));
    expect(adv.params[1]).toBe('2027-08-01');
    expect(written['insurance_alerts.json'][0].kind).toBe('premium_paid');
  });
});
