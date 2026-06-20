# CaiShen server

Node.js + Express backend (port 3001). Data lives in two places: a **per-user JSON
store** under `data/users/<id>/` (accounts, transactions, vault metadata, settings)
and a **Neon Postgres** database (banking/notification tables, tax history, RAG
vectors). Plaid provides live bank data; QuickBooks and a Discord bot integrate on
the side.

## How a request flows

```
client → index.js (cors, json, static)
       → auth middleware (JWT → req.user)         [core/auth.js]
       → domain router mounted at /api/<domain>    [banking/, crypto/, tax/, ...]
       → per-user JSON store (readData/writeData)  or  Neon (core/db.js)
```

`index.js` is the entry point and wiring hub. It defines the per-user store helpers
(`readData`, `writeData`, `makeIO`), runs auth, mounts every domain router, opens the
SSE stream, and schedules the auto-sync cron. **To find a feature's API, open the
matching domain folder below** — you rarely need to read `index.js` itself.

## Folder map

Each folder is one domain. A folder's `index.js` (or `routes.js`) is its HTTP entry;
sibling files are the engines/helpers that entry calls.

| Folder | Mounted at | What lives here |
|--------|-----------|-----------------|
| **core/** | — | Shared infrastructure used by every domain. `db.js` (Neon pool + schema), `db-banking-schema.js` (banking tables), `auth.js` (JWT, login/signup, 2FA), `memory.js` (per-user memory), `verify.js` (startup integrity checks), `csv.js` (CSV parsing), `pdf-parser.js` (PDF text extraction, shared by banking + vault). |
| **banking/** | `/api` (routes.js), `/api/reconcile`, `/api/receipts` | The Banking page + money pipeline. `routes.js` (accounts, transactions, tx-overrides, categorization-rules), `plaid.js` (live sync + webhook + auto-reconcile), `statements.js`, `reconciler.js` + `reconcile-routes.js` (statement↔Plaid matching), `receipt-routes.js` + `receipt-ocr.js` (Groq vision OCR + dedup: `receipt-ingest.js`, `receipt-dedup.js`, `receipt-dupflow.js`, `receipt-hash.js`, `receipt-match.js` — cash + retroactive matching), `categorize.js` (rule engine) + `categorize-ai.js`, `notifier.js`, `neon-mirror.js` (Plaid→Neon). The conversational categorizer/receipt bot: `categorizer-core.js` (transport-free brain) + `messaging-bot.js` + `messaging-store.js` + `messaging-routes.js` + `transports/` (`discord.js`, `twilio.js`). |
| **crypto/** | `/api/crypto` | Cost-basis tax engine. `index.js` (report router), `engine.js` (FIFO lot engine — faithful port, parity-tested by `tests/crypto.test.js`), `reports.js` (Form 8949 / Schedule D / income CSVs). |
| **tax/** | `/api/taxes`, `/api/tax-engine`, `/api/tax-advisor`, `/api/tax-normalize`, `/api/tax-history`, `/api/rag` | Everything tax. `taxes.js` (Tax Center data), `history.js` (calculations/transactions/AI-session log in Neon), `form-parser.js` (W-2/1099/1040 PDF extraction), `engine/` (brackets + calculator), `advisor/` (RAG + engine + guardrails AI advisor), `normalize/` (transactions → categories → TaxInput), `rag/` (tax-law retrieval: embeddings, vectorStore, retriever, ingest). |
| **accounting/** | `/api/accounting`, `/auth/quickbooks`, `/api/quickbooks` | `index.js` (chart of accounts, journal entries, invoices, bills, reports), `quickbooks.js` (OAuth + sync). |
| **advisor/** | `/api/advisor` | `index.js` — AI financial advisor (localhost-only). |
| **vault/** | `/api/vault` | DataVault page: file storage, search, tax-doc detection, sharing. `index.js` is the router; `pdf-parse-worker.js` and `fudge-detect-worker.js` are child processes it spawns via `__dirname` (keep them in this folder). |
| **scrapers/** | `/api/scraper`, `/api/scrapers` (localhost-only) | **Gitignored, local-only.** Playwright bank-session automation (`bank-scraper.js`) and the bridge to the Python scrapers (`scraper-bridge.js`, `scraper-import.js`). Handles credentials/real session data — never committed. |
| **tests/** | — | Jest suites (one per module). `npm test` runs all. Mirrors the parity oracle for crypto/tax engines. |
| **logs/** | — | `server.log` (tee'd console output). Gitignored. |
| **scraper-fixtures/** | — | HAR fixtures with real bank session data. Gitignored. |

## Still inline in `index.js`

`index.js` keeps the app shell plus a few route groups not yet extracted into domain
modules: properties (real estate), tax-years, import-history, `/api/tax-estimate`,
crypto transactions CRUD, wallets + on-chain lookup, backup/restore, and
`parse-statement`/`pdf-render`. Banking was the first group extracted (→ `banking/routes.js`);
the rest follow the same `makeXRouter(deps)` pattern when split out.

## Conventions

- **Router factory pattern:** a domain entry exports `module.exports = function makeXRouter(deps) { … return router }`. `index.js` injects what it needs (`readData`, `writeData`, `makeIO`, `VAULT_DIR`). This keeps domains decoupled from the filesystem layout.
- **Two stores:** per-user JSON (`data/users/<id>/*.json`) for app state; Neon (`core/db.js`) for banking pipeline, tax history, and RAG. `makeIO(userId)` is the JSON accessor.
- **require paths:** within a folder use `./sibling`; reach shared infra with `../core/db`. Workers spawned by path (`vault/*.js`) must stay beside the file that spawns them.

## Run / test

```bash
npm run dev     # nodemon on server/index.js (port 3001)
npm start       # node server/index.js
npm test        # jest --runInBand   (parity + route suites)
```
