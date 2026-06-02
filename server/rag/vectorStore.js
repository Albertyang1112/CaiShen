'use strict';
/**
 * vectorStore.js — Qdrant vector database wrapper (raw REST, no SDK)
 *
 * Stores embedded chunks of tax-law documents. The metadata payload mirrors
 * the tax_sources table so retrieval can filter by tax year, jurisdiction,
 * and current-law status.
 *
 * Config (env):
 *   QDRANT_URL         default http://localhost:6333
 *   QDRANT_API_KEY     optional (Qdrant Cloud)
 *   QDRANT_COLLECTION  default tax_sources
 *
 * Setup (local):
 *   docker run -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant
 *   (or use the docker-compose.yml in this folder)
 */

const QDRANT_URL  = process.env.QDRANT_URL        || 'http://localhost:6333';
const COLLECTION  = process.env.QDRANT_COLLECTION || 'tax_sources';
const API_KEY     = process.env.QDRANT_API_KEY    || null;

/** Low-level Qdrant REST call. */
async function qdrant(path, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['api-key'] = API_KEY;
  const resp = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Qdrant ${method} ${path} → HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * Create the collection (idempotent) and the payload indexes used for filtering.
 * @param {number} dim  embedding dimension (must match the embed model)
 */
async function ensureCollection(dim) {
  // Does the collection already exist?
  try {
    await qdrant(`/collections/${COLLECTION}`);
    return false; // already existed
  } catch (_) { /* fall through to create */ }

  await qdrant(`/collections/${COLLECTION}`, 'PUT', {
    vectors: { size: dim, distance: 'Cosine' },
  });

  // Payload indexes — required for efficient filtering in Qdrant.
  const indexes = [
    { field_name: 'tax_year',       field_schema: 'integer' },
    { field_name: 'jurisdiction',   field_schema: 'keyword' },
    { field_name: 'document_type',  field_schema: 'keyword' },
    { field_name: 'is_current_law', field_schema: 'bool'    },
    { field_name: 'source_id',      field_schema: 'keyword' },
  ];
  for (const idx of indexes) {
    await qdrant(`/collections/${COLLECTION}/index?wait=true`, 'PUT', idx).catch(() => {});
  }
  return true; // created
}

/**
 * Upsert points. Each point: { id, vector, payload }.
 * @param {Array<{id:string,vector:number[],payload:object}>} points
 */
async function upsertPoints(points) {
  if (!points.length) return { status: 'ok' };
  return qdrant(`/collections/${COLLECTION}/points?wait=true`, 'PUT', { points });
}

/**
 * Vector search with optional metadata filter.
 * @param {number[]} vector
 * @param {object|null} filter  Qdrant filter object
 * @param {number} limit
 */
async function search(vector, filter, limit = 8) {
  const body = { vector, limit, with_payload: true };
  if (filter) body.filter = filter;
  const res = await qdrant(`/collections/${COLLECTION}/points/search`, 'POST', body);
  return res.result || [];
}

/** Delete all points belonging to a source document (for re-ingestion / supersede). */
async function deleteBySource(sourceId) {
  return qdrant(`/collections/${COLLECTION}/points/delete?wait=true`, 'POST', {
    filter: { must: [{ key: 'source_id', match: { value: sourceId } }] },
  });
}

/** Health check — true if Qdrant is reachable. */
async function isAvailable() {
  try {
    const resp = await fetch(`${QDRANT_URL}/healthz`);
    if (resp.ok) return true;
    // Older Qdrant builds: /healthz may 404; fall back to root
    const root = await fetch(`${QDRANT_URL}/`);
    return root.ok;
  } catch (_) {
    return false;
  }
}

/** Count points + collection status, for the status endpoint. */
async function stats() {
  try {
    const info = await qdrant(`/collections/${COLLECTION}`);
    return {
      exists: true,
      pointsCount: info.result?.points_count ?? 0,
      vectorsCount: info.result?.vectors_count ?? null,
      status: info.result?.status ?? 'unknown',
    };
  } catch (_) {
    return { exists: false, pointsCount: 0 };
  }
}

module.exports = {
  qdrant, ensureCollection, upsertPoints, search,
  deleteBySource, isAvailable, stats, COLLECTION, QDRANT_URL,
};
