'use strict';
// Twilio SMS transport (banking/transports/twilio.js) + multi-channel delivery / webhook
// dispatch in banking/messaging-bot.js. No network: the Twilio client + fetch are faked.

const { makeTwilioTransport, twilioConfigured } = require('../banking/transports/twilio');
const bot  = require('../banking/messaging-bot');
const core = require('../banking/categorizer-core');

function fakeClient() {
  const sent = [];
  return { sent, messages: { create: async (m) => { sent.push(m); return { sid: 'SM1' }; } } };
}

describe('twilioConfigured', () => {
  const OLD = process.env;
  afterEach(() => { process.env = OLD; });
  test('true only when all three secrets are set and not a placeholder', () => {
    process.env = { ...OLD, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+1999' };
    expect(twilioConfigured()).toBe(true);
    process.env = { ...OLD, TWILIO_ACCOUNT_SID: 'paste_your_sid_here', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+1999' };
    expect(twilioConfigured()).toBe(false);
    process.env = { ...OLD, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: '', TWILIO_FROM_NUMBER: '+1999' };
    expect(twilioConfigured()).toBe(false);
  });
});

describe('twilio transport — outbound', () => {
  test('send posts from/to/body through the REST client', async () => {
    const client = fakeClient();
    const t = makeTwilioTransport({ client, from: '+1999' });
    await t.send('+15551234', 'Hello');
    expect(client.sent[0]).toEqual({ from: '+1999', to: '+15551234', body: 'Hello' });
  });
  test('send ignores empty text', async () => {
    const client = fakeClient();
    const t = makeTwilioTransport({ client, from: '+1999' });
    await t.send('+15551234', '');
    expect(client.sent).toHaveLength(0);
  });
  test('sendFile falls back to a text pointer (no public media host yet)', async () => {
    const client = fakeClient();
    const t = makeTwilioTransport({ client, from: '+1999' });
    await t.sendFile('+15551234', Buffer.from('x'), 'r.jpg');
    expect(client.sent[0].to).toBe('+15551234');
    expect(client.sent[0].body).toMatch(/saved in CaiShen/);
  });
});

describe('twilio transport — parseInbound', () => {
  test('maps From/Body to the channel-agnostic shape (no media)', async () => {
    const t = makeTwilioTransport({ client: fakeClient(), from: '+1999' });
    const inbound = await t.parseInbound({ From: '+15551234', Body: ' hi there ', NumMedia: '0' });
    expect(inbound).toMatchObject({ channel: 'sms', externalId: '+15551234', text: 'hi there', attachments: [] });
  });
  test('returns null when there is no sender', async () => {
    const t = makeTwilioTransport({ client: fakeClient(), from: '+1999' });
    expect(await t.parseInbound({ Body: 'hi' })).toBeNull();
  });
  test('downloads image MMS media into a buffer; skips non-image media', async () => {
    const t = makeTwilioTransport({ client: fakeClient(), accountSid: 'AC1', authToken: 'tok', from: '+1999' });
    const calls = [];
    global.fetch = jest.fn(async (url) => {
      calls.push(url);
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    });
    const inbound = await t.parseInbound({
      From: '+15551234', Body: '', NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/m0', MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/m1', MediaContentType1: 'text/plain',
    });
    expect(inbound.attachments).toHaveLength(1);
    expect(inbound.attachments[0]).toMatchObject({ contentType: 'image/jpeg' });
    expect(inbound.attachments[0].bytes.length).toBe(4);
    expect(calls).toEqual(['https://api.twilio.com/m0']);   // only the image was fetched
    delete global.fetch;
  });
});

describe('twilio transport — validate', () => {
  test('returns false on a bogus signature without throwing', () => {
    const t = makeTwilioTransport({ client: fakeClient(), authToken: 'tok', from: '+1999' });
    expect(t.validate('bad-sig', 'https://x/api/messaging/twilio/webhook', { From: '+1' })).toBe(false);
  });
});

describe('deliverPending — multi-channel routing', () => {
  function multiDb() {
    return async (sql, params = []) => {
      const S = String(sql).replace(/\s+/g, ' ').trim();
      if (S.includes("DISTINCT user_id FROM txn_messages WHERE state='open'")) return { rows: [{ user_id: 'u1' }, { user_id: 'u2' }] };
      if (S.includes("state='asked'")) return { rows: [] };
      if (S.startsWith('SELECT external_id FROM messaging_links')) {
        const [uid, ch] = params;
        if (uid === 'u1' && ch === 'discord') return { rows: [{ external_id: 'd1' }] };
        if (uid === 'u2' && ch === 'sms')     return { rows: [{ external_id: '+15550002' }] };
        return { rows: [] };
      }
      return { rows: [] };
    };
  }
  test('routes each user to the channel they are linked on', async () => {
    const spy = jest.spyOn(core, 'nextPrompt').mockResolvedValue('Q?');
    const dSent = [], sSent = [];
    const transports = {
      discord: { channel: 'discord', send: async (e, t) => dSent.push([e, t]) },
      sms:     { channel: 'sms',     send: async (e, t) => sSent.push([e, t]) },
    };
    await bot.deliverPending({ query: multiDb(), makeIO: () => ({}), transports });
    expect(dSent).toEqual([['d1', 'Q?']]);
    expect(sSent).toEqual([['+15550002', 'Q?']]);
    spy.mockRestore();
  });
});

describe('twilioWebhook — no SMS transport configured', () => {
  test('acks with empty TwiML and never 403s', async () => {
    let body = null, status = 200, headers = {};
    const res = {
      set: (k, v) => { headers[k] = v; },
      status: (c) => { status = c; return res; },
      send: (b) => { body = b; return res; },
    };
    await bot.twilioWebhook({ get: () => '', body: {} }, res);
    expect(body).toBe('<Response></Response>');
    expect(status).toBe(200);
  });
});
