'use strict';
/**
 * vault/ai-review.js — "Vault review": propose cleanup changes for the user to approve.
 *
 * Nothing here deletes or moves anything on its own. The review handler ANALYZES the
 * vault and returns a list of proposed changes; the apply handler executes only the
 * proposals the user explicitly approved (sent back from the UI).
 *
 * What it detects:
 *   • delete_file   — exact-duplicate files (same sha256), keeping the most canonical copy   [code]
 *   • delete_folder — empty folders (no files anywhere in their subtree)                       [code]
 *   • merge_folder  — folders that are duplicates/variants of one another (casing/spelling/
 *                     redundant nesting), via Groq's judgment on the folder tree              [Groq]
 *
 * Deterministic facts (dup files, empty folders) are computed in code so deletions are
 * never based on a hallucination; Groq handles the fuzzy folder-naming judgment.
 */
const path = require('path');
const fs   = require('fs');
const documents = require('../core/documents');
const { groqChat } = require('./groq-client');   // shared rate-limit-aware gateway

const TEXT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const FOLDER_SYSTEM = `You review a personal-finance vault's FOLDER structure for cleanup. You are given a list of folders as "path — N files". Identify folders that are DUPLICATES or VARIANTS of the SAME thing and should be merged into one. Respond with ONLY JSON, no prose:
{"merges":[{"from":"<exact folder path to empty then remove>","into":"<exact canonical folder path to keep>","reason":"one short sentence"}]}
Rules:
- Merge ONLY two SEPARATE folders that are name-variants of the same thing — e.g. different casing or spelling ("CHASE" vs "Chase", "Total Checking" vs "TOTAL CHECKING").
- NEVER merge different banks, different accounts, different properties, or different YEARS.
- NEVER merge a folder into its own PARENT or SUBFOLDER — a parent and its child are hierarchy, NOT duplicates (e.g. do NOT merge "Bank Statements" into "Bank Statements/Chase"). The file counts are subtree totals, so a parent will look like it "has the same files" as its only child — that is NOT a duplicate.
- "from" and "into" must be EXACT paths from the provided list, and neither may be a path-prefix of the other. "into" is the more complete/canonical one.
- Be conservative. If nothing clearly should merge, return {"merges":[]}.`;

