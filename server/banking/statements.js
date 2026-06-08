const PDFDocument = require('pdfkit');
const express     = require('express');
const fs          = require('fs');
const path        = require('path');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const fmtAmt  = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtDate = s => { const [y, m, d] = s.split('-'); return `${m}/${d}/${y.slice(2)}`; };

const mkFolderId = () => `folder_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
const mkFileId   = () => `file_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

function ensureVaultFolder(meta, folderPath, vaultDir) {
  const parts = folderPath.split('/').filter(Boolean);
  let parentId = null;
  for (let i = 0; i < parts.length; i++) {
    const fullPath = parts.slice(0, i+1).join('/');
    let f = meta.folders.find(x => x.path === fullPath);
    if (!f) {
      f = { id: mkFolderId(), name: parts[i], path: fullPath, parentId, createdAt: new Date().toISOString(), tags: {} };
      meta.folders.push(f);
      fs.mkdirSync(path.join(vaultDir, fullPath), { recursive: true });
    }
    parentId = f.id;
  }
  return parentId;
}

// ── PDF generation ────────────────────────────────────────────────────────
function buildStatementPDF(account, txList, year, month) {
  return new Promise((resolve, reject) => {
    const doc  = new PDFDocument({ size: 'LETTER', bufferPages: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end',  () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    const W  = 612, H = 792, L = 50, R = 562, CW = 512;
    const C  = {
      navy:'#1C2B3A', blue:'#378ADD', lblue:'#EBF4FC',
      lgray:'#F8F9FA', gray:'#6B7280', dgray:'#374151',
      border:'#E5E7EB', white:'#FFFFFF', black:'#111827',
      green:'#047857', red:'#B91C1C',
    };

    const txs         = [...txList].filter(t => !t.pending).sort((a, b) => a.date.localeCompare(b.date));
    const deposits    = txs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const withdrawals = txs.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
    const net         = deposits + withdrawals;
    const monthName   = MONTHS[parseInt(month, 10) - 1];
    const daysInMo    = new Date(parseInt(year), parseInt(month), 0).getDate();

    // ── Header ───────────────────────────────────────────────────────────
    doc.rect(0, 0, W, 72).fill(C.navy);
    doc.fontSize(20).font('Helvetica-Bold').fillColor(C.white).text('CaiShen', L, 18, { lineBreak: false });
    doc.fontSize(7.5).font('Helvetica').fillColor('#7BA8C8').text('PERSONAL FINANCE OS', L, 44, { lineBreak: false });
    doc.fontSize(15).font('Helvetica-Bold').fillColor(C.white).text('Account Statement', 0, 20, { width: R, align: 'right', lineBreak: false });
    doc.fontSize(7.5).font('Helvetica').fillColor('#7BA8C8').text(`${monthName} ${year}`, 0, 44, { width: R, align: 'right', lineBreak: false });

    // ── Account bar ──────────────────────────────────────────────────────
    doc.rect(0, 72, W, 52).fill(C.lblue);
    const last4 = account.last4 ? ` ••••${account.last4}` : '';
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.navy).text(`${account.name}${last4}`, L, 82, { lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(C.gray)
      .text(`${account.institution || ''} · ${(account.type || 'account').toUpperCase()} · ${monthName} 1 – ${monthName} ${daysInMo}, ${year}`, L, 99, { lineBreak: false });

    // ── Summary cards ────────────────────────────────────────────────────
    const cardTop = 136, cardH = 54, cardW = (CW - 18) / 4;
    [
      { label: 'TOTAL DEPOSITS',    val: fmtAmt(deposits),                                       color: C.green },
      { label: 'TOTAL WITHDRAWALS', val: fmtAmt(Math.abs(withdrawals)),                           color: C.red   },
      { label: 'NET CHANGE',        val: (net >= 0 ? '+' : '') + fmtAmt(net),                    color: net >= 0 ? C.green : C.red },
      { label: 'TRANSACTIONS',      val: String(txs.length),                                      color: C.navy  },
    ].forEach((card, i) => {
      const cx = L + i * (cardW + 6);
      doc.rect(cx, cardTop, cardW, cardH).fill(C.lgray).stroke(C.border);
      doc.rect(cx, cardTop, 3, cardH).fill(card.color);
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor(C.gray).text(card.label, cx + 10, cardTop + 10, { width: cardW - 14, lineBreak: false });
      doc.fontSize(13).font('Helvetica-Bold').fillColor(card.color).text(card.val, cx + 10, cardTop + 26, { width: cardW - 14, lineBreak: false });
    });

    // ── Table ────────────────────────────────────────────────────────────
    const COLS = [
      { label: 'DATE',        x: L,        w: 56               },
      { label: 'DESCRIPTION', x: L + 61,   w: 183              },
      { label: 'CATEGORY',    x: L + 249,  w: 104              },
      { label: 'AMOUNT',      x: L + 358,  w: 90,  right: true },
      { label: 'TYPE',        x: L + 453,  w: 59,  right: true },
    ];
    const ROW_H = 19, HDR_H = 22, FOOTER_ZONE = 55;

    function drawTableHeader(y) {
      doc.rect(L, y, CW, HDR_H).fill(C.navy);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C.white);
      COLS.forEach(c => doc.text(c.label, c.x + (c.right ? 0 : 4), y + 7, { width: c.w, align: c.right ? 'right' : 'left', lineBreak: false }));
      return y + HDR_H;
    }

    let curY = drawTableHeader(cardTop + cardH + 14);

    txs.forEach((tx, i) => {
      if (curY + ROW_H > H - FOOTER_ZONE) {
        doc.addPage();
        curY = drawTableHeader(30);
      }
      if (i % 2 === 1) doc.rect(L, curY, CW, ROW_H).fill(C.lgray);
      doc.moveTo(L, curY + ROW_H).lineTo(R, curY + ROW_H).strokeColor(C.border).lineWidth(0.3).stroke();

      doc.fontSize(7.5).font('Helvetica').fillColor(C.black)
        .text(fmtDate(tx.date),      COLS[0].x + 4, curY + 5, { width: COLS[0].w - 4, lineBreak: false })
        .text(tx.desc || '',          COLS[1].x + 4, curY + 5, { width: COLS[1].w - 8, lineBreak: false })
        .text(tx.category || 'Other', COLS[2].x + 4, curY + 5, { width: COLS[2].w - 8, lineBreak: false });
      doc.fillColor(tx.amount >= 0 ? C.green : C.red)
        .text(fmtAmt(tx.amount), COLS[3].x, curY + 5, { width: COLS[3].w, align: 'right', lineBreak: false });
      doc.fillColor(tx.amount >= 0 ? C.green : C.gray)
        .text(tx.amount >= 0 ? 'Credit' : 'Debit', COLS[4].x, curY + 5, { width: COLS[4].w, align: 'right', lineBreak: false });
      curY += ROW_H;
    });

    // ── Net change totals row ────────────────────────────────────────────
    if (curY + 40 > H - FOOTER_ZONE) { doc.addPage(); curY = 30; }
    curY += 6;
    doc.moveTo(L, curY).lineTo(R, curY).strokeColor(C.dgray).lineWidth(0.75).stroke();
    curY += 8;
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C.navy).text('Net Change', L + 4, curY, { lineBreak: false });
    doc.fillColor(net >= 0 ? C.green : C.red)
      .text((net >= 0 ? '+' : '') + fmtAmt(net), COLS[3].x, curY, { width: COLS[3].w, align: 'right', lineBreak: false });
    curY += 13;
    doc.fontSize(7).font('Helvetica').fillColor(C.gray)
      .text(
        `${txs.length} settled transactions · ${txs.filter(t => t.amount > 0).length} credits · ${txs.filter(t => t.amount < 0).length} debits`,
        L + 4, curY, { lineBreak: false }
      );

    // ── Footer on every page ─────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    const total = range.count;
    const genDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    for (let p = 0; p < total; p++) {
      doc.switchToPage(range.start + p);
      const fy = H - 38;
      doc.moveTo(L, fy).lineTo(R, fy).strokeColor(C.border).lineWidth(0.5).stroke();
      doc.fontSize(7).font('Helvetica').fillColor(C.gray)
        .text(`Generated by CaiShen  ·  ${genDate}  ·  For personal use only  ·  Page ${p + 1} of ${total}`, L, fy + 9, { width: CW, align: 'center', lineBreak: false });
    }

    doc.end();
  });
}

// ── Core: generate all missing monthly statements for a user ──────────────
async function generateForUser(userId, makeIO, BASE_VAULT_DIR) {
  const io        = makeIO(userId);
  const vaultDir  = path.join(BASE_VAULT_DIR, 'users', userId);
  const accounts  = io.read('accounts.json')      || [];
  const allTxs    = io.read('transactions.json')   || [];
  const plaidAccts = accounts.filter(a => a.source === 'plaid');
  if (!plaidAccts.length) return { generated: 0, skipped: 0 };

  const byAcctMonth = {};
  for (const tx of allTxs) {
    if (!tx.account || !tx.month || tx.pending) continue;
    const key = `${tx.account}::${tx.month}`;
    (byAcctMonth[key] ??= []).push(tx);
  }

  const meta = io.read('vault.json') || { folders: [], files: [] };
  let generated = 0, skipped = 0;

  for (const acct of plaidAccts) {
    const months = [...new Set(
      Object.keys(byAcctMonth)
        .filter(k => k.startsWith(acct.id + '::'))
        .map(k => k.split('::')[1])
    )].sort();

    // Sanitize account name for use as a folder (strip Windows-unsafe chars)
    const acctFolder = (acct.name || acct.subtype || 'Account')
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Account';

    for (const monthStr of months) {
      const [year, month] = monthStr.split('-');
      const folderPath    = `Bank Statements/${acct.institution || 'Unknown'}/${acctFolder}/${year}`;
      const fileName      = `${year}-${month} ${acct.name} Statement.pdf`;

      // Remove old-format duplicate (Bank Statements/{inst}/{year}/{fileName}) if it exists
      const oldFolderPath = `Bank Statements/${acct.institution || 'Unknown'}/${year}`;
      const oldFolder     = meta.folders.find(f => f.path === oldFolderPath);
      if (oldFolder) {
        const oldFile = meta.files.find(f => f.folderId === oldFolder.id && f.name === fileName);
        if (oldFile) {
          const oldPhys = path.join(vaultDir, oldFolderPath, fileName);
          if (fs.existsSync(oldPhys)) fs.unlinkSync(oldPhys);
          meta.files = meta.files.filter(f => f.id !== oldFile.id);
        }
      }

      // Skip if this period is already covered by ANY vault file (real bank PDF or
      // previously-generated statement) — match on year + month + last4 so the
      // canonical-named bank PDFs ("9092 Statement Feb 2026.pdf") are treated as
      // equivalent and we don't regenerate on every cron cycle.
      const periodAlreadyPresent = meta.files.some(f =>
        f.type === 'pdf' &&
        String(f.tags?.year)  === String(year)  &&
        String(f.tags?.month) === String(month) &&
        (acct.last4
          ? String(f.tags?.last4) === String(acct.last4)
          : f.tags?.account === acct.name)
      );
      if (periodAlreadyPresent) { skipped++; continue; }

      // Fallback exact-name check (pre-existing entries without last4 tag)
      const existingFolder = meta.folders.find(f => f.path === folderPath);
      if (existingFolder && meta.files.find(f => f.folderId === existingFolder.id && f.name === fileName)) {
        skipped++; continue;
      }

      const txs = byAcctMonth[`${acct.id}::${monthStr}`] || [];
      if (!txs.length) continue;

      try {
        const pdfBuf   = await buildStatementPDF(acct, txs, year, month);
        const folderId = ensureVaultFolder(meta, folderPath, vaultDir);
        const physPath = path.join(vaultDir, folderPath);
        fs.mkdirSync(physPath, { recursive: true });
        fs.writeFileSync(path.join(physPath, fileName), pdfBuf);
        const deposits    = txs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
        const withdrawals = txs.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
        meta.files.push({
          id: mkFileId(), name: fileName, folderId, folderPath,
          size: pdfBuf.length, type: 'pdf', mimeType: 'application/pdf',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          version: 1, tags: {
            institution: acct.institution, year, month, account: acct.name,
            income: +deposits.toFixed(2), spending: +withdrawals.toFixed(2),
            net: +(deposits + withdrawals).toFixed(2), txCount: txs.length,
          },
        });
        generated++;
        console.log(`[Statements] Created ${folderPath}/${fileName} (user ${userId})`);
      } catch (e) {
        console.error(`[Statements] Error generating ${fileName}:`, e.message);
      }
    }
  }

  // Clean up any leftover old-format year folders (Bank Statements/{inst}/{year})
  // that are now empty after file migration
  meta.folders = meta.folders.filter(f => {
    const parts = f.path.split('/');
    // Old format: exactly 3 parts where last part is a 4-digit year
    if (parts.length === 3 && parts[0] === 'Bank Statements' && /^\d{4}$/.test(parts[2])) {
      const hasFiles = meta.files.some(file => file.folderId === f.id);
      if (!hasFiles) {
        const physPath = path.join(vaultDir, f.path);
        if (fs.existsSync(physPath)) {
          try { fs.rmdirSync(physPath); } catch (_) {}
        }
        return false; // remove from meta
      }
    }
    return true;
  });

  io.write('vault.json', meta);
  return { generated, skipped };
}

// ── Express module export ─────────────────────────────────────────────────
module.exports = function(makeIO, BASE_VAULT_DIR) {
  const router = express.Router();

  router.post('/generate', async (req, res) => {
    try {
      const result = await generateForUser(req.user.id, makeIO, BASE_VAULT_DIR);
      res.json(result);
    } catch (e) {
      console.error('[Statements] Error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /months — available months per account with statement existence ─
  router.get('/months', (req, res) => {
    const io       = makeIO(req.user.id);
    const accounts = io.read('accounts.json')    || [];
    const allTxs   = io.read('transactions.json') || [];
    const meta     = io.read('vault.json')        || { folders: [], files: [] };

    const plaidAccts = accounts.filter(a => a.source === 'plaid');
    const result = plaidAccts.map(acct => {
      // Count transactions per month
      const monthMap = {};
      for (const tx of allTxs) {
        if (tx.account !== acct.id || tx.pending || !tx.month) continue;
        monthMap[tx.month] = (monthMap[tx.month] || 0) + 1;
      }
      const acctFolder = (acct.name || acct.subtype || 'Account')
        .replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim() || 'Account';

      const months = Object.entries(monthMap).map(([monthStr, txCount]) => {
        const [year, month] = monthStr.split('-');
        const folderPath    = `Bank Statements/${acct.institution || 'Unknown'}/${acctFolder}/${year}`;
        const fileName      = `${year}-${month} ${acct.name} Statement.pdf`;
        const folder        = meta.folders.find(f => f.path === folderPath);
        const hasStatement  = !!(folder && meta.files.find(f => f.folderId === folder.id && f.name === fileName));
        return { month: monthStr, txCount, hasStatement };
      }).sort((a, b) => b.month.localeCompare(a.month));

      return {
        id: acct.id, name: acct.name,
        institution: acct.institution, last4: acct.last4,
        months,
        missingCount: months.filter(m => !m.hasStatement).length,
      };
    }).filter(a => a.months.length > 0);

    res.json(result);
  });

  // ── POST /generate-single — generate one month's statement ─────────────
  router.post('/generate-single', async (req, res) => {
    const { accountId, month } = req.body;
    if (!accountId || !month) return res.status(400).json({ error: 'accountId and month required' });

    const io       = makeIO(req.user.id);
    const vaultDir = path.join(BASE_VAULT_DIR, 'users', req.user.id);
    const accounts = io.read('accounts.json')    || [];
    const allTxs   = io.read('transactions.json') || [];
    const meta     = io.read('vault.json')        || { folders: [], files: [] };

    const acct = accounts.find(a => a.id === accountId);
    if (!acct) return res.status(404).json({ error: 'Account not found' });

    const [year, monthNum] = month.split('-');
    const txs = allTxs.filter(t => t.account === accountId && t.month === month && !t.pending);
    if (!txs.length) return res.status(400).json({ error: 'No transactions for this month' });

    const acctFolder = (acct.name || acct.subtype || 'Account')
      .replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim() || 'Account';
    const folderPath = `Bank Statements/${acct.institution || 'Unknown'}/${acctFolder}/${year}`;
    const fileName   = `${year}-${monthNum} ${acct.name} Statement.pdf`;

    try {
      const pdfBuf      = await buildStatementPDF(acct, txs, year, monthNum);
      const folderId    = ensureVaultFolder(meta, folderPath, vaultDir);
      const physPath    = path.join(vaultDir, folderPath);
      fs.mkdirSync(physPath, { recursive: true });
      fs.writeFileSync(path.join(physPath, fileName), pdfBuf);
      // Remove stale entry if any, then insert fresh
      const existingFolder = meta.folders.find(f => f.path === folderPath);
      if (existingFolder) {
        const old = meta.files.find(f => f.folderId === existingFolder.id && f.name === fileName);
        if (old) meta.files = meta.files.filter(f => f.id !== old.id);
      }
      const deps = txs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
      const wds  = txs.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
      meta.files.push({
        id: mkFileId(), name: fileName, folderId, folderPath,
        size: pdfBuf.length, type: 'pdf', mimeType: 'application/pdf',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        version: 1, tags: {
          institution: acct.institution, year, month: monthNum, account: acct.name,
          income: +deps.toFixed(2), spending: +wds.toFixed(2),
          net: +(deps + wds).toFixed(2), txCount: txs.length,
        },
      });
      io.write('vault.json', meta);
      console.log(`[Statements] Generated ${folderPath}/${fileName} (user ${req.user.id})`);
      res.json({ generated: 1, fileName });
    } catch (e) {
      console.error('[Statements] generate-single error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return { router, generateForUser: (userId) => generateForUser(userId, makeIO, BASE_VAULT_DIR) };
};

// Expose buildStatementPDF for use in tests
module.exports.buildStatementPDF = buildStatementPDF;
