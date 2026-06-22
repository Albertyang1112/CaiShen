'use strict';
// DRY-RUN the overdue-statement check for a user — prints what WOULD be sent, sends nothing and
// writes no dedup rows (calls the per-account check directly, not sendReminders).
//   node server/scripts/check-statements.js [userId] [today=YYYY-MM-DD]
require('./_env');
const { query } = require('../core/db');
const { listAccounts } = require('../core/banking-store');
const reminder = require('../banking/statement-reminder');

(async () => {
  const userId = process.argv[2] || '1781913882747';
  const today  = process.argv[3] || new Date().toISOString().slice(0, 10);
  console.log(`Overdue-statement check for ${userId} as of ${today} (grace ${process.env.STATEMENT_LATE_GRACE_DAYS || 4}d)\n`);

  const accounts = (await listAccounts(userId)).filter(a => a.accountClass === 'bank' || a.accountClass === 'card');
  if (!accounts.length) { console.log('No checking/savings/card accounts connected — nothing to check.'); process.exit(0); }

  for (const a of accounts) {
    const closeDay = await reminder.closeDayFor(a);
    const late = await reminder.lateStatementForAccount(query, userId, a, today);
    const who = `${a.institution || a.name} ••${a.last4 || '?'}`;
    if (late) console.log(`• ${who}  (closes ≈ ${closeDay}th)  →  OVERDUE\n    "${reminder.formatReminder(late)}"`);
    else      console.log(`• ${who}  (closes ≈ ${closeDay}th)  →  up to date`);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
