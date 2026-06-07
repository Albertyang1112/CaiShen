// discord-bot.js — Phase 2 conversational categorizer (standalone process).
// Polls user 1's transactions for uncategorized rows, asks in the Discord channel,
// runs the reply through the Groq brain (categorize-ai), confirms, and on "confirm"
// creates the account (if new) + applies the coaId + writes a categorize.js rule.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');
const { parseCategoryReply } = require('./categorize-ai');
const { suggestKeyword } = require('./categorize');

const USER_ID = process.env.BOT_USER_ID || '1';
const dataDir = path.join(__dirname, '..', 'data', 'users', USER_ID);
const io = {
  read: (f) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch { return null; } },
  write: (f, d) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(d, null, 2)),
};
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TOKEN = process.env.DISCORD_BOT_TOKEN;

let channelId = null, pending = null, busy = false, started = false;

const accountsById = () => { const m = {}; for (const a of (io.read('accounts.json') || [])) m[a.id] = a; return m; };
const acctLabel = (tx) => { const a = accountsById()[tx.account]; return a ? a.name + (a.last4 ? ` ••${a.last4}` : '') : (tx.institution || ''); };
const money = (a) => { a = Number(a || 0); return (a < 0 ? '-' : '+') + '$' + Math.abs(a).toFixed(2); };
const nextUncategorized = () => (io.read('transactions.json') || []).find(t => !t.coaId && !t.catAsked && !t.excluded);
const patchTxn = (id, patch) => { const txs = io.read('transactions.json') || []; io.write('transactions.json', txs.map(t => t.id === id ? { ...t, ...patch } : t)); };
const propLabel = (p) => (p.isNew && p.newAccount)
  ? `**new account "${p.newAccount.name}"** (${p.newAccount.type}/${p.newAccount.subtype || ''})`
  : `**${p.accountName}**`;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

async function send(text) {
  if (!channelId) return;
  try { const ch = await client.channels.fetch(channelId); if (ch) await ch.send(text); }
  catch (e) { console.error('[bot] send err', e.message); }
}

async function askNext() {
  if (pending || busy) return;
  const tx = nextUncategorized();
  if (!tx) return;
  pending = { stage: 'await_cat', txn: tx };
  patchTxn(tx.id, { catAsked: true });
  await send(`🟡 **Uncategorized:** ${money(tx.amount)} — ${tx.desc} · ${acctLabel(tx)} · (${tx.date})\nWhat category? (reply in plain words, or \`skip\`)`);
}

async function applyProposal(tx, p) {
  let coa = io.read('chart_of_accounts.json') || [];
  let coaId = p.coaId, name = p.accountName;
  if (p.isNew && p.newAccount) {
    coaId = 'acct_' + Date.now();
    name = p.newAccount.name;
    coa.push({ id: coaId, number: '', name, type: p.newAccount.type, subtype: p.newAccount.subtype || '', active: true });
    io.write('chart_of_accounts.json', coa);
  }
  patchTxn(tx.id, { coaId, approved: true, categorizedBy: 'ai' });
  const kw = suggestKeyword(tx.desc);
  if (kw && coaId) {
    const rules = io.read('categorization_rules.json') || [];
    rules.push({ id: 'rule_' + Date.now(), field: 'desc', op: 'contains', value: kw, coaId, enabled: true });
    io.write('categorization_rules.json', rules);
    await send(`✅ Categorized as **${name}** — and I'll auto-file future **"${kw}"** charges here.`);
  } else { await send(`✅ Categorized as **${name}**.`); }
  console.log('[bot] applied', tx.id, '->', coaId, name);
}

async function handleReply(text) {
  if (pending.stage === 'await_cat' && /^skip$/i.test(text)) { await send('⏭️ Skipped.'); pending = null; return askNext(); }
  if (pending.stage === 'await_confirm' && /^(confirm|yes|y|yep|correct|ok)$/i.test(text)) { await applyProposal(pending.txn, pending.proposal); pending = null; return askNext(); }
  await send('…thinking');
  const p = await parseCategoryReply({ replyText: text, tx: { ...pending.txn, accountName: acctLabel(pending.txn) }, coa: io.read('chart_of_accounts.json') || [] });
  if (p.error) { await send('⚠️ ' + p.error + ' — try rephrasing?'); return; }
  pending.proposal = p; pending.stage = 'await_confirm';
  await send(`→ ${p.interpretation}\nCategorize as ${propLabel(p)}? Reply \`confirm\`, or just tell me the right category.`);
}

client.once('ready', async () => {
  if (started) return; started = true;
  console.log('[bot] online as', client.user.tag);
  try { if (WEBHOOK) channelId = (await axios.get(WEBHOOK)).data.channel_id; } catch (e) { console.error('[bot] channel resolve failed', e.message); }
  console.log('[bot] channelId', channelId);
  await send('🤖 CaiShen categorizer online — I\'ll ask here about uncategorized transactions.');
  setInterval(() => askNext().catch(e => console.error('[bot] askNext', e.message)), 10000);
  askNext().catch(e => console.error('[bot] askNext', e.message));
});

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot || (channelId && msg.channelId !== channelId) || !pending || busy) return;
    busy = true;
    await handleReply(msg.content.trim());
  } catch (e) { console.error('[bot] msg err', e.message); }
  finally { busy = false; }
});

client.login(TOKEN).catch(e => { console.error('[bot] login failed', e.message); process.exit(1); });
