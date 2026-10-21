# API reference

All routes are served by `server/index.ts` under `/api`. JSON in, JSON out.
**Authentication is required** (since 2026-09-17): every route except
`GET /api/auth/status`, `POST /api/auth/login` and `POST /api/auth/bootstrap`
needs a session cookie (`finsys_session`, httpOnly, SameSite=Lax). Access is
checked server-side by role and entity — see *Authentication & access* below.
Errors: `401 {code:"UNAUTHENTICATED"}`, `403 {code:"FORBIDDEN"|"ENTITY_FORBIDDEN"|"ENTITY_REQUIRED"|"PASSWORD_CHANGE_REQUIRED"}`, `429` on login throttle.

## Authentication & access

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/auth/status` | — | `{ needsSetup }` — true while no users exist |
| POST | `/api/auth/bootstrap` | `{ fullName, email, password }` | First-run only: creates the first Admin and signs in (409 once any user exists) |
| POST | `/api/auth/login` | `{ email, password }` | Sets the session cookie. 5 failures per email+IP → locked 15 min |
| POST | `/api/auth/logout` | — | Ends the session |
| GET | `/api/auth/me` | — | `{ user, capabilities[] }` (allowed while a temporary password is pending) |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` | Clears the temporary flag; signs out other sessions |
| POST | `/api/auth/forgot-password` | `{ email }` | Public. Emails a one-hour, single-use reset link. Always `{ ok: true }` — never reveals whether the address exists. 5 per email+IP per 15 min. Without SMTP configured the link is logged to the server console instead |
| POST | `/api/auth/reset-password` | `{ token, password }` | Public. Consumes the token, applies the password policy, ends every session for that user, then signs in with a fresh one. 400 if the token is unknown, used or expired |
| GET/POST | `/api/users` | `{ fullName, email, password, role, allEntities, entityIds[] }` | Admin only |
| PUT | `/api/users/:id` | `{ fullName?, email?, role?, allEntities?, entityIds?, status? }` | Admin only; can't demote/disable the last active Admin or disable yourself |
| POST | `/api/users/:id/reset-password` | `{ password }` | Admin only; forces a change at next sign-in, ends sessions |
| PUT | `/api/bank-transactions/:id/stage` | `{ accountId?, chargedToEntityId?, contactId?, splits? }` or `{ clear: true }` | "Save for review" — Bookkeeper and up; no ledger effect |

Passwords: ≥ 10 characters with a letter and a number. Capabilities by role:

| Capability | Admin | Manager | Bookkeeper | Auditor |
|---|:-:|:-:|:-:|:-:|
| read | ✓ | ✓ | ✓ | ✓ |
| stage (categorize / split / From-To, save for review) | ✓ | ✓ | ✓ | |
| import (statements) | ✓ | ✓ | ✓ | |
| contacts.write (no opening balances) | ✓ | ✓ | ✓ | |
| post (post / unpost / bulk, opening balances) | ✓ | ✓ | | |
| coa.write | ✓ | ✓ | | |
| admin (users, entities, exchange rates, periods, Plaid, legacy AP/AR) | ✓ | | | |

Entity isolation: users without All Entities only see their entities' rows (lists filtered server-side; Shared structure visible, but Shared records can't be created/changed). Statutory reports need `?entityId=` of an accessible entity (auto-filled when the user has exactly one); consolidated views and management analytics require all-entity access. Posting checks the bank entity and every charged-to entity. The authoritative rule list is `RULES` in `server/auth.ts` — unlisted routes are Admin + all-entities only.

The frontend never calls these directly: it uses the hooks in
`packages/api-client-react/src/index.ts`. When you add a route, add the hook.

Month parameters are `YYYY-MM`. Dates are `YYYY-MM-DD`. Amounts are numbers;
`usdAmount` is the reporting figure.

---

