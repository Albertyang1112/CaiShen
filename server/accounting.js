const express = require('express');

// ── Default Chart of Accounts (seeded on first boot) ─────────────────
const DEFAULT_COA = [
  // Assets
  { id: 'a1000', number: '1000', name: 'Chase Checking',         type: 'asset',     subtype: 'bank',          active: true },
  { id: 'a1010', number: '1010', name: 'Savings',                type: 'asset',     subtype: 'bank',          active: true },
  { id: 'a1200', number: '1200', name: 'Brokerage - Schwab',     type: 'asset',     subtype: 'investment',     active: true },
  { id: 'a1210', number: '1210', name: '401(k)',                  type: 'asset',     subtype: 'retirement',    active: true },
  { id: 'a1220', number: '1220', name: 'Crypto',                  type: 'asset',     subtype: 'investment',    active: true },
  { id: 'a1500', number: '1500', name: 'Haas - Property',        type: 'asset',     subtype: 'fixed_asset',   active: true, propertyId: 'haas' },
  { id: 'a1501', number: '1501', name: 'Kobe - Property',        type: 'asset',     subtype: 'fixed_asset',   active: true, propertyId: 'kobe' },
  { id: 'a1502', number: '1502', name: 'Bay Hill - Property',    type: 'asset',     subtype: 'fixed_asset',   active: true, propertyId: 'bayhill' },
  { id: 'a1503', number: '1503', name: 'Muirfield - Property',   type: 'asset',     subtype: 'fixed_asset',   active: true, propertyId: 'muirfield' },
  { id: 'a1504', number: '1504', name: 'Alcita - Property',      type: 'asset',     subtype: 'fixed_asset',   active: true, propertyId: 'alcita' },
  { id: 'a1600', number: '1600', name: 'Accounts Receivable',    type: 'asset',     subtype: 'receivable',    active: true },

  // Liabilities
  { id: 'l2000', number: '2000', name: 'Haas Mortgage',          type: 'liability', subtype: 'mortgage',      active: true, propertyId: 'haas' },
  { id: 'l2001', number: '2001', name: 'Kobe Mortgage',          type: 'liability', subtype: 'mortgage',      active: true, propertyId: 'kobe' },
  { id: 'l2002', number: '2002', name: 'Bay Hill Mortgage',      type: 'liability', subtype: 'mortgage',      active: true, propertyId: 'bayhill' },
  { id: 'l2003', number: '2003', name: 'Muirfield Mortgage',     type: 'liability', subtype: 'mortgage',      active: true, propertyId: 'muirfield' },
  { id: 'l2004', number: '2004', name: 'Alcita Mortgage',        type: 'liability', subtype: 'mortgage',      active: true, propertyId: 'alcita' },
  { id: 'l2100', number: '2100', name: 'Amex Platinum',          type: 'liability', subtype: 'credit_card',   active: true },
  { id: 'l2200', number: '2200', name: 'Accounts Payable',       type: 'liability', subtype: 'payable',       active: true },

  // Equity
  { id: 'e3000', number: '3000', name: "Owner's Equity",         type: 'equity',    subtype: 'equity',        active: true },
  { id: 'e3100', number: '3100', name: 'Retained Earnings',      type: 'equity',    subtype: 'equity',        active: true },

  // Income
  { id: 'i4000', number: '4000', name: 'Haas - Rental Income',   type: 'income',    subtype: 'rental',        active: true, propertyId: 'haas' },
  { id: 'i4001', number: '4001', name: 'Kobe - Rental Income',   type: 'income',    subtype: 'rental',        active: true, propertyId: 'kobe' },
  { id: 'i4002', number: '4002', name: 'Bay Hill - Rental Income',type:'income',    subtype: 'rental',        active: true, propertyId: 'bayhill' },
  { id: 'i4003', number: '4003', name: 'Muirfield - Rental Income',type:'income',   subtype: 'rental',        active: true, propertyId: 'muirfield' },
  { id: 'i4004', number: '4004', name: 'Alcita - Rental Income', type: 'income',    subtype: 'rental',        active: true, propertyId: 'alcita' },
  { id: 'i4100', number: '4100', name: 'W-2 / Salary Income',    type: 'income',    subtype: 'wage',          active: true },
  { id: 'i4200', number: '4200', name: 'RSU / Stock Income',     type: 'income',    subtype: 'investment',    active: true },
  { id: 'i4300', number: '4300', name: 'Interest / Dividends',   type: 'income',    subtype: 'interest',      active: true },
  { id: 'i4400', number: '4400', name: 'Other Income',           type: 'income',    subtype: 'other',         active: true },

  // Expenses
  { id: 'x5000', number: '5000', name: 'Mortgage Interest',      type: 'expense',   subtype: 'mortgage',      active: true },
  { id: 'x5010', number: '5010', name: 'Property Tax',           type: 'expense',   subtype: 'tax',           active: true },
  { id: 'x5020', number: '5020', name: 'Insurance',              type: 'expense',   subtype: 'insurance',     active: true },
  { id: 'x5030', number: '5030', name: 'HOA Fees',               type: 'expense',   subtype: 'hoa',           active: true },
  { id: 'x5040', number: '5040', name: 'Repairs & Maintenance',  type: 'expense',   subtype: 'maintenance',   active: true },
  { id: 'x5050', number: '5050', name: 'Property Management',    type: 'expense',   subtype: 'management',    active: true },
  { id: 'x5060', number: '5060', name: 'Utilities',              type: 'expense',   subtype: 'utilities',     active: true },
  { id: 'x5070', number: '5070', name: 'Landscaping',            type: 'expense',   subtype: 'maintenance',   active: true },
  { id: 'x5100', number: '5100', name: 'Dining & Entertainment', type: 'expense',   subtype: 'personal',      active: true },
  { id: 'x5110', number: '5110', name: 'Groceries',              type: 'expense',   subtype: 'personal',      active: true },
  { id: 'x5120', number: '5120', name: 'Travel',                 type: 'expense',   subtype: 'personal',      active: true },
  { id: 'x5130', number: '5130', name: 'Shopping',               type: 'expense',   subtype: 'personal',      active: true },
  { id: 'x5200', number: '5200', name: 'Professional Services',  type: 'expense',   subtype: 'professional',  active: true },
  { id: 'x5210', number: '5210', name: 'Subscriptions',          type: 'expense',   subtype: 'subscription',  active: true },
  { id: 'x5900', number: '5900', name: 'Miscellaneous Expense',  type: 'expense',   subtype: 'other',         active: true },
];

