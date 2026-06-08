'use strict';
/**
 * embeddings.js — Local embedding generation via Ollama (nomic-embed-text)
 *
 * Uses Ollama's HTTP API (no SDK dependency — raw fetch).
 * nomic-embed-text produces 768-dimensional vectors and runs on CPU,
 * so it works on any machine without a GPU.
 *
 * Config (env):
 *   OLLAMA_URL    default http://localhost:11434
 *   EMBED_MODEL   default nomic-embed-text
 *   EMBED_DIM     default 768  (must match the model)
 *
 * Setup:
 *   ollama pull nomic-embed-text
 */

const OLLAMA_URL  = process.env.OLLAMA_URL  || 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const EMBED_DIM   = parseInt(process.env.EMBED_DIM || '768', 10);

/**
 * Embed a single string. Throws if Ollama is unreachable or returns an error.
 * @param {string} text
 * @returns {Promise<number[]>} embedding vector
 */
async function embed(text) {
  if (!text || !text.trim()) throw new Error('embed() called with empty text');
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Ollama embedding failed: HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!Array.isArray(data.embedding)) {
    throw new Error('Ollama returned no embedding array');
  }
  return data.embedding;
}

/**
 * Embed many strings sequentially (Ollama has no batch embed endpoint).
 * For large ingests this is the bottleneck; acceptable for periodic ingestion.
 * @param {string[]} texts
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<number[][]>}
 */
async function embedBatch(texts, onProgress) {
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embed(texts[i]));
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return out;
}

/** True if Ollama is running and the embed model is available. */
async function isAvailable() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
    if (!resp.ok) return false;
    const data = await resp.json();
    const models = (data.models || []).map(m => (m.name || '').split(':')[0]);
    return models.includes(EMBED_MODEL.split(':')[0]);
  } catch (_) {
    return false;
  }
}

module.exports = { embed, embedBatch, isAvailable, EMBED_DIM, EMBED_MODEL, OLLAMA_URL };