## Chart of accounts

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/accounts` | `?type=Asset\|Liability\|Equity\|Revenue\|Expense&entityId=` | `useListAccounts` |
| POST | `/api/accounts` | `{ name, type, subType, entityId (number or null = Shared — key required), parentId?, code? }` — 400 on invalid type/parent; `code` optional (auto from the type's band when blank), 409 if a supplied code is already used | `useCreateAccount` |
| PUT | `/api/accounts/:id` | same shape + `isActive?`; omitted fields keep current values. **409** if `type` or `entityId` changes on an account with journal lines, or if sub-accounts would no longer match | `useUpdateAccount` |
| DELETE | `/api/accounts/:id` | — **409** with a reason if the account is used (journal lines, sub-accounts, bank feed, rules, bills, invoices, payments) | `useDeleteAccount` |
| POST | `/api/accounts/bulk` | array of rows (Excel import): `Account Name`, `Main Type`, `Sub-Type`, optional `Account Code`, optional `Parent Account` (code or exact name, may be later in the file) → `{ totalRows, successCount, failedCount, errors, warnings }` | `useBulkImportAccounts` |
| POST | `/api/accounts/bulk-delete` | `{ ids: number[] }` → `{ deleted, skipped: [{ id, name, reason }] }` — deletes only unused accounts, children before parents | `useBulkDeleteAccounts` |
| GET | `/api/accounts/balances` (see also `/api/reports/general-ledger`, whose `accounts[]` carry the head's own `entityId`, `null` = Shared, and whose `lines[]` carry `transactionType` + `splitAccounts[]` — the other accounts on the same entry, for the QuickBooks-style Split column, 2026-10-12) | `?asOfDate&currency&entityId` → raw debit − credit per account. With `entityId`: that entity's + Shared accounts, and **every balance (Shared included) counts only that entity's postings** (403 without access); without it, consolidated over the user's visible entities | `useListAccountBalances` |
| GET | `/api/accounts/:id/register` | `?entityId` (optional, limits lines to that entity) → `{ account, lines[] }` with `runningBalanceUSD` (debit − credit, at each line's rate) | `useAccountRegister(id, opts, entityId)` |

Error bodies are `{ error: "…" }`; the client (`apiFetch`) surfaces that message directly.

Account fields: `id`, `code`, `category`, `name`, `type` (`Asset` \| `Liability` \|
`Equity` \| `Revenue` \| `Expense`), `subType`, `description`, `currency`,
`entityId`, `isActive`, `parentId`. See `docs/DATA-MODEL.md` for the rules.

## Customers & Vendors (sub-ledger)

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/contacts` | `?entityId=` (own + Shared) `&type=Customer\|Vendor&includeInactive=true` → contacts with derived `receivedUSD`, `paidUSD`, `outstandingUSD`, `postedLineCount`, `lastActivityDate` | `useListContacts` |
| POST | `/api/contacts` | `{ name, contactType, entityId (number or null — key required), email?, projectName? (customers only; ignored for vendors) }` — 409 on duplicate; 400 if a **Customer** is Shared (`entityId: null`) — customers belong to exactly one entity, only vendors may be Shared | `useCreateContact` |
| PUT | `/api/contacts/:id` | `{ name?, contactType?, entityId?, email?, projectName?, isActive? }` — 409 if type/entity changes on a contact with ledger lines; 400 if the change would make a Shared customer (legacy Shared customers stay editable) | `useUpdateContact` |
| DELETE | `/api/contacts/:id` | — 409 if the contact has ledger lines | `useDeleteContact` |
| GET | `/api/contacts/:id/ledger` | → `{ contact, lines[] }` — Statement of Account: Posted tagged lines (USD per line) with `affectsBalance` (Receivables/Payables line) and `runningBalanceUSD` | `useContactLedger` |
| GET | `/api/reports/subledger` | `?accountId&entityId&asOfDate&netTermsDays` → AR/AP control account itemized by customer/vendor (+ "Unassigned" for untagged lines): `{ account, items[], controlBalanceUSD, itemsTotalUSD, reconciles }`. Each item also carries `aging { current, d1_30, d31_60, d61_90, d90_plus }`, with `agingTotals` and `agingReconciles` alongside (2026-10-12) | `useSubledger` |

