'use strict';
/**
 * backfill-mortgage-statements.js — parse ALREADY-INGESTED mortgage statement PDFs
 * (documents rows with doc_type='mortgage') into the mortgage domain tables.
 *
 * The live pipelines only cover NEW data: scraper-import parses statements as they're
 * ingested, and Plaid Liabilities fills the account snapshot on sync. Statements that
 * were uploaded before the mortgage domain existed sit in `documents` unparsed — this
 * script replays them through the same parseMortgageStatement → recordMortgageStatement
 * path. Idempotent (deterministic mstmt_/mpay_ ids upsert), so re-runs are safe.
 *
 * Statements are recorded in statement-date order so the account's rolling figures
 * (current_principal / monthly_payment / next_due_date) end at the newest statement,
 * and only the FINAL statement's alerts are kept — replaying two years of history
 * should not flood mortgage_alerts.json with stale payment-changed noise.
 *
 *   node server/scripts/backfill-mortgage-statements.js [userId] [--apply]
 *
 * Dry-run by default: prints what each PDF parsed to and what would be recorded.
 */
require('./_env');
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const { query } = require('../core/db');
const documents = require('../core/documents');
const store = require('../core/store');
const { parseMortgageStatement, grabPropertyAddress } = require('../banking/mortgage-parse');
const mort = require('../banking/mortgage');

const SERVICER_NAMES = { rocket: 'Rocket Mortgage', mrcooper: 'Mr. Cooper', fay: 'Fay Servicing', chase: 'Chase', wells: 'Wells Fargo', boa: 'Bank of America' };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function pdftotext(buf) {
  const tmp = path.join(os.tmpdir(), `mortbf_${process.pid}_${Math.random().toString(36).slice(2, 7)}.pdf`);
  try { fs.writeFileSync(tmp, buf); return execFileSync('pdftotext', ['-layout', tmp, '-'], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }).toString(); }
  catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// The servicer printed ON the statement beats the (sometimes stale) vault tag.
function detectServicer(text, tags) {
  if (/mrcooper\.com|Mr\.?\s*Cooper/i.test(text)) return 'Mr. Cooper';
  if (/Rocket\s*Mortgage/i.test(text)) return 'Rocket Mortgage';
  if (/Fay\s*Servicing/i.test(text)) return 'Fay Servicing';
  const tag = norm(tags?.servicer).replace(/\s/g, '');
  return SERVICER_NAMES[tag] || (tags?.servicer || null);
}

// Property by filename ("Kobe Pl May 2026.pdf" → kobe) or the printed property address.
function detectPropertyId(properties, filename, text) {
  const fname = norm(filename);
  const m = text.match(/Property\s*address[^\S\n]*:?[^\S\n]*\n?[^\S\n]*([^\n]{4,60})/i);
  const street = norm(m ? m[1] : '');
  for (const p of properties || []) {
    const pName = norm(p.name);
    if (!pName) continue;
    if (fname.includes(pName) || (street && street.includes(pName))) return p.id;
    const pStreet = norm((p.address || p.addr || '').split(',')[0]);
    if (pStreet && street && (street.includes(pStreet) || pStreet.includes(street))) return p.id;
  }
  return null;
}

