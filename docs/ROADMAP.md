# Roadmap

Where the system stands against the thirteen product requirements, and the order
to build in. Each phase is written so a Claude Code session can pick it up from
the heading alone.

---

## Requirement scorecard

| # | Requirement | Status | Gap |
|---|---|---|---|
| 1 | One reliable source of truth | **Partial** | Data is centralised, but with no auth, no validation and no audit trail it is not yet *reliable* |
| 2 | Multiple entities, brands, departments, accounts, currencies, periods | **Partial** | All present, but entities and brands are hardcoded in the schema and UI |
| 3 | Entry separate from reporting and configuration | **Done** | Navigation and endpoints already enforce it |
| 4 | Reports derived from transactional data | **Done** | No stored report totals anywhere |
| 5 | Monthly, yearly, entity-wise, brand-wise reporting | **Mostly done** | Monthly, brand and consolidated P&L exist; yearly rollups are thin |
| 6 | Revenue/expense classification, allocation, costing, intercompany recharge | **Partial** | Classification and allocation work; recharge is recorded manually, not generated from shared costs |
| 7 | Bank transaction management and reconciliation | **Partial** | Import and review work; **no matching, no posting to expenses** |
| 8 | P&L, KPIs, dashboards, budgets, variance | **Partial** | P&L, KPIs and dashboards exist; **budgets and variance do not exist at all** |
| 9 | Excel import/export | **Mostly done** | Import/export on the main grids; no validation or error report on import |
| 10 | Validation, auditability, data consistency | **Missing** | No server-side validation, no audit log, loose referential integrity |
| 11 | Transparent calculations, no duplicate entry | **Partial** | Calculations are derived; there is no drill-down from a report figure to source rows |
| 12 | Modular and scalable | **At risk** | Hardcoded entity columns mean a new entity restructures the app |
| 13 | Accuracy, usability, performance, management visibility | **Partial** | Good UI and fast at current volume; accuracy is unguarded (no tests) |

---

## Phase 1 — Foundation (do this before any new features)

Nothing else is safe to build on until this is done.

**1.1 Authentication and roles.** Session-based login (`SESSION_SECRET` is already
reserved). Roles: `admin`, `finance`, `viewer`. Viewers read reports; finance
enters data; admin manages configuration and users. Every `/api` route behind
auth.

**1.2 Server-side validation.** `zod` is already a dependency and unused on the
server. One schema per entity, shared between the API and the forms. Reject bad
input with a field-level error response instead of writing it to SQLite. Enforce
the rule that a shared cost's percentages total 100.

**1.3 Audit trail.** Add `createdAt`, `updatedAt`, `createdBy`, `updatedBy` to
every financial table, and an `audit_log` table (`table`, `rowId`, `action`,
`before`, `after`, `userId`, `at`). Financial edits must stop being silently
destructive.

**1.4 Migrations.** Replace the boot-time `CREATE TABLE IF NOT EXISTS` / `ALTER
TABLE` guards with numbered migration files and a `schema_migrations` table, or
adopt Drizzle. Hand-guarded DDL will not survive the schema changes below.

**1.5 Get the database out of git.** Ship `server/seed.ts` with the chart of
accounts, departments and exchange rates; gitignore `finance.db`; document the
backup command. Keep a one-off dump of the current data for reference.

**1.6 A test suite.** Vitest, focused on the maths that matters: currency
conversion, allocation splits, period spreading, and each P&L endpoint against a
fixture database. This is what makes every later refactor safe.

## Phase 2 — Make it genuinely modular (requirement 12)

The `caPct` / `txPct` / `uaePct` / `pkPct` / `buzzPct` columns are the structural
flaw. Replace them:

- `entities` table — `code`, `name`, `type` (`entity` / `brand`), `baseCurrency`,
  `isRevenueBrand`, `active`, `sortOrder`.
- `allocations` table — `parentType` (`expense` / `rule` / `expense_month`),
  `parentId`, `entityId`, `pct`, `amount`.
- Migrate existing rows into it, then drop the `*Pct` columns.
- Serve the entity list from `/api/entities` and delete the hardcoded arrays in
  `src/lib/constants.ts`.
- Make the P&L screens and sidebar generate per-entity routes from that list
  rather than the fixed CA/TX/UAE/BuzzFlick pages.

After this, adding an entity is a row in a table. Do it before the data volume
makes the migration painful.

## Phase 3 — Close the finance loops

**3.1 Bank reconciliation (requirement 7).** Add `expenses.bankTransactionId` and
a matching workflow: suggest matches by amount, date window and vendor; let a
reviewer confirm a match or create an expense directly from a bank line; show a
per-account reconciliation status per month with an unreconciled list.

**3.2 Budgets and variance (requirement 8).** New `budgets` table
(`entityId`, `accountId`, `department`, `period`, `amount`, `version`). A budget
entry screen with Excel import. Variance report: budget vs actual by entity,
department and account, with absolute and percentage variance and a threshold
highlight. This requirement currently has no implementation at all.

**3.3 Automatic intercompany recharge (requirement 6).** When entity A pays a
cost owned by entity B, generate the recharge entry from the expense instead of
asking someone to key it in again. Add a monthly settlement view showing net
positions between entities.

## Phase 4 — Trust and transparency

- **Drill-down (requirement 11).** Every figure on every report clicks through to
  the transactions behind it. This is the single highest-value change for
  management confidence in the numbers.
- **Period close.** Lock a month once signed off; block edits to closed periods;
  require a reopen action that is logged.
- **Import validation.** Excel import should preview, validate row by row, and
  return a downloadable error report rather than partially writing.
- **Yearly reporting.** Full-year P&L, year-over-year comparison, quarterly
  rollups.

## Phase 5 — Scale and operations

- **PostgreSQL migration** when concurrent writers or managed backups are needed.
  Keep the SQL hand-written and portable in the meantime.
- **Split `server/index.ts`** by domain (`routes/revenue.ts`, `routes/reports.ts`,
  …) once it passes ~3,000 lines.
- **Encrypt Plaid access tokens at rest** — they are currently plaintext in
  `plaid_items.accessToken`.
- **Code-split the frontend bundle** — the main chunk is ~1 MB; route-level
  `React.lazy` and a separate `xlsx` chunk would roughly halve first load.
- **Scheduled exports and backups** — nightly SQLite backup, monthly P&L pack
  emailed to management.

---

## Suggested first session in Claude Code

```
Read CLAUDE.md and docs/ROADMAP.md. Implement Phase 1.6 (Vitest with tests for
currency conversion, allocation splits and the consolidated P&L endpoint against
a fixture database), then Phase 1.2 (zod validation on every write endpoint).
Keep pnpm run typecheck and pnpm run build clean.
```

Tests first, then validation, then auth. That sequence means every subsequent
change — especially the Phase 2 refactor — is protected.
