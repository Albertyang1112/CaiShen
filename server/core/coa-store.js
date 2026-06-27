'use strict';
/**
 * core/coa-store.js — write-through mirror of chart_of_accounts.json into the relational
 * chart_of_accounts table. The JSON stays the SOURCE OF TRUTH (accounting/index.js loadChart
 * reads it from the cache/user_kv); this keeps a queryable table current so the COA tree can
 * be joined relationally and categorization_memory.coa_id has real rows to point at.
 *
 * Non-destructive (upsert + delete only the ids no longer present) and atomic, exactly like
 * banking-store's accounts/transactions mirror. Called from core/store.js on every COA write.
 */
const { query, withTransaction } = require('./db');

// Flat COA array → mirror rows. The stored chart is already a flat list of nodes with
// parentId; we just project the queryable columns and keep the whole node in `data`.
function flattenChart(list) {
  return (Array.isArray(list) ? list : [])
    .filter(n => n && n.id)
    .map(n => ({ id: n.id, parentId: n.parentId || null, name: n.name || null, type: n.type || null, scope: n.scope || null, node: n }));
}

async function mirrorChartOfAccounts(userId, list) {
  const rows = flattenChart(list);
  const ids  = rows.map(r => r.id);
  await withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO chart_of_accounts (user_id,id,parent_id,name,type,scope,data,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (user_id,id) DO UPDATE SET
           parent_id=EXCLUDED.parent_id, name=EXCLUDED.name, type=EXCLUDED.type,
           scope=EXCLUDED.scope, data=EXCLUDED.data, updated_at=NOW()`,
        [userId, r.id, r.parentId, r.name, r.type, r.scope, JSON.stringify(r.node)]
      );
    }
    await client.query(`DELETE FROM chart_of_accounts WHERE user_id = $1 AND NOT (id = ANY($2::text[]))`, [userId, ids]);
  });
  return rows.length;
}

module.exports = { mirrorChartOfAccounts, flattenChart };
