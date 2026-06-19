'use strict';
/**
 * banking/transports/discord.js — Discord adapter for the messaging transport interface:
 *   { channel, start(onInbound), send(externalId, text), stop() }
 *
 * DM-only and categorization-agnostic — it just moves text in and out. To add Twilio,
 * write a sibling with the same shape; nothing else in the categorizer changes.
 *
 * Requires (Discord Developer Portal → Bot): the MESSAGE CONTENT intent, and a DM-capable
 * bot. discord.js needs the Channel/Message partials to receive DM events.
 */
const { Client, GatewayIntentBits, Partials } = require('discord.js');

function makeDiscordTransport(token) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });
  let onInbound = null;

  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author?.bot) return;       // ignore our own + other bots
      if (msg.guildId) return;           // DMs only — never react in a server channel

      // Download image/PDF attachments (receipts) into buffers so the core stays
      // transport-agnostic — it just receives bytes, never a Discord URL.
      const attachments = [];
      for (const att of msg.attachments.values()) {
        const ct = att.contentType || '';
        if (!/^image\/|^application\/pdf/.test(ct)) continue;
        if (att.size > 15 * 1024 * 1024) continue;     // 15 MB cap
        try {
          const resp  = await fetch(att.url);
          const bytes = Buffer.from(await resp.arrayBuffer());
          attachments.push({ name: att.name, contentType: ct, bytes });
        } catch (e) { console.error('[discord] attachment fetch failed:', e.message); }
      }

      if (onInbound) await onInbound({
        channel: 'discord',
        externalId: msg.author.id,
        text: (msg.content || '').trim(),
        displayName: msg.author.username,
        attachments,
      });
    } catch (e) { console.error('[discord] inbound error:', e.message); }
  });

  return {
    channel: 'discord',
    async start(cb) {
      onInbound = cb;
      const ready = new Promise((res) =>
        client.once('ready', () => { console.log('[discord] categorizer online as', client.user.tag); res(); }));
      await client.login(token);
      return ready;
    },
    async send(externalId, text) {
      const user = await client.users.fetch(externalId);
      await user.send(text);
    },
    async stop() { try { await client.destroy(); } catch { /* best effort */ } },
  };
}

module.exports = { makeDiscordTransport };