`fetchContactLedger(contactId)` (non-hook, same endpoint) is used for bulk ledger export: the Contacts page fetches every contact in view and `src/lib/ledger-export.ts` builds the Excel (SheetJS, summary + one sheet per contact) or PDF (`jspdf` + `jspdf-autotable`) statement client-side — opening balance, dated posted lines, debit/credit and running/closing balance. No export endpoint; figures are the same derived ledger.

Contact create/update also accept `openingBalance` (number, entity functional currency) and `openingBalanceDate` (as-of date). A non-zero opening balance requires an entity (400 for Shared). The balance fields returned per contact include `openingBalance`, `openingBalanceCurrency`, `openingBalanceDate`, `openingBalanceEntryId`; `outstandingUSD` is the Current Balance. Updating re-posts the opening entry only when amount/date (or type/entity) changes; deleting a contact whose only activity is its opening balance removes that entry too. Trial Balance rows now include `category`; Balance Sheet account rows include `accountId`.

Bank-feed posting accepts an optional payee: `POST /api/bank-transactions/:id/post` `{ …, contactId? }`, `POST /api/bank-transactions/bulk-post` items `{ …, contactId? }`, and `POST /api/bank-transactions/:id/post-split` lines `{ accountId, entityId, amount, contactId? }`. The General Ledger report returns `contactId`, `contactName`, `contactType` per line.

## Departments

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/departments` | — | `useListDepartments` |
| POST | `/api/departments` | `{ name }` | `useCreateDepartment` |

Names are unique, case-insensitive.

## Revenue

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/revenue` | `?month=YYYY-MM` | `useListRevenue` |
| GET | `/api/revenue/clients` | — | (client list for autocomplete) |
| POST | `/api/revenue` | revenue object | `useCreateRevenue` |
| PUT | `/api/revenue/:id` | revenue object | `useUpdateRevenue` |
| DELETE | `/api/revenue/:id` | — | `useDeleteRevenue` |
| POST | `/api/revenue/bulk` | array of rows | `useBulkImportRevenue` |
| POST | `/api/revenue/bulk-delete` | `{ ids: number[] }` | `useBulkDeleteRevenue` |

Revenue fields: `date`, `brand`, `projectName`, `client`, `revenueType`
(`Fresh` \| `Recurring` \| `Upsell`), `originalCurrency`, `originalAmount`,
`exchangeRate`, `usdAmount`, `actualMonth`, `cashReceivedIn`, `notes`.

## Expenses

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/expenses` | `?month=YYYY-MM` | `useListExpenses` |
| POST | `/api/expenses` | expense object | `useCreateExpense` |
| PUT | `/api/expenses/:id` | expense object | `useUpdateExpense` |
| DELETE | `/api/expenses/:id` | — | `useDeleteExpense` |
| POST | `/api/expenses/bulk` | array of rows | `useBulkImportExpenses` |
| POST | `/api/expenses/bulk-delete` | `{ ids: number[] }` | `useBulkDeleteExpenses` |

Expense fields: `date`, `vendor`, `expenseCategory`, `expenseHead`,
`description`, `department`, `accountId`, `originalCurrency`, `originalAmount`,
`exchangeRate`, `usdAmount`, `paidByEntity`, `paidFromBank`, `costOwner`,
`allocationMethod`, `caPct`, `txPct`, `uaePct`, `pkPct`, `buzzPct`,
`actualMonth`, `notes`.

## Exchange rates

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/exchange-rates` | `?month=YYYY-MM` | `useListExchangeRates` |
| POST | `/api/exchange-rates` | rate object (upsert) | `useUpsertExchangeRate` |
| DELETE | `/api/exchange-rates/:id` | — | `useDeleteExchangeRate` |

Unique on `(currency, effectiveMonth)`. POST upserts.

