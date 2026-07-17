const express = require('express');
const { buildDefaultChart, categoryLibrary, resolveLibraryAdditions, OLD_DEFAULT_IDS, idForPath } = require('./categories');
const { autoCoaId, isLikelyBusiness } = require('../banking/auto-categorize');

// ── Report helpers (shared by /pl and /pl/transactions) ──────────────────────
// A node id + every descendant id, so opening a parent category in the drawer
// surfaces everything filed beneath it (not just rows pinned to the parent itself).
function subtreeIds(coa, rootId) {
  const childrenOf = {};
  for (const a of coa) { const p = a.parentId || '__root'; (childrenOf[p] = childrenOf[p] || []).push(a.id); }
  const out = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    for (const c of childrenOf[id] || []) if (!out.has(c)) { out.add(c); stack.push(c); }
  }
  return out;
}

// Name path from a leaf up to its section root, e.g.
// ['Personal Expenses','Entertainment','Games'].
function categoryPath(coaById, id) {
  const parts = [];
  let cur = coaById.get(id);
  while (cur) { parts.unshift(cur.name); cur = cur.parentId ? coaById.get(cur.parentId) : null; }
  return parts;
}

// The effective category node a transaction lands on, mirroring the /pl rule exactly:
// a manual/rule coaId wins; otherwise the built-in guesser; capitalized fixed-asset
// buys and transfers resolve to null (excluded from the P&L). Keeps the drawer's
// transaction list consistent with the totals shown in the report rows.
function effectiveAcct(tx, coaById) {
  if (tx.capital) return null;
  let acct = tx.coaId ? coaById.get(tx.coaId) : null;
  if (!acct) { const g = autoCoaId(tx); acct = g ? coaById.get(g) : null; }
  return acct || null;
}

