// db-remodel-schema.js — "Database Remodel Roadmap" structural tables (staged).
//
// Goal of the remodel: make the database (not CSV files) the source of truth for
// bank accounts, statement cycles, statements, receipts, multi-source transaction
// evidence, and the final displayed transactions. Much of that already exists in
// this codebase under different names:
//
//   roadmap "bank_accounts"  → existing `accounts`        (db-accounts-schema.js)
//   roadmap "files"          → existing `documents`       (db-accounts-schema.js, bytes in R2)
//   roadmap "source_transactions" → existing `source_transactions` (db-banking-schema.js)
//   roadmap "matched_transactions"→ existing `transactions` table (the live display layer)
//   roadmap "receipts"       → existing `receipts`        (db-banking-schema.js)
//
// This file adds ONLY the genuinely-missing structure and extends what's too thin,
// WITHOUT inverting the live data path (the frontend keeps reading `transactions`).
// New tables/columns this run:
//   1. bank_account_periods         — one statement cycle/month per account (container)
//   2. bank_statements              — a typed statement record (promoted out of `documents`)
//   3. receipt_items                — line-item detail under a receipt
//   4. matched_transaction_sources  — evidence links: a displayed txn ← its source rows
//   5. source_transactions (+cols)  — make it the true universal intake + dedup keys
//
// All CREATE/ALTER/INDEX use IF NOT EXISTS — safe to run on every boot; never alters
// or drops existing data. Called from db.js initSchema() AFTER db-banking-schema and
// db-accounts-schema, so accounts/documents/source_transactions/receipts already exist.
//
// IMPORTANT — the `transactions` table is FULL-REPLACED on every Plaid sync
// (banking-store.mirrorTransactions does DELETE+re-INSERT). So nothing here may carry
// a hard FK to transactions(id): a cascade would wipe links on each sync. We reference
// the displayed transaction by a plain TEXT id, exactly as statement_matches already
// does with plaid_txn_id.
module.exports.init = async (query) => {
  // ── 1. bank_account_periods — the per-account statement cycle / month ─────────
  // The parent/container for one period of financial activity. Files, statements,
  // receipts, and source transactions all hang off a period. account_id → accounts.
  await query(`
    CREATE TABLE IF NOT EXISTS bank_account_periods (
      id              TEXT        PRIMARY KEY,
      user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id      TEXT        REFERENCES accounts(id) ON DELETE CASCADE,
      start_date      DATE,
      end_date        DATE,
      label           TEXT,                                 -- "May 15 - June 15, 2026"
      opening_balance DECIMAL(14,2),
      closing_balance DECIMAL(14,2),
      status          TEXT        NOT NULL DEFAULT 'open',  -- open|processing|needs_review|reconciled|finalized
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_periods_user ON bank_account_periods(user_id, account_id, start_date)`);
  // Natural key for find-or-create dedup: one cycle = one (account, start, end).
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_periods_cycle
               ON bank_account_periods(user_id, account_id, start_date, end_date)`);

  // ── 2. bank_statements — a typed statement record (promoted from `documents`) ──
  // The PDF bytes stay in documents/R2; document_id points to that file row. One
  // period may have several statements (corrected/duplicate uploads), so no unique.
  await query(`
    CREATE TABLE IF NOT EXISTS bank_statements (
      id                     TEXT        PRIMARY KEY,
      user_id                TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id             TEXT        REFERENCES accounts(id) ON DELETE SET NULL,
      bank_account_period_id TEXT        REFERENCES bank_account_periods(id) ON DELETE SET NULL,
      document_id            TEXT        REFERENCES documents(id) ON DELETE SET NULL,  -- roadmap "file_id"
      statement_start_date   DATE,
      statement_end_date     DATE,
      opening_balance        DECIMAL(14,2),
      closing_balance        DECIMAL(14,2),
      parser_status          TEXT,                          -- pending|parsed|failed|migrated
      parser_confidence      DECIMAL(5,4),
      parsed_at              TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_bank_stmts_user   ON bank_statements(user_id, account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bank_stmts_period ON bank_statements(bank_account_period_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bank_stmts_doc    ON bank_statements(document_id)`);

  // ── 3. receipt_items — optional line-item detail under one receipt ────────────
  await query(`
    CREATE TABLE IF NOT EXISTS receipt_items (
      id          TEXT        PRIMARY KEY,
      receipt_id  TEXT        NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      item_name   TEXT,
      quantity    DECIMAL(12,3),
      unit_price  DECIMAL(12,2),
      total_price DECIMAL(12,2),
      category    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_receipt_items ON receipt_items(receipt_id)`);

  // ── 4. matched_transaction_sources — evidence links for a displayed txn ───────
  // Connects one final/displayed transaction (transactions.id, stored as plain TEXT —
  // see the full-replace note above) back to the source_transactions rows that
  // support it, with the role each source played. This generalizes statement_matches
  // (which only links statement↔plaid) to cover plaid/statement/receipt/manual.
  await query(`
    CREATE TABLE IF NOT EXISTS matched_transaction_sources (
      id                    TEXT        PRIMARY KEY,
      user_id               TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transaction_id        TEXT        NOT NULL,   -- displayed txn (transactions.id); NOT a FK on purpose
      source_transaction_id TEXT        REFERENCES source_transactions(id) ON DELETE CASCADE,
      source_role           TEXT,                   -- plaid|bank_statement|receipt|manual_csv|manual_entry|legacy_csv
      match_confidence      DECIMAL(5,4),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mts_txn    ON matched_transaction_sources(user_id, transaction_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mts_source ON matched_transaction_sources(source_transaction_id)`);
  // A given source row supports a given displayed txn at most once.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mts_pair
               ON matched_transaction_sources(transaction_id, source_transaction_id)`);

  // ── 5. Extend source_transactions into the true universal intake ──────────────
  // Today it only carries source IN ('plaid','statement'). The remodel routes receipt,
  // manual, and legacy-CSV rows here too (source is free TEXT, so the vocabulary just
  // widens — no enum to alter). Add the container/provenance/dedup columns the roadmap
  // specifies. All ADD COLUMN IF NOT EXISTS — existing rows get NULLs, nothing breaks.
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS account_id              TEXT REFERENCES accounts(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS bank_account_period_id  TEXT REFERENCES bank_account_periods(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS bank_statement_id       TEXT REFERENCES bank_statements(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS receipt_id              TEXT REFERENCES receipts(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS external_transaction_id TEXT`);   // Plaid txn id, etc.
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS posted_date             DATE`);
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS merchant_name           TEXT`);
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS category                TEXT`);
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS source_hash             TEXT`);
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS pfc_detailed            TEXT`);   // Plaid personal_finance_category.detailed (FOOD_AND_DRINK_COFFEE, ...)
  await query(`ALTER TABLE source_transactions ADD COLUMN IF NOT EXISTS payment_channel         TEXT`);   // Plaid payment_channel: online | in store | other

  await query(`CREATE INDEX IF NOT EXISTS idx_source_txns_period   ON source_transactions(user_id, bank_account_period_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_source_txns_extid    ON source_transactions(user_id, external_transaction_id)`);
  // Dedup keys (roadmap Phase 5). Partial uniques: only enforced once the new columns
  // are populated, so existing rows (NULL on both) are unaffected.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_source_txns_extid
               ON source_transactions(user_id, source, external_transaction_id)
               WHERE external_transaction_id IS NOT NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_source_txns_hash
               ON source_transactions(user_id, source_hash)
               WHERE source_hash IS NOT NULL`);

  // ── 6. Extend receipts toward the roadmap's structured shape ──────────────────
  // The existing receipts table is attachment-oriented (txn_id + ocr_data JSONB). The
  // remodel promotes the key OCR fields to real columns and links each receipt to its
  // account + period, so receipts are queryable and bucket into the same period as the
  // transaction they back. (txn_id / ocr_data / match_status stay as-is.)
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS account_id             TEXT REFERENCES accounts(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS bank_account_period_id TEXT REFERENCES bank_account_periods(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS merchant_name          TEXT`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS receipt_date           DATE`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS total_amount           DECIMAL(12,2)`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS tax_amount             DECIMAL(12,2)`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS tip_amount             DECIMAL(12,2)`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_method         TEXT`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS parser_status          TEXT`);
  await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS parser_confidence      DECIMAL(5,4)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_receipts_period ON receipts(bank_account_period_id)`);
  // Standalone receipts: a receipt sent to the bot may arrive before (or without) a matching
  // transaction, so txn_id is now optional — it's filled in when/if we match one.
  await query(`ALTER TABLE receipts ALTER COLUMN txn_id DROP NOT NULL`);

  console.log('✓ Remodel schema ready (bank_account_periods, bank_statements, receipt_items, matched_transaction_sources; source_transactions + receipts extended)');
};
