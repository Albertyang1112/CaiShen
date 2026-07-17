'use strict';
/**
 * banking/payment-reminders.js — due-date reminder engine for insurance premiums + tax
 * payments, delivered over the chatbot (hooked into messaging-bot's 12h checkReminders).
 *
 * Cadence (the user's spec):
 *   > 30 days out            → silent
 *   8–30 days out            → WEEKLY reminders
 *   ≤ 7 days out (+ overdue) → DAILY reminders (override weekly)
 *   > 30 days overdue        → degrade back to weekly (an escrow-paid county bill that
 *                              never shows a bank debit shouldn't nag daily forever)
 *   payment matched          → the item stops being collected → silence; the policy's
 *                              next_due_date advances → the cycle restarts on its own.
 *
 * No stored reminder state beyond the sent-log (payment_reminders_log) — a UNIQUE
 * (user, item, due date, bucket) insert is the dedup, so the 12h loop firing twice a day
 * sends at most one message per bucket (bucket = calendar day for daily, ISO week for
 * weekly). Self-correcting, zero buttons.
 */
const crypto = require('crypto');

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fdate = (d) => d ? `${MON[Number(String(d).slice(5, 7)) - 1]} ${Number(String(d).slice(8, 10))}, ${String(d).slice(0, 4)}` : '?';
const money = (v) => v != null ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'an amount TBD';

// ── Pure cadence core (exported for tests) ───────────────────────────────────
function cadenceFor(daysUntilDue) {
  if (daysUntilDue == null || daysUntilDue > 30) return null;   // too far out
  if (daysUntilDue < -30) return 'weekly';                      // stale overdue → back off
  if (daysUntilDue <= 7) return 'daily';                        // ≤1 week (incl. overdue)
  return 'weekly';                                              // 8..30 days
}

// ISO week number (for the weekly dedup bucket).
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function bucketFor(cadence, today) {
  return cadence === 'daily' ? `d${today}` : `w${isoWeek(today)}`;
}

const daysUntil = (due, today) => Math.round((Date.parse(due) - Date.parse(today)) / 86400000);

let _schemaReady = false;
async function ensureSchema(query) {
  if (_schemaReady) return;
  await query(`CREATE TABLE IF NOT EXISTS payment_reminders_log (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_kind TEXT NOT NULL, item_id TEXT NOT NULL,
    due_date DATE, bucket TEXT NOT NULL, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_reminder
    ON payment_reminders_log(user_id, item_kind, item_id, due_date, bucket)`);
  _schemaReady = true;
}

// ── Collect everything currently owed ────────────────────────────────────────
// Unified item shape: { itemKind, itemId, dueDate, amount, label }. Refund rows are never
// collected (requirement: recognize refunds → no payment nag).
async function collectDueItems(query, io, userId, today) {
  const items = [];

  // 1. Unpaid insurance bills (a statement row whose payment has no matched txn).
  const bills = await query(
    `SELECT s.id, s.due_date, s.amount_due, pol.id AS policy_id, pol.carrier, pol.coverage_type, pol.property_id
       FROM insurance_statements s
       JOIN insurance_policies pol ON pol.id = s.insurance_policy_id
       LEFT JOIN insurance_payments pay ON pay.insurance_statement_id = s.id
      WHERE s.user_id=$1 AND s.due_date IS NOT NULL
        AND (pay.id IS NULL OR pay.matched_transaction_id IS NULL)`, [userId]);
  const billedPolicies = new Set();
  for (const b of bills.rows) {
    const due = String(b.due_date).slice(0, 10);
    billedPolicies.add(`${b.policy_id}|${due}`);
    items.push({
      itemKind: 'insurance', itemId: b.id, dueDate: due, amount: b.amount_due,
      label: [b.carrier, b.coverage_type].filter(Boolean).join(' '), propertyId: b.property_id || null,
    });
  }

  // 2. Anticipated next premiums — the policy's rolled-forward next_due_date when no
  //    statement covers it yet ("expected" wording; item id embeds the date so a shifted
  //    due date restarts dedup cleanly).
  const pols = await query(
    `SELECT id, carrier, coverage_type, premium_amount, next_due_date, property_id
       FROM insurance_policies WHERE user_id=$1 AND status='active' AND next_due_date IS NOT NULL`, [userId]);
  for (const p of pols.rows) {
    const due = String(p.next_due_date).slice(0, 10);
    if (billedPolicies.has(`${p.id}|${due}`)) continue;               // a real bill already covers it
    items.push({
      itemKind: 'insurance', itemId: `${p.id}|${due}`, dueDate: due, amount: p.premium_amount,
      label: [p.carrier, p.coverage_type].filter(Boolean).join(' '), propertyId: p.property_id || null,
      expected: true,
    });
  }

  // 3. Unpaid tax installments (refund rows have status refund_* and are excluded).
  const tax = await query(
    `SELECT id, label, authority, due_date, amount, property_id FROM tax_payment_schedule
      WHERE user_id=$1 AND status='unpaid' AND due_date IS NOT NULL`, [userId]);
  for (const t of tax.rows) {
    items.push({
      itemKind: 'tax', itemId: t.id, dueDate: String(t.due_date).slice(0, 10), amount: t.amount,
      label: [t.label, t.authority].filter(Boolean).join(' — '), propertyId: t.property_id || null,
    });
  }

  // 4. Open action items (letters demanding a response — escheatment notices etc.).
  // These nag WEEKLY from day one (alwaysRemind — the letter is already urgent), daily in
  // the final week before the consequence date, and stop only on a "done" reply.
  const acts = (io && typeof io.read === 'function' && io.read('action_items.json')) || [];
  for (const a of acts) {
    if (!a || a.status !== 'open') continue;
    items.push({
      itemKind: 'action', itemId: a.id, dueDate: a.dueDate || '9999-12-31', amount: a.amount ?? null,
      label: a.title, detail: a.detail || null, alwaysRemind: true, noDate: !a.dueDate,
    });
  }
  return items;
}

