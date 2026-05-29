/**
 * pdf-parse-worker.js
 * Run by vault.js via child_process so each PDF is parsed in a fresh process.
 * pdf2json keeps global state — sequential parses in the same process can return
 * transactions from a previously-parsed file (e.g. March gets Feb's data).
 *
 * Usage:  node pdf-parse-worker.js <filePath> <year> <month>
 * Stdout: single JSON line { transactions: [ { date, amount, description }, ... ] }
 */
'use strict';

const { parsePDFTransactions } = require('./pdf-parser');
const fs = require('fs');

const [, , filePath, year, month] = process.argv;

async function run() {
  try {
    const buf  = fs.readFileSync(filePath);
    const tags = { year: parseInt(year, 10), month: parseInt(month, 10) };
    const txs  = await parsePDFTransactions(buf, tags);
    process.stdout.write(JSON.stringify({ transactions: txs }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ transactions: [], error: e.message }) + '\n');
  }
}

run();
