# CaiShen — Project Context for Claude

## What is CaiShen?
CaiShen (财神, Chinese god of wealth) is a personal finance OS built as a local Node.js + React app. It runs entirely on the user's machine — no cloud database, no external servers. All financial data stays local. It is being built for personal use first, with commercialization as a future goal.

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
│   ├── index.js          ← Express backend (port 3001)
│   ├── plaid.js          ← Plaid OAuth + sync (live bank connections)
│   ├── quickbooks.js     ← QuickBooks OAuth + sync
│   └── vault.js          ← Data Vault file storage API
├── client/
│   └── src/
│       ├── App.jsx           ← Main app, routing, sidebar, state
│       ├── App.css           ← Not used much — styles in index.css
│       ├── index.css         ← All CSS variables and global styles
│       ├── main.jsx          ← React entry point
│       ├── PersonalSpending.jsx     ← CSV upload, auto-categorization, friend sidebar
│       ├── TransactionTransfer.jsx  ← Move/split transactions, auto-transfer rules
│       ├── Projections.jsx          ← Tax projections, property sale optimizer, net worth
│       └── DataVault.jsx            ← File browser, folder upload, PDF/Excel preview
├── data/                 ← Local JSON storage (gitignored)
│   ├── accounts.json
│   ├── transactions.json
│   ├── properties.json
│   ├── connections.json
│   ├── tax_years.json
│   ├── settings.json
│   └── vault.json
├── vault/                ← Uploaded files stored here (gitignored)
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
- multer — file uploads
- plaid — Plaid API SDK
- intuit-oauth — QuickBooks OAuth
- node-cron — auto-sync scheduler
- better-sqlite3 — (installed, not yet used)
- crypto-js — encryption
- axios — HTTP requests
- pdf2json — PDF text extraction (server-side, no vulnerabilities)
- pdf-parse — installed but had issues, replaced by pdf2json
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
PLAID_CLIENT_ID=6a0b879d613f95000efc0e78
PLAID_SECRET=[production secret - rotated, get new one from dashboard]
PLAID_ENV=production

# QuickBooks
QB_CLIENT_ID=[production client id]
QB_CLIENT_SECRET=[production client secret]
QB_REDIRECT_URI=http://localhost:3001/auth/quickbooks/callback

# Security
MASTER_PASSWORD=[user chosen]

# App
PORT=3001
AUTO_SYNC_INTERVAL=5

# Plaid webhooks (real-time push — requires public HTTPS URL)
# Local dev: run "ngrok http 3001" then set to ngrok URL + /api/plaid/webhook
# Example: PLAID_WEBHOOK_URL=https://abc123.ngrok.io/api/plaid/webhook
PLAID_WEBHOOK_URL=

