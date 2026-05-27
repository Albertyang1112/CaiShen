/**
 * fudge-detect-worker.js
 * Run by vault.js via child_process in an isolated process so pdf2json
 * state from previous parses doesn't bleed into the comparison.
 *
 * Usage:  node fudge-detect-worker.js <origPath> <newPath> <year> <month>
 * Stdout: single JSON line { origAmounts: [...], newAmounts: [...] }
 */
'use strict';

const { parsePDFTransactions } = require('./pdf-parser');
const fs = require('fs');

const [, , origPath, newPath, year, month] = process.argv;

async function run() {
  const tags = { year: parseInt(year, 10), month: parseInt(month, 10) };
  try {
    const origBuf  = fs.readFileSync(origPath);
    const origTxs  = await parsePDFTransactions(origBuf, tags);
    const newBuf   = fs.readFileSync(newPath);
    const newTxs   = await parsePDFTransactions(newBuf, {});
    // Emit only what the parent needs: date+amount pairs
    const pick = txs => txs.map(t => ({ date: t.date, amount: t.amount }));
    process.stdout.write(JSON.stringify({ orig: pick(origTxs), new: pick(newTxs) }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ orig: [], new: [] }) + '\n');
  }
}

run();