## Allocation rules

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/allocation-rules` | — | `useListAllocationRules` |
| POST | `/api/allocation-rules` | rule object | `useCreateAllocationRule` |
| PUT | `/api/allocation-rules/:id` | rule object | `useUpdateAllocationRule` |
| DELETE | `/api/allocation-rules/:id` | — | `useDeleteAllocationRule` |

Rule fields: `name`, `description`, `caPct`, `txPct`, `uaePct`, `pkPct`,
`buzzPct`. Percentages are not validated to total 100.

## Intercompany transactions

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/intercompany-transactions` | `?month=YYYY-MM` | `useListIntercompanyTransactions` |
| POST | `/api/intercompany-transactions` | transaction object | `useCreateIntercompanyTransaction` |
| PUT | `/api/intercompany-transactions/:id` | transaction object | `useUpdateIntercompanyTransaction` |
| DELETE | `/api/intercompany-transactions/:id` | — | `useDeleteIntercompanyTransaction` |

Fields: `fromEntity`, `toEntity`, `date`, `originalCurrency`, `originalAmount`,
`exchangeRate`, `usdAmount`, `description`.

## Reports (all derived — read only)

| Method | Path | Params | Hook |
|---|---|---|---|
| GET | `/api/dashboard` | `?month`, `?brand` | `useGetDashboard` |
| GET | `/api/monthly-trend` | — | `useGetMonthlyTrend` |
| GET | `/api/consolidated-pl` | `?month` | `useGetConsolidatedPL` |
| GET | `/api/brand-pl` | `?entity` (required), `?month` | `useGetBrandPL` |
| GET | `/api/monthly-pl` | `?year`, `?brand` | `useGetMonthlyPL` |
| GET | `/api/allocation` | `?month` | `useGetAllocationReport` |
| GET | `/api/intercompany` | `?month` | `useGetIntercompany` |
| GET | `/api/bank-spending` | `?month` | `useGetBankSpending` |

These endpoints compute from the transactional tables on every request. Never
add a route that reads a stored report total.

