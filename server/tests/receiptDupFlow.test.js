'use strict';
// Flow tests: findDuplicate over existing receipts, and the same/separate/unsure reply handling.
const { findDuplicate } = require('../banking/receipt-dedup');
const dupflow = require('../banking/receipt-dupflow');

// Fake query: serves findDuplicate's SELECT, tracks receipt status updates + the held receipt.
function makeDb({ existing = [], newReceipt = null } = {}) {
  const receipts = {};
  if (newReceipt) receipts[newReceipt.id] = { ...newReceipt };
  const messages = {};
  async function query(sql, params = []) {
    const S = String(sql).replace(/\s+/g, ' ').trim();
    if (S.startsWith('SELECT id, doc_id, file_sha256')) return { rows: existing };            // findDuplicate
    if (S.startsWith('SELECT txn_id, ocr_data FROM receipts WHERE id=')) {                  // finalize read
      const r = receipts[params[0]]; return { rows: r ? [{ txn_id: r.txn_id || null, ocr_data: r.ocr_data || {} }] : [] };
    }
    if (S.startsWith('UPDATE receipts SET duplicate_status=')) {                            // outcome writes
      const r = receipts[params[0]] || (receipts[params[0]] = {});
      const ds = (S.match(/duplicate_status='([^']+)'/) || [])[1];
      const rs = (S.match(/review_status='([^']+)'/) || [])[1];
      if (ds) r.duplicate_status = ds; if (rs) r.review_status = rs;
      return { rows: [] };
    }
    if (S.startsWith('UPDATE txn_messages SET state=')) { const m = messages[params[0]]; if (m) m.state = 'answered'; return { rows: [] }; }
    if (S.startsWith('UPDATE txn_messages SET payload=')) { const m = messages[params[0]]; if (m) m.payload = params[1]; return { rows: [] }; }
    return { rows: [] };   // recordReceiptRemodel + log writes → no-op
  }
  query.receipts = receipts; query.messages = messages;
  return query;
}
const fakeIO = () => ({ read: () => [], write: () => true, dir: '.' });

describe('findDuplicate', () => {
  test('hard duplicate by file hash', async () => {
    const db = makeDb({ existing: [{ id: 'r1', file_sha256: 'H', ocr_data: { merchant: 'Walmart', total: 43.91 } }] });
    const r = await findDuplicate(db, 'u1', { file_sha256: 'H', ocr: { merchant: 'Walmart', total: 43.91 } });
    expect(r.level).toBe('hard');
    expect(r.matchedReceiptId).toBe('r1');
  });
  test('possible duplicate by merchant + amount + date', async () => {
    const db = makeDb({ existing: [{ id: 'r1', ocr_data: { merchant: 'Walmart', total: 43.91, date: '2026-06-15' } }] });
    const r = await findDuplicate(db, 'u1', { ocr: { merchant: 'Walmart', total: 43.91, date: '2026-06-15' } });
    expect(r.level).toBe('possible');
    expect(r.matchedReceiptId).toBe('r1');
  });
  test('unique when nothing matches', async () => {
    const db = makeDb({ existing: [{ id: 'r1', ocr_data: { merchant: 'Target', total: 5, date: '2026-01-01' } }] });
    const r = await findDuplicate(db, 'u1', { ocr: { merchant: 'Walmart', total: 43.91, date: '2026-06-15' } });
    expect(r.level).toBe('unique');
  });
});

describe('handleDedupReply', () => {
  function setup(stage = 'await_decision') {
    const q = { id: 'txm1', payload: { stage, newReceiptId: 'rNew', existingReceiptId: 'rOld', checkId: 'dchk1' } };
    const db = makeDb({ newReceipt: { id: 'rNew', txn_id: null, ocr_data: { merchant: 'Walmart', total: 43.91, items: [] } } });
    db.messages.txm1 = { id: 'txm1', state: 'asked', payload: JSON.stringify(q.payload) };
    return { db, q };
  }
  test('"same" → confirmed_duplicate + rejected (no active receipt)', async () => {
    const { db, q } = setup();
    const r = await dupflow.handleDedupReply(db, fakeIO(), 'u1', q, 'same');
    expect(r.replies[0]).toMatch(/same purchase/);
    expect(db.receipts.rNew).toMatchObject({ duplicate_status: 'confirmed_duplicate', review_status: 'rejected_duplicate' });
  });
  test('"separate" with proof → confirmed_separate + user_confirmed', async () => {
    const { db, q } = setup();
    const r = await dupflow.handleDedupReply(db, fakeIO(), 'u1', q, 'separate, different receipt number 849202', { groqClassify: async () => null });
    expect(r.replies[0]).toMatch(/separate purchase/);
    expect(db.receipts.rNew).toMatchObject({ duplicate_status: 'confirmed_separate', review_status: 'user_confirmed' });
  });
  test('"separate" with no proof → one follow-up; not finalized yet', async () => {
    const { db, q } = setup();
    const r = await dupflow.handleDedupReply(db, fakeIO(), 'u1', q, 'separate');
    expect(r.replies[0]).toMatch(/What makes it separate/);
    expect(JSON.parse(db.messages.txm1.payload).stage).toBe('await_proof');
    expect(db.receipts.rNew.duplicate_status).toBeUndefined();
  });
  test('follow-up with a detail → confirmed_separate', async () => {
    const { db, q } = setup('await_proof');
    const r = await dupflow.handleDedupReply(db, fakeIO(), 'u1', q, 'it was at 4:12 PM');
    expect(r.replies[0]).toMatch(/separate purchase/);
    expect(db.receipts.rNew.duplicate_status).toBe('confirmed_separate');
  });
  test('follow-up with nothing useful → needs_review', async () => {
    const { db, q } = setup('await_proof');
    const r = await dupflow.handleDedupReply(db, fakeIO(), 'u1', q, 'idk');
    expect(r.replies[0]).toMatch(/mark this for review/);
    expect(db.receipts.rNew.review_status).toBe('needs_review');
  });
  test('"unsure" → needs_review', async () => {
    const { db, q } = setup();
    const r = await dupflow.handleDedupReply(db, fakeIO(), 'u1', q, 'not sure');
    expect(r.replies[0]).toMatch(/mark this for review/);
    expect(db.receipts.rNew).toMatchObject({ duplicate_status: 'needs_review', review_status: 'needs_review' });
  });
});
