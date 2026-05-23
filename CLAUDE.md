# CaiShen — Project Context for Claude

## What is CaiShen?
CaiShen (财神, Chinese god of wealth) is a personal finance OS built as a local Node.js + React app. It runs entirely on the user's machine — no cloud database, no external servers. All financial data stays local. User accounts are stored in a hosted PostgreSQL database (Neon) so anyone who clones the project shares the same user list. It is being built for personal use first, with commercialization as a future goal.

---

## Owner / Developer
- **Name:** Albert Yang
- **GitHub:** Albertyang1112
- **Location:** Desktop — `C:\Users\Albert Yang\Desktop\CaiShen`
- **OS:** Windows 11
- **Node version:** v24.15.0
- **Editor:** VS Code with Command Prompt as default terminal

---

## Project Structure
```
CaiShen/
├── server/
│   ├── index.js          ← Express backend (port 3001) — async IIFE startup
│   ├── auth.js           ← JWT auth, signup, login, 2FA, device trust (uses DB)
│   ├── db.js             ← PostgreSQL connection pool + schema init (Neon)
│   ├── plaid.js          ← Plaid OAuth + sync (live bank connections)
│   ├── quickbooks.js     ← QuickBooks OAuth + sync
│   ├── vault.js          ← Data Vault file storage API
│   ├── advisor.js        ← AI Advisor (Claude Opus 4.7 streaming)
│   ├── accounting.js     ← Chart of accounts, invoices, bills, journal entries
│   └── statements.js     ← Auto-generate monthly PDF bank statements
├── client/
│   └── src/
│       ├── App.jsx           ← Main app, routing, sidebar, state
│       ├── App.css           ← Not used much — styles in index.css
│       ├── index.css         ← All CSS variables and global styles
│       ├── main.jsx          ← React entry point
│       ├── Login.jsx         ← Login, signup, 2FA verification screens
│       ├── PersonalSpending.jsx     ← CSV upload, auto-categorization, friend sidebar
│       ├── TransactionTransfer.jsx  ← Move/split transactions, auto-transfer rules
│       ├── Projections.jsx          ← Tax projections, property sale optimizer, net worth
│       └── DataVault.jsx            ← File browser, folder upload, PDF/Excel preview
├── data/                 ← Local JSON storage (gitignored)
│   ├── users/            ← Per-user financial data directories (data/users/{userId}/)
│   │   └── {userId}/     ← accounts.json, transactions.json, properties.json, etc.
│   └── settings.json     ← Global app settings
├── vault/                ← Uploaded files stored here (gitignored)
│   └── users/{userId}/   ← Per-user vault files
├── backups/              ← Auto-backups before every data write (gitignored)
├── .env                  ← API keys (gitignored, NEVER commit)
├── .gitignore
├── package.json
└── package-lock.json
```

---

## Running the App
Two terminals must be open simultaneously:

**Terminal 1 — Backend:**
```bash
cd C:\Users\Albert Yang\Desktop\CaiShen
npm start
```
Runs on http://localhost:3001

**Terminal 2 — Frontend:**
```bash
cd C:\Users\Albert Yang\Desktop\CaiShen\client
npm run dev
```
Runs on http://localhost:5173

---

## Tech Stack
### Backend
- Node.js + Express
- **pg** — PostgreSQL client (Neon hosted DB for user accounts)
- bcryptjs — password hashing
- jsonwebtoken — JWT auth tokens
- nodemailer — 2FA email sending (Gmail SMTP)
- multer — file uploads
- plaid — Plaid API SDK
- intuit-oauth — QuickBooks OAuth
- node-cron — auto-sync scheduler
- better-sqlite3 — (installed, not yet used)
- crypto-js — encryption
- axios — HTTP requests
- pdf2json — PDF text extraction (server-side, no vulnerabilities)
- pdfkit — PDF generation (monthly statements)
- sharp — installed for future image processing

