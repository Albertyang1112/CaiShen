'use strict';
// Tests for the messaging layer: banking/messaging-store.js (link identity + codes) and
// the transport-free routing in banking/messaging-bot.js (handleInbound / deliverPending).
// No DB/Discord: `query` is an in-memory fake; the core boundary is spied where crossed.

const store = require('../banking/messaging-store');
const bot   = require('../banking/messaging-bot');
const core  = require('../banking/categorizer-core');
const { findMatch, shouldAccept } = require('../banking/receipt-ingest');

// Minimal in-memory stand-in for the messaging tables.
function makeMsgDb(seed = {}) {
  const db = { links: seed.links || [], codes: seed.codes || [] };
  async function query(sql, params = []) {
    const S = String(sql).replace(/\s+/g, ' ').trim();
    if (S.startsWith('INSERT INTO messaging_link_codes')) {
      db.codes.push({ code: params[0], user_id: params[1], channel: params[2], used: false, expires_at: Date.now() + 15 * 60000 });
      return { rows: [] };
    }
    if (S.startsWith('SELECT user_id FROM messaging_link_codes')) {
      const c = db.codes.find(c => c.code === params[0] && !c.used && c.expires_at > Date.now());
      return { rows: c ? [{ user_id: c.user_id }] : [] };
    }
    if (S.startsWith('UPDATE messaging_link_codes SET used=TRUE')) {
      const c = db.codes.find(c => c.code === params[0]); if (c) c.used = true;
      return { rows: [] };
    }
    if (S.startsWith('INSERT INTO messaging_links')) {
      const ex = db.links.find(l => l.channel === params[2] && l.external_id === params[3]);
      if (ex) { ex.user_id = params[1]; ex.display_name = params[4]; }
      else db.links.push({ id: params[0], user_id: params[1], channel: params[2], external_id: params[3], display_name: params[4], linked_at: Date.now() });
      return { rows: [] };
    }
    if (S.startsWith('SELECT user_id FROM messaging_links')) {
      const l = db.links.find(l => l.channel === params[0] && l.external_id === params[1]);
      return { rows: l ? [{ user_id: l.user_id }] : [] };
    }
    if (S.startsWith('SELECT channel, external_id')) {
      return { rows: db.links.filter(l => l.user_id === params[0]) };
    }
    if (S.startsWith('DELETE FROM messaging_links')) {
      db.links = db.links.filter(l => !(l.user_id === params[0] && l.channel === params[1]));
      return { rows: [] };
    }
    return { rows: [] };
  }
  query.db = db;
  return query;
}

describe('messaging-store', () => {
  test('genCode is N unambiguous chars', () => {
    const c = store.genCode(8);
    expect(c).toHaveLength(8);
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]+$/);   // no 0/O/1/I
  });
  test('parseLinkCommand pulls the code, else null', () => {
    expect(store.parseLinkCommand('link ABC123')).toBe('ABC123');
    expect(store.parseLinkCommand('/link abc9')).toBe('ABC9');
    expect(store.parseLinkCommand('home appliances')).toBeNull();
  });
  test('create → redeem once; reuse fails; lookup works', async () => {
    const db = makeMsgDb();
    const code = await store.createLinkCode(db, 'u1', { channel: 'discord' });
    const r1 = await store.redeemLinkCode(db, code, { channel: 'discord', externalId: 'd1', displayName: 'Al' });
    expect(r1).toEqual({ ok: true, userId: 'u1' });
    expect(await store.userForExternal(db, 'discord', 'd1')).toBe('u1');
    const r2 = await store.redeemLinkCode(db, code, { channel: 'discord', externalId: 'd1' });
    expect(r2.ok).toBe(false);   // already used
  });
  test('expired code is rejected', async () => {
    const db = makeMsgDb();
    const code = await store.createLinkCode(db, 'u1', {});
    db.db.codes[0].expires_at = Date.now() - 1;
    expect((await store.redeemLinkCode(db, code, { channel: 'discord', externalId: 'd1' })).ok).toBe(false);
  });
  test('unlink removes the binding', async () => {
    const db = makeMsgDb({ links: [{ id: 'x', user_id: 'u1', channel: 'discord', external_id: 'd1' }] });
    await store.unlink(db, 'u1', 'discord');
    expect(await store.userForExternal(db, 'discord', 'd1')).toBeNull();
  });
});

