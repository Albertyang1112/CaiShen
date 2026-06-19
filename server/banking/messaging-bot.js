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
async function handleInbound({ query, makeIO, parseReply, ingest }, { channel, externalId, text, displayName, attachments }) {
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
      } catch (e) { replies.push('⚠️ Could not process that receipt: ' + e.message); }
    }
    return { replies, userId };
  }

  const res = await core.handleReply(query, makeIO(userId), userId, text, parseReply ? { parseReply } : {});
  return { replies: [res.reply, res.next].filter(Boolean), userId };
}

// Send the next pending question to each linked user who isn't already awaiting a reply.
// "One question at a time per user": skip anyone with an outstanding 'asked' message.
async function deliverPending({ query, makeIO, transport }) {
  const channel = transport.channel;
  const open = await query(`SELECT DISTINCT user_id FROM txn_messages WHERE state='open'`);
  for (const { user_id } of open.rows) {
    try {
      const ext = await query(
        `SELECT external_id FROM messaging_links WHERE user_id=$1 AND channel=$2 LIMIT 1`, [user_id, channel]);
      if (!ext.rows[0]) continue;                                                // not linked on this channel
      const asked = await query(`SELECT 1 FROM txn_messages WHERE user_id=$1 AND state='asked' LIMIT 1`, [user_id]);
      if (asked.rows[0]) continue;                                              // already awaiting a reply
      const text = await core.nextPrompt(query, makeIO(user_id), user_id);
      if (text) await transport.send(ext.rows[0].external_id, text);
    } catch (e) { console.error('[bot] deliver user', user_id, e.message); }
  }
}

// Boot the transport + delivery loop. Returns the transport (or null if no token).
function start({ makeIO, query, intervalMs = 8000 } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) { console.warn('[bot] DISCORD_BOT_TOKEN not set — categorizer bot disabled.'); return null; }
  const { makeDiscordTransport } = require('./transports/discord');
  const transport = makeDiscordTransport(token);

  transport.start(async (inbound) => {
    try {
      const { replies } = await handleInbound({ query, makeIO }, inbound);
      for (const r of replies) {
        try { await transport.send(inbound.externalId, r); } catch (e) { console.error('[bot] reply send:', e.message); }
      }
    } catch (e) { console.error('[bot] handleInbound:', e.message); }
  }).then(() => {
    const tick = () => deliverPending({ query, makeIO, transport }).catch(e => console.error('[bot] deliver loop:', e.message));
    setInterval(tick, intervalMs);
    tick();
  }).catch(e => console.error('[bot] start failed:', e.message));

  return transport;
}

module.exports = { handleInbound, deliverPending, start, formatReceiptReply, HELP };
