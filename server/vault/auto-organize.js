'use strict';
/**
 * vault/auto-organize.js — POST /api/vault/auto-organize handler.
 * Sorts untagged PDFs into property/type folders, backfills last4, merges duplicate
 * folders, and flags tampered statements (spawns fudge-detect-worker.js in this dir).
 * Extracted from vault/index.js to keep the router thin. Deps injected by the factory.
 */
const path = require('path');
const fs   = require('fs');
const { stmtFilename, titleCase } = require('./helpers');

module.exports = function makeAutoOrganize({ getUserVaultDir, makeIO, readMeta, writeMeta }) {
  return async (req, res) => {
    try {
      const { extractStatementMeta, guessAccountTypeSubtype } = require('../core/pdf-parser');
      const userId   = req.user.id;
      const io       = makeIO(userId);
      const vaultDir = getUserVaultDir(userId);
      let   meta     = readMeta(userId);
      let   accounts = io.read('accounts.json') || [];

      const { folderId, consolidate } = req.body;

      // ── Helper: ensure folder path exists in meta + on disk ─────────────────
      const ensureFolderPath = (targetPath) => {
        const parts = targetPath.split('/').filter(Boolean);
        let parentId = null;
        for (let i = 0; i < parts.length; i++) {
          const fullPath = parts.slice(0, i + 1).join('/');
          let f = meta.folders.find(x => x.path === fullPath);
          if (!f) {
            f = {
              id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: parts[i], path: fullPath, parentId,
              createdAt: new Date().toISOString(), tags: {},
            };
            meta.folders.push(f);
            fs.mkdirSync(path.join(vaultDir, fullPath), { recursive: true });
          }
          parentId = f.id;
        }
        return parentId;
      };

      // ── Score an account folder name — higher = more "official" ─────────────
      // All-caps names (like "TOTAL CHECKING") are typically the bank's own label.
      // Descriptive/contextual names (like "High School Checking") score lower.
      const scoreAccountName = (name) => {
        let score = 0;
        if (name === name.toUpperCase() && /[A-Z]/.test(name)) score += 20; // all-caps
        const keywords = ['TOTAL', 'PREMIER', 'SIGNATURE', 'PLATINUM', 'BUSINESS',
                          'CHECKING', 'SAVINGS', 'MONEY MARKET', 'BROKERAGE'];
        for (const kw of keywords) if (name.toUpperCase().includes(kw)) score += 5;
        score -= name.length * 0.5; // shorter names score slightly higher
        return score;
      };

      // ── Step 1: Backfill last4 on vault PDFs that have institution but no last4 ──
      // Necessary so files sorted by older code (no last4 tag) can be cross-matched.
      const needsBackfill = meta.files.filter(f =>
        f.type === 'pdf' && f.tags?.institution && !f.tags?.last4
      );
      if (needsBackfill.length > 0) {
        const BFCONC = 5;
        for (let i = 0; i < needsBackfill.length; i += BFCONC) {
          await Promise.allSettled(needsBackfill.slice(i, i + BFCONC).map(async (f) => {
            const fp = path.join(vaultDir, f.folderPath, f.name);
            if (!fs.existsSync(fp)) return;
            const buf = fs.readFileSync(fp);
            const { last4: pdfL4 } = await extractStatementMeta(buf);
            const fnL4M = f.name.match(/statements?[-_](\d{4})/i);
            const resolved = (fnL4M ? fnL4M[1] : null) || pdfL4;
            if (resolved) {
              const fi = meta.files.findIndex(x => x.id === f.id);
              if (fi >= 0) meta.files[fi].tags = { ...meta.files[fi].tags, last4: resolved };
            }
          }));
        }
        writeMeta(meta, userId);
        console.log(`[vault/auto-organize] Backfilled last4 for ${needsBackfill.length} files`);
      }

      // ── Step 2: Build vault-folder → last4 map for cross-file matching ───────
      // Maps inst+last4 → best canonical account folder name.
      // This lets PDFs find the "right" folder even if accounts.json is empty.
      const vaultFolderL4Map = {}; // key: "inst_lower:l4" → best folder name
      for (const folder of meta.folders) {
        const parts = folder.path.split('/');
        if (parts[0] !== 'Bank Statements' || parts.length !== 3) continue;
        const instName = parts[1], acctName = parts[2];
        const folderFiles = meta.files.filter(f => f.folderPath.startsWith(folder.path + '/') || f.folderPath === folder.path);
        const last4s = [...new Set(folderFiles.map(f => f.tags?.last4).filter(Boolean))];
        for (const l4 of last4s) {
          const key = `${instName.toLowerCase()}:${l4}`;
          const cur = vaultFolderL4Map[key];
          if (!cur || scoreAccountName(acctName) > scoreAccountName(cur)) {
            vaultFolderL4Map[key] = acctName;
          }
        }
      }

      // ── Step 3: Consolidate duplicate account folders ────────────────────────
      // If multiple Bank Statements/{inst}/{acct}/ folders share the same last4,
      // merge them into the highest-scoring (most official) one.
      let consolidated = 0;
      const acctLevelFolders = meta.folders.filter(f => {
        const p = f.path.split('/');
        return p.length === 3 && p[0] === 'Bank Statements';
      });
      // Group: inst → last4 → [folders]
      const instL4Groups = {};
      for (const folder of acctLevelFolders) {
        const inst = folder.path.split('/')[1];
        const folderFiles = meta.files.filter(f => f.folderPath.startsWith(folder.path));
        const last4s = [...new Set(folderFiles.map(f => f.tags?.last4).filter(Boolean))];
        for (const l4 of last4s) {
          const key = `${inst}::${l4}`;
          if (!instL4Groups[key]) instL4Groups[key] = [];
          instL4Groups[key].push(folder);
        }
      }
      for (const [key, folders] of Object.entries(instL4Groups)) {
        if (folders.length <= 1) continue;
        const l4   = key.split('::')[1];
        const inst = key.split('::')[0];
        // Pick canonical: highest name score
        folders.sort((a, b) => scoreAccountName(b.name) - scoreAccountName(a.name));
        const canonical  = folders[0];
        const duplicates = folders.slice(1);
        for (const dup of duplicates) {
          const dupFiles = meta.files.filter(f => f.folderPath.startsWith(dup.path));
          for (const f of dupFiles) {
            const rel           = f.folderPath.slice(dup.path.length); // e.g. "/2019"
            const newFolderPath = canonical.path + rel;
            const targetFolderId = ensureFolderPath(newFolderPath);
            const src = path.join(vaultDir, f.folderPath, f.name);
            const dst = path.join(vaultDir, newFolderPath, f.name);
            try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch {}
            const fi = meta.files.findIndex(x => x.id === f.id);
            if (fi >= 0) {
              meta.files[fi].folderPath = newFolderPath;
              meta.files[fi].folderId   = targetFolderId;
              meta.files[fi].tags       = { ...meta.files[fi].tags, account: canonical.name, last4: l4 };
            }
            consolidated++;
          }
          // Remove dup folder tree from meta + disk
          const toRemove = meta.folders
            .filter(x => x.path === dup.path || x.path.startsWith(dup.path + '/'))
            .map(x => x.id);
          meta.folders = meta.folders.filter(x => !toRemove.includes(x.id));
          try { fs.rmSync(path.join(vaultDir, dup.path), { recursive: true, force: true }); } catch {}
        }
        // Ensure accounts.json reflects the canonical name
        let acctEntry = accounts.find(a =>
          a.last4 === l4 && (a.institution || '').toLowerCase() === inst.toLowerCase()
        );
        if (acctEntry && acctEntry.name !== canonical.name) {
          acctEntry.name = canonical.name;
          io.write('accounts.json', accounts);
        } else if (!acctEntry) {
          const { type, subtype } = guessAccountTypeSubtype(inst, canonical.name);
          accounts.push({
            id: `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: canonical.name, institution: inst, type, subtype,
            last4: l4, source: 'pdf_import',
            createdAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
          });
          io.write('accounts.json', accounts);
        }
      }
      if (consolidated > 0) {
        writeMeta(meta, userId);
        console.log(`[vault/auto-organize] Consolidated ${consolidated} files across duplicate account folders`);
      }

      // ── Rename pass (runs in both modes) — canonical filename for Bank Statement PDFs ─
      // Renames files that have last4 + year + month tags but non-canonical names.
      // Target format: "{last4} Statement {MonAbbr} {YYYY}.pdf"
      // If the canonical name already exists in the same folder, the file being renamed
      // is a period-exact duplicate — it is deleted automatically.
      let renamed = 0;
      const bankStmtFiles = meta.files.filter(f =>
        f.type === 'pdf' &&
        f.tags?.last4 && f.tags?.year && f.tags?.month &&
        f.folderPath && f.folderPath.startsWith('Bank Statements/')
      );
      let dupeRemoved = 0;
      for (const f of bankStmtFiles) {
        const canonical = stmtFilename(f.tags.last4, f.tags.year, f.tags.month);
        if (f.name === canonical) continue; // already correct
        const dir     = path.join(vaultDir, f.folderPath);
        const oldPath = path.join(dir, f.name);
        if (!fs.existsSync(oldPath)) continue;

        // If canonical name already exists (owned by a DIFFERENT meta entry) → duplicate
        if (fs.existsSync(path.join(dir, canonical))) {
          try {
            const archDir = path.join(vaultDir, '_deleted', `dup_${Date.now()}`);
            fs.mkdirSync(archDir, { recursive: true });
            fs.renameSync(oldPath, path.join(archDir, f.name));
          } catch { try { fs.unlinkSync(oldPath); } catch {} }
          const fi = meta.files.findIndex(x => x.id === f.id);
          if (fi >= 0) meta.files.splice(fi, 1);
          dupeRemoved++;
          console.log(`[vault/auto-organize] Auto-archived duplicate: ${f.name} (kept: ${canonical})`);
          continue;
        }

        // Rename to canonical
        try {
          fs.renameSync(oldPath, path.join(dir, canonical));
          const fi = meta.files.findIndex(x => x.id === f.id);
          if (fi >= 0) meta.files[fi].name = canonical;
          renamed++;
        } catch (e) {
          console.warn(`[vault/auto-organize] rename failed: ${f.name} → ${canonical}:`, e.message);
        }
      }

      // ── Period-exact cleanup: remove any remaining (2)/(3) duplicates ─────────
      // Catches files that were already named with a suffix before this pass ran.
      const periodGroups = {};
      for (const f of meta.files.filter(x =>
        x.type === 'pdf' && x.tags?.last4 && x.tags?.year && x.tags?.month
      )) {
        const key = `${f.tags.last4}::${f.tags.year}::${f.tags.month}`;
        if (!periodGroups[key]) periodGroups[key] = [];
        periodGroups[key].push(f);
      }
      for (const group of Object.values(periodGroups)) {
        if (group.length < 2) continue;
        // Prefer canonical name (no numeric suffix), then shortest name
        group.sort((a, b) => {
          const aIsClean = !/\s\(\d+\)\.pdf$/i.test(a.name);
          const bIsClean = !/\s\(\d+\)\.pdf$/i.test(b.name);
          if (aIsClean !== bIsClean) return aIsClean ? -1 : 1;
          return a.name.length - b.name.length;
        });
        for (const dup of group.slice(1)) {
          const fp = path.join(vaultDir, dup.folderPath, dup.name);
          try {
            if (fs.existsSync(fp)) {
              const archDir = path.join(vaultDir, '_deleted', `dup_${Date.now()}`);
              fs.mkdirSync(archDir, { recursive: true });
              fs.renameSync(fp, path.join(archDir, dup.name));
            }
          } catch { try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {} }
          const fi = meta.files.findIndex(x => x.id === dup.id);
          if (fi >= 0) meta.files.splice(fi, 1);
          dupeRemoved++;
          console.log(`[vault/auto-organize] Auto-archived duplicate: ${dup.name} (kept: ${group[0].name})`);
        }
      }

      if (renamed > 0 || dupeRemoved > 0) {
        writeMeta(meta, userId);
        if (renamed    > 0) console.log(`[vault/auto-organize] Renamed ${renamed} files to canonical format`);
        if (dupeRemoved > 0) console.log(`[vault/auto-organize] Auto-removed ${dupeRemoved} duplicate file(s)`);
      }

      // ── Consolidate-only mode: return after backfill + merge + cleanup ────────
      if (consolidate) {
        return res.json({ processed:0, organized:0, failed:0, skipped:0, fudgedCount:0, consolidated, renamed, duplicatesRemoved: dupeRemoved });
      }

      // ── Step 4: Gather PDF files to organize ──────────────────────────────────
      const pdfFiles = folderId
        ? meta.files.filter(f => f.folderId === folderId && f.type === 'pdf')
        : meta.files.filter(f => f.type === 'pdf' && !f.tags?.institution);

      if (!pdfFiles.length) {
        return res.json({ processed:0, organized:0, failed:0, skipped:0, consolidated });
      }

      // ── Step 5: Sort newest-first so auto-created accounts use current names ─
      const filenameDate = name => {
        const m1 = name.match(/^(\d{8})/);           if (m1) return m1[1];
        const m2 = name.match(/^(\d{4})[-._](\d{2})/); if (m2) return m2[1] + m2[2] + '00';
        return '00000000';
      };
      pdfFiles.sort((a, b) => filenameDate(b.name).localeCompare(filenameDate(a.name)));

      // ── Step 6: Extract metadata in parallel (5 at a time) ───────────────────
      const CONCURRENCY = 5;
      const extracted = [];
      for (let i = 0; i < pdfFiles.length; i += CONCURRENCY) {
        const batch = pdfFiles.slice(i, i + CONCURRENCY);
        const batchOut = await Promise.allSettled(batch.map(async (file) => {
          const filePath = path.join(vaultDir, file.folderPath, file.name);
          if (!fs.existsSync(filePath)) throw new Error('File missing from disk');
          const buffer   = fs.readFileSync(filePath);
          const detected = await extractStatementMeta(buffer);
          return { file, detected };
        }));
        extracted.push(...batchOut);
      }

      const results = { processed:0, organized:0, failed:0, skipped:0, fudgedCount:0, consolidated, duplicatesRemoved:0, details:[] };

      for (const outcome of extracted) {
        if (outcome.status === 'rejected') { results.failed++; continue; }
        const { file, detected } = outcome.value;
        results.processed++;

        // Supplement with filename-based extraction (e.g. "20190116-statements-9092-.pdf")
        const fnLast4M = file.name.match(/statements?[-_](\d{4})/i);
        const fnDateM  = file.name.match(/^(\d{4})(\d{2})\d{2}[-_.]/);
        const fnLast4  = fnLast4M ? fnLast4M[1] : null;
        const fnYear   = fnDateM  ? parseInt(fnDateM[1]) : null;
        const fnMonth  = fnDateM  ? parseInt(fnDateM[2]) : null;

        const inst  = detected.institution;
        const l4    = fnLast4 || detected.last4;
        const aName = detected.accountName;
        const year  = detected.year  || fnYear;
        const month = detected.month || fnMonth;

        // ── Account matching (priority order) ────────────────────────────────
        let matchedAcct = null;
        let autoCreated = false;

        // P1: Plaid accounts first (most authoritative)
        if (l4 && inst) {
          const instKey = inst.toLowerCase().split(' ')[0];
          matchedAcct = accounts.find(a =>
            a.source === 'plaid' && a.last4 === l4 &&
            (a.institution || '').toLowerCase().includes(instKey)
          );
        }
        // P2: any account by last4 + institution
        if (!matchedAcct && l4 && inst) {
          const instKey = inst.toLowerCase().split(' ')[0];
          matchedAcct = accounts.find(a =>
            a.last4 === l4 && (a.institution || '').toLowerCase().includes(instKey)
          );
        }
        // P3: any account by last4 alone
        if (!matchedAcct && l4) matchedAcct = accounts.find(a => a.last4 === l4);
        // P4: existing vault folder for same institution + last4 → use that folder's name
        if (!matchedAcct && l4 && inst) {
          const key          = `${inst.toLowerCase()}:${l4}`;
          const canonicalName = vaultFolderL4Map[key];
          if (canonicalName) {
            matchedAcct = accounts.find(a => a.name === canonicalName &&
              (a.institution||'').toLowerCase().includes(inst.toLowerCase().split(' ')[0])
            );
            if (!matchedAcct) {
              const { type, subtype } = guessAccountTypeSubtype(inst, canonicalName);
              const newAcct = {
                id: `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                name: canonicalName, institution: inst, type, subtype,
                balance: detected.closingBalance ?? 0,
                availableBalance: detected.closingBalance ?? 0,
                last4: l4, source: 'pdf_import',
                createdAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
              };
              accounts.push(newAcct);
              io.write('accounts.json', accounts);
              matchedAcct = newAcct;
              autoCreated = true;
            }
          }
        }
        // P5: match by institution + account name
        if (!matchedAcct && inst && aName) {
          const instKey = inst.toLowerCase().split(' ')[0];
          const nameKey = aName.toLowerCase().split(' ')[0];
          matchedAcct = accounts.find(a =>
            (a.institution || '').toLowerCase().includes(instKey) &&
            (a.name        || '').toLowerCase().includes(nameKey)
          );
        }
        // P6: auto-create (files are sorted newest-first so name comes from current PDF)
        if (!matchedAcct && inst) {
          const { type, subtype } = guessAccountTypeSubtype(inst, aName);
          const newAcct = {
            id:               `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name:             aName ? titleCase(aName) : `${inst} Account`,
            institution:      inst, type, subtype,
            balance:          detected.closingBalance ?? 0,
            availableBalance: detected.closingBalance ?? 0,
            last4:            l4 || null, source: 'pdf_import',
            createdAt:        new Date().toISOString(),
            lastUpdated:      new Date().toISOString(),
          };
          accounts.push(newAcct);
          io.write('accounts.json', accounts);
          matchedAcct = newAcct;
          autoCreated = true;
        }

        if (!matchedAcct || !inst || !year) {
          results.skipped++;
          results.details.push({ file: file.name, status: 'skipped',
            reason: !inst ? 'Institution not detected' : !year ? 'Year not detected' : 'No matching account',
          });
          continue;
        }

        const cleanName  = (matchedAcct.name || inst).replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
        const targetPath = `Bank Statements/${inst}/${cleanName}/${year}`;

        // ── Period duplicate / fudge detection (runs before the already-in-place check) ─
        if (l4 && year && month) {
          const mStr = String(month).padStart(2, '0');
          const existingPeriodFile = meta.files.find(f2 =>
            f2.id !== file.id && f2.type === 'pdf' &&
            f2.folderPath === targetPath &&
            f2.tags?.last4 === String(l4) &&
            f2.tags?.year  === String(year) &&
            f2.tags?.month === mStr
          );
          if (existingPeriodFile) {
            // ── Ghost-file guard ──────────────────────────────────────────────
            // vault.json may reference a file that was renamed/moved (e.g. old
            // "2026-03 TOTAL CHECKING Statement.pdf" → canonical "9092 Statement Mar 2026.pdf").
            // If the physical file no longer exists at the recorded path, the entry
            // is stale. Remove the ghost from vault.json and let this upload proceed.
            const existingPhysPath = path.join(vaultDir, existingPeriodFile.folderPath, existingPeriodFile.name);
            if (!fs.existsSync(existingPhysPath)) {
              console.log(`[vault/auto-organize] Ghost entry removed: ${existingPeriodFile.name} (file missing on disk)`);
              const ghostIdx = meta.files.findIndex(f2 => f2.id === existingPeriodFile.id);
              if (ghostIdx >= 0) meta.files.splice(ghostIdx, 1);
              // fall through — no duplicate, organize normally
            } else {

            // ── Compare transactions to distinguish fudge from true duplicate ──
            // Run in a child process: pdf2json has shared global state that
            // corrupts when a pdfkit "bufferPages" PDF is parsed after another PDF
            // in the same process — resulting in hangs or wrong results.
            let isFudge = false;
            try {
              const { execFileSync } = require('child_process');
              const workerPath = path.join(__dirname, 'fudge-detect-worker.js');
              const origPath   = path.join(vaultDir, existingPeriodFile.folderPath, existingPeriodFile.name);
              const newPath    = path.join(vaultDir, file.folderPath, file.name);
              const tags       = existingPeriodFile.tags || {};
              const raw = execFileSync(
                process.execPath, [workerPath, origPath, newPath, tags.year || '', tags.month || ''],
                { cwd: __dirname, timeout: 30000, maxBuffer: 1024 * 1024 }
              );
              const jsonLine2 = raw.toString().split('\n')
                .map(l => l.trim()).filter(l => l.startsWith('{')).pop() || '{}';
              const { orig: origTxs, new: newTxs } = JSON.parse(jsonLine2);
              if (newTxs.length > 0 && origTxs.length > 0) {
                let fudgeCount = 0, matchCount = 0;
                for (const t2 of newTxs) {
                  const sameDateTxs = origTxs.filter(t1 => t1.date === t2.date);
                  if (!sameDateTxs.length) continue;
                  const minDiff = Math.min(...sameDateTxs.map(t1 =>
                    Math.abs(Math.abs(t2.amount) - Math.abs(t1.amount))
                  ));
                  if (minDiff < 0.02) matchCount++;
                  else fudgeCount++;
                }
                const total = fudgeCount + matchCount;
                isFudge = total >= 2 && (fudgeCount / total) >= 0.2;
                console.log(`[vault/fudge-detect] orig=${origTxs.length} new=${newTxs.length} fudge=${fudgeCount}/${total} isFudge=${isFudge}`);
              }
            } catch (e) {
              console.error('[vault/auto-organize] fudge detection:', e.message);
            }

            if (isFudge) {
              // Rename to a clearly flagged filename and tag as suspicious
              const flaggedName = stmtFilename(l4, year, month).replace('.pdf', '_FLAGGED.pdf');
              const srcPhys     = path.join(vaultDir, file.folderPath, file.name);
              const dstPhys     = path.join(vaultDir, file.folderPath, flaggedName);
              if (file.name !== flaggedName && fs.existsSync(srcPhys)) {
                try { fs.renameSync(srcPhys, dstPhys); } catch {}
              }
              const fi = meta.files.findIndex(f2 => f2.id === file.id);
              if (fi >= 0) {
                if (file.name !== flaggedName) meta.files[fi].name = flaggedName;
                meta.files[fi].tags = {
                  ...meta.files[fi].tags,
                  institution: inst, account: matchedAcct.name,
                  ...(l4    && { last4: String(l4) }),
                  ...(year  && { year:  String(year) }),
                  ...(month && { month: mStr }),
                  fudge: true, fudgeOf: existingPeriodFile.id,
                };
              }
              results.fudgedCount = (results.fudgedCount || 0) + 1;
              console.log(`[vault/auto-organize] Fudge detected: ${file.name} vs ${existingPeriodFile.name}`);
              continue;
            } else if (file.folderPath !== targetPath) {
              // True duplicate arriving from a different folder — archive to _deleted
              const srcPath = path.join(vaultDir, file.folderPath, file.name);
              try {
                if (fs.existsSync(srcPath)) {
                  const archDir = path.join(vaultDir, '_deleted', `dup_${Date.now()}`);
                  fs.mkdirSync(archDir, { recursive: true });
                  fs.renameSync(srcPath, path.join(archDir, file.name));
                }
              } catch { try { if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath); } catch {} }
              const fi = meta.files.findIndex(f2 => f2.id === file.id);
              if (fi >= 0) meta.files.splice(fi, 1);
              results.duplicatesRemoved++;
              console.log(`[vault/auto-organize] Auto-archived duplicate: ${file.name} (kept: ${existingPeriodFile.name})`);
              continue;
            } else {
              // True duplicate already in target folder — silently ignore
              continue;
            }
            } // end ghost-file else
          }
        }

        // Already in the correct place with no period conflict — skip silently (not an error)
        if (file.folderPath === targetPath) { continue; }

        // Move physical file — use canonical filename immediately if we have all tags
        const targetFolderId = ensureFolderPath(targetPath);
        let   dstName = (l4 && year && month) ? stmtFilename(l4, year, month) : file.name;
        if (fs.existsSync(path.join(vaultDir, targetPath, dstName))) {
          // Shouldn't reach here (period-exact check above should have caught it),
          // but guard just in case a file exists on disk but not in meta
          const base = path.basename(dstName, path.extname(dstName));
          dstName    = `${base}_${Date.now()}${path.extname(dstName)}`;
        }
        fs.renameSync(
          path.join(vaultDir, file.folderPath, file.name),
          path.join(vaultDir, targetPath, dstName)
        );

        const fileIdx = meta.files.findIndex(f2 => f2.id === file.id);
        if (fileIdx >= 0) {
          meta.files[fileIdx].name       = dstName;
          meta.files[fileIdx].folderPath = targetPath;
          meta.files[fileIdx].folderId   = targetFolderId;
          meta.files[fileIdx].tags = {
            ...meta.files[fileIdx].tags,
            institution: inst, account: matchedAcct.name,
            ...(l4    && { last4: l4 }),
            ...(year  && { year:  String(year) }),
            ...(month && { month: String(month).padStart(2, '0') }),
          };
        }
        results.organized++;
        results.details.push({ file: dstName, status: 'organized', targetPath,
          institution: inst, account: matchedAcct.name, year, month, autoCreated });
      }

      writeMeta(meta, userId);

      // ── Clean up source folder and any now-empty ancestor folders ───────────
      // Walk up the parentId chain, removing every folder that becomes empty
      // after its children are organized out. This prevents ghost empty parent
      // folders (e.g. "statements") from lingering and blocking future re-uploads.
      if (folderId) {
        let cleanId      = folderId;
        let firstDeleted = null;
        while (cleanId) {
          const cleanHasFiles    = meta.files.some(f => f.folderId === cleanId);
          const cleanHasChildren = meta.folders.some(f => f.parentId === cleanId);
          if (cleanHasFiles || cleanHasChildren) break; // still has content — stop
          const cleanFolder = meta.folders.find(f => f.id === cleanId);
          if (!cleanFolder) break;
          if (!firstDeleted) firstDeleted = cleanFolder; // remember the first (deepest) one
          const nextParent = cleanFolder.parentId;
          try {
            const physPath = path.join(vaultDir, cleanFolder.path);
            if (fs.existsSync(physPath)) fs.rmSync(physPath, { recursive: true, force: true });
          } catch {}
          meta.folders = meta.folders.filter(f => f.id !== cleanId);
          cleanId = nextParent;
        }
        if (firstDeleted) {
          writeMeta(meta, userId);
          results.sourceFolderDeleted = true;
          results.sourceFolderName    = firstDeleted.name;
        }
      }

      results.renamed = renamed;
      console.log(`[vault/auto-organize] ${results.organized}/${results.processed} sorted, ${results.duplicatesRemoved} dupes removed, ${results.fudgedCount} flagged, ${results.skipped} skipped, ${results.failed} failed, ${consolidated} consolidated, ${renamed} renamed`);
      res.json(results);
    } catch (e) {
      console.error('[vault/auto-organize]', e.message);
      res.status(500).json({ error: e.message });
    }
  };
};
