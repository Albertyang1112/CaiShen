'use strict';
const rm = require('../banking/receipt-match');
const core = require('../banking/categorizer-core');

function makeDb({ receipts = {} } = {}) {
  async function query(sql, params = []) {
    const S = String(sql).replace(/\s+/g, ' ').trim();
    if (S.includes('FROM receipts WHERE id=')) { const r = receipts[params[0]]; return { rows: r ? [r] : [] }; }
    if (S.includes('FROM receipts WHERE user_id=$1 AND txn_id IS NULL')) return { rows: Object.values(receipts).filter(r => r._pending) };
    if (S.startsWith('UPDATE receipts SET txn_id=')) { const r = receipts[params[1]]; if (r) r.txn_id = params[0]; return { rows: [] }; }
    if (S.startsWith('UPDATE receipts SET payment_method=')) { const r = receipts[params[0]]; if (r) r.payment_method = 'card'; return { rows: [] }; }
    return { rows: [] };
  }
  query.receipts = receipts;
  return query;
}
function fakeIO(initial = []) { let t = [...initial]; return { read: () => t, write: (_f, d) => { t = d; return true; }, txns: () => t, dir: '.' }; }

describe('createCashTransaction', () => {
  test('creates a source=cash expense and links the receipt', async () => {
    const receipts = { rRec: { id: 'rRec' } };
    const io = fakeIO();
    const tx = await rm.createCashTransaction(makeDb({ receipts }), io, 'u1',
      { id: 'rRec', ocr_data: {}, merchant_name: "Raising Cane's", receipt_date: '2026-06-18', total_amount: 21.59 });
    expect(tx.source).toBe('cash');
    expect(tx.amount).toBe(-21.59);
    expect(tx.receiptId).toBe('rRec');
    expect(io.txns()[0].id).toBe(tx.id);
    expect(receipts.rRec.txn_id).toBe(tx.id);
  });
});

describe('handleCashAnswer', () => {
  test('"no" → marks card, kept on file', async () => {
    const receipts = { rRec: { id: 'rRec', ocr_data: {}, total_amount: 21.59 } };
    const r = await rm.handleCashAnswer(makeDb({ receipts }), fakeIO(), 'u1', { id: 'cq', payload: { receiptId: 'rRec' } }, 'no');
    expect(r.replies[0]).toMatch(/Kept on file/);
    expect(receipts.rRec.payment_method).toBe('card');
  });
  test('"yes" → creates a cash expense', async () => {
    const receipts = { rRec: { id: 'rRec', ocr_data: { merchant: "Raising Cane's" }, merchant_name: "Raising Cane's", receipt_date: '2026-06-18', total_amount: 21.59 } };
    const io = fakeIO();
    const eq = jest.spyOn(core, 'enqueueQuestions').mockResolvedValue(0);
    const np = jest.spyOn(core, 'nextPrompt').mockResolvedValue(null);
    const r = await rm.handleCashAnswer(makeDb({ receipts }), io, 'u1', { id: 'cq', payload: { receiptId: 'rRec' } }, 'yes');
    expect(r.replies[0]).toMatch(/cash expense/);
    expect(io.txns().some(t => t.source === 'cash' && t.amount === -21.59)).toBe(true);
    eq.mockRestore(); np.mockRestore();
  });
  test('unclear reply → re-asks', async () => {
    const r = await rm.handleCashAnswer(makeDb(), fakeIO(), 'u1', { id: 'cq', payload: { receiptId: 'rRec' } }, 'maybe');
    expect(r.replies[0]).toMatch(/yes or no/);
  });
});

describe('matchPendingReceipts', () => {
  test('matches a pending receipt to a transaction by amount + date', async () => {
    const receipts = { rRec: { id: 'rRec', _pending: true, ocr_data: { merchant: 'Raising Cane' }, merchant_name: 'Raising Cane', receipt_date: '2026-06-18', total_amount: 21.59 } };
    const io = fakeIO([{ id: 'tCard', desc: 'RAISING CANES', amount: -21.59, date: '2026-06-18', source: 'plaid' }]);
    const n = await rm.matchPendingReceipts(makeDb({ receipts }), io, 'u1');
    expect(n).toBe(1);
    expect(receipts.rRec.txn_id).toBe('tCard');
    expect(io.txns().find(t => t.id === 'tCard').receiptId).toBe('rRec');
  });
  test('no candidate (amount differs) → no match', async () => {
    const receipts = { rRec: { id: 'rRec', _pending: true, ocr_data: {}, total_amount: 99.99, receipt_date: '2026-06-18' } };
    const io = fakeIO([{ id: 'tCard', amount: -21.59, date: '2026-06-18', source: 'plaid' }]);
    expect(await rm.matchPendingReceipts(makeDb({ receipts }), io, 'u1')).toBe(0);
  });
  test('multiple candidates → Groq picks the right one', async () => {
    const receipts = { rRec: { id: 'rRec', _pending: true, ocr_data: { merchant: 'Cane' }, total_amount: 21.59, receipt_date: '2026-06-18' } };
    const io = fakeIO([
      { id: 't1', desc: 'TARGET', amount: -21.59, date: '2026-06-18', source: 'plaid' },
      { id: 't2', desc: 'RAISING CANES', amount: -21.59, date: '2026-06-17', source: 'plaid' },
    ]);
    const groqPick = async (_m, cands) => cands.find(c => /CANES/.test(c.desc));
    const n = await rm.matchPendingReceipts(makeDb({ receipts }), io, 'u1', { groqPick });
    expect(n).toBe(1);
    expect(receipts.rRec.txn_id).toBe('t2');
  });
});
