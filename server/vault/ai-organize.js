'use strict';
/**
 * vault/ai-organize.js — POST /api/vault/auto-organize handler, AI-powered.
 *
 * Replaces the regex/heuristic sorter. Each uploaded PDF is classified by Groq
 * (vault/ai-sort.js → classifyDocument), which reads the document's text, decides
 * the doc type (bank_statement | mortgage_statement | escrow | tax_form | other),
 * and produces the destination folder + filename — reusing existing vault folders.
 * This handler then files it there.
 *
 * Everything around the classification is preserved so the Data Vault UI keeps
 * working unchanged: the "which copy do you want to keep?" duplicate prompt, tamper
 * (fudge) detection on statement re-uploads, folder creation, R2 metadata moves,
 * empty-source-folder cleanup, and the same JSON response shape the client expects.
 *
 * Safety: if a file can't be classified (Groq down / no key / unreadable scan), it is
 * left where it is and reported as skipped/failed — never misfiled.
 */
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const documents = require('../core/documents');
const { classifyDocument } = require('./ai-sort');
const { parserSort } = require('./parser-sort');

// One file at a time. Under the free-tier tokens-per-minute cap, firing several
// large (~4k-token) classify calls at once makes them collide and 429 — and the
// shared cooldown then stalls all of them. Sequential calls each get the full
// token budget and succeed; combined with the per-batch writeMeta below, this also
// means progress is persisted after every single file. Raise this on a paid Groq tier.
const CLASSIFY_CONCURRENCY = 1;

// Deterministic fast-path (Tier 1+2 of the hybrid sorter): read the PDF locally and,
// when the parser is confident, return a fully-reconciled filing decision WITHOUT a
// Groq call. Handles bank/mortgage statements + tax forms; returns null (→ Groq) for
// receipts, unknown types, scanned/no-text PDFs, or any low-confidence read. The
// triage + confidence gate live in vault/parser-sort.js.
async function deterministicDecision(buffer, file, folders) {
  const res = await parserSort(buffer, file, folders);
  return res && res.confidence >= 0.75 ? res.decision : null;
}