## Banking (Plaid + manual)

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/plaid/status` | — | `usePlaidStatus` |
| GET | `/api/plaid/items` | — | `usePlaidItems` |
| GET | `/api/plaid/accounts` | — | `usePlaidAccounts` |
| GET | `/api/plaid/transactions` | `?limit=50` | `usePlaidTransactions` |
| GET | `/api/plaid/items/:id/unposted` | — | `usePlaidUnpostedTransactions` |
| PATCH | `/api/plaid/items/:id/transactions/review` | `{ transactionIds, reviewStatus }` | `useUpdatePlaidTransactionReview` |
| POST | `/api/plaid/link-token` | — | `useCreatePlaidLinkToken` |
| POST | `/api/plaid/exchange` | `{ publicToken, institution }` | `useExchangePlaidPublicToken` |
| POST | `/api/plaid/manual-items` | `{ institutionName, country, icon }` | `useCreateManualPlaidItem` |
| POST | `/api/plaid/items/:id/sync` | — | `useSyncPlaidItem` |
| DELETE | `/api/plaid/items/:id` | — | `useDeletePlaidItem` |
| GET | `/api/plaid/items/:id/statements` | — | `usePlaidStatements` |
| POST | `/api/plaid/items/:id/statements` | multipart `statement` file | `useUploadPlaidStatement` |
| GET | `/api/plaid/statements/:id/download` | — | (direct link) |

`reviewStatus` is `pending` \| `posted` \| `excluded`. Reviewing a transaction
records a status only — it does **not** create an expense record. Wiring review
to posting is roadmap work.

`/api/plaid/status` reports whether Plaid credentials are configured; manual bank
profiles work regardless.

## General Ledger — entities, brands, journal entries (Phase 1.1/1.3)

These tables have existed since Phase 1.1/1.3 but had no REST surface until the
Bank Transactions Hub UI needed one — see `.claude/PHASE_TRACKER.md` for the
rest of the six-phase gap this is a partial start on.

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/entities` | — | `useListEntities` |
| POST | `/api/entities` | `{ name, country, functionalCurrency }` → entity + `intercompanyAccountsCreated`. Creates the same-named brand and reciprocal "Due From / Due To Affiliates — …" accounts with every existing entity, in both sets of books (one transaction) | `useCreateEntity` |
| PUT | `/api/entities/:id` | `{ name?, country?, functionalCurrency? }` — renaming also renames the brand and other entities' auto-named "… — <old name>" clearing accounts | `useUpdateEntity` |
| DELETE | `/api/entities/:id` | — 400 if it has journal entries / bank accounts or other entities have posted against it; otherwise removes its brand, its accounts and other entities' clearing accounts for it → `{ ok, intercompanyAccountsRemoved }` | `useDeleteEntity` |
| GET | `/api/brands` | `?entityId=` | `useListBrands` |
| GET | `/api/reports/cash-flow-trend` | `?entityId&startDate&endDate&currency&granularity=day\|month` → `{ openingPosition, series: [{ bucket, cashIn, cashOut, net, position }] }`. Debits on Cash & Equivalents accounts are cash in, credits cash out (same account set as `/cash-flow`); `position` is the running balance seeded from before the range. Empty buckets are included so a curve never skips a period | `useCashFlowTrend` |
| GET | `/api/backups` | → `{ directory, enabled, intervalHours, keep, backups: [{ name, bytes, createdAt }] }` — the automatic daily snapshots (2026-10-20). Admin + all entities, since a snapshot is the whole book of record plus the users table |
| POST | `/api/backups/run` | Takes a snapshot immediately through SQLite's online backup API, integrity-checks it, prunes old ones → `{ name, bytes, createdAt, durationMs, pruned[] }` |
| GET | `/api/backups/:name/download` | Streams one snapshot. Only names the server itself produced are served, so the path cannot be walked. This is the way to get a copy off the host without shell access |
| POST | `/api/imports/quickbooks/preview` | multipart: `file` (QuickBooks "Transaction Detail by Account" CSV) + `entityId` (capability `import`). **Writes no ledger rows** — parses, pairs each transaction's printed halves back into one entry, and returns `{ batchId, entries[], quarantine[], accounts[], warnings[], duplicateCount, newAccountCount }`. `accounts[]` carries the existing match or a *suggested* type with a confidence flag; `entries[]` carry `importRowHash` and `duplicateOf` (2026-10-13) |
| POST | `/api/imports/quickbooks/:id/commit` | `{ accounts: [{ name, accountId? , create?: { type, subType?, code? } }] }` (capability `import`) — creates the confirmed accounts and writes the batch as **Draft** journal entries, skipping anything whose `importRowHash` is already in the books. 400 if any account name has no decision |
| POST | `/api/import-batches/:id/post` | Draft → Posted for the whole batch (capability `post`). **400 while `quarantineCount > 0`**; the balance trigger still gates each entry |
| POST | `/api/import-batches/:id/discard` | Deletes the batch's draft entries (capability `import`); refused once posted |
| GET | `/api/import-batches` / `/api/import-batches/:id` | Batch list / one batch with its parsed payload and entries (capability `read`, entity-filtered) |
| GET | `/api/reports/intercompany-balances` | `?asOfDate` → owner × counterparty matrix read from the `subType = 'Intercompany Clearing'` heads (2026-10-12): `{ entities[], cells[], mismatches[], groupNetUSD, eliminates }`. A cell is debit − credit on that pair's heads, so **positive = the owner is owed**; it carries `mirrorNetUSD` (what the other side's books say) and `difference`, which must be zero. Capability `read`, all-entity users only | `useIntercompanyBalances` |
| GET | `/api/plaid/status` | → `{ configured, ready, configError, env, products, countryCodes, linkedItems }` — why Plaid can't be used, when it can't | `usePlaidStatus` |
| POST | `/api/plaid/link-token` | Creates a Link token (`client_user_id` = signed-in user). Errors return `{ message, errorCode, errorType, requestId }`; a config problem is a 500 with `errorCode: "CONFIGURATION"` | `useCreatePlaidLinkToken` |
| POST | `/api/plaid/exchange` (alias `/api/plaid/exchange-token`) | `{ publicToken, institution }` → saves the item + accounts; same error shape | `useExchangePlaidPublicToken` |
| GET | `/api/exchange-rates/resolve` | `?currency&date` → `{ rate, found, source, effectiveMonth, period }` from the configured `exchange_rates` table (never an external feed) — what the Journal Entry screen pre-fills | `useResolveExchangeRate` / `fetchExchangeRate` |
| POST | `/api/journal-entries` | Manual journal entry: `{ transactionDate, reference?, description?, lines: [{ accountId, entityId, debit, credit, description?, currency?, exchangeRate? }] }` (capability `post`). `debit`/`credit` are NATIVE amounts in the line's `currency` (default USD); `exchangeRate` overrides the configured month rate (400 if a non-USD line has neither). Balancing — overall and per entity — is on the **converted USD** amounts; the line stores native amount + `currency` + `exchangeRate` + `amountUSD`. Each line is one-sided and > 0; total debits = total credits; **each entity's lines must balance on their own**; a line's account must be that entity's own or Shared; period must be unlocked. Posts one `source='ManualJournal'` entry per entity, sharing the reference → `{ ok, journalEntries[], entryNumbers[] }` Each line may also carry `contactId` — the From / To party picked on that line, which is what the Customer/Vendor sub-ledger balances are derived from (2026-10-21). | `useCreateJournalEntry` |
| GET | `/api/journal-entries/:id` | — → the entry plus `lines[]` (each with the account's `code` / `accountName` / `accountEntityId`, and the line's own `debit`, `credit`, `currency`, `exchangeRate`, `memo`) (2026-10-21). Read on demand by the JV screen to pre-fill the form when correcting an entry — the list endpoint returns headers only and the GL report is grouped by account, so neither can rebuild a sheet. Capability `read`, entity-checked | `fetchJournalEntry` (not a hook) |
| POST | `/api/journal-entries/:id/reverse` | `{ reversalDate?, memo? }` → `{ reversed: true, originalEntryId, reversalEntryId, reversalEntryNumber }` (2026-10-21). **Manual JVs only** (`source = 'ManualJournal'`). Posts a mirror of a Posted JV — every line with debit and credit swapped, keeping each line's currency, stamped rate, brand and contact — tagged `[REVERSAL-OF-<id>]` in its reference, and itself a `ManualJournal` entry so it lists on the JV screen. Both entries stay in the books; net effect on every balance is zero. Refused `409` for any other source (the message names the screen that owns it — banking Undo for `BankFeed`, void for `AR`/`AP`), for an entry that is itself a reversal, and for one already reversed; `400` if it isn't Posted. Both the original's period and the reversal's must be open. Capability `post`, entity-checked | `useReverseJournalEntry` |
| DELETE | `/api/journal-entries/:id` | → `{ deleted: true, entryId, entryNumber }` (2026-10-21). Deletes a **Draft manual JV** outright, with its lines and monthly allocations. Refused `409` for a Posted entry (`reverseWith` names the reverse endpoint) and for any non-`ManualJournal` source. Capability `post`, entity-checked | `useDeleteJournalEntry` |
| GET | `/api/split-rules` | Reusable multi-entity split templates with their lines (`read`) | `useListSplitRules` |
| POST/PUT/DELETE | `/api/split-rules[/:id]` | Create / edit / delete a rule (Admin + all entities). Percentages are 4 dp and must total exactly 100; an entity may appear once. Rules are configuration only — no posting references them | `useCreateSplitRule` / `useUpdateSplitRule` / `useDeleteSplitRule` |
| GET | `/api/journal-entries` | `?entityId=&brandId=&status=` | `useListJournalEntries` |

