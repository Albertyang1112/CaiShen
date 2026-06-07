// db-banking-schema.js — additive Neon tables for the transaction notification,
// AI categorization, reconciliation, and Telegram features (Phase 0).
// All CREATE ... IF NOT EXISTS — safe to run on every boot; never alters/drops
// existing tables. Called from db.js initSchema() after the users table exists.
module.exports.init = async (query) => {
  // Raw multi-source transaction ledger (audit store): every row from every
  // source CSV (Plaid pulls + per-year statement parses), per user.
  await query(`
    CREATE TABLE IF NOT EXISTS source_transactions (
      id           TEXT        PRIMARY KEY,
      user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source       TEXT        NOT NULL,            -- 'plaid' | 'statement'
      source_file  TEXT,                            -- 'plaid_transactions.csv' | 'chase-2026.csv'
      period_year  INTEGER,
      account      TEXT,
      txn_date     DATE,
      description  TEXT,
      amount       DECIMAL(12,2),
      raw          JSONB,
      ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_source_txns_user  ON source_transactions(user_id, source, period_year)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_source_txns_match ON source_transactions(user_id, txn_date, amount)`);

  // Learned categorization memory: keyed by account + merchant so the model
  // learns per-account patterns (food on Haas vs food on personal checking).
  await query(`
    CREATE TABLE IF NOT EXISTS categorization_memory (
      id               TEXT         PRIMARY KEY,
      user_id          TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account          TEXT,
      merchant_pattern TEXT,
      bucket           TEXT,                          -- 'personal' | 'business'
      category         TEXT,
      coa_id           TEXT,
      confidence       DECIMAL(5,4)  NOT NULL DEFAULT 1.0,
      times_confirmed  INTEGER       NOT NULL DEFAULT 1,
      last_used        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_catmem_lookup ON categorization_memory(user_id, account, merchant_pattern)`);

  // Telegram link: binds one chat to one user so only that chat can command the bot.
  await query(`
    CREATE TABLE IF NOT EXISTS telegram_links (
      user_id    TEXT        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_id    TEXT        NOT NULL,
      username   TEXT,
      linked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_tg_chat ON telegram_links(chat_id)`);

  // Outstanding categorization questions awaiting a Telegram reply.
  await query(`
    CREATE TABLE IF NOT EXISTS txn_messages (
      id             TEXT        PRIMARY KEY,
      user_id        TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transaction_id TEXT,
      chat_id        TEXT,
      kind           TEXT,                            -- 'confirm' | 'ask'
      state          TEXT        NOT NULL DEFAULT 'open',  -- 'open' | 'answered' | 'closed'
      payload        JSONB,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_txnmsg_open ON txn_messages(user_id, state)`);

  // Phase 3 — reconciliation match results: one row per (statement txn, plaid txn) pair,
  // or a stmt_only/plaid_only stub when one side has no match.
  await query(`
    CREATE TABLE IF NOT EXISTS statement_matches (
      id               TEXT        PRIMARY KEY,
      user_id          TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stmt_source_id   TEXT,                    -- FK to source_transactions (statement row)
      plaid_txn_id     TEXT,                    -- local Plaid tx id (from transactions.json)
      match_score      DECIMAL(5,4),
      date_delta_days  SMALLINT,
      name_sim         DECIMAL(5,4),
      status           TEXT        NOT NULL,    -- 'matched'|'stmt_only'|'plaid_only'|'conflict'
      flag_reason      TEXT,
      period_year      INTEGER,
      reconciled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_stmtmatch_user   ON statement_matches(user_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_stmtmatch_year   ON statement_matches(user_id, period_year)`);

  // Phase 4 — receipt attachments: one row per file attached to a transaction.
  await query(`
    CREATE TABLE IF NOT EXISTS receipts (
      id            TEXT        PRIMARY KEY,
      user_id       TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      txn_id        TEXT        NOT NULL,               -- local Plaid transaction id
      file_path     TEXT        NOT NULL,               -- absolute path on disk (data/users/{id}/receipts/)
      original_name TEXT,                               -- original uploaded filename
      mime_type     TEXT,                               -- image/jpeg | image/png | application/pdf etc.
      ocr_data      JSONB,                              -- { merchant, total, date, items }
      match_status  TEXT NOT NULL DEFAULT 'unreviewed', -- 'matched'|'partial'|'mismatch'|'unreviewed'
      match_flags   JSONB,                              -- array of flag description strings
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_receipts_txn    ON receipts(user_id, txn_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(user_id, match_status)`);

  console.log('✓ Banking/notification schema ready (source_transactions, categorization_memory, telegram_links, txn_messages, statement_matches, receipts)');
};