module.exports = function makeAiOrganize({ getUserVaultDir, makeIO, readMeta, writeMeta }) {
  return async (req, res) => {
    try {
      const userId   = req.user.id;
      const vaultDir = getUserVaultDir(userId);
      let   meta     = readMeta(userId);

      const { folderId, consolidate } = req.body;
      // Decisions from the "which copy to keep?" prompt on a prior run:
      // { "<idA|idB sorted>": "<fileIdToKeep>" }.
      const duplicateResolutions = (req.body.duplicateResolutions && typeof req.body.duplicateResolutions === 'object')
        ? req.body.duplicateResolutions : {};
      const hasResolutions = Object.keys(duplicateResolutions).length > 0;

      const zero = (extra = {}) => ({
        processed: 0, organized: 0, failed: 0, skipped: 0, fudgedCount: 0,
        consolidated: 0, renamed: 0, duplicatesRemoved: 0, duplicates: [], mortgageHealed: 0, ...extra,
      });

      // The AI sorter doesn't need the old backfill/folder-merge "consolidate" pass.
      if (consolidate) return res.json(zero());

      // GROQ must be configured — otherwise leave everything untouched (never misfile).
      if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_api_key_here') {
        return res.json(zero({ aiError: 'GROQ_API_KEY not configured' }));
      }

      // ── Storage helpers (R2-first; disk only for un-migrated files) ──────────
      const readFileBytes = async (f) => {
        try { const b = await documents.getDocumentBytes(userId, f.id); if (b) return b; } catch {}
        const p = path.join(vaultDir, f.folderPath, f.name);
        return fs.existsSync(p) ? fs.readFileSync(p) : null;
      };
      const fileExists = async (f) => {
        try { if (await documents.documentExists(userId, f.id)) return true; } catch {}
        return fs.existsSync(path.join(vaultDir, f.folderPath, f.name));
      };
      const applyRename = async (f, newName) => {
        try { const op = path.join(vaultDir, f.folderPath, f.name), np = path.join(vaultDir, f.folderPath, newName);
              if (fs.existsSync(op) && !fs.existsSync(np)) fs.renameSync(op, np); } catch {}
        try { await documents.renameDocument(userId, f.id, newName); } catch {}
      };
      const applyMove = async (f, newFolderPath, newName) => {
        try {
          const op = path.join(vaultDir, f.folderPath, f.name);
          const nd = path.join(vaultDir, newFolderPath), np = path.join(nd, newName);
          if (fs.existsSync(op)) { fs.mkdirSync(nd, { recursive: true }); if (!fs.existsSync(np)) fs.renameSync(op, np); }
        } catch {}
        if (newName !== f.name) { try { await documents.renameDocument(userId, f.id, newName); } catch {} }
      };
      const removeFile = async (f) => {
        try { await documents.deleteDocument(userId, f.id); } catch {}
        try { const p = path.join(vaultDir, f.folderPath, f.name); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
      };
      const ensureFolderPath = (targetPath) => {
        const parts = targetPath.split('/').filter(Boolean);
        let parentId = null;
        for (let i = 0; i < parts.length; i++) {
          const fullPath = parts.slice(0, i + 1).join('/');
          let f = meta.folders.find(x => x.path === fullPath);
          if (!f) {
            f = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  name: parts[i], path: fullPath, parentId, createdAt: new Date().toISOString(), tags: {} };
            meta.folders.push(f);
            try { fs.mkdirSync(path.join(vaultDir, fullPath), { recursive: true }); } catch {}
          }
          parentId = f.id;
        }
        return parentId;
      };

      // ── Duplicate-prompt plumbing (unchanged protocol the UI already speaks) ─
      const duplicatesFound = [];
      const seenDupKeys     = new Set();
      const dupInfo = (f) => ({ id: f.id, name: f.name, folderPath: f.folderPath, size: f.size,
        createdAt: f.createdAt, txCount: f.tags?.txCount, verificationStatus: f.tags?.verificationStatus });
      const pushDuplicate = (existing, incoming, period) => {
        const key = [existing.id, incoming.id].sort().join('|');
        if (seenDupKeys.has(key)) return;
        seenDupKeys.add(key);
        duplicatesFound.push({ key, period, existing: dupInfo(existing), incoming: dupInfo(incoming) });
      };
      const resolutionFor = (a, b) => {
        const keepId = duplicateResolutions[[a.id, b.id].sort().join('|')];
        return (keepId === a.id || keepId === b.id) ? keepId : null;
      };

      // ── Tamper (fudge) detection — compares transactions of two statement PDFs ─
      // in a child process (pdf2json shared-state bug). Returns true if ≥20% of
      // same-date transactions differ in amount. Statements only.
      const detectFudge = async (existing, incoming, year, month) => {
        let tmpOrig = null, tmpNew = null;
        try {
          const { execFileSync } = require('child_process');
          const workerPath = path.join(__dirname, 'fudge-detect-worker.js');
          const origBuf = await readFileBytes(existing), newBuf = await readFileBytes(incoming);
          if (!origBuf || !newBuf) return false;
          tmpOrig = path.join(os.tmpdir(), `cs_orig_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.pdf`);
          tmpNew  = path.join(os.tmpdir(), `cs_new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.pdf`);
          fs.writeFileSync(tmpOrig, origBuf); fs.writeFileSync(tmpNew, newBuf);
          const raw = execFileSync(process.execPath, [workerPath, tmpOrig, tmpNew, String(year || ''), String(month || '')],
            { cwd: __dirname, timeout: 30000, maxBuffer: 1024 * 1024 });
          const jsonLine = raw.toString().split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop() || '{}';
          const { orig: origTxs, new: newTxs } = JSON.parse(jsonLine);
          if (!(newTxs?.length > 0 && origTxs?.length > 0)) return false;
          let fudgeCount = 0, matchCount = 0;
          for (const t2 of newTxs) {
            const same = origTxs.filter(t1 => t1.date === t2.date);
            if (!same.length) continue;
            const minDiff = Math.min(...same.map(t1 => Math.abs(Math.abs(t2.amount) - Math.abs(t1.amount))));
            if (minDiff < 0.02) matchCount++; else fudgeCount++;
          }
          const total = fudgeCount + matchCount;
          return total >= 2 && (fudgeCount / total) >= 0.2;
        } catch (e) { console.error('[vault/ai-organize] fudge detection:', e.message); return false; }
        finally { try { if (tmpOrig) fs.unlinkSync(tmpOrig); } catch {}; try { if (tmpNew) fs.unlinkSync(tmpNew); } catch {} }
      };

      // ── Per-doc-type derived helpers ─────────────────────────────────────────
      const mm = (d) => d.month ? String(d.month).padStart(2, '0') : null;
      // Tags written on an organized file — shared with the chatbot doc-ingest path so
      // both filers stamp identical tags (see vault/helpers.js decisionTags).
      const baseTags = require('./helpers').decisionTags;
      const dupPeriod = (d) => ({
        last4:  d.last4 || undefined,
        year:   d.year ? String(d.year) : undefined,
        month:  mm(d) || undefined,
        street: (d.docType === 'mortgage_statement' || d.docType === 'escrow') ? d.propertyAddress : undefined,
        periodStart: d.periodStart || undefined,
        periodEnd:   d.periodEnd   || undefined,
      });
      // Two statements cover the SAME date range? (the true "same statement" signal).
      // Allow ±3 days for minor reading variance; ~monthly cycles are weeks apart so
      // this still cleanly separates the same period from a different one. Returns
      // null when range info is missing on either side (caller falls back).
      const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
      const rangeMatch = (d, f2) => {
        const s2 = f2.tags?.periodStart, e2 = f2.tags?.periodEnd;
        if (!(d.periodStart && d.periodEnd && s2 && e2)) return null;
        return dayDiff(d.periodStart, s2) <= 3 && dayDiff(d.periodEnd, e2) <= 3;
      };
      // Does an existing file in the SAME target folder cover the same period?
      const periodMatch = (f2, targetPath, d) => {
        if (f2.id == null || f2.type !== 'pdf' || f2.folderPath !== targetPath) return false;
        if (d.docType === 'bank_statement' || d.docType === 'mortgage_statement') {
          const rm = rangeMatch(d, f2);
          if (rm !== null) return rm;                // both have ranges → date range is authoritative
          // Legacy fallback (older files without stored ranges): same name, or account + closing month.
          if (f2.name === d.filename) return true;
          if (d.docType === 'bank_statement')
            return !!d.last4 && f2.tags?.last4 === String(d.last4) && f2.tags?.year === String(d.year) && f2.tags?.month === mm(d);
          return f2.tags?.year === String(d.year) && f2.tags?.month === mm(d);
        }
        if (f2.name === d.filename) return true;
        if (d.docType === 'escrow')
          return f2.tags?.docType === 'escrow' && f2.tags?.year === String(d.year);
        if (d.docType === 'tax_form')
          return f2.tags?.docType === 'tax_form' && f2.tags?.year === String(d.year) && (f2.tags?.formType || '') === (d.formType || '');
        if (d.docType === 'insurance_statement') {
          // Same policy (last-4) + same billing month = the same bill.
          const p4 = d.policyNumber ? String(d.policyNumber).replace(/[^A-Za-z0-9]/g, '').slice(-4) : null;
          return f2.tags?.docType === 'insurance_statement' && !!p4 && f2.tags?.last4 === p4
              && f2.tags?.year === String(d.year) && f2.tags?.month === mm(d);
        }
        return false;
      };

      // ── Gather the PDFs to process ───────────────────────────────────────────
      // Only UN-SORTED PDFs — never re-classify files that already carry an
      // institution/aiSorted marker. (Uploading into a folder that already holds
      // organized statements used to re-run Groq on every file in it, exhausting
      // the rate limit and abandoning the genuinely-new uploads.) This applies to
      // the folder-scoped path too; a re-sort of an already-filed file isn't needed.
      const unsorted = (f) => !f.tags?.institution && !f.tags?.aiSorted;
      // Images too: a photographed insurance bill / disclosure classifies via the Groq
      // vision path classifyDocument already supports (parserSort just returns null).
      const sortable = (f) => (f.type === 'pdf' || f.type === 'image') && unsorted(f);
      let pdfFiles = folderId
        ? meta.files.filter(f => f.folderId === folderId && sortable(f))
        : meta.files.filter(f => sortable(f));
      if (hasResolutions) {
        const ids = new Set(Object.keys(duplicateResolutions).flatMap(k => k.split('|')));
        pdfFiles = pdfFiles.filter(f => ids.has(f.id));
      }
      if (!pdfFiles.length) return res.json(zero({ duplicates: duplicatesFound }));

      const folders = meta.folders; // reuse-context for the classifier
      // The user's own properties — lets the classifier file "Insurance/{property name}/…"
      // and the domain recorder link policies to the right property. Never hardcoded.
      let userProps = [];
      try { userProps = makeIO(userId).read('properties.json') || []; } catch {}

      // ── Classify (Groq) -> file -> PERSIST, one small batch at a time ────────
      // Persisting after EVERY batch means a rate-limited or interrupted run keeps
      // the files it already sorted (their aiSorted tag is saved), so re-running
      // resumes on the remaining files instead of restarting from the first one.
      const results = zero({ duplicates: duplicatesFound, details: [] });

      for (let i = 0; i < pdfFiles.length; i += CLASSIFY_CONCURRENCY) {
        const batch = pdfFiles.slice(i, i + CLASSIFY_CONCURRENCY);
        const classified = await Promise.all(batch.map(async (file) => {
          try {
            const buffer = await readFileBytes(file);
            if (!buffer) return { file, error: 'File bytes unavailable' };
            // Known-type files (e.g. scraped mortgage statements) skip Groq entirely.
            const det = await deterministicDecision(buffer, file, folders);
            if (det && det.docType !== 'other' && det.folder) return { file, decision: det, ok: true, buffer };
            // A scraped file whose type is already known should NEVER fall through to
            // Groq in a big batch - one unreadable one would burn the rate limit in
            // retries and stall everything. Leave it for a later targeted pass.
            if (file.tags?.source === 'mortgage') return { file, error: 'deterministic read failed (skipped Groq for scraped batch)' };
            const r = await classifyDocument({ buffer, filename: file.name,
              mimeType: file.mimeType || (file.type === 'image' ? 'image/jpeg' : 'application/pdf'),
              folders, properties: userProps });
            return { file, decision: r.decision, ok: r.ok, error: r.ok ? null : (r.error || null), buffer, text: r.text || null };
          } catch (e) { return { file, error: e.response?.data?.error?.message || e.message }; }
        }));

        for (const { file, decision: d, error, buffer, text } of classified) {
          results.processed++;

          if (error && !d) { results.failed++; results.details.push({ file: file.name, status: 'failed', reason: error }); continue; }

          // Unclassifiable → leave in place, mark attempted so the auto-load flow won't
          // re-ask Groq every refresh (the manual Sort button still retries).
          if (!d || d.docType === 'other' || !d.folder || d.folder === 'Unsorted') {
            results.skipped++;
            const fi = meta.files.findIndex(x => x.id === file.id);
            if (fi >= 0) meta.files[fi].tags = { ...meta.files[fi].tags, aiSorted: true, docType: 'other' };
            results.details.push({ file: file.name, status: 'skipped', reason: error || d?.reasoning || 'Could not determine document type' });
            continue;
          }

          const targetPath  = d.folder;
          const isStatement = d.docType === 'bank_statement' || d.docType === 'mortgage_statement';

          // ── Period duplicate at the target folder ──────────────────────────────
          const existing = meta.files.find(f2 => f2.id !== file.id && periodMatch(f2, targetPath, d));
          if (existing) {
            if (!(await fileExists(existing))) {                       // ghost entry — drop it, organize normally
              const gi = meta.files.findIndex(x => x.id === existing.id);
              if (gi >= 0) meta.files.splice(gi, 1);
            } else {
              if (isStatement && d.year && d.month && await detectFudge(existing, file, d.year, d.month)) {
                const flaggedName = d.filename.replace(/\.pdf$/i, '') + '_FLAGGED.pdf';
                if (file.name !== flaggedName) await applyRename(file, flaggedName);
                const fi = meta.files.findIndex(x => x.id === file.id);
                if (fi >= 0) {
                  meta.files[fi].name = flaggedName;
                  meta.files[fi].tags = { ...meta.files[fi].tags, ...baseTags(d), fudge: true, fudgeOf: existing.id };
                }
                results.fudgedCount++;
                results.details.push({ file: flaggedName, status: 'flagged', targetPath });
                continue;
              }
              const keepId = resolutionFor(existing, file);
              if (!keepId) { pushDuplicate(existing, file, dupPeriod(d)); continue; }
              if (keepId === existing.id) {                            // keep existing → drop incoming
                await removeFile(file);
                const fi = meta.files.findIndex(x => x.id === file.id);
                if (fi >= 0) meta.files.splice(fi, 1);
                results.duplicatesRemoved++; continue;
              }
              await removeFile(existing);                              // keep incoming → drop existing, place incoming
              const ei = meta.files.findIndex(x => x.id === existing.id);
              if (ei >= 0) meta.files.splice(ei, 1);
              results.duplicatesRemoved++;
            }
          }

          // ── File it ────────────────────────────────────────────────────────────
          const newFolderId = ensureFolderPath(targetPath);
          let dstName = d.filename;
          if (meta.files.some(f2 => f2.id !== file.id && f2.folderPath === targetPath && f2.name === dstName)) {
            const base = path.basename(dstName, path.extname(dstName));
            dstName = `${base}_${Date.now()}${path.extname(dstName)}`;
          }
          if (!(file.folderPath === targetPath && file.name === dstName)) await applyMove(file, targetPath, dstName);
          const fi = meta.files.findIndex(x => x.id === file.id);
          if (fi >= 0) {
            meta.files[fi].name       = dstName;
            meta.files[fi].folderPath = targetPath;
            meta.files[fi].folderId   = newFolderId;
            meta.files[fi].tags       = { ...meta.files[fi].tags, ...baseTags(d) };
          }
          results.organized++;
          results.details.push({ file: dstName, status: 'organized', targetPath, docType: d.docType, year: d.year, month: d.month });

          // ── Domain recorder (insurance / tax / action letters) — best-effort, success
          // path only. Duplicates/fudge never reach here, so a re-upload can't
          // double-record; the recorders' deterministic ids make replays idempotent.
          if (d.docType === 'insurance_statement' || d.docType === 'tax_form' || d.docType === 'disclosure') {
            try {
              const { runDomainRecorder } = require('./domain-hooks');
              const rec = await runDomainRecorder(makeIO(userId), userId, { docType: d.docType, fileId: file.id, buffer, text, decision: d });
              if (rec && rec.recorded) results.details[results.details.length - 1].recorded = true;
            } catch (e) { console.error('[vault/ai-organize] domain recorder:', e.message); }
          }
        }

        writeMeta(meta, userId);   // persist after every batch (resumable)
      }

      // ── Clean up the source folder + now-empty ancestors ─────────────────────
      if (folderId) {
        let cleanId = folderId, firstDeleted = null;
        while (cleanId) {
          const hasFiles    = meta.files.some(f => f.folderId === cleanId);
          const hasChildren = meta.folders.some(f => f.parentId === cleanId);
          if (hasFiles || hasChildren) break;
          const folder = meta.folders.find(f => f.id === cleanId);
          if (!folder) break;
          if (!firstDeleted) firstDeleted = folder;
          const nextParent = folder.parentId;
          try { const pp = path.join(vaultDir, folder.path); if (fs.existsSync(pp)) fs.rmSync(pp, { recursive: true, force: true }); } catch {}
          meta.folders = meta.folders.filter(f => f.id !== cleanId);
          cleanId = nextParent;
        }
        if (firstDeleted) { writeMeta(meta, userId); results.sourceFolderDeleted = true; results.sourceFolderName = firstDeleted.name; }
      }

      console.log(`[vault/ai-organize] ${results.organized}/${results.processed} sorted, ${results.duplicatesRemoved} dupes removed, ${duplicatesFound.length} dupe pair(s) awaiting decision, ${results.fudgedCount} flagged, ${results.skipped} skipped, ${results.failed} failed`);
      res.json(results);
    } catch (e) {
      console.error('[vault/ai-organize]', e.message);
      res.status(500).json({ error: e.message });
    }
  };
};
