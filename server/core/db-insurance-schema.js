'use strict';
// db-insurance-schema.js — the insurance domain + tax payment schedule. An insurance bill
// used to be just a PDF in the vault; these tables give it first-class structure: the policy
// (optionally linked to a property), each billing statement, and the premium payment — so
// due dates, paid status, and carrier contact info are queryable, and the chatbot can run
// payment reminders off them. tax_payment_schedule holds due dates extracted from tax
// documents (property-tax installments, 1040-ES vouchers, balance due, refunds).
//
// All CREATE/ALTER/INDEX use IF NOT EXISTS — safe on every boot. Called from db.js
// initSchema() AFTER users/documents exist (it references them).
//
// `matched_transaction_id` columns are SOFT refs to transactions(id) — same rationale as
// mortgage_payments: the display layer is rebuilt from JSON, so a hard FK would churn.
module.exports.init = async (query) => {
  // ── insurance_policies — one row per policy (property_id NULL for auto/umbrella) ──
  await query(`
    CREATE TABLE IF NOT EXISTS insurance_policies (
      id                 TEXT        PRIMARY KEY,
      user_id            TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      property_id        TEXT,                                  -- properties.json id (soft ref)
      carrier            TEXT,                                  -- Farmers|State Farm|GeoVera|…
      policy_number      TEXT,                                  -- full (masked to last-4 in UI)
      policy_number_mask TEXT,                                  -- last 4 only
      coverage_type      TEXT,                                  -- homeowners|earthquake|flood|auto|umbrella|…
      premium_amount     DECIMAL(12,2),
      billing_frequency  TEXT,                                  -- annual|semiannual|quarterly|monthly
      period_start       DATE,
      period_end         DATE,
      next_due_date      DATE,
      carrier_phone      TEXT,
      carrier_email      TEXT,
      carrier_website    TEXT,
      carrier_address    TEXT,
      status             TEXT        NOT NULL DEFAULT 'active', -- active|cancelled|expired
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ins_policies_user ON insurance_policies(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ins_policies_prop ON insurance_policies(user_id, property_id)`);
  // The INSURED location as printed on the bill — labels the policy in the UI even before
  // (or without) a property link; property_id stays the structured linkage.
  await query(`ALTER TABLE insurance_policies ADD COLUMN IF NOT EXISTS insured_address TEXT`);

  // ── insurance_statements — one parsed bill (PDF bytes stay in documents/R2) ───────
  await query(`
    CREATE TABLE IF NOT EXISTS insurance_statements (
      id                  TEXT        PRIMARY KEY,
      user_id             TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      insurance_policy_id TEXT        REFERENCES insurance_policies(id) ON DELETE CASCADE,
      document_id         TEXT        REFERENCES documents(id) ON DELETE SET NULL,
      statement_date      DATE,
      due_date            DATE,
      amount_due          DECIMAL(12,2),
      period_start        DATE,
      period_end          DATE,
      parser_status       TEXT,                                 -- parsed|partial|failed
      parser_confidence   DECIMAL(5,4),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ins_stmts_user ON insurance_statements(user_id, insurance_policy_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ins_stmts_doc  ON insurance_statements(document_id)`);

  // ── insurance_payments — paid = matched_transaction_id set (green flag is derived) ─
  await query(`
    CREATE TABLE IF NOT EXISTS insurance_payments (
      id                     TEXT        PRIMARY KEY,
      user_id                TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      insurance_policy_id    TEXT        REFERENCES insurance_policies(id) ON DELETE CASCADE,
      insurance_statement_id TEXT        REFERENCES insurance_statements(id) ON DELETE SET NULL,
      payment_date           DATE,
      amount                 DECIMAL(12,2),
      matched_transaction_id TEXT,                              -- transactions.id (soft ref) — the bank debit
      method                 TEXT,                              -- bank|check|escrow|manual
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ins_pmts_user  ON insurance_payments(user_id, insurance_policy_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ins_pmts_match ON insurance_payments(matched_transaction_id)`);

  // ── tax_payment_schedule — due dates extracted from tax documents ─────────────────
  // One row per installment/voucher; refunds get kind='refund' + status='refund_expected'
  // and are surfaced in the UI but never nagged by the reminder engine.
  await query(`
    CREATE TABLE IF NOT EXISTS tax_payment_schedule (
      id                     TEXT        PRIMARY KEY,
      user_id                TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_document_id     TEXT        REFERENCES documents(id) ON DELETE SET NULL,
      kind                   TEXT,                              -- property_tax|estimated_tax|balance_due|refund
      label                  TEXT,                              -- "1st installment"|"Q3 1040-ES"|…
      authority              TEXT,                              -- IRS|FTB|"LA County Tax Collector"|…
      tax_year               INTEGER,
      due_date               DATE,
      amount                 DECIMAL(12,2),
      status                 TEXT        NOT NULL DEFAULT 'unpaid', -- unpaid|paid|refund_expected|refund_received
      matched_transaction_id TEXT,                              -- transactions.id (soft ref)
      property_id            TEXT,                              -- properties.json id (soft ref, property-tax bills)
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_sched_user ON tax_payment_schedule(user_id, status, due_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_sched_doc  ON tax_payment_schedule(source_document_id)`);

  // ── receipts additive columns — checks ride the receipt pipeline ──────────────────
  // doc_kind distinguishes a proof-of-purchase receipt from a check image; checks match
  // by check_number/payee against the bank feed instead of merchant/±3d.
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS doc_kind     TEXT DEFAULT 'receipt'`); // receipt|check
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS check_number TEXT`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payee        TEXT`);

  console.log('✓ Insurance schema ready (insurance_policies, insurance_statements, insurance_payments, tax_payment_schedule)');
};