(async () => {
  const apply = process.argv.includes('--apply');
  let userId = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!userId) {
    const r = await query(`SELECT user_id, COUNT(*) n FROM documents WHERE doc_type='mortgage' GROUP BY user_id ORDER BY n DESC LIMIT 1`);
    userId = r.rows[0]?.user_id;
  }
  if (!userId) { console.log('No mortgage documents found for any user.'); process.exit(0); }

  await store.preloadAll();                       // io reads (transactions for payment matching)
  const properties = store.read('properties.json', userId) || [];
  const loanAccts  = (await query(`SELECT id, mask FROM accounts WHERE user_id=$1 AND account_class='loan'`, [userId])).rows;

  const docs = (await query(
    `SELECT id, original_name, sha256, tags FROM documents
      WHERE user_id=$1 AND doc_type='mortgage' ORDER BY uploaded_at`, [userId])).rows
    .filter(d => (d.tags?.type || '') !== 'tax');

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — user ${userId}, ${docs.length} mortgage statement PDF(s)\n`);

  // 1) Parse everything first (dedup identical bytes by sha) …
  const seen = new Set(); const parsed = []; const skipped = [];
  for (const d of docs) {
    if (d.sha256 && seen.has(d.sha256)) { skipped.push({ d, why: 'duplicate bytes (same sha256)' }); continue; }
    if (d.sha256) seen.add(d.sha256);
    let bytes = null; try { bytes = await documents.getDocumentBytes(userId, d.id); } catch {}
    const text = bytes ? pdftotext(bytes) : '';
    if (!text) { skipped.push({ d, why: bytes ? 'pdftotext produced no text' : 'bytes unavailable' }); continue; }
    const p = parseMortgageStatement(text);
    if (!p.statementDate) { skipped.push({ d, why: `no statement date (status=${p.parserStatus})` }); continue; }
    parsed.push({ d, p, servicer: detectServicer(text, d.tags), propertyId: detectPropertyId(properties, d.original_name, text),
                  address: grabPropertyAddress(text) });
  }

  // … 2) then record in statement-date order so account rollups end at the newest.
  parsed.sort((a, b) => String(a.p.statementDate).localeCompare(String(b.p.statementDate)));

  for (const row of parsed) {
    const acct = loanAccts.find(a => a.mask && a.mask === row.p.loanNumberMask);
    console.log(`  ${row.p.statementDate}  ${row.d.original_name}`);
    console.log(`      due ${row.p.dueDate || '?'}  amount $${row.p.amountDue ?? '?'}  principal $${row.p.principalBalance ?? '?'}  P/I ${row.p.principalPaid ?? '?'}/${row.p.interestPaid ?? '?'}  rate ${row.p.interestRate ?? '?'}%`);
    console.log(`      servicer=${row.servicer || '?'}  property=${row.propertyId || '?'}  loan…${row.p.loanNumberMask || '?'}  bankAcct=${acct ? acct.id.slice(0, 8) + '…' : 'none'}`);
  }
  if (skipped.length) { console.log(`\nSKIPPED: ${skipped.length}`); for (const s of skipped) console.log(`  ${s.d.original_name} — ${s.why}`); }
  if (!apply) { console.log('\n(dry run — re-run with --apply)'); process.exit(0); }
  if (!parsed.length) { console.log('\nNothing to record.'); process.exit(0); }

  // One upsert per loan, keyed off the NEWEST statement (current servicer wins the label).
  const latest = parsed[parsed.length - 1];
  const linked = loanAccts.find(a => a.mask && a.mask === latest.p.loanNumberMask);
  const macctId = await mort.upsertMortgageAccount(query, userId, {
    accountId: linked?.id || null,
    propertyId: latest.propertyId,
    servicer: latest.servicer,
    loanMask: latest.p.loanNumberMask,
    loanNumber: latest.p.loanNumber,
    interestRate: latest.p.interestRate,
  });
  // The printed property address fills the Plaid-Liabilities columns until consent is granted.
  const addr = latest.address || parsed.map(r => r.address).filter(Boolean).pop();
  if (addr) {
    await query(
      `UPDATE mortgage_accounts SET
         property_street=COALESCE(property_street,$2), property_city=COALESCE(property_city,$3),
         property_region=COALESCE(property_region,$4), property_postal_code=COALESCE(property_postal_code,$5),
         servicer=$6, updated_at=NOW()
       WHERE id=$1`,
      [macctId, addr.street, addr.city, addr.region, addr.postalCode, latest.servicer]);
  }

  // Alerts from historical replays are noise; keep only the ones the FINAL statement raises.
  let lastAlerts = [];
  const quietIO = {
    read: (f) => (f === 'mortgage_alerts.json' ? [] : store.read(f, userId)),
    write: (f, v) => { if (f === 'mortgage_alerts.json') lastAlerts = v; },
  };
  let recorded = 0, matched = 0;
  for (const row of parsed) {
    lastAlerts = [];
    const res = await mort.recordMortgageStatement(query, quietIO, userId, {
      mortgageAccountId: macctId, documentId: row.d.id, parsed: row.p, servicer: row.servicer,
    });
    recorded++; if (res.matchedTxnId) matched++;
  }
  if (lastAlerts.length) {
    const prev = store.read('mortgage_alerts.json', userId) || [];
    const fresh = lastAlerts.filter(a => !prev.some(p0 => p0.kind === a.kind && p0.mortgageAccountId === a.mortgageAccountId && p0.message === a.message));
    if (fresh.length) store.write('mortgage_alerts.json', [...fresh, ...prev].slice(0, 200), userId);
  }
  await store.flush();
  console.log(`\n✓ recorded ${recorded} statement(s) into ${macctId} (${matched} payment(s) matched to a bank transaction)`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(1); });
