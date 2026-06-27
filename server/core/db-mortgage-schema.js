'use strict';
// db-mortgage-schema.js — the mortgage domain the remodel was missing. Until now a
// mortgage was only an `accounts` row (account_class='loan') + statement PDFs filed in the
// vault with NO parsed detail. These tables give mortgages first-class structure: the loan
// account, each statement, the payment breakdown (principal/interest/escrow), and escrow
// activity — so principal paydown, escrow changes, and payment matching are queryable.
//
// All CREATE/ALTER/INDEX use IF NOT EXISTS — safe on every boot. Called from db.js
// initSchema() AFTER accounts/documents/bank_account_periods exist (it references them).
//
// `mortgage_payments.matched_transaction_id` is a SOFT ref to transactions(id) — same
// rationale as matched_transaction_sources: the display layer is rebuilt from JSON, so a
// hard FK would churn. It points at the Plaid bank debit that paid the mortgage.
module.exports.init = async (query) => {
  // ── mortgage_accounts — one row per loan (optionally linked to an accounts row) ──
  await query(`
    CREATE TABLE IF NOT EXISTS mortgage_accounts (
      id                 TEXT        PRIMARY KEY,
      user_id            TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id         TEXT        REFERENCES accounts(id) ON DELETE SET NULL,   -- the generalized loan account
      property_id        TEXT,                                  -- haas|kobe|bayhill|muirfield|alcita|…
      servicer           TEXT,                                  -- Rocket|Chase|Wells|BoA|Mr Cooper
      loan_number_mask   TEXT,                                  -- last 4 only
      original_principal DECIMAL(14,2),
      interest_rate      DECIMAL(6,4),
      current_principal  DECIMAL(14,2),
      escrow_balance     DECIMAL(14,2),
      monthly_payment    DECIMAL(12,2),
      next_due_date      DATE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mortgage_accts_user ON mortgage_accounts(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mortgage_accts_acct ON mortgage_accounts(account_id)`);

  // ── mortgage_statements — one parsed statement (PDF bytes stay in documents/R2) ──
  await query(`
    CREATE TABLE IF NOT EXISTS mortgage_statements (
      id                     TEXT        PRIMARY KEY,
      user_id                TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mortgage_account_id    TEXT        REFERENCES mortgage_accounts(id) ON DELETE CASCADE,
      document_id            TEXT        REFERENCES documents(id) ON DELETE SET NULL,
      bank_account_period_id TEXT        REFERENCES bank_account_periods(id) ON DELETE SET NULL,
      statement_date         DATE,
      due_date               DATE,
      amount_due             DECIMAL(12,2),
      principal_balance      DECIMAL(14,2),
      escrow_balance         DECIMAL(14,2),
      parser_status          TEXT,                              -- parsed|partial|failed
      parser_confidence      DECIMAL(5,4),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mortgage_stmts_user ON mortgage_statements(user_id, mortgage_account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mortgage_stmts_doc  ON mortgage_statements(document_id)`);

  // ── mortgage_payments — the principal/interest/escrow split for one statement ────
  await query(`
    CREATE TABLE IF NOT EXISTS mortgage_payments (
      id                     TEXT        PRIMARY KEY,
      user_id                TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mortgage_account_id    TEXT        REFERENCES mortgage_accounts(id) ON DELETE CASCADE,
      mortgage_statement_id  TEXT        REFERENCES mortgage_statements(id) ON DELETE SET NULL,
      payment_date           DATE,
      total_paid             DECIMAL(12,2),
      principal_portion      DECIMAL(12,2),
      interest_portion       DECIMAL(12,2),
      escrow_portion         DECIMAL(12,2),
      matched_transaction_id TEXT,                              -- transactions.id (soft ref) — the bank debit
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mortgage_pmts_user  ON mortgage_payments(user_id, mortgage_account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mortgage_pmts_match ON mortgage_payments(matched_transaction_id)`);

  // ── mortgage_escrow_transactions — escrow account activity (tax/insurance/…) ─────
  await query(`
    CREATE TABLE IF NOT EXISTS mortgage_escrow_transactions (
      id                    TEXT        PRIMARY KEY,
      user_id               TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mortgage_account_id   TEXT        REFERENCES mortgage_accounts(id) ON DELETE CASCADE,
      mortgage_statement_id TEXT        REFERENCES mortgage_statements(id) ON DELETE SET NULL,
      date                  DATE,
      type                  TEXT,                               -- tax|insurance|shortage|disbursement|deposit
      description           TEXT,
      amount                DECIMAL(12,2),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mortgage_escrow_user ON mortgage_escrow_transactions(user_id, mortgage_account_id)`);

  console.log('✓ Mortgage schema ready (mortgage_accounts, mortgage_statements, mortgage_payments, mortgage_escrow_transactions)');
};
