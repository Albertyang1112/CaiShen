# Transactions Table — Extract + QuickBooks Features

**Plan for a `/goal` run. This doc is self-contained — a fresh session can execute it without prior chat context.**

Run rooted in this repo: `C:\Users\Albert Yang\Desktop\CaiShen`.

---

## Goal

`client/src/pages/Banking/Banking.jsx` is one 1,148-line file. Pull the **transactions
table + its toolbar** out into its own component so we can (a) iterate on it fast and
(b) debug it in isolation, then add the **top-3 missing QuickBooks features**. Keep the
existing **dark theme** (it's automatic — everything uses CSS variables).

This `/goal` delivers: **Extract (zero visual change) → + checkboxes/bulk bar → + pagination → + CSV export/print.**

---

## Where things are today (Banking.jsx, line numbers approximate — verify before editing)

| Piece | Lines | Keep / Move |
| --- | --- | --- |
| `fmt`, `fd`, `fmtFull` (currency format) | 5–7 | **Move** → `bankingFormat.js` (shared) |
| Account classification block + `classifyAccount`, `is*Account` | 9–227 | **Keep in Banking.jsx** (App.jsx imports `classifyAccount`) |
| `CAT_COLOR` | 230–236 | **Move** → `bankingFormat.js` |
| `TYPE_ORDER` / `TYPE_LABELS` / `TYPE_COLORS` | 241–243 | **Move** → `bankingFormat.js` |
| `Modal`, `Field` | 246–267 | **Keep** (used by the detail modal, which stays) |
| `MetricCard`, `AccountCard`, `StmtCard` | 270–356 | **Keep** |
| **`TxTable`** | **358–433** | **Move** → `TransactionsTable.jsx` |
| `SpendingBreakdown` | 435–468 | **Move** → `TransactionsTable.jsx` |
| `ArrowBtn`, `AccountStrip` | 472–560 | **Keep** |
| `ReceiptPanel`, `TxDetailModal` | 562–831 | **Keep in Banking.jsx for now** (move in a later run) |
| `Banking` default export | 833–1148 | **Edit** — see below |
| Transactions-view markup (toolbar + table + sidebar) | 1020–1078 | **Move** → `TransactionsTable.jsx` |

App.jsx wiring (do not change): `import Banking, { classifyAccount } from './pages/Banking/Banking'`,
rendered as `<Banking accounts={…} transactions={…} onUpdate={…} />`.

---

## The split — "just enough to isolate the feature"

Create **two** new files next to Banking.jsx:

### 1. `client/src/pages/Banking/bankingFormat.js`
Pure formatting + display constants shared by the page chrome and the table:
```js
export const fmt = ...        // from Banking.jsx:5
export const fd = ...         // :6
export const fmtFull = ...    // :7
export const CAT_COLOR = {...}        // :230
export const TYPE_ORDER  = [...]      // :241
export const TYPE_LABELS = {...}      // :242
export const TYPE_COLORS = {...}      // :243
```
Then `import { ... } from './bankingFormat'` in **both** Banking.jsx and TransactionsTable.jsx.
(This avoids a Banking↔TransactionsTable circular import.)

### 2. `client/src/pages/Banking/TransactionsTable.jsx`
A **self-contained transactions view**. It owns everything between the
Transactions/Statements toggle and the statements view. Moves in:
- `TxTable` (becomes internal, gains a checkbox column + pagination)
- `SpendingBreakdown`
- the toolbar markup (search input, month `<select>`, status tabs, totals strip, auto-categorize button)

**State that moves INTO this component** (was in `Banking`): `search`, `filterMonth`,
`statusFilter`, `sortDir`, `autoMsg`, plus `autoCategorize()`. Plus **new** state:
`selectedIds` (Set), `page`, `pageSize`.

**Derived values computed INSIDE this component:** `months`, `scopedTxs`, `filteredTxs`,
`statusCounts`, `filtIncome/filtExpenses/filtNet`, `hasSpending`. (Logic is identical to
Banking.jsx:924–954 — move it verbatim.)

**Props it receives from Banking:**
```jsx
<TransactionsTable
  transactions={bankTxs}      // already filtered to bank accounts (Banking.jsx:868)
  bankAccounts={bankAccounts}
  coaById={coaById}
  reconcileFlags={reconcileFlags}
  selectedAcct={selectedAcct} // used for the account filter + showAccount toggle
  onRowClick={setDetailTx}    // opens the existing TxDetailModal in Banking
  onUpdate={onUpdate}         // functional updates only — see constraints
  reload={reload}             // refetch after rule application / bulk ops
/>
```

**Stays in Banking.jsx:** account classification + `classifyAccount` export, `MetricCard`
row, `AccountStrip` + `selectedAcct` state + "Show all accounts", the
Transactions/Statements toggle (and `scopeTxCount` for its label), the whole Statements
view, `detailTx` + `TxDetailModal` + `ReceiptPanel`, and the `vaultData`/`coa`/
`reconcileFlags` fetches.

---

## Hard constraints (breaking any of these is a regression)

1. **`classifyAccount` must stay exported from `Banking.jsx`** — App.jsx imports it (App.jsx:12).
2. **Props contract `{ accounts, transactions, onUpdate }` is fixed** by App.jsx — don't change it.
3. **`onUpdate` must be called with a FUNCTION** (`prev => …`), never a stale snapshot —
   live Plaid sync pushes SSE refetches that race the UI (see Banking.jsx:721 for the existing pattern).
4. **Styling = inline styles + CSS variables only.** No Tailwind, no styled-components, no
   new color literals. Reuse the existing `inputStyle` object (Banking.jsx:956) and vars like
   `var(--green)`, `var(--bg-secondary)`, `var(--coral)`, `var(--teal)`, `var(--border)`.
5. **No new npm dependencies.** CSV + print use built-ins (`Blob`, `URL.createObjectURL`, `window`).
6. **Tabler icons** for any new buttons (`ti ti-download`, `ti ti-printer`, etc.).

---

## Data shapes

**Transaction (`tx`)**: `id`, `date` (`YYYY-MM-DD`), `desc`, `account` (account id),
`amount` (Number; **negative = spent/withdrawal**, positive = received), `category`
(spending bucket string), `coaId` (Chart-of-Accounts id or null), `pending` (bool),
`approved` (bool — CaiShen's "confirmed"; QB "Posted" ≈ this), `month` (`YYYY-MM`),
`source` (`plaid` | `csv_import` | `manual`), `note`. Override-backed (optional):
`excluded` (bool), `attachments` (array).

**Account (`acc`)**: `id`, `name`, `institution`, `last4`, `balance`,
`availableBalance`, `type`, `subtype`, `source`.

**Server PATCH** `PATCH /api/transactions/:id` does `{ ...existing, ...req.body }`
(partial merge — routes.js:100). So bulk approve = `axios.patch(`/api/transactions/${id}`, { approved: true })` per row.

---

## Execution checklist

### Step 1 — Extract (ZERO visual change), then verify
- [ ] Create `bankingFormat.js`; move `fmt/fd/fmtFull/CAT_COLOR/TYPE_*` there; export them.
- [ ] Update Banking.jsx to `import { fd, fmtFull, TYPE_ORDER, TYPE_LABELS, TYPE_COLORS } from './bankingFormat'` (MetricCard/AccountCard/TxDetailModal still need these).
- [ ] Create `TransactionsTable.jsx`; move `TxTable` + `SpendingBreakdown` + the toolbar +
      the listed state/derived logic; import what it needs from `./bankingFormat`.
- [ ] In Banking.jsx, replace lines ~1020–1078 with `{view==='transactions' && <TransactionsTable …/>}`
      and delete the now-unused state/derived vars that moved.
- [ ] **Verify identical:** run the app (below), open Banking, confirm the table, filters,
      tabs, totals, sorting, row-click→modal, and spending sidebar all look/behave exactly as before.
      **Do not proceed until this is byte-for-byte the same.**

### Step 2 — Feature A: row checkboxes + bulk action bar
- [ ] Add a leading checkbox `<th>`/`<td>` column to `TxTable`. Header = select-all
      (indeterminate when partial); row checkbox toggles `tx.id` in `selectedIds` (Set).
- [ ] Checkbox `onClick` must `e.stopPropagation()` so it doesn't open the row modal.
- [ ] When `selectedIds.size > 0`, show a bulk bar above the table: "N selected" +
      **Approve** (`PATCH {approved:true}` for each, `Promise.all`, then `reload()`),
      **Clear selection**. (Bulk "Categorize…" optional — a small COA `<select>` → `PATCH {coaId}`.)
- [ ] Style: `accent-color: var(--green)` on checkboxes; bulk bar uses `var(--bg-secondary)` + `var(--border)`.
- [ ] Verify: select a few rows → bar appears → Approve → rows move to Approved tab; counts update.

### Step 3 — Feature B: pagination
- [ ] State `page` (1-based) + `pageSize` (default 50). Render only the current slice of `filteredTxs`.
- [ ] Footer bar: `"{start}–{end} of {total}"`, `‹ Prev` / `Next ›` (disabled at ends),
      and a page-size `<select>` (25 / 50 / 100). Mirror QuickBooks' layout.
- [ ] **Totals strip (Deposits/Withdrawals/Net/Count) must stay computed over the FULL
      `filteredTxs`, not the current page.**
- [ ] Reset `page` to 1 via `useEffect` whenever `search`/`filterMonth`/`statusFilter`/`selectedAcct` change.
- [ ] Verify: paging works, page size changes, totals unaffected by page.

### Step 4 — Feature C: export CSV + print
- [ ] **Export CSV** button (`ti ti-download`): build CSV from ALL `filteredTxs` (not just the
      page) — columns: Date, Description, Account, Category (COA name or bucket), Spent,
      Received, Status (Pending/Posted). Download via `Blob` + temporary `<a download>`.
- [ ] **CSV formula-injection guard** (finance app — security matters): prefix `'` to any
      cell whose first char is one of `= + - @ \t \r`, EXCEPT plain signed numbers (so
      `-12.50` survives). Mirror the server's `toCsv()` in `server/crypto-reports.js`.
- [ ] **Print** button (`ti ti-printer`): open a new window with a clean, light HTML table
      of the current `filteredTxs` and call `print()`. (Don't touch global CSS.)
- [ ] Place both buttons right-aligned in the toolbar near Auto-categorize; style via `inputStyle`.
- [ ] Verify: CSV downloads and opens correctly; a cell starting with `=` is escaped; print preview shows the table.

---

## Verification — how to run (two terminals, per project CLAUDE.md)

```bat
:: Terminal 1 — backend (port 3001)
cd C:\Users\Albert Yang\Desktop\CaiShen
npm start

:: Terminal 2 — frontend (port 5173)
cd C:\Users\Albert Yang\Desktop\CaiShen\client
npm run dev
```
Open http://localhost:5173 → log in → Banking. Use the preview tools to snapshot/screenshot
the table before (Step 1 baseline) and after each feature. No new deps, so no `npm install` needed.

---

## Out of scope for THIS run (stage next)
- Date-range picker (today: month dropdown only) and transaction-**type** dropdown.
- Per-row 📎 attachment / 💬 note indicator icons (data exists: `tx.attachments`, `tx.note`).
- Per-row inline action button (QB "Post" dropdown) — bulk Approve covers the main need first.
- **Match / PAIR** badge (match a bank line to an existing record) — deepest feature; CaiShen's
  `reconcileFlags` + COA are adjacent but not identical.
- An **"Excluded"** tab (server already supports `excluded` via `PATCH /api/tx-overrides/:id`).
- Moving `TxDetailModal` + `ReceiptPanel` into the new file.

---

## Bonus facts discovered (for later features)
- `GET /api/transactions` merges per-tx overrides (`vendor`, `attachments`) from
  `tx_overrides.json` (routes.js:80–81). Overrides are **sync-safe** (Plaid re-sync won't wipe them).
- `PATCH /api/tx-overrides/:id` accepts `category`, `excluded`, `attachments` (full array),
  or `addAttachment` / `removeAttachment` (vault file id helpers) — routes.js:113–116.
