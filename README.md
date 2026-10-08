# TekRevol FinSys

Internal financial management and reporting platform for TekRevol. It centralises
revenue, expenses, bank activity, intercompany transfers, cost allocation and P&L
reporting across the group's entities and brands (TekRevol CA, TX, AE, PK and
BuzzFlick), replacing the spreadsheet-based finance process.

This repository was originally built on Replit and has been migrated to a plain,
portable Node.js project. See [`docs/HANDOFF.md`](docs/HANDOFF.md) for what changed
during the migration and [`docs/ROADMAP.md`](docs/ROADMAP.md) for what remains.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 5, TypeScript, TailwindCSS 4, shadcn/Radix UI, Recharts |
| Routing | `wouter` (client-side) |
| Data fetching | TanStack Query, via the local `@workspace/api-client-react` package |
| Backend | Express 4 (TypeScript, run through `tsx`) |
| Database | SQLite via `better-sqlite3` (single file: `server/finance.db`) |
| Banking | Plaid (optional; manual bank profiles work without it) |
| Excel | SheetJS (`xlsx`) for import/export |
| Package manager | pnpm workspace (`.`, `packages/*`, `server`) |

## Requirements

- Node.js 20 or 22 (22 recommended — see `.nvmrc`)
- pnpm 9 or newer (`npm install -g pnpm`)
- A C/C++ toolchain + Python 3, only needed if `better-sqlite3` has to compile
  from source on your platform (see [`docs/LOCAL-SETUP.md`](docs/LOCAL-SETUP.md))

## Quick start

```bash
pnpm install
cp .env.example .env      # optional; only needed for Plaid
pnpm run dev:all          # API on :3001 + web on :5000
```

Open http://localhost:5000

Full platform-by-platform instructions, including Windows, are in
[`docs/LOCAL-SETUP.md`](docs/LOCAL-SETUP.md).

## Scripts

| Command | What it does |
|---|---|
| `pnpm run dev:all` | Runs the API and the Vite dev server together (recommended) |
| `pnpm run dev` | Vite dev server only, on `PORT` (default 5000), proxying `/api` to `:3001` |
| `pnpm run dev:api` | Express API only, on `SERVER_PORT` (default 3001) |
| `pnpm run build` | Builds the frontend into `dist/public` |
| `pnpm run start` | Production: serves the API **and** `dist/public` on `PORT` (default 5000) |
| `pnpm run typecheck` | TypeScript check of the frontend (`tsc --noEmit`) |

Production run: `pnpm run build && NODE_ENV=production pnpm run start`

## Project layout

```
.
├── index.html                     # Vite entry
├── vite.config.ts                 # Build, aliases, /api dev proxy
├── src/                           # React frontend
│   ├── App.tsx                    # Routes
│   ├── components/                # Layout, shared widgets
│   │   └── ui/                    # shadcn primitives (do not hand-edit lightly)
│   ├── lib/constants.ts           # Entities, brands, currencies, banks
│   └── pages/                     # One file per screen
├── packages/api-client-react/     # Typed React Query hooks — the only API surface
├── server/
│   ├── index.ts                   # Entire Express API + SQLite schema
│   └── finance.db                 # SQLite database (committed; see HANDOFF)
├── public/                        # Favicons, logo, static assets
└── docs/                          # Architecture, API, data model, roadmap, setup
```

## Documentation

| Document | Purpose |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Working agreement and conventions for Claude Code sessions |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Migration state: what was broken, what was fixed, open risks |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the system is put together and why |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Every table, column and relationship |
| [`docs/API.md`](docs/API.md) | Complete endpoint reference |
| [`docs/LOCAL-SETUP.md`](docs/LOCAL-SETUP.md) | Developer onboarding, per platform |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Requirement-by-requirement gap analysis and build order |

## Screens

**Reports** — Dashboard (command centre), Consolidated P&L, Monthly P&L, per-brand
P&L (CA / TX / AE / BuzzFlick), Allocation Engine, Intercompany.
**Source data** — Bank Transactions.
**Configuration & rules** — Chart of Accounts, Exchange Rates, Allocation Rules.

## Status

The application builds, typechecks and runs cleanly end to end. It is a working
internal prototype, not yet a production finance system: there is no
authentication, no audit trail, no database migrations and no budgeting module.
Those gaps and the recommended build order are set out in
[`docs/ROADMAP.md`](docs/ROADMAP.md).
