require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());

// ── Static client files ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client')));

// ── Data directory setup ──────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '../data');
const BACKUP_DIR = path.join(__dirname, '../backups');

const defaultFiles = {
  'accounts.json': [],
  'transactions.json': [],
  'properties.json': [],
  'tax_years.json': [],
  'connections.json': { plaid: [], quickbooks: null },
  'settings.json': {
    autoSyncInterval: parseInt(process.env.AUTO_SYNC_INTERVAL) || 60,
    theme: 'dark',
    masterPasswordSet: false
  }
};

// Create data files if they don't exist
Object.entries(defaultFiles).forEach(([file, defaultVal]) => {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2));
    console.log(`Created ${file}`);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────
function readData(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    console.error(`Error reading ${file}:`, e.message);
    return null;
  }
}

function writeData(file, data) {
  try {
    // Auto-backup before every write
    const src = path.join(DATA_DIR, file);
    if (fs.existsSync(src)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(BACKUP_DIR, `${file}.${timestamp}.bak`);
      fs.copyFileSync(src, backupPath);
      // Keep only last 30 backups per file
      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(file))
        .sort();
      if (backups.length > 30) {
        backups.slice(0, backups.length - 30).forEach(f =>
          fs.unlinkSync(path.join(BACKUP_DIR, f))
        );
      }
    }
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error(`Error writing ${file}:`, e.message);
    return false;
  }
}

// ── Routes: Data ─────────────────────────────────────────────────────
app.get('/api/accounts', (req, res) => res.json(readData('accounts.json')));
app.get('/api/transactions', (req, res) => res.json(readData('transactions.json')));
app.get('/api/properties', (req, res) => res.json(readData('properties.json')));
app.get('/api/tax-years', (req, res) => res.json(readData('tax_years.json')));
app.get('/api/settings', (req, res) => res.json(readData('settings.json')));

app.post('/api/properties', (req, res) => {
  const props = readData('properties.json');
  const newProp = { id: Date.now().toString(), ...req.body };
  props.push(newProp);
  writeData('properties.json', props);
  res.json(newProp);
});

app.put('/api/properties/:id', (req, res) => {
  const props = readData('properties.json');
  const idx = props.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  props[idx] = { ...props[idx], ...req.body };
  writeData('properties.json', props);
  res.json(props[idx]);
});

app.delete('/api/properties/:id', (req, res) => {
  const props = readData('properties.json').filter(p => p.id !== req.params.id);
  writeData('properties.json', props);
  res.json({ success: true });
});

// ── Routes: Vault ─────────────────────────────────────────────────────
const vaultRoutes = require('./vault')
app.use('/api/vault', vaultRoutes)

// ── Server-Sent Events — push data-refresh signals to the browser ─────
const sseClients = new Set()
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})
function notifyClients() {
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify({ type: 'data-updated' })}\n\n`)
  }
}

// ── Routes: Plaid ─────────────────────────────────────────────────────
const { router: plaidRouter, syncAll: plaidSyncAll } = require('./plaid')(readData, writeData, notifyClients);
app.use('/api/plaid', plaidRouter);

// ── Routes: QuickBooks ────────────────────────────────────────────────
const { authRouter: qbAuth, apiRouter: qbApi } = require('./quickbooks')(readData, writeData)
app.use('/auth/quickbooks', qbAuth)
app.use('/api/quickbooks', qbApi)

// ── Routes: Backup & Export ───────────────────────────────────────────
app.get('/api/backup', (req, res) => {
  const backup = {
    exportedAt: new Date().toISOString(),
    version: '1.0.0',
    accounts: readData('accounts.json'),
    transactions: readData('transactions.json'),
    properties: readData('properties.json'),
    taxYears: readData('tax_years.json'),
    settings: readData('settings.json'),
  };
  res.setHeader('Content-Disposition', `attachment; filename=caishen-backup-${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.json(backup);
});

app.post('/api/restore', (req, res) => {
  const { accounts, transactions, properties, taxYears, settings } = req.body;
  if (accounts) writeData('accounts.json', accounts);
  if (transactions) writeData('transactions.json', transactions);
  if (properties) writeData('properties.json', properties);
  if (taxYears) writeData('tax_years.json', taxYears);
  if (settings) writeData('settings.json', settings);
  res.json({ success: true, restoredAt: new Date().toISOString() });
});

app.post('/api/parse-statement', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const axios = require('axios');
    const base64 = req.file.buffer.toString('base64');
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 }
        }, {
          type: 'text',
          text: 'Extract all transactions from this bank statement. Return ONLY a JSON array with objects: { date: "YYYY-MM-DD", desc: "merchant name", amount: -123.45 }. Negative amounts for expenses, positive for deposits. No markdown, no explanation, just the JSON array.'
        }]
      }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });
    const text = response.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const transactions = parsed.map((t, i) => {
      const date = new Date(t.date);
      return {
        id: `pdf_${i}_${Date.now()}`,
        date: t.date,
        desc: t.desc,
        amount: t.amount,
        category: 'Other',
        source: 'pdf',
        month: `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`
      };
    });
    res.json({ transactions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pdf-render', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const PDFParser = require('pdf2json')
    const parser = new PDFParser()
    
    await new Promise((resolve, reject) => {
      parser.on('pdfParser_dataReady', resolve)
      parser.on('pdfParser_dataError', reject)
      parser.parseBuffer(req.file.buffer)
    })

    const text = parser.getRawTextContent()
    const pages = parser.data?.Pages?.length || 0

    res.json({ text, pages })
  } catch (e) {
    console.error('PDF parse error:', e.message)
    res.status(500).json({ error: e.message, text: '', pages: 0 })
  }
})

// ── Routes: Status ────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    version: '1.0.0',
    plaidConfigured: !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_CLIENT_ID !== 'paste_your_client_id_here'),
    qbConfigured: !!(process.env.QB_CLIENT_ID && process.env.QB_CLIENT_ID !== 'paste_your_qb_client_id_here'),
    dataDir: DATA_DIR,
    uptime: process.uptime()
  });
});

// ── Catch-all: serve dashboard ────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  const indexPath = path.join(__dirname, '../client/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f1117;color:#fff">
        <h2>CaiShen Server Running ✓</h2>
        <p>Server is up on port ${process.env.PORT || 3001}</p>
        <p>Client files not found in /client — add your built React app there.</p>
        <p><a href="/api/status" style="color:#378ADD">Check API status</a></p>
      </body></html>
    `);
  }
});

// ── Auto-sync scheduler ───────────────────────────────────────────────
const intervalMinutes = parseInt(process.env.AUTO_SYNC_INTERVAL) || 5;
cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
  const ts = new Date().toLocaleTimeString();
  const result = await plaidSyncAll().catch(e => ({ error: e.message }));
  if (result.skipped) return;
  if (result.error) { console.log(`[${ts}] Auto-sync error: ${result.error}`); return; }
  for (const r of result.results || []) {
    if (r.error) {
      console.log(`[${ts}] ${r.institution}: error — ${r.error}`);
    } else {
      console.log(`[${ts}] ${r.institution}: ${r.accounts} accounts, ${r.transactions} transactions`);
    }
  }
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✓ CaiShen server running at http://localhost:${PORT}`);
  console.log(`✓ Data directory: ${DATA_DIR}`);
  console.log(`✓ Auto-sync every ${intervalMinutes} minutes`);
  console.log(`\nOpen http://localhost:${PORT} in your browser\n`);

  // Auto-open browser on start
  try {
    const open = require('open');
    open(`http://localhost:${PORT}`);
  } catch(e) {}
});