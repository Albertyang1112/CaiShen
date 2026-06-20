'use strict';
// db-receipts-schema.js — receipt duplicate-detection schema. Adds decision/tracking +
// dedup-signal columns to `receipts`, and an auditable `receipt_duplicate_checks` log.
// Additive (IF NOT EXISTS), safe on every boot. Runs AFTER receipts exists (banking+remodel).
module.exports.init = async (query) => {
  const cols = [
    'duplicate_status          TEXT',   // unique|possible_duplicate|hard_duplicate|confirmed_duplicate|confirmed_separate|needs_review
    'duplicate_of_receipt_id   TEXT',
    'duplicate_confidence      DECIMAL(5,4)',
    'duplicate_reason          TEXT',
    'user_duplicate_response   TEXT',
    'user_separate_explanation TEXT',
    'review_status             TEXT',   // auto_accepted|user_confirmed|needs_review|rejected_duplicate
    'file_sha256               TEXT',   // exact-file dedup
    'perceptual_hash           TEXT',   // near-image dedup (aHash)
    'ocr_text_hash             TEXT',   // exact-content dedup
  ];
  for (const c of cols) await query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ${c}`);
  await query(`CREATE INDEX IF NOT EXISTS idx_receipts_dupe ON receipts(user_id, duplicate_status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_receipts_sha  ON receipts(user_id, file_sha256)`);

  // Auditable record of every duplicate check: why we flagged it, what the user said, the outcome.
  await query(`
    CREATE TABLE IF NOT EXISTS receipt_duplicate_checks (
      id                            TEXT        PRIMARY KEY,
      user_id                       TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bank_account_id               TEXT,
      bank_account_period_id        TEXT,
      new_file_id                   TEXT,
      new_receipt_id                TEXT,
      possible_duplicate_receipt_id TEXT,
      duplicate_score               DECIMAL(5,4),
      duplicate_reason              TEXT,
      duplicate_signals_json        JSONB,
      bot_message                   TEXT,
      user_response                 TEXT,
      user_separate_explanation     TEXT,
      final_decision                TEXT,       -- hard_duplicate|confirmed_duplicate|confirmed_separate|needs_review
      created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_dupchecks_user ON receipt_duplicate_checks(user_id, created_at DESC)`);
  console.log('✓ Receipt dedup schema ready (receipts dup columns, receipt_duplicate_checks)');
};
