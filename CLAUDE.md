# CLAUDE.md — working agreement for TekRevol FinSys

Read this before changing anything. It describes how this codebase actually works,
the rules that keep the financial numbers trustworthy, and the traps in the current
implementation.

---

## 1. What this system is

An internal finance platform for TekRevol. It is the single source of truth for
revenue, expenses, bank activity, intercompany transfers, cost allocation and P&L
across five entities: `CA`, `TX`, `UAE`, `PK`, `BuzzFlick`. Revenue is booked
against four of them (`PK` is a cost centre, not a revenue brand).

**Non-negotiable product rules** — every change must respect these:

1. One reliable source of truth. No number is entered twice.
2. Data entry, reporting and configuration/rules stay separate.
3. **Reports are always derived from transactional data.** Never store a computed
   report figure. If a total is wrong, fix the derivation or the transactions.
4. Calculations stay transparent and traceable back to source rows.
5. The system must stay modular: adding an entity, brand, report or module must
   not require restructuring the application. (Today it does — see §6.)

## 2. Commands

```bash
pnpm install          # install (workspace: ., packages/*, server)
pnpm run dev:all      # API :3001 + web :5000 — normal dev loop
pnpm run typecheck    # MUST pass before you consider a change done
pnpm run build        # frontend → dist/public
pnpm run start        # production (serves API + built frontend on :5000)
```

Verification loop for any change: `pnpm run typecheck` → `pnpm run build` →
run `dev:all` and exercise the affected screen. There is no test suite yet; adding
one is the first item on the roadmap.

## 3. Architecture in one page

```
Browser (React SPA, wouter routes)
   │  hooks only — never raw fetch
   ▼
packages/api-client-react   ← the ONLY place the frontend talks to HTTP
   │  /api/*
   ▼
server/index.ts             ← Express, one file, all routes + schema
   │  better-sqlite3 (synchronous)
   ▼
server/finance.db           ← SQLite, WAL mode, foreign_keys ON
```

- **Dev:** Vite on 5000 proxies `/api` to Express on 3001.
- **Prod:** Express on 5000 serves both `/api` and `dist/public`.
- The schema is created idempotently at server boot (`CREATE TABLE IF NOT EXISTS`
  plus ad-hoc `ALTER TABLE` guards). There is no migration tool.

## 4. Conventions

**Adding an endpoint**

1. Add the route in `server/index.ts` next to its sibling routes.
2. Add a matching hook in `packages/api-client-react/src/index.ts`.
3. Consume the hook in the page. Never call `fetch` from a component.
4. Invalidate the right query keys after mutations — keys are the plain strings
   already used in that file (`['revenue', params]`, `['dashboard', params]`, …).

**Money**

- Every amount is stored twice: `originalCurrency` + `originalAmount`, and
  `usdAmount` computed with the `exchangeRate` in effect for that month.
- USD is the reporting currency. Rates live in `exchange_rates`, keyed by
  `(currency, effectiveMonth)` where month is `YYYY-MM`.
- Never re-derive historical USD amounts from today's rate.

**Dates and periods**

- `date` is `YYYY-MM-DD`; period fields (`actualMonth`, `month`,
  `effectiveMonth`, `cashReceivedIn`) are `YYYY-MM`.
- `date` is when the transaction happened; `actualMonth` is the period it belongs
  to for reporting. They differ deliberately — respect the distinction.

**Frontend**

- Path alias `@/` → `src/`. UI primitives in `src/components/ui` are generated
  shadcn components; prefer composing over editing them.
- Entities, brands, currencies, banks and departments come from
  `src/lib/constants.ts`. Display names come from `entityLabel()` — internal codes
  (`UAE`) stay stable while labels (`TekRevol AE`) can change.
- Excel import/export uses SheetJS in the page component.

**Style**

- TypeScript strict is on. Do not introduce `any` where a real type is possible;
  the few remaining `any`s are technical debt, not a pattern to copy.
- Match the surrounding file's formatting. No new formatter configs.

## 5. Allocation model (read before touching reports)

Shared costs are spread across entities by percentage columns on the expense row:
`caPct`, `txPct`, `uaePct`, `pkPct`, `buzzPct`. `allocationMethod` is one of
`Direct`, `Percentage`, `Equal Split`, `Manual`. Named reusable splits live in
`allocation_rules`. A cost booked to one entity uses `costOwner`; `Shared` means
the percentages apply.

`expense_monthly_allocations` and `revenue_monthly_allocations` spread a single
transaction across several months (deferred revenue, prepaid costs). When they
exist for a row, reporting must use them rather than the row's own month.

**Percentages must total 100 for a shared cost.** This is not enforced anywhere
yet. Do not add features that assume it is.

## 6. Known constraints — do not paper over these

- **Entities are hardcoded as columns** (`caPct`, `txPct`, …) in the schema, the
  API and the UI. Adding a sixth entity currently means a schema change plus edits
  across most files. This directly violates product rule 5 and is the single
  biggest refactor on the roadmap (normalise to an `allocations` row-per-entity
  table). Do not add a sixth `*Pct` column — raise the refactor instead.
- **No authentication, no users, no roles.** Every request is anonymous.
- **No audit trail.** Most tables have no `createdAt`/`updatedAt` and nothing
  records who changed what. Financial edits are silently destructive.
- **No server-side validation.** `zod` is a dependency but the API does not
  validate request bodies. Bad input reaches SQLite directly.
- **No migrations.** Schema changes are hand-written `ALTER TABLE` guards at boot.
- **No budgets, no variance analysis.** The requirement exists; the module does not.
- **Bank reconciliation is partial.** Transactions can be fetched and reviewed
  (pending / posted / excluded) but are never matched to expense records.
- **`server/finance.db` is committed to git.** Convenient for handoff, wrong for
  the long run: it will conflict on merge and it puts live financial data in the
  repository. Move to a seed script plus an ignored working database.
- **Plaid is optional.** Without `PLAID_CLIENT_ID`/`PLAID_SECRET` the bank screen
  still works using manual bank profiles and uploaded statements.

## 7. Ground rules for changes

- Never invent or hardcode a financial figure to make a screen look right. Empty
  states are correct when there is no data.
- Never let a report read from anything but transactional tables.
- Schema change → update `docs/DATA-MODEL.md`. New endpoint → update `docs/API.md`.
- Keep `server/index.ts` organised by domain section as it is today; if you split
  it into modules, do it as one deliberate refactor, not incidentally.
- Before finishing: `pnpm run typecheck` and `pnpm run build` both clean.
