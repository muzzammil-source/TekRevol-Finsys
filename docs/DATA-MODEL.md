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
| `code` | TEXT | Auto-assigned from the type's band: Asset 1000s, Liability 2000s, Equity 3000s, Revenue 4000s, Expense 5000s (e.g. `4010`) |
| `category` | TEXT | Derived from `subType`; load-bearing for reports/posting (e.g. `Cash & Equivalents`, `Cost of Goods Sold`) |
| `name` | TEXT | Required |
| `type` | TEXT | **Statutory type**: `Asset` \| `Liability` \| `Equity` \| `Revenue` \| `Expense`. Enforced by the API and by DB triggers `trg_accounts_type_valid_ins/upd`. Locked once the account has journal lines. |
| `subType` | TEXT | Free-text sub-type (e.g. `Bank`, `Operating Revenue`, `Intercompany Clearing`) |
| `description` | TEXT | |
| `currency` | TEXT | Default `USD` |
| `entityId` | INTEGER | FK → `entities(id)` ON DELETE SET NULL. `NULL` = Shared / Master head. Locked once the account has journal lines. |
| `isActive` | INTEGER | `1`/`0`. Inactive accounts keep their history but reject new postings. |
| `counterpartyEntityId` | INTEGER | FK → `entities(id)` ON DELETE SET NULL (2026-09-16). Set on intercompany clearing accounts: in `entityId`'s books, "Due From Affiliates — X" (Asset) / "Due To Affiliates — X" (Liability) where X = this entity. One pair per ordered (owner, counterparty) pair — 2·N·(N−1) accounts for N entities — created on entity create, backfilled at boot, and self-healed at posting. Posting routes by this id, never by name. |
| `parentId` | INTEGER | FK → `accounts(id)` ON DELETE SET NULL (2026-09-16). Sub-account hierarchy: parent must have the same `type`; an entity's account may sit under that entity's or a Shared parent, a Shared account only under a Shared parent; no cycles; max 4 levels. |

Deletion rule: an account referenced by journal lines, sub-accounts, a bank feed (`bank_accounts.glAccountId`), categorization rules, bills, invoices or payment records cannot be deleted — deactivate it instead.

Balances are stored/returned as debit − credit and **presented** on the account's natural side (`src/lib/account-balance.ts`): credit-normal types (Liability, Equity, Revenue) show credit − debit, so a minus sign only appears for an abnormal position. A parent's COA balance is the roll-up of itself + descendants (display only).

### `users`, `user_entities`, `sessions` — authentication & RBAC (2026-09-17)
| Table / column | Notes |
|---|---|
| `users.email` | Unique (case-insensitive) |
| `users.passwordHash` | `scrypt$N$r$p$salt$hash` (Node crypto scrypt, 16-byte salt) |
| `users.role` | `Admin` \| `Manager` \| `Bookkeeper` \| `Auditor` (CHECK) |
| `users.allEntities` | 1 = every entity (Admins always) |
| `users.status` | `Active` \| `Disabled` — disabling deletes the user's sessions |
| `users.mustChangePassword` | 1 after admin creation / reset; API refuses data access until changed |
| `user_entities (userId, entityId)` | Explicit entity access when `allEntities = 0` |
| `sessions.tokenHash` | SHA-256 of the random cookie token (the token itself is never stored); 12h sliding expiry |
| `password_resets.tokenHash` | SHA-256 of the link token (2026-10-12) — same reasoning as sessions: the email holds the only copy, so a leaked database can't take an account |
| `password_resets.expiresAt` / `usedAt` | 1h expiry, single use. Requesting again deletes the account's other unused rows; a completed reset also clears every session for that user |

`bank_transactions.stagedJson` / `stagedByUserId` / `stagedAt` (2026-09-17): "Save for review" — categorization prepared by a user who can't post (`{accountId, chargedToEntityId, contactId, splits}`), cleared when the transaction is posted. Not accounting data.

### Balance trigger: USD, not native (2026-09-18)
`trg_journal_balance_on_post` was replaced by **`trg_journal_balance_on_post_usd`** (the old one is dropped by name at boot — a trigger body can't be altered in place). It blocks Draft → Posted unless `Σ(debit × exchangeRate) = Σ(credit × exchangeRate)` within half a cent, i.e. the entry balances in USD, the reporting currency. For a single-currency entry this is the old test scaled by one rate; a multi-currency manual entry (e.g. an AED line against a USD line) can only balance this way.

### `split_rules` / `split_rule_lines` — reusable multi-entity split templates (2026-09-17)
| Column | Type | Notes |
|---|---|---|
| `split_rules.name` | TEXT | e.g. "50/50 Dual Entity" |
| `split_rules.description` | TEXT | Optional note on when to use it |
| `split_rules.isActive` | INTEGER | Inactive rules stay listed but aren't offered in the Split modal |
| `split_rule_lines.ruleId` | INTEGER | FK → `split_rules(id)` ON DELETE CASCADE |
| `split_rule_lines.entityId` | INTEGER | FK → `entities(id)` ON DELETE CASCADE. One line per entity |
| `split_rule_lines.percent` | REAL | Percent to 4 dp; a rule's lines must total exactly 100 (server-validated) |

Configuration only: applying a rule fills the Banking Split modal's lines. No journal line ever references a rule, so editing or deleting one cannot change posted history.

### `contacts` — Customer / Vendor master (2026-09-16)
| Column | Type | Notes |
|---|---|---|
| `name` | TEXT | Required. Unique per (`lower(name)`, `contactType`, entity) |
| `contactType` | TEXT | `Customer` \| `Vendor` (CHECK) |
| `entityId` | INTEGER | FK → `entities(id)` ON DELETE SET NULL. `NULL` = Shared |
| `email` | TEXT | Optional |
| `projectName` | TEXT NOT NULL DEFAULT '' | (2026-09-17) Customer's project; always `''` for vendors (server clears it) |
| `isActive` | INTEGER | Inactive contacts keep history but can't be used on new postings |
| `openingBalanceEntryId` | INTEGER | FK → `journal_entries(id)` ON DELETE SET NULL. The Posted `source='OpeningBalance'` entry carrying the contact's opening balance: Customer Dr Accounts Receivable / Cr Opening Balance Equity; Vendor Dr OBE / Cr Accounts Payable (reversed for a negative amount), in the contact's entity's functional currency. The AR/AP line is tagged with the contact. AR / AP / OBE accounts are auto-created (Shared) on first use if the chart has none. The amount is read back from the entry, never stored. |
| `createdAt` | TEXT | |

Sub-ledger link: `journal_lines.contactId` (FK → `contacts(id)`) on the **target** line of a bank-feed posting (never the cash or intercompany-clearing legs). `journal_entries.contactId` / `contactType` are stamped only when every tagged line in that entry has the same contact. A contact used on a line must belong to that line's entity or be Shared. **No balance is stored**: `receivedUSD` (Σ credits), `paidUSD` (Σ debits) and `outstandingUSD` (Customer: Dr − Cr on `Receivables` accounts; Vendor: Cr − Dr on `Payables` accounts) are derived from Posted tagged lines, so unposting reverses them. Type/entity are locked and delete is refused once a contact has ledger lines.

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
