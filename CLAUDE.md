# CLAUDE.md — working agreement for TekRevol FinSys

Read this before changing anything. It describes how this codebase actually works,
the rules that keep the financial numbers trustworthy, and the traps in the current
implementation.

**Multi-session work is underway to replace this with a full double-entry
accounting system (target: replace QuickBooks).** Before starting any work,
read `.claude/PHASE_TRACKER.md` for the current phase and what's already
decided. Always record completed sub-phases there — do not rely on chat
history to carry state between sessions.

---

## 0. Core Architecture Rule (Phase 1+)

**This system is a strict double-entry legal book of record. All financial
entries must hit the General Ledger with balanced Debits and Credits.**

Concretely: every financial fact that matters for the books is eventually a
`journal_entries` row with two or more `journal_lines` rows whose debits sum to
exactly its credits (enforced by a SQLite trigger on posting — see
`docs/DATA-MODEL.md` once Phase 1.1 lands). The pre-Phase-1 tables described in
§5 below (`revenue`, `expenses`, single-percentage allocation) are the legacy
single-entry model; they are being superseded, not deleted mid-flight — see the
phase tracker for what still reads from which model at any given time.

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
6. **(Phase 1+) Books are double-entry.** Every posted transaction balances to
   zero net (Σ debit = Σ credit) at the journal-entry level. No code path may
   post an unbalanced entry.

## 2. Commands

```bash
pnpm install          # install (workspace: ., packages/*, server)
pnpm run dev:all      # API :3001 + web :5000 — normal dev loop
pnpm run typecheck    # MUST pass before you consider a change done (frontend + hooks + server)
pnpm run test         # unit tests (node:test via tsx) — currently the CSV import parser
pnpm run build        # frontend → dist/public
pnpm run start        # production (serves API + built frontend on :5000)
```

Verification loop for any change: `pnpm run typecheck` → `pnpm run test` →
`pnpm run build` → run `dev:all` and exercise the affected screen.

> **The typecheck gate works as of 2026-10-13** (it was broken for months —
> `typescript` wasn't installed and `tsconfig.json` only covered `src/**/*`).
> It now runs twice: `tsconfig.json` for the frontend **and**
> `packages/*/src/**` (the hook package), `tsconfig.server.json` for
> `server/**`. Turning it on immediately found a missing import that would
> have thrown at runtime, so keep it green.
>
> **Tests** are Node's built-in runner (`node:test`) through `tsx` — no test
> framework dependency. Coverage is deliberately narrow so far: the
> QuickBooks CSV parser (`server/qb-import.test.ts`), because it decides what
> becomes a journal entry. Put new pure logic in a module like that one, so it
> can be tested without booting Express or touching the database.

## 2a. Tech stack (as read from the codebase)

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 5, TypeScript (strict), TailwindCSS 4, shadcn/Radix UI, Recharts, wouter routing |
| Data fetching | TanStack Query v5, via the local `@workspace/api-client-react` hook package (the only HTTP surface — no raw `fetch` in components) |
| Backend | Express 4, TypeScript, executed directly via `tsx` (no build step for the server) |
| Database | SQLite via `better-sqlite3` (synchronous), single file `server/finance.db`, WAL mode, `foreign_keys = ON` |
| ORM / migrations | **None.** Raw SQL via `better-sqlite3` prepared statements. Schema is created idempotently at boot with `CREATE TABLE IF NOT EXISTS`, and evolved with hand-written `ALTER TABLE` guards (`ensureColumn()` in `server/index.ts`). There is no Prisma, Drizzle, SQLAlchemy, or migration tool of any kind — new tables/columns follow this same additive-guard pattern. |
| Excel I/O | SheetJS (`xlsx`), in the page component |
| Banking | Plaid (`plaid` npm package), optional — manual bank profiles work without credentials |
| Package manager | pnpm workspace: `.` (frontend), `packages/api-client-react`, `server` |
| Auth | Session cookie + RBAC (Admin / Manager / Bookkeeper / Auditor) with entity-level isolation — `server/auth.ts` (since 2026-09-17) |

**Native build note (Windows):** `better-sqlite3@9.6.0` ships no Windows Node
prebuilt binary — it must compile from source (needs VS Build Tools "Desktop
development with C++" + a matching node-gyp, and must be built against the same
Node major version `dev:all` runs under; ABI mismatches fail silently with a
`NODE_MODULE_VERSION` error).

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
- **Authentication & RBAC (2026-09-17).** Every `/api` request needs a signed-in
  session (httpOnly cookie) except `auth/status|login|bootstrap`. Roles and
  entity access are enforced **server-side** in `server/auth.ts`: a
  deny-by-default route rule table (any route without a rule is Admin-only
  and needs all-entity access), plus entity filtering/checks inside
  entity-scoped routes via `canAccessEntity` / `assertEntityAccess`.
  **When you add an endpoint, add a rule for it in `RULES`** and, if it
  returns or changes entity-scoped rows, filter/check entities in the route.
  UI hiding is convenience only. Scripts/curl must log in first (use a cookie
  session). Still missing: an audit log of who changed what.
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
- Before finishing: `pnpm run typecheck` and `pnpm run build` both clean (see the
  §2 note — typecheck is currently broken; at minimum run `build` and exercise
  the change in `dev:all`).
- **Always record completed sub-phases in `.claude/PHASE_TRACKER.md`** — check it
  off, log what was built/migrated, and update "Current Active Phase" before
  ending a session. A future session (possibly a different model) needs to be
  able to resume from that file alone.
- Never post an unbalanced journal entry, and never add a code path that can
  mark a `journal_entries` row `Posted` without its lines balancing (§0).