`entities`/`brands` use numeric ids, distinct from the string entity codes
(`CA`, `TX`, …) in `src/lib/constants.ts` — see that file's `ENTITIES`. These
three endpoints are read-only; there is still no way to create a journal entry
directly (posting only happens through the bank-transactions/AP/AR flows
below).

## Bank Transactions Hub (Phase 1.2/1.3 GL staging + posting engine)

Distinct from the legacy `/api/plaid/*` connections further down this file —
this is the double-entry-aware staging layer (`bank_accounts`,
`bank_transactions`, `categorization_rules`) that posts into `journal_entries`.

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/bank-accounts` | `?entityId=` | `useListBankAccounts` |
| POST | `/api/bank-accounts` | `{ name, entityId, bankName, accountNumberLast4?, currency?, connectionType?, plaidAccountId? }` | `useCreateBankAccount` |
| PUT | `/api/bank-accounts/:id` | same shape | — |
| DELETE | `/api/bank-accounts/:id` | — | — |
| GET | `/api/bank-transactions` | `?bankAccountId=&status=` — posted rows also carry derived `categoryAccounts: [{ accountId, code, name }]` (non-bank lines of the linked journal entry), `contacts: [{ id, name, contactType }]` (contacts tagged on the posted lines — the From/To column) and `chargedToEntities: [{ entityId, name }]` (entities bearing the cost, read across the `[SPLIT-BT…]` batch, so a cross-entity charge names the other entity) | `useListBankTransactions` |
| GET | `/api/bank-transactions/unposted` | `?bankAccountId=` — rows include `suggestedCategorization` | `useUnpostedBankTransactions` |
| PATCH | `/api/bank-transactions/:id/status` | `{ status: PENDING\|POSTED\|IGNORED }` | — |
| POST | `/api/bank-transactions/import` | multipart, field `statement` (CSV/OFX/QBO) + `bankAccountId` + optional `columnMapping` JSON | `useImportBankStatement` |
| POST | `/api/bank-transactions/plaid-sync` | `{ bankAccountId }` | `useSyncPlaidBankAccount` |
| POST | `/api/bank-transactions/:id/post` | `{ accountId?, entityId?, brandId?, postingDate?, description?, reference? }` | `usePostBankTransaction` |
| POST | `/api/bank-transactions/bulk-post` | `{ items: [{ bankTransactionId, accountId?, entityId?, brandId? }] }` | `useBulkPostBankTransactions` |
| POST | `/api/bank-transactions/bulk-ignore` | `{ ids: number[] }` → `{ ignored, ignoredIds[], skipped: [{ id, reason }] }` (2026-10-20). Clears rows out of the pending feed by setting status `IGNORED` — **not** a delete, so the row's deduplication hash still blocks the same transaction being re-imported. Only rows that are `PENDING` **and** have no `journalEntryId` are touched; anything posted is refused and returned in `skipped`, never silently detached from its entry. Capability `post`, entity-filtered |
| POST | `/api/bank-transactions/:id/unpost` | — → `{ unposted: true, entryId, removedJournalEntryIds[] }`. Reverses a posting: deletes the journal entry (and, for a cross-entity charge, every sibling entry sharing its `[SPLIT-BT…]` reference tag), then returns the feed row to `PENDING` with `journalEntryId` cleared. Refused if the row isn't posted, if it is part of a completed reconciliation, or if any affected entry falls in a locked period. Capability `post`, entity-checked |
| POST | `/api/bank-transactions/bulk-unpost` | `{ ids: number[] }` → `{ unposted, items: [{ bankTransactionId, removedJournalEntryIds[] }], removedJournalEntryCount }` (2026-10-21). Batch form of the above, **all-or-nothing**: every id is validated and reverted inside a single SQLite transaction, so one unusable id (already pending, reconciled, locked period, no access) aborts the whole batch with `{ error, unposted: 0 }` and writes nothing. Capability `post`, entity-checked per row |
| GET | `/api/categorization-rules` | — | `useListCategorizationRules` |
| POST/PUT/DELETE | `/api/categorization-rules[/:id]` | `{ matchPattern, matchType, targetAccountId, targetBrandId?, targetEntityId, priority?, isActive? }` | — (no hook yet — rule management UI doesn't exist) |

`bank_transactions.amount` is signed: positive = credit/money in, negative =
debit/money out. Posting resolves the bank's GL cash account from
`bank_accounts.glAccountId`, falling back to the entity's single seeded "Cash
& Equivalents" account.

## Static

`GET *` — in production only, serves `dist/public/index.html` so client-side
routes resolve on refresh.

---

## Conventions for new endpoints

- Group the route with its domain siblings in `server/index.ts`.
- Filter by `month` with a query parameter, never a path segment.
- Return plain arrays for list endpoints and plain objects for single records.
- Bulk import takes a bare array; bulk delete takes `{ ids: [] }`.
- Add the hook and invalidate the affected query keys in the same change.
- Update this file.
