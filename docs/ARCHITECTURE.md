# Architecture

## Shape of the system

```
┌──────────────────────────────────────────────────────────┐
│ Browser — React 18 SPA                                   │
│   wouter routes → src/pages/*.tsx                        │
│   TanStack Query cache                                   │
└───────────────────────┬──────────────────────────────────┘
                        │ hooks only (never raw fetch)
┌───────────────────────▼──────────────────────────────────┐
│ packages/api-client-react                                │
│   one hook per endpoint, query keys, mutations           │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP /api/*
                        │ dev: Vite :5000 proxies → :3001
                        │ prod: same origin :5000
┌───────────────────────▼──────────────────────────────────┐
│ server/index.ts — Express                                │
│   routes · schema bootstrap · report derivation          │
│   multer uploads · Plaid client (optional)               │
└───────────────────────┬──────────────────────────────────┘
                        │ better-sqlite3 (synchronous)
┌───────────────────────▼──────────────────────────────────┐
│ server/finance.db — SQLite, WAL, foreign_keys ON         │
└──────────────────────────────────────────────────────────┘
```

## The three-layer rule

The product requirement "keep data entry separate from reporting and
configuration/rules" is reflected in the navigation and should be reflected in
every change:

| Layer | Screens | Writes to |
|---|---|---|
| **Configuration & rules** | Chart of Accounts, Exchange Rates, Allocation Rules | `accounts`, `departments`, `exchange_rates`, `allocation_rules` |
| **Data entry** | Revenue, Expenses, Intercompany, Bank Transactions | `revenue`, `expenses`, `intercompany_transactions`, `plaid_*` |
| **Reporting** | Dashboard, Consolidated P&L, Monthly P&L, Brand P&L, Allocation Engine | nothing — read only |

Reporting endpoints compute from transactional tables on every request. No report
figure is ever stored. This is what makes the numbers auditable and it is the
rule most likely to be broken accidentally by a performance optimisation — if
report queries get slow, add indexes or a cache with explicit invalidation, not a
totals table.

## Request lifecycle

1. A page calls a hook, e.g. `useListRevenue({ month })`.
2. The hook issues `GET /api/revenue?month=2026-09` under the query key
   `['revenue', { month }]`.
3. Express handles it synchronously against SQLite (`better-sqlite3` has no async
   overhead; queries block the event loop, which is fine at this data volume).
4. A mutation hook posts, then the page invalidates the affected query keys.

Because the API client is a workspace package rather than generated code, adding
an endpoint is a two-file change: the route and the hook.

## Money and currency

Every monetary row stores the original currency and amount alongside the USD
figure and the rate used. USD is the reporting currency throughout. Rates are
monthly, keyed `(currency, effectiveMonth)`, so historical figures stay stable
when a rate changes. Nothing recomputes USD amounts retroactively, and nothing
should.

## Allocation engine

Costs are attributed to entities in three steps:

1. **Direct** — `costOwner` names one entity; 100% lands there.
2. **Shared** — `costOwner = 'Shared'`; the `*Pct` columns split it, either typed
   in or copied from a named `allocation_rules` row.
3. **Period spreading** — optional rows in `expense_monthly_allocations` /
   `revenue_monthly_allocations` spread one transaction across several months,
   with their own per-month split. When present these take precedence over the
   parent row's month and percentages.

`paidByEntity` is tracked separately from `costOwner`: entity A paying entity B's
cost is precisely the intercompany recharge case, and the Intercompany screen
reports on it.

## Banking

Two paths, both landing in the same tables:

- **Plaid** — link token → public token exchange → item stored → cursor-based
  transaction sync.
- **Manual** — a bank profile created by hand, plus uploaded statement files
  stored under `server/uploads/bank-statements/`.

Transactions carry a review status (`pending` / `posted` / `excluded`). Review is
currently a label only: nothing creates an expense record from a bank line, and
nothing matches a bank line to an existing expense. Closing that loop is the
reconciliation work in the roadmap.

Plaid credentials are optional. Absent them, `/api/plaid/status` reports the
feature off and the screen falls back to manual profiles.

## Frontend structure

- `src/App.tsx` — route table. One route per page component.
- `src/components/layout.tsx` — `PageHeader` / `PageContent` shell and sidebar.
- `src/components/ui/*` — shadcn primitives. Generated; compose rather than edit.
- `src/components/formatters.tsx` — currency and number display. Use it, so
  figures format identically everywhere.
- `src/lib/constants.ts` — entities, brands, currencies, banks, departments,
  and `entityLabel()` for display names. Internal codes are stable; labels can
  change without touching data.
- Excel import/export uses SheetJS inside the page component that owns the grid.

## Deployment

`pnpm run build` emits `dist/public`. With `NODE_ENV=production`, Express serves
that directory plus `/api` on a single port and falls back to `index.html` for
client-side routes. One process, one port, one SQLite file — it runs behind
nginx, in a container, or on any PaaS with a persistent volume for the database.

The persistent volume matters: SQLite is a file. A platform with an ephemeral
filesystem will silently lose financial data on redeploy.

## Deliberate simplifications, and when to revisit

| Choice | Fine while | Revisit when |
|---|---|---|
| SQLite, single file | one office, modest volume, one writer | concurrent writers, or you need managed backups → PostgreSQL |
| Whole API in one file | ~1,900 lines, one domain | it passes ~3,000 lines or two people edit it at once → split by domain |
| No ORM, hand-written SQL | queries stay readable and explicit | schema churn makes hand-written migrations risky → Drizzle or Prisma |
| No auth | localhost only | the moment it is reachable by anyone else — this is now |
| Entities as columns | five fixed entities | a sixth entity, or per-entity configuration → normalise (see DATA-MODEL) |
