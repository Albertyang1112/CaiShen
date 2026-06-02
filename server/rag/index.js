'use strict';
/**
 * rag/index.js — Express router for tax-law retrieval & ingestion
 *
 * Routes (all under /api/rag):
 *   GET    /status                 service health (Qdrant + Ollama) + corpus stats
 *   POST   /retrieve               { query, taxYear?, jurisdiction?, topK? } → excerpts
 *   GET    /sources                list registered tax-law sources (DB metadata)
 *   POST   /ingest        [admin]  ingest one document
 *   POST   /sources/:id/supersede [admin] mark a source as no-longer-current
 *   DELETE /sources/:id   [admin]  remove a source (DB row + vectors)
 *
 * Retrieval/status are available to any authenticated user.
 * Ingestion and mutation require role 'admin'.
 *
 * Everything degrades gracefully: if Qdrant/Ollama are down, /status reports
 * it and /retrieve returns a clear error instead of crashing.
 */

const express = require('express');
const { retrieve, formatForPrompt } = require('./retriever');
const { ingestDocument, supersedeSource } = require('./ingest');
const embeddings  = require('./embeddings');
const vectorStore = require('./vectorStore');
const { query }   = require('../db');

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required for this operation' });
  }
  next();
}

function makeRouter() {
  const router = express.Router();

  // ── GET /status ────────────────────────────────────────────────────────────
  router.get('/status', async (_req, res) => {
    const [ollamaUp, qdrantUp] = await Promise.all([
      embeddings.isAvailable(),
      vectorStore.isAvailable(),
    ]);
    const corpus = qdrantUp ? await vectorStore.stats() : { exists: false, pointsCount: 0 };

    let sourceCount = 0;
    try {
      const r = await query('SELECT COUNT(*)::int AS n FROM tax_sources WHERE is_current_law = TRUE');
      sourceCount = r.rows[0]?.n ?? 0;
    } catch (_) { /* DB may be mid-init */ }

    res.json({
      ready: ollamaUp && qdrantUp,
      ollama: { available: ollamaUp, model: embeddings.EMBED_MODEL, url: embeddings.OLLAMA_URL },
      qdrant: { available: qdrantUp, collection: vectorStore.COLLECTION, ...corpus },
      currentSources: sourceCount,
    });
  });

  // ── POST /retrieve ───────────────────────────────────────────────────────────
  // Body: { query, taxYear?, jurisdiction?, topK?, minScore?, format? }
  // If format==='prompt', also returns a prompt-ready string.
  router.post('/retrieve', async (req, res) => {
    const { query: q, taxYear, jurisdiction = 'federal', topK = 8, minScore = 0, format } = req.body;
    if (!q || !q.trim()) return res.status(400).json({ error: 'query is required' });

    try {
      const excerpts = await retrieve(q, { taxYear, jurisdiction, topK, minScore });
      const out = { query: q, taxYear, jurisdiction, count: excerpts.length, excerpts };
      if (format === 'prompt') out.promptBlock = formatForPrompt(excerpts);
      res.json(out);
    } catch (e) {
      console.error('[RAG] Retrieve error:', e.message);
      res.status(503).json({
        error: 'Retrieval unavailable. Ensure Ollama and Qdrant are running.',
        detail: e.message,
      });
    }
  });

  // ── GET /sources ─────────────────────────────────────────────────────────────
  // Query: ?year=2024&jurisdiction=federal&includeSuperseded=false
  router.get('/sources', async (req, res) => {
    const year    = req.query.year ? parseInt(req.query.year) : null;
    const juris    = req.query.jurisdiction || null;
    const includeSuperseded = req.query.includeSuperseded === 'true';
    try {
      let sql = 'SELECT id, source_name, url, jurisdiction, document_type, tax_year, ' +
                'code_section, form_number, topic_tags, is_current_law, chunk_count, ' +
                'last_fetched, updated_at FROM tax_sources WHERE 1=1';
      const p = [];
      if (!includeSuperseded) sql += ' AND is_current_law = TRUE';
      if (year)  { p.push(year);  sql += ` AND (tax_year = $${p.length} OR tax_year IS NULL)`; }
      if (juris) { p.push(juris); sql += ` AND jurisdiction = $${p.length}`; }
      sql += ' ORDER BY source_name';
      const { rows } = await query(sql, p);
      res.json({ sources: rows, count: rows.length });
    } catch (e) {
      console.error('[RAG] Sources error:', e.message);
      res.status(500).json({ error: 'Failed to list sources' });
    }
  });

  // ── POST /ingest [admin] ──────────────────────────────────────────────────────
  router.post('/ingest', requireAdmin, async (req, res) => {
    const doc = req.body;
    if (!doc?.fullText || !doc?.sourceName || !doc?.documentType) {
      return res.status(400).json({ error: 'sourceName, documentType, and fullText are required' });
    }
    try {
      const result = await ingestDocument(doc);
      res.status(201).json({ success: true, ...result });
    } catch (e) {
      console.error('[RAG] Ingest error:', e.message);
      res.status(503).json({
        error: 'Ingestion failed. Ensure Ollama and Qdrant are running.',
        detail: e.message,
      });
    }
  });

  // ── POST /sources/:id/supersede [admin] ───────────────────────────────────────
  router.post('/sources/:id/supersede', requireAdmin, async (req, res) => {
    const { supersededBy } = req.body || {};
    try {
      await supersedeSource(req.params.id, supersededBy || null);
      res.json({ superseded: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to supersede source', detail: e.message });
    }
  });

  // ── DELETE /sources/:id [admin] ───────────────────────────────────────────────
  router.delete('/sources/:id', requireAdmin, async (req, res) => {
    try {
      await vectorStore.deleteBySource(req.params.id).catch(() => {});
      await query('DELETE FROM tax_sources WHERE id = $1', [req.params.id]);
      res.json({ deleted: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete source', detail: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter, requireAdmin };
