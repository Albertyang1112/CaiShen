// db-accounts-schema.js — Neon tables for the "all data in the database" model:
// Plaid connections (encrypted tokens), accounts (generalized: bank/card/loan/
// investment/crypto/property), and document metadata (bytes live in object storage).
//
// All CREATE ... IF NOT EXISTS + ALTER ... IF NOT EXISTS — safe to run on every boot;
// never alters/drops existing data. Called from db.js initSchema() after the banking
// schema, so users/plaid_items exist before accounts/documents reference them.
module.exports.init = async (query) => {
  // ── users: add phone (rest of the User table already exists) ────────────────
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);

  // ── plaid_items: one row per linked institution. Holds the sensitive token. ──
  // access_token_enc is AES-256-GCM ciphertext (see core/secret.js) — NEVER plaintext.
  await query(`
    CREATE TABLE IF NOT EXISTS plaid_items (
      id                TEXT        PRIMARY KEY,
      user_id           TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id           TEXT        UNIQUE NOT NULL,
      access_token_enc  BYTEA       NOT NULL,
      institution_id    TEXT,
      institution_name  TEXT,
      status            TEXT        NOT NULL DEFAULT 'active',   -- active | login_required | revoked
      connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sync_at      TIMESTAMPTZ
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_plaid_items_user ON plaid_items(user_id)`);

  // ── accounts: the generalized "Bank" table. account_class is the discriminator ──
  // that says what kind of account it is (bank vs mortgage vs crypto vs equity).
  // Plaid accounts link to a plaid_item; manual/crypto accounts have plaid_item_id NULL.
  await query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                TEXT        PRIMARY KEY,                  -- Plaid account_id, or generated
      user_id           TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plaid_item_id     TEXT        REFERENCES plaid_items(id) ON DELETE CASCADE,
      source            TEXT        NOT NULL,                     -- plaid | manual | crypto
      account_class     TEXT        NOT NULL,                     -- bank|card|loan|investment|crypto|property
      plaid_type        TEXT,                                     -- depository|credit|loan|investment
      plaid_subtype     TEXT,                                     -- checking|savings|mortgage|401k|...
      name              TEXT,
      official_name     TEXT,
      mask              TEXT,                                     -- last 4 ONLY (no full PAN/CVV/expiry)
      holder_name       TEXT,                                     -- from Plaid Identity
      current_balance   DECIMAL(14,2),
      available_balance DECIMAL(14,2),
      currency          TEXT        DEFAULT 'USD',
      details           JSONB       NOT NULL DEFAULT '{}',        -- type-specific long tail
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id, account_class)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_accounts_item ON accounts(plaid_item_id)`);

  // ── documents: metadata only. The PDF/image bytes live in object storage (R2); ──
  // storage_key + storage_bucket point to them. sha256 enables re-upload de-dup.
  await query(`
    CREATE TABLE IF NOT EXISTS documents (
      id             TEXT        PRIMARY KEY,
      user_id        TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id     TEXT        REFERENCES accounts(id) ON DELETE SET NULL,
      doc_type       TEXT        NOT NULL,                        -- statement|tax_form|mortgage|receipt|other
      storage_key    TEXT        NOT NULL,
      storage_bucket TEXT        NOT NULL,
      original_name  TEXT,
      mime_type      TEXT,
      size_bytes     BIGINT,
      sha256         TEXT,
      period_year    INTEGER,
      period_month   INTEGER,
      tags           JSONB       NOT NULL DEFAULT '{}',
      ocr_data       JSONB,
      uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_documents_user    ON documents(user_id, doc_type)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_documents_account ON documents(account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_documents_sha     ON documents(user_id, sha256)`);

  // ── user_kv: generic per-user store for the long-tail JSON/CSV "files" that ──
  // don't warrant their own structured table (chart_of_accounts, properties,
  // wallets, settings, insights, staged CSVs, …). The DB-backed data layer
  // (core/store.js) reads/writes this; accounts + transactions get real tables.
  await query(`
    CREATE TABLE IF NOT EXISTS user_kv (
      user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_key    TEXT        NOT NULL,         -- 'transactions.json' | 'properties.json' | 'plaid_transactions.csv' | ...
      data       JSONB,                        -- populated for .json keys
      text_data  TEXT,                         -- populated for .csv / raw-text keys
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, doc_key)
    )
  `);

  console.log('✓ Accounts/documents schema ready (plaid_items, accounts, documents, user_kv; users.phone)');
};