describe('handleInbound', () => {
  test('unlinked sender gets help', async () => {
    const db = makeMsgDb();
    const r = await bot.handleInbound({ query: db, makeIO: () => ({}) }, { channel: 'discord', externalId: 'd1', text: 'hey' });
    expect(r.replies[0]).toBe(bot.HELP);
  });
  test('unlinked sender with a valid code gets linked', async () => {
    const db = makeMsgDb();
    const code = await store.createLinkCode(db, 'u1', { channel: 'discord' });
    const r = await bot.handleInbound({ query: db, makeIO: () => ({}) }, { channel: 'discord', externalId: 'd1', text: `link ${code}`, displayName: 'Al' });
    expect(r.replies[0]).toContain('Linked');
    expect(await store.userForExternal(db, 'discord', 'd1')).toBe('u1');
  });
  test('linked sender reply is dispatched to the core (reply + next)', async () => {
    const db = makeMsgDb({ links: [{ id: 'x', user_id: 'u1', channel: 'discord', external_id: 'd1' }] });
    const io = {};
    const makeIO = jest.fn(() => io);
    const spy = jest.spyOn(core, 'handleReply').mockResolvedValue({ reply: 'R', next: 'N', applied: true });
    const r = await bot.handleInbound({ query: db, makeIO }, { channel: 'discord', externalId: 'd1', text: 'ok' });
    expect(r.replies).toEqual(['R', 'N']);
    expect(spy).toHaveBeenCalledWith(db, io, 'u1', 'ok', {});
    spy.mockRestore();
  });
});

describe('deliverPending', () => {
  function deliverDb({ asked }) {
    return async (sql, params = []) => {
      const S = String(sql).replace(/\s+/g, ' ').trim();
      if (S.includes("DISTINCT user_id FROM txn_messages WHERE state='open'")) return { rows: [{ user_id: 'u1' }] };
      if (S.startsWith('SELECT external_id FROM messaging_links')) return { rows: [{ external_id: 'd1' }] };
      if (S.includes("state='asked'")) return { rows: asked ? [{ x: 1 }] : [] };
      return { rows: [] };
    };
  }
  test('pushes the next question to an idle, linked user', async () => {
    const spy = jest.spyOn(core, 'nextPrompt').mockResolvedValue('Q?');
    const sent = [];
    await bot.deliverPending({ query: deliverDb({ asked: false }), makeIO: () => ({}),
      transport: { channel: 'discord', send: async (e, t) => sent.push([e, t]) } });
    expect(sent).toEqual([['d1', 'Q?']]);
    spy.mockRestore();
  });
  test('skips a user already awaiting a reply (one at a time)', async () => {
    const spy = jest.spyOn(core, 'nextPrompt').mockResolvedValue('Q?');
    const sent = [];
    await bot.deliverPending({ query: deliverDb({ asked: true }), makeIO: () => ({}),
      transport: { channel: 'discord', send: async (e, t) => sent.push([e, t]) } });
    expect(sent).toEqual([]);
    spy.mockRestore();
  });
});

describe('receipt findMatch', () => {
  const txns = [
    { id: 't1', desc: 'WALMART SUPERCENTER', amount: -84.20, date: '2026-06-15' },
    { id: 't2', desc: 'TARGET',              amount: -20.00, date: '2026-06-10' },
  ];
  test('matches by amount + nearby date', () => {
    expect(findMatch({ total: 84.20, date: '2026-06-15', merchant: 'Walmart' }, txns).id).toBe('t1');
  });
  test('no match when the amount differs', () => {
    expect(findMatch({ total: 999, date: '2026-06-15' }, txns)).toBeNull();
  });
  test('no match when the date is too far off', () => {
    expect(findMatch({ total: 84.20, date: '2026-05-01' }, txns)).toBeNull();
  });
  test('a null total never matches', () => {
    expect(findMatch({ total: null }, txns)).toBeNull();
  });
});