// Canonical-keep ranking for duplicate files: prefer organized trees, shorter paths,
// and names without a "(1)" upload-collision suffix.
function fileScore(f) {
  let s = 0;
  if (/^Bank Statements\//.test(f.folderPath || ''))     s += 100;
  if (/^Mortgage Statements\//.test(f.folderPath || ''))  s += 100;
  if (/^Tax Documents\//.test(f.folderPath || ''))        s += 80;
  if (/\(\d+\)\.pdf$/i.test(f.name || ''))                s -= 50;   // "... (1).pdf"
  s -= (f.folderPath || '').length * 0.1;                            // shorter path wins
  return s;
}

async function groqMerges(folderLines) {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_api_key_here') return [];
  const resp = await groqChat({          // shared gate handles concurrency + 429 cooldown
    model: TEXT_MODEL, temperature: 0, max_tokens: 1200,
    messages: [
      { role: 'system', content: FOLDER_SYSTEM },
      { role: 'user', content: `FOLDERS:\n${folderLines}` },
    ],
  });
  const raw = resp.data?.choices?.[0]?.message?.content || '';
  let parsed = null;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
  return Array.isArray(parsed?.merges) ? parsed.merges : [];
}

module.exports = function makeAiReview({ getUserVaultDir, makeIO, readMeta, writeMeta }) {
  const { query } = require('../core/db');

  // ── POST /api/vault/review — analyze, return proposals (changes nothing) ──────
  const reviewHandler = async (req, res) => {
    try {
      const userId = req.user.id;
      const meta   = readMeta(userId);
      const subtreeCount = (p) => meta.files.filter(f => f.folderPath === p || (f.folderPath || '').startsWith(p + '/')).length;

      const proposals = [];
      let pid = 0;
      const add = (p) => proposals.push({ id: `p${++pid}`, ...p });

      // 1. Exact-duplicate files (sha256 from the documents table)
      try {
        const rows = await query(
          `SELECT sha256, array_agg(id) ids FROM documents
            WHERE user_id=$1 AND sha256 IS NOT NULL GROUP BY sha256 HAVING count(*) > 1`, [userId]);
        for (const row of rows.rows) {
          const files = row.ids.map(id => meta.files.find(f => f.id === id)).filter(Boolean);
          if (files.length < 2) continue;
          files.sort((a, b) => fileScore(b) - fileScore(a));
          const keep = files[0];
          for (const f of files.slice(1)) {
            add({ type: 'delete_file', severity: 'destructive',
              fileId: f.id, fileName: f.name, folderPath: f.folderPath,
              reason: `Exact duplicate (identical content) of "${keep.name}" in ${keep.folderPath}. Keeping that copy.` });
          }
        }
      } catch (e) { console.error('[vault/review] dup scan:', e.message); }

      // 2. Empty folders (topmost folder with no files anywhere beneath it)
      for (const fo of meta.folders) {
        if (subtreeCount(fo.path) > 0) continue;
        const parent = fo.parentId ? meta.folders.find(x => x.id === fo.parentId) : null;
        if (parent && subtreeCount(parent.path) === 0) continue;   // its parent is also empty → only propose the topmost
        add({ type: 'delete_folder', severity: 'destructive', folderPath: fo.path,
          reason: 'Empty folder — contains no files.' });
      }

      // 3. Folder consolidation (Groq judgment on the folder tree)
      try {
        const lines = meta.folders.map(f => `${f.path} — ${subtreeCount(f.path)} files`).sort().join('\n');
        const merges = lines ? await groqMerges(lines) : [];
        // A folder may never merge into its own ancestor/descendant — that's hierarchy,
        // not duplication, and applying it would collapse the tree. Hard guardrail
        // (the prompt also forbids it, but never trust the model on a destructive op).
        const related = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
        for (const m of merges) {
          if (!m?.from || !m?.into || m.from === m.into) continue;
          if (!meta.folders.some(f => f.path === m.from) || !meta.folders.some(f => f.path === m.into)) continue;
          if (related(m.from, m.into)) { console.log(`[vault/review] dropped unsafe merge ${m.from} → ${m.into}`); continue; }
          add({ type: 'merge_folder', severity: 'destructive',
            fromPath: m.from, intoPath: m.into, fileCount: subtreeCount(m.from),
            reason: m.reason || `"${m.from}" looks like a duplicate of "${m.into}".` });
        }
      } catch (e) { console.error('[vault/review] groq folder merge:', e.message); }

      console.log(`[vault/review] ${proposals.length} proposal(s): ` +
        proposals.map(p => p.type).join(', '));
      res.json({ proposals, scanned: { files: meta.files.length, folders: meta.folders.length } });
    } catch (e) {
      console.error('[vault/review]', e.message);
      res.status(500).json({ error: e.message });
    }
  };

  // ── POST /api/vault/review/apply — execute ONLY the approved proposals ────────
  const applyHandler = async (req, res) => {
    try {
      const userId   = req.user.id;
      const vaultDir = getUserVaultDir(userId);
      let   meta     = readMeta(userId);
      const approved = Array.isArray(req.body?.proposals) ? req.body.proposals : [];
      if (!approved.length) return res.json({ applied: 0, results: [] });

      const removeFileById = async (id) => {
        try { await documents.deleteDocument(userId, id); } catch {}
        const f = meta.files.find(x => x.id === id);
        if (f) { try { const p = path.join(vaultDir, f.folderPath, f.name); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
        meta.files = meta.files.filter(x => x.id !== id);
      };
      const removeFolderSubtree = (folderPath) => {
        const ids = meta.folders.filter(f => f.path === folderPath || f.path.startsWith(folderPath + '/')).map(f => f.id);
        meta.folders = meta.folders.filter(f => !ids.includes(f.id));
        try { const pp = path.join(vaultDir, folderPath); if (fs.existsSync(pp)) fs.rmSync(pp, { recursive: true, force: true }); } catch {}
      };
      const ensureFolderPath = (targetPath) => {
        const parts = targetPath.split('/').filter(Boolean);
        let parentId = null;
        for (let i = 0; i < parts.length; i++) {
          const full = parts.slice(0, i + 1).join('/');
          let f = meta.folders.find(x => x.path === full);
          if (!f) { f = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: parts[i], path: full, parentId, createdAt: new Date().toISOString(), tags: {} };
            meta.folders.push(f); try { fs.mkdirSync(path.join(vaultDir, full), { recursive: true }); } catch {} }
          parentId = f.id;
        }
        return parentId;
      };

      const results = [];
      let applied = 0;
      for (const p of approved) {
        try {
          if (p.type === 'delete_file' && p.fileId) {
            if (meta.files.some(f => f.id === p.fileId)) { await removeFileById(p.fileId); applied++; results.push({ id: p.id, ok: true }); }
            else results.push({ id: p.id, ok: false, error: 'file no longer present' });

          } else if (p.type === 'delete_folder' && p.folderPath) {
            // Re-validate it's still empty before removing.
            const n = meta.files.filter(f => f.folderPath === p.folderPath || (f.folderPath || '').startsWith(p.folderPath + '/')).length;
            if (n === 0) { removeFolderSubtree(p.folderPath); applied++; results.push({ id: p.id, ok: true }); }
            else results.push({ id: p.id, ok: false, error: `folder is not empty (${n} files)` });

          } else if (p.type === 'merge_folder' && p.fromPath && p.intoPath) {
            // Guardrail: never collapse a folder into its own ancestor/descendant.
            if (p.fromPath === p.intoPath || p.fromPath.startsWith(p.intoPath + '/') || p.intoPath.startsWith(p.fromPath + '/')) {
              results.push({ id: p.id, ok: false, error: 'refused: folders are parent/child, not duplicates' });
              continue;
            }
            const movers = meta.files.filter(f => f.folderPath === p.fromPath || (f.folderPath || '').startsWith(p.fromPath + '/'));
            for (const f of movers) {
              const rel = f.folderPath === p.fromPath ? '' : f.folderPath.slice(p.fromPath.length + 1);
              const newFolderPath = rel ? `${p.intoPath}/${rel}` : p.intoPath;
              const newFolderId = ensureFolderPath(newFolderPath);
              // metadata move (R2 object stays by id); best-effort disk move
              try { const op = path.join(vaultDir, f.folderPath, f.name), nd = path.join(vaultDir, newFolderPath), np = path.join(nd, f.name);
                if (fs.existsSync(op)) { fs.mkdirSync(nd, { recursive: true }); if (!fs.existsSync(np)) fs.renameSync(op, np); } } catch {}
              const fi = meta.files.findIndex(x => x.id === f.id);
              if (fi >= 0) { meta.files[fi].folderPath = newFolderPath; meta.files[fi].folderId = newFolderId; }
            }
            removeFolderSubtree(p.fromPath);
            applied++; results.push({ id: p.id, ok: true, moved: movers.length });

          } else {
            results.push({ id: p.id, ok: false, error: 'unknown or malformed proposal' });
          }
        } catch (e) { results.push({ id: p.id, ok: false, error: e.message }); }
      }

      if (applied > 0) writeMeta(meta, userId);
      console.log(`[vault/review/apply] applied ${applied}/${approved.length}`);
      res.json({ applied, results });
    } catch (e) {
      console.error('[vault/review/apply]', e.message);
      res.status(500).json({ error: e.message });
    }
  };

  return { reviewHandler, applyHandler };
};
