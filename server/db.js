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
  console.log('✓ Database connected and schema ready');
}

module.exports = { query, initSchema };
