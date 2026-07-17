'use strict';
// Chatbot document dispatcher: routing by gate doc type, check matching, replies.

const docIngest = require('../banking/doc-ingest');
const { findCheckMatch, ingestAttachment, ingestCheck, formatDocReply } = docIngest;

describe('findCheckMatch', () => {
  const txns = [
    { id: 't1', date: '2026-07-05', amount: -412.00, desc: 'CHECK # 1234', checkNumber: '1234' },
    { id: 't2', date: '2026-07-05', amount: -412.00, desc: 'CHECK # 9999', checkNumber: '9999' },
    { id: 't3', date: '2026-07-20', amount: -412.00, desc: 'GEOVERA INSURANCE' },
  ];
  test('check number beats everything else', () => {
    const m = findCheckMatch({ check_amount: 412, check_date: '2026-07-01', check_number: '1234', payee: 'GeoVera' }, txns);
    expect(m.id).toBe('t1');
  });
  test('leading zeros on check numbers are ignored', () => {
    const m = findCheckMatch({ check_amount: 412, check_date: '2026-07-01', check_number: '01234' }, txns);
    expect(m.id).toBe('t1');
  });
  test('payee tokens break ties when no check number', () => {
    const m = findCheckMatch({ check_amount: 412, check_date: '2026-07-15', payee: 'GeoVera Insurance' }, txns);
    expect(m.id).toBe('t3');
  });
  test('date window: a txn >14 days after the check date is out', () => {
    const m = findCheckMatch({ check_amount: 412, check_date: '2026-06-01', check_number: '1234' }, txns);
    expect(m).toBeNull();
  });
  test('amount mismatch → null', () => {
    expect(findCheckMatch({ check_amount: 999, check_date: '2026-07-01' }, txns)).toBeNull();
    expect(findCheckMatch({}, txns)).toBeNull();
  });
});

describe('ingestAttachment routing', () => {
  const io = { read: () => [], write: () => {} };
  const att = { buffer: Buffer.from('x'), mimeType: 'image/jpeg', originalName: 'photo.jpg' };

  test('accepted receipt → result passes through untouched', async () => {
    const receiptRes = { level: 'unique', id: 'r1', ocr: {}, matched: null };
    const res = await ingestAttachment(null, io, 'u1', att, { ingestReceipt: async () => receiptRes });
    expect(res).toBe(receiptRes);
  });

  test('rejected as check → routed to the check flow', async () => {
    const calls = [];
    const res = await ingestAttachment(null, io, 'u1', att, {
      ingestReceipt: async () => ({ rejected: true, reason: 'not_receipt', docType: 'check', ocr: { check_number: '55' } }),
      ingestCheck: async (q, i, u, args) => { calls.push(args); return { kind: 'check', id: 'c1', ocr: args.ocr, matched: null }; },
    });
    expect(res.kind).toBe('check');
    expect(calls[0].ocr.check_number).toBe('55');
  });

  test('rejected as insurance_statement → routed to the vault filer', async () => {
    const res = await ingestAttachment(null, io, 'u1', att, {
      ingestReceipt: async () => ({ rejected: true, reason: 'not_receipt', docType: 'insurance_statement', ocr: {} }),
      fileToVault: async (q, i, u, args) => ({ kind: 'filed', docType: args.gateDocType, folder: 'Insurance/Alcita/2026', filename: 'x.pdf' }),
    });
    expect(res.kind).toBe('filed');
    expect(res.docType).toBe('insurance_statement');
  });

  test('rejected as other → original rejection returned', async () => {
    const rej = { rejected: true, reason: 'not_receipt', docType: 'other', ocr: {} };
    const res = await ingestAttachment(null, io, 'u1', att, { ingestReceipt: async () => rej });
    expect(res).toBe(rej);
  });
});

describe('ingestCheck', () => {
  test('stores a receipts row with doc_kind=check and links role check', async () => {
    const calls = [];
    const query = (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, payee, total_amount FROM receipts/.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT 1 FROM accounts/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const txns = [{ id: 't1', date: '2026-07-05', amount: -412.00, desc: 'CHECK # 1234', checkNumber: '1234' }];
    const written = {};
    const io = {
      dir: require('os').tmpdir(),
      read: (f) => f === 'transactions.json' ? txns : (written[f] || []),
      write: (f, v) => { written[f] = v; },
    };
    const res = await ingestCheck(query, io, 'u1', {
      buffer: Buffer.from('checkbytes'), mimeType: 'image/jpeg', originalName: 'check.jpg',
      ocr: { payee: 'GeoVera', check_number: '1234', check_amount: 412, check_date: '2026-07-01' },
    });
    expect(res.kind).toBe('check');
    expect(res.matched.id).toBe('t1');
    const ins = calls.find(c => /INSERT INTO receipts/.test(c.sql));
    expect(ins.sql).toContain("'check'");
    // Evidence link went through matching.js with role 'check'.
    const link = calls.find(c => /INSERT INTO matched_transaction_sources/.test(c.sql));
    expect(link.params).toContain('check');
    // The matched txn now carries the receipt id.
    expect(written['transactions.json'][0].receiptId).toBe(res.id);
  });

  test('same file bytes twice → duplicate, no second row', async () => {
    const query = (sql) => /SELECT id, payee, total_amount FROM receipts/.test(sql)
      ? Promise.resolve({ rows: [{ id: 'r0', payee: 'GeoVera' }] })
      : Promise.resolve({ rows: [] });
    const res = await ingestCheck(query, { read: () => [], write: () => {} }, 'u1', {
      buffer: Buffer.from('checkbytes'), mimeType: 'image/jpeg', originalName: 'check.jpg',
      ocr: { check_amount: 412 },
    });
    expect(res.duplicate).toBe(true);
  });
});

describe('formatDocReply', () => {
  test('matched check reply names the txn and the paid insurance bill', () => {
    const msg = formatDocReply({ kind: 'check', id: 'c1', matched: { id: 't1', desc: 'CHECK # 1234', date: '2026-07-05' },
      ocr: { check_number: '1234', payee: 'GeoVera', check_amount: 412, check_date: '2026-07-01' }, paidInsurance: 1 });
    expect(msg).toContain('#1234');
    expect(msg).toContain('GeoVera');
    expect(msg).toContain('Matched to: CHECK # 1234');
    expect(msg).toContain('pays your insurance bill');
  });
  test('filed insurance reply includes folder + due date + reminder promise', () => {
    const msg = formatDocReply({ kind: 'filed', docType: 'insurance_statement', folder: 'Insurance/Alcita/2026', filename: 'x.pdf',
      recorded: { recorded: true, matchedTxnId: null, parsed: { carrier: 'GeoVera', coverageType: 'earthquake', amountDue: 412, dueDate: '2026-08-01' } } });
    expect(msg).toContain('Insurance/Alcita/2026');
    expect(msg).toContain('$412.00');
    expect(msg).toContain('due 2026-08-01');
    expect(msg).toContain("remind you");
  });
  test('receipt results return null (bot falls back to formatReceiptReply)', () => {
    expect(formatDocReply({ level: 'unique' })).toBeNull();
  });
});
