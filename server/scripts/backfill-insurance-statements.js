'use strict';
/**
 * backfill-insurance-statements.js — replay ALREADY-FILED vault documents through the
 * insurance / tax-schedule recorders.
 *
 * The live pipelines only cover NEW uploads (vault auto-organize and chatbot doc-ingest
 * run the domain recorder as they file). Documents that were filed before the insurance
 * domain existed — or that were sorted manually — sit in `documents` unparsed. This
 * script replays them through the SAME domain hook (vault/domain-hooks.js), so parsing
 * logic still exists exactly once. Idempotent (deterministic istmt_/ipay_/txsch_ ids
 * upsert), so re-runs are safe. This is also the manual re-parse lever — script, not a
 * button.
 *
 *   node server/scripts/backfill-insurance-statements.js [userId] [--apply] [--tax]
 *
 * Dry-run by default: prints what each PDF parsed to and what would be recorded.
 * --tax also replays tax_form documents through the payment-schedule extractor (those
 * cost a Groq call each, so they're opt-in).
 */
require('./_env');
const { query } = require('../core/db');
const documents = require('../core/documents');
const store = require('../core/store');
const { parseInsuranceStatement } = require('../banking/insurance-parse');
const { extractRawText } = require('../core/pdf-parser');

(async () => {
  const apply = process.argv.includes('--apply');
  const doTax = process.argv.includes('--tax');
  let userId = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!userId) {
    const r = await query(
      `SELECT user_id, COUNT(*) n FROM documents WHERE tags->>'docType' IN ('insurance_statement','tax_form') GROUP BY user_id ORDER BY n DESC LIMIT 1`);
    userId = r.rows[0]?.user_id;
  }
  if (!userId) { console.log('No insurance/tax documents found for any user.'); process.exit(0); }

  await store.preloadAll();
  const io = { read: (f) => store.read(f, userId), write: (f, v) => store.write(f, v, userId) };

  const wanted = doTax ? `('insurance_statement','tax_form')` : `('insurance_statement')`;
  const docs = (await query(
    `SELECT id, original_name, tags FROM documents
      WHERE user_id=$1 AND tags->>'docType' IN ${wanted} ORDER BY uploaded_at`, [userId])).rows;

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — user ${userId}, ${docs.length} document(s)${doTax ? ' (incl. tax forms)' : ''}\n`);

  let recorded = 0, skipped = 0;
  for (const d of docs) {
    const docType = d.tags?.docType;
    let bytes = null; try { bytes = await documents.getDocumentBytes(userId, d.id); } catch {}
    if (!bytes) { console.log(`  SKIP ${d.original_name} — bytes unavailable`); skipped++; continue; }
    let text = ''; try { text = (await extractRawText(bytes) || '').trim(); } catch {}

    const isPhoto = bytes[0] === 0xff && bytes[1] === 0xd8 || (bytes[0] === 0x89 && bytes[1] === 0x50);
    if (!apply) {
      if (isPhoto) {
        console.log(`  ${d.original_name} — photo (Groq vision extraction runs on --apply)`);
      } else if (docType === 'insurance_statement') {
        const p = parseInsuranceStatement(text);
        console.log(`  ${d.original_name}`);
        console.log(`      carrier=${p.carrier || '?'}  ${p.coverageType || '?'}  policy…${p.policyNumberMask || '?'}  due ${p.dueDate || '?'}  $${p.amountDue ?? '?'}  (${p.parserStatus}, conf ${p.confidence})`);
      } else {
        console.log(`  ${d.original_name} — tax form (schedule extraction runs on --apply)`);
      }
      continue;
    }

    try {
      const { runDomainRecorder } = require('../vault/domain-hooks');
      const decision = { docType, institution: d.tags?.institution || null, coverageType: d.tags?.coverageType || null,
                         propertyAddress: d.tags?.street || null };
      const res = await runDomainRecorder(io, userId, { docType, fileId: d.id, buffer: bytes, text, decision });
      if (res && res.recorded) { recorded++; console.log(`  ✓ ${d.original_name}`); }
      else { skipped++; console.log(`  SKIP ${d.original_name} — ${res?.reason || 'recorder declined'}`); }
    } catch (e) { skipped++; console.log(`  FAIL ${d.original_name} — ${e.message}`); }
  }

  if (!apply) { console.log('\n(dry run — re-run with --apply)'); process.exit(0); }
  await store.flush();
  console.log(`\n✓ recorded ${recorded} document(s), ${skipped} skipped`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(1); });
