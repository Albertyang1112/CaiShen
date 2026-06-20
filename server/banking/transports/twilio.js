'use strict';
/**
 * banking/transports/twilio.js — Twilio SMS/MMS adapter for the messaging transport
 * interface: { channel, start(onInbound), send, sendFile, stop } + { parseInbound, validate }.
 *
 * Unlike Discord (a persistent gateway), Twilio is WEBHOOK-inbound: Twilio HTTP-POSTs each
 * incoming SMS/MMS to a public URL. So `start` just stores the callback; the Express webhook
 * route (mounted in index.js) calls `parseInbound` then the stored handler. Outbound goes
 * through the Twilio REST API, reusing the SAME credentials as 2FA SMS
 * (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER — see core/auth.js).
 *
 * MMS note: sending an image back (the duplicate photo-send-back) needs a *public* media URL.
 * We hold raw bytes, not a URL, so sendFile falls back to a short text pointer until a public
 * media host is wired. Inbound MMS media IS downloaded (Twilio media URL + Basic auth) so a
 * receipt photographed over SMS still reaches OCR.
 */
const twilioLib = require('twilio');

// Same gate core/auth.js uses for 2FA SMS — all three secrets present and not a placeholder.
function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER &&
    process.env.TWILIO_ACCOUNT_SID !== 'paste_your_sid_here');
}

// Pull image/PDF media off a Twilio inbound payload into buffers, so the core stays
// transport-agnostic (it only ever sees bytes, never a Twilio URL).
async function downloadMedia(body, { accountSid, authToken }) {
  const n = parseInt(body.NumMedia || '0', 10) || 0;
  if (!n) return [];
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const out = [];
  for (let i = 0; i < n; i++) {
    const url = body[`MediaUrl${i}`];
    const ct  = body[`MediaContentType${i}`] || '';
    if (!url || !/^image\/|^application\/pdf/.test(ct)) continue;
    try {
      // Twilio media URLs 302 to a signed S3 URL; undici drops the Authorization header on the
      // cross-origin redirect, so Basic auth is used only for the first hop (exactly as intended).
      const resp = await fetch(url, { headers: { Authorization: auth } });
      if (!resp.ok) continue;
      const bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.length > 15 * 1024 * 1024) continue;          // 15 MB cap
      const ext = ct.includes('pdf') ? 'pdf' : (ct.split('/')[1] || 'jpg');
      out.push({ name: `mms-${i}.${ext}`, contentType: ct, bytes });
    } catch (e) { console.error('[twilio] media download failed:', e.message); }
  }
  return out;
}

function makeTwilioTransport(cfg = {}) {
  const accountSid = cfg.accountSid || process.env.TWILIO_ACCOUNT_SID;
  const authToken  = cfg.authToken  || process.env.TWILIO_AUTH_TOKEN;
  const from       = cfg.from       || process.env.TWILIO_FROM_NUMBER;
  const client     = cfg.client     || twilioLib(accountSid, authToken);

  return {
    channel: 'sms',
    from,
    // Webhook-inbound: the Express route dispatches via messaging-bot's handler registry,
    // so start() only marks readiness — it doesn't own an inbound loop like the Discord gateway.
    async start(_onInbound) { console.log('[twilio] SMS categorizer ready (from ' + from + ').'); },
    async send(externalId, text) {
      if (!text) return;
      await client.messages.create({ from, to: externalId, body: String(text) });
    },
    async sendFile(externalId, _bytes, _filename) {
      // No public media host yet — point the user to the app rather than dropping silently.
      await client.messages.create({ from, to: externalId,
        body: '📎 The matching receipt photo is saved in CaiShen — open the app to compare them.' });
    },
    async stop() { /* REST client — nothing to tear down */ },

    // Verify Twilio's request signature. `url` must be the exact public webhook URL Twilio hit.
    validate(signature, url, params) {
      try { return twilioLib.validateRequest(authToken, signature, url, params); }
      catch { return false; }
    },

    // A Twilio inbound webhook payload (form fields) -> the channel-agnostic inbound shape.
    async parseInbound(body) {
      const fromNum = body && body.From;
      if (!fromNum) return null;
      const attachments = await downloadMedia(body, { accountSid, authToken });
      return {
        channel: 'sms',
        externalId: fromNum,
        text: (body.Body || '').trim(),
        displayName: fromNum,
        attachments,
      };
    },
  };
}

module.exports = { makeTwilioTransport, twilioConfigured };
