'use strict';
/**
 * banking/messaging-bot.js — wires a messaging transport (Discord now, Twilio later) to
 * the transport-free categorizer-core. Runs IN-PROCESS with the main server so it shares
 * the core/store cache + Neon, avoiding stale reads and full-replace clobbering.
 *
 *   • handleInbound  — route one inbound message: do the link handshake if the sender
 *                      isn't linked yet, otherwise hand the reply to categorizer-core.
 *   • deliverPending — push the next pending question to each linked, idle user.
 *   • start          — boot the Discord transport + a delivery poll loop.
 *
 * handleInbound/deliverPending take injected deps so they're unit-testable without Discord.
 */
const core  = require('./categorizer-core');
const store = require('./messaging-store');

const HELP = 'Hi! To connect your CaiShen account, open CaiShen → Settings → Connect Discord '
           + 'to get a code, then send it to me here as:  link YOURCODE';

// Summarize an ingested receipt for the user (or explain why it was rejected).
function formatReceiptReply(r) {
  if (r && r.rejected) {
    return r.reason === 'not_receipt'
      ? "🚫 That doesn't look like a receipt or order confirmation, so I didn't save it. Send a photo of a receipt, invoice, or order confirmation."
      : "📄 I couldn't read that clearly — try a sharper photo of the whole receipt (or send the PDF).";
  }
  if (r && (r.level === 'hard' || r.level === 'possible')) {
    const dupflow = require('./receipt-dupflow');
    return r.level === 'hard'
      ? dupflow.hardDuplicateMessage(r.existing || {})
      : dupflow.possibleDuplicateMessage(r.newOcr || {}, r.existing || {});
  }
  const o = (r && r.ocr) || {};
  if (o.total == null && o.merchant == null) {
    return `📄 Saved your receipt, but I couldn't read the details.`;
  }
  const money = o.total != null ? `$${Number(o.total).toFixed(2)}` : '?';
  const items = Array.isArray(o.items) && o.items.length ? ` (${o.items.length} item${o.items.length > 1 ? 's' : ''})` : '';
  const head  = `📄 Saved receipt — ${[o.merchant || 'Receipt', money, o.date].filter(Boolean).join(' · ')}${items}.`;
  return head + (r.matched ? `\nMatched to: ${r.matched.desc} (${r.matched.date}).` : `\nNo matching transaction yet — kept on file.`);
}

// Route one inbound message. Returns { replies: string[], userId? }.
async function handleInbound({ query, makeIO, parseReply, ingest, groqClassify }, { channel, externalId, text, displayName, attachments }) {
  const userId = await store.userForExternal(query, channel, externalId);

  if (!userId) {
    const code = store.parseLinkCommand(text);
    if (!code) return { replies: [HELP] };
    const r = await store.redeemLinkCode(query, code, { channel, externalId, displayName });
    return { replies: [r.ok
      ? "✅ Linked! I'll message you here whenever new transactions need a category. You can also send me a photo of a receipt."
      : 'That code is invalid or expired — grab a fresh one in CaiShen → Settings → Connect Discord.'] };
  }

  // Receipt attachments → OCR + store (no transaction context needed).
  if (Array.isArray(attachments) && attachments.length) {
    const ingestReceipt = ingest || require('./receipt-ingest').ingestReceipt;
    const io = makeIO(userId);
    const replies = [];
    for (const a of attachments) {
      try {
        const res = await ingestReceipt(query, io, userId, { buffer: a.bytes, mimeType: a.contentType, originalName: a.name });
        replies.push(formatReceiptReply(res));
        // On a flagged duplicate, send the existing receipt photo back for comparison (best-effort).
        if ((res.level === 'hard' || res.level === 'possible') && res.existingDocId) {
          try { const bytes = await require('../core/documents').getDocumentBytes(userId, res.existingDocId); if (bytes) replies.push({ file: bytes, name: 'existing-receipt.jpg' }); }
          catch { /* skip the photo if it can't be fetched */ }
        }
        // A saved, unmatched receipt → ask whether it was cash.
        if (res.level === 'unique' && !res.matched && res.id) {
          await require('./receipt-match').createCashQuestion(query, userId, res.id);
          replies.push('Was this a cash purchase? Reply yes or no.');
        }
      } catch (e) { replies.push('⚠️ Could not process that receipt: ' + e.message); }
    }
    return { replies, userId };
  }

  // A pending duplicate-resolution question takes priority over categorization.
  const dupflow = require('./receipt-dupflow');
  const dq = await dupflow.pendingDedupQuestion(query, userId);
  if (dq) {
    const res = await dupflow.handleDedupReply(query, makeIO(userId), userId, dq, text, groqClassify ? { groqClassify } : {});
    return { replies: res.replies, userId };
  }

  // Then a pending cash question.
  const rm = require('./receipt-match');
  const cq = await rm.pendingCashQuestion(query, userId);
  if (cq) {
    const res = await rm.handleCashAnswer(query, makeIO(userId), userId, cq, text);
    return { replies: res.replies, userId };
  }

  const res = await core.handleReply(query, makeIO(userId), userId, text, parseReply ? { parseReply } : {});
  return { replies: [res.reply, res.next].filter(Boolean), userId };
}

