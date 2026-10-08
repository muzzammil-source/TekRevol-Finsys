# Handoff — Replit → local / Claude Code

Date: 9 September 2026
Source: `https://github.com/mshahmeer-dotcom/TekRevol-Finsys.git` @ `6a28af2`
Result: the project builds, typechecks and runs cleanly outside Replit.

---

## 1. What was wrong in the GitHub backup

**The backend source file was corrupted.** `server/index.ts` in commit `6a28af2`
("Sync bank transactions redesign and setup") was missing its first 197 lines —
it began mid-way through a `CREATE TABLE` statement:

```
 NOT NULL UNIQUE,
    mimeType TEXT DEFAULT '',
```

Every import, the database connection, the Plaid client setup, the multer upload
config and eleven table definitions were gone. The server could not start at all:

```
Error [TransformError]: server/index.ts:1:5: ERROR: Expected ";" but found "NULL"
```

This looks like a truncated upload rather than an edit — the previous commit
`87399e3` contains the complete file. **If you push from Replit again, verify
`server/index.ts` starts with `import express from "express";` before trusting
the backup.**

**Nine TypeScript errors** in `src/pages/bank-spending.tsx` and
`src/pages/exchange-rates.tsx` (implicit `any` parameters, and a Plaid
`onSuccess` signature mismatch where `public_token` is `string | null`).

**Replit-only coupling** — `vite.config.ts` imported three `@replit/*` plugins,
`.replit` defined the run configuration, and `scripts/post-merge.sh` was a Replit
merge hook. None of it works or is needed elsewhere.

**`better-sqlite3` needed compiling** with no prebuilt binary for Node 22.

## 2. What was changed

| Change | Detail |
|---|---|
| Restored `server/index.ts` | Re-spliced the missing 197-line header from commit `87399e3` onto the current body. Verified: server boots, all 16 GET endpoints return 200, all 12 screens render. |
| Fixed all TypeScript errors | `pnpm run typecheck` is clean. |
| Removed Replit coupling | Deleted `.replit`, `replit.nix`, `replit.md`, `scripts/post-merge.sh`; removed the three `@replit/*` Vite plugins from `vite.config.ts`, `package.json` and the pnpm catalog. |
| Fixed the `@assets` alias | Pointed at `attached_assets/` at the repo root instead of two directories above it (it resolved outside the project on Replit). |
| Added a real dev workflow | `pnpm run dev:all` runs API and web together via `concurrently`; added `dev:api` and `start`; added `tsx` at the root so the server runs from the repo root. |
| Made the API target configurable | `API_PROXY_TARGET` env var instead of a hardcoded proxy target. |
| Removed a stray file | `src/pages/allocation-rules_`, a stale duplicate of `allocation-rules.tsx`. |
| Added `.nvmrc`, `.env.example` | Node 22; documented every environment variable. |
| Added documentation | `README.md`, `CLAUDE.md`, and this `docs/` set. |

Nothing about the financial logic, the schema or the UI was changed.

## 3. Verified working

- `pnpm install` — clean, including the `better-sqlite3` native build
- `pnpm run typecheck` — no errors
- `pnpm run build` — 2,877 modules, `dist/public`
- `NODE_ENV=production pnpm run start` — API + static frontend on one port
- All 16 read endpoints return `200`
- All 12 routes render with no page errors: Dashboard, Consolidated P&L,
  Monthly P&L, Brand P&L, Allocation, Intercompany, Bank Transactions, Revenue,
  Expenses, Chart of Accounts, Exchange Rates, Allocation Rules

## 4. Database state

`server/finance.db` is committed and contains the data that was on Replit:

| Table | Rows |
|---|---|
| revenue | 26 |
| departments | 9 |
| exchange_rates | 3 |
| accounts | 2 |
| expenses | 2 |
| allocation_rules | 1 |
| plaid_items / plaid_accounts | 2 / 2 |
| everything else | 0 |

This is prototype data, not a full financial history. Treat the first real
month-end load as the moment the numbers start mattering.

## 5. Open risks to address early

1. **No authentication.** Anyone who can reach the port can read and edit
   financial records. Fix before this leaves a developer machine.
2. **No audit trail.** Edits and deletes leave no trace.
3. **The database is in git.** It will conflict on merge and it spreads live
   financial data to every clone. Move to seed + ignored working DB.
4. **Entities are hardcoded as columns.** Adding an entity is currently a
   schema-and-everything change. See `docs/ROADMAP.md` §2.
5. **No server-side validation.** Request bodies reach SQLite unchecked.
6. **No tests.** Nothing protects the allocation and P&L maths from regressions.

## 6. Picking this up in Claude Code

```bash
git clone <your-repo> TekRevol-Finsys && cd TekRevol-Finsys
pnpm install
claude
```

`CLAUDE.md` at the repo root is read automatically and carries the conventions,
the allocation model and the list of traps. Start any session by asking for
`docs/ROADMAP.md` §1 (foundation work) unless you have a specific feature in mind.
