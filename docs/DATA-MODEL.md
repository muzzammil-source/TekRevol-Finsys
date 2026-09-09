# Data model

SQLite (`server/finance.db`), WAL journal mode, `foreign_keys = ON`. The schema is
created idempotently at server boot in `server/index.ts` — `CREATE TABLE IF NOT
EXISTS` plus guarded `ALTER TABLE` statements for columns added later. There is no
migration tool; see `docs/ROADMAP.md`.

Conventions: `id` is `INTEGER PRIMARY KEY AUTOINCREMENT`; dates are `YYYY-MM-DD`
text; periods are `YYYY-MM` text; money is `REAL`; `usdAmount` is the reporting
figure derived from `originalAmount × exchangeRate`.

Entity codes: `CA`, `TX`, `UAE`, `PK`, `BuzzFlick`. Revenue brands exclude `PK`.

---

## Configuration

### `accounts` — chart of accounts
| Column | Type | Notes |
|---|---|---|
| `code` | TEXT | Account code, e.g. `0001` |
| `category` | TEXT | Grouping, e.g. `Tools & Subscription` |
| `name` | TEXT | Required |
| `type` | TEXT | `expense` or `revenue` |
| `description` | TEXT | |

### `departments`
| Column | Type | Notes |
|---|---|---|
| `name` | TEXT | UNIQUE, `COLLATE NOCASE` |

### `exchange_rates`
| Column | Type | Notes |
|---|---|---|
| `currency` | TEXT | e.g. `PKR`, `AED` |
| `rateToUsd` | REAL | Multiplier to USD |
| `effectiveMonth` | TEXT | `YYYY-MM` |
| `notes` | TEXT | |

UNIQUE `(currency, effectiveMonth)`. Rates are per month and historical — never
recompute past USD amounts with a newer rate.

### `allocation_rules` — reusable cost splits
| Column | Type | Notes |
|---|---|---|
| `name`, `description` | TEXT | |
| `caPct`, `txPct`, `uaePct`, `pkPct`, `buzzPct` | REAL | Should total 100; **not enforced** |

---

## Transactions

### `revenue`
| Column | Type | Notes |
|---|---|---|
| `date` | TEXT | When it happened |
| `brand` | TEXT | `CA` \| `TX` \| `UAE` \| `BuzzFlick` |
| `projectName`, `client` | TEXT | `client` required |
| `revenueType` | TEXT | `Fresh` \| `Recurring` \| `Upsell` |
| `originalCurrency`, `originalAmount`, `exchangeRate`, `usdAmount` | | |
| `actualMonth` | TEXT | `YYYY-MM` — the reporting period |
| `cashReceivedIn` | TEXT | Entity that received the cash |
| `notes` | TEXT | |

`date` vs `actualMonth`: revenue can be earned in one month and reported in
another. Reports key off `actualMonth`.

### `expenses`
| Column | Type | Notes |
|---|---|---|
| `date` | TEXT | |
| `vendor` | TEXT | Required |
| `expenseCategory`, `expenseHead`, `description` | TEXT | `expenseHead` required |
| `department` | TEXT | Free text, validated against `departments` in the UI |
| `accountId` | INTEGER | Loose reference to `accounts.id` — **no FK constraint** |
| `originalCurrency`, `originalAmount`, `exchangeRate`, `usdAmount` | | |
| `paidByEntity` | TEXT | Which entity actually paid; default `PK` |
| `paidFromBank` | TEXT | Bank account used |
| `costOwner` | TEXT | Entity code, or `Shared` |
| `allocationMethod` | TEXT | `Direct` \| `Percentage` \| `Equal Split` \| `Manual` |
| `caPct`, `txPct`, `uaePct`, `pkPct`, `buzzPct` | REAL | Split when `costOwner = Shared` |
| `actualMonth` | TEXT | Reporting period |
| `notes` | TEXT | |

`paidByEntity` and `costOwner` are deliberately separate: one entity paying for
another is what drives intercompany recharge.

