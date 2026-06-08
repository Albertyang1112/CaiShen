# CaiShen client

React + Vite single-page app (dev server on port 5173, proxying `/api` and `/auth`
to the backend on 3001). Built output goes to `../client-dist/`, which the server
serves in production.

## Shell vs pages

`src/App.jsx` is the **app shell**: it gates on auth (`Login`), renders the sidebar
nav, holds the top-level `accounts`/`transactions` state, and switches between pages
based on the active nav id. Every standalone page lives in its own folder under
`src/pages/` and is imported by `App.jsx`.

```
src/
  main.jsx            entry — mounts <App/>
  App.jsx             shell: auth gate, sidebar, state, page router
  index.css           global styles + design tokens (CSS vars)
  App.css             shell-specific styles
  assets/             static images (hero, logos)
  pages/
    <PageName>/<PageName>.jsx
```

## Pages

| Page (folder) | Nav | What it does |
|---------------|-----|--------------|
| **Banking/** | Banking | Accounts + transactions table, inline reconcile badges (✓/⚠/◈), statements view. Also exports `classifyAccount` used by the shell. |
| **PersonalSpending/** | Personal Spending | Category spending breakdown + trends. |
| **TransactionTransfer/** | Transactions | Bulk transaction review, categorize, transfer between accounts. |
| **Crypto/** | Crypto | Wallets, on-chain holdings, FIFO cost-basis tax report (Form 8949 / Schedule D). |
| **Accounting/** | Accounting | Chart of accounts, journal entries, invoices, bills, financial reports. |
| **TaxCenter/** | Taxes | Tax forms, returns, year-by-year tax data. |
| **TaxAdvisor/** | Tax Advisor | AI tax advisor (RAG-backed). Co-locates `TaxDataReview.jsx`, its only consumer. |
| **Advisor/** | AI Advisor | AI financial advisor chat (localhost-only). |
| **Projections/** | Projections | Net-worth / cash-flow projections. |
| **DataVault/** | Data Vault | Document storage, search, tax-doc detection, sharing. |
| **Login/** | — | Auth screen (login / signup / 2FA); shown by the shell when unauthenticated. |
| **BankScraper/**, **Scrapers/** | — | **Gitignored, local-only.** UIs for the bank-session automation; same posture as `server/scrapers/`. |

## Still inline in `App.jsx`

A few screens are still defined inside `App.jsx` rather than in `pages/`:
`MainDashboard`, `ConnectionsScreen`, `SettingsScreen`, and the real-estate views
(`RealEstateDash`, `PropertyDetail`), plus shared bits (`Icon`, `NavBtn`, the API
constant, contexts). These are candidates to extract into `pages/` + a `shared/`
folder next, leaving `App.jsx` a thin shell + router.

## Conventions

- **One page = one folder** under `src/pages/`. The component file matches the folder name (`pages/Banking/Banking.jsx`).
- **Imports:** `App.jsx` imports pages as `./pages/<Name>/<Name>`. A page's private sub-components are co-located in its folder (e.g. `TaxAdvisor/TaxDataReview.jsx`).
- **Styling:** global tokens and base styles in `index.css` (CSS custom properties like `--teal`, `--coral`); pages use inline styles referencing those vars.
- **API:** pages call the backend via `axios` against `/api/...` (Vite proxies to 3001 in dev).

## Run / build

```bash
npm run dev      # vite dev server, port 5173, HMR
npm run build    # production build → ../client-dist/
```