describe('handleInbound — receipts', () => {
  test('an attachment from a linked user is routed to receipt ingest', async () => {
    const db = makeMsgDb({ links: [{ id: 'x', user_id: 'u1', channel: 'discord', external_id: 'd1' }] });
    let got = null;
    const ingest = async (q, io, uid, { buffer, mimeType }) => {
      got = { uid, mimeType, len: buffer.length };
      return { ocr: { merchant: 'Walmart', total: 84.2, date: '2026-06-15', items: [{}, {}] }, matched: null };
    };
    const r = await bot.handleInbound({ query: db, makeIO: () => ({}), ingest }, {
      channel: 'discord', externalId: 'd1', text: '',
      attachments: [{ name: 'r.jpg', contentType: 'image/jpeg', bytes: Buffer.from('xxxx') }],
    });
    expect(got).toEqual({ uid: 'u1', mimeType: 'image/jpeg', len: 4 });
    expect(r.replies[0]).toMatch(/Walmart/);
  });

  test('an attachment from an unlinked user gets help, not ingest', async () => {
    const db = makeMsgDb();
    let called = false;
    const ingest = async () => { called = true; return {}; };
    const r = await bot.handleInbound({ query: db, makeIO: () => ({}), ingest }, {
      channel: 'discord', externalId: 'dX', text: '',
      attachments: [{ name: 'r.jpg', contentType: 'image/jpeg', bytes: Buffer.from('x') }],
    });
    expect(called).toBe(false);
    expect(r.replies[0]).toBe(bot.HELP);
  });

  test('a rejected (non-receipt) attachment tells the user it was not saved', async () => {
    const db = makeMsgDb({ links: [{ id: 'x', user_id: 'u1', channel: 'discord', external_id: 'd1' }] });
    const ingest = async () => ({ rejected: true, reason: 'not_receipt', docType: 'other' });
    const r = await bot.handleInbound({ query: db, makeIO: () => ({}), ingest }, {
      channel: 'discord', externalId: 'd1', text: '',
      attachments: [{ name: 'cat.jpg', contentType: 'image/jpeg', bytes: Buffer.from('x') }],
    });
    expect(r.replies[0]).toMatch(/doesn't look like a receipt/);
  });
});

describe('receipt shouldAccept (gatekeeper)', () => {
  test('accepts when classified as a receipt', () => {
    expect(shouldAccept({ is_receipt: true }).accept).toBe(true);
  });
  test('rejects when classified as not a receipt', () => {
    expect(shouldAccept({ is_receipt: false, doc_type: 'other' })).toEqual({ accept: false, reason: 'not_receipt', docType: 'other' });
  });
  test('unclassified: accept if purchase data was read, else reject as unreadable', () => {
    expect(shouldAccept({ is_receipt: null, total: 9.99 }).accept).toBe(true);
    expect(shouldAccept({ is_receipt: null, merchant: null, total: null })).toEqual({ accept: false, reason: 'unreadable', docType: null });
  });
});

describe('formatReceiptReply', () => {
  test('rejection message for a non-receipt', () => {
    expect(bot.formatReceiptReply({ rejected: true, reason: 'not_receipt' })).toMatch(/doesn't look like a receipt/);
  });
  test('summary for an accepted receipt', () => {
    expect(bot.formatReceiptReply({ ocr: { merchant: 'Walmart', total: 14.99, date: '2026-06-15', items: [] }, matched: null }))
      .toMatch(/Saved receipt — Walmart/);
  });
});