### Frontend
- React 18 + Vite
- axios — API calls
- react-plaid-link — Plaid Link OAuth popup
- exceljs — Excel file reading (0 vulnerabilities, replaced SheetJS)
- pdfjs-dist — NOT used (removed due to vulnerabilities)

---

## API Keys & .env Structure
```
# Plaid
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=production

# QuickBooks
QB_CLIENT_ID=...
QB_CLIENT_SECRET=...
QB_REDIRECT_URI=http://localhost:3001/auth/quickbooks/callback

# Anthropic (AI Advisor)
ANTHROPIC_API_KEY=...

# Etherscan (optional — for ETH wallet on-chain lookup; free at etherscan.io)
ETHERSCAN_API_KEY=...

# Security
MASTER_PASSWORD=[user chosen — seeds default admin on first boot]
ADMIN_EMAIL=[admin's email for 2FA]

# Database (Neon PostgreSQL — shared user accounts)
DATABASE_URL=postgresql://neondb_owner:[password]@[host]/neondb?sslmode=require

# Email (2FA sender — dedicated Gmail + App Password)
EMAIL_FROM=caishen.sender@gmail.com
EMAIL_PASS=[16-char Gmail App Password]
EMAIL_SMTP=smtp.gmail.com   (optional, default)
EMAIL_PORT=587               (optional, default)

# App
PORT=3001
AUTO_SYNC_INTERVAL=5

# Plaid webhooks (real-time push — requires public HTTPS URL)
PLAID_WEBHOOK_URL=
```

---

## Architecture: Per-User Data Isolation

All financial data is stored in per-user directories via the `makeIO(userId)` factory pattern:

```js
// server/index.js
function makeIO(userId) {
  return {
    read:  (file) => readData(file, userId),   // reads from data/users/{userId}/
    write: (file, data) => writeData(file, data, userId)
  };
}
```

All module factories receive `makeIO` and call it with `req.user.id` per request:
- `require('./plaid')(makeIO, notifyClients)`
- `require('./vault')(VAULT_DIR, makeIO)`
- `require('./advisor')(makeIO)`
- `require('./accounting')(makeIO)`
- `require('./statements')(makeIO, VAULT_DIR)`
- `require('./quickbooks')(makeIO)`

**User accounts** live in Neon PostgreSQL (shared, hosted).
**Financial data** lives in `data/users/{userId}/` (local, private).

On first boot, `migrateAdminData()` copies any existing root `data/*.json` files into `data/users/1/`.

---

## Authentication & 2FA

- **`server/db.js`** — PostgreSQL pool + `initSchema()` (creates `users` table if not exists)
- **`server/auth.js`** — factory `module.exports = function()`, exports `{ router, verifyToken, requireAdmin }` + static `module.exports.ensureDefaultAdmin(readData)`
- **`server/index.js`** — async IIFE startup: `initSchema()` → `authMod()` → `ensureDefaultAdmin(readData)` → all routes → `app.listen()`

### Login flow
1. POST `/api/auth/login` with `{ username, password, deviceId }`
2. `deviceId` is a UUID stored in `localStorage` (`caishen_device_id`), auto-generated on first visit
3. If device is in `user.trusted_devices` → JWT issued immediately
4. If device is new AND user has an email → 6-digit code generated, emailed via nodemailer, `{ needs2FA: true, tempId, maskedEmail }` returned
5. POST `/api/auth/verify-2fa` with `{ tempId, code, deviceId }` → deviceId added to `trusted_devices` in DB → JWT issued

### Signup flow
- POST `/api/auth/signup` with `{ username, email, password }`
- Email required (used for 2FA on new devices)
- Role: `viewer` by default
- Admin can promote via `POST /api/auth/users`

