'use strict';
/**
 * ingest.js — Document ingestion pipeline
 *
 *   chunk → embed → upsert to Qdrant → register/update row in tax_sources
 *
 * A "document" is one logical source (an IRS publication, an IRC section, a
 * state guidance page). It is split into chunks; each chunk becomes one Qdrant
 * point carrying the full metadata payload so retrieval can filter and cite.
 *
 * Re-ingesting the same logical source (same sourceKey) replaces its old points
 * and updates its tax_sources row — so annual refreshes are clean.
 */

const crypto = require('crypto');
const { chunkText, estimateTokens } = require('./chunker');
const { embedBatch, EMBED_DIM }     = require('./embeddings');
const { ensureCollection, upsertPoints, deleteBySource } = require('./vectorStore');
const { query } = require('../db');

/**
 * @typedef {object} TaxDocInput
 * @property {string}  sourceName     "IRS Publication 17 (2024)"
 * @property {string}  documentType   'publication'|'regulation'|'irc'|'notice'|
 *                                     'revenue_ruling'|'form_instructions'|'legislation'|'state_guidance'
 * @property {string}  fullText       the document text
 * @property {string}  [sourceKey]    stable key for re-ingestion (e.g. 'irs-pub-17-2024').
 *                                     If omitted, a random id is used (always new).
 * @property {string}  [url]
 * @property {string}  [jurisdiction='federal']
 * @property {number}  [taxYear]      omit for year-agnostic sources (e.g. an IRC section)
 * @property {string}  [effectiveDate] ISO date
 * @property {string}  [codeSection]  "IRC §280A"
 * @property {string}  [formNumber]   "Schedule E"
 * @property {string[]}[topicTags]
 * @property {boolean} [isCurrentLaw=true]
 */

/**
 * Ingest one document.
 * @param {TaxDocInput} doc
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{sourceId:string, chunkCount:number, tokenEstimate:number, replaced:boolean}>}
 */
async function ingestDocument(doc, onProgress) {
  if (!doc || !doc.fullText || !doc.sourceName || !doc.documentType) {
    throw new Error('ingestDocument requires sourceName, documentType, and fullText');
  }

  const jurisdiction = doc.jurisdiction || 'federal';
  const isCurrent    = doc.isCurrentLaw !== false;

  // Stable source id: derive from sourceKey if provided so re-ingest replaces.
  const sourceId = doc.sourceKey
    ? `src-${sha1(doc.sourceKey).slice(0, 24)}`
    : crypto.randomUUID();

  // 1. Chunk
  const chunks = chunkText(doc.fullText);
  if (!chunks.length) throw new Error('Document produced no chunks');
  const tokenEstimate = chunks.reduce((s, c) => s + estimateTokens(c), 0);

  // 2. Ensure collection exists
  await ensureCollection(EMBED_DIM);

  // 3. If re-ingesting a known source, clear its old points first
  let replaced = false;
  const existing = await query(
    'SELECT id FROM tax_sources WHERE id = $1', [sourceId]
  ).catch(() => ({ rows: [] }));
  if (existing.rows.length) {
    await deleteBySource(sourceId).catch(() => {});
    replaced = true;
  }

  // 4. Embed all chunks
  const vectors = await embedBatch(chunks, onProgress);

  // 5. Build points with full metadata payload
  const qdrantIds = [];
  const points = chunks.map((text, i) => {
    const pointId = crypto.randomUUID();
    qdrantIds.push(pointId);
    return {
      id: pointId,
      vector: vectors[i],
      payload: {
        source_id:      sourceId,
        source_name:    doc.sourceName,
        url:            doc.url || null,
        jurisdiction,
        document_type:  doc.documentType,
        tax_year:       doc.taxYear ?? null,
        code_section:   doc.codeSection || null,
        form_number:    doc.formNumber || null,
        topic_tags:     doc.topicTags || [],
        is_current_law: isCurrent,
        chunk_index:    i,
        text,
      },
    };
  });

  // 6. Upsert to Qdrant
  await upsertPoints(points);

  // 7. Register/update tax_sources row
  await query(
    `INSERT INTO tax_sources
       (id, source_name, url, jurisdiction, document_type, tax_year,
        effective_date, code_section, form_number, topic_tags,
        is_current_law, qdrant_ids, chunk_count, last_fetched, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       source_name=$2, url=$3, jurisdiction=$4, document_type=$5, tax_year=$6,
       effective_date=$7, code_section=$8, form_number=$9, topic_tags=$10,
       is_current_law=$11, qdrant_ids=$12, chunk_count=$13,
       last_fetched=NOW(), updated_at=NOW()`,
    [
      sourceId, doc.sourceName, doc.url || null, jurisdiction,
      doc.documentType, doc.taxYear ?? null, doc.effectiveDate || null,
      doc.codeSection || null, doc.formNumber || null, doc.topicTags || [],
      isCurrent, qdrantIds, chunks.length,
    ]
  );

  return { sourceId, chunkCount: chunks.length, tokenEstimate, replaced };
}

/**
 * Mark a source as superseded (no longer current law). It stays in the store
 * for audit/history but is filtered out of retrieval.
 * @param {string} sourceId
 * @param {string} [supersededBy] id of the replacement source
 */
async function supersedeSource(sourceId, supersededBy = null) {
  await query(
    'UPDATE tax_sources SET is_current_law = FALSE, superseded_by = $2, updated_at = NOW() WHERE id = $1',
    [sourceId, supersededBy]
  );
  // Flip the flag on the vector payloads too, so the retrieval filter excludes them.
  // (Qdrant set-payload by filter.)
  const { qdrant, COLLECTION } = require('./vectorStore');
  await qdrant(`/collections/${COLLECTION}/points/payload?wait=true`, 'POST', {
    payload: { is_current_law: false },
    filter:  { must: [{ key: 'source_id', match: { value: sourceId } }] },
  }).catch(() => {});
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

module.exports = { ingestDocument, supersedeSource };
