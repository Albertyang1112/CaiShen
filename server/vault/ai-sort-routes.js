'use strict';
/**
 * vault/ai-sort-routes.js — DORMANT Express routes for the Groq document sorter.
 *
 * ⚠ NOT mounted anywhere yet (by design — the user wants to evaluate it first).
 * To activate later, add ONE line in server/vault/index.js, e.g.:
 *
 *     router.post('/ai-classify', require('./ai-sort-routes').classifyHandler({ readMeta }));
 *
 * and render the client/src/pages/AiSort/AiSort.jsx page. Until then this file is
 * inert and changes nothing about the running app.
 *
 *   POST /ai-classify  (multipart "files")  → { results: [{ filename, ok, decision, error }] }
 *     Dry-run: classifies each uploaded file with Groq and returns where it WOULD go.
 *     Stores nothing. The page then applies a chosen decision via the existing
 *     POST /api/vault/upload (folderPath=decision.folder) + PATCH /api/vault/file/:id.
 */
const { upload } = require('./helpers');
const { classifyDocument } = require('./ai-sort');

// Factory: returns an Express handler. `deps.readMeta(userId)` → vault meta (folders).
function classifyHandler({ readMeta }) {
  return [
    upload.array('files'),
    async (req, res) => {
      try {
        const userId  = req.user.id;
        const folders = (readMeta(userId).folders) || [];
        const files   = req.files || [];
        if (!files.length) return res.status(400).json({ error: 'No files uploaded.' });

        // Classify up to 5 at a time (Groq free-tier friendly).
        const results = [];
        const CONC = 5;
        for (let i = 0; i < files.length; i += CONC) {
          const batch = files.slice(i, i + CONC);
          const out = await Promise.all(batch.map(async (f) => {
            try {
              const r = await classifyDocument({
                buffer: f.buffer, filename: f.originalname, mimeType: f.mimetype, folders,
              });
              return { filename: f.originalname, size: f.size, ok: r.ok,
                       decision: r.decision, reasoning: r.decision?.reasoning,
                       needsOcr: r.needsOcr || false, error: r.error || null };
            } catch (e) {
              return { filename: f.originalname, ok: false,
                       error: e.response?.data?.error?.message || e.message, decision: null };
            }
          }));
          results.push(...out);
        }
        res.json({ results, model: require('./ai-sort').TEXT_MODEL });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  ];
}

module.exports = { classifyHandler };