### DB schema
```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  email           TEXT UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'viewer',
  display_name    TEXT,
  trusted_devices JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

### Migration
On first boot with empty DB, `ensureDefaultAdmin(readData)` checks for existing `data/users.json` and migrates all users to DB automatically.

---

## Properties (Real Estate)
Albert owns 5 rental properties. These are hardcoded in multiple places:
| ID | Name | Address | Color |
|---|---|---|---|
| haas | Haas | 123 Haas Ave, LA | --blue |
| kobe | Kobe | 456 Kobe Blvd, LA | --teal |
| bayhill | Bay Hill | 789 Bay Hill Dr, SF | --purple |
| muirfield | Muirfield | 321 Muirfield Ln, SD | --amber |
| alcita | Alcita | 654 Alcita Ct, OC | --coral |

---

## What's Built ✅
### Dashboard
- Main dashboard — net worth, asset allocation donut chart, asset class cards with % bars
- Each asset class is clickable and drills into its own dashboard
- Breadcrumb navigation
- Sidebar: Overview / Asset Classes / Tools sections
- Logout button always visible in sidebar (collapsed and expanded)

### Asset Class Dashboards
- **Real Estate** — portfolio summary + individual property dashboards (Haas, Kobe, Bay Hill, Muirfield, Alcita)
- **Equities** — placeholder (positions, RSU tracker coming)
- **Crypto** — full module (see Crypto section below)
- **Retirement** — placeholder
- **Cash** — placeholder

### Login / Auth
- Sign in + Create account tabs (underline tab style)
- 2FA screen with masked email display and large code input
- Device ID auto-generated (UUID) and stored in localStorage
- Trusted devices — 2FA only on new devices, skipped on known ones
- Logout button in sidebar footer (always visible, collapsed and expanded)

### Personal Spending
- CSV upload (drag & drop or browse)
- Auto-categorizes using Chase's own Category column first, then keyword fallback
- Chase CSV parser handles "Posting Date" header (checking accounts) and "Transaction Date" (credit cards)
- 13 categories: Dining, Groceries, Shopping, Transport, Travel, Entertainment, Fitness, Health, Subscriptions, Coffee, Tech, Utilities, Other
- Month filter (dropdown + sidebar bar chart)
- Income/credits tracked separately from expenses
- Net cash flow metric
- Friend sidebar — click any category to get a roast
- Re-categorize dropdown per transaction
- Sort by date, amount, or name
- Multiple statement import (merges, no duplicates)

### Transaction Transfer
- Full transaction list with search, account filter, category filter
- **Move transaction** — modal to reassign to any account/property with note + audit trail
- **Split transaction** — divide one transaction across multiple accounts/properties by amount or %
- **Auto-transfer rules** — keyword/account/category rules that auto-move transactions, persist via localStorage
- **History tab** — log of all transfers, splits, bulk rule applications
- "Apply all rules" button

### Projections
- 4 tabs: Tax Projections, Property Sale, Net Worth, RSU & ISO
- **Tax Projections** — sliders for W-2, RSU, crypto, RE income, LTCG, ISO; live federal/state/NIIT/AMT breakdown; quarterly estimates; scenario comparison
  - **Year baseline** — loads prior year actuals from `tax_years.json`; auto-selects last year on open; "Save {year}" button POSTs to `POST /api/tax-years`
  - **Tax advisor recommendations** — 8 rule-based tips computed from slider values (AMT trigger, standard deduction, LTCG shift, depreciation, RSU bracket, NIIT, quarterly reminders, retirement contributions)
- **Property Sale** — select property, adjust price/years held; full proceeds breakdown; depreciation recapture; tax-optimal price finder with bar chart; bracket threshold warnings
- **Net Worth** — savings/appreciation/return sliders; bar chart + year-by-year table
- **RSU & ISO** — vest tax impact calculator; ISO AMT planner with safe exercise zone

### Data Vault
- GitHub-style folder tree sidebar
- File grid with icons by type (PDF, CSV, Excel, image, etc.)
- Click any file → Discord-style popup preview (dims background)
- **PDF preview** — server-side text extraction via pdf2json; shows extracted text; scanned PDFs show "no text" message
- **CSV preview** — renders as clean table
- **Excel preview** — multi-sheet support via ExcelJS, 0 vulnerabilities
- **Image preview** — full size on dark background
- Folder upload (preserves folder structure)
- Folder merge prompt (4 options: Merge, Replace, Keep, Save as new)
- Auto-tags folders named after properties (Haas, Kobe, etc.)
- Persistent storage — files saved to `vault/users/{userId}/`, metadata in per-user `vault.json`
- Deleted folders archived to `vault/_deleted/`, not permanently removed
- **Auto-generated monthly PDF statements** — generated from Plaid transactions; stored in `Bank Statements/{Institution}/{Year}/` in vault; skips already-existing statements
- **Import CSV History button** in toolbar — Chase CSV parser (`parseHistoryCSV` in DataVault.jsx); account selector (Plaid accounts); deduplication via `POST /api/import-history`; step-by-step Chase download instructions

### Connections & Live Sync
- Plaid connection screen with Connect account button (react-plaid-link)
- QuickBooks UI hardcoded to "Keys not configured" — QB keys are placeholder values; do not change until real keys obtained
- Setup checklist showing what's configured
- Disconnect button per Plaid institution
- Sync all button (manual)
- **Sync full history** button — shows warning modal (dimmed background) explaining Plaid's history limits (e.g. Chase only provides ~4 months via API); user confirms before Plaid sync runs; modal directs to Data Vault for older history via CSV
- **Chase bank account connected and live** — production, live sync working
- **Auto-sync via node-cron** — polls every `AUTO_SYNC_INTERVAL` minutes; iterates all users from DB
- **Server-Sent Events (SSE)** at `/api/events` — server pushes a `data-updated` event to all open browser tabs after every sync; browser auto-refreshes accounts + transactions without page reload
- SSE reconnects automatically after 5s if connection drops
- **Plaid webhook endpoint** at `/api/plaid/webhook` — handles `TRANSACTIONS` webhook events; searches all user data dirs to find owner of item_id
- Plaid transactions mapped to CaiShen categories via `PLAID_CAT_MAP` in `plaid.js`
- Plaid transactions include `month` field (`YYYY-MM`) for Personal Spending month filter compatibility

### Crypto (`client/src/Crypto.jsx`)
Full Koinly-style crypto tracker. Four tabs:
- **Portfolio** — FIFO cost basis engine computes holdings from manual transactions; live prices from CoinGecko free API; shows quantity, avg cost, live price, value, unrealized P&L, return %
- **Transactions** — manual ledger (buy/sell/receive/send/transfer in/out); CSV export; data stored in `crypto_txns.json`
- **Tax Report** — YTD short-term/long-term realized gains from FIFO; estimated tax at 37% ST rate; rule-based tax optimization tips (harvesting, ST→LT shift, etc.)
- **Wallets** — two features:
  1. **Quick address lookup** — paste any public address; server auto-detects chain (BTC/ETH/SOL/LTC/DOGE) and fetches live balance + last 25 txns from free blockchain APIs
  2. **Saved wallets** — name, type, address, exchange, notes; each card with address gets "Sync on-chain" button that expands inline with balance + transactions + block explorer links

**On-chain APIs** (all free, no keys required except Etherscan optional):
- BTC: Blockstream.info
- ETH: Etherscan (add `ETHERSCAN_API_KEY` to `.env` for higher rate limits)
- SOL: Solana public mainnet RPC
- LTC/DOGE: BlockCypher

**Server endpoint**: `GET /api/wallet-lookup?address=<addr>` — chain detection via regex, returns `{ chain, address, balance, transactions[] }`

**Data files**: `crypto_txns.json` and `wallets.json` per user in `data/users/{userId}/`

**COINS map** supports: BTC, ETH, SOL, ADA, DOT, AVAX, MATIC, LINK, UNI, USDC, USDT, XRP, BNB, DOGE, LTC

### Settings
- **Data & Privacy card** — "Export all data" button downloads full JSON backup via `GET /api/backup` as a blob file download
- Export includes: accounts, transactions, properties, tax years, crypto transactions, wallets, invoices, bills, chart of accounts

### AI Advisor
- **Chat tab** — real-time streaming chat with Claude Opus 4.7; full financial context injected as cached system prompt
- **Proactive Insights tab** — AI generates 5 insights on demand; cached to per-user `insights.json`; cards with priority + category badges
- Backend: `server/advisor.js` — `POST /api/advisor/chat` (SSE streaming), `GET /api/advisor/insights`, `POST /api/advisor/generate-insights` (async fire-and-forget)
- Uses `@anthropic-ai/sdk` with `claude-opus-4-7` and `thinking: {type: 'adaptive'}`
- Prompt caching via `cache_control: {type: 'ephemeral'}` on the financial context system prompt
- Context includes: all accounts, properties with NOI/ROI, last 150 transactions, 30-day spending by category, net worth summary, CA tax context
- Graceful "not configured" UI when `ANTHROPIC_API_KEY` is missing
- Suggested prompts on empty chat; auto-scroll; auto-resize textarea; Clear button
- Streaming cursor blink animation during assistant response generation

---

## What's NOT Built Yet ⏳
- **Tax Return Tab** — 1040, Schedule E, Schedule D, Schedule C, AMT, year-over-year, PDF export
- **Equities & RSU Tracker** — vesting schedule, ISO/NSO planner (Projections has RSU calc but no position tracker)
- **Retirement Planner** — 401k, Roth, projections
- **PDF parsing with AI** — pdf2json handles text PDFs; scanned PDFs need Claude Vision (add ANTHROPIC_API_KEY)
- **QuickBooks full integration** — UI shows "not configured"; needs real API keys registered in Intuit developer portal + correct redirect URI
- **Plaid webhook real-time push** — endpoint built; needs ngrok public URL set in `PLAID_WEBHOOK_URL`
- **Crypto: auto-import from on-chain** — wallet lookup is read-only; transactions must still be entered manually
- **LLC formation analyzer**
- **Business plan builder**

---

## Current Issues Being Debugged
1. **QuickBooks redirect_uri invalid** — needs correct redirect URI registered in Intuit developer portal; OAuth flow starts but callback fails

---

## Decisions Made
- **No AI for categorization during development** — keyword matching only until Anthropic key obtained
- **No pdfjs-dist** — removed due to vulnerabilities; using pdf2json server-side instead
- **No SheetJS (xlsx)** — replaced with ExcelJS (0 vulnerabilities)
- **QuickBooks over file parsing** — instead of parsing uploaded files, pull data directly from QB
- **Plaid for live bank data** — production keys obtained, Chase connected, live sync working
- **Transaction state lifted to App.jsx** — PersonalSpending and TransactionTransfer share the same transactions array via props
- **Auto-backup before every write** — writeData() in index.js auto-backups to backups/ folder, keeps last 30
- **Plaid products: `['transactions']` only** — `balances` is not a Plaid product; `investments` requires separate approval. Do not add either back to linkTokenCreate.
- **QuickBooks module exports `{ authRouter, apiRouter }`** — single factory call; `authRouter` mounts at `/auth/quickbooks`, `apiRouter` at `/api/quickbooks`. Do NOT require the module twice.
- **All server modules use `makeIO(userId)` factory** — signature pattern: `module.exports = function(makeIO, ...)`. Each handler calls `makeIO(req.user.id)` to get scoped read/write. accounting.js injects via `router.use()` middleware into `req.read`/`req.write`.
- **QuickBooks OAuth state encodes userId** — `state: 'caishen-qb-{userId}'` so callback (no JWT) can find the right user's data
- **SSE for live UI updates** — server pushes `data-updated` events via `/api/events`; App.jsx `EventSource` re-fetches on each event. Reconnects after 5s on error.
- **AI Advisor uses official `@anthropic-ai/sdk`** — Uses `claude-opus-4-7` with `thinking: {type: 'adaptive'}`. No sampling params — they 400 on Opus 4.7.
- **AI Advisor chat uses SSE streaming via fetch** — `EventSource` only supports GET; chat is POST, so use `fetch()` + `response.body.getReader()`. Server uses `client.messages.stream()` + `.on('text', ...)`.
- **AI Advisor insights are fire-and-forget** — responds `{status:'generating'}` immediately; frontend polls until `generatedAt` is newer.
- **Prompt caching on financial context** — `cache_control: {type: 'ephemeral'}` caches system prompt for 5 minutes.
- **User accounts in hosted PostgreSQL (Neon)** — financial data stays local; only the users table is shared. Anyone cloning the repo and adding `DATABASE_URL` to `.env` shares the same user list.
- **index.js uses async IIFE** — entire route setup + server start is inside `(async () => { ... })()` so DB init and admin seeding can be awaited before the server accepts requests.
- **Cron job reads users from DB** — `SELECT id, username FROM users` instead of `readData('users.json')`.
- **2FA email uses nodemailer + Gmail SMTP** — `EMAIL_FROM` / `EMAIL_PASS` (App Password) in `.env`. Falls back to console.log if not configured.
- **Login screen tabs use underline style** — active tab has blue bottom border, not pill/card background.
- **Crypto wallet lookup routes through server** — `GET /api/wallet-lookup` hits blockchain APIs server-side to avoid CORS issues; uses axios (already a dep).
- **QuickBooks hardcoded as "not configured"** — placeholder API keys exist in .env but aren't real; QB card in Connections is hardcoded to show coral "Keys not configured" — do not revert to dynamic check until real keys are added.
- **Plaid `optional_products: ['statements']` removed** — caused "account not enabled" error; CaiShen generates its own PDFs via pdfkit from transaction data, not Plaid's Statements API.
- **Import CSV History moved to Data Vault** — was in Connections screen; now lives in Data Vault toolbar. `parseHistoryCSV` and `ImportHistoryModal` are in `DataVault.jsx`.
- **Sync full history has warning modal** — clicking the button shows a modal explaining Plaid's ~4-month history limit before proceeding; directs user to Data Vault for older history via CSV import.
- **"Accounting" renamed to "Report"** in sidebar `NAV_TOOLS`.
- **Settings has data export** — `GET /api/backup` returns full JSON as blob download; wired to "Export all data" button in Settings.
- **Projections saves/loads year baselines** — `POST /api/tax-years` upserts a year record; `GET /api/tax-years` (reads `tax_years.json`) loads them; auto-selects prior year on open.

---

## Git / GitHub
- Repo: https://github.com/Albertyang1112/CaiShen (private)
- Main branch: main
- .gitignore excludes: .env, node_modules, data/, backups/, vault/

---

## Styling Conventions
All colors use CSS variables defined in `index.css`:
```css
--bg-primary, --bg-secondary, --bg-card, --bg-hover
--border, --border-light
--text-primary, --text-secondary, --text-muted
--blue, --blue-light (--blue-L), --teal, --teal-light
--purple, --purple-light, --amber, --amber-light
--coral, --coral-light, --green, --green-light
--pink, --pink-light
--radius-sm, --radius-md, --radius-lg
```

All components use inline styles with these CSS variables. No Tailwind, no styled-components.

---

## Collaborator Notes
- Project has GitHub collaborators
- Collaborator's QuickBooks account tracks all property/business expenses
- Plan: pull data from QB instead of parsing uploaded files manually
- Security is a priority — collaborator flagged vulnerability concerns
- All dependencies should have 0 known vulnerabilities for production

---

## Future Commercialization Plans
- CaiShen may be sold as a product to other users
- Target market: high-income individuals with real estate, RSUs, crypto, complex tax situations
- Potential pivot: white-label for financial advisors to give to clients
- Phase 1: Plaid for all banks; Phase 2: Akoya for direct bank integrations; Phase 3: Chase Direct + BofA direct for scale
- Need proper privacy policy and EULA before commercial launch (documents written, hosted on GitHub Gist)