# Anthropic (not yet configured - waiting)
ANTHROPIC_API_KEY=
```

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

### Asset Class Dashboards
- **Real Estate** — portfolio summary + individual property dashboards (Haas, Kobe, Bay Hill, Muirfield, Alcita)
- **Equities** — placeholder (positions, RSU tracker coming)
- **Crypto** — placeholder (wallet dashboard coming)
- **Retirement** — placeholder
- **Cash** — placeholder

### Personal Spending
- CSV upload (drag & drop or browse)
- Auto-categorizes using Chase's own Category column first, then keyword fallback
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
- Persistent storage — files saved to `vault/` folder, metadata in `data/vault.json`
- Deleted folders archived to `vault/_deleted/`, not permanently removed

### Connections & Live Sync
- Plaid connection screen with Connect account button (react-plaid-link)
- QuickBooks OAuth connect button
- Setup checklist showing what's configured
- Disconnect button per Plaid institution
- Sync all button (manual)
- **Chase bank account connected and live** — 74+ transactions synced in production
- **Auto-sync via node-cron** — polls every `AUTO_SYNC_INTERVAL` minutes (default 5) while server is running
- **Server-Sent Events (SSE)** at `/api/events` — server pushes a `data-updated` event to all open browser tabs after every sync; browser auto-refreshes accounts + transactions without page reload
- SSE reconnects automatically after 5s if connection drops
- **Plaid webhook endpoint** at `/api/plaid/webhook` — handles `TRANSACTIONS` webhook events for true real-time push; requires `PLAID_WEBHOOK_URL` in `.env` pointing to a public HTTPS URL (use ngrok for local dev)
- Plaid transactions mapped to CaiShen categories via `PLAID_CAT_MAP` in `plaid.js`
- Plaid transactions include `month` field (`YYYY-MM`) for Personal Spending month filter compatibility

### AI Advisor
- **Chat tab** — real-time streaming chat with Claude Opus 4.7; full financial context injected as cached system prompt
- **Proactive Insights tab** — AI generates 5 insights on demand; cached to `data/insights.json`; cards with priority + category badges
- Backend: `server/advisor.js` — `POST /api/advisor/chat` (SSE streaming), `GET /api/advisor/insights`, `POST /api/advisor/generate-insights` (async fire-and-forget)
- Uses `@anthropic-ai/sdk` with `claude-opus-4-7` and `thinking: {type: 'adaptive'}`
- Prompt caching via `cache_control: {type: 'ephemeral'}` on the financial context system prompt
- Context includes: all accounts, properties with NOI/ROI, last 150 transactions, 30-day spending by category, net worth summary, CA tax context
- Graceful "not configured" UI when `ANTHROPIC_API_KEY` is missing; shows exact setup instructions
- Suggested prompts on empty chat; auto-scroll; auto-resize textarea; Clear button
- Streaming cursor blink animation during assistant response generation

---

## What's NOT Built Yet ⏳
- **Tax Return Tab** — 1040, Schedule E, Schedule D, Schedule C, AMT, year-over-year, PDF export
- **AI Advisor API key** — infrastructure built and ready; just needs `ANTHROPIC_API_KEY` in `.env`
- **Equities & RSU Tracker** — vesting schedule, ISO/NSO planner
- **Crypto Module** — wallet dashboard, cost basis, Koinly import
- **Retirement Planner** — 401k, Roth, projections
- **PDF parsing with AI** — pdf2json handles text PDFs; scanned PDFs need Claude Vision (add API key first)
- **QuickBooks full integration** — OAuth connects but redirect URI is invalid; needs correct redirect URI registered in Intuit developer portal with production keys
- **Plaid webhook real-time push** — endpoint built and ready; needs ngrok (or deployed server) to get a public HTTPS URL, then set `PLAID_WEBHOOK_URL` in `.env`
- **Monthly statement generator** — PDF export of combined account statements
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
- **PDF preview uses iframe** — decided to use native browser PDF rendering, but not yet implemented (still using pdf2json text extraction)
- **QuickBooks over file parsing** — instead of parsing 1,978 uploaded files, pull data directly from QB which already has everything categorized
- **Plaid for live bank data** — production keys obtained, Chase connected, live sync working
- **Transaction state lifted to App.jsx** — PersonalSpending and TransactionTransfer share the same transactions array via props
- **Auto-backup before every write** — writeData() in index.js auto-backups to backups/ folder, keeps last 30
- **Plaid products: `['transactions']` only** — `balances` is not a Plaid product (auto-included with all connections); `investments` requires separate Plaid approval. Do not add either back to linkTokenCreate.
- **QuickBooks module exports `{ authRouter, apiRouter }`** — single factory call initializes one OAuthClient; `authRouter` mounts at `/auth/quickbooks`, `apiRouter` at `/api/quickbooks`. Do NOT require the module twice.
- **plaid.js factory signature: `(readData, writeData, notifyClients)`** — `notifyClients` is passed from index.js and called after every sync to trigger SSE push to browser. Default is `() => {}` so it's safe to call without it.
- **SSE for live UI updates** — server pushes `data-updated` events via `/api/events`; App.jsx `EventSource` re-fetches accounts + transactions on each event. Reconnects after 5s on error.
- **AI Advisor uses official `@anthropic-ai/sdk`** — not raw axios. Uses `claude-opus-4-7` with `thinking: {type: 'adaptive'}`. No beta headers needed for adaptive thinking. No sampling params (temperature etc.) — they 400 on Opus 4.7.
- **AI Advisor chat uses SSE streaming via fetch** — `EventSource` only supports GET; chat is POST, so use `fetch()` + `response.body.getReader()` for streaming. Server uses `client.messages.stream()` + `.on('text', ...)`.
- **AI Advisor insights are fire-and-forget** — `POST /api/advisor/generate-insights` responds with `{status:'generating'}` immediately; generation runs async in background; frontend polls `/api/advisor/insights` until `generatedAt` is newer than trigger time.
- **Prompt caching on financial context** — advisor system prompt uses `cache_control: {type: 'ephemeral'}` to cache the large financial context block for 5 minutes, reducing cost on repeated chat turns.

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