// Best-effort human merchant label for the insights / drawer. Prefer an explicit
// vendor; otherwise strip common processor prefixes and trailing store-number / city
// /state noise off the raw description. Heuristic — good enough for grouping.
function cleanMerchant(tx) {
  if (tx.vendor && String(tx.vendor).trim()) return String(tx.vendor).trim();
  let d = String(tx.desc || '').trim();
  if (!d) return 'Unknown';
  d = d.replace(/^(TST\*|SQ ?\*|SP ?\*|PP\*|PAYPAL ?\*|POS |PURCHASE |DEBIT |CREDIT |CHECKCARD |VISA |PMT |ACH )/i, '');
  d = d.replace(/\s+#?\d{3,}\b.*$/, '');       // trailing store number / ref id and anything after
  d = d.replace(/\s+[A-Z]{2}$/, '');           // trailing state code
  d = d.replace(/\s{2,}/g, ' ').trim();
  return d || String(tx.desc).trim();
}

module.exports = function(makeIO) {
  const router = express.Router();

  // Inject per-user IO into every request
  router.use((req, res, next) => {
    const { read, write } = makeIO(req.user.id);
    req.read = read; req.write = write;
    next();
  });

  // ── Chart of Accounts — self-healing to the canonical default tree ────
  // The curated default tree is authoritative. On every load we GUARANTEE all default
  // nodes are present, KEEP the user's own added categories (system === false — e.g.
  // "Chipotle" under Fast Food), and DROP stale / duplicate / orphan nodes left behind by
  // earlier seed/migration versions. This keeps auto-categorization targets resolvable and
  // the report tree clean (one section root per type+scope, no parentless orphans), and is
  // idempotent — it only rewrites the chart when the node set actually changes.
  function loadChart(req) {
    const fresh = buildDefaultChart();
    const freshIds = new Set(fresh.map(n => n.id));
    const coa = req.read('chart_of_accounts.json');

    if (!coa || coa.length === 0) {
      req.write('chart_of_accounts.json', fresh);
      return fresh;
    }

    const seen = new Set(freshIds);
    const userNodes = [];
    for (const n of coa) {
      if (n.system === false && !seen.has(n.id)) { seen.add(n.id); userNodes.push(n); }   // user-created, keep (dedup by id)
    }
    const merged = [...fresh, ...userNodes];

    const coaIds = new Set(coa.map(n => n.id));
    const unchanged = merged.length === coa.length && merged.every(n => coaIds.has(n.id));
    if (!unchanged) req.write('chart_of_accounts.json', merged);
    return merged;
  }

  router.get('/coa', (req, res) => res.json(loadChart(req)));

  router.post('/coa', (req, res) => {
    const coa = loadChart(req);
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name is required' });
    // Inherit type/scope from the parent when adding a sub-category.
    const parent = b.parentId ? coa.find(a => a.id === b.parentId) : null;
    const entry = {
      id: `cat_user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: b.name,
      type: b.type || parent?.type || 'expense',
      scope: b.scope || parent?.scope || null,
      parentId: b.parentId || null,
      subtype: b.subtype,
      active: b.active !== false,
      system: false,
    };
    coa.push(entry);
    req.write('chart_of_accounts.json', coa);
    res.json(entry);
  });

  router.put('/coa/:id', (req, res) => {
    const coa = loadChart(req);
    const idx = coa.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const next = { ...coa[idx], ...req.body, id: coa[idx].id };
    // Guard against moving a node under itself or a descendant (would create a cycle).
    if (next.parentId && next.parentId !== coa[idx].parentId) {
      const descendants = new Set([req.params.id]);
      for (let added = true; added; ) {
        added = false;
        for (const a of coa) if (a.parentId && descendants.has(a.parentId) && !descendants.has(a.id)) { descendants.add(a.id); added = true; }
      }
      if (descendants.has(next.parentId)) return res.status(400).json({ error: 'Cannot move a category under itself' });
    }
    coa[idx] = next;
    req.write('chart_of_accounts.json', coa);
    res.json(coa[idx]);
  });

  router.delete('/coa/:id', (req, res) => {
    const coa = loadChart(req);
    if (coa.some(a => a.parentId === req.params.id))
      return res.status(400).json({ error: 'This category has sub-categories. Delete or move them first.' });
    const txs = req.read('transactions.json') || [];
    if (txs.some(t => t.coaId === req.params.id))
      return res.status(400).json({ error: 'Transactions are categorized here. Recategorize them first, or deactivate instead.' });
    req.write('chart_of_accounts.json', coa.filter(a => a.id !== req.params.id));
    res.json({ success: true });
  });

  // ── Category library (the long-tail set the user can add later) ───────
  router.get('/category-library', (req, res) => {
    const coa = loadChart(req);
    res.json(categoryLibrary(new Set(coa.map(a => a.id))));
  });

  router.post('/coa/from-library', (req, res) => {
    const coa = loadChart(req);
    const additions = resolveLibraryAdditions(req.body?.id, new Set(coa.map(a => a.id)));
    if (!additions) return res.status(400).json({ error: 'Unknown library category' });
    if (additions.length) { coa.push(...additions); req.write('chart_of_accounts.json', coa); }
    // The requested leaf is the last node in the ancestors-first chain.
    res.json({ added: additions, node: additions[additions.length - 1] || coa.find(a => a.id === req.body.id) });
  });

  // ── Manual balance-sheet balances (per leaf, for items not in any account) ──
  router.get('/category-balances', (req, res) => res.json(req.read('category_balances.json') || {}));

  router.put('/category-balances/:id', (req, res) => {
    const balances = req.read('category_balances.json') || {};
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      delete balances[req.params.id];                       // clearing the balance
    } else {
      balances[req.params.id] = { amount, note: req.body?.note || '', asOf: new Date().toISOString() };
    }
    req.write('category_balances.json', balances);
    res.json(balances);
  });

  // ── Vendors ──────────────────────────────────────────────────────────
  router.get('/vendors', (req, res) => res.json(req.read('vendors.json') || []));

  router.post('/vendors', (req, res) => {
    const vendors = req.read('vendors.json') || [];
    const v = { id: `vendor_${Date.now()}`, ...req.body, createdAt: new Date().toISOString() };
    vendors.push(v);
    req.write('vendors.json', vendors);
    res.json(v);
  });

  router.put('/vendors/:id', (req, res) => {
    const vendors = req.read('vendors.json') || [];
    const idx = vendors.findIndex(v => v.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    vendors[idx] = { ...vendors[idx], ...req.body };
    req.write('vendors.json', vendors);
    res.json(vendors[idx]);
  });

  router.delete('/vendors/:id', (req, res) => {
    req.write('vendors.json', (req.read('vendors.json') || []).filter(v => v.id !== req.params.id));
    res.json({ success: true });
  });

  // ── Invoices ──────────────────────────────────────────────────────────
  router.get('/invoices', (req, res) => {
    let inv = req.read('invoices.json') || [];
    // Auto-flag overdue
    const today = new Date().toISOString().split('T')[0];
    inv = inv.map(i => i.status === 'sent' && i.dueDate < today ? { ...i, status: 'overdue' } : i);
    res.json(inv);
  });

  router.post('/invoices', (req, res) => {
    const invoices = req.read('invoices.json') || [];
    const inv = {
      id: `inv_${Date.now()}`,
      status: 'draft',
      createdAt: new Date().toISOString(),
      items: [],
      ...req.body
    };
    invoices.push(inv);
    req.write('invoices.json', invoices);
    res.json(inv);
  });

  router.put('/invoices/:id', (req, res) => {
    const invoices = req.read('invoices.json') || [];
    const idx = invoices.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    invoices[idx] = { ...invoices[idx], ...req.body };
    req.write('invoices.json', invoices);
    res.json(invoices[idx]);
  });

  router.delete('/invoices/:id', (req, res) => {
    req.write('invoices.json', (req.read('invoices.json') || []).filter(i => i.id !== req.params.id));
    res.json({ success: true });
  });

  // ── Bills ─────────────────────────────────────────────────────────────
  router.get('/bills', (req, res) => {
    let bills = req.read('bills.json') || [];
    const today = new Date().toISOString().split('T')[0];
    bills = bills.map(b => b.status === 'unpaid' && b.dueDate < today ? { ...b, status: 'overdue' } : b);
    res.json(bills);
  });

  router.post('/bills', (req, res) => {
    const bills = req.read('bills.json') || [];
    const bill = {
      id: `bill_${Date.now()}`,
      status: 'unpaid',
      createdAt: new Date().toISOString(),
      ...req.body
    };
    bills.push(bill);
    req.write('bills.json', bills);
    res.json(bill);
  });

  router.put('/bills/:id', (req, res) => {
    const bills = req.read('bills.json') || [];
    const idx = bills.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    bills[idx] = { ...bills[idx], ...req.body };
    req.write('bills.json', bills);
    res.json(bills[idx]);
  });

  router.delete('/bills/:id', (req, res) => {
    req.write('bills.json', (req.read('bills.json') || []).filter(b => b.id !== req.params.id));
    res.json({ success: true });
  });

  // ── Journal Entries ───────────────────────────────────────────────────
  router.get('/journal', (req, res) => res.json(req.read('journal_entries.json') || []));

  router.post('/journal', (req, res) => {
    const entries = req.read('journal_entries.json') || [];
    const entry = {
      id: `je_${Date.now()}`,
      createdAt: new Date().toISOString(),
      lines: [],
      ...req.body
    };
    // Validate debits == credits
    const totalDebit  = (entry.lines || []).reduce((s, l) => s + (l.debit  || 0), 0);
    const totalCredit = (entry.lines || []).reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.status(400).json({ error: `Debits ($${totalDebit.toFixed(2)}) must equal credits ($${totalCredit.toFixed(2)})` });
    }
    entries.push(entry);
    req.write('journal_entries.json', entries);
    res.json(entry);
  });

  router.delete('/journal/:id', (req, res) => {
    req.write('journal_entries.json', (req.read('journal_entries.json') || []).filter(e => e.id !== req.params.id));
    res.json({ success: true });
  });

  // ── P&L Report ────────────────────────────────────────────────────────
  router.get('/pl', (req, res) => {
    const { startDate, endDate, propertyId } = req.query;
    const txs       = req.read('transactions.json')   || [];
    const journals  = req.read('journal_entries.json') || [];
    const coa       = loadChart(req);   // re-seeded tree, so auto-category ids resolve
    const properties = req.read('properties.json') || [];

    const start = startDate || new Date(Date.now() - 365*24*60*60*1000).toISOString().split('T')[0];
    const end   = endDate   || new Date().toISOString().split('T')[0];

    // Filter transactions by date
    let filteredTxs = txs.filter(t => t.date >= start && t.date <= end);
    if (propertyId) filteredTxs = filteredTxs.filter(t => t.propertyId === propertyId || t.account === propertyId);

    // Effective category for each transaction: its manual coaId if set, otherwise an
    // auto-guess from merchant/description (auto-categorize.js). Transfers/card payments
    // resolve to null and are excluded. The account's *type* decides income vs expense;
    // balance-sheet accounts (asset/liability/equity) never get assigned here.
    const incomeByCategory  = {};
    const expenseByCategory = {};
    const byAccount  = {};                          // coaId → total (drives the nested report)
    const countByAccount = {};                      // coaId → transaction count (rolled up client-side)
    let totalIncome = 0, totalExpenses = 0;
    const coaById = new Map(coa.map(a => [a.id, a]));

    for (const tx of filteredTxs) {
      if (tx.capital) continue;                    // capitalized fixed-asset purchase → Balance Sheet, not P&L
      // Prefer the saved category; if it's stale (id not in the current chart) or absent,
      // fall back to the auto-guess so the transaction still lands on a valid leaf.
      const acct = effectiveAcct(tx, coaById);
      if (!acct) continue;                          // transfer, or unresolved → skip
      const amt = Math.abs(tx.amount);
      if (acct.type === 'income') {
        incomeByCategory[acct.name] = (incomeByCategory[acct.name] || 0) + amt;
        byAccount[acct.id] = (byAccount[acct.id] || 0) + amt;
        countByAccount[acct.id] = (countByAccount[acct.id] || 0) + 1;
        totalIncome += amt;
      } else if (acct.type === 'expense') {
        expenseByCategory[acct.name] = (expenseByCategory[acct.name] || 0) + amt;
        byAccount[acct.id] = (byAccount[acct.id] || 0) + amt;
        countByAccount[acct.id] = (countByAccount[acct.id] || 0) + 1;
        totalExpenses += amt;
      }
    }

    // Add journal entry amounts
    for (const je of journals) {
      if (!je.date || je.date < start || je.date > end) continue;
      for (const line of je.lines || []) {
        const acct = coa.find(a => a.id === line.accountId);
        if (!acct) continue;
        if (acct.type === 'income') {
          const credit = line.credit || 0;
          if (credit > 0) { incomeByCategory[acct.name] = (incomeByCategory[acct.name] || 0) + credit; byAccount[acct.id] = (byAccount[acct.id] || 0) + credit; countByAccount[acct.id] = (countByAccount[acct.id] || 0) + 1; totalIncome += credit; }
        }
        if (acct.type === 'expense') {
          const debit = line.debit || 0;
          if (debit > 0) { expenseByCategory[acct.name] = (expenseByCategory[acct.name] || 0) + debit; byAccount[acct.id] = (byAccount[acct.id] || 0) + debit; countByAccount[acct.id] = (countByAccount[acct.id] || 0) + 1; totalExpenses += debit; }
        }
      }
    }

    // Enrich with property NOI
    const propertyPL = properties.map(p => ({
      id: p.id, name: p.name,
      rentalIncome: (p.rent || 0) * 12,
      expenses: (p.exp || 0) * 12,
      noi: ((p.rent || 0) - (p.exp || 0)) * 12,
      roi: p.value ? (((p.rent - p.exp) * 12) / p.value * 100).toFixed(1) : null
    }));

    res.json({
      period: { start, end },
      income: { total: totalIncome, byCategory: incomeByCategory },
      expenses: { total: totalExpenses, byCategory: expenseByCategory },
      byAccount,
      countByAccount,
      netIncome: totalIncome - totalExpenses,
      propertyPL
    });
  });

  // ── P&L drawer: the transactions behind one category (subtree) ──────────
  // Returns the rows that rolled up into `coaId` (and any descendants) for the
  // same period, enriched with account name + category path, so the UI can show
  // exact transactions on demand without bloating the main /pl payload.
  router.get('/pl/transactions', async (req, res) => {
    const { coaId, startDate, endDate, propertyId } = req.query;
    if (!coaId) return res.status(400).json({ error: 'coaId is required' });

    const coa = loadChart(req);
    const coaById = new Map(coa.map(a => [a.id, a]));
    const node = coaById.get(coaId);
    if (!node) return res.status(404).json({ error: 'Unknown category' });

    const ids = subtreeIds(coa, coaId);
    const txs = req.read('transactions.json') || [];
    const start = startDate || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end   = endDate   || new Date().toISOString().split('T')[0];

    let filtered = txs.filter(t => t.date >= start && t.date <= end);
    if (propertyId) filtered = filtered.filter(t => t.propertyId === propertyId || t.account === propertyId);

    // Resolve account ids → display names (best-effort; falls back to the raw id).
    const acctName = {};
    try { for (const a of (await require('../core/banking-store').listAccounts(req.user.id)) || []) acctName[a.id] = a.name; } catch {}

    const out = [];
    for (const tx of filtered) {
      const acct = effectiveAcct(tx, coaById);
      if (!acct || !ids.has(acct.id)) continue;
      out.push({
        id: tx.id,
        date: tx.date,
        amount: Math.abs(Number(tx.amount) || 0),
        signed: Number(tx.amount) || 0,
        merchant: cleanMerchant(tx),
        desc: tx.desc || '',
        account: acctName[tx.account] || tx.account || '',
        accountId: tx.account || null,
        coaId: acct.id,
        categoryPath: categoryPath(coaById, acct.id),
        pending: !!tx.pending,
        auto: !!tx.coaAuto,
        note: tx.note || tx.memo || null,
      });
    }
    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));   // newest first

    res.json({
      coaId,
      name: node.name,
      type: node.type,
      parentName: node.parentId ? (coaById.get(node.parentId)?.name || null) : null,
      categoryPath: categoryPath(coaById, coaId),
      period: { start, end },
      total: out.reduce((s, t) => s + t.amount, 0),
      count: out.length,
      transactions: out,
    });
  });

  // ── Balance Sheet ─────────────────────────────────────────────────────
  // Unified: every linked account, property, and capitalized fixed-asset purchase is
  // mapped onto a specific chart leaf (`byLeaf`), so the UI rolls them up into one tree
  // alongside manual category balances. Accounts are classified by `accountClass`
  // (bank/card/loan/investment/crypto) — NOT by balance sign — so an overdrawn checking
  // account stays an asset instead of flipping to a liability. Equity = Assets − Liabilities.
  router.get('/balance-sheet', async (req, res) => {
    const accounts   = await require('../core/banking-store').listAccounts(req.user.id) || [];
    const settings   = req.read('account_settings.json') || {};
    const properties = req.read('properties.json') || [];
    const txs        = req.read('transactions.json') || [];
    const coa        = loadChart(req);

    // Entity merge (one loan = one row): a linked mortgage account whose property matches
    // an imported book leaf ("Mortgages:Kobe Mortgage") is itemized ON that leaf — live
    // balance, book section — instead of the generic hardcoded mortgage leaf. The import
    // side skips the book balance for merged leaves, so nothing double-counts.
    const leafByLoanAcct = new Map();
    for (const [leafId, m] of await require('../core/loan-match').linkedMortgageLeaves(req.user.id, { chart: coa, properties, accounts })) {
      if (m.accountId) leafByLoanAcct.set(m.accountId, leafId);
    }
    // Self-heal on read: a merged leaf must never ALSO carry a book/manual balance (a
    // pre-merge import left one behind) — one entity, one number, the live loan's. Any
    // intentional correction belongs in the books or the loan record, not stacked here.
    if (leafByLoanAcct.size) {
      const manual = req.read('category_balances.json') || {};
      let healed = false;
      for (const leafId of new Set(leafByLoanAcct.values())) {
        if (manual[leafId]) { delete manual[leafId]; healed = true; }
      }
      if (healed) req.write('category_balances.json', manual);
    }

    const L = (...names) => idForPath(names);
    const byLeaf = {};
    const add = (leafId, amount, item) => {
      if (!leafId || !amount) return;
      const e = byLeaf[leafId] || (byLeaf[leafId] = { linked: 0, accounts: [] });
      e.linked += amount;
      if (item) e.accounts.push(item);
    };
    const isBiz = (a) => {
      const s = settings[a.id];
      return (s && typeof s.business === 'boolean') ? s.business : isLikelyBusiness(a);
    };
    const classOf = (a) => {
      if (a.accountClass) return a.accountClass;
      const t = (a.type || '').toLowerCase(), st = (a.subtype || '').toLowerCase();
      if (a.source === 'crypto') return 'crypto';
      if (st.includes('mortgage')) return 'loan';
      if (t === 'credit') return 'card';
      if (t === 'loan') return 'loan';
      if (t === 'investment') return 'investment';
      return 'bank';
    };

    // 1. Linked accounts → asset / liability leaves (itemized per account).
    for (const a of accounts) {
      const cls = classOf(a), biz = isBiz(a);
      const sub = (a.subtype || '').toLowerCase();
      const bal = Number(a.balance) || 0;
      let leafId, amt = bal;
      if (cls === 'card') {
        leafId = biz ? L('Business Liabilities', 'Credit Cards', 'Business Credit Card')
                     : L('Personal Liabilities', 'Credit Cards', 'Credit Card Balance');
        // SIGNED, not abs: a card balance is owed-positive; a negative balance means the
        // card owes YOU (overpayment/refund) and nets against the others — QB parity.
        amt = bal;
      } else if (cls === 'loan') {
        leafId = leafByLoanAcct.get(a.id)   // merged: live loan shown on its book leaf
               || (sub.includes('mortgage') ? L('Personal Liabilities', 'Mortgage & Real Estate Debt', 'Primary Mortgage')
               : biz                        ? L('Business Liabilities', 'Loans', 'Business Loan')
               :                              L('Personal Liabilities', 'Loans', 'Personal Loan'));
        amt = Math.abs(bal);
      } else if (cls === 'investment') {
        leafId = L('Personal Assets', 'Investments', 'Brokerage');
      } else if (cls === 'crypto') {
        leafId = L('Personal Assets', 'Investments', 'Crypto');
      } else { // bank / depository
        leafId = biz
          ? (sub.includes('saving') ? L('Business Assets', 'Cash & Equivalents', 'Business Savings')
                                    : L('Business Assets', 'Cash & Equivalents', 'Business Checking'))
          : (sub.includes('saving') ? L('Personal Assets', 'Cash & Bank Accounts', 'Savings')
                                    : L('Personal Assets', 'Cash & Bank Accounts', 'Checking'));
      }
      add(leafId, amt, { id: a.id, name: a.name, balance: amt, sub: a.subtype || cls, institution: a.institution, last4: a.last4, business: biz });
    }

    // 2. Properties → Real Estate asset + Rental Mortgage liability (itemized).
    const reLeaf = L('Personal Assets', 'Real Estate', 'Rental Property');
    const rmLeaf = L('Personal Liabilities', 'Mortgage & Real Estate Debt', 'Rental Mortgage');
    for (const p of properties) {
      const v = Number(p.value) || 0, m = Number(p.mortgage) || 0;
      if (v) add(reLeaf, v, { name: p.name || 'Property', balance: v, sub: 'Property' });
      if (m) add(rmLeaf, m, { name: (p.name || 'Property') + ' — mortgage', balance: m, sub: 'Mortgage' });
    }

    // 3. Capitalized fixed-asset purchases (capital:true) → their Fixed Asset leaf (itemized).
    for (const t of txs) {
      if (!t.capital || !t.coaId) continue;
      const amt = Math.abs(Number(t.amount) || 0);
      add(t.coaId, amt, { name: t.desc || 'Asset', balance: amt, sub: t.date || '', needsReview: !t.approved });
    }

    // 4. Quick linked-only totals by chart type (the UI recomputes including manual balances).
    const typeById = new Map(coa.map(n => [n.id, n.type]));
    let assets = 0, liabilities = 0;
    for (const [id, e] of Object.entries(byLeaf)) {
      const ty = typeById.get(id);
      if (ty === 'asset') assets += e.linked;
      else if (ty === 'liability') liabilities += e.linked;
    }

    res.json({
      asOf: new Date().toISOString(),
      byLeaf,
      totals: { assets, liabilities, equity: assets - liabilities },
      // Authoritative post-heal manual balances: the client renders THESE instead of its
      // parallel /category-balances fetch, which can race the merge self-heal above and
      // stack a just-deleted book balance on top of the linked loan.
      manualBalances: req.read('category_balances.json') || {},
    });
  });

  return { router };
};
