'use strict';
/**
 * core/backup-routes.js — extracted from index.js. Full-data export/import and the
 * historical-CSV import path. Mounted at /api. Takes the raw { readData, writeData } (not
 * makeIO) because backup/restore also touch the GLOBAL settings.json (uid-less read/write),
 * which makeIO can't express.
 *
 *   GET  /api/backup                  — full per-user JSON export (blob download)
 *   POST /api/restore                 — restore from a backup blob
 *   POST /api/import-history/preview  — dry-run dedup report
 *   POST /api/import-history          — import Chase CSV rows + record manual_csv provenance
 */
const express = require('express');

module.exports = function makeBackupRoutes({ readData, writeData }) {
  const router = express.Router();

  // ── Backup & export ─────────────────────────────────────────────────────────
  router.get('/backup', (req, res) => {
    const uid = req.user.id;
    const backup = {
      exportedAt: new Date().toISOString(), version: '1.0.0',
      accounts: readData('accounts.json', uid), transactions: readData('transactions.json', uid),
      properties: readData('properties.json', uid), taxYears: readData('tax_years.json', uid),
      settings: readData('settings.json'),
      invoices: readData('invoices.json', uid), bills: readData('bills.json', uid),
      vendors: readData('vendors.json', uid), journalEntries: readData('journal_entries.json', uid),
      chartOfAccounts: readData('chart_of_accounts.json', uid),
      cryptoTransactions: readData('crypto_txns.json', uid),
      wallets: readData('wallets.json', uid),
    };
    res.setHeader('Content-Disposition', `attachment; filename=caishen-backup-${Date.now()}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  });

  router.post('/restore', (req, res) => {
    const uid = req.user.id;
    const { accounts, transactions, properties, taxYears, settings, invoices, bills, vendors, journalEntries, chartOfAccounts } = req.body;
    if (accounts)        writeData('accounts.json', accounts, uid);
    if (transactions)    writeData('transactions.json', transactions, uid);
    if (properties)      writeData('properties.json', properties, uid);
    if (taxYears)        writeData('tax_years.json', taxYears, uid);
    if (settings)        writeData('settings.json', settings);        // global
    if (invoices)        writeData('invoices.json', invoices, uid);
    if (bills)           writeData('bills.json', bills, uid);
    if (vendors)         writeData('vendors.json', vendors, uid);
    if (journalEntries)  writeData('journal_entries.json', journalEntries, uid);
    if (chartOfAccounts) writeData('chart_of_accounts.json', chartOfAccounts, uid);
    res.json({ success: true, restoredAt: new Date().toISOString() });
  });

  // ── Import preview — dry-run before actual import ────────────────────────────
  router.post('/import-history/preview', (req, res) => {
    const { transactions } = req.body;
    const uid = req.user.id;
    if (!Array.isArray(transactions) || !transactions.length)
      return res.status(400).json({ error: 'No transactions provided' });

    const existing = readData('transactions.json', uid) || [];
    const exactKeys = new Set(
      existing.map(t => `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.desc || '').toLowerCase().slice(0, 20)}`)
    );
    const descKeyMap = new Map();
    for (const t of existing) {
      const k = `${t.date}|${String(t.desc || '').toLowerCase().slice(0, 20)}`;
      if (!descKeyMap.has(k)) descKeyMap.set(k, t);
    }

    const exactDuplicates = [], conflicts = [], newTxs = [];
    for (const t of transactions) {
      const eKey = `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.desc || '').toLowerCase().slice(0, 20)}`;
      const dKey = `${t.date}|${String(t.desc || '').toLowerCase().slice(0, 20)}`;
      if (exactKeys.has(eKey)) exactDuplicates.push(t);
      else if (descKeyMap.has(dKey)) conflicts.push({ incoming: t, existing: descKeyMap.get(dKey) });
      else newTxs.push(t);
    }

    res.json({
      new: newTxs.length,
      duplicates: exactDuplicates.length,
      conflicts: conflicts.length,
      conflictDetails: conflicts.slice(0, 15),
      duplicateDetails: exactDuplicates.slice(0, 10),
    });
  });

  // ── Import historical CSV transactions ───────────────────────────────────────
  router.post('/import-history', async (req, res) => {
    const { transactions, accountId } = req.body;
    const uid = req.user.id;
    if (!Array.isArray(transactions) || !transactions.length)
      return res.status(400).json({ error: 'No transactions provided' });

    const accounts = readData('accounts.json', uid) || [];
    const account  = accounts.find(a => a.id === accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const existing     = readData('transactions.json', uid) || [];
    const existingKeys = new Set(
      existing.map(t => `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.desc || '').toLowerCase().slice(0, 20)}`)
    );

    const toAdd = [];
    for (const t of transactions) {
      const key = `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.desc || '').toLowerCase().slice(0, 20)}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const [y, m] = t.date.split('-');
      toAdd.push({
        id: `csv_${t.date}_${String(t.desc || '').replace(/\W/g, '').slice(0, 8).toLowerCase()}_${Math.random().toString(36).slice(2, 6)}`,
        date: t.date, month: `${y}-${m}`, desc: t.desc || '',
        amount: t.amount, category: t.category || 'Other',
        account: accountId, institution: account.institution,
        pending: false, source: 'csv_import', lastUpdated: new Date().toISOString(),
      });
    }

    writeData('transactions.json', [...existing, ...toAdd], uid);
    // Record the imported rows in the universal intake (source_transactions, source='manual_csv')
    // + link each to the display txn it became. Best-effort: the display import above succeeded.
    try {
      const { query } = require('./db');
      const n = await require('../banking/manual-import').recordManualCsvRows(query, uid, toAdd);
      if (n) console.log(`[import-history] user ${uid}: recorded ${n} manual_csv source row(s)`);
    } catch (e) { console.error('[import-history] source_transactions error:', e.message); }
    res.json({ imported: toAdd.length, skipped: transactions.length - toAdd.length });
  });

  return router;
};