function formatPaymentReminder(it, days, io) {
  // Action letters read differently: what to DO + the consequence deadline + how to stop it.
  if (it.itemKind === 'action') {
    const deadline = it.noDate ? '' : days < 0 ? ` Deadline ${fdate(it.dueDate)} has PASSED.` : ` Deadline: ${fdate(it.dueDate)} (${days} day${days === 1 ? '' : 's'}).`;
    return `📬 Action needed: ${it.label}.${it.detail ? ` ${it.detail}.` : ''}${deadline} Reply "done" once you've handled it.`;
  }
  const props = (io && typeof io.read === 'function' && io.read('properties.json')) || [];
  const prop = it.propertyId ? props.find(p => p && p.id === it.propertyId) : null;
  const where = prop && prop.name ? ` (${prop.name})` : '';
  const when = days < 0 ? `was due ${fdate(it.dueDate)} — ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
             : days === 0 ? 'is due TODAY'
             : `is due ${fdate(it.dueDate)} — ${days} day${days === 1 ? '' : 's'} away`;
  const head = it.itemKind === 'tax' ? '🧾 Tax payment' : `🛡️ ${it.expected ? 'Expected insurance' : 'Insurance'} bill`;
  return `${head}: ${it.label || 'payment'}${where} for ${money(it.amount)} ${when}.`
    + (days <= 7 ? ` I'll keep reminding you daily until it's paid.` : '');
}

// Send every due (deduped) reminder for one user. `send(text)` delivers one message.
// Returns the number sent. Runs only in the bot's lock-holding instance.
async function sendPaymentReminders(query, userId, send, today, deps = {}) {
  await ensureSchema(query);
  const io = deps.io || null;
  const collect = deps.collectDueItems || collectDueItems;
  const items = await collect(query, io, userId, today);
  let sent = 0;
  for (const it of items) {
    try {
      const days = daysUntil(it.dueDate, today);
      // alwaysRemind (action letters): weekly even when the deadline is far/absent —
      // the letter itself is the urgency, not the date.
      const cadence = cadenceFor(days) || (it.alwaysRemind ? 'weekly' : null);
      if (!cadence) continue;
      const bucket = bucketFor(cadence, today);
      const ins = await query(
        `INSERT INTO payment_reminders_log (id, user_id, item_kind, item_id, due_date, bucket)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, item_kind, item_id, due_date, bucket) DO NOTHING RETURNING id`,
        [`prem_${crypto.randomBytes(6).toString('hex')}`, userId, it.itemKind, String(it.itemId), it.dueDate, bucket]);
      if (!ins.rows.length) continue;             // already reminded this bucket
      await send(formatPaymentReminder(it, days, io));
      sent++;
    } catch (e) { console.error('[payment-reminders] item', it.itemId, e.message); }
  }
  return sent;
}

module.exports = { cadenceFor, bucketFor, isoWeek, collectDueItems, sendPaymentReminders, formatPaymentReminder, ensureSchema };
