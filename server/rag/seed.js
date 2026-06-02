'use strict';
/**
 * seed.js — Ingest the starter tax-law corpus into Qdrant + tax_sources.
 *
 * Prerequisites:
 *   1. Qdrant running:   docker compose -f server/rag/docker-compose.yml up -d
 *   2. Ollama + model:   ollama pull nomic-embed-text
 *   3. .env has DATABASE_URL (tax_sources table is created by initSchema)
 *
 * Run:
 *   node server/rag/seed.js
 *
 * Idempotent: each document has a stable sourceKey, so re-running replaces the
 * existing points/row rather than duplicating.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { SEED_DOCUMENTS } = require('./seed-data');
const { ingestDocument } = require('./ingest');
const embeddings  = require('./embeddings');
const vectorStore = require('./vectorStore');
const { initSchema } = require('../db');

async function main() {
  console.log('CaiShen — tax-law RAG seed\n');

  // Preflight checks
  const [ollamaUp, qdrantUp] = await Promise.all([
    embeddings.isAvailable(),
    vectorStore.isAvailable(),
  ]);

  if (!ollamaUp) {
    console.error(`✗ Ollama not available at ${embeddings.OLLAMA_URL}`);
    console.error(`  Install Ollama and run:  ollama pull ${embeddings.EMBED_MODEL}`);
    process.exit(1);
  }
  console.log(`✓ Ollama up (${embeddings.EMBED_MODEL})`);

  if (!qdrantUp) {
    console.error(`✗ Qdrant not available at ${vectorStore.QDRANT_URL}`);
    console.error('  Start it:  docker compose -f server/rag/docker-compose.yml up -d');
    process.exit(1);
  }
  console.log(`✓ Qdrant up (collection: ${vectorStore.COLLECTION})`);

  // Ensure tax_sources table exists
  try { await initSchema(); }
  catch (e) { console.error('✗ DB schema init failed:', e.message); process.exit(1); }

  console.log(`\nIngesting ${SEED_DOCUMENTS.length} documents...\n`);

  let totalChunks = 0;
  for (const doc of SEED_DOCUMENTS) {
    process.stdout.write(`  • ${doc.sourceName} ... `);
    try {
      const r = await ingestDocument(doc);
      totalChunks += r.chunkCount;
      console.log(`${r.chunkCount} chunk(s)${r.replaced ? ' (replaced)' : ''}`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  const stats = await vectorStore.stats();
  console.log(`\n✓ Done. ${totalChunks} chunks ingested. Collection now holds ${stats.pointsCount} points.`);
  process.exit(0);
}

main().catch(e => { console.error('Seed failed:', e); process.exit(1); });