### `intercompany_transactions`
| Column | Type | Notes |
|---|---|---|
| `fromEntity`, `toEntity` | TEXT | Entity codes |
| `date` | TEXT | |
| `originalCurrency`, `originalAmount`, `exchangeRate`, `usdAmount` | | |
| `description` | TEXT | |

---

## Period spreading

### `expense_monthly_allocations`
| Column | Type | Notes |
|---|---|---|
| `expenseId` | INTEGER | FK → `expenses(id)` ON DELETE CASCADE |
| `month` | TEXT | `YYYY-MM` |
| `amount` | REAL | USD portion for that month |
| `caPct`…`buzzPct` | REAL | Per-month split, may differ from the parent row |

### `revenue_monthly_allocations`
| Column | Type | Notes |
|---|---|---|
| `revenueId` | INTEGER | FK → `revenue(id)` ON DELETE CASCADE |
| `month` | TEXT | `YYYY-MM` |
| `amount` | REAL | USD portion for that month |

Used for prepaid costs and deferred revenue. **When rows exist for a transaction,
reporting must use them instead of the parent row's own month.**

---

## Banking

### `plaid_items` — a connected or manual bank profile
| Column | Type | Notes |
|---|---|---|
| `itemId` | TEXT | UNIQUE; Plaid item id, or a generated id for manual profiles |
| `institutionId`, `institutionName` | TEXT | |
| `accessToken` | TEXT | **Stored in plaintext** — see roadmap |
| `cursor` | TEXT | Plaid sync cursor |
| `provider` | TEXT | `plaid` by default |
| `country`, `icon` | TEXT | |
| `isManual` | INTEGER | `1` for manual profiles (no Plaid connection) |
| `createdAt`, `updatedAt` | TEXT | Defaults to `CURRENT_TIMESTAMP` |

### `plaid_accounts`
| Column | Type | Notes |
|---|---|---|
| `itemId` | INTEGER | FK → `plaid_items(id)` ON DELETE CASCADE |
| `plaidAccountId` | TEXT | UNIQUE |
| `name`, `officialName`, `mask`, `type`, `subtype` | TEXT | |
| `isoCurrency` | TEXT | |
| `currentBalance`, `availableBalance` | REAL | Nullable |

### `plaid_transactions`
| Column | Type | Notes |
|---|---|---|
| `itemId` | INTEGER | FK → `plaid_items(id)` ON DELETE CASCADE |
| `plaidTransactionId` | TEXT | UNIQUE |
| `plaidAccountId`, `date`, `authorizedDate` | TEXT | |
| `name`, `merchantName`, `category` | TEXT | |
| `amount` | REAL | Positive = money out, per Plaid's convention |
| `isoCurrency` | TEXT | |
| `pending` | INTEGER | |
| `rawJson` | TEXT | Full Plaid payload |
| review status | TEXT | `pending` \| `posted` \| `excluded` |

A reviewed transaction is **not** linked to an expense record. Building that link
is the reconciliation work in the roadmap.

### `bank_statements`
| Column | Type | Notes |
|---|---|---|
| `itemId` | INTEGER | FK → `plaid_items(id)` ON DELETE CASCADE |
| `originalName` | TEXT | |
| `storedName` | TEXT | UNIQUE; file on disk under `server/uploads/bank-statements/` |
| `mimeType`, `fileSize`, `createdAt` | | |

---

## Structural notes

**Entities as columns.** `caPct`, `txPct`, `uaePct`, `pkPct`, `buzzPct` repeat on
`expenses`, `allocation_rules` and `expense_monthly_allocations`. A sixth entity
means altering three tables and touching most of the API and UI. The fix is an
`entities` table plus a row-per-entity `allocations` table
(`parentType`, `parentId`, `entityCode`, `pct`, `amount`). This is the largest
open refactor.

**No audit columns.** Only `plaid_*` tables carry timestamps. Core financial
tables record neither when a row was created or changed nor by whom.

**Loose references.** `expenses.accountId` and every `brand` / `costOwner` /
`paidByEntity` / `department` value are unconstrained text or unenforced ids.
Referential integrity depends on the UI behaving.
