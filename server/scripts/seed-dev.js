'use strict';
/**
 * scripts/seed-dev.js — populate a LOCAL development database with synthetic, non-real
 * financial data so you can exercise Banking, Reports, receipts + dedup, reconciliation,
 * and the Mortgage page without touching production. Run: `npm run db:seed`.
 *
 * SAFETY: refuses to run unless DATABASE_URL is a LOCAL host (so it can never seed prod).
 * Idempotent: deterministic `dev_*` ids + ON CONFLICT upserts — re-run anytime.
 * NO real user data — everything here is fake.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env.local'), override: true });

const bcrypt = require('bcryptjs');
const { query, initSchema, getPool, classifyDbUrl } = require('../core/db');
const { findOrCreatePeriod } = require('../banking/periods');

const USER = 'dev_user';
const ACCT_CHK = 'dev_acct_chk';
const ACCT_MTG = 'dev_acct_mtg';
const MORT = 'dev_mort';

async function main() {
  const url = process.env.DATABASE_URL || '';
  const { isLocal, host } = classifyDbUrl(url);
  if (!isLocal) {
    console.error(`✗ seed-dev refuses to run: DATABASE_URL is not local (host=${host || '?'}).`);
    console.error('  Point .env.local at a local Postgres first. This script only ever seeds a local DB.');
    process.exit(1);
  }
  console.log(`▶ Seeding LOCAL database @ ${host} …`);
  await initSchema();   // make sure all tables exist

  // ── User (login: dev / dev1234) ────────────────────────────────────────────
  const hash = bcrypt.hashSync('dev1234', 10);
  await query(
    `INSERT INTO users (id, username, email, password_hash, role, display_name)
     VALUES ($1,'dev','dev@local.test',$2,'admin','Dev User')
     ON CONFLICT (id) DO UPDATE SET password_hash=EXCLUDED.password_hash, role='admin'`,
    [USER, hash]
  );

  // ── Accounts (a checking account + a mortgage loan account) ─────────────────
  const accounts = [
    [ACCT_CHK, 'manual', 'bank', 'depository', 'checking', 'Dev Checking', '4321', 5200.00],
    [ACCT_MTG, 'manual', 'loan', 'loan', 'mortgage', 'Dev Home Loan', '9988', -312500.00],
  ];
  for (const [id, source, klass, ptype, psub, name, mask, bal] of accounts) {
    await query(
      `INSERT INTO accounts (id,user_id,source,account_class,plaid_type,plaid_subtype,name,official_name,mask,current_balance,available_balance,currency,details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$9,'USD','{}')
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, current_balance=EXCLUDED.current_balance, updated_at=NOW()`,
      [id, USER, source, klass, ptype, psub, name, mask, bal]
    );
  }

  // ── Period for May 2026 on the checking account ─────────────────────────────
  await findOrCreatePeriod(query, USER, ACCT_CHK, '2026-05-15');

  // ── Transactions (the display layer the Banking/Reports pages read) ─────────
  const txns = [
    { id: 'dev_txn_groc', date: '2026-05-03', desc: 'Whole Foods Market', amount: -84.21, category: 'Groceries' },
    { id: 'dev_txn_gas',  date: '2026-05-05', desc: 'Shell Gas',          amount: -52.10, category: 'Transport' },
    { id: 'dev_txn_pay',  date: '2026-05-10', desc: 'Payroll ACME Inc',   amount: 3200.00, category: 'Income' },
    { id: 'dev_txn_mtg',  date: '2026-05-15', desc: 'Rocket Mortgage Pmt',amount: -2450.00, category: 'Housing' },
    { id: 'dev_txn_cof',  date: '2026-05-20', desc: 'Starbucks',          amount: -6.45,  category: 'Coffee' },
  ];
  for (const t of txns) {
    const acct = t.id === 'dev_txn_mtg' ? ACCT_MTG : ACCT_CHK;
    const obj = { ...t, month: t.date.slice(0, 7), account: acct, institution: 'Dev Bank', source: 'plaid', pending: false };
    await query(
      `INSERT INTO transactions (id,user_id,account,txn_date,month,description,amount,category,institution,pending,source,data,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Dev Bank',false,'plaid',$9,NOW())
       ON CONFLICT (id) DO UPDATE SET amount=EXCLUDED.amount, category=EXCLUDED.category, description=EXCLUDED.description, data=EXCLUDED.data, updated_at=NOW()`,
      [t.id, USER, acct, t.date, obj.month, t.desc, t.amount, t.category, JSON.stringify(obj)]
    );
  }

  // ── source_transactions: a Plaid row, a statement row (to reconcile), a receipt row ──
  const srcs = [
    ['dev_src_plaid_gas', 'plaid',     ACCT_CHK, '2026-05-05', 'Shell Gas',          -52.10, 'dev_txn_gas'],
    ['dev_src_stmt_gas',  'statement', ACCT_CHK, '2026-05-06', 'SHELL OIL 12345',    -52.10, null],
    ['dev_src_rcpt_groc', 'receipt',   ACCT_CHK, '2026-05-03', 'Whole Foods Market', -84.21, null],
  ];
  for (const [id, source, acct, date, desc, amount, ext] of srcs) {
    await query(
      `INSERT INTO source_transactions (id,user_id,source,account_id,external_transaction_id,txn_date,description,merchant_name,amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)
       ON CONFLICT (id) DO UPDATE SET amount=EXCLUDED.amount, description=EXCLUDED.description`,
      [id, USER, source, acct, ext, date, desc, amount]
    );
  }

  // ── matched_transaction_sources: statement ↔ plaid, and receipt ↔ txn ───────
  const links = [
    ['dev_txn_gas',  'dev_src_stmt_gas',  'bank_statement', 0.95],
    ['dev_txn_groc', 'dev_src_rcpt_groc', 'receipt',        0.90],
  ];
  for (const [txnId, srcId, role, conf] of links) {
    await query(
      `INSERT INTO matched_transaction_sources (id,user_id,transaction_id,source_transaction_id,source_role,match_confidence)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (transaction_id, source_transaction_id) DO UPDATE SET match_confidence=EXCLUDED.match_confidence, updated_at=NOW()`,
      [`dev_mts_${srcId}`, USER, txnId, srcId, role, conf]
    );
  }

  // ── Receipt + line items + a duplicate-check log ────────────────────────────
  await query(
    `INSERT INTO receipts (id,user_id,txn_id,file_path,original_name,mime_type,ocr_data,match_status,
        merchant_name,receipt_date,total_amount,duplicate_status,review_status,file_sha256)
     VALUES ($1,$2,'dev_txn_groc','dev/receipts/wholefoods.jpg','wholefoods.jpg','image/jpeg',$3,'matched',
        'Whole Foods Market','2026-05-03',84.21,'unique','auto_accepted','devsha_wholefoods')
     ON CONFLICT (id) DO UPDATE SET total_amount=EXCLUDED.total_amount`,
    ['dev_rcpt_groc', USER, JSON.stringify({ merchant: 'Whole Foods Market', total: 84.21, date: '2026-05-03', items: [
      { desc: 'Bananas', amount: 2.99 }, { desc: 'Almond Milk', amount: 4.49 }, { desc: 'Groceries', amount: 76.73 } ] })]
  );
  const items = [['Bananas', 2.99], ['Almond Milk', 4.49], ['Groceries', 76.73]];
  await query(`DELETE FROM receipt_items WHERE receipt_id='dev_rcpt_groc'`);
  for (let i = 0; i < items.length; i++) {
    await query(
      `INSERT INTO receipt_items (id,receipt_id,item_name,total_price) VALUES ($1,'dev_rcpt_groc',$2,$3)`,
      [`dev_ritem_${i}`, items[i][0], items[i][1]]
    );
  }
  await query(
    `INSERT INTO receipt_duplicate_checks (id,user_id,new_receipt_id,duplicate_score,duplicate_reason,final_decision)
     VALUES ('dev_dupchk_1',$1,'dev_rcpt_groc',0.0,'no prior match','unique')
     ON CONFLICT (id) DO NOTHING`,
    [USER]
  );

  // ── Mortgage domain: account → statement → payment → escrow ─────────────────
  await query(
    `INSERT INTO mortgage_accounts (id,user_id,account_id,property_id,servicer,loan_number_mask,interest_rate,current_principal,escrow_balance,monthly_payment,next_due_date)
     VALUES ($1,$2,$3,'haas','Rocket Mortgage','9988',6.25,312500.00,4200.50,2450.00,'2026-06-15')
     ON CONFLICT (id) DO UPDATE SET current_principal=EXCLUDED.current_principal, monthly_payment=EXCLUDED.monthly_payment`,
    [MORT, USER, ACCT_MTG]
  );
  await query(
    `INSERT INTO mortgage_statements (id,user_id,mortgage_account_id,statement_date,due_date,amount_due,principal_balance,escrow_balance,parser_status,parser_confidence)
     VALUES ('dev_mstmt_202605',$1,$2,'2026-05-01','2026-05-15',2450.00,312500.00,4200.50,'parsed',1.0)
     ON CONFLICT (id) DO UPDATE SET amount_due=EXCLUDED.amount_due`,
    [USER, MORT]
  );
  await query(
    `INSERT INTO mortgage_payments (id,user_id,mortgage_account_id,mortgage_statement_id,payment_date,total_paid,principal_portion,interest_portion,escrow_portion,matched_transaction_id)
     VALUES ('dev_mpay_202605',$1,$2,'dev_mstmt_202605','2026-05-15',2450.00,850.25,1300.75,299.00,'dev_txn_mtg')
     ON CONFLICT (id) DO UPDATE SET total_paid=EXCLUDED.total_paid`,
    [USER, MORT]
  );
  await query(`DELETE FROM mortgage_escrow_transactions WHERE mortgage_statement_id='dev_mstmt_202605'`);
  const escrow = [['tax', 'County Property Tax', 199.00], ['insurance', 'Homeowners Insurance', 100.00]];
  for (let i = 0; i < escrow.length; i++) {
    await query(
      `INSERT INTO mortgage_escrow_transactions (id,user_id,mortgage_account_id,mortgage_statement_id,date,type,description,amount)
       VALUES ($1,$2,$3,'dev_mstmt_202605','2026-05-15',$4,$5,$6)`,
      [`dev_mesc_${i}`, USER, MORT, escrow[i][0], escrow[i][1], escrow[i][2]]
    );
  }

  console.log('✓ Seed complete.');
  console.log('   Login:  dev / dev1234');
  console.log(`   Data:   ${txns.length} transactions, 2 accounts, 1 receipt (+items), 1 mortgage (statement/payment/escrow)`);
  await getPool().end();
}

main().catch(e => { console.error('✗ seed-dev failed:', e.message); process.exit(1); });
