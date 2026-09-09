# API reference

All routes are served by `server/index.ts` under `/api`. JSON in, JSON out.
There is **no authentication** — every route is currently public.

The frontend never calls these directly: it uses the hooks in
`packages/api-client-react/src/index.ts`. When you add a route, add the hook.

Month parameters are `YYYY-MM`. Dates are `YYYY-MM-DD`. Amounts are numbers;
`usdAmount` is the reporting figure.

---

## Chart of accounts

| Method | Path | Params / body | Hook |
|---|---|---|---|
| GET | `/api/accounts` | `?type=expense\|revenue` | `useListAccounts` |
| POST | `/api/accounts` | account object | `useCreateAccount` |
| PUT | `/api/accounts/:id` | account object | `useUpdateAccount` |
| DELETE | `/api/accounts/:id` | — | `useDeleteAccount` |
| POST | `/api/accounts/bulk` | array of rows (Excel import) | `useBulkImportAccounts` |
| POST | `/api/accounts/bulk-delete` | `{ ids: number[] }` | `useBulkDeleteAccounts` |

Account fields: `code`, `category`, `name`, `type` (`expense` \| `revenue`),
`description`.

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