module.exports = function(makeIO) {
  const router = express.Router();

  // Inject per-user IO into every request
  router.use((req, res, next) => {
    const { read, write } = makeIO(req.user.id);
    req.read = read; req.write = write;
    next();
  });

  // ── Chart of Accounts ─────────────────────────────────────────────────
  router.get('/coa', (req, res) => {
    // Seed defaults on first access
    let coa = req.read('chart_of_accounts.json');
    if (!coa || coa.length === 0) { coa = DEFAULT_COA; req.write('chart_of_accounts.json', DEFAULT_COA); }
    res.json(coa);
  });

  router.post('/coa', (req, res) => {
    const coa = req.read('chart_of_accounts.json') || [];
    const entry = { id: `acct_${Date.now()}`, active: true, ...req.body };
    coa.push(entry);
    req.write('chart_of_accounts.json', coa);
    res.json(entry);
  });

  router.put('/coa/:id', (req, res) => {
    const coa = req.read('chart_of_accounts.json') || [];
    const idx = coa.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    coa[idx] = { ...coa[idx], ...req.body };
    req.write('chart_of_accounts.json', coa);
    res.json(coa[idx]);
  });

  router.delete('/coa/:id', (req, res) => {
    const coa = req.read('chart_of_accounts.json') || [];
    req.write('chart_of_accounts.json', coa.filter(a => a.id !== req.params.id));
    res.json({ success: true });
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
    const coa       = req.read('chart_of_accounts.json') || [];
    const properties = req.read('properties.json') || [];

    const start = startDate || new Date(Date.now() - 365*24*60*60*1000).toISOString().split('T')[0];
    const end   = endDate   || new Date().toISOString().split('T')[0];

    // Filter transactions by date
    let filteredTxs = txs.filter(t => t.date >= start && t.date <= end);
    if (propertyId) filteredTxs = filteredTxs.filter(t => t.propertyId === propertyId || t.account === propertyId);

    // Group by category
    const incomeByCategory  = {};
    const expenseByCategory = {};
    let totalIncome = 0, totalExpenses = 0;

    for (const tx of filteredTxs) {
      if (tx.amount > 0) {
        incomeByCategory[tx.category] = (incomeByCategory[tx.category] || 0) + tx.amount;
        totalIncome += tx.amount;
      } else {
        const cat = tx.category || 'Uncategorized';
        expenseByCategory[cat] = (expenseByCategory[cat] || 0) + Math.abs(tx.amount);
        totalExpenses += Math.abs(tx.amount);
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
          if (credit > 0) { incomeByCategory[acct.name] = (incomeByCategory[acct.name] || 0) + credit; totalIncome += credit; }
        }
        if (acct.type === 'expense') {
          const debit = line.debit || 0;
          if (debit > 0) { expenseByCategory[acct.name] = (expenseByCategory[acct.name] || 0) + debit; totalExpenses += debit; }
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
      netIncome: totalIncome - totalExpenses,
      propertyPL
    });
  });

  // ── Balance Sheet ─────────────────────────────────────────────────────
  router.get('/balance-sheet', (req, res) => {
    const accounts   = req.read('accounts.json')   || [];
    const properties = req.read('properties.json') || [];

    const bankAccounts    = accounts.filter(a => a.balance > 0 && ['bank','checking','savings','depository'].includes(a.type?.toLowerCase()));
    const investAccounts  = accounts.filter(a => a.balance > 0 && ['investment','brokerage','retirement'].includes(a.type?.toLowerCase()));
    const cryptoAccounts  = accounts.filter(a => a.balance > 0 && ['crypto'].includes(a.type?.toLowerCase()));
    const creditLiab      = accounts.filter(a => a.balance < 0);

    const totalRE         = properties.reduce((s, p) => s + (p.value    || 0), 0);
    const totalMortgage   = properties.reduce((s, p) => s + (p.mortgage || 0), 0);
    const totalBank       = bankAccounts.reduce((s, a) => s + (a.balance || 0), 0);
    const totalInvest     = investAccounts.reduce((s, a) => s + (a.balance || 0), 0);
    const totalCrypto     = cryptoAccounts.reduce((s, a) => s + (a.balance || 0), 0);
    const totalCredit     = Math.abs(creditLiab.reduce((s, a) => s + (a.balance || 0), 0));
    const totalAssets     = totalBank + totalInvest + totalCrypto + totalRE;
    const totalLiabilities = totalMortgage + totalCredit;

    res.json({
      asOf: new Date().toISOString(),
      assets: {
        total: totalAssets,
        cash: { total: totalBank, accounts: bankAccounts },
        investments: { total: totalInvest, accounts: investAccounts },
        crypto: { total: totalCrypto, accounts: cryptoAccounts },
        realEstate: { total: totalRE, equity: totalRE - totalMortgage, properties }
      },
      liabilities: {
        total: totalLiabilities,
        mortgages: { total: totalMortgage, properties: properties.map(p => ({ name: p.name, balance: p.mortgage })) },
        creditCards: { total: totalCredit, accounts: creditLiab }
      },
      equity: totalAssets - totalLiabilities
    });
  });

  return { router };
};