// Build the per-transport inbound callback: route the message through the core, then send each
// reply back over the SAME transport it arrived on (a {file} reply → sendFile, else send).
function makeInboundHandler({ query, makeIO, transport }) {
  return async (inbound) => {
    try {
      const { replies } = await handleInbound({ query, makeIO }, inbound);
      for (const r of replies) {
        try {
          if (r && typeof r === 'object' && r.file) await transport.sendFile(inbound.externalId, r.file, r.name);
          else await transport.send(inbound.externalId, r);
        } catch (e) { console.error('[bot] reply send:', e.message); }
      }
    } catch (e) { console.error('[bot] handleInbound:', e.message); }
  };
}

// Send the next pending question to each linked user who isn't already awaiting a reply.
// "One question at a time per user": skip anyone with an outstanding 'asked' message.
// Routes per user to whichever channel they're linked on that has a live transport.
// Accepts either `transports` ({channel: transport}) or a single legacy `transport`.
async function deliverPending({ query, makeIO, transport, transports }) {
  const map = transports || (transport ? { [transport.channel]: transport } : {});
  const channels = Object.keys(map);
  if (!channels.length) return;
  const open = await query(`SELECT DISTINCT user_id FROM txn_messages WHERE state='open'`);
  for (const { user_id } of open.rows) {
    try {
      const asked = await query(`SELECT 1 FROM txn_messages WHERE user_id=$1 AND state='asked' LIMIT 1`, [user_id]);
      if (asked.rows[0]) continue;                                              // already awaiting a reply
      let target = null;
      for (const ch of channels) {
        const ext = await query(
          `SELECT external_id FROM messaging_links WHERE user_id=$1 AND channel=$2 LIMIT 1`, [user_id, ch]);
        if (ext.rows[0]) { target = { transport: map[ch], externalId: ext.rows[0].external_id }; break; }
      }
      if (!target) continue;                                                    // not linked on any live channel
      const text = await core.nextPrompt(query, makeIO(user_id), user_id);
      if (text) await target.transport.send(target.externalId, text);
    } catch (e) { console.error('[bot] deliver user', user_id, e.message); }
  }
}

// Live transports + their inbound handlers, keyed by channel. Populated by start();
// the Twilio webhook route reads _inbound.sms to dispatch incoming SMS/MMS.
let _transports = {};
let _inbound = {};

// Boot every configured transport (Discord if DISCORD_BOT_TOKEN, Twilio if TWILIO_* set) and a
// single multi-channel delivery loop. Returns { transports } (or null if none configured).
function start({ makeIO, query, intervalMs = 8000 } = {}) {
  _transports = {}; _inbound = {};
  const boots = [];

  const token = process.env.DISCORD_BOT_TOKEN;
  if (token) {
    const { makeDiscordTransport } = require('./transports/discord');
    const t = makeDiscordTransport(token);
    const handler = makeInboundHandler({ query, makeIO, transport: t });
    _transports.discord = t; _inbound.discord = handler;
    boots.push(Promise.resolve(t.start(handler))
      .catch(e => { delete _transports.discord; console.error('[bot] discord start failed:', e.message); }));
  } else console.warn('[bot] DISCORD_BOT_TOKEN not set — Discord channel disabled.');

  const { makeTwilioTransport, twilioConfigured } = require('./transports/twilio');
  if (twilioConfigured()) {
    const t = makeTwilioTransport();
    const handler = makeInboundHandler({ query, makeIO, transport: t });
    _transports.sms = t; _inbound.sms = handler;
    boots.push(Promise.resolve(t.start(handler))
      .catch(e => { delete _transports.sms; console.error('[bot] twilio start failed:', e.message); }));
  } else console.warn('[bot] Twilio not configured — SMS channel disabled.');

  if (!boots.length) { console.warn('[bot] no messaging transports configured — categorizer bot idle.'); return null; }

  Promise.allSettled(boots).then(() => {
    if (!Object.keys(_transports).length) return;
    const tick = () => deliverPending({ query, makeIO, transports: _transports })
      .catch(e => console.error('[bot] deliver loop:', e.message));
    setInterval(tick, intervalMs);
    tick();
  });

  return { transports: _transports };
}

// Express handler for Twilio's inbound webhook (mounted public in index.js). Verifies the
// signature when TWILIO_PUBLIC_URL is set, ACKs immediately with empty TwiML, then processes
// + replies via REST so OCR latency never trips Twilio's request timeout.
async function twilioWebhook(req, res) {
  const t = _transports.sms, handler = _inbound.sms;
  if (!t || !handler) { res.set('Content-Type', 'text/xml'); return res.send('<Response></Response>'); }

  const publicUrl = process.env.TWILIO_PUBLIC_URL;
  if (publicUrl) {
    const sig = req.get('X-Twilio-Signature') || '';
    if (!t.validate(sig, publicUrl, req.body || {})) {
      console.warn('[twilio] signature validation failed — rejecting webhook.');
      return res.status(403).send('invalid signature');
    }
  } else if (!twilioWebhook._warned) {
    twilioWebhook._warned = true;
    console.warn('[twilio] TWILIO_PUBLIC_URL not set — inbound signature validation is OFF (set it in prod).');
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
  try {
    const inbound = await t.parseInbound(req.body || {});
    if (inbound) await handler(inbound);
  } catch (e) { console.error('[twilio] webhook dispatch:', e.message); }
}

module.exports = { handleInbound, deliverPending, makeInboundHandler, start, twilioWebhook, formatReceiptReply, HELP };
