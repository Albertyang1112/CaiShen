const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL not set in .env — create a free Supabase project and paste the connection string');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', err => console.error('[DB] Pool error:', err.message));
  }
  return pool;
}

async function query(sql, params = []) {
  const client = await getPool().connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function initSchema() {
  // ── Core auth ──────────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT        PRIMARY KEY,
      username        TEXT        UNIQUE NOT NULL,
      email           TEXT        UNIQUE,
      password_hash   TEXT        NOT NULL,
      role            TEXT        NOT NULL DEFAULT 'viewer',
      display_name    TEXT,
      trusted_devices JSONB       NOT NULL DEFAULT '[]',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Tax: saved calculation results ─────────────────────────────────────────
  // Every time the deterministic engine runs a full calculation, we optionally
  // save it here so the AI advisor and the user can refer back to it.
  await query(`
    CREATE TABLE IF NOT EXISTS tax_calculations (
      id              TEXT        PRIMARY KEY,
      user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tax_year        INTEGER     NOT NULL,
      filing_status   TEXT        NOT NULL,
      label           TEXT,                         -- user-assigned name, e.g. "2024 Final"
      source          TEXT        DEFAULT 'manual', -- 'manual'|'advisor'|'api'

      -- Cached top-level numbers for quick queries without parsing the full result
      agi             INTEGER,
      total_liability INTEGER,
      balance_due     INTEGER,     -- positive = owe, negative = refund
      effective_rate  REAL,
      marginal_rate   REAL,

      -- Full snapshots for audit trail and AI explanation
      input_snapshot  JSONB       NOT NULL,  -- TaxInput at time of calculation
      result_snapshot JSONB       NOT NULL,  -- full TaxResult including steps[]

      engine_version  TEXT        NOT NULL DEFAULT '1.0',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_calc_user_year
               ON tax_calculations(user_id, tax_year, created_at DESC)`);

  // ── Tax: per-transaction tax classification ────────────────────────────────
  // Transactions pulled from Plaid, vault PDFs, or scrapers get normalized here
  // with a tax category, schedule, and deductibility so the engine can use them.
  await query(`
    CREATE TABLE IF NOT EXISTS tax_transactions (
      id                TEXT         PRIMARY KEY,
      user_id           TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tax_year          INTEGER      NOT NULL,

      -- Source tracing: every number can be followed back to its origin
      source_id         TEXT,        -- original transaction ID (Plaid tx_id, vault file id, etc.)
      source_type       TEXT,        -- 'plaid'|'vault_pdf'|'amazon'|'bofa'|'chase'|'manual'
      source_account    TEXT,        -- "Chase (...9092)", "Amazon Order History"

      -- The transaction
      date              DATE,
      amount            DECIMAL(12,2) NOT NULL,
      description       TEXT,

      -- Tax classification
      tax_category      TEXT,        -- see TAX_CATEGORIES in tax-history.js
      deductibility_pct DECIMAL(5,4) DEFAULT 1.0,   -- 0=none, 0.5=half, 1=full
      business_use_pct  DECIMAL(5,4) DEFAULT 1.0,   -- for mixed personal/business items
      schedule          TEXT,        -- 'A'|'B'|'C'|'D'|'E'|'SE'|null
      form_line         TEXT,        -- e.g. "Schedule C, Line 28"

      -- Classification provenance
      normalized_by     TEXT         DEFAULT 'user', -- 'rule'|'ai'|'user'
      ai_confidence     DECIMAL(5,4),
      user_verified     BOOLEAN      DEFAULT FALSE,
      notes             TEXT,
      raw_data          JSONB,       -- original source record for full traceability

      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_txns_user_year
               ON tax_transactions(user_id, tax_year)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_txns_category
               ON tax_transactions(user_id, tax_year, tax_category)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_txns_source
               ON tax_transactions(source_type, source_id)`);

  // ── Tax: AI advisor session log ────────────────────────────────────────────
  // Full audit trail for every AI tax advisor turn. Required because users may
  // rely on this advice; must be able to show exactly what sources were used,
  // what data was considered, and what the model said.
  await query(`
    CREATE TABLE IF NOT EXISTS ai_tax_sessions (
      id                   TEXT        PRIMARY KEY,
      user_id              TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tax_year             INTEGER,
      filing_status        TEXT,

      -- The question and conversation context
      user_question        TEXT        NOT NULL,
      conversation_history JSONB,      -- prior [{role, content}] messages this session

      -- What the AI used to answer
      model_used           TEXT,       -- 'groq/llama-3.3-70b'|'claude-sonnet-3-5'|etc.
      retrieved_source_ids JSONB,      -- array of tax_sources.id used
      retrieved_excerpts   JSONB,      -- [{sourceId, text, relevanceScore}] for audit
      calculation_id       TEXT        REFERENCES tax_calculations(id) ON DELETE SET NULL,
      user_data_snapshot   JSONB,      -- subset of financial data sent to model (no secrets)

      -- The answer
      final_answer         TEXT,
      citations            JSONB,      -- [{source, section, quote}] cited in answer
      assumptions          JSONB,      -- assumptions the model stated

      -- Safety & guardrails
      risk_flags           JSONB,      -- ['audit','multi_state','crypto','large_gains',...]
      validation_passed    BOOLEAN,
      validation_details   JSONB,      -- {hasCitations, numbersFromEngine, correctYear, ...}
      disclaimer_shown     BOOLEAN     DEFAULT FALSE,
      escalated            BOOLEAN     DEFAULT FALSE,
      escalation_reason    TEXT,

      -- Performance
      tokens_used          INTEGER,
      latency_ms           INTEGER,

      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ai_sessions_user
               ON ai_tax_sessions(user_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ai_sessions_year
               ON ai_tax_sessions(user_id, tax_year)`);

  // ── Tax: RAG source document registry ─────────────────────────────────────
  // Metadata for every document in the tax law vector database (Qdrant).
  // The actual text + embeddings live in Qdrant; this table stores the metadata
  // and current/superseded status so we can filter by tax year + jurisdiction.
  await query(`
    CREATE TABLE IF NOT EXISTS tax_sources (
      id              TEXT        PRIMARY KEY,
      source_name     TEXT        NOT NULL,   -- "IRS Publication 17 (2024)"
      url             TEXT,
      jurisdiction    TEXT        NOT NULL,   -- 'federal'|'CA'|'NY'|...
      document_type   TEXT        NOT NULL,   -- 'publication'|'regulation'|'irc'|
                                              -- 'notice'|'revenue_ruling'|
                                              -- 'form_instructions'|'legislation'
      tax_year        INTEGER,                -- NULL = not year-specific (e.g. IRC section)
      effective_date  DATE,
      expiration_date DATE,
      superseded_by   TEXT        REFERENCES tax_sources(id),
      topic_tags      TEXT[],                 -- ['rental','depreciation','schedule_e']
      code_section    TEXT,                   -- "IRC §280A"
      form_number     TEXT,                   -- "Schedule E"
      is_current_law  BOOLEAN     NOT NULL DEFAULT TRUE,
      qdrant_ids      TEXT[],                 -- vector chunk IDs in Qdrant
      chunk_count     INTEGER     DEFAULT 0,
      last_fetched    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_sources_year_active
               ON tax_sources(tax_year, is_current_law)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_sources_type
               ON tax_sources(document_type, jurisdiction)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tax_sources_tags
               ON tax_sources USING GIN(topic_tags)`);

  console.log('✓ Database connected and schema ready');
}

module.exports = { query, initSchema };
