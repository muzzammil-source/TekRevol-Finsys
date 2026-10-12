import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import fs from "fs";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  createAuth,
  AccessError,
  authOf,
  visibleEntityIds,
  canAccessEntity,
  assertEntityAccess,
  assertCapability,
} from "./auth";
import { parseTransactionDetailByAccount, pairTransactions, inferAccountType } from "./qb-import";
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from "plaid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env loading (2026-09-18). Nothing loaded it before: there is no dotenv
// dependency and the `dev:api` / `start` scripts pass no --env-file, so a
// repo-root .env with real Plaid credentials was invisible to the process
// and every Link token attempt failed with "Plaid credentials are not
// configured". Parsed here (no new dependency, and independent of the
// working directory the server was started from). Real environment
// variables always win, so deployments that set them are unaffected.
function loadEnvFile(file: string): number {
  if (!fs.existsSync(file)) return 0;
  let loaded = 0;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

for (const envFile of [path.join(__dirname, ".env"), path.join(__dirname, "..", ".env")]) {
  const count = loadEnvFile(envFile);
  if (count > 0) console.log(`[env] loaded ${count} variable(s) from ${envFile}`);
}

// The database file. DB_PATH points it outside the checkout — which is how
// a deployment keeps its books: the container is rebuilt from git on every
// deploy, so a database sitting inside the repo is replaced each time.
// Point DB_PATH at a mounted volume (e.g. /data/finance.db) and the data
// survives. Unset, it stays beside the server, which is what local
// development wants.
const LEGACY_DB_PATH = path.join(__dirname, "finance.db");
const DB_PATH = String(process.env.DB_PATH || "").trim() || LEGACY_DB_PATH;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// One-time migration onto a volume (2026-10-13). The first boot after
// DB_PATH is pointed at a mounted volume finds it empty, while the old
// database is still sitting in the image next to the server — so it is
// copied across rather than silently starting an empty set of books. The
// WAL and shared-memory files come too: a database copied without its WAL
// loses whatever had not been checkpointed.
//
// This runs only when the target does not exist, so it never overwrites a
// volume that already holds the books. Once the database stops being
// committed to git the legacy file disappears from the image and this
// becomes a no-op — which is the point: it exists to carry the data across
// that one deploy.
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix)) fs.copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
    }
    console.log(`[db] seeded ${DB_PATH} from ${LEGACY_DB_PATH} (first boot on this volume)`);
  } catch (e) {
    console.error("[db] could not seed the database onto the volume:", e);
  }
}
console.log(`[db] ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const BANK_STATEMENT_UPLOAD_DIR = path.join(__dirname, "uploads", "bank-statements");
fs.mkdirSync(BANK_STATEMENT_UPLOAD_DIR, { recursive: true });
const bankStatementUpload = multer({
  storage: multer.diskStorage({
    destination: BANK_STATEMENT_UPLOAD_DIR,
    filename: (_req, file, callback) => {
      callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (![".csv", ".xls", ".xlsx", ".pdf"].includes(extension)) {
      callback(new Error("Only CSV, XLS, XLSX, and PDF bank statements are supported"));
      return;
    }
    callback(null, true);
  },
});

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS exchange_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT NOT NULL,
    rateToUsd REAL NOT NULL DEFAULT 1,
    effectiveMonth TEXT NOT NULL,
    notes TEXT DEFAULT '',
    UNIQUE(currency, effectiveMonth)
  );

  CREATE TABLE IF NOT EXISTS intercompany_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fromEntity TEXT NOT NULL,
    toEntity TEXT NOT NULL,
    originalCurrency TEXT NOT NULL DEFAULT 'USD',
    originalAmount REAL NOT NULL DEFAULT 0,
    exchangeRate REAL NOT NULL DEFAULT 1,
    usdAmount REAL NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    description TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS plaid_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId TEXT NOT NULL UNIQUE,
    institutionId TEXT DEFAULT '',
    institutionName TEXT NOT NULL,
    accessToken TEXT NOT NULL,
    cursor TEXT DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'plaid',
    country TEXT DEFAULT '',
    icon TEXT DEFAULT '',
    isManual INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS plaid_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId INTEGER NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
    plaidAccountId TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    officialName TEXT DEFAULT '',
    mask TEXT DEFAULT '',
    type TEXT DEFAULT '',
    subtype TEXT DEFAULT '',
    isoCurrency TEXT DEFAULT 'USD',
    currentBalance REAL DEFAULT NULL,
    availableBalance REAL DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bank_statements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId INTEGER NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
    originalName TEXT NOT NULL,
    storedName TEXT NOT NULL UNIQUE,
    mimeType TEXT DEFAULT '',
    fileSize INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// ======= GENERAL LEDGER (Phase 1.1 — see .claude/PHASE_TRACKER.md) =======
// This is the strict double-entry book of record (CLAUDE.md §0). The
// pre-Phase-1 single-entry tables (revenue, expenses, allocation_rules,
// *_monthly_allocations) were retired on 2026-09-10 — their historical rows
// were migrated into real Posted journal_entries/journal_lines first (see
// .claude/PHASE_TRACKER.md), then the tables were dropped. This is now the
// only financial data model in this app.
db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    country TEXT NOT NULL,
    functionalCurrency TEXT NOT NULL DEFAULT 'USD',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entityId INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    isActive INTEGER NOT NULL DEFAULT 1,
    UNIQUE(name, entityId)
  );

  CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entryNumber TEXT NOT NULL UNIQUE,
    entityId INTEGER NOT NULL REFERENCES entities(id),
    brandId INTEGER REFERENCES brands(id),
    transactionDate TEXT NOT NULL,
    postingDate TEXT NOT NULL,
    description TEXT DEFAULT '',
    reference TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Draft',
    source TEXT NOT NULL DEFAULT 'Manual',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Reusable multi-entity split rules (2026-09-17): "50/50 Dual Entity",
  -- "3-Way 33/33/34", … applied in the Banking Split modal. Configuration
  -- only — no figure here ever reaches a report except through a posting
  -- the user makes from it.
  CREATE TABLE IF NOT EXISTS split_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    isActive INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS split_rule_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ruleId INTEGER NOT NULL REFERENCES split_rules(id) ON DELETE CASCADE,
    entityId INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    -- Percent of the transaction, 4 dp (33.3333). The set must total 100.
    percent REAL NOT NULL,
    sortOrder INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    journalEntryId INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    accountId INTEGER NOT NULL REFERENCES accounts(id),
    debit REAL NOT NULL DEFAULT 0,
    credit REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    exchangeRate REAL NOT NULL DEFAULT 1.0,
    amountUSD REAL NOT NULL DEFAULT 0,
    brandId INTEGER REFERENCES brands(id),
    memo TEXT DEFAULT ''
  );

  -- Multi-month amortization (2026-09-10): the raw journal_lines row keeps
  -- the entry's real payment/posting date (statutory/tax books never move —
  -- CLAUDE.md dates rule). When a line represents a cost or revenue that
  -- should be *recognized* over several months instead of all at once
  -- (e.g. a $12,000 Jan payment covering Jan-Dec service), its incurred
  -- monthly breakdown is stored here and management reports read from this
  -- table instead of the line's own transactionDate when rows exist for it.
  -- No line has both a "no allocation" and "allocation" state ambiguously —
  -- if a line has zero rows here, management reports fall back to bucketing
  -- its full amount into its own journal_entries.transactionDate month.
  CREATE TABLE IF NOT EXISTS journal_line_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    journalLineId INTEGER NOT NULL REFERENCES journal_lines(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    amountUSD REAL NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_journal_line_allocations_line ON journal_line_allocations(journalLineId);
  CREATE INDEX IF NOT EXISTS idx_journal_line_allocations_month ON journal_line_allocations(month);

  -- Core Architecture Rule (CLAUDE.md §0): a journal entry may only be marked
  -- Posted if its lines already balance. Draft entries are exempt so they can
  -- be built up line by line before posting.
  --
  -- Balanced means balanced in USD, the reporting currency (2026-09-18): a
  -- line's native debit/credit are weighted by its own exchangeRate,
  -- which is what every report already sums. For a single-currency entry
  -- this is the old Σdebit = Σcredit test scaled by one rate, so nothing
  -- posted before changes meaning; a multi-currency manual entry (native
  -- amounts in EUR and USD on one entry) could not satisfy the old native
  -- test at all. Tolerance is half a cent, since rates carry decimals.
  CREATE TRIGGER IF NOT EXISTS trg_journal_balance_on_post_usd
  BEFORE UPDATE OF status ON journal_entries
  WHEN NEW.status = 'Posted' AND ABS((
    SELECT COALESCE(SUM(debit * COALESCE(exchangeRate, 1)), 0) - COALESCE(SUM(credit * COALESCE(exchangeRate, 1)), 0)
    FROM journal_lines WHERE journalEntryId = NEW.id
  )) > 0.005
  BEGIN
    SELECT RAISE(ABORT, 'Journal entry does not balance: converted USD debits must equal USD credits to post');
  END;

  -- Once Posted, an entry is a legal book record: its lines are immutable.
  -- Correct a mistake by voiding the entry and posting a new one, never by
  -- editing a posted line.
  CREATE TRIGGER IF NOT EXISTS trg_journal_lines_immutable_when_posted_upd
  BEFORE UPDATE ON journal_lines
  WHEN (SELECT status FROM journal_entries WHERE id = OLD.journalEntryId) = 'Posted'
  BEGIN
    SELECT RAISE(ABORT, 'Cannot modify a line on a Posted journal entry — void and re-enter instead');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_journal_lines_immutable_when_posted_del
  BEFORE DELETE ON journal_lines
  WHEN (SELECT status FROM journal_entries WHERE id = OLD.journalEntryId) = 'Posted'
  BEGIN
    SELECT RAISE(ABORT, 'Cannot delete a line on a Posted journal entry — void and re-enter instead');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_journal_lines_immutable_when_posted_ins
  BEFORE INSERT ON journal_lines
  WHEN (SELECT status FROM journal_entries WHERE id = NEW.journalEntryId) = 'Posted'
  BEGIN
    SELECT RAISE(ABORT, 'Cannot add a line to a Posted journal entry — void and re-enter instead');
  END;
`);

// The native-amount balance trigger this replaced (2026-09-18). A trigger
// body can't be altered in place, so the old one is dropped by name once the
// USD-weighted one above exists.
db.exec(`DROP TRIGGER IF EXISTS trg_journal_balance_on_post;`);

// ======= BANK TRANSACTIONS STAGING (Phase 1.2 — see .claude/PHASE_TRACKER.md) =======
// A staging layer transactions land in (PENDING) before a human or a rule
// (Phase 1.3) turns them into a posted journal entry. This is additive
// alongside the pre-existing plaid_items/plaid_accounts/plaid_transactions
// tables above, which keep serving the legacy Bank Transactions screen
// unchanged. bank_accounts.plaidAccountId is the join key into the existing
// plaid_accounts table when connectionType='PLAID', so Plaid credentials and
// access tokens are never duplicated — see syncPlaidBankAccount() below.
db.exec(`
  CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entityId INTEGER NOT NULL REFERENCES entities(id),
    bankName TEXT NOT NULL,
    accountNumberLast4 TEXT DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    connectionType TEXT NOT NULL DEFAULT 'MANUAL_UPLOAD' CHECK (connectionType IN ('PLAID','MANUAL_UPLOAD')),
    plaidAccountId TEXT DEFAULT NULL,
    isActive INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bank_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bankAccountId INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    transactionDate TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rawText TEXT DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','POSTED','IGNORED')),
    deduplicationHash TEXT NOT NULL UNIQUE,
    plaidTransactionId TEXT DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_bank_transactions_account_date ON bank_transactions(bankAccountId, transactionDate);
`);

// ---- Additive migrations (never destructive, always backward compatible) ----
function ensureColumn(table: string, column: string, ddl: string) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  } catch (e) {
    console.error(`Migration error (${table}.${column}):`, e);
  }
}

ensureColumn("plaid_items", "provider", "provider TEXT NOT NULL DEFAULT 'plaid'");
ensureColumn("plaid_items", "country", "country TEXT DEFAULT ''");
ensureColumn("plaid_items", "icon", "icon TEXT DEFAULT ''");
ensureColumn("plaid_items", "isManual", "isManual INTEGER NOT NULL DEFAULT 0");
ensureColumn("plaid_accounts", "currentBalance", "currentBalance REAL DEFAULT NULL");
ensureColumn("plaid_accounts", "availableBalance", "availableBalance REAL DEFAULT NULL");

// GL (Phase 1.1): extend the existing chart-of-accounts table rather than
// creating a second one. Pre-Phase-1 rows (type='expense'|'revenue', lower
// case, no entityId) keep working untouched; new GL rows use the Title-Case
// Asset/Liability/Equity/Revenue/Expense types from the task spec. See the
// "casing/type convention" note logged in .claude/PHASE_TRACKER.md — this is
// a known wart to reconcile once Phase 1.3's posting engine needs one
// consistent account model.
ensureColumn("accounts", "currency", "currency TEXT DEFAULT 'USD'");
ensureColumn("accounts", "entityId", "entityId INTEGER DEFAULT NULL");
ensureColumn("accounts", "isActive", "isActive INTEGER NOT NULL DEFAULT 1");

// Chart of Accounts expansion (2026-09-10): a configurable sub-type per
// account (e.g. "Current Assets", "Accounts Payable", "COGS", "Operating
// Expense", "Intercompany Clearing") on top of the 5 fundamental `type`
// categories — free-text, not an enum, so new sub-types can be introduced
// from the UI without a schema change (matches how `category` already
// works on this table).
ensureColumn("accounts", "subType", "subType TEXT DEFAULT ''");

// accounts.entityId -> entities.id (2026-09-11).
//
// The column was originally added by ensureColumn as a bare
// `entityId INTEGER DEFAULT NULL`, so it carried NO foreign key: an
// account could reference an entity that had never existed or had since
// been deleted, and nothing would complain. SQLite cannot add a
// constraint to an existing column (no ALTER TABLE ADD CONSTRAINT), so
// the table has to be rebuilt — done once, guarded on whether the FK is
// already present, using SQLite's documented 12-step procedure.
//
// ON DELETE SET NULL rather than CASCADE on purpose: deleting an entity
// must never silently delete chart-of-accounts rows. Any account left
// behind simply becomes unscoped ("Shared") and is still visible and
// fixable in the COA. (DELETE /api/entities also refuses outright while
// an entity still has books.)
//
// Must run AFTER every ensureColumn on `accounts` so the rebuilt table
// carries the complete column set. `accounts` has no indexes or triggers
// of its own, so nothing else needs recreating; journal_lines' FK to
// accounts(id) survives because ids are copied verbatim.
function ensureAccountsEntityFk() {
  const fks = db.prepare("PRAGMA foreign_key_list(accounts)").all() as any[];
  if (fks.some((f) => f.table === "entities" && f.from === "entityId")) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE accounts_fk_migration (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          description TEXT DEFAULT '',
          currency TEXT DEFAULT 'USD',
          entityId INTEGER DEFAULT NULL REFERENCES entities(id) ON DELETE SET NULL,
          isActive INTEGER NOT NULL DEFAULT 1,
          subType TEXT DEFAULT ''
        );
        INSERT INTO accounts_fk_migration (id, code, category, name, type, description, currency, entityId, isActive, subType)
          SELECT id, code, category, name, type, description, currency,
                 -- drop any pre-existing dangling reference rather than
                 -- letting the new constraint reject the whole copy
                 CASE WHEN entityId IN (SELECT id FROM entities) THEN entityId ELSE NULL END,
                 isActive, subType
          FROM accounts;
        DROP TABLE accounts;
        ALTER TABLE accounts_fk_migration RENAME TO accounts;
      `);
    })();
    console.log("Migration: accounts.entityId -> entities(id) foreign key added");
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
ensureAccountsEntityFk();

// Chart of Accounts hierarchy (2026-09-16). Added AFTER the entityId FK
// rebuild above so a fresh database gets the rebuilt table first and this
// column second (the rebuild copies a fixed column list). ON DELETE SET
// NULL is only a backstop — DELETE /api/accounts refuses to remove an
// account that still has sub-accounts.
ensureColumn("accounts", "parentId", "parentId INTEGER DEFAULT NULL REFERENCES accounts(id) ON DELETE SET NULL");

// Counterparty-specific intercompany clearing (2026-09-16). An account with
// subType 'Intercompany Clearing' and a counterpartyEntityId is "Due From /
// Due To Affiliates — <that entity>" in its owner's books. Routing matches on
// this id, never on the account name, so renames can't break posting.
ensureColumn("accounts", "counterpartyEntityId", "counterpartyEntityId INTEGER DEFAULT NULL REFERENCES entities(id) ON DELETE SET NULL");

// Statutory type guard at the database level (2026-09-16). The API already
// validates Main Type, but every other writer (seeds, scripts, a future
// module) would otherwise be free to store "Assets" or "Income" — which the
// reports would then silently drop from every statement.
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_accounts_type_valid_ins
  BEFORE INSERT ON accounts
  WHEN NEW.type NOT IN ('Asset','Liability','Equity','Revenue','Expense')
  BEGIN SELECT RAISE(ABORT, 'accounts.type must be one of Asset, Liability, Equity, Revenue, Expense'); END;
  CREATE TRIGGER IF NOT EXISTS trg_accounts_type_valid_upd
  BEFORE UPDATE OF type ON accounts
  WHEN NEW.type NOT IN ('Asset','Liability','Equity','Revenue','Expense')
  BEGIN SELECT RAISE(ABORT, 'accounts.type must be one of Asset, Liability, Equity, Revenue, Expense'); END;
`);

// One-time backfill (2026-09-11): bank heads created before the Entity
// field existed carry entityId NULL. When there is exactly ONE entity the
// owner is unambiguous, so assign it; with two or more this is left alone
// rather than guessing which company's books a bank belongs to.
function backfillSoleEntityOnBankHeads() {
  const entities = db.prepare("SELECT id FROM entities").all() as { id: number }[];
  if (entities.length !== 1) return;
  const r = db
    .prepare(
      "UPDATE accounts SET entityId = ? WHERE entityId IS NULL AND type = 'Asset' AND subType IN ('Bank','Cash and Cash Equivalents','Cash & Equivalents')",
    )
    .run(entities[0].id);
  if (r.changes > 0) console.log(`Backfill: assigned ${r.changes} bank head(s) to the sole entity`);
}
backfillSoleEntityOnBankHeads();

// Posting engine (Phase 1.3): a bank_account can optionally be pinned to a
// specific GL cash/bank Asset account. When unset, postBankTransactionToGL()
// falls back to the entity's single seeded "Cash & Equivalents" account (see
// resolveBankGlAccount below) — so this stays optional for the common case
// and only needs setting when an entity has more than one bank account.
ensureColumn("bank_accounts", "glAccountId", "glAccountId INTEGER DEFAULT NULL");

// Charged-To Entity and Accounting Period (2026-09-11).
//
// `chargedToEntityId` is WHO BEARS THE COST, which is not always who paid:
// FZCO's bank can settle a TekRevol CA expense. When it differs from the
// bank account's entity the posting is routed through the existing
// cross-brand split engine, which raises the Due From/To Affiliates pair —
// see postBankTransactionToGL.
//
// `accountingPeriod` (YYYY-MM) is WHEN THE COST BELONGS, which is not
// always when the cash moved: an annual invoice paid in May can be a
// September service period. Stored alongside the real transactionDate
// rather than replacing it, because the statutory books must keep the
// payment date (CLAUDE.md dates rule) — reports choose which basis to use.
ensureColumn("bank_transactions", "chargedToEntityId", "chargedToEntityId INTEGER DEFAULT NULL");
ensureColumn("bank_transactions", "accountingPeriod", "accountingPeriod TEXT DEFAULT NULL");
ensureColumn("journal_entries", "chargedToEntityId", "chargedToEntityId INTEGER DEFAULT NULL");
ensureColumn("journal_entries", "accountingPeriod", "accountingPeriod TEXT DEFAULT NULL");

// Audit trail for the rate actually applied (2026-09-11). The per-line
// `exchangeRate` already carries the number, but not WHERE it came from —
// and once posting stopped blocking on a missing rate, "was this figure
// derived from a real monthly rate or from a fallback?" became a question
// the books must be able to answer. `exchangeRateSource` is one of
// exact | earlier | later | parity; anything other than 'exact' means the
// USD amount is an approximation, and 'parity' on a foreign currency means
// it is knowingly wrong until re-posted.
ensureColumn("journal_entries", "appliedExchangeRate", "appliedExchangeRate REAL DEFAULT NULL");
ensureColumn("journal_entries", "exchangeRateSource", "exchangeRateSource TEXT DEFAULT NULL");

// Customer / Vendor sub-ledger (2026-09-16).
//
// `contacts` is the master list. Like accounts, a contact belongs to one
// entity or is Shared (entityId NULL) across all of them.
//
// The sub-ledger link lives on journal_lines.contactId — line level,
// because one split bank payment can settle two different vendors. The
// journal_entries.contactId / contactType pair is a convenience stamp,
// filled only when every tagged line in that entry has the same contact.
//
// No balance is ever stored on a contact (CLAUDE.md rule 3): a contact's
// ledger is derived from its tagged Posted lines, so unposting an entry
// reverses it automatically.
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contactType TEXT NOT NULL CHECK (contactType IN ('Customer','Vendor')),
    entityId INTEGER DEFAULT NULL REFERENCES entities(id) ON DELETE SET NULL,
    email TEXT DEFAULT '',
    isActive INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_name_type_entity
    ON contacts (lower(name), contactType, COALESCE(entityId, 0));
`);
// The Posted journal entry that carries a contact's opening balance (Dr AR /
// Cr Opening Balance Equity, or Dr OBE / Cr AP). The amount itself is never
// stored on the contact — it is read back from this entry's tagged line.
ensureColumn("contacts", "projectName", "projectName TEXT NOT NULL DEFAULT ''");
ensureColumn("contacts", "openingBalanceEntryId","openingBalanceEntryId INTEGER DEFAULT NULL REFERENCES journal_entries(id) ON DELETE SET NULL");
ensureColumn("journal_lines", "contactId", "contactId INTEGER DEFAULT NULL REFERENCES contacts(id)");
ensureColumn("journal_entries", "contactId", "contactId INTEGER DEFAULT NULL REFERENCES contacts(id)");
ensureColumn("journal_entries", "contactType", "contactType TEXT DEFAULT NULL");

// Live balance display (Bank Transactions Hub header cards): populated by
// refreshBankAccountBalance() below via Plaid's /accounts/balance/get.
// Native-currency only — the USD-converted figure shown in the UI is always
// computed at read time via latestRateToUsd(), never stored, per CLAUDE.md
// product rule 3 (reports/derived figures aren't stored).
ensureColumn("bank_accounts", "currentBalance", "currentBalance REAL DEFAULT NULL");
ensureColumn("bank_accounts", "currentBalanceUpdatedAt", "currentBalanceUpdatedAt TEXT DEFAULT NULL");

// Traceability (CLAUDE.md §1 rule 4): once a bank transaction is posted, this
// points at the journal_entries row it produced, so "what does this posted
// transaction map to in the GL" never depends on re-deriving it. It also
// backstops the status='PENDING' check against double-posting.
ensureColumn("bank_transactions", "journalEntryId", "journalEntryId INTEGER DEFAULT NULL");
// "Save for review" (2026-09-17): categorization prepared by a user who can't
// post (Bookkeeper) — JSON { accountId, chargedToEntityId, contactId, splits }.
// Not accounting data; cleared once the transaction is posted.
// Import provenance (Phase C). importRowHash is a stable fingerprint of the
// source transaction, so running the same export twice cannot double the
// books — the UNIQUE index below is what actually enforces that, rather than
// a check the importer could forget to make.
ensureColumn("journal_entries", "importBatchId", "importBatchId INTEGER DEFAULT NULL REFERENCES import_batches(id)");
ensureColumn("journal_entries", "importRowHash", "importRowHash TEXT DEFAULT NULL");
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_journal_entries_import_row ON journal_entries(importRowHash) WHERE importRowHash IS NOT NULL");
} catch (e) {
  console.error("Migration error (import row hash index):", e);
}

ensureColumn("bank_transactions", "stagedJson", "stagedJson TEXT DEFAULT NULL");
ensureColumn("bank_transactions", "stagedByUserId", "stagedByUserId INTEGER DEFAULT NULL");
ensureColumn("bank_transactions", "stagedAt", "stagedAt TEXT DEFAULT NULL");

// Income Statement structure (Phase 1.6, task item 1): every seeded expense
// account was tagged "Operating Expenses" back in Phase 1.1 — there was no
// P&L consumer yet, so there was no reason to split out Cost of Goods
// Sold/Direct Delivery Costs. The task's own Operating Expenses example list
// ("SaaS, Payroll, Marketing, Office, Intercompany Recharges") names exactly
// 5 of the 7 seeded expense accounts — by elimination, the remaining two
// (Hosting/Infra, Payment Gateway Fees — both direct costs of delivering
// service to clients, not general overhead) are the COGS accounts. This
// reclassifies only those two, only if still at their original seeded
// category (never overwrites a category a user has since changed), so
// Gross Profit means something. Category only changes — type stays
// "Expense", nothing else about the row is touched.
try {
  db.prepare("UPDATE accounts SET category = 'Cost of Goods Sold' WHERE code IN ('5300','5400') AND category = 'Operating Expenses'").run();
} catch (e) {
  console.error("Migration error (COGS reclassification):", e);
}

// ======= AUTO-CATEGORIZATION RULES (Phase 1.3) =======
// matchType disambiguates the task spec's "Regex or Substring" MatchPattern
// explicitly rather than trying to sniff it from the pattern text (fragile —
// e.g. "STRIPE" alone can't tell you which the author intended, and a
// silently-wrong regex/substring guess is exactly the kind of thing that
// should never be ambiguous in something that assigns GL accounts).
db.exec(`
  CREATE TABLE IF NOT EXISTS categorization_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    matchPattern TEXT NOT NULL,
    matchType TEXT NOT NULL DEFAULT 'SUBSTRING' CHECK (matchType IN ('REGEX','SUBSTRING')),
    targetAccountId INTEGER NOT NULL REFERENCES accounts(id),
    targetBrandId INTEGER REFERENCES brands(id),
    targetEntityId INTEGER NOT NULL REFERENCES entities(id),
    priority INTEGER NOT NULL DEFAULT 100,
    isActive INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_categorization_rules_active_priority ON categorization_rules(isActive, priority);
`);

// ======= AP / AR / INTERCOMPANY TREASURY (Phase 1.4) =======
// journalEntryId columns beyond the task's literal column lists follow the
// same traceability precedent as bank_transactions.journalEntryId (Phase
// 1.3): CLAUDE.md rule 4 requires every figure trace back to source rows,
// and a bill/invoice/recharge that posts to the GL needs to say which entry
// it produced. intercompany_recharges needs *two* — settlement posts one
// entry in the source entity's books and a mirroring one in the target
// entity's books (see settleIntercompanyRecharge below) — neither the task's
// column list nor a single FK could represent that.
db.exec(`
  CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    billNumber TEXT NOT NULL UNIQUE,
    entityId INTEGER NOT NULL REFERENCES entities(id),
    brandId INTEGER REFERENCES brands(id),
    vendorName TEXT NOT NULL,
    issueDate TEXT NOT NULL,
    dueDate TEXT NOT NULL,
    totalAmount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    amountPaid REAL NOT NULL DEFAULT 0,
    amountOutstanding REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PARTIALLY_PAID','PAID','VOIDED')),
    expenseAccountId INTEGER NOT NULL REFERENCES accounts(id),
    journalEntryId INTEGER DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoiceNumber TEXT NOT NULL UNIQUE,
    entityId INTEGER NOT NULL REFERENCES entities(id),
    brandId INTEGER REFERENCES brands(id),
    customerName TEXT NOT NULL,
    issueDate TEXT NOT NULL,
    dueDate TEXT NOT NULL,
    totalAmount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    amountPaid REAL NOT NULL DEFAULT 0,
    amountOutstanding REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PARTIALLY_PAID','PAID','VOIDED')),
    revenueAccountId INTEGER NOT NULL REFERENCES accounts(id),
    journalEntryId INTEGER DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payment_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    billId INTEGER REFERENCES bills(id),
    invoiceId INTEGER REFERENCES invoices(id),
    bankTransactionId INTEGER REFERENCES bank_transactions(id),
    paymentDate TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    paidFromAccountId INTEGER NOT NULL REFERENCES accounts(id),
    notes TEXT DEFAULT '',
    journalEntryId INTEGER REFERENCES journal_entries(id),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((billId IS NOT NULL AND invoiceId IS NULL) OR (billId IS NULL AND invoiceId IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS intercompany_recharges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceEntityId INTEGER NOT NULL REFERENCES entities(id),
    targetEntityId INTEGER NOT NULL REFERENCES entities(id),
    targetBrandId INTEGER REFERENCES brands(id),
    fundRequiredAmount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    purpose TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','SETTLED')),
    billId INTEGER REFERENCES bills(id),
    sourceJournalEntryId INTEGER DEFAULT NULL,
    targetJournalEntryId INTEGER DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_bills_entity_status ON bills(entityId, status);
  CREATE INDEX IF NOT EXISTS idx_invoices_entity_status ON invoices(entityId, status);
  CREATE INDEX IF NOT EXISTS idx_payment_records_bill ON payment_records(billId);
  CREATE INDEX IF NOT EXISTS idx_payment_records_invoice ON payment_records(invoiceId);
  CREATE INDEX IF NOT EXISTS idx_intercompany_recharges_source_status ON intercompany_recharges(sourceEntityId, status);
`);

// ======= BANK RECONCILIATION & PERIOD LOCKING (Phase 1.5) =======
db.exec(`
  CREATE TABLE IF NOT EXISTS reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bankAccountId INTEGER NOT NULL REFERENCES bank_accounts(id),
    statementStartDate TEXT NOT NULL,
    statementEndDate TEXT NOT NULL,
    statementStartingBalance REAL NOT NULL DEFAULT 0,
    statementEndingBalance REAL NOT NULL DEFAULT 0,
    glStartingBalance REAL NOT NULL DEFAULT 0,
    glEndingBalance REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COMPLETED','LOCKED')),
    reconciledBy TEXT DEFAULT '',
    completedAt TEXT DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reconciliation_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciliationId INTEGER NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
    bankTransactionId INTEGER REFERENCES bank_transactions(id),
    journalLineId INTEGER REFERENCES journal_lines(id),
    matchType TEXT NOT NULL DEFAULT 'SUGGESTED' CHECK (matchType IN ('EXACT','MANUAL','SUGGESTED')),
    matchScore REAL NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS accounting_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entityId INTEGER NOT NULL REFERENCES entities(id),
    periodMonth TEXT NOT NULL,
    isLocked INTEGER NOT NULL DEFAULT 0,
    lockedAt TEXT DEFAULT NULL,
    lockedBy TEXT DEFAULT '',
    UNIQUE(entityId, periodMonth)
  );

  -- ======= LEDGER IMPORT (Phase C, 2026-10-13) =======
  -- One row per uploaded file. The parsed preview is kept in payloadJson so
  -- the confirm step doesn't need the file uploaded a second time, and so
  -- what the user approved is exactly what gets written.
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'QuickBooks',
    filename TEXT NOT NULL DEFAULT '',
    entityId INTEGER NOT NULL REFERENCES entities(id),
    status TEXT NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','DRAFT','POSTED','DISCARDED')),
    fileHash TEXT NOT NULL DEFAULT '',
    payloadJson TEXT NOT NULL DEFAULT '',
    rowCount INTEGER NOT NULL DEFAULT 0,
    entryCount INTEGER NOT NULL DEFAULT 0,
    quarantineCount INTEGER NOT NULL DEFAULT 0,
    createdByUserId INTEGER DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    postedAt TEXT DEFAULT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reconciliations_bank_account_status ON reconciliations(bankAccountId, status);
  CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_reconciliation ON reconciliation_matches(reconciliationId);
  CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_bank_transaction ON reconciliation_matches(bankTransactionId);
  CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_journal_line ON reconciliation_matches(journalLineId);
`);

// Remove the temporary demo feed that was created while validating the
// unsupported-bank UI. Manual banks added by users are retained.
try {
  db.prepare(
    "DELETE FROM plaid_items WHERE isManual = 1 AND lower(institutionName) LIKE '%demo%'",
  ).run();
} catch (e) {
  console.error("Migration error (remove demo bank feed):", e);
}

// ======= PHASE 1.1 SEED: Entities, Brands, Chart of Accounts =======
// Idempotent — safe to run on every boot. Never deletes or overwrites a row
// that already exists; only inserts what's missing, matched by natural key
// (entities.name, brands.(name,entityId), accounts.code).
type SeedStats = {
  entitiesInserted: number;
  brandsInserted: number;
  accountsInserted: number;
};

function seedPhase1Schema(): SeedStats {
  const stats: SeedStats = { entitiesInserted: 0, brandsInserted: 0, accountsInserted: 0 };

  // Country/functional-currency mapping inferred from src/lib/constants.ts
  // (ENTITIES, BANKS_BY_ENTITY) — CA and BuzzFlick are not covered by the
  // task's literal "US, UAE, PK" country enum, so this is a best-effort
  // assumption logged for confirmation in .claude/PHASE_TRACKER.md.
  const ENTITY_SEED: { name: string; country: string; functionalCurrency: string }[] = [
    { name: "CA", country: "CA", functionalCurrency: "USD" }, // TekRevol CA (Canada) — books in USD like the rest of the group
    { name: "TX", country: "US", functionalCurrency: "USD" },
    { name: "UAE", country: "UAE", functionalCurrency: "AED" },
    { name: "PK", country: "PK", functionalCurrency: "PKR" },
    { name: "BuzzFlick", country: "US", functionalCurrency: "USD" }, // ASSUMPTION — confirm actual incorporation country
  ];

  const insertEntity = db.prepare(
    "INSERT INTO entities (name, country, functionalCurrency) VALUES (?, ?, ?)",
  );
  const entityIdByName = new Map<string, number>();
  for (const e of ENTITY_SEED) {
    const existing = db.prepare("SELECT id FROM entities WHERE name = ?").get(e.name) as
      | { id: number }
      | undefined;
    if (existing) {
      entityIdByName.set(e.name, existing.id);
    } else {
      const r = insertEntity.run(e.name, e.country, e.functionalCurrency);
      entityIdByName.set(e.name, Number(r.lastInsertRowid));
      stats.entitiesInserted += 1;
    }
  }

  // One default brand per entity, named after the entity itself, so every
  // journal line can carry a brandId from day one without forcing a second
  // setup step. Additional brands (e.g. multiple product lines under one
  // entity) can be added later without a migration.
  const insertBrand = db.prepare(
    "INSERT INTO brands (name, entityId, isActive) VALUES (?, ?, 1)",
  );
  for (const e of ENTITY_SEED) {
    const entityId = entityIdByName.get(e.name)!;
    const existing = db
      .prepare("SELECT id FROM brands WHERE name = ? AND entityId = ?")
      .get(e.name, entityId);
    if (!existing) {
      insertBrand.run(e.name, entityId);
      stats.brandsInserted += 1;
    }
  }

  // Standard baseline Chart of Accounts. entityId is null for shared/template
  // accounts (used across entities); Cash in Bank is entity-specific because
  // it maps to a real bank account per product rule 1 (no number entered
  // twice — each entity's cash sits in exactly one GL account).
  type AccountSeed = {
    code: string;
    name: string;
    type: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense";
    category: string;
    subType: string;
    currency: string;
    entityName?: string; // null/undefined => shared template account
  };

  const accountSeeds: AccountSeed[] = [
    // Assets
    ...ENTITY_SEED.map((e, i) => ({
      code: `100${i}`,
      name: `Cash in Bank - ${e.name}`,
      type: "Asset" as const,
      category: "Cash & Equivalents",
      subType: "Current Assets",
      currency: e.functionalCurrency,
      entityName: e.name,
    })),
    { code: "1100", name: "Accounts Receivable", type: "Asset", category: "Receivables", subType: "Current Assets", currency: "USD" },
    { code: "1200", name: "Intercompany Receivables", type: "Asset", category: "Intercompany", subType: "Intercompany Clearing", currency: "USD" },
    // Per-entity "Due From Affiliates" — the intercompany clearing account
    // debited in the PAYING entity's books when it covers a cross-brand
    // expense on another entity's behalf (item 2 in the task: automated
    // dual-entry cross-brand allocation). One per entity, additive
    // alongside the shared 1200 above — 1200 is untouched/still usable for
    // anything not going through the new split-posting engine.
    ...ENTITY_SEED.map((e, i) => ({
      code: `121${i}`,
      name: `Due From Affiliates - ${e.name}`,
      type: "Asset" as const,
      category: "Intercompany",
      subType: "Intercompany Clearing",
      currency: "USD",
      entityName: e.name,
    })),
    // Liabilities
    { code: "2000", name: "Accounts Payable", type: "Liability", category: "Payables", subType: "Accounts Payable", currency: "USD" },
    { code: "2100", name: "Accrued Expenses", type: "Liability", category: "Payables", subType: "Accounts Payable", currency: "USD" },
    { code: "2200", name: "Intercompany Payables", type: "Liability", category: "Intercompany", subType: "Intercompany Clearing", currency: "USD" },
    // Per-entity "Due To Affiliates" — credited in the BENEFITING entity's
    // books for the same cross-brand transaction (mirror of 121x above).
    ...ENTITY_SEED.map((e, i) => ({
      code: `221${i}`,
      name: `Due To Affiliates - ${e.name}`,
      type: "Liability" as const,
      category: "Intercompany",
      subType: "Intercompany Clearing",
      currency: "USD",
      entityName: e.name,
    })),
    // Equity
    { code: "3000", name: "Owner's Equity", type: "Equity", category: "Equity", subType: "Equity", currency: "USD" },
    { code: "3100", name: "Retained Earnings", type: "Equity", category: "Equity", subType: "Equity", currency: "USD" },
    // Revenue
    { code: "4000", name: "Fresh Sales", type: "Revenue", category: "Sales Revenue", subType: "Operating Revenue", currency: "USD" },
    { code: "4100", name: "Recurring Subscriptions", type: "Revenue", category: "Sales Revenue", subType: "Operating Revenue", currency: "USD" },
    { code: "4200", name: "Upsell Revenue", type: "Revenue", category: "Sales Revenue", subType: "Operating Revenue", currency: "USD" },
    // Expenses
    { code: "5000", name: "Payroll", type: "Expense", category: "Operating Expenses", subType: "Operating Expense", currency: "USD" },
    { code: "5100", name: "Software/SaaS", type: "Expense", category: "Operating Expenses", subType: "Operating Expense", currency: "USD" },
    { code: "5200", name: "Marketing/Ad Spend", type: "Expense", category: "Operating Expenses", subType: "Operating Expense", currency: "USD" },
    { code: "5300", name: "Hosting/Infra", type: "Expense", category: "Operating Expenses", subType: "COGS", currency: "USD" },
    { code: "5400", name: "Payment Gateway Fees", type: "Expense", category: "Operating Expenses", subType: "COGS", currency: "USD" },
    { code: "5500", name: "Office/Admin", type: "Expense", category: "Operating Expenses", subType: "Operating Expense", currency: "USD" },
    { code: "5600", name: "Intercompany Recharges", type: "Expense", category: "Intercompany", subType: "Intercompany Clearing", currency: "USD" },
  ];

  const insertAccount = db.prepare(
    "INSERT INTO accounts (code, category, name, type, description, currency, entityId, isActive, subType) VALUES (?, ?, ?, ?, '', ?, ?, 1, ?)",
  );
  // Backfill subType on rows this seed itself created in an earlier session
  // (before the `subType` column existed) — insert-only-if-missing never
  // touches an existing row's other columns, so those rows would otherwise
  // keep an empty subType forever even though they're in this same list.
  // Only ever fills a currently-blank subType — never overwrites a value a
  // user has since set through the Chart of Accounts UI.
  const backfillSubType = db.prepare("UPDATE accounts SET subType = ? WHERE code = ? AND (subType IS NULL OR subType = '')");
  for (const a of accountSeeds) {
    const existing = db.prepare("SELECT id FROM accounts WHERE code = ?").get(a.code);
    if (existing) {
      backfillSubType.run(a.subType, a.code);
      continue;
    }
    const entityId = a.entityName ? entityIdByName.get(a.entityName) ?? null : null;
    insertAccount.run(a.code, a.category, a.name, a.type, a.currency, entityId, a.subType);
    stats.accountsInserted += 1;
  }

  return stats;
}

// REMOVED FROM THE BOOT PATH 2026-09-11 — hard reset to a zero-state.
//
// `seedPhase1Schema()` used to run here on every start, re-inserting its
// five entities, their brands and ~30 GL accounts whenever any of them was
// missing. That is why deleting a seeded account never stuck: it came back
// on the next restart wearing the seed's name (this is what replaced the
// imported "WF"/"Chase Bank" heads at codes 1000/1001 with "Cash in Bank -
// CA"/"- TX" — see the incident note in .claude/PHASE_TRACKER.md).
//
// Entities are now created by the user through Settings → Entities
// (POST /api/entities), which also provisions each entity's brand and its
// Due From/To Affiliates intercompany heads. The chart of accounts is
// built by the user via the COA screen or a CSV import.
//
// The function itself is intentionally left in the file, unreferenced, as
// documentation of the original baseline chart — do NOT wire it back into
// the boot path. If demo data is ever wanted again, call it from an
// explicit script or behind an env flag.
void seedPhase1Schema;

// REMOVED 2026-09-11 — bank account seed (zero-state purge).
//
// This used to insert five demo operating accounts (Wells Fargo - CA,
// Chase - TX, Emirates Islamic - UAE, Meezan Bank - PK, Bank Alhabib - PK)
// at every boot so the Bank Hub had something to render. The app is now a
// real production environment: bank accounts come only from a live Plaid
// link ("Connect Bank") or an explicit manual profile ("Add Manual Bank"),
// and the Hub has a proper empty state instead.
//
// DO NOT re-add a seed here. Deleting the rows alone is not enough — an
// idempotent boot seed silently recreates them on the next restart, which
// is exactly how these survived the earlier data wipe. If a future task
// needs demo data, put it behind an explicit opt-in (a script or an env
// flag), never in the boot path.
//
// The Phase 1.1 seed above is deliberately kept: entities, brands and the
// chart of accounts are STRUCTURE, not transactional data.


const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Authentication & RBAC (2026-09-17) — see server/auth.ts. The gate runs
// before every /api handler registered below; any route without an explicit
// rule there is Admin-only.
const auth = createAuth(db);
app.use(auth.gate);
auth.registerRoutes(app);

// Which Plaid host to talk to. `development` was retired by Plaid and is
// gone from the SDK (v47 exposes sandbox + production only), so a leftover
// PLAID_ENV=development used to fall through to the SANDBOX host while
// carrying live keys — which Plaid rejects as INVALID_API_KEYS, with nothing
// in the message explaining why. It is now a loud configuration error.
function resolvePlaidEnv(): { env: string; basePath: string } {
  const env = (process.env.PLAID_ENV || "sandbox").toLowerCase().trim();
  const basePath = (PlaidEnvironments as Record<string, string>)[env];
  if (basePath) return { env, basePath };
  if (env === "development") {
    throw new Error(
      "PLAID_ENV=development is no longer supported by Plaid (the development environment was retired). " +
      "Set PLAID_ENV=sandbox with your sandbox secret, or PLAID_ENV=production with your production secret.",
    );
  }
  throw new Error(`PLAID_ENV="${env}" is not a Plaid environment. Use sandbox or production.`);
}

function plaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error(
      "Plaid credentials are not configured — set PLAID_CLIENT_ID and PLAID_SECRET (in the repo-root .env, or as real environment variables) and restart the API.",
    );
  }
  const { basePath } = resolvePlaidEnv();
  return new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
        },
      },
    }),
  );
}

// PLAID_PRODUCTS / PLAID_COUNTRY_CODES (comma-separated env vars) drive the
// Link token's product/country scope. Falls back to the transactions/US
// defaults this app has always used if unset or unrecognized, rather than
// failing Link token creation over a bad env value.
function plaidProductsFromEnv(): Products[] {
  const raw = (process.env.PLAID_PRODUCTS || "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const resolved = raw.map((p) => (Products as any)[p.charAt(0).toUpperCase() + p.slice(1)]).filter(Boolean);
  return resolved.length > 0 ? resolved : [Products.Transactions];
}

function plaidCountryCodesFromEnv(): CountryCode[] {
  const raw = (process.env.PLAID_COUNTRY_CODES || "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  const resolved = raw.map((c) => (CountryCode as any)[c.charAt(0) + c.slice(1).toLowerCase()]).filter(Boolean);
  return resolved.length > 0 ? resolved : [CountryCode.Us];
}

function encryptionKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.SESSION_SECRET || "finance-app-session-key")
    .digest();
}

function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptSecret(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function plaidErrorMessage(error: any) {
  return (
    error?.response?.data?.error_message ||
    error?.response?.data?.display_message ||
    error?.message ||
    "Plaid request failed"
  );
}

// Plaid returns its real reason (INVALID_API_KEYS, PRODUCT_NOT_READY,
// INVALID_FIELD …) in the response body. Log the whole of it — code, type,
// request id, HTTP status — and hand the codes back to the caller so the UI
// can show what actually went wrong instead of a bare 502.
function plaidErrorDetails(error: any) {
  const data = error?.response?.data ?? {};
  return {
    message: plaidErrorMessage(error),
    errorCode: data.error_code ?? null,
    errorType: data.error_type ?? null,
    requestId: data.request_id ?? null,
    status: error?.response?.status ?? null,
  };
}

function logPlaidError(where: string, error: any) {
  const d = plaidErrorDetails(error);
  console.error(
    `[plaid] ${where} failed — env=${(process.env.PLAID_ENV || "sandbox").toLowerCase()} status=${d.status ?? "-"} ` +
    `code=${d.errorCode ?? "-"} type=${d.errorType ?? "-"} requestId=${d.requestId ?? "-"}: ${d.message}`,
  );
  return d;
}

function dateFilter(month?: string, field = "date"): string {
  if (!month) return "";
  if (month.length === 7)
    return `AND strftime('%Y-%m', ${field}) = '${month.replace(/'/g, "")}'`;
  if (month.length === 4)
    return `AND strftime('%Y', ${field}) = '${month.replace(/'/g, "")}'`;
  return "";
}

function monthMatches(rowMonth: string, filter?: string): boolean {
  if (!filter) return true;
  if (!rowMonth) return false;
  if (filter.length === 7) return rowMonth === filter;
  if (filter.length === 4) return rowMonth.slice(0, 4) === filter;
  return true;
}

// ======= BANK TRANSACTIONS HUB — parsers, normalizer, dedup engine (Phase 1.2) =======
// Amount convention for the whole staging layer: positive = credit (money
// in), negative = debit (money out) — the opposite of Plaid's raw sign, so
// Plaid amounts are flipped on the way in (see syncPlaidBankAccount below).

// EVERY date in this system is an ISO `YYYY-MM-DD` string, and every
// report filters with plain string comparison (`je.transactionDate <= ?`).
// That makes a non-ISO date actively dangerous rather than merely ugly:
// "22-05-2026" compares GREATER than "2026-12-31" (because '2' > '0' at
// the second character), so a transaction stored that way silently
// disappears from the General Ledger, P&L, Balance Sheet, Trial Balance
// and every account balance — while still looking fine in the Banking
// Hub, which doesn't filter by date.
//
// That is exactly what happened on 2026-09-11: a UAE bank CSV used
// dash-separated DD-MM-YYYY, which this function did not recognise, and
// the old fallback `return s` wrote the raw string straight into the
// ledger. Two fixes below:
//   1. dash/dot separators are parsed, not just slashes; and
//   2. an unparseable date now returns "" so the row is SKIPPED, rather
//      than being written in a format that corrupts reporting.
//
// Day-vs-month order is resolved by value where possible (a component > 12
// can only be the day). When genuinely ambiguous, slashes are read
// month-first (US export convention) and dashes/dots day-first
// (European/international convention) — which is how the same banks that
// choose each separator actually write their dates.
//
// `order` (2026-09-16) overrides that per-separator guess for ambiguous
// dates. A single row can't tell 10/3/2026 apart, but a whole statement
// usually can — see resolveStatementDateOrder, which callers use to decide
// once per file instead of once per row.
type DateOrder = "DMY" | "MDY";

function normalizeDateString(raw: string, order?: DateOrder): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); // already ISO
  if (/^\d{8}/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; // OFX DTPOSTED: YYYYMMDDhhmmss[tz]

  const parts = s.match(/^(\d{1,2})([\/\-.])(\d{1,2})\2(\d{2,4})$/);
  if (parts) {
    const first = Number(parts[1]);
    const sep = parts[2];
    const second = Number(parts[3]);
    const yRaw = parts[4];
    const yyyy = yRaw.length === 2 ? (Number(yRaw) > 70 ? `19${yRaw}` : `20${yRaw}`) : yRaw;

    let dd: number;
    let mm: number;
    if (first > 12) {
      dd = first; mm = second;          // unambiguous: day first
    } else if (second > 12) {
      mm = first; dd = second;          // unambiguous: month first
    } else if (order === "DMY") {
      dd = first; mm = second;          // ambiguous, statement-level decision
    } else if (order === "MDY") {
      mm = first; dd = second;
    } else if (sep === "/") {
      mm = first; dd = second;          // ambiguous + slashes -> US
    } else {
      dd = first; mm = second;          // ambiguous + dashes/dots -> day first
    }
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  const d = new Date(s);
  // Never return the raw string: an unrecognised format must fail loudly
  // (row skipped) rather than quietly entering the ledger un-comparable.
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// Decides DD/MM vs MM/DD ONCE for a whole statement (2026-09-16).
//
// Why: per-row guessing read a day-first Wells Fargo export
// ("10/3/2026" = 10 March) as month-first, pushing a March statement into
// October–December 2026. Those rows were in the future, so every report run
// "as of today" silently excluded anything posted from them.
//
// Evidence, strongest first:
//   1. Any row with a component > 12 fixes the order for the whole file
//      (a statement never mixes conventions).
//   2. Plausibility: a bank statement cannot contain future transactions.
//      If one reading puts rows in the future and the other doesn't, the
//      other reading wins.
//   3. Otherwise undefined — normalizeDateString keeps its per-separator
//      default.
function resolveStatementDateOrder(rawDates: string[], today = new Date()): DateOrder | undefined {
  const parsed = rawDates
    .map((r) => String(r || "").trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))
    .filter((m): m is RegExpMatchArray => !!m);
  if (parsed.length === 0) return undefined;
  if (parsed.some((m) => Number(m[1]) > 12)) return "DMY";
  if (parsed.some((m) => Number(m[2]) > 12)) return "MDY";

  // Small grace for timezone / same-day postings.
  const horizon = new Date(today.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  const futureCount = (order: DateOrder) =>
    rawDates.filter((r) => {
      const iso = normalizeDateString(r, order);
      return iso && iso > horizon;
    }).length;
  const mdyFuture = futureCount("MDY");
  const dmyFuture = futureCount("DMY");
  if (mdyFuture > 0 && dmyFuture === 0) return "DMY";
  if (dmyFuture > 0 && mdyFuture === 0) return "MDY";
  return undefined;
}

function parseMoneyString(raw: string): number {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const isParenNegative = /^\(.*\)$/.test(s); // accounting convention: (45.99) means -45.99
  const cleaned = s.replace(/[(),$]/g, "").replace(/,/g, "");
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return 0;
  return isParenNegative ? -Math.abs(n) : n;
}

// Minimal RFC4180-ish CSV tokenizer: handles quoted fields, embedded commas
// inside quotes, and "" as an escaped quote. Deliberately dependency-free —
// files here are bank statements (hundreds to low thousands of rows), not
// bulk data, and the repo's existing style is hand-rolled parsing (see
// dateFilter/monthMatches above) rather than adding a new package for this.
function parseDelimitedText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* ignore, \n below ends the row */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

type ColumnMapping = {
  dateColumn: string; // header name (case-insensitive) or 0-based index
  descriptionColumn: string;
  amountColumn?: string; // single signed column (credits positive), OR:
  debitColumn?: string; // separate debit/credit columns
  creditColumn?: string;
  hasHeaderRow?: boolean; // default true
  /** Explicit DD/MM vs MM/DD for ambiguous dates; auto-resolved per file when omitted. */
  dateOrder?: DateOrder;
};

type NormalizedTxn = {
  transactionDate: string; // YYYY-MM-DD
  description: string;
  rawText?: string;
  amount: number; // positive = credit, negative = debit
  currency?: string;
  plaidTransactionId?: string | null;
};

function parseCsvStatement(text: string, mapping: ColumnMapping): NormalizedTxn[] {
  const rows = parseDelimitedText(text);
  if (rows.length === 0) return [];
  const hasHeader = mapping.hasHeaderRow !== false;
  const header = hasHeader ? rows[0].map((h) => h.trim()) : null;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const colIndex = (name?: string): number => {
    if (!name && name !== "0") return -1;
    if (header) {
      const idx = header.findIndex((h) => h.toLowerCase() === String(name).toLowerCase());
      if (idx >= 0) return idx;
    }
    const asNum = Number(name);
    return Number.isInteger(asNum) ? asNum : -1;
  };

  const dateIdx = colIndex(mapping.dateColumn);
  const descIdx = colIndex(mapping.descriptionColumn);
  const amountIdx = colIndex(mapping.amountColumn);
  const debitIdx = colIndex(mapping.debitColumn);
  const creditIdx = colIndex(mapping.creditColumn);
  if (dateIdx < 0 || descIdx < 0) {
    throw new Error("columnMapping.dateColumn and descriptionColumn must match a real column");
  }

  const dateOrder = mapping.dateOrder ?? resolveStatementDateOrder(dataRows.map((r) => r[dateIdx] || ""));
  const out: NormalizedTxn[] = [];
  for (const r of dataRows) {
    const date = normalizeDateString(r[dateIdx] || "", dateOrder);
    const description = (r[descIdx] || "").trim();
    if (!date || !description) continue;
    let amount: number;
    if (amountIdx >= 0) {
      amount = parseMoneyString(r[amountIdx]);
    } else {
      const debit = debitIdx >= 0 ? Math.abs(parseMoneyString(r[debitIdx])) : 0;
      const credit = creditIdx >= 0 ? Math.abs(parseMoneyString(r[creditIdx])) : 0;
      amount = credit - debit;
    }
    out.push({ transactionDate: date, description, rawText: r.join(","), amount });
  }
  return out;
}

// OFX and QBO share the same <STMTTRN>...</STMTTRN> transaction-block
// structure (QBO is Quicken's OFX-based format) — one tolerant parser
// covers both. Deliberately regex/line-based rather than a strict XML/SGML
// parser: real-world OFX exports from banks are frequently not
// well-formed XML (unclosed tags per the OFX 1.x SGML convention), and a
// strict parser would reject files a human would call valid.
function parseOfxStatement(text: string): NormalizedTxn[] {
  const out: NormalizedTxn[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/<\/STMTTRN>/i)[0];
    const field = (tag: string): string => {
      const m = body.match(new RegExp(`<${tag}>([^\\r\\n<]*)`, "i"));
      return m ? m[1].trim() : "";
    };
    const dtRaw = field("DTPOSTED") || field("DTUSER");
    const amtRaw = field("TRNAMT");
    if (!dtRaw || !amtRaw) continue;
    const name = field("NAME");
    const memo = field("MEMO");
    const fitId = field("FITID");
    out.push({
      transactionDate: normalizeDateString(dtRaw),
      description: (name || memo || "(no description)").trim(),
      rawText: (fitId ? `FITID:${fitId}\n` : "") + body.trim(),
      amount: parseMoneyString(amtRaw),
    });
  }
  return out;
}

// ---- CSV header auto-detection ----
// Bank exports use wildly inconsistent header names, so a client that omits
// columnMapping (or the server, as a last-resort fallback) tries to guess it
// from the header row rather than forcing every upload through manual
// mapping. Matching is by whole word/phrase token, not substring — a naive
// substring check on short aliases like "in"/"out"/"dr"/"cr" would false-
// -match inside unrelated words (e.g. "Interest" contains "in").
const DATE_COLUMN_ALIASES = ["date", "txn date", "transaction date", "posting date"];
const DESCRIPTION_COLUMN_ALIASES = ["description", "narrative", "particulars", "memo", "payee", "details"];
const AMOUNT_COLUMN_ALIASES = ["amount", "net amount", "val"];
const DEBIT_COLUMN_ALIASES = ["debit", "withdrawal", "dr", "out"];
const CREDIT_COLUMN_ALIASES = ["credit", "deposit", "cr", "in"];

function tokenizeHeader(h: string): string[] {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function headerMatchesAlias(headerTokens: string[], alias: string): boolean {
  const aliasTokens = tokenizeHeader(alias);
  if (aliasTokens.length === 0) return false;
  for (let i = 0; i <= headerTokens.length - aliasTokens.length; i++) {
    if (aliasTokens.every((t, j) => headerTokens[i + j] === t)) return true;
  }
  return false;
}

function findColumnByAliases(headers: string[], aliases: string[]): string | undefined {
  return headers.find((h) => {
    const tokens = tokenizeHeader(h);
    return aliases.some((a) => headerMatchesAlias(tokens, a));
  });
}

// Returns null (never throws) when the header row doesn't contain enough to
// build a usable mapping — callers decide what to do (fall back to a clear
// error, or ask the user for a manual mapping).
function detectColumnMapping(headerRow: string[]): ColumnMapping | null {
  const dateColumn = findColumnByAliases(headerRow, DATE_COLUMN_ALIASES);
  const descriptionColumn = findColumnByAliases(headerRow, DESCRIPTION_COLUMN_ALIASES);
  if (!dateColumn || !descriptionColumn) return null;

  const amountColumn = findColumnByAliases(headerRow, AMOUNT_COLUMN_ALIASES);
  const debitColumn = findColumnByAliases(headerRow, DEBIT_COLUMN_ALIASES);
  const creditColumn = findColumnByAliases(headerRow, CREDIT_COLUMN_ALIASES);
  if (!amountColumn && !debitColumn && !creditColumn) return null;

  return { dateColumn, descriptionColumn, amountColumn, debitColumn, creditColumn, hasHeaderRow: true };
}

function parseStatementFile(
  filename: string,
  buffer: Buffer,
  mapping?: ColumnMapping,
): { format: "CSV" | "OFX" | "QBO"; transactions: NormalizedTxn[]; detectedMapping?: ColumnMapping } {
  const ext = path.extname(filename).toLowerCase();
  const text = buffer.toString("utf8");
  if (ext === ".csv") {
    let detectedMapping: ColumnMapping | undefined;
    let effectiveMapping = mapping;
    if (!effectiveMapping || !effectiveMapping.dateColumn || !effectiveMapping.descriptionColumn) {
      const headerRow = (parseDelimitedText(text)[0] || []).map((h) => h.trim());
      const detected = detectColumnMapping(headerRow);
      if (detected) {
        detectedMapping = detected;
        effectiveMapping = detected;
      }
    }
    if (!effectiveMapping || !effectiveMapping.dateColumn || !effectiveMapping.descriptionColumn) {
      throw new Error(
        "CSV import requires columnMapping with at least dateColumn and descriptionColumn, plus amountColumn or debitColumn/creditColumn — the header row didn't contain any recognizable column names, so this couldn't be auto-detected",
      );
    }
    return { format: "CSV", transactions: parseCsvStatement(text, effectiveMapping), detectedMapping };
  }
  if (ext === ".ofx" || ext === ".qbo") {
    return { format: ext === ".qbo" ? "QBO" : "OFX", transactions: parseOfxStatement(text) };
  }
  throw new Error(`Unsupported statement format "${ext}" — supported: .csv, .ofx, .qbo`);
}

// ---- Deduplication engine ----
// Hash = MD5(bankAccountId + transactionDate + amount + normalizedDescription).
// Amount is fixed to 2 decimals and description is case/whitespace/punctuation
// -normalized first so the same real-world transaction hashes identically
// whether it arrives via CSV re-upload, OFX, or a Plaid sync.
function normalizeDescriptionForHash(desc: string): string {
  return (desc || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeDedupeHash(bankAccountId: number, transactionDate: string, amount: number, description: string): string {
  const key = `${bankAccountId}|${transactionDate}|${amount.toFixed(2)}|${normalizeDescriptionForHash(description)}`;
  return crypto.createHash("md5").update(key).digest("hex");
}

// Single insert path shared by CSV/OFX/QBO import and Plaid sync, so the
// dedupe rule is enforced exactly once, in exactly one place. The DB-level
// UNIQUE constraint on deduplicationHash is a safety net behind the
// pre-check (catches a race between two concurrent imports of the same
// statement), not the primary mechanism.
function ingestBankTransaction(txn: {
  bankAccountId: number;
  transactionDate: string;
  description: string;
  rawText?: string;
  amount: number;
  currency?: string;
  plaidTransactionId?: string | null;
}): { inserted: boolean; duplicate: boolean; id?: number } {
  const bankAccountCurrency = (bankAccountId: number): string => {
    const row = db.prepare("SELECT currency FROM bank_accounts WHERE id = ?").get(bankAccountId) as
      | { currency: string }
      | undefined;
    return (row?.currency || "USD").toUpperCase();
  };
  const hash = computeDedupeHash(txn.bankAccountId, txn.transactionDate, txn.amount, txn.description);
  const existing = db.prepare("SELECT id FROM bank_transactions WHERE deduplicationHash = ?").get(hash) as
    | { id: number }
    | undefined;
  if (existing) return { inserted: false, duplicate: true, id: existing.id };
  try {
    const r = db
      .prepare(
        `INSERT INTO bank_transactions (bankAccountId, transactionDate, description, rawText, amount, currency, status, deduplicationHash, plaidTransactionId)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(
        txn.bankAccountId,
        txn.transactionDate,
        txn.description,
        txn.rawText || "",
        txn.amount,
        // A statement row is denominated in its bank account's currency.
        // Defaulting to "USD" mislabelled every row imported into an AED
        // account, which then posted to the GL at rate 1:1.
        txn.currency || bankAccountCurrency(txn.bankAccountId),
        hash,
        txn.plaidTransactionId || null,
      );
    return { inserted: true, duplicate: false, id: Number(r.lastInsertRowid) };
  } catch (e: any) {
    if (String(e?.message || "").includes("UNIQUE constraint failed")) {
      return { inserted: false, duplicate: true };
    }
    throw e;
  }
}

// ---- Plaid ingestion service ----
// Modular by design: it reuses plaidClient()/decryptSecret()/plaidErrorMessage
// from the existing Plaid integration above rather than re-implementing
// credential handling, so PLAID_CLIENT_ID/PLAID_SECRET (env) and each
// connection's encrypted access token stay the one place Plaid credentials
// live in this codebase. A bank_accounts row becomes "Plaid-ready" by setting
// connectionType='PLAID' and plaidAccountId to a real Plaid account id
// already linked via the existing /api/plaid/exchange flow (which populates
// plaid_items/plaid_accounts) — this function is the bridge from that
// existing table into the new staging table.
async function syncPlaidBankAccount(bankAccountId: number): Promise<{ added: number; duplicatesSkipped: number }> {
  const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bankAccountId) as any;
  if (!bankAccount) throw new Error("Bank account not found");
  if (bankAccount.connectionType !== "PLAID") {
    throw new Error("This bank account is not Plaid-connected (connectionType is MANUAL_UPLOAD)");
  }
  if (!bankAccount.plaidAccountId) throw new Error("This bank account has no plaidAccountId linked yet");

  const plaidAccount = db
    .prepare("SELECT * FROM plaid_accounts WHERE plaidAccountId = ?")
    .get(bankAccount.plaidAccountId) as any;
  if (!plaidAccount) {
    throw new Error("No Plaid connection found for this account's plaidAccountId — link the bank via /api/plaid first");
  }
  const item = db.prepare("SELECT * FROM plaid_items WHERE id = ?").get(plaidAccount.itemId) as any;
  if (!item) throw new Error("The Plaid connection for this bank account no longer exists");

  const client = plaidClient(); // throws a clear error if PLAID_CLIENT_ID/PLAID_SECRET aren't configured
  const accessToken = decryptSecret(item.accessToken);

  let cursor = item.cursor || undefined;
  let hasMore = true;
  let added = 0;
  let duplicatesSkipped = 0;
  while (hasMore) {
    const response = await client.transactionsSync({ access_token: accessToken, ...(cursor ? { cursor } : {}) });
    const data = response.data;
    for (const t of data.added || []) {
      if (t.account_id !== bankAccount.plaidAccountId) continue; // one Plaid item can cover several accounts
      const result = ingestBankTransaction({
        bankAccountId: bankAccount.id,
        transactionDate: t.date,
        description: t.merchant_name || t.name,
        rawText: JSON.stringify(t),
        amount: -(t.amount ?? 0), // Plaid: positive = money out; ours: positive = credit (money in)
        currency: t.iso_currency_code || bankAccount.currency || "USD",
        plaidTransactionId: t.transaction_id,
      });
      if (result.inserted) added += 1;
      else duplicatesSkipped += 1;
    }
    cursor = data.next_cursor;
    hasMore = Boolean(data.has_more);
  }
  return { added, duplicatesSkipped };
}

// Live balance refresh — Plaid's /accounts/balance/get (accountsBalanceGet),
// not the cached accountsGet balance the legacy plaid_items sync uses, since
// the Hub's header cards need a real-time figure on demand. Same join chain
// (bank_accounts -> plaid_accounts -> plaid_items -> access token) as
// syncPlaidBankAccount above — reuses it rather than re-deriving it.
async function refreshBankAccountBalance(bankAccountId: number): Promise<any> {
  const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bankAccountId) as any;
  if (!bankAccount) throw new Error("Bank account not found");
  if (bankAccount.connectionType !== "PLAID") {
    throw new Error("This bank account is not Plaid-connected (connectionType is MANUAL_UPLOAD)");
  }
  if (!bankAccount.plaidAccountId) throw new Error("This bank account has no plaidAccountId linked yet");

  const plaidAccount = db
    .prepare("SELECT * FROM plaid_accounts WHERE plaidAccountId = ?")
    .get(bankAccount.plaidAccountId) as any;
  if (!plaidAccount) {
    throw new Error("No Plaid connection found for this account's plaidAccountId — link the bank via /api/plaid first");
  }
  const item = db.prepare("SELECT * FROM plaid_items WHERE id = ?").get(plaidAccount.itemId) as any;
  if (!item) throw new Error("The Plaid connection for this bank account no longer exists");

  const client = plaidClient();
  const accessToken = decryptSecret(item.accessToken);
  const response = await client.accountsBalanceGet({
    access_token: accessToken,
    options: { account_ids: [bankAccount.plaidAccountId] },
  });
  const plaidBalanceAccount = response.data.accounts.find((a) => a.account_id === bankAccount.plaidAccountId);
  if (!plaidBalanceAccount) throw new Error("Plaid did not return a balance for this account");

  const balance = plaidBalanceAccount.balances?.current ?? plaidBalanceAccount.balances?.available ?? null;
  const updatedAt = new Date().toISOString();
  db.prepare("UPDATE bank_accounts SET currentBalance = ?, currentBalanceUpdatedAt = ? WHERE id = ?").run(
    balance,
    updatedAt,
    bankAccountId,
  );
  return db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bankAccountId);
}

const bankTransactionImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---- Routes ----

// Phase 1.1's entities/brands tables had no REST surface until now — the
// Bank Transactions Hub UI needs real (numeric) entity/brand ids for its
// dropdowns, distinct from the string codes in src/lib/constants.ts.
// bankAccountCount is derived from the CHART OF ACCOUNTS, not from the
// bank_accounts table (2026-09-11). Since the Banking hub became
// COA-driven, a bank only gets a bank_accounts "feed" row the first time a
// statement is uploaded to it — so counting feed rows reported 0 for
// entities that visibly had bank cards. Counting the Asset/Bank heads
// themselves is what the Settings screen actually means by "bank
// accounts", and it matches what Banking renders one-for-one.
app.get("/api/entities", (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT e.*,
           (SELECT COUNT(*) FROM accounts a
             WHERE a.entityId = e.id
               AND a.isActive = 1
               AND a.type = 'Asset'
               AND a.subType IN ('Bank', 'Cash and Cash Equivalents', 'Cash & Equivalents')
           ) AS bankAccountCount,
           (SELECT COUNT(*) FROM brands b WHERE b.entityId = e.id) AS brandCount
         FROM entities e
         ORDER BY e.name`,
      )
      .all()
      // Entity isolation: a restricted user only ever sees their entities,
      // which also scopes every entity picker in the UI.
      .filter((e: any) => canAccessEntity(req, e.id)),
  );
});

// Entity CRUD (2026-09-11). Entities used to exist only as a boot seed,
// which made them impossible to manage from the app — that seed is gone
// (see the note where seedPhase1Schema used to run), so this is now the
// only way they come into existence.
//
// Creating an entity also provisions the two things the rest of the system
// assumes every entity has:
//   1. a same-named brand (journal_lines.brandId is the per-brand
//      reporting grain), and
//   2. its pair of intercompany clearing heads — "Due From Affiliates - X"
//      (Asset) and "Due To Affiliates - X" (Liability) — which the
//      cross-brand split posting engine debits/credits and the
//      consolidated balance sheet eliminates against.
// Without step 2 the intercompany engine silently has nowhere to post, so
// it is done here rather than left to the user to remember.
// ---- Counterparty-specific intercompany clearing accounts (2026-09-16) ----
//
// For every ordered pair of entities (OWNER, COUNTERPARTY) the owner's COA
// carries exactly one of each, scoped to the owner:
//   Asset      "Due From Affiliates — <counterparty>"  (receivable)
//   Liability  "Due To Affiliates — <counterparty>"    (payable)
// linked by accounts.counterpartyEntityId. With N entities that is
// 2·N·(N−1) accounts; each side's balance with each affiliate is visible on
// its own, and the consolidated balance sheet still eliminates them all
// (subType 'Intercompany Clearing').

const IC_PREFIX = { DueFrom: "Due From Affiliates", DueTo: "Due To Affiliates" } as const;
const icAccountName = (direction: "DueFrom" | "DueTo", counterpartyName: string) => `${IC_PREFIX[direction]} — ${counterpartyName}`;

// Idempotent. Returns how many accounts it created / adopted.
function ensureIntercompanyPair(ownerEntityId: number, counterpartyEntityId: number): { created: number; adopted: number } {
  const result = { created: 0, adopted: 0 };
  if (ownerEntityId === counterpartyEntityId) return result;
  const counterparty = db.prepare("SELECT id, name FROM entities WHERE id = ?").get(counterpartyEntityId) as { id: number; name: string } | undefined;
  const owner = db.prepare("SELECT id FROM entities WHERE id = ?").get(ownerEntityId);
  if (!counterparty || !owner) return result;

  for (const direction of ["DueFrom", "DueTo"] as const) {
    const type = direction === "DueFrom" ? "Asset" : "Liability";
    const existing = db
      .prepare("SELECT id FROM accounts WHERE entityId = ? AND counterpartyEntityId = ? AND type = ? AND subType = 'Intercompany Clearing'")
      .get(ownerEntityId, counterpartyEntityId, type);
    if (existing) continue;

    // Adopt a pre-feature generic clearing account ("Due From Affiliates -
    // <owner>", no counterparty) instead of duplicating it — but ONLY if
    // nothing has been posted to it, so no historical balance is ever
    // silently re-attributed to a particular affiliate.
    const legacy = db
      .prepare(`SELECT a.id FROM accounts a
                WHERE a.entityId = ? AND a.counterpartyEntityId IS NULL AND a.type = ?
                  AND a.subType = 'Intercompany Clearing' AND a.name LIKE ?
                  AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.accountId = a.id)
                ORDER BY a.id LIMIT 1`)
      .get(ownerEntityId, type, `${IC_PREFIX[direction]}%`) as { id: number } | undefined;
    if (legacy) {
      db.prepare("UPDATE accounts SET counterpartyEntityId = ?, name = ? WHERE id = ?")
        .run(counterpartyEntityId, icAccountName(direction, counterparty.name), legacy.id);
      result.adopted += 1;
      continue;
    }

    db.prepare(
      `INSERT INTO accounts (code, category, name, type, description, subType, currency, entityId, isActive, counterpartyEntityId)
       VALUES (?, 'Intercompany', ?, ?, '', 'Intercompany Clearing', 'USD', ?, 1, ?)`,
    ).run(nextAccountCodeForType(type), icAccountName(direction, counterparty.name), type, ownerEntityId, counterpartyEntityId);
    result.created += 1;
  }
  return result;
}

// Both directions for every pair — used at boot (backfill) and whenever an
// entity is created. Runs in one transaction.
function ensureAllIntercompanyPairs(): { created: number; adopted: number } {
  return db.transaction(() => {
    const ids = (db.prepare("SELECT id FROM entities ORDER BY id").all() as { id: number }[]).map((e) => e.id);
    const total = { created: 0, adopted: 0 };
    for (const owner of ids) {
      for (const counterparty of ids) {
        if (owner === counterparty) continue;
        const r = ensureIntercompanyPair(owner, counterparty);
        total.created += r.created;
        total.adopted += r.adopted;
      }
    }
    return total;
  })();
}

app.post("/api/entities", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const country = String(req.body?.country || "").trim();
  const functionalCurrency = String(req.body?.functionalCurrency || "USD").trim().toUpperCase();
  if (!name) return res.status(400).json({ error: "Entity name is required" });
  if (!country) return res.status(400).json({ error: "Country is required" });

  try {
    const created = db.transaction(() => {
      const e = db
        .prepare("INSERT INTO entities (name, country, functionalCurrency) VALUES (?, ?, ?)")
        .run(name, country, functionalCurrency);
      const entityId = Number(e.lastInsertRowid);

      db.prepare("INSERT INTO brands (name, entityId, isActive) VALUES (?, ?, 1)").run(name, entityId);

      // Reciprocal counterparty-specific clearing accounts with every
      // existing entity: in the NEW entity's books one Due From / Due To per
      // existing entity, and in each existing entity's books a Due From /
      // Due To for the new one. Same transaction — all or nothing.
      let created = 0;
      const others = (db.prepare("SELECT id FROM entities WHERE id <> ?").all(entityId) as { id: number }[]).map((r) => r.id);
      for (const other of others) {
        created += ensureIntercompanyPair(entityId, other).created;
        created += ensureIntercompanyPair(other, entityId).created;
      }
      return { entityId, created };
    })();
    res.json({ ...(db.prepare("SELECT * FROM entities WHERE id = ?").get(created.entityId) as any), intercompanyAccountsCreated: created.created });
  } catch (err: any) {
    const msg = /UNIQUE/i.test(err.message || "") ? `An entity named "${name}" already exists` : err.message;
    res.status(400).json({ error: msg || "Failed to create entity" });
  }
});

app.put("/api/entities/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM entities WHERE id = ?").get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "Entity not found" });
  const name = String(req.body?.name ?? existing.name).trim();
  const country = String(req.body?.country ?? existing.country).trim();
  const functionalCurrency = String(req.body?.functionalCurrency ?? existing.functionalCurrency).trim().toUpperCase();
  if (!name) return res.status(400).json({ error: "Entity name is required" });
  try {
    db.transaction(() => {
      db.prepare("UPDATE entities SET name = ?, country = ?, functionalCurrency = ? WHERE id = ?").run(name, country, functionalCurrency, req.params.id);
      db.prepare("UPDATE brands SET name = ? WHERE entityId = ? AND name = ?").run(name, req.params.id, existing.name);
      // Keep other entities' "Due From/To Affiliates — <this entity>" names
      // in step — only where the name is still the auto-generated one, so a
      // deliberate manual rename in the COA is never overwritten.
      if (name !== existing.name) {
        for (const direction of ["DueFrom", "DueTo"] as const) {
          db.prepare("UPDATE accounts SET name = ? WHERE counterpartyEntityId = ? AND name = ?")
            .run(icAccountName(direction, name), req.params.id, icAccountName(direction, existing.name));
        }
      }
    })();
    res.json(db.prepare("SELECT * FROM entities WHERE id = ?").get(req.params.id));
  } catch (err: any) {
    const msg = /UNIQUE/i.test(err.message || "") ? `An entity named "${name}" already exists` : err.message;
    res.status(400).json({ error: msg || "Failed to update entity" });
  }
});

// Refuses rather than cascading: an entity with posted history is part of
// the legal record, and silently deleting its journal entries to satisfy
// a DELETE would destroy books. The caller is told exactly what is in the
// way.
app.delete("/api/entities/:id", (req, res) => {
  const id = Number(req.params.id);
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as any;
  if (!entity) return res.status(404).json({ error: "Entity not found" });

  const entries = (db.prepare("SELECT COUNT(*) as n FROM journal_entries WHERE entityId = ?").get(id) as any).n;
  const banks = (db.prepare("SELECT COUNT(*) as n FROM bank_accounts WHERE entityId = ?").get(id) as any).n;
  if (entries > 0 || banks > 0) {
    return res.status(400).json({
      error: `"${entity.name}" still has ${entries} journal entr${entries === 1 ? "y" : "ies"} and ${banks} bank account(s). Remove those first — deleting an entity never deletes its books.`,
    });
  }

  // The reciprocal "Due From/To Affiliates — <this entity>" accounts live in
  // OTHER entities' books. They can only carry lines if this entity had
  // journal entries (refused above), but check rather than assume.
  const usedMirrors = (db.prepare(
    "SELECT COUNT(*) n FROM accounts a WHERE a.counterpartyEntityId = ? AND EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.accountId = a.id)",
  ).get(id) as { n: number }).n;
  if (usedMirrors > 0) {
    return res.status(400).json({ error: `Other entities have posted intercompany activity with "${entity.name}" — it can't be deleted.` });
  }

  let removedMirrors = 0;
  db.transaction(() => {
    // Its own scoped accounts and brands go too; both are meaningless
    // without the entity — as do the other entities' clearing accounts for it.
    removedMirrors = db.prepare("DELETE FROM accounts WHERE counterpartyEntityId = ? AND entityId <> ?").run(id, id).changes;
    db.prepare("DELETE FROM accounts WHERE entityId = ?").run(id);
    db.prepare("DELETE FROM brands WHERE entityId = ?").run(id);
    db.prepare("DELETE FROM entities WHERE id = ?").run(id);
  })();
  res.json({ ok: true, intercompanyAccountsRemoved: removedMirrors });
});

app.get("/api/brands", (req, res) => {
  const { entityId } = req.query as any;
  let q = "SELECT * FROM brands WHERE 1=1";
  const params: any[] = [];
  if (entityId) {
    q += " AND entityId = ?";
    params.push(entityId);
  }
  q += " ORDER BY name";
  res.json((db.prepare(q).all(...params) as any[]).filter((b) => canAccessEntity(req, b.entityId)));
});

// Read-only GL drill-down (flagged as missing in every phase log since 1.3):
// the Bank Transactions Hub's Posted tab needs to resolve a bank
// transaction's journalEntryId into a human-readable entryNumber and its
// brand, for display and for brand filtering.
app.get("/api/journal-entries", (req, res) => {
  const { entityId, brandId, status } = req.query as any;
  let q = "SELECT * FROM journal_entries WHERE 1=1";
  const params: any[] = [];
  if (entityId) {
    q += " AND entityId = ?";
    params.push(entityId);
  }
  if (brandId) {
    q += " AND brandId = ?";
    params.push(brandId);
  }
  if (status) {
    q += " AND status = ?";
    params.push(status);
  }
  q += " ORDER BY id DESC";
  res.json((db.prepare(q).all(...params) as any[]).filter((je) => canAccessEntity(req, je.entityId)));
});

// ---- Split rules (2026-09-17) ----
//
// Reusable percentage templates applied in the Banking Split modal. They are
// pure configuration: applying one only fills the modal's lines, and the
// posting itself still goes through the split engine's cent checks.
function splitRuleWithLines(id: number) {
  const rule = db.prepare("SELECT * FROM split_rules WHERE id = ?").get(id) as any;
  if (!rule) return null;
  rule.lines = db
    .prepare("SELECT srl.*, e.name as entityName FROM split_rule_lines srl JOIN entities e ON e.id = srl.entityId WHERE srl.ruleId = ? ORDER BY srl.sortOrder, srl.id")
    .all(id);
  return rule;
}

// Percentages are carried to 4 dp, the same scale the Split modal uses, so a
// 33.3333 / 33.3333 / 33.3334 rule totals exactly 100.
function validateSplitRuleLines(lines: any): string | null {
  if (!Array.isArray(lines) || lines.length < 2) return "A split rule needs at least two entity lines";
  let units = 0;
  for (const [i, l] of lines.entries()) {
    const entityId = Number(l?.entityId);
    if (!Number.isInteger(entityId) || !db.prepare("SELECT id FROM entities WHERE id = ?").get(entityId)) {
      return `Line ${i + 1}: pick an entity`;
    }
    const pct = Number(l?.percent);
    if (!Number.isFinite(pct) || pct <= 0) return `Line ${i + 1}: percentage must be greater than 0`;
    units += Math.round(pct * 10000);
  }
  if (new Set(lines.map((l: any) => Number(l.entityId))).size !== lines.length) return "Each entity can appear only once in a rule";
  if (units !== 100 * 10000) return `Percentages must total exactly 100% (currently ${(units / 10000).toFixed(4).replace(/\.?0+$/, "")}%)`;
  return null;
}

app.get("/api/split-rules", (req, res) => {
  const rules = db.prepare("SELECT * FROM split_rules ORDER BY name").all() as any[];
  res.json(rules.map((r) => splitRuleWithLines(r.id)));
});

app.post("/api/split-rules", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Name is required" });
  const error = validateSplitRuleLines(req.body?.lines);
  if (error) return res.status(400).json({ error });
  const id = db.transaction(() => {
    const r = db.prepare("INSERT INTO split_rules (name, description) VALUES (?, ?)").run(name, String(req.body?.description ?? "").trim());
    const ruleId = Number(r.lastInsertRowid);
    const line = db.prepare("INSERT INTO split_rule_lines (ruleId, entityId, percent, sortOrder) VALUES (?, ?, ?, ?)");
    req.body.lines.forEach((l: any, i: number) => line.run(ruleId, Number(l.entityId), Number(l.percent), i));
    return ruleId;
  })();
  res.json(splitRuleWithLines(id));
});

app.put("/api/split-rules/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM split_rules WHERE id = ?").get(id) as any;
  if (!existing) return res.status(404).json({ error: "Rule not found" });
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (req.body?.lines !== undefined) {
    const error = validateSplitRuleLines(req.body.lines);
    if (error) return res.status(400).json({ error });
  }
  db.transaction(() => {
    db.prepare("UPDATE split_rules SET name = ?, description = ?, isActive = ? WHERE id = ?").run(
      name,
      req.body?.description !== undefined ? String(req.body.description).trim() : existing.description,
      req.body?.isActive === false || req.body?.isActive === 0 ? 0 : 1,
      id,
    );
    if (req.body?.lines !== undefined) {
      db.prepare("DELETE FROM split_rule_lines WHERE ruleId = ?").run(id);
      const line = db.prepare("INSERT INTO split_rule_lines (ruleId, entityId, percent, sortOrder) VALUES (?, ?, ?, ?)");
      req.body.lines.forEach((l: any, i: number) => line.run(id, Number(l.entityId), Number(l.percent), i));
    }
  })();
  res.json(splitRuleWithLines(id));
});

app.delete("/api/split-rules/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare("SELECT id FROM split_rules WHERE id = ?").get(id)) return res.status(404).json({ error: "Rule not found" });
  // Rules are never referenced by a posting (applying one only fills the
  // modal), so deleting one can't orphan ledger history.
  db.prepare("DELETE FROM split_rules WHERE id = ?").run(id);
  res.json({ ok: true, deleted: id });
});

// ---- Manual journal entries (2026-09-17) ----
//
// A hand-written entry, posted straight to the ledger. Statutory rules:
//   - at least two lines, each exactly one-sided (debit XOR credit), > 0
//   - total debits = total credits to the cent IN USD, AND each entity's own
//     lines balance on their own: journal_entries holds ONE entity, so a set
//     that doesn't balance per entity would leave that company's books
//     lopsided. (Use the Due From / To Affiliates heads between entities.)
//   - every line's account must belong to that line's entity or be Shared
//   - the period must not be locked, and the user must have entity access
//
// Multi-currency (2026-09-18): a line carries its own currency and rate to
// USD (defaulting to the month's configured rate, overridable). The native
// amount goes in journal_lines.debit/credit with `currency`/`exchangeRate`
// beside it for audit, and `amountUSD` holds the converted figure — the same
// shape every other posting path writes, so the GL, COA balances and reports
// (which all weight by exchangeRate) pick it up with no further change.
// Balancing is judged on the CONVERTED USD amounts.
// One Posted entry per entity, all sharing the same reference, so the GL,
// COA and entity views pick it up on their next read (nothing is stored).
app.post("/api/journal-entries", (req, res) => {
  const transactionDate = String(req.body?.transactionDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) return res.status(400).json({ error: "A transaction date (YYYY-MM-DD) is required" });
  const reference = String(req.body?.reference ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (lines.length < 2) return res.status(400).json({ error: "A journal entry needs at least two lines" });

  const cents = (n: any) => Math.round((Number(n) || 0) * 100);
  const period = statutoryPeriodOf(transactionDate);
  type PreparedLine = {
    accountId: number; entityId: number; debit: number; credit: number; description: string; account: any;
    contactId: number | null;
    currency: string; exchangeRate: number; rateSource: string; debitUSD: number; creditUSD: number;
  };
  const prepared: PreparedLine[] = [];
  for (const [i, l] of lines.entries()) {
    const lineNo = i + 1;
    const debit = cents(l?.debit);
    const credit = cents(l?.credit);
    if (debit < 0 || credit < 0) return res.status(400).json({ error: `Line ${lineNo}: amounts can't be negative` });
    if (debit === 0 && credit === 0) return res.status(400).json({ error: `Line ${lineNo}: enter a debit or a credit` });
    if (debit > 0 && credit > 0) return res.status(400).json({ error: `Line ${lineNo}: a line is either a debit or a credit, not both` });
    const entityId = Number(l?.entityId);
    if (!Number.isInteger(entityId)) return res.status(400).json({ error: `Line ${lineNo}: pick an entity` });
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(Number(l?.accountId)) as any;
    if (!account) return res.status(400).json({ error: `Line ${lineNo}: pick an account` });
    if (account.isActive === 0) return res.status(400).json({ error: `Line ${lineNo}: account "${account.name}" is inactive` });
    if (account.entityId != null && Number(account.entityId) !== entityId) {
      return res.status(400).json({ error: `Line ${lineNo}: account "${account.code} ${account.name}" belongs to another entity — pick that entity's own or a Shared account` });
    }
    // Currency + rate: what the client sent, else the month's configured
    // rate. A hand-typed rate is honoured (and recorded as an override).
    const currency = String(l?.currency ?? "USD").trim().toUpperCase() || "USD";
    const resolved = resolveExchangeRate(currency, period);
    const suppliedRate = l?.exchangeRate === undefined || l?.exchangeRate === null || l?.exchangeRate === "" ? null : Number(l.exchangeRate);
    if (suppliedRate !== null && (!Number.isFinite(suppliedRate) || suppliedRate <= 0)) {
      return res.status(400).json({ error: `Line ${lineNo}: exchange rate must be greater than 0` });
    }
    if (currency === "USD" && suppliedRate !== null && Math.abs(suppliedRate - 1) > 1e-9) {
      return res.status(400).json({ error: `Line ${lineNo}: USD lines are always rate 1` });
    }
    const exchangeRate = currency === "USD" ? 1 : (suppliedRate ?? resolved.rate);
    if (currency !== "USD" && suppliedRate === null && !resolved.found) {
      return res.status(400).json({ error: `Line ${lineNo}: no ${currency} rate is configured for ${period} — enter one, or add it under Settings → Currency` });
    }
    // Optional Payee / Contact, so a manual entry feeds the customer /
    // vendor sub-ledger exactly like a bank posting does.
    let contact: { id: number; contactType: "Customer" | "Vendor"; name: string } | null = null;
    try {
      contact = resolveContactForEntity(l?.contactId, entityId, `Line ${lineNo} From/To`);
    } catch (err: any) {
      return res.status(hasHttpStatus(err) ? err.status : 400).json({ error: err.message });
    }
    prepared.push({
      accountId: account.id, entityId, debit, credit, description: String(l?.description ?? "").trim(), account,
      contactId: contact?.id ?? null,
      currency, exchangeRate,
      rateSource: currency === "USD" ? "usd" : suppliedRate !== null ? "manual" : resolved.source,
      // Converted at the line's own rate, rounded to the cent — the figure
      // that hits the ledger and every report.
      debitUSD: Math.round(debit * exchangeRate),
      creditUSD: Math.round(credit * exchangeRate),
    });
  }

  const totalDebit = prepared.reduce((s, l) => s + l.debitUSD, 0);
  const totalCredit = prepared.reduce((s, l) => s + l.creditUSD, 0);
  if (totalDebit !== totalCredit) {
    return res.status(400).json({ error: `Converted USD debits (${(totalDebit / 100).toFixed(2)}) and credits (${(totalCredit / 100).toFixed(2)}) must be equal` });
  }

  const entityIds = [...new Set(prepared.map((l) => l.entityId))];
  try {
    for (const entityId of entityIds) {
      assertEntityAccess(req, entityId, "an entity on this entry");
      if (!db.prepare("SELECT id FROM entities WHERE id = ?").get(entityId)) throw new PostingError(400, `Entity ${entityId} does not exist`);
      assertPeriodNotLocked(entityId, transactionDate);
      const own = prepared.filter((l) => l.entityId === entityId);
      const d = own.reduce((s, l) => s + l.debitUSD, 0);
      const c = own.reduce((s, l) => s + l.creditUSD, 0);
      if (d !== c) {
        const name = (db.prepare("SELECT name FROM entities WHERE id = ?").get(entityId) as any)?.name ?? entityId;
        throw new PostingError(
          400,
          `${name}'s lines don't balance in USD (debits ${(d / 100).toFixed(2)} vs credits ${(c / 100).toFixed(2)}). Each entity's own books must balance — use a Due From / To Affiliates line to move value between entities.`,
        );
      }
    }

    const created = db.transaction(() => {
      const entries: any[] = [];
      const batchRef = reference || `Manual JE ${transactionDate}`;
      for (const entityId of entityIds) {
        const own = prepared.filter((x) => x.entityId === entityId);
        const brandId = resolveEntityBrandId(entityId);
        const entryNumber = nextEntryNumber();
        // The entry-level rate is only meaningful when its lines share one
        // currency; a mixed entry records the rate per line instead.
        const currencies = [...new Set(own.map((l) => l.currency))];
        const entryRate = currencies.length === 1 ? own[0].exchangeRate : 1;
        const entryRateSource = currencies.length === 1 ? own[0].rateSource : "per-line";
        const e = db.prepare(
          `INSERT INTO journal_entries (entryNumber, entityId, brandId, transactionDate, postingDate, description, reference, status, source, accountingPeriod, appliedExchangeRate, exchangeRateSource)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', 'ManualJournal', ?, ?, ?)`,
        ).run(
          entryNumber, entityId, brandId, transactionDate, todayIso(),
          description || batchRef, batchRef, period, entryRate, entryRateSource,
        );
        const entryId = Number(e.lastInsertRowid);
        const insertLine = db.prepare(
          `INSERT INTO journal_lines (journalEntryId, accountId, debit, credit, currency, exchangeRate, amountUSD, brandId, memo, contactId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const l of own) {
          // Native amount + its own currency and rate stay on the line for
          // audit; amountUSD is the converted figure the ledger reports on.
          // The line memo stays the LINE's own text — the header memo lives
          // on the entry and read-side views fall back to it.
          insertLine.run(
            entryId, l.accountId, l.debit / 100, l.credit / 100, l.currency, l.exchangeRate,
            (l.debitUSD || l.creditUSD) / 100, brandId, l.description, l.contactId,
          );
        }
        // Posting flips Draft → Posted; the balance trigger re-checks the lines.
        db.prepare("UPDATE journal_entries SET status = 'Posted' WHERE id = ?").run(entryId);
        entries.push(db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(entryId));
      }
      return entries;
    })();

    res.json({ ok: true, journalEntries: created, entryNumbers: created.map((e: any) => e.entryNumber) });
  } catch (err: any) {
    if (hasHttpStatus(err)) return res.status(err.status).json({ error: err.message });
    res.status(400).json({ error: err.message || "Could not post the journal entry" });
  }
});

// Enriches each row with what the Bank Transactions Hub header cards need
// beyond the raw bank_accounts columns, computed at read time (never
// stored) per CLAUDE.md rule 3:
//  - unpostedCount: bank_transactions PENDING for this account
//  - usdBalance: currentBalance converted via the shared exchange_rates
//    table (same latestRateToUsd() every report uses) — null if no
//    balance has been fetched yet, or no rate is configured
//  - displayBalance: the same balance expressed in the caller's requested
//    ?currency (the hub's Global Currency Switcher, 2026-09-11). Derived
//    at read time from the USD base, never stored — the only balance this
//    system persists is the account's own native currentBalance
//    (CLAUDE.md rule 3), and the rate used is whatever is configured for
//    the active month, falling back to the most recent earlier month.
//
// The old `plaidIcon` enrichment was dropped in the 2026-09-11 header
// cleanup: the card no longer renders an institution glyph (it shows a
// "Plaid Live" / "Manual CSV" badge instead), so the subquery had no
// remaining consumer.
app.get("/api/bank-accounts", (req, res) => {
  const { entityId, currency } = req.query as any;
  const displayCurrency = currency || "USD";
  let q = `
    SELECT ba.*,
      (SELECT COUNT(*) FROM bank_transactions bt WHERE bt.bankAccountId = ba.id AND bt.status = 'PENDING') as unpostedCount
    FROM bank_accounts ba WHERE 1=1`;
  const params: any[] = [];
  if (entityId) {
    q += " AND ba.entityId = ?";
    params.push(entityId);
  }
  q += " ORDER BY ba.name";
  const rows = db.prepare(q).all(...params) as any[];
  const today = todayIso();
  const enriched = rows.map((r) => {
    if (r.currentBalance === null || r.currentBalance === undefined) {
      return { ...r, usdBalance: null, usdRateFound: null, displayCurrency, displayBalance: null, displayRateFound: null };
    }
    const { rate, found } = latestRateToUsd(r.currency, today);
    const usdBalance = r.currentBalance * rate;
    // An account already held in the display currency is shown as-is — a
    // native -> USD -> native round trip would only introduce rounding
    // drift against the figure the bank itself reports.
    const display =
      displayCurrency === r.currency
        ? { amount: r.currentBalance, rateFound: true }
        : convertFromUsd(usdBalance, displayCurrency, today);
    return {
      ...r,
      usdBalance,
      usdRateFound: found,
      displayCurrency,
      displayBalance: display.amount,
      // A conversion is only trustworthy if BOTH legs resolved: native ->
      // USD (found) and USD -> display (display.rateFound).
      displayRateFound: displayCurrency === r.currency ? true : found && display.rateFound,
    };
  });
  res.json(enriched.filter((r: any) => canAccessEntity(req, r.entityId)));
});

// First unused code in a numeric band. The chart of accounts reserves
// 1000-1099 for bank/cash heads (Phase 1.1 seeds 1000-100x there), so a
// newly created bank account lands in the same band a bookkeeper would
// expect rather than at some arbitrary number.
function nextAvailableAccountCode(rangeStart: number, rangeEnd: number): string {
  const taken = new Set((db.prepare("SELECT code FROM accounts").all() as { code: string }[]).map((r) => String(r.code).trim()));
  for (let c = rangeStart; c <= rangeEnd; c++) {
    if (!taken.has(String(c))) return String(c);
  }
  throw new Error(`No unused account code left in the ${rangeStart}-${rangeEnd} range — free one up in the Chart of Accounts first`);
}

// Creating a bank account also creates the GL account head that represents
// its cash (2026-09-11, Phase 2 item 4): an Asset account with sub-type
// "Bank" (-> category "Cash & Equivalents" via deriveCategory, the
// load-bearing column that drives cash resolution and cash-flow
// classification), scoped to the same entity, and linked back through
// bank_accounts.glAccountId.
//
// Why this matters beyond tidiness: postBankTransactionToGL resolves a
// bank's cash leg via resolveBankGlAccount(), which without an explicit
// glAccountId falls back to resolveEntityCashAccount() — and that only
// succeeds when the entity has exactly ONE Cash & Equivalents account.
// Binding the head explicitly at creation makes every new bank account
// post correctly regardless of how many cash accounts an entity has.
//
// Nothing about intercompany posting changes here: journal_lines.brandId,
// the per-entity Due From/To Affiliates heads and the split-posting engine
// are untouched — this only fills in a column that already existed.
app.post("/api/bank-accounts", (req, res) => {
  const d = req.body;
  if (!d.name || !d.entityId || !d.bankName) {
    return res.status(400).json({ error: "name, entityId and bankName are required" });
  }
  const connectionType = d.connectionType === "PLAID" ? "PLAID" : "MANUAL_UPLOAD";
  // Defaults to the entity's functional currency rather than USD, so an
  // AED entity's accounts aren't silently created as USD.
  const currency = d.currency || resolveEntityCurrency(d.entityId);

  // One Plaid account backs exactly one feed: a second row would ingest the
  // same transactions twice, into two sets of books (2026-09-18).
  if (d.plaidAccountId) {
    const existingFeed = db.prepare("SELECT id, name FROM bank_accounts WHERE plaidAccountId = ?").get(d.plaidAccountId) as any;
    if (existingFeed) {
      return res.status(409).json({
        error: `That Plaid account is already connected as "${existingFeed.name}" — re-assign that feed instead of linking it twice.`,
        bankAccountId: existingFeed.id,
      });
    }
  }

  const createBankAccount = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO bank_accounts (name, entityId, bankName, accountNumberLast4, currency, connectionType, plaidAccountId, isActive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.name,
        d.entityId,
        d.bankName,
        d.accountNumberLast4 || "",
        currency,
        connectionType,
        d.plaidAccountId || null,
        d.isActive === false ? 0 : 1,
      );
    const bankAccountId = Number(r.lastInsertRowid);

    let glAccountId: number;
    if (d.glAccountId) {
      // Caller pointed at an existing head (e.g. re-linking a bank to a
      // cash account that's already in the books) — use it, don't create
      // a duplicate. It still has to be a bank head this entity can post
      // to, and not already backing another feed, or the cash leg would
      // land in the wrong company's books (2026-09-18).
      const existing = db.prepare("SELECT * FROM accounts WHERE id = ?").get(Number(d.glAccountId)) as any;
      if (!existing) throw new Error(`glAccountId ${d.glAccountId} is not an account in the Chart of Accounts`);
      if (existing.type !== "Asset" || (existing.subType !== "Bank" && existing.category !== "Cash & Equivalents")) {
        throw new Error(`"${existing.code} ${existing.name}" is not a bank / cash head — pick an Asset account with sub-type Bank`);
      }
      if (existing.entityId != null && Number(existing.entityId) !== Number(d.entityId)) {
        throw new Error(`"${existing.code} ${existing.name}" belongs to another entity — pick that entity's own bank head or a Shared one`);
      }
      const takenBy = db.prepare("SELECT name FROM bank_accounts WHERE glAccountId = ?").get(Number(d.glAccountId)) as any;
      if (takenBy) throw new Error(`"${existing.code} ${existing.name}" already backs the bank feed "${takenBy.name}"`);
      glAccountId = Number(d.glAccountId);
    } else {
      const subType = "Bank";
      const ins = db
        .prepare(
          "INSERT INTO accounts (code, category, name, type, description, subType, currency, entityId, isActive) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          nextAvailableAccountCode(1000, 1099),
          deriveCategory(subType),
          `${d.bankName} - ${d.name}`,
          "Asset",
          "",
          subType,
          currency,
          d.entityId,
          1,
        );
      glAccountId = Number(ins.lastInsertRowid);
    }

    db.prepare("UPDATE bank_accounts SET glAccountId = ? WHERE id = ?").run(glAccountId, bankAccountId);
    return bankAccountId;
  });

  try {
    const bankAccountId = createBankAccount();
    res.json(db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bankAccountId));
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to create bank account" });
  }
});

app.put("/api/bank-accounts/:id", (req, res) => {
  const d = req.body;
  const connectionType = d.connectionType === "PLAID" ? "PLAID" : "MANUAL_UPLOAD";
  // Re-assigning a feed to another entity (2026-09-18): allowed only while
  // nothing has been booked from it, because posted lines already sit in the
  // old entity's books and its cash head is tagged to that entity. The head
  // moves with the feed when it is still unused.
  const current = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(req.params.id) as any;
  if (!current) return res.status(404).json({ error: "Bank account not found" });
  const newEntityId = d.entityId === undefined || d.entityId === null ? current.entityId : Number(d.entityId);
  if (Number(newEntityId) !== Number(current.entityId)) {
    try {
      assertEntityAccess(req, current.entityId, "this bank account's entity");
      assertEntityAccess(req, newEntityId, "that entity");
    } catch (err: any) {
      return res.status(err.status || 403).json({ error: err.message });
    }
    const posted = (db.prepare("SELECT COUNT(*) n FROM bank_transactions WHERE bankAccountId = ? AND status = 'POSTED'").get(current.id) as any).n;
    if (posted > 0) {
      return res.status(409).json({
        error: `"${current.name}" has ${posted} posted transaction(s) in its current entity's books, so it can't be moved. Create a new feed for the other entity instead.`,
      });
    }
    if (current.glAccountId) {
      const lines = (db.prepare("SELECT COUNT(*) n FROM journal_lines WHERE accountId = ?").get(current.glAccountId) as any).n;
      if (lines > 0) {
        return res.status(409).json({ error: `This feed's cash account already has ${lines} ledger line(s), so the feed can't change entity.` });
      }
      // An unused head follows the feed, so the two never disagree.
      db.prepare("UPDATE accounts SET entityId = ? WHERE id = ? AND entityId IS NOT NULL").run(newEntityId, current.glAccountId);
    }
  }
  db.prepare(
    `UPDATE bank_accounts SET name=?, entityId=?, bankName=?, accountNumberLast4=?, currency=?, connectionType=?, plaidAccountId=?, isActive=? WHERE id=?`,
  ).run(
    d.name,
    d.entityId,
    d.bankName,
    d.accountNumberLast4 || "",
    d.currency || "USD",
    connectionType,
    d.plaidAccountId || null,
    d.isActive === false ? 0 : 1,
    req.params.id,
  );
  res.json(db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(req.params.id));
});

app.post("/api/bank-accounts/:id/refresh-balance", async (req, res) => {
  const feed = db.prepare("SELECT entityId FROM bank_accounts WHERE id = ?").get(Number(req.params.id)) as { entityId: number } | undefined;
  if (!feed) return res.status(404).json({ error: "Bank account not found" });
  if (!canAccessEntity(req, feed.entityId)) return res.status(403).json({ error: "You don't have access to this bank account's entity" });
  try {
    const updated = await refreshBankAccountBalance(Number(req.params.id));
    const today = todayIso();
    const { rate, found } = latestRateToUsd(updated.currency, today);
    res.json({
      ...updated,
      usdBalance: updated.currentBalance === null ? null : updated.currentBalance * rate,
      usdRateFound: updated.currentBalance === null ? null : found,
    });
  } catch (err: any) {
    res.status(502).json({ error: plaidErrorMessage(err) });
  }
});

app.delete("/api/bank-accounts/:id", (req, res) => {
  db.prepare("DELETE FROM bank_accounts WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ===== COA-DRIVEN BANKING HUB (2026-09-11) =====
//
// The Chart of Accounts is now the single source of truth for WHICH bank
// cards exist. A card is any active Asset head whose sub-type marks it as
// a bank/cash account — create one in the COA and its card appears; make
// it inactive or delete it and the card goes away. "Add Manual Bank" is
// gone, so there is no second, competing place to define a bank.
//
// `bank_accounts` did not go away — it changed job. It is no longer a
// user-facing list, it is the FEED attached to a COA head: Plaid
// credentials, the bank's own reported balance, and the owner of
// bank_transactions rows. It is created lazily (POST /api/banking/feeds)
// the first time a head actually needs one, so a COA bank head that has
// never been used carries no feed row at all.
//
// Nothing downstream changed: bank_transactions still hang off a
// bank_accounts row, and postBankTransactionToGL still resolves the cash
// leg through resolveBankGlAccount() — which now always finds an explicit
// glAccountId, because every feed is created already pointing at its head.
const COA_BANK_HEAD_SQL = `
  SELECT * FROM accounts
  WHERE isActive = 1
    AND type = 'Asset'
    AND (subType IN ('Bank', 'Cash and Cash Equivalents', 'Cash & Equivalents')
         OR category = 'Cash & Equivalents')
  ORDER BY code
`;

app.get("/api/banking/cards", (req, res) => {
  const { currency, entityId } = req.query as any;
  const displayCurrency = currency || "USD";
  const today = todayIso();

  let heads = db.prepare(COA_BANK_HEAD_SQL).all() as any[];
  if (entityId) heads = heads.filter((h) => h.entityId === Number(entityId));
  // Entity isolation: only bank heads of entities this user may see (a
  // Shared bank head has no single owner, so restricted users don't get it).
  heads = heads.filter((h) => canAccessEntity(req, h.entityId));

  const feedByHead = new Map<number, any>();
  for (const f of db.prepare("SELECT * FROM bank_accounts").all() as any[]) {
    if (f.glAccountId) feedByHead.set(f.glAccountId, f);
  }
  // An account's LOCAL currency comes from its entity's functional
  // currency (Settings → Entities), which is where the user actually
  // configures it — e.g. FZCO is an AED entity, so its bank heads are AED
  // accounts. `accounts.currency` is deliberately not used: the COA form
  // has no currency field, so that column is hardcoded 'USD' on every row
  // and would report every account as USD.
  const entityById = new Map<number, any>();
  for (const e of db.prepare("SELECT * FROM entities").all() as any[]) entityById.set(e.id, e);
  const unpostedStmt = db.prepare("SELECT COUNT(*) as n FROM bank_transactions WHERE bankAccountId = ? AND status = 'PENDING'");

  const cards = heads.map((h) => {
    const feed = feedByHead.get(h.id) || null;
    const isPlaid = !!feed && feed.connectionType === "PLAID";

    // The ledger balance is the honest figure for every card: derived from
    // posted journal lines, exactly like the Chart of Accounts Balance
    // column, so the two can never disagree.
    const ledgerUsd = computeGlAccountBalance(h.id, today);
    const ledger = convertFromUsd(ledgerUsd, displayCurrency, today);

    // A Plaid feed additionally knows what the bank itself reports, which
    // is what makes reconciliation meaningful — kept separate from the
    // ledger figure rather than overwriting it.
    let liveBalance: number | null = null;
    let liveBalanceConverted: number | null = null;
    let liveRateFound: boolean | null = null;
    if (feed && feed.currentBalance !== null && feed.currentBalance !== undefined) {
      const { rate, found } = latestRateToUsd(feed.currency, today);
      const usd = feed.currentBalance * rate;
      const conv =
        displayCurrency === feed.currency
          ? { amount: feed.currentBalance, rateFound: true }
          : convertFromUsd(usd, displayCurrency, today);
      liveBalance = feed.currentBalance;
      liveBalanceConverted = conv.amount;
      liveRateFound = displayCurrency === feed.currency ? true : found && conv.rateFound;
    }

    // Local-currency presentation (2026-09-11). The ledger is kept in USD
    // (CLAUDE.md: USD is the functional reporting currency), so the local
    // figure is derived at read time from that USD balance at the active
    // month's rate — never stored. `localRateFound` is false when no rate
    // is configured for the currency, so the UI can say so instead of
    // showing a silently-wrong number.
    const entity = h.entityId ? entityById.get(h.entityId) : null;
    const localCurrency = (entity?.functionalCurrency || "USD").toUpperCase();
    const local =
      localCurrency === "USD"
        ? { amount: ledgerUsd, rateFound: true }
        : convertFromUsd(ledgerUsd, localCurrency, today);
    const { rate: localRate, found: localRateConfigured } = latestRateToUsd(localCurrency, today);

    return {
      accountId: h.id,
      code: h.code,
      name: h.name,
      subType: h.subType,
      currency: localCurrency,
      entityId: h.entityId,
      bankAccountId: feed ? feed.id : null,
      connectionType: isPlaid ? "PLAID" : "MANUAL_UPLOAD",
      unpostedCount: feed ? (unpostedStmt.get(feed.id) as any).n : 0,
      displayCurrency,
      ledgerBalanceUsd: ledgerUsd,
      ledgerBalance: ledger.amount,
      ledgerRateFound: ledger.rateFound,
      // Primary (local) and secondary (USD) figures for the card.
      localCurrency,
      localBalance: local.amount,
      localRateFound: localCurrency === "USD" ? true : localRateConfigured && local.rateFound,
      localRateToUsd: localCurrency === "USD" ? 1 : localRate,
      liveBalance,
      liveBalanceConverted,
      liveRateFound,
    };
  });

  res.json({ currency: displayCurrency, cards });
});

// Find-or-create the feed row backing a COA bank head. Idempotent — safe
// to call before every upload.
//
// An entity is genuinely required and cannot be defaulted: every
// journal_entries row this feed will eventually produce must be booked to
// a legal entity (NOT NULL), so if the COA head isn't entity-scoped the
// caller has to say which entity the statement belongs to. Erroring here
// is better than silently booking someone's statement to the wrong books.
app.post("/api/banking/feeds", (req, res) => {
  const accountId = Number(req.body?.accountId);
  if (!accountId) return res.status(400).json({ error: "accountId is required" });

  const head = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as any;
  if (!head) return res.status(404).json({ error: "Account not found in the Chart of Accounts" });

  const existing = db.prepare("SELECT * FROM bank_accounts WHERE glAccountId = ?").get(accountId) as any;
  if (existing) {
    if (!canAccessEntity(req, existing.entityId)) return res.status(403).json({ error: "You don't have access to this bank account's entity" });
    return res.json(existing);
  }

  const entityId = head.entityId || (req.body?.entityId ? Number(req.body.entityId) : null);
  if (entityId && !canAccessEntity(req, entityId)) {
    return res.status(403).json({ error: "You don't have access to that entity" });
  }
  if (!entityId) {
    return res.status(400).json({
      error: `"${head.name}" isn't scoped to an entity in the Chart of Accounts — choose which entity this statement belongs to.`,
      needsEntity: true,
    });
  }
  if (!db.prepare("SELECT id FROM entities WHERE id = ?").get(entityId)) {
    return res.status(400).json({ error: `Entity ${entityId} does not exist` });
  }

  // The feed's currency is the ENTITY's functional currency, not
  // accounts.currency — that column is hardcoded 'USD' by POST
  // /api/accounts (the COA form has no currency field), so using it
  // labelled an AED entity's bank feed as USD and every statement row
  // imported into it inherited that wrong currency.
  const feedCurrency = resolveEntityCurrency(entityId);
  const r = db
    .prepare(
      `INSERT INTO bank_accounts (name, entityId, bankName, accountNumberLast4, currency, connectionType, plaidAccountId, isActive, glAccountId)
       VALUES (?, ?, ?, '', ?, 'MANUAL_UPLOAD', NULL, 1, ?)`,
    )
    .run(head.name, entityId, head.name, feedCurrency, accountId);

  res.json(db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(r.lastInsertRowid));
});

app.get("/api/bank-transactions", (req, res) => {
  const { bankAccountId, status } = req.query as any;
  let q = "SELECT * FROM bank_transactions WHERE 1=1";
  const params: any[] = [];
  if (bankAccountId) {
    q += " AND bankAccountId = ?";
    params.push(bankAccountId);
  }
  if (status) {
    q += " AND status = ?";
    params.push(status);
  }
  q += " ORDER BY transactionDate DESC, id DESC";
  const visible = visibleEntityIds(req);
  let rows = db.prepare(q).all(...params) as any[];
  if (visible) {
    // A transaction belongs to its bank account's entity.
    const feedEntity = new Map((db.prepare("SELECT id, entityId FROM bank_accounts").all() as any[]).map((f) => [f.id, f.entityId]));
    rows = rows.filter((t) => canAccessEntity(req, feedEntity.get(t.bankAccountId)));
  }
  // Posted rows carry the GL account(s) they were categorized to: the
  // non-bank lines of the paying entity's journal entry (for an
  // intercompany charge that's the "Due From Affiliates — X" line). Derived
  // from the ledger on every read, never stored.
  const posted = rows.filter((t) => t.journalEntryId);
  if (posted.length) {
    const bankAccounts = new Map((db.prepare("SELECT * FROM bank_accounts").all() as any[]).map((b) => [b.id, b]));
    const bankGl = new Map<number, number | null>();
    const bankGlFor = (bankAccountId: number) => {
      if (!bankGl.has(bankAccountId)) {
        let glId: number | null = null;
        try { glId = resolveBankGlAccount(bankAccounts.get(bankAccountId))?.id ?? null; } catch { glId = null; }
        bankGl.set(bankAccountId, glId);
      }
      return bankGl.get(bankAccountId)!;
    };
    const linesOf = db.prepare(
      `SELECT jl.accountId, jl.contactId, a.code, a.name, a.subType FROM journal_lines jl JOIN accounts a ON a.id = jl.accountId
       WHERE jl.journalEntryId = ? ORDER BY jl.id`,
    );
    // From/To and Charged To mirror the two fields a Pending row carries:
    // the contact(s) tagged on the posted lines, and the entity that
    // actually bears the cost — which for an intercompany charge is not the
    // entity that paid. A cross-entity post writes one entry per entity
    // under a shared [SPLIT-BT…] tag, so both are read across that batch.
    const entryOf = db.prepare("SELECT id, entityId, reference, chargedToEntityId FROM journal_entries WHERE id = ?");
    const batchEntriesOf = db.prepare("SELECT id, entityId FROM journal_entries WHERE reference LIKE ?");
    const contactOf = db.prepare("SELECT id, name, contactType FROM contacts WHERE id = ?");
    const entityNames = new Map((db.prepare("SELECT id, name FROM entities").all() as any[]).map((e) => [e.id, e.name]));
    const contactCache = new Map<number, any>();
    const contactById = (id: number) => {
      if (!contactCache.has(id)) contactCache.set(id, contactOf.get(id) ?? null);
      return contactCache.get(id);
    };

    for (const t of posted) {
      const glId = bankGlFor(t.bankAccountId);
      const seen = new Set<number>();
      const payingLines = linesOf.all(t.journalEntryId) as any[];
      t.categoryAccounts = payingLines
        .filter((l) => l.accountId !== glId && !seen.has(l.accountId) && seen.add(l.accountId))
        .map((l) => ({ accountId: l.accountId, code: l.code, name: l.name }));

      t.contacts = [];
      t.chargedToEntities = [];
      const entry = entryOf.get(t.journalEntryId) as any;
      if (!entry) continue;
      const batchTag = String(entry.reference || "").match(/\[(SPLIT-BT\d+-\d+)\]/)?.[1] || null;
      const entries = batchTag ? (batchEntriesOf.all(`%[${batchTag}]%`) as any[]) : [entry];
      const contactIds = new Set<number>();
      const chargedIds = new Set<number>();
      for (const e of entries) {
        const lines = e.id === t.journalEntryId ? payingLines : (linesOf.all(e.id) as any[]);
        let bearsCost = false;
        for (const l of lines) {
          if (l.contactId) contactIds.add(l.contactId);
          // Cash and intercompany clearing legs are plumbing, not the cost.
          if (l.accountId !== glId && l.subType !== "Intercompany Clearing") bearsCost = true;
        }
        if (bearsCost) chargedIds.add(e.entityId);
      }
      if (!chargedIds.size) chargedIds.add(entry.chargedToEntityId ?? entry.entityId);
      t.contacts = [...contactIds]
        .map((id) => contactById(id))
        .filter(Boolean)
        .map((c: any) => ({ id: c.id, name: c.name, contactType: c.contactType }));
      t.chargedToEntities = [...chargedIds].map((id) => ({ entityId: id, name: entityNames.get(id) || `Entity ${id}` }));
    }
  }
  res.json(rows);
});

// Entity of a bank transaction = its bank account's entity. Throws 404/403.
function assertBankTransactionAccess(req: express.Request, bankTransactionId: number): void {
  const row = db.prepare("SELECT ba.entityId FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bankAccountId WHERE bt.id = ?")
    .get(bankTransactionId) as { entityId: number } | undefined;
  if (!row) throw new PostingError(404, "Bank transaction not found");
  assertEntityAccess(req, row.entityId, "this bank transaction's entity");
}

app.patch("/api/bank-transactions/:id/status", (req, res) => {
  const status = req.body?.status;
  if (!["PENDING", "POSTED", "IGNORED"].includes(status)) {
    return res.status(400).json({ error: "status must be PENDING, POSTED or IGNORED" });
  }
  assertBankTransactionAccess(req, Number(req.params.id));
  db.prepare("UPDATE bank_transactions SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json(db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(req.params.id));
});

app.post("/api/bank-transactions/import", bankTransactionImportUpload.single("statement"), (req, res) => {
  try {
    const bankAccountId = Number(req.body.bankAccountId);
    if (!bankAccountId) return res.status(400).json({ error: "bankAccountId is required" });
    const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bankAccountId) as any;
    if (!bankAccount) return res.status(404).json({ error: "Bank account not found" });
    if (!canAccessEntity(req, bankAccount.entityId)) return res.status(403).json({ error: "You don't have access to this bank account's entity" });
    if (!req.file) return res.status(400).json({ error: 'No statement file uploaded (field name: "statement")' });

    let mapping: ColumnMapping | undefined;
    if (req.body.columnMapping) {
      try {
        mapping = JSON.parse(req.body.columnMapping);
      } catch {
        return res.status(400).json({ error: "columnMapping must be valid JSON" });
      }
    }

    const { format, transactions, detectedMapping } = parseStatementFile(req.file.originalname, req.file.buffer, mapping);

    let inserted = 0;
    let duplicatesSkipped = 0;
    const errors: { row: number; reason: string }[] = [];
    transactions.forEach((t, idx) => {
      if (!t.transactionDate || !t.description) {
        errors.push({ row: idx + 1, reason: "Missing date or description" });
        return;
      }
      const result = ingestBankTransaction({
        bankAccountId,
        transactionDate: t.transactionDate,
        description: t.description,
        rawText: t.rawText,
        amount: t.amount,
        currency: bankAccount.currency || "USD",
      });
      if (result.inserted) inserted += 1;
      else duplicatesSkipped += 1;
    });

    res.json({ format, totalRows: transactions.length, inserted, duplicatesSkipped, errors, detectedMapping });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to parse statement" });
  }
});

app.post("/api/bank-transactions/plaid-sync", async (req, res) => {
  const bankAccountId = Number(req.body.bankAccountId);
  if (!bankAccountId) return res.status(400).json({ error: "bankAccountId is required" });
  try {
    const result = await syncPlaidBankAccount(bankAccountId);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: plaidErrorMessage(err) });
  }
});

// ======= AUTO-CATEGORIZATION ENGINE (Phase 1.3) =======
// Rules are evaluated in priority order (lower number = evaluated first —
// i.e. higher priority), then by id as a stable tiebreak; the first rule
// whose pattern matches the transaction's description wins. Never throws on
// a malformed regex rule — a bad rule should degrade to "no suggestion for
// this row", not break the entire unposted-transactions list.
function matchesRule(description: string, rule: any): boolean {
  const desc = description || "";
  if (rule.matchType === "REGEX") {
    try {
      return new RegExp(rule.matchPattern, "i").test(desc);
    } catch {
      return false;
    }
  }
  return desc.toLowerCase().includes(String(rule.matchPattern || "").toLowerCase());
}

function findMatchingRule(bankTransaction: any): any {
  const rules = db
    .prepare("SELECT * FROM categorization_rules WHERE isActive = 1 ORDER BY priority ASC, id ASC")
    .all() as any[];
  return rules.find((rule) => matchesRule(bankTransaction.description, rule)) || null;
}

function suggestCategorization(bankTransaction: any): {
  ruleId: number;
  matchPattern: string;
  matchType: string;
  suggestedAccountId: number;
  suggestedBrandId: number | null;
  suggestedEntityId: number;
} | null {
  const rule = findMatchingRule(bankTransaction);
  if (!rule) return null;
  return {
    ruleId: rule.id,
    matchPattern: rule.matchPattern,
    matchType: rule.matchType,
    suggestedAccountId: rule.targetAccountId,
    suggestedBrandId: rule.targetBrandId ?? null,
    suggestedEntityId: rule.targetEntityId,
  };
}

// ======= DOUBLE-ENTRY POSTING ENGINE (Phase 1.3) =======

class PostingError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Errors that carry their own HTTP status: posting-engine errors and
// access-control refusals (AccessError from ./auth, e.g. entity access).
function hasHttpStatus(err: unknown): err is { status: number; message: string } {
  return err instanceof PostingError || err instanceof AccessError;
}

// Period Lock Enforcement (Phase 1.5, task item 3). Called explicitly at the
// top of every function that creates or reverses a journal entry —
// postBankTransactionToGL, createBill/applyPaymentToBill/voidBill,
// createInvoice/applyPaymentToInvoice/voidInvoice, and
// settleIntercompanyRecharge (checked for BOTH entities there, since it
// posts to two sets of books). Deliberately NOT hidden inside a single
// shared helper like createDraftJournalEntry: an explicit call at the start
// of each entry point is easier to audit (nothing can skip the gate by
// constructing a journal entry a slightly different way) and makes the rule
// visible wherever it applies, at the cost of a few repeated lines — worth
// it for something that guards a compliance/closed-books invariant.
function assertPeriodNotLocked(entityId: number, date: string) {
  const periodMonth = String(date).slice(0, 7);
  const period = db.prepare("SELECT * FROM accounting_periods WHERE entityId = ? AND periodMonth = ?").get(entityId, periodMonth) as
    | { isLocked: number }
    | undefined;
  if (period && period.isLocked) {
    throw new PostingError(423, `Accounting period ${periodMonth} for entity ${entityId} is locked — no new, updated, or voided journal entries are allowed`);
  }
}

// Sequential, human-readable entry numbers (JE-<year>-<seq>). Safe without
// extra locking: better-sqlite3 is synchronous and every route handler here
// runs to completion (no `await` in the critical section) before the next
// request is processed, so there is no interleaving window between the
// read and the INSERT.
//
// Uses MAX(seq)+1, not COUNT+1 (2026-09-11 fix). COUNT collided as soon as
// any entry was deleted: with entries 000001-000003 and 000001 removed,
// COUNT is 2 and the "next" number is 000003 — which already exists, so
// the INSERT died on `UNIQUE constraint failed: journal_entries.entryNumber`.
// That became reachable the moment Unpost started deleting entries.
// MAX never reissues a number, which is also the correct behaviour for an
// audit trail: a voided entry's number should stay retired, not get
// silently reused by a different transaction.
function nextEntryNumber(): string {
  const year = new Date().getFullYear();
  const prefix = `JE-${year}-`;
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(substr(entryNumber, ?) AS INTEGER)), 0) AS maxSeq
       FROM journal_entries WHERE entryNumber LIKE ?`,
    )
    .get(prefix.length + 1, `${prefix}%`) as { maxSeq: number };
  return `${prefix}${String((row.maxSeq || 0) + 1).padStart(6, "0")}`;
}

// USD conversion follows the same rule as the legacy model (CLAUDE.md
// "Money": rates are keyed by (currency, effectiveMonth), never re-derived
// from today's rate). Unlike the legacy revenue/expense endpoints — which
// only ever use whatever exchangeRate the client posts — this actually looks
// the rate up, since Phase 1.1's exchange_rates table exists to be used by
// something. Falls back to 1 (with the caller told so) if no rate is
// configured for that currency/month yet, rather than silently posting a
// wrong USD figure.
// Posting-time rate for a currency in a given month (YYYY-MM).
//
// Exact month first, then the most recent EARLIER month that has one —
// the same fallback the reports use via latestRateToUsd, so a statement
// imported before that month's rate was entered still posts at a sane
// historical rate instead of silently at 1:1. Never looks forward: a
// future rate must not be applied to a past transaction (CLAUDE.md Money).
//
// `found: false` now means "no rate exists for this currency at or before
// this month" — the caller must refuse to post rather than book a foreign
// amount as though it were USD (see postBankTransactionToGL). Before this,
// an AED transaction in a month with no rate was booked at rate 1, which
// recorded AED 22,000 as USD 22,000.
type RateSource = "exact" | "earlier" | "later" | "parity";
type ResolvedRate = { rate: number; found: boolean; source: RateSource; effectiveMonth?: string };

// Posting never blocks on a missing rate (2026-09-11). The chain, in
// descending order of how defensible the number is:
//
//   exact   — a rate configured for this very month. Correct.
//   earlier — the most recent PRIOR month. Standard accounting practice:
//             the last rate actually in force before the transaction.
//   later   — the earliest FUTURE month, used only when nothing earlier
//             exists. Pricing a past transaction with a later rate is a
//             compromise (CLAUDE.md: never re-derive historical amounts
//             from today's rate), accepted here so a user whose only rate
//             is September isn't blocked from posting May — but recorded
//             as such so it can be found and corrected.
//   parity  — 1.0, only when the currency has NO rates at all. For a
//             FOREIGN currency this is a knowingly wrong number: AED
//             22,000 books as USD 22,000. It is allowed because being
//             unable to post at all is worse, but it is flagged loudly
//             and stamped on the entry so every affected row is findable.
//
// `source` is persisted on the journal entry precisely so "which of these
// happened" is answerable months later, rather than being a toast the user
// dismissed and forgot.
function resolveExchangeRate(currency: string, month: string): ResolvedRate {
  if (currency === "USD") return { rate: 1, found: true, source: "exact", effectiveMonth: month };

  const exact = db
    .prepare("SELECT rateToUsd, effectiveMonth FROM exchange_rates WHERE currency = ? AND effectiveMonth = ?")
    .get(currency, month) as { rateToUsd: number; effectiveMonth: string } | undefined;
  if (exact) return { rate: exact.rateToUsd, found: true, source: "exact", effectiveMonth: exact.effectiveMonth };

  const earlier = db
    .prepare(
      "SELECT rateToUsd, effectiveMonth FROM exchange_rates WHERE currency = ? AND effectiveMonth < ? ORDER BY effectiveMonth DESC LIMIT 1",
    )
    .get(currency, month) as { rateToUsd: number; effectiveMonth: string } | undefined;
  if (earlier) return { rate: earlier.rateToUsd, found: true, source: "earlier", effectiveMonth: earlier.effectiveMonth };

  const later = db
    .prepare(
      "SELECT rateToUsd, effectiveMonth FROM exchange_rates WHERE currency = ? AND effectiveMonth > ? ORDER BY effectiveMonth ASC LIMIT 1",
    )
    .get(currency, month) as { rateToUsd: number; effectiveMonth: string } | undefined;
  if (later) return { rate: later.rateToUsd, found: true, source: "later", effectiveMonth: later.effectiveMonth };

  return { rate: 1, found: false, source: "parity" };
}

// Human-readable note for the UI when a rate other than an exact monthly
// match was used. null when the number is fully trustworthy.
function rateWarning(currency: string, month: string, r: ResolvedRate): string | null {
  if (currency === "USD" || r.source === "exact") return null;
  if (r.source === "earlier") {
    return `No ${currency} rate for ${month} — used the ${r.effectiveMonth} rate (${r.rate}).`;
  }
  if (r.source === "later") {
    return `No ${currency} rate for ${month} or earlier — used the later ${r.effectiveMonth} rate (${r.rate}). Add a rate for ${month} and re-post for an accurate figure.`;
  }
  return `No ${currency} exchange rate exists at all — posted at 1:1 parity, so the USD figure is NOT accurate. Add a ${currency} rate under Settings → Currency and re-post this transaction.`;
}

// An entity's single seeded "Cash & Equivalents" account (Phase 1.1 seeds
// exactly one per entity). Returns null — never guesses — if that's not
// unique for the entity. Shared by resolveBankGlAccount below and by the
// Phase 1.4 intercompany settlement logic, which needs a source entity's
// cash account without necessarily having a specific bank_accounts row.
function resolveEntityCashAccount(entityId: number): any {
  const candidates = db
    .prepare("SELECT * FROM accounts WHERE entityId = ? AND category = 'Cash & Equivalents' AND isActive = 1")
    .all(entityId) as any[];
  return candidates.length === 1 ? candidates[0] : null;
}

// Brand / Entity unification (2026-09-11).
//
// These are two names for one real-world thing here: every entity is
// created with exactly one same-named brand (see POST /api/entities), and
// the UI now presents a single "Entity" concept. The `brands` table and
// `journal_lines.brandId` are KEPT rather than collapsed into `entities`,
// because brandId is the grain the cross-brand split-posting engine works
// on — it is what lets one bank transaction be shared across several
// brands, which is the whole point of postBankTransactionToGLSplit and the
// Due From/To Affiliates machinery. Repointing brandId at entities(id)
// would permanently remove that capability to delete a column that costs
// nothing.
//
// What IS enforced is that the two can never disagree: a line's brand is
// derived from its entry's entity unless a caller deliberately supplies a
// brand that belongs to that same entity.
// An entity's functional currency is the single source of truth for what
// currency its bank accounts and their statement rows are denominated in.
// (`accounts.currency` is not usable for this — POST /api/accounts
// hardcodes 'USD' because the COA form has no currency field.)
function resolveEntityCurrency(entityId: number | null | undefined): string {
  if (!entityId) return "USD";
  const row = db.prepare("SELECT functionalCurrency FROM entities WHERE id = ?").get(entityId) as
    | { functionalCurrency: string }
    | undefined;
  return (row?.functionalCurrency || "USD").toUpperCase();
}

function resolveEntityBrandId(entityId: number): number | null {
  const row = db
    .prepare("SELECT id FROM brands WHERE entityId = ? AND isActive = 1 ORDER BY id LIMIT 1")
    .get(entityId) as { id: number } | undefined;
  return row ? row.id : null;
}

function brandBelongsToEntity(brandId: number, entityId: number): boolean {
  const row = db.prepare("SELECT entityId FROM brands WHERE id = ?").get(brandId) as { entityId: number } | undefined;
  return !!row && Number(row.entityId) === Number(entityId);
}

// Resolves the Asset GL account that represents a bank_account's cash
// balance: an explicit bank_accounts.glAccountId if set, otherwise the
// entity's single "Cash & Equivalents" account.
function resolveBankGlAccount(bankAccount: any): any {
  if (bankAccount.glAccountId) {
    const explicit = db.prepare("SELECT * FROM accounts WHERE id = ?").get(bankAccount.glAccountId);
    if (explicit) return explicit;
  }
  return resolveEntityCashAccount(bankAccount.entityId);
}

type PostDetails = {
  accountId?: number;
  entityId?: number;
  brandId?: number | null;
  postingDate?: string;
  description?: string;
  reference?: string;
  /** Who bears the cost. Defaults to the bank account's own entity. */
  chargedToEntityId?: number | null;
  /** Optional Payee / Contact (Customer or Vendor) tagged on the target line. */
  contactId?: number | null;
  /**
   * Ignored since 2026-09-16 — the statutory period is always the
   * transaction date's month (see statutoryPeriodOf). Kept on the type so
   * older clients that still send it don't break.
   */
  accountingPeriod?: string | null;
};

// Resolves an optional Payee / Contact for a posting line (2026-09-16).
// The contact is recorded in the ledger of the entity whose line it tags,
// so it must be that entity's own contact or a Shared one, and active.
// Either type may be used in either direction — a vendor refund is money
// in from a Vendor — the UI merely lists the usual type first.
function resolveContactForEntity(rawContactId: any, entityId: number, lineLabel = "From/To"):{ id: number; contactType: "Customer" | "Vendor"; name: string } | null {
  if (rawContactId === undefined || rawContactId === null || rawContactId === "" || rawContactId === "none") return null;
  const id = Number(rawContactId);
  if (!Number.isInteger(id) || id <= 0) throw new PostingError(400, `${lineLabel}: invalid contact id "${rawContactId}"`);
  const contact = db.prepare("SELECT id, name, contactType, entityId, isActive FROM contacts WHERE id = ?").get(id) as any;
  if (!contact) throw new PostingError(400, `${lineLabel}: contact ${id} does not exist`);
  if (contact.isActive === 0) throw new PostingError(400, `${lineLabel}: ${contact.contactType} "${contact.name}" is inactive`);
  if (contact.entityId !== null && Number(contact.entityId) !== Number(entityId)) {
    throw new PostingError(400, `${lineLabel}: ${contact.contactType} "${contact.name}" belongs to a different entity than the one this line is booked in`);
  }
  return { id: contact.id, contactType: contact.contactType, name: contact.name };
}

// Statutory period (2026-09-16): a bank transaction belongs to the month
// its transaction date falls in — full stop. The user-chosen "accounting
// month" picker was a management-reporting device (shift a cost into the
// service month) and has been removed from posting; any caller-supplied
// period is ignored rather than trusted. Dates are ISO by the time they
// reach here (normalizeDateString), so the first 7 chars are YYYY-MM.
// "Today" in the server's own timezone (2026-09-18). `toISOString()` is UTC,
// so anywhere east of it — the books are kept in PKT/GST — every default
// as-of date and posting date ran a day behind local midnight, which hid a
// transaction dated today from the Chart of Accounts balances until UTC
// caught up. Dates in this system are plain YYYY-MM-DD calendar days.
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function statutoryPeriodOf(transactionDate: string): string {
  return String(transactionDate).slice(0, 7);
}

// The posting engine. Turns one PENDING bank_transactions row into a
// balanced, Posted journal_entries row with exactly two journal_lines — the
// target account (Expense/Revenue/Asset/etc, whichever the caller or a
// matched categorization rule points at) and the bank's own cash account,
// as the balancing offset. Everything happens inside one db.transaction()
// so a failure at any step (including the Phase 1.1 balance trigger, which
// this can never actually trip given how the two lines are built, but it's
// still the enforced backstop) leaves the bank transaction untouched at
// PENDING rather than partially posted.
//
// Sign convention: bank_transactions.amount is positive=credit (money in),
// negative=debit (money out) — see Phase 1.2. Money in means the bank
// account (an Asset) is debited and the target account (typically Revenue)
// is credited; money out means the target account (typically Expense) is
// debited and the bank account is credited. Standard double-entry for a
// cash transaction.
//
// Scope boundary (documented, not silently assumed): both lines are posted
// in the bank transaction's own currency with one shared exchange rate — a
// single-currency cash transaction being categorized, not a cross-currency
// transfer where the target account's currency differs from the bank's.
// That case is out of scope for this phase.
function postBankTransactionToGL(bankTransactionId: number, postDetails: PostDetails) {
  const bt = db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(bankTransactionId) as any;
  if (!bt) throw new PostingError(404, "Bank transaction not found");
  if (bt.status !== "PENDING") {
    throw new PostingError(409, `Bank transaction is ${bt.status}, not PENDING — it cannot be posted again`);
  }
  if (bt.journalEntryId) {
    throw new PostingError(409, "This bank transaction is already linked to a journal entry");
  }

  const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bt.bankAccountId) as any;
  if (!bankAccount) throw new PostingError(400, "The bank_accounts row for this transaction no longer exists");

  // Charged to a DIFFERENT entity than the one that paid? That is exactly
  // the cross-entity case the split engine already handles — one entity's
  // cash settling another's cost, raising the Due From/To Affiliates pair.
  // Delegate to it with a single 100% line rather than duplicating that
  // logic here; the accounting period rides along as a single-month
  // allocation so management reports bucket it correctly.
  const chargedTo = normalizeEntityId(postDetails.chargedToEntityId);
  if (chargedTo && Number(chargedTo) !== Number(bankAccount.entityId)) {
    if (!db.prepare("SELECT id FROM entities WHERE id = ?").get(chargedTo)) {
      throw new PostingError(400, `Charged-to entity ${chargedTo} does not exist`);
    }
    const accountIdForSplit = postDetails.accountId;
    if (!accountIdForSplit) {
      throw new PostingError(400, "accountId is required when charging a transaction to another entity");
    }
    // One 100% line charged to the other entity. No management
    // amortization window: the statutory period is the transaction month.
    return postBankTransactionToGLSplit(bankTransactionId, {
      splits: [{
        accountId: accountIdForSplit,
        entityId: chargedTo,
        percentage: 100,
        contactId: postDetails.contactId ?? null,
      }],
      postingDate: postDetails.postingDate,
      description: postDetails.description,
      reference: postDetails.reference,
      chargedToEntityId: chargedTo,
    });
  }

  // Resolve the target account: explicit accountId wins; otherwise fall back
  // to a matching categorization rule so a 1-click bulk-post of matched rows
  // can omit accountId entirely.
  let accountId = postDetails.accountId;
  let brandId = postDetails.brandId ?? null;
  let ruleEntityId: number | undefined;
  if (!accountId) {
    const suggestion = suggestCategorization(bt);
    if (!suggestion) {
      throw new PostingError(400, "accountId is required (no matching categorization rule found to auto-assign one)");
    }
    accountId = suggestion.suggestedAccountId;
    if (brandId === null) brandId = suggestion.suggestedBrandId;
    ruleEntityId = suggestion.suggestedEntityId;
  }

  const targetAccount = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as any;
  if (!targetAccount) throw new PostingError(400, `accountId ${accountId} does not exist in the chart of accounts`);
  if (targetAccount.isActive === 0) {
    throw new PostingError(400, `Account "${targetAccount.code} ${targetAccount.name}" is inactive — reactivate it in the Chart of Accounts or pick another account`);
  }

  const bankGlAccount = resolveBankGlAccount(bankAccount);
  if (!bankGlAccount) {
    throw new PostingError(
      400,
      `No GL cash account is linked to bank account "${bankAccount.name}" — set bank_accounts.glAccountId, or ` +
        `configure exactly one active "Cash & Equivalents" account for entity ${bankAccount.entityId}`,
    );
  }

  // The bank account's own entity always wins (2026-09-11). A bank account
  // belongs to exactly one set of books, so letting a caller post its
  // transactions into a different entity could only ever be a mistake —
  // and it was the source of Bank Card / feed mismatches.
  const entityId = bankAccount.entityId || postDetails.entityId || ruleEntityId;
  if (!entityId) throw new PostingError(400, "entityId is required and could not be resolved");
  if (postDetails.entityId && Number(postDetails.entityId) !== Number(entityId)) {
    throw new PostingError(
      400,
      `This transaction belongs to bank account "${bankAccount.name}", which is owned by entity ${entityId}. ` +
        `It cannot be posted to entity ${postDetails.entityId}.`,
    );
  }
  assertPeriodNotLocked(entityId, bt.transactionDate);
  // Same statutory rule as split lines: the target head must be this
  // entity's own account or a Shared one, never another entity's.
  if (targetAccount.entityId != null && Number(targetAccount.entityId) !== Number(entityId)) {
    throw new PostingError(
      400,
      `Account "${targetAccount.code} ${targetAccount.name}" belongs to a different entity — pick one of this entity's own or a Shared account, or set Charged To`,
    );
  }

  // Brand and Entity are the same real-world thing in this system (one
  // brand per entity, same name — see resolveEntityBrandId). Rather than
  // asking for both and risking a line whose brand disagrees with its
  // entry's entity, an unspecified brand is derived from the entity.
  if (brandId === null) brandId = resolveEntityBrandId(entityId);
  else if (!brandBelongsToEntity(brandId, entityId)) {
    throw new PostingError(400, `Brand ${brandId} does not belong to entity ${entityId}`);
  }

  const amount = Number(bt.amount) || 0;
  const amountAbs = Math.abs(amount);
  if (amountAbs < 0.000001) throw new PostingError(400, "Cannot post a zero-amount transaction");

  const currency = bt.currency || bankAccount.currency || "USD";
  // Same-entity path: the charged-to entity IS the paying entity, and the
  // period is the month the money actually moved.
  const accountingPeriod = statutoryPeriodOf(bt.transactionDate);
  // Rate is looked up against the transaction month.
  const lookupPeriod = accountingPeriod;
  // Never blocks: resolveExchangeRate always yields a usable rate, and
  // reports how defensible it is. The caller surfaces `rateWarningMessage`
  // and the entry itself records `exchangeRateSource` for later audit.
  const resolvedRate = resolveExchangeRate(currency, lookupPeriod);
  const exchangeRate = resolvedRate.rate;
  const rateWarningMessage = rateWarning(currency, lookupPeriod, resolvedRate);

  const postingDate = postDetails.postingDate || todayIso();
  const description = postDetails.description || bt.description;
  const reference = postDetails.reference || `bank_transactions#${bt.id}`;
  // Payee / Contact tags the TARGET line only — the bank (cash) line is the
  // entity's own money, not a counterparty balance.
  const contact = resolveContactForEntity(postDetails.contactId, entityId);

  // amount > 0 (credit/money in): Debit bank (asset ↑), Credit target (e.g. revenue ↑)
  // amount < 0 (debit/money out): Debit target (e.g. expense ↑), Credit bank (asset ↓)
  const targetLine = amount > 0 ? { debit: 0, credit: amountAbs } : { debit: amountAbs, credit: 0 };
  const bankLine = amount > 0 ? { debit: amountAbs, credit: 0 } : { debit: 0, credit: amountAbs };

  const run = db.transaction(() => {
    const entryNumber = nextEntryNumber();
    const entryResult = db
      .prepare(
        `INSERT INTO journal_entries (entryNumber, entityId, brandId, transactionDate, postingDate, description, reference, status, source, chargedToEntityId, accountingPeriod, appliedExchangeRate, exchangeRateSource, contactId, contactType)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', 'BankFeed', ?, ?, ?, ?, ?, ?)`,
      )
      .run(entryNumber, entityId, brandId, bt.transactionDate, postingDate, description, reference, entityId, accountingPeriod, exchangeRate, resolvedRate.source, contact?.id ?? null, contact?.contactType ?? null);
    const journalEntryId = Number(entryResult.lastInsertRowid);

    const insertLine = db.prepare(
      `INSERT INTO journal_lines (journalEntryId, accountId, debit, credit, currency, exchangeRate, amountUSD, brandId, memo, contactId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertLine.run(
      journalEntryId, targetAccount.id, targetLine.debit, targetLine.credit,
      currency, exchangeRate, (targetLine.debit || targetLine.credit) * exchangeRate,
      brandId, description, contact?.id ?? null,
    );
    insertLine.run(
      journalEntryId, bankGlAccount.id, bankLine.debit, bankLine.credit,
      currency, exchangeRate, (bankLine.debit || bankLine.credit) * exchangeRate,
      brandId, `Bank: ${bankAccount.name}`, null,
    );

    // Flip Draft → Posted. The Phase 1.1 trigger re-checks Σdebit=Σcredit
    // here — belt and suspenders, since the two lines above are constructed
    // to already balance by definition.
    db.prepare("UPDATE journal_entries SET status = 'Posted' WHERE id = ?").run(journalEntryId);
    db.prepare("UPDATE bank_transactions SET status = 'POSTED', journalEntryId = ? WHERE id = ?").run(journalEntryId, bt.id);

    return journalEntryId;
  });

  const journalEntryId = run();
  return {
    exchangeRateFound: resolvedRate.found,
    appliedExchangeRate: exchangeRate,
    exchangeRateSource: resolvedRate.source,
    exchangeRateEffectiveMonth: resolvedRate.effectiveMonth ?? null,
    // Non-blocking: present when the rate used was anything other than an
    // exact monthly match, so the UI can warn without refusing the post.
    rateWarning: rateWarningMessage,
    journalEntry: db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(journalEntryId),
    journalLines: db.prepare("SELECT * FROM journal_lines WHERE journalEntryId = ?").all(journalEntryId),
    bankTransaction: db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(bt.id),
  };
}

function monthRange(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  let [y, m] = startMonth.split("-").map(Number);
  const [endY, endM] = endMonth.split("-").map(Number);
  let guard = 0;
  while ((y < endY || (y === endY && m <= endM)) && guard < 120) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    guard += 1;
  }
  return months;
}

function entityCashAccountOrThrow(entityId: number, entityName: string): any {
  const acc = resolveEntityCashAccount(entityId);
  if (!acc) throw new PostingError(500, `No unique Cash & Equivalents account configured for entity "${entityName}"`);
  return acc;
}

// The clearing account in OWNER's books for its position with COUNTERPARTY.
// Direction is decided by the caller from the cash flow (see the split
// engine): Due From = receivable from the counterparty, Due To = payable.
// Self-heals: a missing pair (e.g. an entity created before this feature,
// or a clearing account deleted from the COA) is provisioned on the spot
// inside the posting transaction rather than failing the post.
function intercompanyClearingAccount(ownerEntityId: number, direction: "DueFrom" | "DueTo", counterpartyEntityId: number): any {
  const type = direction === "DueFrom" ? "Asset" : "Liability";
  const find = () => db
    .prepare("SELECT * FROM accounts WHERE entityId = ? AND counterpartyEntityId = ? AND type = ? AND subType = 'Intercompany Clearing' ORDER BY isActive DESC, id LIMIT 1")
    .get(ownerEntityId, counterpartyEntityId, type) as any;
  let acc = find();
  if (!acc) {
    ensureIntercompanyPair(ownerEntityId, counterpartyEntityId);
    acc = find();
  }
  if (!acc) {
    throw new PostingError(500, `Could not provision the ${direction === "DueFrom" ? "Due From" : "Due To"} Affiliates account for entity ${ownerEntityId} ↔ ${counterpartyEntityId}`);
  }
  if (acc.isActive === 0) {
    throw new PostingError(400, `Intercompany account "${acc.code} ${acc.name}" is inactive — reactivate it in the Chart of Accounts before posting between these entities`);
  }
  return acc;
}

type CrossBrandSplitLine = {
  accountId: number;
  /** Optional Payee / Contact for this line, validated against the line's entity. */
  contactId?: number | null;
  /** Charged-to entity for this line. Preferred over brandId (brand is derived). */
  entityId?: number;
  brandId?: number;
  percentage?: number;
  amount?: number;
  effectiveStartMonth?: string; // YYYY-MM — if set together with effectiveEndMonth, this line's
  effectiveEndMonth?: string;   // USD amount is spread evenly across the month range for management reports
};

type CrossBrandSplitDetails = {
  splits: CrossBrandSplitLine[];
  postingDate?: string;
  description?: string;
  reference?: string;
  accountingPeriod?: string | null;
  chargedToEntityId?: number | null;
};

// Multi-brand % / $ split posting with automatic cross-entity dual entries
// (2026-09-10 "Advanced Posting Engine" task item 2). One bank transaction
// still produces exactly one balanced journal_entries row per entity
// touched — never a partial or unbalanced entry — but now potentially more
// than one entity when a split brand belongs to an entity other than the
// bank account's own:
//   Paying entity:  Credit Cash | Debit target account (same-entity splits)
//                                | Debit "Due From Affiliates" (cross-entity splits, one line per foreign entity)
//   Foreign entity: Debit target account | Credit "Due To Affiliates"
// Both legs of a cross-entity pair always use the identical computed dollar
// amount, so each entity's own entry balances AND the pair nets to zero by
// construction — nothing here needs a reconciling "plug".
function postBankTransactionToGLSplit(bankTransactionId: number, details: CrossBrandSplitDetails) {
  const bt = db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(bankTransactionId) as any;
  if (!bt) throw new PostingError(404, "Bank transaction not found");
  if (bt.status !== "PENDING") {
    throw new PostingError(409, `Bank transaction is ${bt.status}, not PENDING — it cannot be posted again`);
  }
  if (bt.journalEntryId) {
    throw new PostingError(409, "This bank transaction is already linked to a journal entry");
  }
  if (!Array.isArray(details.splits) || details.splits.length === 0) {
    throw new PostingError(400, "At least one split line is required");
  }

  const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bt.bankAccountId) as any;
  if (!bankAccount) throw new PostingError(400, "The bank_accounts row for this transaction no longer exists");
  const bankGlAccount = resolveBankGlAccount(bankAccount);
  if (!bankGlAccount) {
    throw new PostingError(400, `No GL cash account is linked to bank account "${bankAccount.name}"`);
  }
  const payingEntityId: number = bankAccount.entityId;
  const payingEntity = db.prepare("SELECT * FROM entities WHERE id = ?").get(payingEntityId) as any;
  if (!payingEntity) throw new PostingError(400, "The paying entity no longer exists");

  const amount = Number(bt.amount) || 0;
  const amountAbs = Math.abs(amount);
  if (amountAbs < 0.000001) throw new PostingError(400, "Cannot post a zero-amount transaction");
  const isMoneyOut = amount < 0; // Expense-shaped: Debit target, Credit Cash. Money-in splits (revenue) mirror with Credit target, Debit Cash.
  const splitPeriod = statutoryPeriodOf(bt.transactionDate);
  // On the paying side, "charged to" is whoever the caller named; a true
  // multi-brand split has no single bearer, so it stays null there.
  const splitChargedTo = normalizeEntityId(details.chargedToEntityId) ?? null;

  // Resolve each split line's charged-to entity (and the brand derived from
  // it), and validate its GL account against that entity. Statutory rule:
  // a line's target account is booked in the CHARGED-TO entity's ledger, so
  // it must be that entity's own head or a Shared (entityId NULL) head —
  // never another entity's account.
  const brandCache = new Map<number, any>();
  const loadBrand = (brandId: number) => {
    if (!brandCache.has(brandId)) {
      const brand = db.prepare("SELECT * FROM brands WHERE id = ?").get(brandId);
      if (!brand) throw new PostingError(400, `brandId ${brandId} does not exist`);
      brandCache.set(brandId, brand);
    }
    return brandCache.get(brandId);
  };
  const resolvedSplits = details.splits.map((s, idx) => {
    const lineNo = idx + 1;
    if (!s.accountId) throw new PostingError(400, `Split line ${lineNo} requires a GL account`);
    const lineEntityId = normalizeEntityId(s.entityId);
    let brand: any;
    if (lineEntityId) {
      if (!db.prepare("SELECT id FROM entities WHERE id = ?").get(lineEntityId)) {
        throw new PostingError(400, `Split line ${lineNo}: entity ${lineEntityId} does not exist`);
      }
      if (s.brandId && !brandBelongsToEntity(s.brandId, lineEntityId)) {
        throw new PostingError(400, `Split line ${lineNo}: brand ${s.brandId} does not belong to entity ${lineEntityId}`);
      }
      const brandId = s.brandId || resolveEntityBrandId(lineEntityId);
      if (!brandId) throw new PostingError(400, `Split line ${lineNo}: entity ${lineEntityId} has no brand to post against`);
      brand = loadBrand(brandId);
    } else if (s.brandId) {
      brand = loadBrand(s.brandId);
    } else {
      throw new PostingError(400, `Split line ${lineNo} requires a charged-to entity`);
    }
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(s.accountId) as any;
    if (!account) throw new PostingError(400, `Split line ${lineNo}: account ${s.accountId} does not exist`);
    if (account.isActive === 0) throw new PostingError(400, `Split line ${lineNo}: account "${account.name}" is inactive`);
    if (account.entityId != null && Number(account.entityId) !== Number(brand.entityId)) {
      throw new PostingError(
        400,
        `Split line ${lineNo}: account "${account.code} ${account.name}" belongs to a different entity than the one it is charged to — pick that entity's own or a Shared account`,
      );
    }
    return { ...s, brandId: brand.id as number, brand };
  });

  // Amounts. Two modes:
  //  - AMOUNT mode (every line carries an amount — the statutory Split UI):
  //    each line is booked at exactly what was entered, and the lines must
  //    sum to the bank amount to the cent. Nothing is silently absorbed
  //    into the last line — a mismatch is rejected.
  //  - PERCENTAGE mode (legacy callers, incl. the single Charged-To post at
  //    100%): the last line takes the rounding residual so the set sums to
  //    exactly amountAbs.
  const cents = (n: number) => Math.round(n * 100);
  const amountMode = resolvedSplits.every((s) => s.amount !== undefined && s.amount !== null && s.percentage == null);
  let splitAmounts: number[];
  if (amountMode) {
    splitAmounts = resolvedSplits.map((s, idx) => {
      const amt = Number(s.amount);
      if (!Number.isFinite(amt) || cents(amt) <= 0) {
        throw new PostingError(400, `Split line ${idx + 1}: amount must be greater than zero`);
      }
      return cents(amt) / 100;
    });
    const totalCents = splitAmounts.reduce((sum, a) => sum + cents(a), 0);
    if (totalCents !== cents(amountAbs)) {
      throw new PostingError(
        400,
        `Split lines total ${(totalCents / 100).toFixed(2)} but the bank transaction is ${amountAbs.toFixed(2)} — they must be equal`,
      );
    }
  } else {
    let runningTotal = 0;
    splitAmounts = resolvedSplits.map((s, idx) => {
      const isLast = idx === resolvedSplits.length - 1;
      let amt: number;
      if (isLast) {
        amt = Math.round((amountAbs - runningTotal) * 100) / 100;
      } else if (s.percentage !== undefined && s.percentage !== null) {
        amt = Math.round(amountAbs * (Number(s.percentage) / 100) * 100) / 100;
      } else if (s.amount !== undefined && s.amount !== null) {
        amt = Math.round(Number(s.amount) * 100) / 100;
      } else {
        throw new PostingError(400, "Every split line requires a percentage or an amount");
      }
      runningTotal += amt;
      return amt;
    });
    if (splitAmounts.some((a) => a < -0.005)) {
      throw new PostingError(400, "Split amounts/percentages add up to more than the transaction total");
    }
    if (Math.abs(runningTotal - amountAbs) > 0.02) {
      throw new PostingError(400, `Split amounts (${runningTotal.toFixed(2)}) do not add up to the transaction total (${amountAbs.toFixed(2)})`);
    }
  }

  const currency = bt.currency || bankAccount.currency || "USD";
  // splitPeriod is already resolved above (accounting period, else the
  // transaction month) — the rate is looked up against it.
  const lookupPeriod = splitPeriod;
  // Never blocks: resolveExchangeRate always yields a usable rate, and
  // reports how defensible it is. The caller surfaces `rateWarningMessage`
  // and the entry itself records `exchangeRateSource` for later audit.
  const resolvedRate = resolveExchangeRate(currency, lookupPeriod);
  const exchangeRate = resolvedRate.rate;
  const rateWarningMessage = rateWarning(currency, lookupPeriod, resolvedRate);
  const postingDate = postDetailsDate(details.postingDate);
  const description = details.description || bt.description;
  const batchTag = `SPLIT-BT${bt.id}-${Date.now()}`;
  const reference = details.reference || `bank_transactions#${bt.id} (multi-brand split)`;

  assertPeriodNotLocked(payingEntityId, bt.transactionDate);

  // Group split lines by target entity so same-entity brands share one
  // journal line set and each foreign entity gets exactly one entry.
  type Grouped = { entityId: number; entity: any; lines: { accountId: number; brandId: number; amountUsd: number; nativeAmount: number; startMonth?: string; endMonth?: string; contact: { id: number; contactType: "Customer" | "Vendor" } | null }[] };
  const byEntity = new Map<number, Grouped>();
  resolvedSplits.forEach((s, idx) => {
    const targetEntityId = s.brand.entityId;
    if (!byEntity.has(targetEntityId)) {
      const entity = targetEntityId === payingEntityId ? payingEntity : db.prepare("SELECT * FROM entities WHERE id = ?").get(targetEntityId);
      if (!entity) throw new PostingError(400, `Entity ${targetEntityId} (via brandId ${s.brandId}) does not exist`);
      byEntity.set(targetEntityId, { entityId: targetEntityId, entity, lines: [] });
    }
    const nativeAmount = splitAmounts[idx];
    byEntity.get(targetEntityId)!.lines.push({
      accountId: s.accountId,
      brandId: s.brandId,
      amountUsd: nativeAmount * exchangeRate,
      nativeAmount,
      startMonth: s.effectiveStartMonth,
      endMonth: s.effectiveEndMonth,
      // Validated against the entity whose ledger this line lands in.
      contact: resolveContactForEntity(s.contactId, targetEntityId, resolvedSplits.length > 1 ? `Split line ${idx + 1} From/To` : "From/To"),
    });
    if (targetEntityId !== payingEntityId) {
      assertPeriodNotLocked(targetEntityId, bt.transactionDate);
    }
  });

  const run = db.transaction(() => {
    const createdEntryIds: number[] = [];
    const allocationInserts: { journalLineId: number; month: string; amountUSD: number }[] = [];

    // ---- Paying entity's own entry: Cash leg + same-entity target lines + one "Due From" line per foreign entity ----
    const payingEntryNumber = nextEntryNumber();
    const payingEntryResult = db
      .prepare(
        `INSERT INTO journal_entries (entryNumber, entityId, brandId, transactionDate, postingDate, description, reference, status, source, chargedToEntityId, accountingPeriod, appliedExchangeRate, exchangeRateSource)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', 'BankFeed', ?, ?, ?, ?)`,
      )
      .run(payingEntryNumber, payingEntityId, null, bt.transactionDate, postingDate, description, `${reference} [${batchTag}]`, splitChargedTo, splitPeriod, exchangeRate, resolvedRate.source);
    const payingEntryId = Number(payingEntryResult.lastInsertRowid);
    createdEntryIds.push(payingEntryId);

    // contactId (last column) is set only on target lines — cash and
    // intercompany-clearing legs are never a customer/vendor balance.
    const insertLine = db.prepare(
      `INSERT INTO journal_lines (journalEntryId, accountId, debit, credit, currency, exchangeRate, amountUSD, brandId, memo, contactId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Entry-level stamp: only when every tagged line of the entry shares one
    // contact (a split paying two vendors leaves it NULL; lines stay tagged).
    const stampEntryContact = (entryId: number, lines: Grouped["lines"]) => {
      const tagged = lines.filter((l) => l.contact);
      const ids = new Set(tagged.map((l) => l.contact!.id));
      if (tagged.length > 0 && ids.size === 1) {
        db.prepare("UPDATE journal_entries SET contactId = ?, contactType = ? WHERE id = ?").run(tagged[0].contact!.id, tagged[0].contact!.contactType, entryId);
      }
    };

    // Cash leg — full transaction amount, balances the whole entry.
    const cashLine = isMoneyOut ? { debit: 0, credit: amountAbs } : { debit: amountAbs, credit: 0 };
    insertLine.run(payingEntryId, bankGlAccount.id, cashLine.debit, cashLine.credit, currency, exchangeRate, amountAbs * exchangeRate, null, `Bank: ${bankAccount.name}`, null);

    const paying = byEntity.get(payingEntityId);
    if (paying) {
      stampEntryContact(payingEntryId, paying.lines);
      for (const line of paying.lines) {
        const targetLine = isMoneyOut ? { debit: line.nativeAmount, credit: 0 } : { debit: 0, credit: line.nativeAmount };
        const r = insertLine.run(payingEntryId, line.accountId, targetLine.debit, targetLine.credit, currency, exchangeRate, line.amountUsd, line.brandId, description, line.contact?.id ?? null);
        if (line.startMonth && line.endMonth) {
          const lineId = Number(r.lastInsertRowid);
          const months = monthRange(line.startMonth, line.endMonth);
          const perMonth = Math.round((line.amountUsd / months.length) * 100) / 100;
          months.forEach((m, i) => {
            const amt = i === months.length - 1 ? Math.round((line.amountUsd - perMonth * (months.length - 1)) * 100) / 100 : perMonth;
            allocationInserts.push({ journalLineId: lineId, month: m, amountUSD: amt });
          });
        }
      }
    }

    // Intercompany clearing direction depends on which way the cash moved
    // (fixed 2026-09-16 — money-in previously re-used the money-out accounts
    // with the sides flipped, i.e. a CREDIT to the asset "Due From" and a
    // DEBIT to the liability "Due To"; it balanced and eliminated, but each
    // entity's own Balance Sheet showed a negative asset / negative
    // liability instead of a real receivable / payable):
    //   Money OUT — payer covered the foreign entity's cost:
    //     payer   Dr Due From Affiliates (receivable)
    //     foreign Cr Due To Affiliates   (payable)
    //   Money IN — payer received cash that belongs to the foreign entity:
    //     payer   Cr Due To Affiliates   (payable)
    //     foreign Dr Due From Affiliates (receivable)
    const foreignEntities = [...byEntity.values()].filter((g) => g.entityId !== payingEntityId);
    for (const foreign of foreignEntities) {
      const totalUsd = foreign.lines.reduce((s, l) => s + l.amountUsd, 0);
      const totalNative = foreign.lines.reduce((s, l) => s + l.nativeAmount, 0);
      // Counterparty-specific: the payer's position with THIS foreign entity.
      const payerClearingAccount = intercompanyClearingAccount(payingEntityId, isMoneyOut ? "DueFrom" : "DueTo", foreign.entityId);
      const payerClearingLine = isMoneyOut ? { debit: totalNative, credit: 0 } : { debit: 0, credit: totalNative };
      insertLine.run(
        payingEntryId, payerClearingAccount.id, payerClearingLine.debit, payerClearingLine.credit, currency, exchangeRate, totalUsd, null,
        isMoneyOut
          ? `Due from ${foreign.entity.name} — intercompany allocation of ${description}`
          : `Due to ${foreign.entity.name} — cash received on its behalf: ${description}`,
        null,
      );

      // ---- Foreign entity's own mirroring entry ----
      const foreignEntryNumber = nextEntryNumber();
      const foreignEntryResult = db
        .prepare(
          `INSERT INTO journal_entries (entryNumber, entityId, brandId, transactionDate, postingDate, description, reference, status, source, chargedToEntityId, accountingPeriod, appliedExchangeRate, exchangeRateSource)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', 'BankFeed', ?, ?, ?, ?)`,
        )
        // The foreign entry IS the charged-to side, so it records itself.
        .run(foreignEntryNumber, foreign.entityId, null, bt.transactionDate, postingDate, description, `${reference} [${batchTag}]`, foreign.entityId, splitPeriod, exchangeRate, resolvedRate.source);
      const foreignEntryId = Number(foreignEntryResult.lastInsertRowid);
      createdEntryIds.push(foreignEntryId);
      stampEntryContact(foreignEntryId, foreign.lines);

      for (const line of foreign.lines) {
        const targetLine = isMoneyOut ? { debit: line.nativeAmount, credit: 0 } : { debit: 0, credit: line.nativeAmount };
        const r = insertLine.run(foreignEntryId, line.accountId, targetLine.debit, targetLine.credit, currency, exchangeRate, line.amountUsd, line.brandId, description, line.contact?.id ?? null);
        if (line.startMonth && line.endMonth) {
          const lineId = Number(r.lastInsertRowid);
          const months = monthRange(line.startMonth, line.endMonth);
          const perMonth = Math.round((line.amountUsd / months.length) * 100) / 100;
          months.forEach((m, i) => {
            const amt = i === months.length - 1 ? Math.round((line.amountUsd - perMonth * (months.length - 1)) * 100) / 100 : perMonth;
            allocationInserts.push({ journalLineId: lineId, month: m, amountUSD: amt });
          });
        }
      }

      // …and the foreign entity's mirror position with the payer.
      const foreignClearingAccount = intercompanyClearingAccount(foreign.entityId, isMoneyOut ? "DueTo" : "DueFrom", payingEntityId);
      const foreignClearingLine = isMoneyOut ? { debit: 0, credit: totalNative } : { debit: totalNative, credit: 0 };
      insertLine.run(
        foreignEntryId, foreignClearingAccount.id, foreignClearingLine.debit, foreignClearingLine.credit, currency, exchangeRate, totalUsd, null,
        isMoneyOut
          ? `Due to ${payingEntity.name} — intercompany allocation of ${description}`
          : `Due from ${payingEntity.name} — cash it received on this entity's behalf: ${description}`,
        null,
      );

      db.prepare("UPDATE journal_entries SET status = 'Posted' WHERE id = ?").run(foreignEntryId);
    }

    db.prepare("UPDATE journal_entries SET status = 'Posted' WHERE id = ?").run(payingEntryId);
    db.prepare("UPDATE bank_transactions SET status = 'POSTED', journalEntryId = ? WHERE id = ?").run(payingEntryId, bt.id);

    const insertAllocation = db.prepare(
      "INSERT INTO journal_line_allocations (journalLineId, month, amountUSD) VALUES (?, ?, ?)",
    );
    for (const a of allocationInserts) insertAllocation.run(a.journalLineId, a.month, a.amountUSD);

    return createdEntryIds;
  });

  const entryIds = run();
  return {
    exchangeRateFound: resolvedRate.found,
    appliedExchangeRate: exchangeRate,
    exchangeRateSource: resolvedRate.source,
    exchangeRateEffectiveMonth: resolvedRate.effectiveMonth ?? null,
    // Non-blocking: present when the rate used was anything other than an
    // exact monthly match, so the UI can warn without refusing the post.
    rateWarning: rateWarningMessage,
    batchTag,
    journalEntries: db.prepare(`SELECT * FROM journal_entries WHERE id IN (${entryIds.map(() => "?").join(",")})`).all(...entryIds),
    bankTransaction: db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(bt.id),
  };
}

function postDetailsDate(d?: string): string {
  return d || todayIso();
}

// ---- Categorization rule routes ----

app.get("/api/categorization-rules", (req, res) => {
  res.json(db.prepare("SELECT * FROM categorization_rules ORDER BY priority ASC, id ASC").all());
});

app.post("/api/categorization-rules", (req, res) => {
  const d = req.body;
  if (!d.matchPattern || !d.targetAccountId || !d.targetEntityId) {
    return res.status(400).json({ error: "matchPattern, targetAccountId and targetEntityId are required" });
  }
  if (d.matchType === "REGEX") {
    try {
      new RegExp(d.matchPattern);
    } catch (e: any) {
      return res.status(400).json({ error: `matchPattern is not a valid regex: ${e.message}` });
    }
  }
  const r = db
    .prepare(
      `INSERT INTO categorization_rules (matchPattern, matchType, targetAccountId, targetBrandId, targetEntityId, priority, isActive)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.matchPattern,
      d.matchType === "REGEX" ? "REGEX" : "SUBSTRING",
      d.targetAccountId,
      d.targetBrandId || null,
      d.targetEntityId,
      Number.isFinite(d.priority) ? d.priority : 100,
      d.isActive === false ? 0 : 1,
    );
  res.json(db.prepare("SELECT * FROM categorization_rules WHERE id = ?").get(r.lastInsertRowid));
});

app.put("/api/categorization-rules/:id", (req, res) => {
  const d = req.body;
  if (d.matchType === "REGEX") {
    try {
      new RegExp(d.matchPattern);
    } catch (e: any) {
      return res.status(400).json({ error: `matchPattern is not a valid regex: ${e.message}` });
    }
  }
  db.prepare(
    `UPDATE categorization_rules SET matchPattern=?, matchType=?, targetAccountId=?, targetBrandId=?, targetEntityId=?, priority=?, isActive=? WHERE id=?`,
  ).run(
    d.matchPattern,
    d.matchType === "REGEX" ? "REGEX" : "SUBSTRING",
    d.targetAccountId,
    d.targetBrandId || null,
    d.targetEntityId,
    Number.isFinite(d.priority) ? d.priority : 100,
    d.isActive === false ? 0 : 1,
    req.params.id,
  );
  res.json(db.prepare("SELECT * FROM categorization_rules WHERE id = ?").get(req.params.id));
});

app.delete("/api/categorization-rules/:id", (req, res) => {
  db.prepare("DELETE FROM categorization_rules WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Unposted transactions + posting routes ----

// Each pending row carries the OWNING entity of its bank account (and
// that entity's brand), resolved server-side (2026-09-11). The feed used
// to return the raw bank_transactions row and let the client pick an
// entity from a dropdown, which is how a row could end up staged against a
// different entity than the bank card it came from. Ownership is a fact of
// the bank account, not a choice — so it is returned as data and rendered
// read-only.
//
// `entityId` filters by the OWNING entity via the bank account, so
// "unposted for entity X" can never include another entity's rows.
app.get("/api/bank-transactions/unposted", (req, res) => {
  const { bankAccountId, entityId } = req.query as any;
  let q = `
    SELECT bt.*,
           ba.entityId   AS entityId,
           ba.name       AS bankAccountName,
           ba.bankName   AS bankName,
           e.name        AS entityName
    FROM bank_transactions bt
    JOIN bank_accounts ba ON ba.id = bt.bankAccountId
    LEFT JOIN entities e ON e.id = ba.entityId
    WHERE bt.status = 'PENDING'`;
  const params: any[] = [];
  if (bankAccountId) {
    q += " AND bt.bankAccountId = ?";
    params.push(bankAccountId);
  }
  if (entityId) {
    q += " AND ba.entityId = ?";
    params.push(Number(entityId));
  }
  q += " ORDER BY bt.transactionDate DESC, bt.id DESC";
  const rows = (db.prepare(q).all(...params) as any[]).filter((t) => canAccessEntity(req, t.entityId));
  const userName = db.prepare("SELECT fullName FROM users WHERE id = ?");
  res.json(
    // Native bank amounts only. USD conversion happens silently at posting
    // time (resolveExchangeRate) and is stamped on the journal lines.
    rows.map((t) => {
      let staged: any = null;
      try { staged = t.stagedJson ? JSON.parse(t.stagedJson) : null; } catch { staged = null; }
      const { stagedJson: _omit, ...rest } = t;
      return {
        ...rest,
        brandId: t.entityId ? resolveEntityBrandId(t.entityId) : null,
        suggestedCategorization: suggestCategorization(t),
        // Categorization saved for review by a user who can't post (e.g. a
        // Bookkeeper). A poster's row opens pre-filled with it.
        staged,
        stagedByName: t.stagedByUserId ? ((userName.get(t.stagedByUserId) as any)?.fullName ?? null) : null,
      };
    }),
  );
});

// Entity access for a posting: the bank transaction's own entity plus every
// entity a line is charged to (directly, or via a legacy brandId).
function assertPostingEntityAccess(req: express.Request, bankTransactionId: number, body: any) {
  assertBankTransactionAccess(req, bankTransactionId);
  const targets: (number | null)[] = [];
  if (body?.chargedToEntityId) targets.push(Number(body.chargedToEntityId));
  for (const s of Array.isArray(body?.splits) ? body.splits : []) {
    if (s?.entityId) targets.push(Number(s.entityId));
    else if (s?.brandId) targets.push((db.prepare("SELECT entityId FROM brands WHERE id = ?").get(Number(s.brandId)) as any)?.entityId ?? null);
  }
  for (const e of targets) assertEntityAccess(req, e, "an entity this transaction is charged to");
}

// Save for review (2026-09-17). Users with the `stage` capability (Bookkeeper
// and up) record their categorization — From/To, Categorize, Charged To, or a
// full split — on the pending transaction without touching the ledger. It is
// data entry only: nothing is posted until a Manager/Admin posts it. Send
// { clear: true } to discard a saved categorization.
app.put("/api/bank-transactions/:id/stage", (req, res) => {
  try {
    const id = Number(req.params.id);
    const txn = db.prepare("SELECT status FROM bank_transactions WHERE id = ?").get(id) as any;
    if (!txn) return res.status(404).json({ error: "Bank transaction not found" });
    if (txn.status !== "PENDING") return res.status(409).json({ error: "Only unposted transactions can be prepared for review" });
    assertPostingEntityAccess(req, id, req.body);
    if (req.body?.clear) {
      db.prepare("UPDATE bank_transactions SET stagedJson = NULL, stagedByUserId = NULL, stagedAt = NULL WHERE id = ?").run(id);
      return res.json({ ok: true, staged: null });
    }
    const num = (v: any) => (v === undefined || v === null || v === "" ? null : Number(v));
    const staged = {
      accountId: num(req.body?.accountId),
      chargedToEntityId: num(req.body?.chargedToEntityId),
      contactId: num(req.body?.contactId),
      splits: Array.isArray(req.body?.splits)
        ? req.body.splits.map((s: any) => ({ accountId: num(s.accountId), entityId: num(s.entityId), contactId: num(s.contactId), amount: num(s.amount) }))
        : null,
    };
    for (const accId of [staged.accountId, ...(staged.splits || []).map((s: any) => s.accountId)]) {
      if (accId !== null && !db.prepare("SELECT id FROM accounts WHERE id = ?").get(accId)) return res.status(400).json({ error: `Account ${accId} does not exist` });
    }
    for (const cId of [staged.contactId, ...(staged.splits || []).map((s: any) => s.contactId)]) {
      if (cId !== null && !db.prepare("SELECT id FROM contacts WHERE id = ?").get(cId)) return res.status(400).json({ error: `Contact ${cId} does not exist` });
    }
    db.prepare("UPDATE bank_transactions SET stagedJson = ?, stagedByUserId = ?, stagedAt = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(staged), authOf(req).user.id, id);
    res.json({ ok: true, staged });
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 400).json({ error: err.message || "Failed to save for review" });
  }
});

const clearStaged = (bankTransactionId: number) =>
  db.prepare("UPDATE bank_transactions SET stagedJson = NULL, stagedByUserId = NULL, stagedAt = NULL WHERE id = ?").run(bankTransactionId);

app.post("/api/bank-transactions/:id/post", (req, res) => {
  try {
    assertPostingEntityAccess(req, Number(req.params.id), req.body);
    const result = postBankTransactionToGL(Number(req.params.id), req.body || {});
    clearStaged(Number(req.params.id));
    res.json(result);
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to post transaction" });
  }
});

// Unpost (2026-09-11): send a posted bank transaction back to the
// unposted feed and remove the journal entry it created.
//
// This DELETES the entry rather than voiding it (voidBill/voidInvoice post
// a mirror-image reversal and keep both sides). That is the right call
// here specifically because bank-feed categorisation is data entry, not a
// filed transaction: a mis-picked GL account is a typo, and leaving a
// reversal pair behind for every typo would bury the real books in noise.
// The guard below is what keeps that safe: once anything has been built on
// top of the entry it is no longer just a typo, and unposting is refused.
//
// Sequencing matters: journal_lines are immutable while their entry is
// Posted (Phase 1.1 triggers), so the entry must be flipped back to Draft
// before its lines can be deleted.
app.post("/api/bank-transactions/:id/unpost", (req, res) => {
  const id = Number(req.params.id);
  const txn = db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(id) as any;
  if (!txn) return res.status(404).json({ error: "Bank transaction not found" });
  if (txn.status !== "POSTED" || !txn.journalEntryId) {
    return res.status(400).json({ error: "This transaction isn't posted, so there's nothing to undo." });
  }

  // Refuse if the entry has been reconciled — undoing it would silently
  // change a period someone has already signed off.
  const matched = (db.prepare("SELECT COUNT(*) as n FROM reconciliation_matches WHERE bankTransactionId = ?").get(id) as any).n;
  if (matched > 0) {
    return res.status(400).json({
      error: "This transaction is part of a completed reconciliation. Undo the reconciliation first.",
    });
  }

  const entryId = txn.journalEntryId;

  // A cross-entity / multi-brand post creates SEVERAL entries — the paying
  // entity's plus one per foreign entity — tied together by a
  // `[SPLIT-BT<id>-<ts>]` tag in their reference. bank_transactions only
  // links back to the paying one, so deleting just that left the foreign
  // entry orphaned: its "Due To Affiliates" line survived with no
  // counterparty, silently unbalancing the group's books. Every entry in
  // the batch must go together.
  const entry = db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(entryId) as any;
  const batchTag = String(entry?.reference || "").match(/\[(SPLIT-BT\d+-\d+)\]/)?.[1] || null;
  const entryIds: number[] = batchTag
    ? (db.prepare("SELECT id FROM journal_entries WHERE reference LIKE ?").all(`%[${batchTag}]%`) as any[]).map((r) => r.id)
    : [entryId];

  // Undoing removes entries from EVERY entity in the batch, so the user
  // needs access to all of them.
  try {
    assertBankTransactionAccess(req, id);
    for (const eid of entryIds) {
      const e = db.prepare("SELECT entityId FROM journal_entries WHERE id = ?").get(eid) as any;
      assertEntityAccess(req, e?.entityId, "an entity this posting was charged to");
    }
  } catch (err: any) {
    return res.status(hasHttpStatus(err) ? err.status : 403).json({ error: err.message });
  }

  try {
    db.transaction(() => {
      for (const eid of entryIds) {
        db.prepare("UPDATE journal_entries SET status = 'Draft' WHERE id = ?").run(eid);
        db.prepare("DELETE FROM journal_line_allocations WHERE journalLineId IN (SELECT id FROM journal_lines WHERE journalEntryId = ?)").run(eid);
        db.prepare("DELETE FROM journal_lines WHERE journalEntryId = ?").run(eid);
        db.prepare("DELETE FROM journal_entries WHERE id = ?").run(eid);
      }
      db.prepare("UPDATE bank_transactions SET status = 'PENDING', journalEntryId = NULL WHERE id = ?").run(id);
    })();
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Failed to unpost transaction" });
  }

  res.json({
    ok: true,
    removedJournalEntryId: entryId,
    removedJournalEntryIds: entryIds,
    bankTransaction: db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(id),
  });
});

app.post("/api/bank-transactions/:id/post-split", (req, res) => {
  try {
    assertPostingEntityAccess(req, Number(req.params.id), req.body);
    const result = postBankTransactionToGLSplit(Number(req.params.id), req.body || {});
    clearStaged(Number(req.params.id));
    res.json(result);
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to post split transaction" });
  }
});

app.post("/api/bank-transactions/bulk-post", (req, res) => {
  const items: (PostDetails & { bankTransactionId: number })[] = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ error: "items[] is required" });

  const results: { bankTransactionId: number; journalEntryId: number }[] = [];
  const errors: { bankTransactionId: number; reason: string }[] = [];
  for (const item of items) {
    try {
      assertPostingEntityAccess(req, Number(item.bankTransactionId), item);
      const result = postBankTransactionToGL(item.bankTransactionId, item) as any;
      clearStaged(Number(item.bankTransactionId));
      // Same-entity posts return `journalEntry`; a Charged-To (intercompany)
      // post routes through the split engine and returns `journalEntries`,
      // whose first entry is the paying entity's own. Reading only
      // `journalEntry` reported an already-committed post as a failure.
      const entry = result.journalEntry ?? result.journalEntries?.[0];
      results.push({ bankTransactionId: item.bankTransactionId, journalEntryId: entry?.id });
    } catch (err: any) {
      errors.push({ bankTransactionId: item.bankTransactionId, reason: err.message || "Failed to post" });
    }
  }
  res.json({ posted: results.length, failed: errors.length, results, errors });
});

// ======= AP / AR / INTERCOMPANY TREASURY — posting helpers (Phase 1.4) =======

// Small shared builders so bills/invoices/intercompany settlement don't each
// repeat the journal_entries/journal_lines INSERT SQL that Phase 1.3's
// postBankTransactionToGL already established the shape of. postBankTransactionToGL
// itself is left untouched (already verified in Phase 1.3) — these are used
// only by the new Phase 1.4 functions below.
function createDraftJournalEntry(params: {
  entityId: number;
  brandId?: number | null;
  transactionDate: string;
  postingDate: string;
  description: string;
  reference: string;
  source: string;
}): number {
  const entryNumber = nextEntryNumber();
  const r = db
    .prepare(
      `INSERT INTO journal_entries (entryNumber, entityId, brandId, transactionDate, postingDate, description, reference, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', ?)`,
    )
    .run(
      entryNumber,
      params.entityId,
      params.brandId ?? null,
      params.transactionDate,
      params.postingDate,
      params.description,
      params.reference,
      params.source,
    );
  return Number(r.lastInsertRowid);
}

function insertJournalLine(
  journalEntryId: number,
  accountId: number,
  debit: number,
  credit: number,
  currency: string,
  exchangeRate: number,
  brandId: number | null,
  memo: string,
) {
  db.prepare(
    `INSERT INTO journal_lines (journalEntryId, accountId, debit, credit, currency, exchangeRate, amountUSD, brandId, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(journalEntryId, accountId, debit, credit, currency, exchangeRate, (debit || credit) * exchangeRate, brandId, memo);
}

function postJournalEntry(journalEntryId: number) {
  db.prepare("UPDATE journal_entries SET status = 'Posted' WHERE id = ?").run(journalEntryId);
}

// The shared-template GL accounts (Accounts Payable 2000, Accounts
// Receivable 1100, Intercompany Receivables 1200, Intercompany Payables
// 2200, Intercompany Recharges 5600) are singletons seeded once in Phase
// 1.1 — never re-derived here, and never invented if missing.
function requireSharedAccountByCode(code: string, label: string): any {
  const acc = db.prepare("SELECT * FROM accounts WHERE code = ? AND isActive = 1").get(code);
  if (!acc) {
    throw new PostingError(500, `Required GL account ${code} (${label}) is missing from the chart of accounts`);
  }
  return acc;
}

function requireEntityByName(name: string): any {
  const entity = db.prepare("SELECT * FROM entities WHERE name = ?").get(name);
  if (!entity) throw new PostingError(500, `Entity "${name}" is missing — the Phase 1.1 entity seed may not have run`);
  return entity;
}

// ---- Accounts Payable (bills) ----

// A bill is recognized (Debit Expense, Credit Accounts Payable) the moment
// it's entered — the task's own status enum (PENDING/PARTIALLY_PAID/PAID/
// VOIDED) has no "draft/unposted" state, so a bill is always a real
// liability from creation. Without this entry, account 2000 would only ever
// receive debits from payments and never the credits that create the
// liability in the first place — the GL would never actually be right, which
// the task's item 2 (payment-only entry) doesn't by itself achieve. This is
// a deliberate addition beyond the literal spec, logged in the tracker.
function createBill(d: any) {
  if (!d.billNumber || !d.entityId || !d.vendorName || !d.dueDate || !d.expenseAccountId) {
    throw new PostingError(400, "billNumber, entityId, vendorName, dueDate and expenseAccountId are required");
  }
  assertPeriodNotLocked(d.entityId, d.issueDate || todayIso());
  const totalAmount = Number(d.totalAmount) || 0;
  if (totalAmount <= 0) throw new PostingError(400, "totalAmount must be positive");
  const expenseAccount = db.prepare("SELECT * FROM accounts WHERE id = ?").get(d.expenseAccountId) as any;
  if (!expenseAccount) throw new PostingError(400, "expenseAccountId does not exist in the chart of accounts");
  const apAccount = requireSharedAccountByCode("2000", "Accounts Payable");

  const currency = d.currency || "USD";
  const issueDate = d.issueDate || todayIso();
  const month = issueDate.slice(0, 7);
  const { rate: exchangeRate } = resolveExchangeRate(currency, month);

  const run = db.transaction(() => {
    const journalEntryId = createDraftJournalEntry({
      entityId: d.entityId,
      brandId: d.brandId ?? null,
      transactionDate: issueDate,
      postingDate: issueDate,
      description: `Bill ${d.billNumber} — ${d.vendorName}`,
      reference: `bills#pending`,
      source: "AP",
    });
    insertJournalLine(journalEntryId, expenseAccount.id, totalAmount, 0, currency, exchangeRate, d.brandId ?? null, `Bill ${d.billNumber} — ${d.vendorName}`);
    insertJournalLine(journalEntryId, apAccount.id, 0, totalAmount, currency, exchangeRate, d.brandId ?? null, `AP: ${d.vendorName}`);
    postJournalEntry(journalEntryId);

    const r = db
      .prepare(
        `INSERT INTO bills (billNumber, entityId, brandId, vendorName, issueDate, dueDate, totalAmount, currency, amountPaid, amountOutstanding, status, expenseAccountId, journalEntryId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'PENDING', ?, ?)`,
      )
      .run(d.billNumber, d.entityId, d.brandId ?? null, d.vendorName, issueDate, d.dueDate, totalAmount, currency, totalAmount, expenseAccount.id, journalEntryId);
    const billId = Number(r.lastInsertRowid);
    db.prepare("UPDATE journal_entries SET reference = ? WHERE id = ?").run(`bills#${billId}`, journalEntryId);
    return billId;
  });

  return db.prepare("SELECT * FROM bills WHERE id = ?").get(run());
}

// Partial Payment & Auto-Status Logic (task item 2). AmountPaid/
// AmountOutstanding/Status are always recomputed from SUM(payment_records)
// — the transactional source — never incremented, per CLAUDE.md product
// rule 3 ("reports are always derived from transactional data").
function applyPaymentToBill(
  billId: number,
  paymentDetails: {
    amount: number;
    paymentDate?: string;
    currency?: string;
    paidFromAccountId?: number;
    bankTransactionId?: number;
    notes?: string;
  },
) {
  const bill = db.prepare("SELECT * FROM bills WHERE id = ?").get(billId) as any;
  if (!bill) throw new PostingError(404, "Bill not found");
  if (bill.status === "VOIDED") throw new PostingError(409, "Cannot pay a voided bill");
  if (bill.status === "PAID") throw new PostingError(409, "Bill is already fully paid");
  assertPeriodNotLocked(bill.entityId, paymentDetails.paymentDate || todayIso());

  const amount = Number(paymentDetails.amount);
  if (!(amount > 0)) throw new PostingError(400, "Payment amount must be positive");
  if (amount > bill.amountOutstanding + 0.000001) {
    throw new PostingError(400, `Payment of ${amount} exceeds the outstanding balance of ${bill.amountOutstanding}`);
  }

  let paidFromAccountId = paymentDetails.paidFromAccountId;
  let linkedBankTransaction: any = null;
  if (!paidFromAccountId && paymentDetails.bankTransactionId) {
    linkedBankTransaction = db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(paymentDetails.bankTransactionId);
    if (!linkedBankTransaction) throw new PostingError(400, "bankTransactionId not found");
    if (linkedBankTransaction.status !== "PENDING") throw new PostingError(409, "The linked bank transaction is not PENDING");
    const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(linkedBankTransaction.bankAccountId) as any;
    if (!bankAccount) throw new PostingError(400, "The bank_accounts row for the linked transaction no longer exists");
    const bankGl = resolveBankGlAccount(bankAccount);
    if (!bankGl) throw new PostingError(400, "Could not resolve a GL cash account for the linked bank transaction");
    paidFromAccountId = bankGl.id;
  }
  if (!paidFromAccountId) {
    throw new PostingError(400, "paidFromAccountId (or a resolvable bankTransactionId) is required");
  }
  const paidFromAccount = db.prepare("SELECT * FROM accounts WHERE id = ?").get(paidFromAccountId) as any;
  if (!paidFromAccount) throw new PostingError(400, "paidFromAccountId does not exist in the chart of accounts");

  const apAccount = requireSharedAccountByCode("2000", "Accounts Payable");
  const currency = paymentDetails.currency || bill.currency || "USD";
  const paymentDate = paymentDetails.paymentDate || todayIso();
  const month = paymentDate.slice(0, 7);
  const { rate: exchangeRate } = resolveExchangeRate(currency, month);

  const run = db.transaction(() => {
    const journalEntryId = createDraftJournalEntry({
      entityId: bill.entityId,
      brandId: bill.brandId,
      transactionDate: paymentDate,
      postingDate: paymentDate,
      description: `Payment on bill ${bill.billNumber} — ${bill.vendorName}`,
      reference: `bills#${bill.id}`,
      source: "AP",
    });
    // Debit Accounts Payable (liability decreases), Credit Cash/Bank (asset decreases) — task item 2.
    insertJournalLine(journalEntryId, apAccount.id, amount, 0, currency, exchangeRate, bill.brandId, `Payment: ${bill.vendorName}`);
    insertJournalLine(journalEntryId, paidFromAccount.id, 0, amount, currency, exchangeRate, bill.brandId, `Payment: ${bill.vendorName}`);
    postJournalEntry(journalEntryId);

    db.prepare(
      `INSERT INTO payment_records (billId, invoiceId, bankTransactionId, paymentDate, amount, currency, paidFromAccountId, notes, journalEntryId)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(billId, paymentDetails.bankTransactionId || null, paymentDate, amount, currency, paidFromAccountId, paymentDetails.notes || "", journalEntryId);

    if (linkedBankTransaction) {
      db.prepare("UPDATE bank_transactions SET status = 'POSTED', journalEntryId = ? WHERE id = ?").run(journalEntryId, linkedBankTransaction.id);
    }

    const totalPaid = (db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM payment_records WHERE billId = ?").get(billId) as any).s;
    const outstanding = Math.max(bill.totalAmount - totalPaid, 0);
    const status = totalPaid <= 0 ? "PENDING" : outstanding <= 0.000001 ? "PAID" : "PARTIALLY_PAID";
    db.prepare("UPDATE bills SET amountPaid = ?, amountOutstanding = ?, status = ? WHERE id = ?").run(totalPaid, outstanding, status, billId);

    return journalEntryId;
  });

  const journalEntryId = run();
  return {
    journalEntry: db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(journalEntryId),
    journalLines: db.prepare("SELECT * FROM journal_lines WHERE journalEntryId = ?").all(journalEntryId),
    bill: db.prepare("SELECT * FROM bills WHERE id = ?").get(billId),
  };
}

// Voiding is only supported before any payment has been applied (reversing
// a partially-paid bill would also need to reverse the payment entries and
// the linked bank transactions — out of scope for this phase, and refused
// with a clear error rather than attempted half-correctly).
function voidBill(billId: number) {
  const bill = db.prepare("SELECT * FROM bills WHERE id = ?").get(billId) as any;
  if (!bill) throw new PostingError(404, "Bill not found");
  if (bill.status === "VOIDED") throw new PostingError(409, "Bill is already voided");
  if (bill.amountPaid > 0) throw new PostingError(409, "Cannot void a bill that already has payments applied");
  // A void touches both the period the original liability landed in AND
  // today's period (the reversing entry posts today) — either being locked
  // blocks it.
  const voidDate = todayIso();
  assertPeriodNotLocked(bill.entityId, bill.issueDate);
  assertPeriodNotLocked(bill.entityId, voidDate);

  const run = db.transaction(() => {
    if (bill.journalEntryId) {
      const original = db.prepare("SELECT * FROM journal_lines WHERE journalEntryId = ?").all(bill.journalEntryId) as any[];
      const journalEntryId = createDraftJournalEntry({
        entityId: bill.entityId,
        brandId: bill.brandId,
        transactionDate: todayIso(),
        postingDate: todayIso(),
        description: `Void bill ${bill.billNumber} — ${bill.vendorName}`,
        reference: `bills#${bill.id}`,
        source: "AP",
      });
      // Exact mirror image of the original lines — nets the liability to zero.
      for (const line of original) {
        insertJournalLine(journalEntryId, line.accountId, line.credit, line.debit, line.currency, line.exchangeRate, line.brandId, `Void: ${line.memo}`);
      }
      postJournalEntry(journalEntryId);
    }
    db.prepare("UPDATE bills SET status = 'VOIDED' WHERE id = ?").run(billId);
  });
  run();
  return db.prepare("SELECT * FROM bills WHERE id = ?").get(billId);
}

// ---- Accounts Receivable (invoices) — mirrors bills exactly ----

function createInvoice(d: any) {
  if (!d.invoiceNumber || !d.entityId || !d.customerName || !d.dueDate || !d.revenueAccountId) {
    throw new PostingError(400, "invoiceNumber, entityId, customerName, dueDate and revenueAccountId are required");
  }
  assertPeriodNotLocked(d.entityId, d.issueDate || todayIso());
  const totalAmount = Number(d.totalAmount) || 0;
  if (totalAmount <= 0) throw new PostingError(400, "totalAmount must be positive");
  const revenueAccount = db.prepare("SELECT * FROM accounts WHERE id = ?").get(d.revenueAccountId) as any;
  if (!revenueAccount) throw new PostingError(400, "revenueAccountId does not exist in the chart of accounts");
  const arAccount = requireSharedAccountByCode("1100", "Accounts Receivable");

  const currency = d.currency || "USD";
  const issueDate = d.issueDate || todayIso();
  const month = issueDate.slice(0, 7);
  const { rate: exchangeRate } = resolveExchangeRate(currency, month);

  const run = db.transaction(() => {
    const journalEntryId = createDraftJournalEntry({
      entityId: d.entityId,
      brandId: d.brandId ?? null,
      transactionDate: issueDate,
      postingDate: issueDate,
      description: `Invoice ${d.invoiceNumber} — ${d.customerName}`,
      reference: `invoices#pending`,
      source: "AR",
    });
    insertJournalLine(journalEntryId, arAccount.id, totalAmount, 0, currency, exchangeRate, d.brandId ?? null, `AR: ${d.customerName}`);
    insertJournalLine(journalEntryId, revenueAccount.id, 0, totalAmount, currency, exchangeRate, d.brandId ?? null, `Invoice ${d.invoiceNumber} — ${d.customerName}`);
    postJournalEntry(journalEntryId);

    const r = db
      .prepare(
        `INSERT INTO invoices (invoiceNumber, entityId, brandId, customerName, issueDate, dueDate, totalAmount, currency, amountPaid, amountOutstanding, status, revenueAccountId, journalEntryId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'PENDING', ?, ?)`,
      )
      .run(d.invoiceNumber, d.entityId, d.brandId ?? null, d.customerName, issueDate, d.dueDate, totalAmount, currency, totalAmount, revenueAccount.id, journalEntryId);
    const invoiceId = Number(r.lastInsertRowid);
    db.prepare("UPDATE journal_entries SET reference = ? WHERE id = ?").run(`invoices#${invoiceId}`, journalEntryId);
    return invoiceId;
  });

  return db.prepare("SELECT * FROM invoices WHERE id = ?").get(run());
}

function applyPaymentToInvoice(
  invoiceId: number,
  paymentDetails: {
    amount: number;
    paymentDate?: string;
    currency?: string;
    paidFromAccountId?: number; // "paid into" for AR, named the same as AP for one consistent payment_records shape
    bankTransactionId?: number;
    notes?: string;
  },
) {
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId) as any;
  if (!invoice) throw new PostingError(404, "Invoice not found");
  if (invoice.status === "VOIDED") throw new PostingError(409, "Cannot receive payment on a voided invoice");
  if (invoice.status === "PAID") throw new PostingError(409, "Invoice is already fully paid");
  assertPeriodNotLocked(invoice.entityId, paymentDetails.paymentDate || todayIso());

  const amount = Number(paymentDetails.amount);
  if (!(amount > 0)) throw new PostingError(400, "Payment amount must be positive");
  if (amount > invoice.amountOutstanding + 0.000001) {
    throw new PostingError(400, `Payment of ${amount} exceeds the outstanding balance of ${invoice.amountOutstanding}`);
  }

  let depositToAccountId = paymentDetails.paidFromAccountId;
  let linkedBankTransaction: any = null;
  if (!depositToAccountId && paymentDetails.bankTransactionId) {
    linkedBankTransaction = db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(paymentDetails.bankTransactionId);
    if (!linkedBankTransaction) throw new PostingError(400, "bankTransactionId not found");
    if (linkedBankTransaction.status !== "PENDING") throw new PostingError(409, "The linked bank transaction is not PENDING");
    const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(linkedBankTransaction.bankAccountId) as any;
    if (!bankAccount) throw new PostingError(400, "The bank_accounts row for the linked transaction no longer exists");
    const bankGl = resolveBankGlAccount(bankAccount);
    if (!bankGl) throw new PostingError(400, "Could not resolve a GL cash account for the linked bank transaction");
    depositToAccountId = bankGl.id;
  }
  if (!depositToAccountId) {
    throw new PostingError(400, "paidFromAccountId (the depositing cash account) or a resolvable bankTransactionId is required");
  }
  const depositAccount = db.prepare("SELECT * FROM accounts WHERE id = ?").get(depositToAccountId) as any;
  if (!depositAccount) throw new PostingError(400, "paidFromAccountId does not exist in the chart of accounts");

  const arAccount = requireSharedAccountByCode("1100", "Accounts Receivable");
  const currency = paymentDetails.currency || invoice.currency || "USD";
  const paymentDate = paymentDetails.paymentDate || todayIso();
  const month = paymentDate.slice(0, 7);
  const { rate: exchangeRate } = resolveExchangeRate(currency, month);

  const run = db.transaction(() => {
    const journalEntryId = createDraftJournalEntry({
      entityId: invoice.entityId,
      brandId: invoice.brandId,
      transactionDate: paymentDate,
      postingDate: paymentDate,
      description: `Payment received on invoice ${invoice.invoiceNumber} — ${invoice.customerName}`,
      reference: `invoices#${invoice.id}`,
      source: "AR",
    });
    // Debit Cash/Bank (asset increases), Credit Accounts Receivable (asset decreases).
    insertJournalLine(journalEntryId, depositAccount.id, amount, 0, currency, exchangeRate, invoice.brandId, `Payment: ${invoice.customerName}`);
    insertJournalLine(journalEntryId, arAccount.id, 0, amount, currency, exchangeRate, invoice.brandId, `Payment: ${invoice.customerName}`);
    postJournalEntry(journalEntryId);

    db.prepare(
      `INSERT INTO payment_records (billId, invoiceId, bankTransactionId, paymentDate, amount, currency, paidFromAccountId, notes, journalEntryId)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(invoiceId, paymentDetails.bankTransactionId || null, paymentDate, amount, currency, depositToAccountId, paymentDetails.notes || "", journalEntryId);

    if (linkedBankTransaction) {
      db.prepare("UPDATE bank_transactions SET status = 'POSTED', journalEntryId = ? WHERE id = ?").run(journalEntryId, linkedBankTransaction.id);
    }

    const totalPaid = (db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM payment_records WHERE invoiceId = ?").get(invoiceId) as any).s;
    const outstanding = Math.max(invoice.totalAmount - totalPaid, 0);
    const status = totalPaid <= 0 ? "PENDING" : outstanding <= 0.000001 ? "PAID" : "PARTIALLY_PAID";
    db.prepare("UPDATE invoices SET amountPaid = ?, amountOutstanding = ?, status = ? WHERE id = ?").run(totalPaid, outstanding, status, invoiceId);

    return journalEntryId;
  });

  const journalEntryId = run();
  return {
    journalEntry: db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(journalEntryId),
    journalLines: db.prepare("SELECT * FROM journal_lines WHERE journalEntryId = ?").all(journalEntryId),
    invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId),
  };
}

function voidInvoice(invoiceId: number) {
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId) as any;
  if (!invoice) throw new PostingError(404, "Invoice not found");
  if (invoice.status === "VOIDED") throw new PostingError(409, "Invoice is already voided");
  if (invoice.amountPaid > 0) throw new PostingError(409, "Cannot void an invoice that already has payments applied");
  const voidDate = todayIso();
  assertPeriodNotLocked(invoice.entityId, invoice.issueDate);
  assertPeriodNotLocked(invoice.entityId, voidDate);

  const run = db.transaction(() => {
    if (invoice.journalEntryId) {
      const original = db.prepare("SELECT * FROM journal_lines WHERE journalEntryId = ?").all(invoice.journalEntryId) as any[];
      const journalEntryId = createDraftJournalEntry({
        entityId: invoice.entityId,
        brandId: invoice.brandId,
        transactionDate: todayIso(),
        postingDate: todayIso(),
        description: `Void invoice ${invoice.invoiceNumber} — ${invoice.customerName}`,
        reference: `invoices#${invoice.id}`,
        source: "AR",
      });
      for (const line of original) {
        insertJournalLine(journalEntryId, line.accountId, line.credit, line.debit, line.currency, line.exchangeRate, line.brandId, `Void: ${line.memo}`);
      }
      postJournalEntry(journalEntryId);
    }
    db.prepare("UPDATE invoices SET status = 'VOIDED' WHERE id = ?").run(invoiceId);
  });
  run();
  return db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
}

// ---- Pakistan Treasury: intercompany recharge settlement ----

// Settling a recharge posts TWO journal entries — one per set of books,
// exactly as task item 3 specifies ("PK Books: ... US/UAE Books: ...").
// journal_entries.entityId scopes an entry to one entity's books, so an
// intercompany transaction between two entities is always two mirrored
// entries, never one — this is standard "due to/due from" intercompany
// accounting, and matches the existing 1200/2200 shared-template accounts
// seeded in Phase 1.1 for exactly this purpose.
function settleIntercompanyRecharge(rechargeId: number, postDetails?: { postingDate?: string }) {
  const recharge = db.prepare("SELECT * FROM intercompany_recharges WHERE id = ?").get(rechargeId) as any;
  if (!recharge) throw new PostingError(404, "Intercompany recharge not found");
  if (recharge.status === "SETTLED") throw new PostingError(409, "Recharge is already settled");
  if (recharge.status !== "APPROVED") {
    throw new PostingError(409, `Recharge must be APPROVED before it can be settled (current status: ${recharge.status})`);
  }
  const settlementDate = postDetails?.postingDate || todayIso();
  // Settlement posts to BOTH entities' books — either being locked blocks
  // the whole settlement (never post to one entity's books and not the
  // other).
  assertPeriodNotLocked(recharge.sourceEntityId, settlementDate);
  assertPeriodNotLocked(recharge.targetEntityId, settlementDate);

  const sourceCash = resolveEntityCashAccount(recharge.sourceEntityId);
  if (!sourceCash) {
    throw new PostingError(400, `No unique "Cash & Equivalents" account found for source entity ${recharge.sourceEntityId}`);
  }
  const icReceivable = requireSharedAccountByCode("1200", "Intercompany Receivables");
  const icPayable = requireSharedAccountByCode("2200", "Intercompany Payables");
  const rechargeExpense = requireSharedAccountByCode("5600", "Intercompany Recharges");

  const amount = Number(recharge.fundRequiredAmount);
  if (!(amount > 0)) throw new PostingError(400, "fundRequiredAmount must be positive");
  const currency = recharge.currency || "USD";
  const postingDate = settlementDate;
  const { rate: exchangeRate } = resolveExchangeRate(currency, postingDate.slice(0, 7));

  const run = db.transaction(() => {
    // PK (source) books: Debit Intercompany Receivable, Credit Bank/Cash.
    const sourceEntryId = createDraftJournalEntry({
      entityId: recharge.sourceEntityId,
      transactionDate: postingDate,
      postingDate,
      description: `Intercompany funding to entity ${recharge.targetEntityId}${recharge.purpose ? `: ${recharge.purpose}` : ""}`,
      reference: `intercompany_recharges#${recharge.id}`,
      source: "Intercompany",
    });
    insertJournalLine(sourceEntryId, icReceivable.id, amount, 0, currency, exchangeRate, null, `Due from entity ${recharge.targetEntityId}`);
    insertJournalLine(sourceEntryId, sourceCash.id, 0, amount, currency, exchangeRate, null, "Funding transferred");
    postJournalEntry(sourceEntryId);

    // Target entity's books: Debit Expense/Brand Cost, Credit Intercompany Payable.
    const targetEntryId = createDraftJournalEntry({
      entityId: recharge.targetEntityId,
      brandId: recharge.targetBrandId,
      transactionDate: postingDate,
      postingDate,
      description: `Cost funded by entity ${recharge.sourceEntityId}${recharge.purpose ? `: ${recharge.purpose}` : ""}`,
      reference: `intercompany_recharges#${recharge.id}`,
      source: "Intercompany",
    });
    insertJournalLine(targetEntryId, rechargeExpense.id, amount, 0, currency, exchangeRate, recharge.targetBrandId, `Funded by entity ${recharge.sourceEntityId}`);
    insertJournalLine(targetEntryId, icPayable.id, 0, amount, currency, exchangeRate, recharge.targetBrandId, `Due to entity ${recharge.sourceEntityId}`);
    postJournalEntry(targetEntryId);

    db.prepare("UPDATE intercompany_recharges SET status = 'SETTLED', sourceJournalEntryId = ?, targetJournalEntryId = ? WHERE id = ?").run(
      sourceEntryId,
      targetEntryId,
      recharge.id,
    );
    return { sourceEntryId, targetEntryId };
  });

  const { sourceEntryId, targetEntryId } = run();
  return {
    recharge: db.prepare("SELECT * FROM intercompany_recharges WHERE id = ?").get(rechargeId),
    sourceJournalEntry: db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(sourceEntryId),
    sourceJournalLines: db.prepare("SELECT * FROM journal_lines WHERE journalEntryId = ?").all(sourceEntryId),
    targetJournalEntry: db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(targetEntryId),
    targetJournalLines: db.prepare("SELECT * FROM journal_lines WHERE journalEntryId = ?").all(targetEntryId),
  };
}

function daysOverdue(dueDate: string, asOf: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.floor((now - due) / (1000 * 60 * 60 * 24));
}

function agingBucket(days: number): string {
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

// ---- Routes: Bills (AP) ----

app.get("/api/bills", (req, res) => {
  const { entityId, brandId, status } = req.query as any;
  let q = "SELECT * FROM bills WHERE 1=1";
  const params: any[] = [];
  if (entityId) { q += " AND entityId = ?"; params.push(entityId); }
  if (brandId) { q += " AND brandId = ?"; params.push(brandId); }
  if (status) { q += " AND status = ?"; params.push(status); }
  q += " ORDER BY dueDate DESC";
  res.json(db.prepare(q).all(...params));
});

app.get("/api/bills/:id", (req, res) => {
  const bill = db.prepare("SELECT * FROM bills WHERE id = ?").get(req.params.id);
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  const payments = db.prepare("SELECT * FROM payment_records WHERE billId = ? ORDER BY paymentDate DESC, id DESC").all(req.params.id);
  res.json({ ...bill, payments });
});

app.post("/api/bills", (req, res) => {
  try {
    res.json(createBill(req.body || {}));
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to create bill" });
  }
});

// Only non-financial fields are editable once a bill has posted its
// liability entry — changing totalAmount/currency/expenseAccountId after
// the fact would desync bills from the journal entry that already exists
// for it (never rewrite history; void and re-enter instead).
app.put("/api/bills/:id", (req, res) => {
  const bill = db.prepare("SELECT * FROM bills WHERE id = ?").get(req.params.id) as any;
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  const d = req.body || {};
  db.prepare("UPDATE bills SET vendorName = ?, dueDate = ? WHERE id = ?").run(
    d.vendorName ?? bill.vendorName,
    d.dueDate ?? bill.dueDate,
    req.params.id,
  );
  res.json(db.prepare("SELECT * FROM bills WHERE id = ?").get(req.params.id));
});

app.post("/api/bills/:id/void", (req, res) => {
  try {
    res.json(voidBill(Number(req.params.id)));
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to void bill" });
  }
});

app.post("/api/bills/:id/payments", (req, res) => {
  try {
    res.json(applyPaymentToBill(Number(req.params.id), req.body || {}));
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to apply payment" });
  }
});

app.get("/api/ap/outstanding", (req, res) => {
  const { entityId, brandId, age } = req.query as any;
  let q = "SELECT * FROM bills WHERE status IN ('PENDING','PARTIALLY_PAID')";
  const params: any[] = [];
  if (entityId) { q += " AND entityId = ?"; params.push(entityId); }
  if (brandId) { q += " AND brandId = ?"; params.push(brandId); }
  const today = todayIso();
  let bills = (db.prepare(q).all(...params) as any[]).map((b) => ({ ...b, daysOverdue: daysOverdue(b.dueDate, today) }));
  if (age !== undefined) {
    const threshold = Number(age);
    bills = bills.filter((b) => b.daysOverdue >= threshold);
  }
  const agingSummary: Record<string, number> = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  bills.forEach((b) => { agingSummary[agingBucket(b.daysOverdue)] += b.amountOutstanding; });
  res.json({ bills, agingSummary, totalOutstanding: bills.reduce((s, b) => s + b.amountOutstanding, 0) });
});

// ---- Routes: Invoices (AR) ----

app.get("/api/invoices", (req, res) => {
  const { entityId, brandId, status } = req.query as any;
  let q = "SELECT * FROM invoices WHERE 1=1";
  const params: any[] = [];
  if (entityId) { q += " AND entityId = ?"; params.push(entityId); }
  if (brandId) { q += " AND brandId = ?"; params.push(brandId); }
  if (status) { q += " AND status = ?"; params.push(status); }
  q += " ORDER BY dueDate DESC";
  res.json(db.prepare(q).all(...params));
});

app.get("/api/invoices/:id", (req, res) => {
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  const payments = db.prepare("SELECT * FROM payment_records WHERE invoiceId = ? ORDER BY paymentDate DESC, id DESC").all(req.params.id);
  res.json({ ...invoice, payments });
});

app.post("/api/invoices", (req, res) => {
  try {
    res.json(createInvoice(req.body || {}));
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to create invoice" });
  }
});

app.put("/api/invoices/:id", (req, res) => {
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id) as any;
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  const d = req.body || {};
  db.prepare("UPDATE invoices SET customerName = ?, dueDate = ? WHERE id = ?").run(
    d.customerName ?? invoice.customerName,
    d.dueDate ?? invoice.dueDate,
    req.params.id,
  );
  res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id));
});

app.post("/api/invoices/:id/void", (req, res) => {
  try {
    res.json(voidInvoice(Number(req.params.id)));
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to void invoice" });
  }
});

app.post("/api/invoices/:id/payments", (req, res) => {
  try {
    res.json(applyPaymentToInvoice(Number(req.params.id), req.body || {}));
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to apply payment" });
  }
});

// Symmetric AR counterpart to /api/ap/outstanding — not explicitly listed in
// the task's route list (which only names ap/outstanding), but the same
// aging view is exactly as useful for receivables and the invoices table
// already carries every field needed. Added for parity, flagged in the
// tracker rather than left as a silent gap.
app.get("/api/ar/outstanding", (req, res) => {
  const { entityId, brandId, age } = req.query as any;
  let q = "SELECT * FROM invoices WHERE status IN ('PENDING','PARTIALLY_PAID')";
  const params: any[] = [];
  if (entityId) { q += " AND entityId = ?"; params.push(entityId); }
  if (brandId) { q += " AND brandId = ?"; params.push(brandId); }
  const today = todayIso();
  let invoices = (db.prepare(q).all(...params) as any[]).map((i) => ({ ...i, daysOverdue: daysOverdue(i.dueDate, today) }));
  if (age !== undefined) {
    const threshold = Number(age);
    invoices = invoices.filter((i) => i.daysOverdue >= threshold);
  }
  const agingSummary: Record<string, number> = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  invoices.forEach((i) => { agingSummary[agingBucket(i.daysOverdue)] += i.amountOutstanding; });
  res.json({ invoices, agingSummary, totalOutstanding: invoices.reduce((s, i) => s + i.amountOutstanding, 0) });
});

// ---- Routes: Payment Logs (read-only — see note in the tracker) ----
// No PUT/DELETE: a payment_records row always backs a Posted journal entry,
// so it follows the same "posted is immutable" principle as journal_lines
// (Phase 1.1). Correcting a mistaken payment is a reversal, not an edit —
// out of scope for this phase.

app.get("/api/payment-records", (req, res) => {
  const { billId, invoiceId } = req.query as any;
  let q = "SELECT * FROM payment_records WHERE 1=1";
  const params: any[] = [];
  if (billId) { q += " AND billId = ?"; params.push(billId); }
  if (invoiceId) { q += " AND invoiceId = ?"; params.push(invoiceId); }
  q += " ORDER BY paymentDate DESC, id DESC";
  res.json(db.prepare(q).all(...params));
});

app.get("/api/payment-records/:id", (req, res) => {
  const record = db.prepare("SELECT * FROM payment_records WHERE id = ?").get(req.params.id);
  if (!record) return res.status(404).json({ error: "Payment record not found" });
  res.json(record);
});

// ---- Routes: PK Treasury / Intercompany Recharges ----

app.get("/api/intercompany-recharges", (req, res) => {
  const { sourceEntityId, targetEntityId, status } = req.query as any;
  let q = "SELECT * FROM intercompany_recharges WHERE 1=1";
  const params: any[] = [];
  if (sourceEntityId) { q += " AND sourceEntityId = ?"; params.push(sourceEntityId); }
  if (targetEntityId) { q += " AND targetEntityId = ?"; params.push(targetEntityId); }
  if (status) { q += " AND status = ?"; params.push(status); }
  q += " ORDER BY createdAt DESC";
  res.json(db.prepare(q).all(...params));
});

app.post("/api/intercompany-recharges", (req, res) => {
  const d = req.body || {};
  if (!d.sourceEntityId || !d.targetEntityId || !d.fundRequiredAmount) {
    return res.status(400).json({ error: "sourceEntityId, targetEntityId and fundRequiredAmount are required" });
  }
  const r = db
    .prepare(
      `INSERT INTO intercompany_recharges (sourceEntityId, targetEntityId, targetBrandId, fundRequiredAmount, currency, purpose, status, billId)
       VALUES (?, ?, ?, ?, ?, ?, 'REQUESTED', ?)`,
    )
    .run(d.sourceEntityId, d.targetEntityId, d.targetBrandId || null, d.fundRequiredAmount, d.currency || "USD", d.purpose || "", d.billId || null);
  res.json(db.prepare("SELECT * FROM intercompany_recharges WHERE id = ?").get(r.lastInsertRowid));
});

// Status can only move REQUESTED -> APPROVED here; the SETTLED transition is
// only reachable through /settle below, since that's the only path that
// actually posts the double-entry the status is supposed to represent.
app.put("/api/intercompany-recharges/:id", (req, res) => {
  const recharge = db.prepare("SELECT * FROM intercompany_recharges WHERE id = ?").get(req.params.id) as any;
  if (!recharge) return res.status(404).json({ error: "Intercompany recharge not found" });
  const d = req.body || {};
  if (d.status === "SETTLED") {
    return res.status(400).json({ error: "Use POST /api/intercompany-recharges/:id/settle to settle a recharge" });
  }
  if (recharge.status === "SETTLED") {
    return res.status(409).json({ error: "This recharge is already settled and cannot be edited" });
  }
  const status = d.status === "APPROVED" ? "APPROVED" : recharge.status;
  db.prepare(
    "UPDATE intercompany_recharges SET targetBrandId = ?, fundRequiredAmount = ?, currency = ?, purpose = ?, status = ?, billId = ? WHERE id = ?",
  ).run(
    d.targetBrandId ?? recharge.targetBrandId,
    d.fundRequiredAmount ?? recharge.fundRequiredAmount,
    d.currency ?? recharge.currency,
    d.purpose ?? recharge.purpose,
    status,
    d.billId ?? recharge.billId,
    req.params.id,
  );
  res.json(db.prepare("SELECT * FROM intercompany_recharges WHERE id = ?").get(req.params.id));
});

app.post("/api/intercompany-recharges/:id/settle", (req, res) => {
  try {
    res.json(settleIntercompanyRecharge(Number(req.params.id), req.body || {}));
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Failed to settle recharge" });
  }
});

app.get("/api/intercompany/fund-required", (req, res) => {
  let pkEntity: any;
  try {
    pkEntity = requireEntityByName("PK");
  } catch {
    return res.json([]); // PK entity not seeded — empty, not an error
  }
  const rows = db
    .prepare(
      `SELECT r.*, e.name as targetEntityName, b.name as targetBrandName
       FROM intercompany_recharges r
       LEFT JOIN entities e ON e.id = r.targetEntityId
       LEFT JOIN brands b ON b.id = r.targetBrandId
       WHERE r.sourceEntityId = ? AND r.status IN ('REQUESTED','APPROVED')
       ORDER BY r.createdAt DESC`,
    )
    .all(pkEntity.id);
  res.json(rows);
});

// ======= BANK RECONCILIATION & PERIOD LOCKING (Phase 1.5) =======

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// Last calendar day of a "YYYY-MM" period, e.g. "2026-08" -> "2026-08-31".
// Jump to day 1 of the *next* month, then step back one day.
function monthEndDate(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  const firstOfNextMonth = new Date(Date.UTC(y, m, 1)); // JS Date months are 0-based, so month=m (not m-1) is already "next month"
  return addDays(firstOfNextMonth.toISOString().slice(0, 10), -1);
}

// The book balance of a GL account as of a given date (inclusive), in USD,
// derived purely from Posted journal_lines — never trusted from client
// input, per CLAUDE.md product rule 3. Debit − Credit is correct for an
// Asset/cash account (debit increases balance).
//
// `debit`/`credit` are stored in each line's ORIGINAL currency, with
// `exchangeRate` carrying that line's month-of-posting rate to USD, so the
// multiplication is what makes this figure actually USD (2026-09-11 fix).
// Without it this summed raw foreign-currency units while every caller —
// /api/accounts/balances, /api/banking/cards, the cash-flow beginning/
// ending balances — labelled the result USD. It only ever agreed because
// every line so far has been USD with exchangeRate 1; the first AED or PKR
// line would have silently mis-stated the Chart of Accounts balance
// column, the bank cards and the cash-flow statement. This now matches how
// summarizeByAccount and the Trial Balance have always computed it.
// `entityIds` (2026-09-17): when given, only entries booked in those entities
// count — so a Shared account's balance shown to an entity-restricted user
// never includes other entities' postings. null/undefined = all entities.
function computeGlAccountBalance(accountId: number, asOfDateInclusive: string, entityIds?: number[] | null): number {
  const entityClause = entityIds ? ` AND je.entityId IN (${entityIds.map(() => "?").join(",") || "NULL"})` : "";
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(jl.debit * COALESCE(jl.exchangeRate, 1)), 0)
            - COALESCE(SUM(jl.credit * COALESCE(jl.exchangeRate, 1)), 0) as bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
       WHERE jl.accountId = ? AND je.status = 'Posted' AND je.transactionDate <= ?${entityClause}`,
    )
    .get(accountId, asOfDateInclusive, ...(entityIds || [])) as { bal: number };
  return row.bal || 0;
}

// Same sign convention as bank_transactions.amount (positive = money in) for
// a line posted to a bank's own cash Asset account: a debit on that account
// is money in, a credit is money out.
function bankLineSignedAmount(line: any): number {
  return (line.debit || 0) - (line.credit || 0);
}

// The closest available proxy for "Reference/Check Number" matching (task
// item 2's algorithm): bank_transactions has no structured reference field
// in this schema, so this compares normalized description/memo text —
// reusing Phase 1.2's normalizeDescriptionForHash for one consistent
// normalization rule across the codebase.
function referenceLikelyMatches(bankTxnDescription: string, journalLineMemo: string): boolean {
  const btDesc = normalizeDescriptionForHash(bankTxnDescription || "");
  const jlMemo = normalizeDescriptionForHash(journalLineMemo || "");
  if (!btDesc || !jlMemo) return false;
  if (btDesc.includes(jlMemo) || jlMemo.includes(btDesc)) return true;
  return btDesc.split(" ").some((w) => w.length > 3 && jlMemo.includes(w));
}

// Auto-Matching Algorithm & Service (task item 2). Two tiers:
//   Tier 1 (EXACT): a bank_transaction already posted through Phase 1.3/1.4
//     (has journalEntryId) has a KNOWN, structurally guaranteed journal_line
//     on the bank's own GL cash account from that same journal entry — no
//     fuzzy logic needed, this is just looking up what already exists.
//   Tier 2 (SUGGESTED): remaining bank_transactions (still PENDING, never
//     posted) against remaining journal_lines on the bank's cash account
//     from ANY source (bill payments, intercompany settlements, manual
//     entries) — matched by exact amount + ±3-day date window (both hard
//     requirements per the task spec), scored by date proximity with a
//     bonus for description/memo overlap.
// Greedy, not globally optimal: processes bank transactions in date order
// and takes the best still-available candidate for each. A rare double
// hard-to-place case (two candidates equally good for two transactions)
// could pick sub-optimally; documented as a known limitation rather than
// implementing full bipartite matching, which is out of scope for this
// phase.
function autoMatchBankTransactions(reconciliationId: number, bankAccountId: number, startDate: string, endDate: string) {
  const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(bankAccountId) as any;
  if (!bankAccount) throw new PostingError(404, "Bank account not found");
  const bankGl = resolveBankGlAccount(bankAccount);
  if (!bankGl) throw new PostingError(400, "Could not resolve a GL cash account for this bank account");

  const alreadyMatchedBt = new Set(
    (db.prepare("SELECT DISTINCT bankTransactionId FROM reconciliation_matches WHERE bankTransactionId IS NOT NULL").all() as any[]).map(
      (r) => r.bankTransactionId,
    ),
  );
  const alreadyMatchedJl = new Set(
    (db.prepare("SELECT DISTINCT journalLineId FROM reconciliation_matches WHERE journalLineId IS NOT NULL").all() as any[]).map(
      (r) => r.journalLineId,
    ),
  );

  const bankTxns = (
    db
      .prepare("SELECT * FROM bank_transactions WHERE bankAccountId = ? AND transactionDate BETWEEN ? AND ? ORDER BY transactionDate")
      .all(bankAccountId, startDate, endDate) as any[]
  ).filter((t) => !alreadyMatchedBt.has(t.id));

  const journalLines = (
    db
      .prepare(
        `SELECT jl.*, je.transactionDate as jeTransactionDate
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
         WHERE jl.accountId = ? AND je.status = 'Posted' AND je.transactionDate BETWEEN ? AND ?`,
      )
      .all(bankGl.id, startDate, endDate) as any[]
  ).filter((l) => !alreadyMatchedJl.has(l.id));

  const usedJlIds = new Set<number>();
  const results: { bankTransactionId: number; journalLineId: number; matchType: string; matchScore: number }[] = [];

  // Tier 1: direct linkage via journalEntryId.
  for (const bt of bankTxns) {
    if (!bt.journalEntryId) continue;
    const direct = journalLines.find((l) => l.journalEntryId === bt.journalEntryId && !usedJlIds.has(l.id));
    if (direct) {
      results.push({ bankTransactionId: bt.id, journalLineId: direct.id, matchType: "EXACT", matchScore: 100 });
      usedJlIds.add(direct.id);
    }
  }

  // Tier 2: fuzzy match on the remainder.
  for (const bt of bankTxns) {
    if (results.some((r) => r.bankTransactionId === bt.id)) continue;
    let best: { line: any; score: number } | null = null;
    for (const jl of journalLines) {
      if (usedJlIds.has(jl.id)) continue;
      if (Math.abs(bankLineSignedAmount(jl) - bt.amount) > 0.005) continue; // exact amount match — hard requirement
      const dayDiff = Math.abs(daysBetween(bt.transactionDate, jl.jeTransactionDate));
      if (dayDiff > 3) continue; // ±3-day window — hard requirement
      let score = 100 - dayDiff * 15;
      if (referenceLikelyMatches(bt.description, jl.memo)) score = Math.min(100, score + 15);
      if (!best || score > best.score) best = { line: jl, score };
    }
    if (best) {
      results.push({ bankTransactionId: bt.id, journalLineId: best.line.id, matchType: "SUGGESTED", matchScore: Math.max(0, Math.min(100, best.score)) });
      usedJlIds.add(best.line.id);
    }
  }

  const insert = db.prepare(
    `INSERT INTO reconciliation_matches (reconciliationId, bankTransactionId, journalLineId, matchType, matchScore) VALUES (?, ?, ?, ?, ?)`,
  );
  const run = db.transaction(() => {
    for (const r of results) insert.run(reconciliationId, r.bankTransactionId, r.journalLineId, r.matchType, r.matchScore);
  });
  run();

  return db.prepare("SELECT * FROM reconciliation_matches WHERE reconciliationId = ? ORDER BY matchScore DESC").all(reconciliationId);
}

// Ending Statement Balance vs reconciled GL cash balance, and the variance
// between them (task item 4). variance ≈ 0 means every dollar on the bank
// statement is accounted for in the book as of the statement end date.
function computeReconciliationStatus(reconciliation: any) {
  const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(reconciliation.bankAccountId) as any;
  const bankGl = bankAccount ? resolveBankGlAccount(bankAccount) : null;
  const glEndingBalance = bankGl ? computeGlAccountBalance(bankGl.id, reconciliation.statementEndDate) : reconciliation.glEndingBalance;
  const variance = Number((reconciliation.statementEndingBalance - glEndingBalance).toFixed(6));
  const matchedCount = (
    db.prepare("SELECT COUNT(*) n FROM reconciliation_matches WHERE reconciliationId = ?").get(reconciliation.id) as { n: number }
  ).n;
  const unmatchedBankTransactions = db
    .prepare(
      `SELECT bt.* FROM bank_transactions bt
       WHERE bt.bankAccountId = ? AND bt.transactionDate BETWEEN ? AND ?
       AND bt.id NOT IN (SELECT bankTransactionId FROM reconciliation_matches WHERE bankTransactionId IS NOT NULL)`,
    )
    .all(reconciliation.bankAccountId, reconciliation.statementStartDate, reconciliation.statementEndDate);
  const unmatchedJournalLines = bankGl
    ? db
        .prepare(
          `SELECT jl.* FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
           WHERE jl.accountId = ? AND je.status = 'Posted' AND je.transactionDate BETWEEN ? AND ?
           AND jl.id NOT IN (SELECT journalLineId FROM reconciliation_matches WHERE journalLineId IS NOT NULL)`,
        )
        .all(bankGl.id, reconciliation.statementStartDate, reconciliation.statementEndDate)
    : [];
  return {
    reconciliationId: reconciliation.id,
    statementEndingBalance: reconciliation.statementEndingBalance,
    glEndingBalance,
    variance,
    isReconciled: Math.abs(variance) < 0.005,
    matchedCount,
    unmatchedBankTransactions,
    unmatchedJournalLines,
  };
}

// ---- Routes: Reconciliation sessions ----

app.get("/api/reconciliations", (req, res) => {
  const { bankAccountId, status } = req.query as any;
  let q = "SELECT * FROM reconciliations WHERE 1=1";
  const params: any[] = [];
  if (bankAccountId) { q += " AND bankAccountId = ?"; params.push(bankAccountId); }
  if (status) { q += " AND status = ?"; params.push(status); }
  q += " ORDER BY statementEndDate DESC";
  res.json(db.prepare(q).all(...params));
});

app.get("/api/reconciliations/:id", (req, res) => {
  const reconciliation = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(req.params.id) as any;
  if (!reconciliation) return res.status(404).json({ error: "Reconciliation not found" });
  const matches = db.prepare("SELECT * FROM reconciliation_matches WHERE reconciliationId = ?").all(req.params.id);
  res.json({ ...reconciliation, matches, ...computeReconciliationStatus(reconciliation) });
});

// GL starting/ending balances are always computed from transactional data,
// never accepted from the client, per CLAUDE.md product rule 3 — even
// though the task's own column list names them as stored fields, they are
// still a derived snapshot, not an independent source of truth.
app.post("/api/reconciliations", (req, res) => {
  const d = req.body || {};
  if (!d.bankAccountId || !d.statementStartDate || !d.statementEndDate) {
    return res.status(400).json({ error: "bankAccountId, statementStartDate and statementEndDate are required" });
  }
  const bankAccount = db.prepare("SELECT * FROM bank_accounts WHERE id = ?").get(d.bankAccountId) as any;
  if (!bankAccount) return res.status(400).json({ error: "Bank account not found" });
  const bankGl = resolveBankGlAccount(bankAccount);
  if (!bankGl) return res.status(400).json({ error: "Could not resolve a GL cash account for this bank account" });

  const glStartingBalance = computeGlAccountBalance(bankGl.id, addDays(d.statementStartDate, -1));
  const glEndingBalance = computeGlAccountBalance(bankGl.id, d.statementEndDate);

  const r = db
    .prepare(
      `INSERT INTO reconciliations (bankAccountId, statementStartDate, statementEndDate, statementStartingBalance, statementEndingBalance, glStartingBalance, glEndingBalance, status, reconciledBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
    )
    .run(
      d.bankAccountId,
      d.statementStartDate,
      d.statementEndDate,
      Number(d.statementStartingBalance) || 0,
      Number(d.statementEndingBalance) || 0,
      glStartingBalance,
      glEndingBalance,
      d.reconciledBy || "",
    );
  res.json(db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(r.lastInsertRowid));
});

app.post("/api/reconciliations/:id/auto-match", (req, res) => {
  const reconciliation = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(req.params.id) as any;
  if (!reconciliation) return res.status(404).json({ error: "Reconciliation not found" });
  if (reconciliation.status !== "DRAFT") return res.status(409).json({ error: "Only a DRAFT reconciliation can be auto-matched" });
  try {
    const matches = autoMatchBankTransactions(reconciliation.id, reconciliation.bankAccountId, reconciliation.statementStartDate, reconciliation.statementEndDate);
    res.json(matches);
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err.message || "Auto-match failed" });
  }
});

// A manual match — the user pairing a specific bank_transaction with a
// specific journal_line the auto-matcher didn't find (or didn't score
// highest). Always recorded as matchType MANUAL, score 100 (a human
// confirmed it).
app.post("/api/reconciliations/:id/matches", (req, res) => {
  const reconciliation = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(req.params.id) as any;
  if (!reconciliation) return res.status(404).json({ error: "Reconciliation not found" });
  if (reconciliation.status !== "DRAFT") return res.status(409).json({ error: "Cannot add matches to a non-DRAFT reconciliation" });
  const { bankTransactionId, journalLineId } = req.body || {};
  if (!bankTransactionId && !journalLineId) {
    return res.status(400).json({ error: "At least one of bankTransactionId or journalLineId is required" });
  }
  const r = db
    .prepare(`INSERT INTO reconciliation_matches (reconciliationId, bankTransactionId, journalLineId, matchType, matchScore) VALUES (?, ?, ?, 'MANUAL', 100)`)
    .run(req.params.id, bankTransactionId || null, journalLineId || null);
  res.json(db.prepare("SELECT * FROM reconciliation_matches WHERE id = ?").get(r.lastInsertRowid));
});

// Rejecting a bad suggestion — not explicitly requested by the task, but a
// reconciliation workspace where a wrong SUGGESTED match can never be
// un-done isn't usable. Added and flagged in the tracker like other
// additions in prior phases.
app.delete("/api/reconciliations/:id/matches/:matchId", (req, res) => {
  const reconciliation = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(req.params.id) as any;
  if (!reconciliation) return res.status(404).json({ error: "Reconciliation not found" });
  if (reconciliation.status !== "DRAFT") return res.status(409).json({ error: "Cannot remove matches from a non-DRAFT reconciliation" });
  db.prepare("DELETE FROM reconciliation_matches WHERE id = ? AND reconciliationId = ?").run(req.params.matchId, req.params.id);
  res.json({ ok: true });
});

app.post("/api/reconciliations/:id/complete", (req, res) => {
  const reconciliation = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(req.params.id) as any;
  if (!reconciliation) return res.status(404).json({ error: "Reconciliation not found" });
  if (reconciliation.status !== "DRAFT") return res.status(409).json({ error: "Only a DRAFT reconciliation can be completed" });
  const status = computeReconciliationStatus(reconciliation);
  if (!status.isReconciled) {
    return res.status(400).json({ error: `Cannot complete: variance is ${status.variance}, not zero`, ...status });
  }
  db.prepare("UPDATE reconciliations SET status = 'COMPLETED', completedAt = CURRENT_TIMESTAMP, reconciledBy = ? WHERE id = ?").run(
    req.body?.reconciledBy || reconciliation.reconciledBy || "",
    req.params.id,
  );
  res.json(db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(req.params.id));
});

// GET /api/reconciliation/status — task item 4. Accepts either
// reconciliationId (an existing session) or bankAccountId + statementEndDate
// (+ optional statementEndingBalance) for an ad-hoc check without a formal
// DRAFT session.
app.get("/api/reconciliation/status", (req, res) => {
  const { reconciliationId, bankAccountId, statementEndDate, statementEndingBalance, statementStartDate } = req.query as any;
  if (reconciliationId) {
    const reconciliation = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(reconciliationId) as any;
    if (!reconciliation) return res.status(404).json({ error: "Reconciliation not found" });
    return res.json(computeReconciliationStatus(reconciliation));
  }
  if (!bankAccountId || !statementEndDate) {
    return res.status(400).json({ error: "Provide reconciliationId, or bankAccountId and statementEndDate" });
  }
  const adHoc = {
    id: 0,
    bankAccountId: Number(bankAccountId),
    statementStartDate: statementStartDate || statementEndDate,
    statementEndDate,
    statementEndingBalance: Number(statementEndingBalance) || 0,
  };
  res.json(computeReconciliationStatus(adHoc));
});

// ---- Period locking ----

app.get("/api/accounting-periods", (req, res) => {
  const { entityId } = req.query as any;
  let q = "SELECT * FROM accounting_periods WHERE 1=1";
  const params: any[] = [];
  if (entityId) { q += " AND entityId = ?"; params.push(entityId); }
  q += " ORDER BY periodMonth DESC";
  res.json(db.prepare(q).all(...params));
});

// POST /api/reconciliation/lock-period — task item 4. A period locks only
// once EVERY bank account belonging to the entity has at least one COMPLETED
// (zero-variance) reconciliation covering that month — not just the one
// reconciliation happening to be in front of the user. Re-verifies variance
// at lock time too (not just trusting the earlier COMPLETED flag), so a
// match removed after completion can't silently slip through.
app.post("/api/reconciliation/lock-period", (req, res) => {
  const { entityId, periodMonth, lockedBy } = req.body || {};
  if (!entityId || !periodMonth) return res.status(400).json({ error: "entityId and periodMonth are required" });

  const bankAccounts = db.prepare("SELECT * FROM bank_accounts WHERE entityId = ? AND isActive = 1").all(entityId) as any[];
  const monthStart = `${periodMonth}-01`;
  const monthEnd = monthEndDate(periodMonth);

  const unreconciledAccounts: string[] = [];
  const completedReconciliationIds: number[] = [];
  for (const acct of bankAccounts) {
    const candidates = db
      .prepare(
        `SELECT * FROM reconciliations WHERE bankAccountId = ? AND status = 'COMPLETED' AND statementEndDate BETWEEN ? AND ?`,
      )
      .all(acct.id, monthStart, monthEnd) as any[];
    const stillZero = candidates.find((c) => computeReconciliationStatus(c).isReconciled);
    if (!stillZero) {
      unreconciledAccounts.push(acct.name);
    } else {
      completedReconciliationIds.push(stillZero.id);
    }
  }
  if (unreconciledAccounts.length > 0) {
    return res.status(400).json({
      error: `Cannot lock ${periodMonth}: the following bank accounts have no zero-variance COMPLETED reconciliation for this period: ${unreconciledAccounts.join(", ")}`,
    });
  }

  const run = db.transaction(() => {
    const existing = db.prepare("SELECT * FROM accounting_periods WHERE entityId = ? AND periodMonth = ?").get(entityId, periodMonth) as any;
    if (existing) {
      db.prepare("UPDATE accounting_periods SET isLocked = 1, lockedAt = CURRENT_TIMESTAMP, lockedBy = ? WHERE id = ?").run(lockedBy || "", existing.id);
    } else {
      db.prepare("INSERT INTO accounting_periods (entityId, periodMonth, isLocked, lockedAt, lockedBy) VALUES (?, ?, 1, CURRENT_TIMESTAMP, ?)").run(
        entityId,
        periodMonth,
        lockedBy || "",
      );
    }
    for (const id of completedReconciliationIds) {
      db.prepare("UPDATE reconciliations SET status = 'LOCKED' WHERE id = ?").run(id);
    }
  });
  run();

  res.json(db.prepare("SELECT * FROM accounting_periods WHERE entityId = ? AND periodMonth = ?").get(entityId, periodMonth));
});

// ======= LEGAL FINANCIAL STATEMENTS (Phase 1.6) =======
// The whole point of Phase 1 (CLAUDE.md §0): every number below is derived
// from Posted journal_lines, live, at request time — nothing here is ever
// stored. This is also the first code to read journal_lines at scale for
// reporting rather than posting, so it's the first real end-to-end test of
// whether the double-entry books built in Phases 1.1–1.5 actually produce a
// coherent set of financial statements.

// Multi-currency (task item 4): the task names a CurrencyFrom/CurrencyTo/
// EffectiveMonth/Rate shape, but that would be a SECOND exchange-rate table
// alongside the one already in production use since Phase 0 and relied on
// by Phase 1.3/1.4's resolveExchangeRate() — a straight violation of
// CLAUDE.md product rule 1 ("no number is entered twice"). This system only
// ever needs X-to-USD conversion (USD is the sole reporting currency per
// CLAUDE.md's Money section), so the existing exchange_rates(currency,
// rateToUsd, effectiveMonth) table already holds everything a pairwise
// table would, just without the redundant "CurrencyTo" column that's always
// implicitly USD here. Reused, not duplicated.
//
// Every journal_line's amountUSD was already fixed at posting time using
// the rate in effect THAT month (never re-derived later, per the same Money
// rule) — so the reports below always compute in USD first from that
// historically-correct figure, then apply ONE display conversion (latest
// available rate as of the report's end date) only if the caller asked for
// a non-USD presentation currency. This is a display convenience layered on
// top of historically-accurate USD figures, not a re-booking.
function latestRateToUsd(currency: string, asOfDate: string): { rate: number; found: boolean; effectiveMonth?: string } {
  if (currency === "USD") return { rate: 1, found: true };
  const month = asOfDate.slice(0, 7);
  const row = db
    .prepare("SELECT rateToUsd, effectiveMonth FROM exchange_rates WHERE currency = ? AND effectiveMonth <= ? ORDER BY effectiveMonth DESC LIMIT 1")
    .get(currency, month) as { rateToUsd: number; effectiveMonth: string } | undefined;
  return row ? { rate: row.rateToUsd, found: true, effectiveMonth: row.effectiveMonth } : { rate: 1, found: false };
}

function convertFromUsd(usdAmount: number, targetCurrency: string, asOfDate: string): { amount: number; rateFound: boolean } {
  if (targetCurrency === "USD") return { amount: usdAmount, rateFound: true };
  const { rate, found } = latestRateToUsd(targetCurrency, asOfDate);
  // Never silently produce a wrong number: if no rate is configured, return
  // the raw USD figure with rateFound:false rather than dividing by a
  // fabricated 1.0 and mislabeling it as the target currency.
  return found ? { amount: usdAmount / rate, rateFound: true } : { amount: usdAmount, rateFound: false };
}

// ---- Income Statement (task item 1) ----

type LedgerLineRow = {
  accountId: number;
  code: string;
  accountName: string;
  category: string;
  type: string;
  debit: number;
  credit: number;
  exchangeRate: number;
  // Each line's own posting date (2026-09-11: needed so report-level
  // display-currency translation can look up the exchange rate in effect
  // for THAT line's own month, not one blanket rate for the whole report —
  // see summarizeByAccountForDisplay below).
  transactionDate: string;
};

// `periodBasis` picks WHICH date the range filters on (2026-09-11):
//   'transaction' (default) — the statutory basis: when the cash moved.
//   'accounting'            — the management basis: the accountingPeriod
//                             the user assigned (YYYY-MM), for costs whose
//                             service month differs from their payment
//                             month. Falls back to the transaction month
//                             for rows that never had one set, so switching
//                             basis never makes a transaction disappear.
function queryPostedLines(filter: {
  accountTypes: string[];
  entityId?: number;
  brandId?: number;
  startDate?: string; // omit for "since inception"
  endDate: string;
  periodBasis?: "transaction" | "accounting";
}): LedgerLineRow[] {
  const byPeriod = filter.periodBasis === "accounting";
  // Compared as YYYY-MM against the period, or YYYY-MM-DD against the date.
  const dateExpr = byPeriod
    ? "COALESCE(je.accountingPeriod, substr(je.transactionDate,1,7))"
    : "je.transactionDate";
  const bound = (d: string) => (byPeriod ? String(d).slice(0, 7) : d);

  let q = `
    SELECT jl.accountId, a.code, a.name as accountName, a.category, a.type, jl.debit, jl.credit, jl.exchangeRate, je.transactionDate
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journalEntryId
    JOIN accounts a ON a.id = jl.accountId
    WHERE je.status = 'Posted' AND a.type IN (${filter.accountTypes.map(() => "?").join(",")})
      AND ${dateExpr} <= ?
  `;
  const params: any[] = [...filter.accountTypes, bound(filter.endDate)];
  if (filter.startDate) {
    q += ` AND ${dateExpr} >= ?`;
    params.push(bound(filter.startDate));
  }
  if (filter.entityId) {
    q += " AND je.entityId = ?";
    params.push(filter.entityId);
  }
  if (filter.brandId) {
    q += " AND jl.brandId = ?";
    params.push(filter.brandId);
  }
  return db.prepare(q).all(...params) as LedgerLineRow[];
}

// Nets a set of lines to a signed USD amount per account, respecting each
// account type's normal balance side (Revenue/Liability/Equity: credit
// increases; Asset/Expense: debit increases) — so a reversal/void (Phase
// 1.4's void posts the exact mirror image) correctly nets toward zero
// instead of double-counting.
function summarizeByAccount(rows: LedgerLineRow[]): { code: string; name: string; category: string; usdAmount: number }[] {
  const byAccount = new Map<number, { code: string; name: string; category: string; usdAmount: number }>();
  for (const r of rows) {
    const creditNormal = r.type === "Revenue" || r.type === "Liability" || r.type === "Equity";
    const signedOriginal = creditNormal ? r.credit - r.debit : r.debit - r.credit;
    const signedUsd = signedOriginal * (r.exchangeRate || 1);
    const existing = byAccount.get(r.accountId);
    if (existing) existing.usdAmount += signedUsd;
    else byAccount.set(r.accountId, { code: r.code, name: r.accountName, category: r.category, usdAmount: signedUsd });
  }
  return [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function computeNetIncomeUsd(entityId: number | undefined, brandId: number | undefined, startDate: string | undefined, endDate: string): number {
  const rows = queryPostedLines({ accountTypes: ["Revenue", "Expense"], entityId, brandId, startDate, endDate });
  const revenue = rows.filter((r) => r.type === "Revenue");
  const expense = rows.filter((r) => r.type === "Expense");
  const revTotal = summarizeByAccount(revenue).reduce((s, a) => s + a.usdAmount, 0);
  const expTotal = summarizeByAccount(expense).reduce((s, a) => s + a.usdAmount, 0);
  return revTotal - expTotal;
}

// Month-accurate display-currency translation (2026-09-11): the true,
// historically-fixed USD figure per account is unchanged (never re-derived
// — CLAUDE.md Money rule), but when the caller also wants the report shown
// in a non-USD currency, each individual line is translated using the
// exchange rate in effect for THAT line's own transactionDate/month
// (falling back to the most recent earlier month with a configured rate,
// via convertFromUsd -> latestRateToUsd), and only THEN summed per account
// — instead of summing every line in USD first and applying one blanket
// rate (e.g. the report's end date) to the whole period. A report spanning
// several months where the rate moved would otherwise silently misstate
// every month except the last. rateFound is false if any line's month (or
// any earlier month) never had a rate configured for that currency.
function summarizeByAccountForDisplay(
  rows: LedgerLineRow[],
  displayCurrency: string,
): { accounts: { accountId: number; code: string; name: string; category: string; usdAmount: number; amount: number }[]; rateFound: boolean } {
  // accountId is carried so statements can drill down (e.g. AR/AP → sub-ledger).
  const byAccount = new Map<number, { accountId: number; code: string; name: string; category: string; usdAmount: number; amount: number }>();
  let rateFound = true;
  for (const r of rows) {
    const creditNormal = r.type === "Revenue" || r.type === "Liability" || r.type === "Equity";
    const signedOriginal = creditNormal ? r.credit - r.debit : r.debit - r.credit;
    const signedUsd = signedOriginal * (r.exchangeRate || 1);
    const converted = convertFromUsd(signedUsd, displayCurrency, r.transactionDate);
    if (!converted.rateFound) rateFound = false;
    const existing = byAccount.get(r.accountId);
    if (existing) {
      existing.usdAmount += signedUsd;
      existing.amount += converted.amount;
    } else {
      byAccount.set(r.accountId, { accountId: r.accountId, code: r.code, name: r.accountName, category: r.category, usdAmount: signedUsd, amount: converted.amount });
    }
  }
  return { accounts: [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code)), rateFound };
}

function computeNetIncomeForDisplay(
  entityId: number | undefined,
  brandId: number | undefined,
  startDate: string | undefined,
  endDate: string,
  displayCurrency: string,
): { amount: number; rateFound: boolean } {
  const rows = queryPostedLines({ accountTypes: ["Revenue", "Expense"], entityId, brandId, startDate, endDate });
  const revenue = summarizeByAccountForDisplay(rows.filter((r) => r.type === "Revenue"), displayCurrency);
  const expense = summarizeByAccountForDisplay(rows.filter((r) => r.type === "Expense"), displayCurrency);
  const revTotal = revenue.accounts.reduce((s, a) => s + a.amount, 0);
  const expTotal = expense.accounts.reduce((s, a) => s + a.amount, 0);
  return { amount: revTotal - expTotal, rateFound: revenue.rateFound && expense.rateFound };
}

app.get("/api/reports/income-statement", (req, res) => {
  const { entityId, brandId, startDate, endDate, currency, periodBasis } = req.query as any;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate are required" });
  const displayCurrency = currency || "USD";
  const basis: "transaction" | "accounting" = periodBasis === "accounting" ? "accounting" : "transaction";

  const rows = queryPostedLines({
    accountTypes: ["Revenue", "Expense"],
    entityId: entityId ? Number(entityId) : undefined,
    brandId: brandId ? Number(brandId) : undefined,
    startDate,
    endDate,
    periodBasis: basis,
  });
  // Month-accurate translation (2026-09-11): each line is converted to the
  // display currency using the rate in effect for its OWN transaction
  // month (summarizeByAccountForDisplay), not one blanket rate for the
  // whole report period — see that function's comment for why.
  const revenueSummary = summarizeByAccountForDisplay(rows.filter((r) => r.type === "Revenue"), displayCurrency);
  // COGS vs Operating Expenses split by category (see the migration note
  // above) — anything not explicitly "Cost of Goods Sold" is Operating,
  // so an uncategorized future expense account is never silently dropped
  // from the statement.
  const cogsSummary = summarizeByAccountForDisplay(rows.filter((r) => r.type === "Expense" && r.category === "Cost of Goods Sold"), displayCurrency);
  const opexSummary = summarizeByAccountForDisplay(rows.filter((r) => r.type === "Expense" && r.category !== "Cost of Goods Sold"), displayCurrency);

  const totalGrossRevenue = revenueSummary.accounts.reduce((s, a) => s + a.amount, 0);
  const totalCogs = cogsSummary.accounts.reduce((s, a) => s + a.amount, 0);
  const grossProfit = totalGrossRevenue - totalCogs;
  const totalOperatingExpenses = opexSummary.accounts.reduce((s, a) => s + a.amount, 0);
  const netOperatingIncome = grossProfit - totalOperatingExpenses;
  const rateFound = revenueSummary.rateFound && cogsSummary.rateFound && opexSummary.rateFound;

  res.json({
    entityId: entityId ? Number(entityId) : null,
    brandId: brandId ? Number(brandId) : null,
    startDate,
    endDate,
    currency: displayCurrency,
    periodBasis: basis,
    rateFound,
    revenue: { accounts: revenueSummary.accounts, total: totalGrossRevenue },
    costOfGoodsSold: { accounts: cogsSummary.accounts, total: totalCogs },
    grossProfit,
    operatingExpenses: { accounts: opexSummary.accounts, total: totalOperatingExpenses },
    netOperatingIncome,
  });
});

// ---- Balance Sheet (task item 2) ----

app.get("/api/reports/balance-sheet", (req, res) => {
  const { entityId, asOfDate, currency } = req.query as any;
  if (!asOfDate) return res.status(400).json({ error: "asOfDate is required" });
  const displayCurrency = currency || "USD";
  const entId = entityId ? Number(entityId) : undefined;

  const assetLiabRows = queryPostedLines({ accountTypes: ["Asset", "Liability"], entityId: entId, endDate: asOfDate });
  let assetSummary = summarizeByAccountForDisplay(assetLiabRows.filter((r) => r.type === "Asset"), displayCurrency);
  let liabilitySummary = summarizeByAccountForDisplay(assetLiabRows.filter((r) => r.type === "Liability"), displayCurrency);
  let assetRows = assetSummary.accounts;
  let liabilityRows = liabilitySummary.accounts;

  // Consolidation eliminations (2026-09-10 "Advanced Posting Engine" task
  // item 4): only in the CONSOLIDATED view (no entityId filter) — a
  // single entity's own Due From/Due To Affiliates balance is real from
  // that entity's own books and stays on its own balance sheet. Every
  // cross-brand split posts an equal-and-opposite pair (see
  // postBankTransactionToGLSplit), so summed across the whole group the
  // "Intercompany Clearing" sub-type accounts should always net to ~$0 —
  // reported honestly (not forced to exactly 0) so a real posting bug
  // would surface here rather than being silently hidden.
  let eliminations: { intercompanyAssetsUsd: number; intercompanyLiabilitiesUsd: number; netUsd: number; intercompanyAssets: number; intercompanyLiabilities: number; net: number } | null = null;
  if (!entId) {
    const icClearingCodes = new Set(
      (db.prepare("SELECT code FROM accounts WHERE subType = 'Intercompany Clearing'").all() as { code: string }[]).map((r) => r.code),
    );
    const icAssetRows = assetRows.filter((a) => icClearingCodes.has(a.code));
    const icLiabilityRows = liabilityRows.filter((a) => icClearingCodes.has(a.code));
    const intercompanyAssetsUsd = icAssetRows.reduce((s, a) => s + a.usdAmount, 0);
    const intercompanyLiabilitiesUsd = icLiabilityRows.reduce((s, a) => s + a.usdAmount, 0);
    const intercompanyAssets = icAssetRows.reduce((s, a) => s + a.amount, 0);
    const intercompanyLiabilities = icLiabilityRows.reduce((s, a) => s + a.amount, 0);
    eliminations = {
      intercompanyAssetsUsd,
      intercompanyLiabilitiesUsd,
      netUsd: intercompanyAssetsUsd - intercompanyLiabilitiesUsd,
      intercompanyAssets,
      intercompanyLiabilities,
      net: intercompanyAssets - intercompanyLiabilities,
    };
    const icCodes = new Set([...icAssetRows, ...icLiabilityRows].map((a) => a.code));
    assetRows = assetRows.filter((a) => !icCodes.has(a.code));
    liabilityRows = liabilityRows.filter((a) => !icCodes.has(a.code));
  }

  const equityDirectSummary = summarizeByAccountForDisplay(queryPostedLines({ accountTypes: ["Equity"], entityId: entId, endDate: asOfDate }), displayCurrency);
  const equityDirectRows = equityDirectSummary.accounts;
  const ownersEquityUsd = equityDirectRows.reduce((s, a) => s + a.usdAmount, 0);
  const ownersEquity = equityDirectRows.reduce((s, a) => s + a.amount, 0);
  // Retained Earnings is never posted to directly (no period-close/sweep
  // mechanism exists yet) — computed dynamically as cumulative net income
  // since inception, exactly as the task specifies. "Since inception" =
  // no startDate bound, matching queryPostedLines' documented open-start
  // behavior. Kept in USD (computeNetIncomeUsd) for the Assets ==
  // Liabilities + Equity identity check below, and separately translated
  // month-by-month (computeNetIncomeForDisplay) for the figure actually
  // shown to the user.
  const retainedEarningsUsd = computeNetIncomeUsd(entId, undefined, undefined, asOfDate);
  const retainedEarningsDisplay = computeNetIncomeForDisplay(entId, undefined, undefined, asOfDate, displayCurrency);
  const retainedEarnings = retainedEarningsDisplay.amount;

  const totalAssetsUsd = assetRows.reduce((s, a) => s + a.usdAmount, 0);
  const totalLiabilitiesUsd = liabilityRows.reduce((s, a) => s + a.usdAmount, 0);
  const totalEquityUsd = ownersEquityUsd + retainedEarningsUsd;
  const totalAssets = assetRows.reduce((s, a) => s + a.amount, 0);
  const totalLiabilities = liabilityRows.reduce((s, a) => s + a.amount, 0);
  const totalEquity = ownersEquity + retainedEarnings;
  // Verification check (task item 2): Assets == Liabilities + Equity. This
  // is a mathematical identity given the Phase 1.1 balance trigger — every
  // journal entry sums to zero, so summed across every account type in or
  // out of scope, Assets always equals Liabilities + Equity exactly IN USD.
  // A non-zero USD variance here would mean a real bug in this computation
  // (a sign error, a scope mismatch), not a bookkeeping error — reported
  // honestly either way, not asserted away. Eliminated intercompany
  // balances are removed from BOTH sides equally (assets and liabilities),
  // so this identity still holds exactly in the consolidated view too.
  //
  // This no longer holds exactly once translated to a non-USD display
  // currency (2026-09-11 month-accurate translation): each account's own
  // lines are converted using the rate in effect for THEIR own months, so
  // Assets/Liabilities/Equity — each drawing from a different mix of
  // historical months — can land on slightly different effective blended
  // rates. That is real, expected FX translation variance (this system has
  // no Currency Translation Adjustment plug account), not a books error —
  // so the "balanced" verification always checks the USD figures (exact),
  // and the display-currency gap is surfaced separately, honestly, as
  // translationVariance rather than folded into "balanced".
  const varianceUsd = Number((totalAssetsUsd - (totalLiabilitiesUsd + totalEquityUsd)).toFixed(6));
  const translationVariance = Number((totalAssets - (totalLiabilities + totalEquity)).toFixed(6));
  const rateFound = assetSummary.rateFound && liabilitySummary.rateFound && equityDirectSummary.rateFound && retainedEarningsDisplay.rateFound;

  res.json({
    entityId: entId ?? null,
    asOfDate,
    currency: displayCurrency,
    rateFound,
    assets: { accounts: assetRows, total: totalAssets },
    liabilities: { accounts: liabilityRows, total: totalLiabilities },
    equity: {
      ownersEquity,
      retainedEarnings,
      total: totalEquity,
    },
    eliminations: eliminations && {
      intercompanyAssets: eliminations.intercompanyAssets,
      intercompanyLiabilities: eliminations.intercompanyLiabilities,
      net: eliminations.net,
      eliminated: Math.abs(eliminations.netUsd) < 0.01,
    },
    verification: {
      balanced: Math.abs(varianceUsd) < 0.005,
      variance: displayCurrency === "USD" ? varianceUsd : translationVariance,
      translationVariance: displayCurrency === "USD" ? 0 : translationVariance,
    },
  });
});

// ---- Trial Balance (2026-09-11, statutory navigation) ----
// The classic proof-of-books listing: every account carrying a balance,
// netted onto whichever side it lands on. The debit column total must
// equal the credit column total — an identity guaranteed by the Phase 1.1
// balance trigger, reported honestly rather than forced, so a genuine
// posting bug would surface here instead of being hidden.
//
// Stated in USD only. This is a proof of the ledger itself, not a
// presentation statement, so unlike the P&L/Balance Sheet it is not
// re-translated into a display currency — USD is the functional reporting
// currency of the books (CLAUDE.md Money).
app.get("/api/reports/trial-balance", (req, res) => {
  const { entityId, startDate, endDate } = req.query as any;
  const asOf = endDate || todayIso();
  let q = `
    SELECT a.id as accountId, a.code, a.name, a.type, a.subType, a.category,
      COALESCE(SUM(jl.debit * COALESCE(jl.exchangeRate, 1)), 0) as totalDebit,
      COALESCE(SUM(jl.credit * COALESCE(jl.exchangeRate, 1)), 0) as totalCredit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journalEntryId
    JOIN accounts a ON a.id = jl.accountId
    WHERE je.status = 'Posted' AND je.transactionDate <= ?
  `;
  const params: any[] = [asOf];
  if (startDate) {
    q += " AND je.transactionDate >= ?";
    params.push(startDate);
  }
  if (entityId) {
    q += " AND je.entityId = ?";
    params.push(Number(entityId));
  }
  q += " GROUP BY a.id ORDER BY a.code";

  const accounts = (db.prepare(q).all(...params) as any[])
    .map((r) => {
      const net = r.totalDebit - r.totalCredit;
      return { ...r, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
    })
    // An account whose debits and credits cancel exactly carries no
    // balance — it belongs in the General Ledger detail, not on a trial
    // balance.
    .filter((r) => r.debit > 0.0000001 || r.credit > 0.0000001);

  const totalDebit = accounts.reduce((s, a) => s + a.debit, 0);
  const totalCredit = accounts.reduce((s, a) => s + a.credit, 0);
  const variance = Number((totalDebit - totalCredit).toFixed(6));

  res.json({
    entityId: entityId ? Number(entityId) : null,
    startDate: startDate || null,
    endDate: asOf,
    currency: "USD",
    accounts,
    totals: { debit: totalDebit, credit: totalCredit },
    verification: { balanced: Math.abs(variance) < 0.005, variance },
  });
});

// ---- General Ledger (2026-09-11, statutory navigation) ----
// Account-by-account posting detail: for each account with activity in the
// range, its opening balance, every posted line in date order with a
// running balance, and its closing balance. Uses the same
// debit-minus-credit convention as computeGlAccountBalance, so an
// account's closing figure here always ties back to its Chart of Accounts
// balance and to the Trial Balance above.
app.get("/api/reports/general-ledger", (req, res) => {
  const { entityId, accountId, startDate, endDate, periodBasis } = req.query as any;
  const asOf = endDate || todayIso();
  const from = startDate || null;
  // See queryPostedLines for what the two bases mean.
  const byPeriod = periodBasis === "accounting";
  const dateExpr = byPeriod
    ? "COALESCE(je.accountingPeriod, substr(je.transactionDate,1,7))"
    : "je.transactionDate";
  const bound = (d: string) => (byPeriod ? String(d).slice(0, 7) : d);

  let q = `
    SELECT jl.id as lineId, jl.accountId, jl.debit, jl.credit, jl.exchangeRate, jl.memo, jl.brandId,
           a.code, a.name as accountName, a.type, a.subType, a.entityId as accountEntityId,
           je.id as journalEntryId, je.entryNumber, je.transactionDate, je.description, je.reference, je.entityId,
           je.accountingPeriod, je.chargedToEntityId, je.source,
           jl.contactId, ct.name as contactName, ct.contactType
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journalEntryId
    JOIN accounts a ON a.id = jl.accountId
    LEFT JOIN contacts ct ON ct.id = jl.contactId
    WHERE je.status = 'Posted' AND ${dateExpr} <= ?
  `;
  const params: any[] = [bound(asOf)];
  if (from) {
    q += ` AND ${dateExpr} >= ?`;
    params.push(bound(from));
  }
  if (entityId) {
    q += " AND je.entityId = ?";
    params.push(Number(entityId));
  }
  if (accountId) {
    q += " AND jl.accountId = ?";
    params.push(Number(accountId));
  }
  q += " ORDER BY a.code, je.transactionDate, je.id, jl.id";
  const rows = db.prepare(q).all(...params) as any[];

  // Opening balance = everything posted strictly BEFORE the range start.
  // With no start date the range is open at the left, so opening is 0 by
  // definition (nothing precedes "since inception").
  const openingSql =
    `SELECT COALESCE(SUM(jl.debit * COALESCE(jl.exchangeRate,1)),0) - COALESCE(SUM(jl.credit * COALESCE(jl.exchangeRate,1)),0) as bal
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
     WHERE jl.accountId = ? AND je.status = 'Posted' AND je.transactionDate < ?` +
    (entityId ? " AND je.entityId = ?" : "");
  const openingStmt = db.prepare(openingSql);

  // The "Split" column of a Transaction Detail by Account report: the other
  // account(s) the same entry touched. One other account shows that
  // account's name; several show "-SPLIT-", the convention QuickBooks uses
  // and the one an accountant reading this report expects. Derived per
  // entry, cached so a 50-line entry is looked up once.
  const splitStmt = db.prepare(
    `SELECT jl.accountId, a.code, a.name FROM journal_lines jl
     JOIN accounts a ON a.id = jl.accountId
     WHERE jl.journalEntryId = ? ORDER BY jl.id`,
  );
  const splitCache = new Map<number, { accountId: number; code: string; name: string }[]>();
  const splitsFor = (journalEntryId: number) => {
    if (!splitCache.has(journalEntryId)) {
      const seen = new Set<number>();
      splitCache.set(
        journalEntryId,
        (splitStmt.all(journalEntryId) as any[])
          .filter((l) => !seen.has(l.accountId) && seen.add(l.accountId))
          .map((l) => ({ accountId: l.accountId, code: l.code, name: l.name })),
      );
    }
    return splitCache.get(journalEntryId)!;
  };

  const byAccount = new Map<number, any>();
  for (const r of rows) {
    if (!byAccount.has(r.accountId)) {
      const openingArgs = entityId ? [r.accountId, from, Number(entityId)] : [r.accountId, from];
      const opening = from ? ((openingStmt.get(...openingArgs) as any).bal || 0) : 0;
      byAccount.set(r.accountId, {
        accountId: r.accountId,
        code: r.code,
        name: r.accountName,
        type: r.type,
        subType: r.subType,
        // The HEAD's own ownership (null = Shared / Global), shown as a badge
        // beside the account title — not the entity of any one posting.
        entityId: r.accountEntityId ?? null,
        openingBalance: opening,
        closingBalance: opening,
        lines: [],
      });
    }
    const acct = byAccount.get(r.accountId)!;
    const rate = r.exchangeRate || 1;
    const debit = r.debit * rate;
    const credit = r.credit * rate;
    acct.closingBalance += debit - credit;
    acct.lines.push({
      lineId: r.lineId,
      journalEntryId: r.journalEntryId,
      entryNumber: r.entryNumber,
      transactionDate: r.transactionDate,
      // What the line itself says (its memo, else the entry's header memo),
      // plus the header memo on its own so an audit trail can always show
      // the entry summary next to a line-specific memo.
      description: r.memo || r.description,
      lineMemo: r.memo || '',
      entryDescription: r.description || '',
      reference: r.reference,
      entityId: r.entityId,
      brandId: r.brandId,
      accountingPeriod: r.accountingPeriod || String(r.transactionDate).slice(0, 7),
      chargedToEntityId: r.chargedToEntityId,
      contactId: r.contactId,
      contactName: r.contactName,
      contactType: r.contactType,
      // Where this line came from, in the "Transaction Type" sense: a bank
      // feed posting, a manual journal, an import.
      transactionType: r.source || "Manual",
      splitAccounts: splitsFor(r.journalEntryId).filter((s) => s.accountId !== r.accountId),
      debit,
      credit,
      runningBalance: acct.closingBalance,
    });
  }

  res.json({
    entityId: entityId ? Number(entityId) : null,
    accountId: accountId ? Number(accountId) : null,
    startDate: from,
    endDate: asOf,
    currency: "USD",
    accounts: [...byAccount.values()],
  });
});

// ---- Statement of Cash Flows (task item 3) ----

// Direct method, derived from the actual GL structure rather than an
// invented category: for every journal_line posted to a Cash & Equivalents
// account, the OTHER line(s) in that same journal entry say what the money
// was actually for, and that tells you the activity:
//   Revenue/Expense counterparty, or AR/AP working-capital counterparty
//     -> Operating (day-to-day business)
//   Intercompany Receivable/Payable, or Owner's Equity counterparty
//     -> Financing (treasury/funding movements between entities or owners
//        — matches the "PK Treasury" framing already established in
//        Phase 1.4)
//   Anything else (e.g. a future Fixed Assets/Investments account — none
//     seeded yet, but the classification supports it once one exists)
//     -> Investing
// Every posting function in this codebase creates exactly 2 lines per
// entry, so "the other line" is unambiguous today; a future entry with
// more than 2 lines uses the first non-cash sibling, which is the correct
// call for how this system currently only ever posts.
function classifyCashFlowActivity(counterparty: { type: string; category: string } | undefined): "Operating" | "Investing" | "Financing" {
  if (!counterparty) return "Operating";
  if (counterparty.type === "Revenue" || counterparty.type === "Expense") return "Operating";
  if (counterparty.category === "Receivables" || counterparty.category === "Payables") return "Operating";
  if (counterparty.category === "Intercompany" || counterparty.category === "Equity") return "Financing";
  if (counterparty.category === "Cash & Equivalents") return "Operating"; // bank-to-bank transfer edge case
  return "Investing";
}

app.get("/api/reports/cash-flow", (req, res) => {
  const { entityId, brandId, startDate, endDate, currency } = req.query as any;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate are required" });
  const displayCurrency = currency || "USD";
  const entId = entityId ? Number(entityId) : undefined;

  let cashAcctQ = "SELECT * FROM accounts WHERE category = 'Cash & Equivalents' AND isActive = 1";
  const cashAcctParams: any[] = [];
  if (entId) {
    cashAcctQ += " AND entityId = ?";
    cashAcctParams.push(entId);
  }
  const cashAccounts = db.prepare(cashAcctQ).all(...cashAcctParams) as any[];
  const cashAccountIds = new Set(cashAccounts.map((a) => a.id));

  const buckets: Record<"Operating" | "Investing" | "Financing", number> = { Operating: 0, Investing: 0, Financing: 0 };
  const bucketsUsd: Record<"Operating" | "Investing" | "Financing", number> = { Operating: 0, Investing: 0, Financing: 0 };
  const detail: Record<"Operating" | "Investing" | "Financing", any[]> = { Operating: [], Investing: [], Financing: [] };
  let cashLinesRateFound = true;

  if (cashAccountIds.size > 0) {
    let q = `
      SELECT jl.id, jl.journalEntryId, jl.debit, jl.credit, jl.exchangeRate, je.transactionDate, je.description
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
      WHERE je.status = 'Posted' AND jl.accountId IN (${[...cashAccountIds].join(",")})
        AND je.transactionDate BETWEEN ? AND ?
    `;
    const qp: any[] = [startDate, endDate];
    if (entId) { q += " AND je.entityId = ?"; qp.push(entId); }
    if (brandId) { q += " AND jl.brandId = ?"; qp.push(Number(brandId)); }
    const cashLines = db.prepare(q).all(...qp) as any[];

    const siblingStmt = db.prepare(
      `SELECT jl2.accountId, a.type, a.category, a.name
       FROM journal_lines jl2 JOIN accounts a ON a.id = jl2.accountId
       WHERE jl2.journalEntryId = ? AND jl2.id != ?`,
    );

    // Month-accurate translation (2026-09-11): buckets accumulate in BOTH
    // USD (unchanged — used for the reconciles identity check below, which
    // must stay exact) and the display currency, where each cash line is
    // converted using the rate for its OWN transactionDate/month rather
    // than one blanket rate for the whole report period.
    for (const cl of cashLines) {
      const netCashUsd = (cl.debit - cl.credit) * (cl.exchangeRate || 1); // positive = cash in
      const converted = convertFromUsd(netCashUsd, displayCurrency, cl.transactionDate);
      if (!converted.rateFound) cashLinesRateFound = false;
      const siblings = siblingStmt.all(cl.journalEntryId, cl.id) as any[];
      const counterparty = siblings.find((s) => !cashAccountIds.has(s.accountId)) || siblings[0];
      const activity = classifyCashFlowActivity(counterparty);
      bucketsUsd[activity] += netCashUsd;
      buckets[activity] += converted.amount;
      detail[activity].push({
        journalEntryId: cl.journalEntryId,
        transactionDate: cl.transactionDate,
        description: cl.description,
        counterpartyAccount: counterparty?.name || null,
        amountUsd: netCashUsd,
        amount: converted.amount,
      });
    }
  }

  const netChangeInCashUsd = bucketsUsd.Operating + bucketsUsd.Investing + bucketsUsd.Financing;
  const netChangeInCash = buckets.Operating + buckets.Investing + buckets.Financing;
  const beginningCashUsd = [...cashAccountIds].reduce((s, id) => s + computeGlAccountBalance(id, addDays(startDate, -1)), 0);
  const endingCashComputedUsd = [...cashAccountIds].reduce((s, id) => s + computeGlAccountBalance(id, endDate), 0);
  // Consistency check: the change implied by classified cash movements must
  // equal the actual change in the cash account balances — every cash-
  // account journal_line in range is either classified or the sets
  // wouldn't agree. Always checked in USD (exact); display-currency figures
  // are a translation layered on top for presentation only.
  const reconciles = Math.abs(beginningCashUsd + netChangeInCashUsd - endingCashComputedUsd) < 0.005;

  // Beginning/ending cash are point-in-time balances (not flows), so — like
  // the Balance Sheet — each is translated using the single rate as of its
  // own snapshot date, not a per-line breakdown.
  const conv = (usd: number, asOf: string) => convertFromUsd(usd, displayCurrency, asOf).amount;
  const beginningCash = conv(beginningCashUsd, addDays(startDate, -1));
  const endingCashComputed = conv(endingCashComputedUsd, endDate);
  const rateFound =
    cashLinesRateFound &&
    convertFromUsd(0, displayCurrency, addDays(startDate, -1)).rateFound &&
    convertFromUsd(0, displayCurrency, endDate).rateFound;

  res.json({
    entityId: entId ?? null,
    brandId: brandId ? Number(brandId) : null,
    startDate,
    endDate,
    currency: displayCurrency,
    rateFound,
    operatingActivities: { total: buckets.Operating, lines: detail.Operating },
    investingActivities: { total: buckets.Investing, lines: detail.Investing },
    financingActivities: { total: buckets.Financing, lines: detail.Financing },
    netChangeInCash,
    beginningCashBalance: beginningCash,
    endingCashBalance: endingCashComputed,
    verification: { reconciles },
  });
});

// ---- Phase 2: Grouped Management Reporting & Analytics ----
// Every endpoint below reads exclusively from posted journal_lines via the
// same queryPostedLines/summarizeByAccount/convertFromUsd building blocks
// used by the Phase 1.6 legal statements above (CLAUDE.md rule 3: reports
// are always derived from transactional data, never a stored figure). None
// of this touches the legacy revenue/expenses single-entry tables.

// Same as queryPostedLines but also returns each line's transactionDate, so
// callers can bucket by month. Kept separate rather than adding an optional
// field to the existing LedgerLineRow — every current caller of
// queryPostedLines (income statement, balance sheet, cash flow) has no use
// for a per-line date and shouldn't pay for selecting it.
function queryPostedLinesMonthly(filter: {
  accountTypes: string[];
  entityId?: number;
  brandId?: number;
  startDate?: string;
  endDate: string;
}): (LedgerLineRow & { transactionDate: string; journalLineId: number })[] {
  let q = `
    SELECT jl.id as journalLineId, jl.accountId, a.code, a.name as accountName, a.category, a.type, jl.debit, jl.credit, jl.exchangeRate, je.transactionDate
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journalEntryId
    JOIN accounts a ON a.id = jl.accountId
    WHERE je.status = 'Posted' AND a.type IN (${filter.accountTypes.map(() => "?").join(",")})
      AND je.transactionDate <= ?
  `;
  const params: any[] = [...filter.accountTypes, filter.endDate];
  if (filter.startDate) {
    q += " AND je.transactionDate >= ?";
    params.push(filter.startDate);
  }
  if (filter.entityId) {
    q += " AND je.entityId = ?";
    params.push(filter.entityId);
  }
  if (filter.brandId) {
    q += " AND jl.brandId = ?";
    params.push(filter.brandId);
  }
  return db.prepare(q).all(...params) as any[];
}

// Same normal-balance-side netting as summarizeByAccount, bucketed first by
// calendar month — but this is the MANAGEMENT-books bucketing (task's
// "Section 2"): a line with rows in journal_line_allocations is spread
// across its incurred months instead of landing entirely in its own
// journal_entries.transactionDate month. A line with no allocation rows
// (the common case — most transactions aren't amortized) falls back to the
// original transactionDate-month behavior exactly as before, so this is
// backward compatible for every report built before amortization existed.
function summarizeByMonthAndAccount(
  rows: (LedgerLineRow & { transactionDate: string; journalLineId: number })[],
): Map<string, Map<number, { code: string; name: string; category: string; type: string; usdAmount: number }>> {
  const lineIds = [...new Set(rows.map((r) => r.journalLineId))];
  const allocationsByLine = new Map<number, { month: string; amountUSD: number }[]>();
  if (lineIds.length > 0) {
    const allocRows = db
      .prepare(`SELECT journalLineId, month, amountUSD FROM journal_line_allocations WHERE journalLineId IN (${lineIds.map(() => "?").join(",")})`)
      .all(...lineIds) as { journalLineId: number; month: string; amountUSD: number }[];
    for (const a of allocRows) {
      if (!allocationsByLine.has(a.journalLineId)) allocationsByLine.set(a.journalLineId, []);
      allocationsByLine.get(a.journalLineId)!.push({ month: a.month, amountUSD: a.amountUSD });
    }
  }

  const byMonth = new Map<string, Map<number, { code: string; name: string; category: string; type: string; usdAmount: number }>>();
  const addToMonth = (month: string, r: LedgerLineRow, signedUsd: number) => {
    if (!byMonth.has(month)) byMonth.set(month, new Map());
    const byAccount = byMonth.get(month)!;
    const existing = byAccount.get(r.accountId);
    if (existing) existing.usdAmount += signedUsd;
    else byAccount.set(r.accountId, { code: r.code, name: r.accountName, category: r.category, type: r.type, usdAmount: signedUsd });
  };

  for (const r of rows) {
    const creditNormal = r.type === "Revenue" || r.type === "Liability" || r.type === "Equity";
    const signedUsd = (creditNormal ? r.credit - r.debit : r.debit - r.credit) * (r.exchangeRate || 1);
    const allocations = allocationsByLine.get(r.journalLineId);
    if (allocations && allocations.length > 0) {
      const sign = signedUsd >= 0 ? 1 : -1;
      for (const a of allocations) addToMonth(a.month, r, a.amountUSD * sign);
    } else {
      addToMonth(r.transactionDate.slice(0, 7), r, signedUsd);
    }
  }
  return byMonth;
}

// Section 2 (management) range totals: same shape as summarizeByAccount,
// but built from the allocation-aware monthly bucketing above, then summed
// only over the months inside [startDate, endDate]. Deliberately queries
// with NO lower date bound on transactionDate — a line's own payment date
// can predate the report's startDate while its allocated incurred months
// still land inside the requested range (the whole point of amortization),
// so this can't apply startDate as a SQL filter the way the statutory
// queryPostedLines does.
function queryManagementRangeTotals(filter: {
  accountTypes: string[];
  entityId?: number;
  brandId?: number;
  startDate: string;
  endDate: string;
}): { code: string; name: string; category: string; type: string; usdAmount: number }[] {
  const rows = queryPostedLinesMonthly({
    accountTypes: filter.accountTypes,
    entityId: filter.entityId,
    brandId: filter.brandId,
    endDate: filter.endDate,
  });
  const byMonth = summarizeByMonthAndAccount(rows);
  const startMonth = filter.startDate.slice(0, 7);
  const endMonth = filter.endDate.slice(0, 7);
  const totals = new Map<number, { code: string; name: string; category: string; type: string; usdAmount: number }>();
  for (const [month, byAccount] of byMonth) {
    if (month < startMonth || month > endMonth) continue;
    for (const [accountId, v] of byAccount) {
      const existing = totals.get(accountId);
      if (existing) existing.usdAmount += v.usdAmount;
      else totals.set(accountId, { ...v });
    }
  }
  return [...totals.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// ---- Cross-Brand Operational P&L ----
app.get("/api/reports/brand-pnl", (req, res) => {
  const { entityId, startDate, endDate, currency } = req.query as any;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate are required" });
  const displayCurrency = currency || "USD";
  const entId = entityId ? Number(entityId) : undefined;

  let brandQ = "SELECT b.id, b.name, b.entityId, e.name as entityName FROM brands b JOIN entities e ON e.id = b.entityId WHERE b.isActive = 1";
  const brandParams: any[] = [];
  if (entId) {
    brandQ += " AND b.entityId = ?";
    brandParams.push(entId);
  }
  brandQ += " ORDER BY e.name, b.name";
  const brandRows = db.prepare(brandQ).all(...brandParams) as any[];

  const conv = (usd: number) => convertFromUsd(usd, displayCurrency, endDate).amount;
  const rateFound = convertFromUsd(0, displayCurrency, endDate).rateFound;

  const brands = brandRows.map((b) => {
    const accountTotals = queryManagementRangeTotals({ accountTypes: ["Revenue", "Expense"], brandId: b.id, startDate, endDate });
    const revenueTotalUsd = accountTotals.filter((a) => a.type === "Revenue").reduce((s, a) => s + a.usdAmount, 0);
    const cogsTotalUsd = accountTotals.filter((a) => a.type === "Expense" && a.category === "Cost of Goods Sold").reduce((s, a) => s + a.usdAmount, 0);
    const opexTotalUsd = accountTotals.filter((a) => a.type === "Expense" && a.category !== "Cost of Goods Sold").reduce((s, a) => s + a.usdAmount, 0);
    const grossProfitUsd = revenueTotalUsd - cogsTotalUsd;
    const netIncomeUsd = grossProfitUsd - opexTotalUsd;
    return {
      brandId: b.id,
      brandName: b.name,
      entityId: b.entityId,
      entityName: b.entityName,
      revenue: conv(revenueTotalUsd),
      costOfGoodsSold: conv(cogsTotalUsd),
      grossProfit: conv(grossProfitUsd),
      grossMarginPct: revenueTotalUsd !== 0 ? grossProfitUsd / revenueTotalUsd : null,
      operatingExpenses: conv(opexTotalUsd),
      netIncome: conv(netIncomeUsd),
    };
  });

  res.json({ entityId: entId ?? null, startDate, endDate, currency: displayCurrency, rateFound, brands });
});

// ---- Revenue Segmentation (Fresh Sales / Recurring Subscriptions / Upsell) ----
// Segmentation comes straight from the GL account a line was posted to
// (codes 4000/4100/4200, seeded in Phase 1.1) — not the legacy
// revenue.revenueType text column on the old single-entry table.
app.get("/api/reports/revenue-streams", (req, res) => {
  const { entityId, brandId, startDate, endDate, currency } = req.query as any;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate are required" });
  const displayCurrency = currency || "USD";

  // No startDate on this query — allocated amounts can land inside the
  // requested range even when the line's own payment date predates it (see
  // queryManagementRangeTotals above); filtered to the requested months below.
  const rows = queryPostedLinesMonthly({
    accountTypes: ["Revenue"],
    entityId: entityId ? Number(entityId) : undefined,
    brandId: brandId ? Number(brandId) : undefined,
    endDate,
  });
  const byMonth = summarizeByMonthAndAccount(rows);
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  const months = [...byMonth.keys()].filter((m) => m >= startMonth && m <= endMonth).sort();
  const rateFound = convertFromUsd(0, displayCurrency, endDate).rateFound;

  const series = months.map((month) => {
    // Convert each month's figures at that month's own end-of-month rate
    // (capped at the report's own endDate for the final, partial month),
    // matching the "never re-derive historical USD from today's rate"
    // convention used everywhere else in this file.
    const asOf = monthEndDate(month) < endDate ? monthEndDate(month) : endDate;
    const conv = (usd: number) => convertFromUsd(usd, displayCurrency, asOf).amount;
    const accounts = [...byMonth.get(month)!.values()];
    const find = (code: string) => accounts.find((a) => a.code === code)?.usdAmount || 0;
    const freshUsd = find("4000");
    const recurringUsd = find("4100");
    const upsellUsd = find("4200");
    return {
      month,
      freshSales: conv(freshUsd),
      recurringSubscriptions: conv(recurringUsd),
      upsellRevenue: conv(upsellUsd),
      total: conv(freshUsd + recurringUsd + upsellUsd),
    };
  });

  const totals = series.reduce(
    (acc, s) => ({
      freshSales: acc.freshSales + s.freshSales,
      recurringSubscriptions: acc.recurringSubscriptions + s.recurringSubscriptions,
      upsellRevenue: acc.upsellRevenue + s.upsellRevenue,
      total: acc.total + s.total,
    }),
    { freshSales: 0, recurringSubscriptions: 0, upsellRevenue: 0, total: 0 },
  );

  res.json({
    entityId: entityId ? Number(entityId) : null,
    brandId: brandId ? Number(brandId) : null,
    startDate,
    endDate,
    currency: displayCurrency,
    rateFound,
    series,
    totals,
  });
});

// ---- Multi-Period Trends (Revenue / Expenses / Net Income by month) ----
// Cash movement over time (2026-09-18) — what the dashboard's Cash Flow
// Trend chart plots. For every Posted line on a Cash & Equivalents account:
// a debit is cash IN, a credit is cash OUT (same account set and sign
// convention as /api/reports/cash-flow). Buckets are calendar months, or
// days when `granularity=day` (the 1M view). `position` is the running cash
// balance, seeded with the closing balance from before the range, so the
// line is a real position rather than a cumulative sum starting at zero.
// Everything is derived per request — nothing is stored.
app.get("/api/reports/cash-flow-trend", (req, res) => {
  const { entityId, startDate, endDate, currency, granularity } = req.query as any;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate are required" });
  const displayCurrency = currency || "USD";
  const entId = entityId ? Number(entityId) : undefined;
  const byDay = granularity === "day";

  let cashAcctQ = "SELECT id FROM accounts WHERE category = 'Cash & Equivalents' AND isActive = 1";
  const cashParams: any[] = [];
  if (entId) {
    cashAcctQ += " AND entityId = ?";
    cashParams.push(entId);
  }
  const cashAccountIds = (db.prepare(cashAcctQ).all(...cashParams) as { id: number }[]).map((r) => r.id);
  const rateFound = convertFromUsd(0, displayCurrency, endDate).rateFound;
  if (cashAccountIds.length === 0) {
    return res.json({ startDate, endDate, currency: displayCurrency, rateFound, granularity: byDay ? "day" : "month", series: [] });
  }
  const idList = cashAccountIds.join(",");

  // Opening position: everything posted before the range starts.
  const openingUsd = (db.prepare(
    `SELECT COALESCE(SUM(jl.debit * COALESCE(jl.exchangeRate,1)),0) - COALESCE(SUM(jl.credit * COALESCE(jl.exchangeRate,1)),0) AS bal
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
     WHERE je.status = 'Posted' AND jl.accountId IN (${idList}) AND je.transactionDate < ?`,
  ).get(startDate) as any).bal || 0;

  const rows = db.prepare(
    `SELECT je.transactionDate AS date,
            COALESCE(SUM(jl.debit  * COALESCE(jl.exchangeRate,1)),0) AS inUsd,
            COALESCE(SUM(jl.credit * COALESCE(jl.exchangeRate,1)),0) AS outUsd
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
     WHERE je.status = 'Posted' AND jl.accountId IN (${idList}) AND je.transactionDate BETWEEN ? AND ?
     GROUP BY je.transactionDate ORDER BY je.transactionDate`,
  ).all(startDate, endDate) as any[];

  // Every bucket in the range appears, including empty ones, so the curve
  // doesn't jump over months with no activity.
  const buckets: string[] = [];
  if (byDay) {
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) buckets.push(d);
  } else {
    let m = String(startDate).slice(0, 7);
    const lastM = String(endDate).slice(0, 7);
    while (m <= lastM) {
      buckets.push(m);
      const [y, mm] = m.split("-").map(Number);
      m = `${mm === 12 ? y + 1 : y}-${String(mm === 12 ? 1 : mm + 1).padStart(2, "0")}`;
    }
  }
  const keyOf = (date: string) => (byDay ? date : date.slice(0, 7));
  const totals = new Map<string, { inUsd: number; outUsd: number }>();
  for (const r of rows) {
    const key = keyOf(r.date);
    const acc = totals.get(key) || { inUsd: 0, outUsd: 0 };
    acc.inUsd += r.inUsd;
    acc.outUsd += r.outUsd;
    totals.set(key, acc);
  }

  let runningUsd = openingUsd;
  const series = buckets.map((bucket) => {
    const t = totals.get(bucket) || { inUsd: 0, outUsd: 0 };
    runningUsd += t.inUsd - t.outUsd;
    const asOf = byDay ? bucket : (monthEndDate(bucket) < endDate ? monthEndDate(bucket) : endDate);
    const conv = (usd: number) => convertFromUsd(usd, displayCurrency, asOf).amount;
    return {
      bucket,
      label: byDay ? bucket : bucket,
      cashIn: conv(t.inUsd),
      cashOut: conv(t.outUsd),
      net: conv(t.inUsd - t.outUsd),
      position: conv(runningUsd),
    };
  });

  res.json({
    startDate, endDate, currency: displayCurrency, rateFound,
    granularity: byDay ? "day" : "month",
    openingPosition: convertFromUsd(openingUsd, displayCurrency, startDate).amount,
    series,
  });
});

app.get("/api/reports/trends", (req, res) => {
  const { entityId, brandId, startDate, endDate, currency } = req.query as any;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate are required" });
  const displayCurrency = currency || "USD";
  const entId = entityId ? Number(entityId) : undefined;
  const bId = brandId ? Number(brandId) : undefined;

  const rows = queryPostedLinesMonthly({ accountTypes: ["Revenue", "Expense"], entityId: entId, brandId: bId, endDate });
  const byMonth = summarizeByMonthAndAccount(rows);
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  const months = [...byMonth.keys()].filter((m) => m >= startMonth && m <= endMonth).sort();
  const rateFound = convertFromUsd(0, displayCurrency, endDate).rateFound;

  const series = months.map((month) => {
    const asOf = monthEndDate(month) < endDate ? monthEndDate(month) : endDate;
    const conv = (usd: number) => convertFromUsd(usd, displayCurrency, asOf).amount;
    const accounts = [...byMonth.get(month)!.values()];
    const revenueUsd = accounts.filter((a) => a.type === "Revenue").reduce((s, a) => s + a.usdAmount, 0);
    const expensesUsd = accounts.filter((a) => a.type === "Expense").reduce((s, a) => s + a.usdAmount, 0);
    return {
      month,
      revenue: conv(revenueUsd),
      expenses: conv(expensesUsd),
      netIncome: conv(revenueUsd - expensesUsd),
    };
  });

  res.json({ entityId: entId ?? null, brandId: bId ?? null, startDate, endDate, currency: displayCurrency, rateFound, series });
});

// ---- Executive KPI Dashboard ----
// Burn rate / runway / margin are computed over a trailing window ending
// asOfDate (default today, default 3 trailing months) — not the report's
// own arbitrary start/end range, since these are meant to answer "how are
// we doing right now", not "how did period X look".
app.get("/api/reports/executive", (req, res) => {
  const { entityId, asOfDate, trailingMonths, currency } = req.query as any;
  const displayCurrency = currency || "USD";
  const asOf = asOfDate || todayIso();
  const entId = entityId ? Number(entityId) : undefined;
  const months = trailingMonths ? Number(trailingMonths) : 3;

  const periodStartD = new Date(`${asOf}T00:00:00Z`);
  periodStartD.setUTCMonth(periodStartD.getUTCMonth() - months);
  const periodStart = periodStartD.toISOString().slice(0, 10);

  const totalExpensesUsd = queryManagementRangeTotals({ accountTypes: ["Expense"], entityId: entId, startDate: periodStart, endDate: asOf }).reduce((s, a) => s + a.usdAmount, 0);
  const monthlyBurnRateUsd = months > 0 ? totalExpensesUsd / months : 0;

  const totalRevenueUsd = queryManagementRangeTotals({ accountTypes: ["Revenue"], entityId: entId, startDate: periodStart, endDate: asOf }).reduce((s, a) => s + a.usdAmount, 0);
  const netOperatingIncomeUsd = totalRevenueUsd - totalExpensesUsd;

  // Cash on hand: every active Cash & Equivalents account (optionally
  // scoped to one entity), same account set /api/reports/cash-flow uses.
  let cashAcctQ = "SELECT id FROM accounts WHERE category = 'Cash & Equivalents' AND isActive = 1";
  const cashParams: any[] = [];
  if (entId) {
    cashAcctQ += " AND entityId = ?";
    cashParams.push(entId);
  }
  const cashAccountIds = (db.prepare(cashAcctQ).all(...cashParams) as { id: number }[]).map((r) => r.id);
  const totalCashUsd = cashAccountIds.reduce((s, id) => s + computeGlAccountBalance(id, asOf), 0);
  const avgDailyBurnUsd = monthlyBurnRateUsd / 30;
  // null = no burn in the trailing window (division by zero would be
  // meaningless, not "infinite runway" in any actionable sense).
  const cashRunwayDays = avgDailyBurnUsd > 0 ? totalCashUsd / avgDailyBurnUsd : null;

  // Intercompany Receivables (1200, Asset) / Payables (2200, Liability) are
  // shared accounts (entityId null, per the Phase 1.1 seed) — there is one
  // company-wide net position, not one per entity.
  // Scoped to the entity when one is selected (2026-09-17): clearing
  // accounts are entity-owned since the counterparty-specific rework, and an
  // entity-restricted user must not see other entities' positions.
  const intercompanyAccounts = (entId
    ? db.prepare("SELECT id, type FROM accounts WHERE category = 'Intercompany' AND isActive = 1 AND entityId = ?").all(entId)
    : db.prepare("SELECT id, type FROM accounts WHERE category = 'Intercompany' AND isActive = 1").all()) as { id: number; type: string }[];
  const intercompanyReceivablesUsd = intercompanyAccounts.filter((a) => a.type === "Asset").reduce((s, a) => s + computeGlAccountBalance(a.id, asOf), 0);
  // Liability accounts are credit-normal, so their raw debit-credit balance
  // is negative when money is actually owed — flip sign for a positive
  // "amount payable" figure.
  const intercompanyPayablesUsd = intercompanyAccounts.filter((a) => a.type === "Liability").reduce((s, a) => s - computeGlAccountBalance(a.id, asOf), 0);

  const conv = (usd: number) => convertFromUsd(usd, displayCurrency, asOf).amount;
  const rateFound = convertFromUsd(0, displayCurrency, asOf).rateFound;

  res.json({
    entityId: entId ?? null,
    asOfDate: asOf,
    trailingMonths: months,
    periodStart,
    currency: displayCurrency,
    rateFound,
    monthlyBurnRate: conv(monthlyBurnRateUsd),
    cashOnHand: conv(totalCashUsd),
    cashRunwayDays,
    intercompany: {
      receivables: conv(intercompanyReceivablesUsd),
      payables: conv(intercompanyPayablesUsd),
      net: conv(intercompanyReceivablesUsd - intercompanyPayablesUsd),
    },
    totalRevenue: conv(totalRevenueUsd),
    netOperatingIncome: conv(netOperatingIncomeUsd),
    netOperatingMargin: totalRevenueUsd !== 0 ? netOperatingIncomeUsd / totalRevenueUsd : null,
  });
});

// ======= ACCOUNTS (Chart of Accounts: Expense/Revenue Category + Type) =======
app.get("/api/accounts", (req, res) => {
  const { type, entityId } = req.query as any;
  let q = "SELECT * FROM accounts WHERE 1=1";
  const params: any[] = [];
  if (type) {
    q += " AND type = ?";
    params.push(type);
  }
  if (entityId) {
    q += " AND (entityId = ? OR entityId IS NULL)";
    params.push(entityId);
  }
  q += " ORDER BY code";
  // Entity isolation: own entities' accounts + Shared (structure) accounts.
  res.json((db.prepare(q).all(...params) as any[]).filter((a) => a.entityId == null || canAccessEntity(req, a.entityId)));
});

// COA simplification (2026-09-10): the Create/Edit Account form no longer
// asks for `category` separately from `subType` — it was a redundant
// second free-text grouping field. `category` itself is NOT redundant at
// the data layer, though: resolveEntityCashAccount, the income statement's
// COGS/Opex split, classifyCashFlowActivity, and the executive dashboard's
// cash totals all key off exact `category` string literals ('Cash &
// Equivalents', 'Cost of Goods Sold', 'Intercompany', etc — see
// .claude/PHASE_TRACKER.md). So `category` is now DERIVED from `subType`
// server-side via this map on every create/update, rather than removed —
// the UI is simpler, the load-bearing column keeps being populated
// correctly. An explicit `category` in the request body still wins (kept
// for the bulk-import route and any other caller that already sends one),
// so this is additive, not a breaking change to that surface.
const SUBTYPE_TO_CATEGORY: Record<string, string> = {
  "Bank": "Cash & Equivalents",
  "Current Assets": "Cash & Equivalents",
  "Fixed Assets": "Fixed Assets",
  "Receivables": "Receivables",
  "Accounts Payable": "Payables",
  "Accrued Liabilities": "Payables",
  "Intercompany Clearing": "Intercompany",
  "Equity": "Equity",
  "Operating Revenue": "Sales Revenue",
  "Other Revenue": "Other Revenue",
  "COGS": "Cost of Goods Sold",
  "Operating Expense": "Operating Expenses",
};
function deriveCategory(subType: string, explicitCategory?: string): string {
  if (explicitCategory) return explicitCategory;
  const trimmed = (subType || "").trim();
  return SUBTYPE_TO_CATEGORY[trimmed] || trimmed || "Uncategorized";
}

// Robust field-name lookup (2026-09-11 "Account Code is required" bug fix):
// a request body (JSON from the app's own form, OR a row object parsed
// from an imported CSV/XLSX — SheetJS turns a spreadsheet header row
// directly into object keys) might spell the same field several ways —
// `code`, `Code`, `Account Code`, `account_code`, `accountCode`. Every COA
// write route now goes through this instead of destructuring one exact
// key, so no caller can hit a false "required" error just because they
// used a differently-cased or differently-punctuated header/property name.
// Matching is case-insensitive and ignores spaces/underscores/hyphens.
function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function pickField(source: any, ...aliases: string[]): string {
  if (!source || typeof source !== "object") return "";
  const normalizedAliases = new Set(aliases.map(normalizeFieldKey));
  for (const key of Object.keys(source)) {
    if (normalizedAliases.has(normalizeFieldKey(key))) {
      const v = source[key];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return "";
}

// Main Type is stored as one of exactly 5 Title-Case singular values
// (ACCOUNT_TYPES in src/lib/constants.ts), but a hand-typed cell or a
// template filled in loosely ("Assets", "expenses", "REVENUE") should
// still resolve correctly rather than fail validation over casing/
// pluralization alone.
const ACCOUNT_TYPE_ALIASES: Record<string, string> = {
  asset: "Asset", assets: "Asset",
  liability: "Liability", liabilities: "Liability",
  equity: "Equity",
  revenue: "Revenue", revenues: "Revenue", income: "Revenue",
  expense: "Expense", expenses: "Expense",
};
function normalizeAccountType(raw: string): string {
  const trimmed = (raw || "").trim();
  return ACCOUNT_TYPE_ALIASES[trimmed.toLowerCase()] || trimmed;
}

// Simplified COA create/edit (2026-09-10): the form now only collects
// Code/Type/Name (Sub-Type, Entity/Brand and Description were dropped from
// the UI per the task — Brand in particular was never really an account-
// definition concept: `accounts` has no brandId column at all, only
// entityId, and that's set only by the Phase 1.1 seed for the handful of
// entity-scoped accounts like "Cash in Bank - CA" or "Due From Affiliates -
// TX" — never something a user picks when defining a regular expense/
// revenue account). Both routes below now explicitly validate the 3
// required fields with a clean 400 instead of letting a missing one reach
// better-sqlite3 as an `undefined` bind parameter or a NOT NULL violation
// — either of which throws an *uncaught* exception that Express turns into
// an opaque 500, which is almost certainly what "accounts fail to save"
// actually was. The insert itself is now wrapped in try/catch for the same
// reason — any remaining DB-level failure (e.g. a future constraint) comes
// back as a real error message, not a crash.
const ACCOUNT_TYPES_VALID = new Set(["Asset", "Liability", "Equity", "Revenue", "Expense"]);
// Reads code/name/type off `body` via pickField's alias-tolerant lookup
// (rather than trusting exact `body.code`/`body.name`/`body.type` keys) so
// the same validator used by both the single-account routes and the bulk
// importer never rejects a real value just because it arrived under a
// differently-spelled field name.
function extractAccountFields(body: any): { code: string; name: string; type: string } {
  const code = pickField(body, "code", "Account Code", "account_code", "accountCode");
  const name = pickField(body, "name", "Account Name", "account_name", "accountName");
  const rawType = pickField(body, "type", "Main Type", "main_type", "mainType");
  return { code, name, type: normalizeAccountType(rawType) };
}
// Account Code is NO LONGER user-supplied (2026-09-11). It is generated
// from the account's Main Type, so it is not validated on input — a code
// in the body is still honoured (imports of a previously-exported file
// round-trip cleanly), but its absence is normal, not an error.
function validateAccountFields(body: any): string | null {
  const { name, type } = extractAccountFields(body);
  if (!name) return "Account Name is required";
  if (!type || !ACCOUNT_TYPES_VALID.has(type)) return "Main Type must be one of Asset, Liability, Equity, Revenue, Expense";
  return null;
}

// An account is either scoped to one entity or shared across all of them.
// Forms post numbers as strings, and "", "0" and the literal "shared"
// sentinel all mean unscoped — normalising here keeps a string entityId
// from reaching the DB, where it would compare unequal to the numeric ids
// every consumer matches on.
function normalizeEntityId(raw: any): number | null {
  if (raw === undefined || raw === null || raw === "" || raw === "shared") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Standard accounting bands: Assets 1000s, Liabilities 2000s, Equity
// 3000s, Revenue 4000s, Expenses 5000s.
const ACCOUNT_CODE_BANDS: Record<string, number> = {
  Asset: 1000,
  Liability: 2000,
  Equity: 3000,
  Revenue: 4000,
  Expense: 5000,
};

// Next code for a Main Type. Prefers tidy multiples of ten (1010, 1020,
// …) the way a bookkeeper would number a chart by hand, and only falls
// back to filling single-digit gaps once a band's tens are exhausted.
//
// `alsoTaken` lets a bulk import reserve codes it has assigned earlier in
// the same batch but not yet committed, so a 200-row import can't hand
// the same code to two accounts.
function nextAccountCodeForType(type: string, alsoTaken?: Set<string>): string {
  const band = ACCOUNT_CODE_BANDS[type];
  if (!band) throw new Error(`No account code band defined for type "${type}"`);
  const taken = new Set((db.prepare("SELECT code FROM accounts").all() as { code: string }[]).map((r) => String(r.code).trim()));
  if (alsoTaken) for (const c of alsoTaken) taken.add(c);

  for (let c = band + 10; c < band + 1000; c += 10) {
    if (!taken.has(String(c))) return String(c);
  }
  for (let c = band + 1; c < band + 1000; c++) {
    if (!taken.has(String(c))) return String(c);
  }
  throw new Error(`The ${band}-${band + 999} range is full — free up a code in the Chart of Accounts first`);
}

// Boot backfill for counterparty-specific intercompany accounts. Placed here
// (not beside the entity routes) because nextAccountCodeForType reads
// ACCOUNT_CODE_BANDS, a const declared just above — calling it earlier at
// module load would hit the temporal dead zone.
{
  const ic = ensureAllIntercompanyPairs();
  if (ic.created || ic.adopted) {
    console.log(`Intercompany clearing: ${ic.adopted} legacy account(s) adopted, ${ic.created} created`);
  }
}

// ---- COA hierarchy + statutory guards (2026-09-16) ----

const MAX_ACCOUNT_DEPTH = 4; // top level + 3 levels of sub-accounts

function normalizeParentId(raw: any): number | null {
  if (raw === undefined || raw === null || raw === "" || raw === "none") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A sub-account must roll up cleanly into its parent on every statement:
//   - same statutory type (an Expense can't sit under an Asset — the parent's
//     roll-up would mix P&L and Balance Sheet figures);
//   - compatible ownership: an entity's account may sit under that entity's
//     own parent or a Shared one; a Shared account may only sit under a
//     Shared parent (it would otherwise leak into one entity's subtree);
//   - no cycles, bounded depth.
// Returns an error message, or null when the assignment is valid.
function validateParentAssignment(childId: number | null, parentId: number | null, type: string, entityId: number | null): string | null {
  if (parentId === null) return null;
  if (childId !== null && parentId === childId) return "An account cannot be its own parent";
  const parent = db.prepare("SELECT id, name, type, entityId FROM accounts WHERE id = ?").get(parentId) as any;
  if (!parent) return `Parent account ${parentId} does not exist`;
  if (parent.type !== type) {
    return `Parent "${parent.name}" is ${parent.type}; a ${type} account can only be a sub-account of another ${type} account`;
  }
  if (parent.entityId !== null && Number(parent.entityId) !== Number(entityId)) {
    return entityId === null
      ? `A Shared account can't sit under "${parent.name}", which belongs to one entity`
      : `Parent "${parent.name}" belongs to a different entity`;
  }
  // Walk up from the proposed parent: meeting the child means a cycle.
  // `depth` counts levels from the top of the tree down to the child.
  const parentOf = db.prepare("SELECT parentId FROM accounts WHERE id = ?");
  let depth = 1;
  let cursorId: number | null = parent.id;
  const seen = new Set<number>();
  while (cursorId !== null) {
    if (childId !== null && cursorId === childId) return "That parent is one of this account's own sub-accounts (circular hierarchy)";
    if (seen.has(cursorId)) return "Existing hierarchy contains a cycle — fix it before re-parenting";
    seen.add(cursorId);
    depth += 1;
    cursorId = ((parentOf.get(cursorId) as { parentId: number | null } | undefined)?.parentId) ?? null;
  }
  // Depth of the deepest existing descendant of the child, so moving a
  // whole subtree can't push it past the limit either.
  let subtreeDepth = 0;
  if (childId !== null) {
    const row = db.prepare(`
      WITH RECURSIVE sub(id, lvl) AS (
        SELECT id, 1 FROM accounts WHERE parentId = ?
        UNION ALL SELECT a.id, sub.lvl + 1 FROM accounts a JOIN sub ON a.parentId = sub.id WHERE sub.lvl < 20
      ) SELECT COALESCE(MAX(lvl), 0) AS d FROM sub`).get(childId) as { d: number };
    subtreeDepth = row.d;
  }
  if (depth + subtreeDepth > MAX_ACCOUNT_DEPTH) {
    return `Sub-accounts can be nested at most ${MAX_ACCOUNT_DEPTH} levels deep`;
  }
  return null;
}

// Everything that references an account. Used to refuse destructive
// changes: deleting a used account would break history (and hit raw FK
// errors), and re-typing or re-owning one with posted lines would silently
// reclassify past periods on every statement.
function accountUsage(accountId: number) {
  const n = (sql: string) => (db.prepare(sql).get(accountId) as { n: number }).n;
  return {
    journalLines: n("SELECT COUNT(*) n FROM journal_lines WHERE accountId = ?"),
    subAccounts: n("SELECT COUNT(*) n FROM accounts WHERE parentId = ?"),
    bankFeeds: n("SELECT COUNT(*) n FROM bank_accounts WHERE glAccountId = ?"),
    rules: n("SELECT COUNT(*) n FROM categorization_rules WHERE targetAccountId = ?"),
    bills: n("SELECT COUNT(*) n FROM bills WHERE expenseAccountId = ?"),
    invoices: n("SELECT COUNT(*) n FROM invoices WHERE revenueAccountId = ?"),
    payments: n("SELECT COUNT(*) n FROM payment_records WHERE paidFromAccountId = ?"),
  };
}

function describeAccountUsage(u: ReturnType<typeof accountUsage>): string[] {
  const parts: string[] = [];
  if (u.journalLines) parts.push(`${u.journalLines} journal line(s)`);
  if (u.subAccounts) parts.push(`${u.subAccounts} sub-account(s)`);
  if (u.bankFeeds) parts.push(`a linked bank feed`);
  if (u.rules) parts.push(`${u.rules} categorization rule(s)`);
  if (u.bills) parts.push(`${u.bills} bill(s)`);
  if (u.invoices) parts.push(`${u.invoices} invoice(s)`);
  if (u.payments) parts.push(`${u.payments} payment(s)`);
  return parts;
}

app.post("/api/accounts", (req, res) => {
  const validationError = validateAccountFields(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const { code: suppliedCode, name, type } = extractAccountFields(req.body);
  const subType = pickField(req.body, "subType", "Sub-Type", "sub_type", "subtype");
  const description = pickField(req.body, "description", "Description");
  // Coerced to a real number: a form posts "2" as a string, and a string
  // entityId silently breaks every consumer that matches on identity
  // (the banking-cards filter, the COA page's entity Map). Empty string /
  // "shared" / absent all mean "not scoped to an entity".
  const entityId = normalizeEntityId(req.body.entityId);
  const isActive = req.body.isActive;
  const category = deriveCategory(subType, req.body.category);
  // Ownership must be an explicit decision, but "shared across all
  // entities" is a legitimate one (2026-09-11): a master head like
  // "Bank Charges" is posted to by every entity. So an explicit
  // `entityId: null` is accepted and stored as NULL, while OMITTING the
  // field entirely is rejected — that's a caller that forgot, not a
  // deliberate choice. A supplied id is validated against the entities
  // table so a stale value from a cached dropdown fails loudly here
  // instead of silently becoming a "Shared" account.
  const entityIdProvided = Object.prototype.hasOwnProperty.call(req.body ?? {}, "entityId");
  if (!entityIdProvided) {
    return res.status(400).json({
      error: "Entity is required. Pick an entity, or choose Shared / Master for a head every entity can post to.",
    });
  }
  if (entityId !== null && !db.prepare("SELECT id FROM entities WHERE id = ?").get(entityId)) {
    return res.status(400).json({ error: `Entity ${entityId} does not exist` });
  }
  // Entity isolation: only into an entity the user can access; a Shared head
  // affects every entity, so it needs access to all of them.
  if (!canAccessEntity(req, entityId) && !(entityId === null && visibleEntityIds(req) === null)) {
    return res.status(403).json({ error: entityId === null ? "Creating a Shared account requires access to all entities" : "You don't have access to that entity" });
  }
  const parentId = normalizeParentId(req.body.parentId);
  const parentError = validateParentAssignment(null, parentId, type, entityId);
  if (parentError) return res.status(400).json({ error: parentError });
  // A hand-typed code (Banking "Create New Category") must not collide with
  // an existing head — two accounts sharing a code are indistinguishable in
  // every picker and report.
  if (suppliedCode) {
    const clash = db.prepare("SELECT name FROM accounts WHERE code = ? LIMIT 1").get(String(suppliedCode)) as { name: string } | undefined;
    if (clash) return res.status(409).json({ error: `Account code ${suppliedCode} is already used by "${clash.name}". Pick another code or leave it blank to auto-assign.` });
  }
  try {
    // Generated from the Main Type unless the caller supplied one (the
    // Banking quick-create form, or re-importing an exported file).
    const code = suppliedCode || nextAccountCodeForType(type);
    const r = db
      .prepare(
        "INSERT INTO accounts (code,category,name,type,description,subType,currency,entityId,isActive,parentId) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(code, category, name, type, description || "", subType || "", "USD", entityId, isActive === false ? 0 : 1, parentId);
    res.json(
      db.prepare("SELECT * FROM accounts WHERE id=?").get(r.lastInsertRowid),
    );
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to create account" });
  }
});

app.put("/api/accounts/:id", (req, res) => {
  const validationError = validateAccountFields(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const existing = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "Account not found" });
  // Entity isolation for both the current owner and any new owner.
  try {
    assertEntityAccess(req, existing.entityId, "this account's entity");
    if (req.body.entityId !== undefined) assertEntityAccess(req, normalizeEntityId(req.body.entityId), "that entity");
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }
  const { code: suppliedCode, name, type } = extractAccountFields(req.body);
  // The Edit form no longer has a code field at all, so an absent code
  // means "leave it alone", never "blank it".
  const code = suppliedCode || existing.code;
  const subTypeRaw = pickField(req.body, "subType", "Sub-Type", "sub_type", "subtype");
  const descriptionRaw = pickField(req.body, "description", "Description");
  const entityId = req.body.entityId;
  const isActive = req.body.isActive;
  // The simplified Edit form (2026-09-10) only ever sends code/name/type —
  // subType/entityId/category/description are left `undefined` in the
  // request body, not explicitly cleared. Falling back to the existing
  // row's own value for each of those (instead of blanking them to ''/null)
  // is what stops editing e.g. "Cash in Bank - CA" from silently wiping out
  // its `category: 'Cash & Equivalents'`/`entityId` — both load-bearing for
  // resolveEntityCashAccount — just because the form doesn't ask about them
  // anymore. A caller that explicitly wants to clear one can still send an
  // empty string.
  const nextSubType = subTypeRaw || existing.subType;
  const nextEntityId = entityId !== undefined ? normalizeEntityId(entityId) : existing.entityId;
  const nextDescription = descriptionRaw || existing.description;
  const nextIsActive = isActive !== undefined ? (isActive === false ? 0 : 1) : existing.isActive;
  const category = deriveCategory(nextSubType, req.body.category !== undefined ? req.body.category : existing.category);
  const accountId = Number(req.params.id);
  const nextParentId = req.body.parentId !== undefined ? normalizeParentId(req.body.parentId) : existing.parentId;

  // Statutory lock: once lines are posted, Main Type and owning entity are
  // part of the historical record. Changing them would silently move past
  // amounts between the P&L and Balance Sheet (type) or between companies'
  // books (entity). Open a new account and deactivate this one instead.
  const typeChanged = type !== existing.type;
  const entityChanged = (nextEntityId ?? null) !== (existing.entityId ?? null);
  if (typeChanged || entityChanged) {
    const usage = accountUsage(accountId);
    if (usage.journalLines > 0) {
      return res.status(409).json({
        error: `This account has ${usage.journalLines} posted journal line(s), so its ${typeChanged ? "Main Type" : "entity"} can't change — that would reclassify past periods. Create a new account and deactivate this one instead.`,
      });
    }
    // Sub-accounts must keep matching their parent's type and ownership.
    const children = db.prepare("SELECT name, type, entityId FROM accounts WHERE parentId = ?").all(accountId) as any[];
    const clash = children.find((c) => c.type !== type || (nextEntityId !== null && c.entityId !== null && Number(c.entityId) !== Number(nextEntityId)) || (nextEntityId !== null && c.entityId === null));
    if (clash) {
      return res.status(409).json({ error: `Sub-account "${clash.name}" would no longer match this account's type or entity — move it first` });
    }
  }
  const parentError = validateParentAssignment(accountId, nextParentId ?? null, type, nextEntityId ?? null);
  if (parentError) return res.status(400).json({ error: parentError });

  try {
    db.prepare(
      "UPDATE accounts SET code=?,category=?,name=?,type=?,description=?,subType=?,entityId=?,isActive=?,parentId=? WHERE id=?",
    ).run(code, category, name, type, nextDescription || "", nextSubType || "", nextEntityId, nextIsActive, nextParentId ?? null, accountId);
    res.json(db.prepare("SELECT * FROM accounts WHERE id=?").get(req.params.id));
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to update account" });
  }
});

// Delete only an account nothing references (2026-09-16). Previously this
// deleted unconditionally: a used account hit a raw FOREIGN KEY error (an
// unhandled 500), and a bank head — whose bank_accounts.glAccountId has no
// FK — was deleted outright, orphaning its bank feed.
app.delete("/api/accounts/:id", (req, res) => {
  const accountId = Number(req.params.id);
  const account = db.prepare("SELECT id, name, entityId FROM accounts WHERE id = ?").get(accountId) as any;
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (!canAccessEntity(req, account.entityId) && !(account.entityId === null && visibleEntityIds(req) === null)) {
    return res.status(403).json({ error: "You don't have access to this account's entity" });
  }
  const blockers = describeAccountUsage(accountUsage(accountId));
  if (blockers.length > 0) {
    return res.status(409).json({
      error: `"${account.name}" is still used by ${blockers.join(", ")}. Deactivate it instead (Edit → mark inactive) so its history stays intact.`,
    });
  }
  try {
    db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(409).json({ error: err.message || "Failed to delete account" });
  }
});

// Chart of Accounts "view balances in any currency" (2026-09-10): a global
// currency selector on the COA page replaces the old per-account currency
// field — this computes every account's current Posted balance (via the
// existing computeGlAccountBalance, same one the balance sheet uses) and
// converts it to the requested display currency at read time, never
// storing a converted figure (CLAUDE.md product rule 3).
app.get("/api/accounts/balances", (req, res) => {
  const { asOfDate, currency, entityId } = req.query as any;
  const asOf = asOfDate || todayIso();
  const displayCurrency = currency || "USD";
  let q = "SELECT id FROM accounts WHERE 1=1";
  const params: any[] = [];
  if (entityId) {
    q += " AND (entityId = ? OR entityId IS NULL)";
    params.push(entityId);
  }
  // Entity isolation: visible accounts only, and balances computed from the
  // user's own entities' entries (a Shared account would otherwise expose
  // other entities' totals).
  const visible = visibleEntityIds(req);
  // With ?entityId (COA entity filter), every balance — Shared heads
  // included — counts only that entity's postings, so the figures are that
  // entity's own books rather than the consolidated total.
  if (entityId && !canAccessEntity(req, Number(entityId))) {
    return res.status(403).json({ error: "You don't have access to this entity" });
  }
  const balanceEntities = entityId ? [Number(entityId)] : visible;
  const accountIds = (db.prepare(q.replace("SELECT id", "SELECT id, entityId")).all(...params) as { id: number; entityId: number | null }[])
    .filter((r) => r.entityId == null || canAccessEntity(req, r.entityId))
    .map((r) => r.id);
  const rateFound = convertFromUsd(0, displayCurrency, asOf).rateFound;
  const balances = accountIds.map((id) => {
    const usdAmount = computeGlAccountBalance(id, asOf, balanceEntities);
    return { accountId: id, usdAmount, amount: convertFromUsd(usdAmount, displayCurrency, asOf).amount };
  });
  res.json({ asOfDate: asOf, currency: displayCurrency, rateFound, balances });
});

// "View register" (2026-09-11, QBO-style COA table): lists an account's own
// posted journal lines in date order with a running balance, reusing the
// same debit-minus-credit convention as computeGlAccountBalance so the
// final running balance always matches the COA table's Balance column.
app.get("/api/accounts/:id/register", (req, res) => {
  const accountId = Number(req.params.id);
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as any;
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (account.entityId != null && !canAccessEntity(req, account.entityId)) {
    return res.status(403).json({ error: "You don't have access to this account's entity" });
  }
  const rows = (db
    .prepare(
      `SELECT jl.id, jl.debit, jl.credit, jl.memo, jl.currency, jl.exchangeRate, jl.brandId,
              je.id as journalEntryId, je.entryNumber, je.transactionDate, je.description, je.reference, je.entityId
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journalEntryId
       WHERE jl.accountId = ? AND je.status = 'Posted'
       ORDER BY je.transactionDate ASC, je.id ASC, jl.id ASC`,
    )
    .all(accountId) as any[])
    // A Shared account's register only shows the user's own entities' lines,
    // and only the chosen entity's with ?entityId (COA entity filter).
    .filter((r) => canAccessEntity(req, r.entityId))
    .filter((r) => !req.query.entityId || Number(r.entityId) === Number(req.query.entityId));
  // Raw debit − credit (the UI presents it on the account's natural side).
  // Converted at each line's own stamped rate so the closing figure ties
  // out to computeGlAccountBalance for non-USD lines too — it previously
  // summed native amounts under a "USD" label.
  let running = 0;
  const lines = rows.map((r) => {
    const rate = r.exchangeRate || 1;
    running += ((r.debit || 0) - (r.credit || 0)) * rate;
    return { ...r, runningBalanceUSD: running };
  });
  res.json({ account, lines });
});

app.post("/api/accounts/bulk-delete", (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ deleted: 0, skipped: [] });
  // Same rule as single delete: only unreferenced accounts go. Repeated
  // passes let a selected parent go once its selected sub-accounts have
  // been removed in an earlier pass (children first, whatever the order).
  const del = db.prepare("DELETE FROM accounts WHERE id = ?");
  const result = db.transaction((requested: number[]) => {
    let remaining = [...new Set(requested.map(Number))];
    let deleted = 0;
    let progress = true;
    while (progress && remaining.length > 0) {
      progress = false;
      remaining = remaining.filter((id) => {
        if (describeAccountUsage(accountUsage(id)).length > 0) return true;
        deleted += del.run(id).changes;
        progress = true;
        return false;
      });
    }
    const skipped = remaining.map((id) => {
      const acc = db.prepare("SELECT name FROM accounts WHERE id = ?").get(id) as { name: string } | undefined;
      return { id, name: acc?.name ?? `#${id}`, reason: acc ? `used by ${describeAccountUsage(accountUsage(id)).join(", ")}` : "not found" };
    });
    return { deleted, skipped };
  })(ids);
  res.json(result);
});

// COA bulk import (2026-09-11 fix): this route had drifted completely out
// of sync with the modern 5-type Chart of Accounts — it still required a
// `category` cell (removed from the UI back on 2026-09-10) and only
// accepted the literal lowercase strings "revenue"/"expense" for Type,
// rejecting every Asset/Liability/Equity row and even Title-Case
// "Revenue"/"Expense" outright. That's almost certainly the real source of
// "Account Code is required" and similar false-negative errors reported
// against imports of the *current* template/export (whose header row is
// "Account Code"/"Account Name"/"Main Type"/"Sub-Type" — none of which
// this route's old `r.code`/`r.type` exact-key reads would ever match).
// Now uses the exact same field-extraction/type-normalization/category-
// derivation helpers as the single-account POST/PUT routes above, so a
// row that would succeed through the Add Account modal succeeds the same
// way through an import, and vice versa — one set of rules, not two.
app.post("/api/accounts/bulk", (req, res) => {
  const rows: any[] = Array.isArray(req.body) ? req.body : [];

  const totalRows = rows.length;
  const errors: { row: number; reason: string }[] = [];
  const validRows: { code: string; name: string; type: string; subType: string; category: string; parentRef: string; rowNum: number }[] = [];

  // Codes assigned during THIS batch, so two code-less rows of the same
  // Main Type can't both be handed the same next-available code.
  const assignedInBatch = new Set<string>();

  rows.forEach((r, idx) => {
    const rowNum = idx + 2; // account for header row in spreadsheet
    const { code: suppliedCode, name, type } = extractAccountFields(r);
    const subType = pickField(r, "subType", "Sub-Type", "sub_type", "subtype");

    // Account Code is optional on import (2026-09-11): the template no
    // longer has the column, and anything without one is numbered
    // automatically from its Main Type. A code IS still honoured when
    // present, so re-importing a file this system exported round-trips
    // without renumbering the chart.
    if (!name) {
      errors.push({ row: rowNum, reason: "Account Name is required" });
      return;
    }
    if (!type || !ACCOUNT_TYPES_VALID.has(type)) {
      const rawType = pickField(r, "type", "Main Type", "main_type", "mainType");
      errors.push({
        row: rowNum,
        reason: `Main Type must be one of Asset, Liability, Equity, Revenue, Expense (got "${rawType}")`,
      });
      return;
    }

    let code = suppliedCode;
    if (!code) {
      try {
        code = nextAccountCodeForType(type, assignedInBatch);
      } catch (err: any) {
        errors.push({ row: rowNum, reason: err.message });
        return;
      }
    }
    assignedInBatch.add(code);
    const parentRef = pickField(r, "parentAccount", "Parent Account", "parent", "Parent", "parent_account", "Parent Code");
    validRows.push({ code, name, type, subType, category: deriveCategory(subType), parentRef, rowNum });
  });

  // The import template has no Entity column, so imported accounts adopt
  // the caller's entityId, else the sole entity when there is exactly one
  // (unambiguous). With several entities configured they stay unscoped and
  // can be assigned in the COA — better than silently filing another
  // company's chart under the wrong books.
  const entities = db.prepare("SELECT id FROM entities").all() as { id: number }[];
  const importEntityId = normalizeEntityId(req.body?.entityId) ?? (entities.length === 1 ? entities[0].id : null);

  const insert = db.prepare(
    "INSERT INTO accounts (code,category,name,type,description,subType,currency,entityId,isActive) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insertMany = db.transaction((rows: typeof validRows) =>
    rows.map((d) => insert.run(d.code, d.category, d.name, d.type, "", d.subType, "USD", importEntityId, 1)),
  );
  const results = validRows.length > 0 ? insertMany(validRows) : [];

  // Second pass — "Parent Account" (code or exact name). Done after every
  // row exists so a parent listed later in the same file still resolves.
  // A parent that can't be linked never fails the row (the account itself
  // was created fine); it is reported as a warning to fix in the COA.
  const warnings: { row: number; reason: string }[] = [];
  const setParent = db.prepare("UPDATE accounts SET parentId = ? WHERE id = ?");
  validRows.forEach((d, i) => {
    if (!d.parentRef) return;
    const childId = Number(results[i].lastInsertRowid);
    const byCode = db.prepare("SELECT id FROM accounts WHERE code = ? AND id <> ?").all(d.parentRef, childId) as { id: number }[];
    const byName = byCode.length ? [] : (db.prepare("SELECT id FROM accounts WHERE lower(name) = lower(?) AND id <> ?").all(d.parentRef, childId) as { id: number }[]);
    const matches = byCode.length ? byCode : byName;
    if (matches.length !== 1) {
      warnings.push({ row: d.rowNum, reason: `Created without a parent — "${d.parentRef}" ${matches.length ? "matches more than one account" : "was not found"}` });
      return;
    }
    const err = validateParentAssignment(childId, matches[0].id, d.type, importEntityId);
    if (err) {
      warnings.push({ row: d.rowNum, reason: `Created without a parent — ${err}` });
      return;
    }
    setParent.run(matches[0].id, childId);
  });

  res.json({
    totalRows,
    successCount: results.length,
    failedCount: errors.length,
    errors,
    warnings,
  });
});

// ======= CONTACTS — Customer / Vendor sub-ledger (2026-09-16) =======
//
// Balances are DERIVED from Posted journal lines tagged with the contact —
// nothing is stored on the contact row. All figures are USD (each line at
// its own stamped rate):
//   receivedUSD  sum of credits on tagged lines (e.g. revenue from a customer)
//   paidUSD      sum of debits on tagged lines (e.g. expense paid to a vendor)
//   outstandingUSD  the contact's running balance over EVERY posted line
//                   tagged with it (2026-09-18), whatever account it hit:
//                   Customer = total debited - total credited (invoiced less
//                   received), Vendor = total credited - total debited.
//                   Bank-feed postings tag the revenue/expense line rather
//                   than an AR/AP one, so the older Receivables/Payables-only
//                   rule left every such contact sitting at 0.00.
//   openArApUSD  the same figure restricted to Receivables / Payables
//                   accounts — the strict open-invoice position that ties to
//                   the AR / AP control account (what the Trial Balance and
//                   Balance Sheet drill-downs reconcile against).

function normalizeContactType(raw: any): "Customer" | "Vendor" | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "customer" || s === "customers") return "Customer";
  if (s === "vendor" || s === "vendors" || s === "supplier") return "Vendor";
  return null;
}

// ---- Opening balances & AR/AP control accounts (2026-09-16) ----
//
// A contact's opening balance is a real Posted journal entry (never a stored
// figure), dated "as of" the go-live date, in the contact's entity:
//   Customer, amount > 0 (they owe us):  Dr Accounts Receivable  / Cr Opening Balance Equity
//   Vendor,   amount > 0 (we owe them):  Dr Opening Balance Equity / Cr Accounts Payable
// (a negative amount — a credit balance — reverses the sides). The AR/AP line
// is tagged with the contact, so it is the first line of their statement and
// ties into the control account on the Trial Balance / Balance Sheet.

type ControlKind = "AR" | "AP" | "OBE";
const CONTROL_SPECS: Record<ControlKind, { name: string; type: string; subType: string; category: string }> = {
  AR: { name: "Accounts Receivable", type: "Asset", subType: "Receivables", category: "Receivables" },
  AP: { name: "Accounts Payable", type: "Liability", subType: "Accounts Payable", category: "Payables" },
  OBE: { name: "Opening Balance Equity", type: "Equity", subType: "Equity", category: "Equity" },
};

// Prefers the entity's own active control account, then a Shared one;
// creates a Shared one when the chart has none yet (as QuickBooks does).
function ensureControlAccount(kind: ControlKind, entityId: number): any {
  const spec = CONTROL_SPECS[kind];
  const match = kind === "OBE"
    ? "a.type = 'Equity' AND lower(a.name) = lower('Opening Balance Equity')"
    : `a.type = '${spec.type}' AND a.category = '${spec.category}'`;
  const found = db.prepare(`
    SELECT a.* FROM accounts a
    WHERE ${match} AND a.isActive = 1 AND (a.entityId = ? OR a.entityId IS NULL)
    ORDER BY (a.entityId IS NULL), a.code LIMIT 1`).get(entityId);
  if (found) return found;
  const r = db.prepare(
    "INSERT INTO accounts (code, category, name, type, description, subType, currency, entityId, isActive) VALUES (?, ?, ?, ?, '', ?, 'USD', NULL, 1)",
  ).run(nextAccountCodeForType(spec.type), spec.category, spec.name, spec.type, spec.subType);
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(r.lastInsertRowid);
}

function deleteJournalEntryHard(entryId: number) {
  // Posted lines are immutable by trigger — flip to Draft first (same
  // sequence as Unpost).
  db.prepare("UPDATE journal_entries SET status = 'Draft' WHERE id = ?").run(entryId);
  db.prepare("DELETE FROM journal_line_allocations WHERE journalLineId IN (SELECT id FROM journal_lines WHERE journalEntryId = ?)").run(entryId);
  db.prepare("DELETE FROM journal_lines WHERE journalEntryId = ?").run(entryId);
  db.prepare("DELETE FROM journal_entries WHERE id = ?").run(entryId);
}

// Replaces the contact's opening-balance entry (amount 0 = remove it).
// Amount is in the entity's functional currency; USD via the rate engine.
function postContactOpeningBalance(contactId: number, rawAmount: any, rawDate: any) {
  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as any;
  if (!contact) throw new PostingError(404, "Contact not found");
  const amount = Math.round((Number(rawAmount) || 0) * 100) / 100;
  if (!Number.isFinite(amount)) throw new PostingError(400, "Opening balance must be a number");
  const date = normalizeDateString(String(rawDate || "")) || todayIso();

  if (contact.openingBalanceEntryId) {
    const old = db.prepare("SELECT entityId, transactionDate FROM journal_entries WHERE id = ?").get(contact.openingBalanceEntryId) as any;
    if (old) {
      assertPeriodNotLocked(old.entityId, old.transactionDate);
      deleteJournalEntryHard(contact.openingBalanceEntryId);
    }
    db.prepare("UPDATE contacts SET openingBalanceEntryId = NULL WHERE id = ?").run(contactId);
  }
  if (amount === 0) return null;
  if (contact.entityId == null) {
    throw new PostingError(400, "An opening balance needs an associated entity — a Shared contact has no single set of books to post it to");
  }
  const entityId = Number(contact.entityId);
  assertPeriodNotLocked(entityId, date);

  const currency = resolveEntityCurrency(entityId);
  const rate = resolveExchangeRate(currency, statutoryPeriodOf(date));
  const control = ensureControlAccount(contact.contactType === "Customer" ? "AR" : "AP", entityId);
  const obe = ensureControlAccount("OBE", entityId);
  const abs = Math.abs(amount);
  // Normal side of the control account for a positive balance.
  const controlIsDebit = (contact.contactType === "Customer") === (amount > 0);

  const entryNumber = nextEntryNumber();
  const e = db.prepare(
    `INSERT INTO journal_entries (entryNumber, entityId, brandId, transactionDate, postingDate, description, reference, status, source, chargedToEntityId, accountingPeriod, appliedExchangeRate, exchangeRateSource, contactId, contactType)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', 'OpeningBalance', ?, ?, ?, ?, ?, ?)`,
  ).run(
    entryNumber, entityId, resolveEntityBrandId(entityId), date, todayIso(),
    `Opening balance — ${contact.name}`, `contacts#${contact.id} opening balance`, entityId, statutoryPeriodOf(date),
    rate.rate, rate.source, contact.id, contact.contactType,
  );
  const entryId = Number(e.lastInsertRowid);
  const line = db.prepare(
    `INSERT INTO journal_lines (journalEntryId, accountId, debit, credit, currency, exchangeRate, amountUSD, brandId, memo, contactId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const brandId = resolveEntityBrandId(entityId);
  line.run(entryId, control.id, controlIsDebit ? abs : 0, controlIsDebit ? 0 : abs, currency, rate.rate, abs * rate.rate, brandId, `Opening balance — ${contact.name}`, contact.id);
  line.run(entryId, obe.id, controlIsDebit ? 0 : abs, controlIsDebit ? abs : 0, currency, rate.rate, abs * rate.rate, brandId, `Opening balance — ${contact.name}`, null);
  db.prepare("UPDATE journal_entries SET status = 'Posted' WHERE id = ?").run(entryId);
  db.prepare("UPDATE contacts SET openingBalanceEntryId = ? WHERE id = ?").run(entryId, contactId);
  return entryId;
}

const CONTACT_BALANCE_SELECT = `
  SELECT c.*,
         -- Opening balance, read back from its entry's tagged control line
         -- (native amount, signed so a normal balance is positive).
         (SELECT CASE WHEN c.contactType = 'Customer' THEN ol.debit - ol.credit ELSE ol.credit - ol.debit END
            FROM journal_lines ol WHERE ol.journalEntryId = c.openingBalanceEntryId AND ol.contactId = c.id LIMIT 1) AS openingBalance,
         (SELECT ol.currency FROM journal_lines ol WHERE ol.journalEntryId = c.openingBalanceEntryId AND ol.contactId = c.id LIMIT 1) AS openingBalanceCurrency,
         (SELECT oe.transactionDate FROM journal_entries oe WHERE oe.id = c.openingBalanceEntryId) AS openingBalanceDate,
         COALESCE(SUM(CASE WHEN je.status = 'Posted' THEN jl.credit * jl.exchangeRate END), 0) AS receivedUSD,
         COALESCE(SUM(CASE WHEN je.status = 'Posted' THEN jl.debit  * jl.exchangeRate END), 0) AS paidUSD,
         COALESCE(SUM(CASE WHEN je.status = 'Posted' AND c.contactType = 'Customer'
                           THEN (jl.debit - jl.credit) * jl.exchangeRate
                           WHEN je.status = 'Posted' AND c.contactType = 'Vendor'
                           THEN (jl.credit - jl.debit) * jl.exchangeRate END), 0) AS outstandingUSD,
         COALESCE(SUM(CASE WHEN je.status = 'Posted' AND a.category = 'Receivables' AND c.contactType = 'Customer'
                           THEN (jl.debit - jl.credit) * jl.exchangeRate
                           WHEN je.status = 'Posted' AND a.category = 'Payables' AND c.contactType = 'Vendor'
                           THEN (jl.credit - jl.debit) * jl.exchangeRate END), 0) AS openArApUSD,
         COUNT(CASE WHEN je.status = 'Posted' THEN jl.id END) AS postedLineCount,
         MAX(CASE WHEN je.status = 'Posted' THEN je.transactionDate END) AS lastActivityDate
  FROM contacts c
  LEFT JOIN journal_lines jl ON jl.contactId = c.id
  LEFT JOIN journal_entries je ON je.id = jl.journalEntryId
  LEFT JOIN accounts a ON a.id = jl.accountId`;

// Contact balances as seen by THIS user (2026-09-17): for an entity-restricted
// user only postings in their entities count, so a Shared contact's totals
// never reveal other entities' activity. Ids come from user_entities (integers),
// never from request input, so inlining them is safe.
function contactSelectFor(req: express.Request): string {
  const visible = visibleEntityIds(req);
  if (!visible) return CONTACT_BALANCE_SELECT;
  const inList = visible.length ? visible.map(Number).filter(Number.isInteger).join(",") : "NULL";
  return CONTACT_BALANCE_SELECT.split("je.status = 'Posted'").join(`je.status = 'Posted' AND je.entityId IN (${inList})`);
}

app.get("/api/contacts", (req, res) => {
  const { entityId, type, includeInactive } = req.query as any;
  const where: string[] = [];
  const params: any[] = [];
  if (entityId && !canAccessEntity(req, Number(entityId))) return res.status(403).json({ error: "You don't have access to that entity" });
  const visibleIds = visibleEntityIds(req);
  if (visibleIds) where.push(`(c.entityId IS NULL OR c.entityId IN (${visibleIds.length ? visibleIds.map(Number).join(",") : "NULL"}))`);
  // Scoped to an entity = that entity's own contacts plus Shared ones —
  // the set a posting booked in that entity may use.
  if (entityId) { where.push("(c.entityId = ? OR c.entityId IS NULL)"); params.push(Number(entityId)); }
  const t = type ? normalizeContactType(type) : null;
  if (t) { where.push("c.contactType = ?"); params.push(t); }
  if (includeInactive !== "true") where.push("c.isActive = 1");
  const sql = `${contactSelectFor(req)} ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY c.id ORDER BY c.contactType, lower(c.name)`;
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/contacts", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const contactType = normalizeContactType(req.body?.contactType);
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (!contactType) return res.status(400).json({ error: "Type must be Customer or Vendor" });
  // Same explicit-ownership rule as accounts: key required, null = Shared.
  if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, "entityId")) {
    return res.status(400).json({ error: "Entity is required — pick an entity, or Shared for all entities" });
  }
  const entityId = normalizeEntityId(req.body.entityId);
  if (entityId !== null && !db.prepare("SELECT id FROM entities WHERE id = ?").get(entityId)) {
    return res.status(400).json({ error: `Entity ${entityId} does not exist` });
  }
  // A customer is billed by, and owes, one legal entity — its receivable
  // must sit in a single set of books. Only vendors may be Shared (2026-09-17).
  if (contactType === "Customer" && entityId === null) {
    return res.status(400).json({ error: "A customer must be assigned to a single entity — only vendors can be shared across all entities" });
  }
  const openingBalance = Number(req.body?.openingBalance ?? 0);
  if (!Number.isFinite(openingBalance)) return res.status(400).json({ error: "Opening balance must be a number" });
  if (openingBalance !== 0 && entityId === null) {
    return res.status(400).json({ error: "An opening balance needs an associated entity — pick the entity whose books it belongs to" });
  }
  // RBAC: the contact's entity must be accessible (Shared needs all
  // entities), and an opening balance POSTS a journal entry, so it needs the
  // `post` capability (a Bookkeeper can create contacts, not opening balances).
  try {
    assertEntityAccess(req, entityId, "that entity");
    if (openingBalance !== 0) assertCapability(req, "post", "post opening balances");
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }
  try {
    // Contact + its opening-balance entry are one unit: both or neither.
    const id = db.transaction(() => {
      const projectName = contactType === "Customer" ? String(req.body?.projectName ?? "").trim() : "";
      const r = db.prepare("INSERT INTO contacts (name, contactType, entityId, email, projectName) VALUES (?, ?, ?, ?, ?)")
        .run(name, contactType, entityId, String(req.body?.email ?? "").trim(), projectName);
      const newId = Number(r.lastInsertRowid);
      if (openingBalance !== 0) postContactOpeningBalance(newId, openingBalance, req.body?.openingBalanceDate);
      return newId;
    })();
    res.json(db.prepare(`${CONTACT_BALANCE_SELECT} WHERE c.id = ? GROUP BY c.id`).get(id));
  } catch (err: any) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: `A ${contactType} named "${name}" already exists for that entity` });
    }
    res.status(hasHttpStatus(err) ? err.status : 400).json({ error: err.message || "Failed to create contact" });
  }
});

app.put("/api/contacts/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as any;
  if (!existing) return res.status(404).json({ error: "Contact not found" });
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const contactType = req.body?.contactType !== undefined ? normalizeContactType(req.body.contactType) : existing.contactType;
  if (!contactType) return res.status(400).json({ error: "Type must be Customer or Vendor" });
  const entityId = req.body?.entityId !== undefined ? normalizeEntityId(req.body.entityId) : existing.entityId;
  // Customers are single-entity (see POST). Only reject a CHANGE into that
  // state, so a legacy Shared customer can still be renamed/deactivated.
  if (contactType === "Customer" && entityId === null && (existing.contactType !== "Customer" || existing.entityId !== null)) {
    return res.status(400).json({ error: "A customer must be assigned to a single entity — only vendors can be shared across all entities" });
  }
  // Lines other than the contact's own opening-balance entry — the opening
  // balance alone doesn't lock type/entity, because it is re-posted below.
  const tagged = (db.prepare(
    "SELECT COUNT(*) n FROM journal_lines WHERE contactId = ? AND journalEntryId IS NOT COALESCE(?, -1)",
  ).get(id, existing.openingBalanceEntryId) as { n: number }).n;
  // Same statutory lock as accounts: history already booked against this
  // contact must not silently change type or move to another entity.
  if (tagged > 0 && (contactType !== existing.contactType || (entityId ?? null) !== (existing.entityId ?? null))) {
    return res.status(409).json({ error: `This contact has ${tagged} ledger line(s), so its type and entity can't change. Create a new contact instead.` });
  }
  const isActive = req.body?.isActive !== undefined ? (req.body.isActive === false || req.body.isActive === 0 ? 0 : 1) : existing.isActive;
  const email = req.body?.email !== undefined ? String(req.body.email).trim() : existing.email;
  // Project Name is a customer attribute; it's cleared if the contact is a vendor.
  const projectName = contactType === "Customer"
    ? (req.body?.projectName !== undefined ? String(req.body.projectName ?? "").trim() : (existing.projectName ?? ""))
    : "";
  const openingProvided = req.body?.openingBalance !== undefined;
  try {
    assertEntityAccess(req, existing.entityId, "this contact's entity");
    if ((entityId ?? null) !== (existing.entityId ?? null)) assertEntityAccess(req, entityId, "that entity");
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }
  try {
    db.transaction(() => {
      db.prepare("UPDATE contacts SET name = ?, contactType = ?, entityId = ?, email = ?, projectName = ?, isActive = ? WHERE id = ?")
        .run(name, contactType, entityId, email, projectName, isActive, id);
      // Re-post the opening balance when it was sent, or when a change of
      // type/entity makes the existing entry wrong.
      const typeOrEntityChanged = contactType !== existing.contactType || (entityId ?? null) !== (existing.entityId ?? null);
      const current = db.prepare(`${CONTACT_BALANCE_SELECT} WHERE c.id = ? GROUP BY c.id`).get(id) as any;
      const currentAmount = Math.round((Number(current?.openingBalance) || 0) * 100) / 100;
      const nextAmount = openingProvided ? Math.round((Number(req.body.openingBalance) || 0) * 100) / 100 : currentAmount;
      const nextDate = (req.body?.openingBalanceDate ? normalizeDateString(String(req.body.openingBalanceDate)) : null) || current?.openingBalanceDate || null;
      const amountOrDateChanged = nextAmount !== currentAmount || (nextAmount !== 0 && nextDate !== (current?.openingBalanceDate ?? null));
      // Only re-post when something that affects the entry changed — a plain
      // rename must not burn a new entry number.
      if (amountOrDateChanged || (typeOrEntityChanged && existing.openingBalanceEntryId)) {
        // Re-posting the opening entry writes to the ledger.
        assertCapability(req, "post", "change opening balances");
        postContactOpeningBalance(id, nextAmount, nextDate);
      }
    })();
    res.json(db.prepare(`${CONTACT_BALANCE_SELECT} WHERE c.id = ? GROUP BY c.id`).get(id));
  } catch (err: any) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: `A ${contactType} named "${name}" already exists for that entity` });
    res.status(hasHttpStatus(err) ? err.status : 400).json({ error: err.message || "Failed to update contact" });
  }
});

app.delete("/api/contacts/:id", (req, res) => {
  const id = Number(req.params.id);
  const contact = db.prepare("SELECT name, entityId, openingBalanceEntryId FROM contacts WHERE id = ?").get(id) as { name: string; entityId: number | null; openingBalanceEntryId: number | null } | undefined;
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  try {
    assertEntityAccess(req, contact.entityId, "this contact's entity");
    // Deleting also removes its opening-balance journal entry.
    if (contact.openingBalanceEntryId) assertCapability(req, "post", "delete a contact that has an opening balance");
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }
  // Its own opening-balance entry doesn't block deletion (it goes with the
  // contact); any other activity does.
  const tagged = (db.prepare(
    "SELECT COUNT(*) n FROM journal_lines WHERE contactId = ? AND journalEntryId IS NOT COALESCE(?, -1)",
  ).get(id, contact.openingBalanceEntryId) as { n: number }).n;
  if (tagged > 0) {
    return res.status(409).json({ error: `"${contact.name}" has ${tagged} ledger line(s). Deactivate it instead so its history stays intact.` });
  }
  try {
    db.transaction(() => {
      if (contact.openingBalanceEntryId) postContactOpeningBalance(id, 0, null);
      db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
    })();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 400).json({ error: err.message || "Failed to delete contact" });
  }
});

// A contact's sub-ledger: every Posted line tagged with it, oldest first.
app.get("/api/contacts/:id/ledger", (req, res) => {
  const id = Number(req.params.id);
  const contact = db.prepare(`${contactSelectFor(req)} WHERE c.id = ? GROUP BY c.id`).get(id) as any;
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  if (contact.entityId != null && !canAccessEntity(req, contact.entityId)) {
    return res.status(403).json({ error: "You don't have access to this contact's entity" });
  }
  const lines = (db.prepare(`
    SELECT jl.id AS lineId, je.id AS journalEntryId, je.entryNumber, je.transactionDate, je.entityId,
           e.name AS entityName, a.code AS accountCode, a.name AS accountName, a.category AS accountCategory,
           jl.debit, jl.credit, jl.currency, jl.exchangeRate,
           jl.debit * jl.exchangeRate AS debitUSD, jl.credit * jl.exchangeRate AS creditUSD,
           COALESCE(NULLIF(jl.memo, ''), je.description) AS description
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journalEntryId
    JOIN accounts a ON a.id = jl.accountId
    LEFT JOIN entities e ON e.id = je.entityId
    WHERE jl.contactId = ? AND je.status = 'Posted'
    ORDER BY je.transactionDate, je.id, jl.id`).all(id) as any[])
    .filter((l) => canAccessEntity(req, l.entityId));
  // Statement of Account (2026-09-18): the balance runs row by row over
  // EVERY tagged line, oldest first — Customer = debited − credited, Vendor =
  // credited − debited — so the closing figure equals the contact's
  // outstandingUSD in the Directory. `onArAp` flags the lines that sit on a
  // Receivables / Payables head, which is the subset the AR / AP control
  // account drill-downs reconcile against.
  const c = contact as any;
  let running = 0;
  const statement = lines.map((l) => {
    const delta = c.contactType === "Customer" ? l.debitUSD - l.creditUSD : l.creditUSD - l.debitUSD;
    running += delta;
    const onArAp = (c.contactType === "Customer" && l.accountCategory === "Receivables") || (c.contactType === "Vendor" && l.accountCategory === "Payables");
    // affectsBalance stays for older clients; every line now moves the total.
    return { ...l, affectsBalance: true, onArAp, deltaUSD: delta, runningBalanceUSD: running };
  });
  res.json({ contact, lines: statement });
});

// Sub-ledger drill-down (2026-09-16): an AR / AP control account broken down
// by customer / vendor, as of a date. Built from the same Posted lines as the
// Trial Balance and Balance Sheet, so the rows ALWAYS sum to the control
// account's balance — lines without a contact appear as "Unassigned" rather
// than being dropped, and `reconciles` confirms the tie-out.
app.get("/api/reports/subledger", (req, res) => {
  const { accountId, entityId, asOfDate } = req.query as any;
  const asOf = asOfDate || todayIso();
  const account = db.prepare("SELECT id, code, name, type, category FROM accounts WHERE id = ?").get(Number(accountId)) as any;
  if (!account) return res.status(404).json({ error: "Account not found" });
  // Natural side: Asset (AR) Dr − Cr; Liability (AP) Cr − Dr.
  const sign = account.type === "Asset" || account.type === "Expense" ? 1 : -1;
  const params: any[] = [account.id, asOf];
  let entityClause = "";
  if (entityId) { entityClause = " AND je.entityId = ?"; params.push(Number(entityId)); }
  const rows = db.prepare(`
    SELECT jl.contactId, ct.name AS contactName, ct.contactType, ct.entityId AS contactEntityId,
           SUM((jl.debit - jl.credit) * jl.exchangeRate) AS netUSD,
           COUNT(*) AS lineCount, MAX(je.transactionDate) AS lastActivityDate
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journalEntryId
    LEFT JOIN contacts ct ON ct.id = jl.contactId
    WHERE jl.accountId = ? AND je.status = 'Posted' AND je.transactionDate <= ?${entityClause}
    GROUP BY jl.contactId
    ORDER BY (jl.contactId IS NULL), lower(ct.name)`).all(...params) as any[];
  // ---- Aging (2026-10-12) ----
  // There are no invoice documents behind these balances — open items live
  // as GL lines tagged with a contact — so aging works the way an
  // accountant does it by hand: charges (the account's natural side) are
  // open items, and payments are applied against the OLDEST open charge
  // first (FIFO). What is left unpaid is bucketed by the age of the charge
  // that remains, not by the age of the net balance, which would otherwise
  // let a recent payment make a year-old debt look current.
  //
  // Age is measured from the transaction date plus `netTermsDays` (0 by
  // default — a deliberate decision recorded in the phase tracker: these
  // books carry no payment terms yet, so "Current" means dated today or
  // later rather than "not yet due").
  const netTermsDays = Math.max(0, Number((req.query as any).netTermsDays) || 0);
  const detailParams: any[] = [account.id, asOf];
  if (entityId) detailParams.push(Number(entityId));
  const detailRows = db.prepare(`
    SELECT jl.contactId, je.transactionDate,
           (jl.debit - jl.credit) * jl.exchangeRate AS netUSD
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journalEntryId
    WHERE jl.accountId = ? AND je.status = 'Posted' AND je.transactionDate <= ?${entityClause}
    ORDER BY je.transactionDate, je.id, jl.id`).all(...detailParams) as any[];

  const BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
  type Bucket = (typeof BUCKETS)[number];
  const bucketFor = (daysOverdue: number): Bucket =>
    daysOverdue <= 0 ? "current"
      : daysOverdue <= 30 ? "d1_30"
      : daysOverdue <= 60 ? "d31_60"
      : daysOverdue <= 90 ? "d61_90"
      : "d90_plus";
  const daysBetween = (from: string, to: string) =>
    Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

  const agingByContact = new Map<number | null, Record<Bucket, number>>();
  const byContactLines = new Map<number | null, { date: string; amount: number }[]>();
  for (const r of detailRows) {
    const key = r.contactId ?? null;
    if (!byContactLines.has(key)) byContactLines.set(key, []);
    // Signed so a positive amount is always a charge on this account's
    // natural side, whichever side that is (AR debit, AP credit).
    byContactLines.get(key)!.push({ date: r.transactionDate, amount: sign * r.netUSD });
  }
  for (const [contactId, lines] of byContactLines) {
    const open: { date: string; amount: number }[] = [];
    let unappliedCredit = 0;
    for (const l of lines) {
      if (l.amount >= 0) { open.push({ ...l }); continue; }
      // A payment: consume the oldest open charges first.
      let left = -l.amount;
      while (left > 0.005 && open.length) {
        const take = Math.min(left, open[0].amount);
        open[0].amount -= take;
        left -= take;
        if (open[0].amount <= 0.005) open.shift();
      }
      // Paid more than is open (a prepayment or an unapplied credit note):
      // it stays as a credit and lands in Current, where QuickBooks also
      // shows unapplied credits.
      unappliedCredit += left;
    }
    const buckets: Record<Bucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    for (const o of open) {
      const due = addDays(o.date, netTermsDays);
      buckets[bucketFor(daysBetween(due, asOf))] += o.amount;
    }
    buckets.current -= unappliedCredit;
    for (const b of BUCKETS) buckets[b] = Math.round(buckets[b] * 100) / 100;
    agingByContact.set(contactId, buckets);
  }

  const emptyBuckets = (): Record<Bucket, number> => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });
  const items = rows
    .map((r) => ({
      contactId: r.contactId,
      contactName: r.contactId ? r.contactName : "Unassigned (no customer/vendor)",
      contactType: r.contactType ?? null,
      balanceUSD: Math.round(sign * r.netUSD * 100) / 100,
      lineCount: r.lineCount,
      lastActivityDate: r.lastActivityDate,
      aging: agingByContact.get(r.contactId ?? null) ?? emptyBuckets(),
    }))
    .filter((r) => Math.abs(r.balanceUSD) >= 0.005);
  const controlBalanceUSD = Math.round(sign * rows.reduce((s, r) => s + r.netUSD, 0) * 100) / 100;
  const itemsTotalUSD = Math.round(items.reduce((s, r) => s + r.balanceUSD, 0) * 100) / 100;
  const agingTotals = emptyBuckets();
  for (const i of items) for (const b of BUCKETS) agingTotals[b] = Math.round((agingTotals[b] + i.aging[b]) * 100) / 100;
  res.json({
    account,
    entityId: entityId ? Number(entityId) : null,
    asOfDate: asOf,
    netTermsDays,
    items,
    controlBalanceUSD,
    itemsTotalUSD,
    agingTotals,
    // Each contact's buckets must add back to its own balance; if this is
    // ever false the aging is lying and the report says so rather than
    // quietly showing a prettier number.
    agingReconciles:
      Math.abs(BUCKETS.reduce((s, b) => s + agingTotals[b], 0) - itemsTotalUSD) < 0.01,
    reconciles: Math.abs(controlBalanceUSD - itemsTotalUSD) < 0.01,
  });
});

// GET /api/reports/intercompany-balances — who owes whom, entity by entity
// (2026-10-12).
//
// Every cross-entity posting raises a matched pair: the payer's "Due From
// Affiliates — X" (asset) and X's "Due To Affiliates — payer" (liability),
// each a counterparty-specific head (accounts.subType = 'Intercompany
// Clearing', counterpartyEntityId = the other side). This report reads those
// heads straight from the ledger and lays them out as an owner × counterparty
// matrix.
//
// The pair must mirror: what A says B owes it should equal what B says it
// owes A. Any difference is a real problem — a one-sided posting, or an
// entry posted at different rates on each side — so each cell carries its
// counter-cell and the gap between them rather than netting them silently.
app.get("/api/reports/intercompany-balances", (req, res) => {
  const asOf = (req.query as any).asOfDate || todayIso();
  const entities = db.prepare("SELECT id, name, functionalCurrency FROM entities ORDER BY lower(name)").all() as any[];

  const rows = db.prepare(`
    SELECT a.entityId AS ownerEntityId, a.counterpartyEntityId, a.id AS accountId, a.code, a.name, a.type,
           COALESCE(SUM(jl.debit * COALESCE(jl.exchangeRate, 1)), 0)
             - COALESCE(SUM(jl.credit * COALESCE(jl.exchangeRate, 1)), 0) AS netUSD
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.accountId = a.id
    LEFT JOIN journal_entries je ON je.id = jl.journalEntryId
      AND je.status = 'Posted' AND je.transactionDate <= ?
    WHERE a.subType = 'Intercompany Clearing' AND a.counterpartyEntityId IS NOT NULL
    GROUP BY a.id
  `).all(asOf) as any[];

  // Debits minus credits, with no per-type flip: that already reads as
  // "positive = the owner is owed". A Due From (asset) carries a debit
  // balance and is a receivable; a Due To (liability) carries a credit
  // balance and so comes out negative, which is exactly what owing means
  // here. Flipping liabilities would make both sides of a pair claim to be
  // owed — which is how this was caught.
  const cellKey = (owner: number, counterparty: number) => `${owner}:${counterparty}`;
  const net = new Map<string, number>();
  const accountsByCell = new Map<string, any[]>();
  for (const r of rows) {
    if (r.ownerEntityId == null) continue;
    const key = cellKey(r.ownerEntityId, r.counterpartyEntityId);
    net.set(key, Math.round(((net.get(key) || 0) + r.netUSD) * 100) / 100);
    if (!accountsByCell.has(key)) accountsByCell.set(key, []);
    accountsByCell.get(key)!.push({
      accountId: r.accountId, code: r.code, name: r.name, type: r.type,
      balanceUSD: Math.round(r.netUSD * 100) / 100,
    });
  }

  const cells: any[] = [];
  const mismatches: any[] = [];
  for (const owner of entities) {
    for (const counterparty of entities) {
      if (owner.id === counterparty.id) continue;
      const key = cellKey(owner.id, counterparty.id);
      const mirrorKey = cellKey(counterparty.id, owner.id);
      const amount = net.get(key) || 0;
      const mirror = net.get(mirrorKey) || 0;
      if (amount === 0 && mirror === 0) continue;
      // A owes B, so A's receivable should be B's payable: equal and
      // opposite. The gap is what fails to eliminate on consolidation.
      const difference = Math.round((amount + mirror) * 100) / 100;
      cells.push({
        ownerEntityId: owner.id, ownerName: owner.name,
        counterpartyEntityId: counterparty.id, counterpartyName: counterparty.name,
        receivableUSD: amount > 0 ? amount : 0,
        payableUSD: amount < 0 ? -amount : 0,
        netUSD: amount,
        mirrorNetUSD: mirror,
        difference,
        reciprocal: Math.abs(difference) < 0.01,
        accounts: accountsByCell.get(key) || [],
      });
      if (Math.abs(difference) >= 0.01 && owner.id < counterparty.id) {
        mismatches.push({
          entityAId: owner.id, entityAName: owner.name,
          entityBId: counterparty.id, entityBName: counterparty.name,
          aSaysUSD: amount, bSaysUSD: mirror, differenceUSD: difference,
        });
      }
    }
  }

  // Across the whole group these balances must cancel out — anything left
  // over would survive consolidation as a phantom asset or liability.
  const groupNetUSD = Math.round(cells.reduce((s, c) => s + c.netUSD, 0) * 100) / 100;
  res.json({
    asOfDate: asOf,
    entities: entities.map((e) => ({ id: e.id, name: e.name, functionalCurrency: e.functionalCurrency })),
    cells,
    mismatches,
    groupNetUSD,
    eliminates: Math.abs(groupNetUSD) < 0.01,
  });
});

// ======= LEDGER IMPORT — QuickBooks Transaction Detail by Account =======
// (Phase C, 2026-10-13. Parser and its tests: server/qb-import.ts.)
//
// Three steps, deliberately separated so nothing reaches the books without a
// human having seen it:
//   1. preview — parse, pair the printed halves, show what WOULD be created
//      (including accounts that don't exist yet, and anything quarantined);
//   2. commit  — create the confirmed accounts and write Draft entries;
//   3. post    — turn the batch into the book of record, only once nothing
//      is quarantined.
// Draft is where imports live until someone approves them: a posted line is
// immutable (CLAUDE.md §0), so a bad import must be caught before posting,
// not voided afterwards.

const ledgerImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * Stable fingerprint of one source transaction. Deliberately independent of
 * the batch: re-importing the same file, or an overlapping export, hits the
 * UNIQUE index and is skipped rather than doubling the books.
 */
function importRowHashFor(entityId: number, e: { date: string; transactionType: string; num: string; name: string; lines: { account: string; amount: number }[] }): string {
  const legs = e.lines
    .map((l) => `${l.account.trim().toLowerCase()}:${l.amount.toFixed(2)}`)
    .sort()
    .join(";");
  return crypto
    .createHash("sha256")
    .update([entityId, e.date, e.transactionType.toLowerCase(), e.num.toLowerCase(), e.name.toLowerCase(), legs].join("|"))
    .digest("hex");
}

/** Case-insensitive match of an imported account name to an existing head. */
function matchExistingAccount(name: string, entityId: number): any {
  return db
    .prepare(
      `SELECT * FROM accounts
       WHERE lower(name) = lower(?) AND (entityId IS NULL OR entityId = ?)
       ORDER BY (entityId IS NULL), isActive DESC, id LIMIT 1`,
    )
    .get(name.trim(), entityId);
}

app.post("/api/imports/quickbooks/preview", ledgerImportUpload.single("file"), (req, res) => {
  try {
    const entityId = Number(req.body?.entityId);
    if (!entityId) return res.status(400).json({ error: "entityId is required" });
    assertEntityAccess(req, entityId, "this entity");
    const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId) as any;
    if (!entity) return res.status(400).json({ error: "Entity not found" });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: "file")' });

    const text = req.file.buffer.toString("utf8");
    const parsed = parseTransactionDetailByAccount(text);
    if (parsed.rows.length === 0) {
      return res.status(400).json({
        error: "Nothing importable was found in this file.",
        warnings: parsed.warnings,
      });
    }
    const paired = pairTransactions(parsed);

    // Which account names are already heads this entity can post to, and
    // what the rest would have to be created as. The guess is shown, never
    // applied — account type decides the sign of every report.
    const accountNames = [...new Set(parsed.rows.flatMap((r) => [r.account, ...(r.split && !/^-?\s*split\s*-?$/i.test(r.split) ? [r.split] : [])]))];
    const accounts = accountNames.map((name) => {
      const existing = matchExistingAccount(name, entityId);
      const guess = inferAccountType(name);
      return {
        name,
        existingAccountId: existing?.id ?? null,
        existingCode: existing?.code ?? null,
        existingType: existing?.type ?? null,
        suggestedType: guess.type,
        suggestedSubType: guess.subType,
        confidence: guess.confidence,
      };
    });

    // Already in the books? Shown now rather than discovered at commit.
    const hashStmt = db.prepare("SELECT id, entryNumber, status FROM journal_entries WHERE importRowHash = ?");
    const entries = paired.entries.map((e) => {
      const hash = importRowHashFor(entityId, e);
      const existing = hashStmt.get(hash) as any;
      return { ...e, importRowHash: hash, duplicateOf: existing ? { id: existing.id, entryNumber: existing.entryNumber, status: existing.status } : null };
    });

    const fileHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const payload = { entries, quarantine: paired.quarantine, accounts, warnings: parsed.warnings, parsedAccounts: parsed.accounts };
    const batchId = Number(
      db
        .prepare(
          `INSERT INTO import_batches (source, filename, entityId, status, fileHash, payloadJson, rowCount, entryCount, quarantineCount, createdByUserId)
           VALUES ('QuickBooks', ?, ?, 'PREVIEW', ?, ?, ?, ?, ?, ?)`,
        )
        .run(req.file.originalname || "", entityId, fileHash, JSON.stringify(payload), parsed.rows.length, entries.length, paired.quarantine.length, authOf(req).user.id)
        .lastInsertRowid,
    );

    res.json({
      batchId,
      entityId,
      filename: req.file.originalname || "",
      rowCount: parsed.rows.length,
      skippedRows: parsed.skipped,
      ...payload,
      duplicateCount: entries.filter((e) => e.duplicateOf).length,
      newAccountCount: accounts.filter((a) => !a.existingAccountId).length,
    });
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err?.message || "Could not read that file" });
  }
});

app.post("/api/imports/quickbooks/:id/commit", (req, res) => {
  try {
    const batch = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: "Import batch not found" });
    assertEntityAccess(req, batch.entityId, "this import's entity");
    if (batch.status !== "PREVIEW") return res.status(409).json({ error: `This batch is already ${batch.status.toLowerCase()}` });

    const payload = JSON.parse(batch.payloadJson || "{}");
    const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(batch.entityId) as any;
    const currency = entity?.functionalCurrency || "USD";

    // The user's confirmed decision for every account name in the file:
    // { name, accountId } to use an existing head, or
    // { name, create: { type, subType?, code? } } to make a new one.
    const decisions = new Map<string, any>();
    for (const d of (req.body?.accounts || []) as any[]) {
      if (d?.name) decisions.set(String(d.name).trim().toLowerCase(), d);
    }

    const resolved = new Map<string, number>();
    const created: any[] = [];
    const run = db.transaction(() => {
      for (const a of payload.accounts || []) {
        const key = String(a.name).trim().toLowerCase();
        const decision = decisions.get(key);
        const accountId = decision?.accountId ?? a.existingAccountId;
        if (accountId) {
          const acc = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as any;
          if (!acc) throw new PostingError(400, `Account ${accountId} chosen for "${a.name}" no longer exists`);
          if (acc.entityId != null && acc.entityId !== batch.entityId) {
            throw new PostingError(400, `"${acc.name}" belongs to another entity and can't take this entity's postings`);
          }
          resolved.set(key, acc.id);
          continue;
        }
        const type = decision?.create?.type;
        if (!type) throw new PostingError(400, `No account chosen for "${a.name}" — pick an existing head or confirm a type to create one`);
        if (!["Asset", "Liability", "Equity", "Revenue", "Expense"].includes(type)) {
          throw new PostingError(400, `"${type}" is not a valid account type for "${a.name}"`);
        }
        const code = String(decision?.create?.code || "").trim();
        const r = db
          .prepare("INSERT INTO accounts (code, name, type, subType, category, entityId, currency, isActive) VALUES (?, ?, ?, ?, '', ?, ?, 1)")
          .run(code, String(a.name).trim(), type, String(decision?.create?.subType || ""), batch.entityId, currency);
        resolved.set(key, Number(r.lastInsertRowid));
        created.push({ id: Number(r.lastInsertRowid), name: a.name, type });
      }

      const insertEntry = db.prepare(
        `INSERT INTO journal_entries (entryNumber, entityId, transactionDate, postingDate, description, reference, status, source, accountingPeriod, appliedExchangeRate, exchangeRateSource, importBatchId, importRowHash)
         VALUES (?, ?, ?, ?, ?, ?, 'Draft', 'Import', ?, ?, ?, ?, ?)`,
      );
      const insertLine = db.prepare(
        `INSERT INTO journal_lines (journalEntryId, accountId, debit, credit, currency, exchangeRate, amountUSD, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let createdEntries = 0;
      let skippedDuplicates = 0;
      for (const e of payload.entries || []) {
        if (e.duplicateOf) { skippedDuplicates++; continue; }
        assertPeriodNotLocked(batch.entityId, e.date);
        const month = String(e.date).slice(0, 7);
        const rate = resolveExchangeRate(currency, month);
        const entryId = Number(
          insertEntry
            .run(
              nextEntryNumber(), batch.entityId, e.date, e.date,
              [e.transactionType, e.name, e.memo].filter(Boolean).join(" — ") || "Imported transaction",
              `QB import #${batch.id}${e.num ? ` · ${e.num}` : ""}`,
              month, rate.rate, rate.source, batch.id, e.importRowHash,
            )
            .lastInsertRowid,
        );
        for (const l of e.lines) {
          const accountId = resolved.get(String(l.account).trim().toLowerCase());
          if (!accountId) throw new PostingError(400, `No account resolved for "${l.account}"`);
          const native = Math.abs(l.amount);
          insertLine.run(
            entryId, accountId,
            l.amount > 0 ? native : 0,
            l.amount < 0 ? native : 0,
            currency, rate.rate, Math.round(native * rate.rate * 100) / 100,
            e.memo || "",
          );
        }
        createdEntries++;
      }

      db.prepare("UPDATE import_batches SET status = 'DRAFT', entryCount = ? WHERE id = ?").run(createdEntries, batch.id);
      return { createdEntries, skippedDuplicates };
    });

    const result = run();
    res.json({
      batchId: batch.id,
      status: "DRAFT",
      accountsCreated: created,
      ...result,
      quarantineCount: batch.quarantineCount,
      message: "Imported as Draft entries. Review them, then post the batch.",
    });
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err?.message || "Import failed" });
  }
});

app.post("/api/import-batches/:id/post", (req, res) => {
  try {
    const batch = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: "Import batch not found" });
    assertEntityAccess(req, batch.entityId, "this import's entity");
    if (batch.status !== "DRAFT") return res.status(409).json({ error: `Only a draft batch can be posted (this one is ${batch.status.toLowerCase()})` });
    // The agreed rule: nothing is posted while any source transaction is
    // unaccounted for, so a half-imported file can't become the book of record.
    if (batch.quarantineCount > 0) {
      return res.status(400).json({
        error: `${batch.quarantineCount} transaction(s) from this file could not be read as balanced entries. Fix the export and re-import, or import those by hand — the batch stays in Draft until the quarantine is empty.`,
      });
    }

    const entries = db.prepare("SELECT id, transactionDate FROM journal_entries WHERE importBatchId = ? AND status = 'Draft'").all(batch.id) as any[];
    if (entries.length === 0) return res.status(400).json({ error: "This batch has no draft entries left to post" });

    const run = db.transaction(() => {
      const post = db.prepare("UPDATE journal_entries SET status = 'Posted' WHERE id = ?");
      for (const e of entries) {
        assertPeriodNotLocked(batch.entityId, e.transactionDate);
        // The balance trigger is the real gate — it refuses any entry whose
        // converted debits and credits differ.
        post.run(e.id);
      }
      db.prepare("UPDATE import_batches SET status = 'POSTED', postedAt = CURRENT_TIMESTAMP WHERE id = ?").run(batch.id);
    });
    run();

    res.json({ batchId: batch.id, status: "POSTED", postedEntries: entries.length });
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err?.message || "Could not post this batch" });
  }
});

/** Throws away a preview, or deletes the draft entries of a committed batch. */
app.post("/api/import-batches/:id/discard", (req, res) => {
  try {
    const batch = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: "Import batch not found" });
    assertEntityAccess(req, batch.entityId, "this import's entity");
    if (batch.status === "POSTED") return res.status(409).json({ error: "This batch is posted — void its entries instead" });
    const run = db.transaction(() => {
      // Draft lines are deletable; posted ones are not, and none exist here.
      const ids = (db.prepare("SELECT id FROM journal_entries WHERE importBatchId = ? AND status = 'Draft'").all(batch.id) as any[]).map((r) => r.id);
      for (const id of ids) {
        db.prepare("DELETE FROM journal_lines WHERE journalEntryId = ?").run(id);
        db.prepare("DELETE FROM journal_entries WHERE id = ?").run(id);
      }
      db.prepare("UPDATE import_batches SET status = 'DISCARDED' WHERE id = ?").run(batch.id);
      return ids.length;
    });
    res.json({ batchId: batch.id, status: "DISCARDED", deletedDrafts: run() });
  } catch (err: any) {
    res.status(hasHttpStatus(err) ? err.status : 500).json({ error: err?.message || "Could not discard this batch" });
  }
});

app.get("/api/import-batches", (req, res) => {
  const visible = visibleEntityIds(req);
  let rows = db
    .prepare("SELECT id, source, filename, entityId, status, rowCount, entryCount, quarantineCount, createdAt, postedAt FROM import_batches ORDER BY id DESC LIMIT 100")
    .all() as any[];
  if (visible) rows = rows.filter((b) => canAccessEntity(req, b.entityId));
  res.json(rows);
});

app.get("/api/import-batches/:id", (req, res) => {
  const batch = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(req.params.id) as any;
  if (!batch) return res.status(404).json({ error: "Import batch not found" });
  if (!canAccessEntity(req, batch.entityId)) return res.status(403).json({ error: "You don't have access to this import's entity" });
  const entries = db
    .prepare("SELECT id, entryNumber, transactionDate, description, reference, status FROM journal_entries WHERE importBatchId = ? ORDER BY transactionDate, id")
    .all(batch.id);
  res.json({ ...batch, payload: JSON.parse(batch.payloadJson || "{}"), entries });
});

// ======= EXCHANGE RATES =======
// The rate a posting would use for a currency on a given date — what the
// Journal Entry screen pre-fills its Exchange Rate field with (and can be
// overridden there). Same resolver the posting engine uses, so what the form
// shows is what would post.
app.get("/api/exchange-rates/resolve", (req, res) => {
  const currency = String((req.query as any).currency ?? "USD").trim().toUpperCase() || "USD";
  const date = String((req.query as any).date ?? todayIso());
  const period = statutoryPeriodOf(date);
  const resolved = resolveExchangeRate(currency, period);
  res.json({ currency, date, period, ...resolved });
});

app.get("/api/exchange-rates", (req, res) => {
  const { month } = req.query as any;
  let q = "SELECT * FROM exchange_rates WHERE 1=1";
  if (month) q += ` AND effectiveMonth = '${month}'`;
  q += " ORDER BY effectiveMonth DESC, currency";
  res.json(db.prepare(q).all());
});

app.post("/api/exchange-rates", (req, res) => {
  const { currency, rateToUsd, effectiveMonth, notes } = req.body;
  const r = db
    .prepare(
      "INSERT OR REPLACE INTO exchange_rates (currency,rateToUsd,effectiveMonth,notes) VALUES (?,?,?,?)",
    )
    .run(currency, rateToUsd, effectiveMonth, notes || "");
  res.json(
    db
      .prepare("SELECT * FROM exchange_rates WHERE id=?")
      .get(r.lastInsertRowid),
  );
});

app.delete("/api/exchange-rates/:id", (req, res) => {
  db.prepare("DELETE FROM exchange_rates WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});


// ======= INTERCOMPANY TRANSACTIONS =======
app.get("/api/intercompany-transactions", (req, res) => {
  const { month } = req.query as any;
  const rows = db
    .prepare(`SELECT * FROM intercompany_transactions WHERE 1=1 ${dateFilter(month)} ORDER BY date DESC`)
    .all();
  res.json(rows);
});

app.post("/api/intercompany-transactions", (req, res) => {
  const d = req.body;
  const usd = (d.originalAmount || 0) * (d.exchangeRate || 1);
  const r = db
    .prepare(
      `INSERT INTO intercompany_transactions (fromEntity,toEntity,originalCurrency,originalAmount,exchangeRate,usdAmount,date,description) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(d.fromEntity, d.toEntity, d.originalCurrency || "USD", d.originalAmount || 0, d.exchangeRate || 1, usd, d.date, d.description || "");
  res.json(db.prepare("SELECT * FROM intercompany_transactions WHERE id=?").get(r.lastInsertRowid));
});

app.put("/api/intercompany-transactions/:id", (req, res) => {
  const d = req.body;
  const usd = (d.originalAmount || 0) * (d.exchangeRate || 1);
  db.prepare(
    `UPDATE intercompany_transactions SET fromEntity=?,toEntity=?,originalCurrency=?,originalAmount=?,exchangeRate=?,usdAmount=?,date=?,description=? WHERE id=?`,
  ).run(d.fromEntity, d.toEntity, d.originalCurrency || "USD", d.originalAmount || 0, d.exchangeRate || 1, usd, d.date, d.description || "", req.params.id);
  res.json(db.prepare("SELECT * FROM intercompany_transactions WHERE id=?").get(req.params.id));
});

app.delete("/api/intercompany-transactions/:id", (req, res) => {
  db.prepare("DELETE FROM intercompany_transactions WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ======= PLAID BANK CONNECTIONS =======
// Reports whether Plaid can actually be used, and why not when it can't —
// credentials present, environment valid, and the product/country scope the
// Link token will be created with. Never returns the secret itself.
app.get("/api/plaid/status", (_req, res) => {
  const configured = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
  let env: string | null = null;
  let configError: string | null = null;
  try {
    env = resolvePlaidEnv().env;
  } catch (err: any) {
    configError = err.message;
  }
  res.json({
    configured,
    ready: configured && !configError,
    configError: configured ? configError : "PLAID_CLIENT_ID / PLAID_SECRET are not set",
    env,
    products: plaidProductsFromEnv(),
    countryCodes: plaidCountryCodesFromEnv(),
    linkedItems: (db.prepare("SELECT COUNT(*) as count FROM plaid_items").get() as any).count,
  });
});

app.post("/api/plaid/link-token", async (req, res) => {
  // client_user_id must be a stable, non-empty string identifying the end
  // user; the signed-in user's id is exactly that (it was a hardcoded
  // constant, so every linked item looked like the same person to Plaid).
  const userId = (req as any).auth?.user?.id;
  const clientUserId = String(userId ?? "finance-app-user").trim() || "finance-app-user";
  const products = plaidProductsFromEnv();
  const countryCodes = plaidCountryCodesFromEnv();
  try {
    const { env } = resolvePlaidEnv();
    console.log(`[plaid] link-token: env=${env} products=${products.join(",")} countries=${countryCodes.join(",")} client_user_id=${clientUserId}`);
    const response = await plaidClient().linkTokenCreate({
      client_name: "TekRevol FinSys",
      language: "en",
      country_codes: countryCodes,
      user: { client_user_id: clientUserId },
      products,
    });
    res.json({ linkToken: response.data.link_token });
  } catch (error: any) {
    // A configuration problem (missing keys, retired PLAID_ENV) never
    // reached Plaid at all — that is a 500 here, not a bad gateway.
    if (!error?.response) {
      console.error(`[plaid] link-token blocked by configuration: ${error?.message}`);
      return res.status(500).json({ message: error?.message || "Plaid is not configured", errorCode: "CONFIGURATION" });
    }
    res.status(502).json(logPlaidError("link-token", error));
  }
});

app.get("/api/plaid/items", (_req, res) => {
  res.json(
    db.prepare(
      `SELECT i.id, i.itemId, i.institutionId, i.institutionName, i.provider, i.country, i.icon, i.isManual,
        i.createdAt, i.updatedAt, COUNT(a.id) as accountCount,
        CASE WHEN COUNT(a.currentBalance) > 0 THEN 1 ELSE 0 END as hasBalance,
        COALESCE(SUM(a.currentBalance), 0) as currentBalance,
        COALESCE(SUM(a.availableBalance), 0) as availableBalance,
        MAX(a.isoCurrency) as balanceCurrency
       FROM plaid_items i
       LEFT JOIN plaid_accounts a ON a.itemId = i.id
       GROUP BY i.id
       ORDER BY i.createdAt DESC`,
    ).all(),
  );
});

app.get("/api/plaid/accounts", (_req, res) => {
  res.json(db.prepare(
    `SELECT a.*, i.institutionName
     FROM plaid_accounts a
     JOIN plaid_items i ON i.id = a.itemId
     ORDER BY i.institutionName, a.name`,
  ).all());
});

app.get("/api/plaid/items/:id/statements", (req, res) => {
  const item = db.prepare("SELECT id FROM plaid_items WHERE id = ?").get(req.params.id);
  if (!item) return res.status(404).json({ message: "Plaid item not found" });
  res.json(db.prepare(
    `SELECT id, itemId, originalName, mimeType, fileSize, createdAt
     FROM bank_statements
     WHERE itemId = ?
     ORDER BY createdAt DESC, id DESC`,
  ).all(Number(req.params.id)));
});

app.post("/api/plaid/items/:id/statements", bankStatementUpload.single("statement"), (req, res) => {
  const item = db.prepare("SELECT id FROM plaid_items WHERE id = ?").get(req.params.id);
  if (!item) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    return res.status(404).json({ message: "Plaid item not found" });
  }
  if (!req.file) return res.status(400).json({ message: "Choose a bank statement file to upload" });

  const result = db.prepare(
    `INSERT INTO bank_statements (itemId, originalName, storedName, mimeType, fileSize)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(Number(req.params.id), req.file.originalname, req.file.filename, req.file.mimetype || "", req.file.size);
  res.status(201).json({
    id: result.lastInsertRowid,
    itemId: Number(req.params.id),
    originalName: req.file.originalname,
    mimeType: req.file.mimetype || "",
    fileSize: req.file.size,
  });
});

app.get("/api/plaid/statements/:id/download", (req, res) => {
  const statement = db.prepare("SELECT * FROM bank_statements WHERE id = ?").get(req.params.id) as any;
  if (!statement) return res.status(404).json({ message: "Bank statement not found" });
  const filePath = path.join(BANK_STATEMENT_UPLOAD_DIR, statement.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ message: "Bank statement file is missing" });
  res.download(filePath, statement.originalName);
});

const MANUAL_BANK_CURRENCIES: Record<string, string> = {
  AE: "AED",
  BH: "BHD",
  KW: "KWD",
  OM: "OMR",
  QA: "QAR",
  SA: "SAR",
  PK: "PKR",
};

const MANUAL_BANK_NAMES: Record<string, string> = {
  AE: "United Arab Emirates",
  BH: "Bahrain",
  KW: "Kuwait",
  OM: "Oman",
  QA: "Qatar",
  SA: "Saudi Arabia",
  PK: "Pakistan",
};

app.post("/api/plaid/manual-items", (req, res) => {
  const institutionName = String(req.body?.institutionName || "").trim();
  const country = String(req.body?.country || "").trim().toUpperCase();
  const icon = String(req.body?.icon || "🏦").trim().slice(0, 8) || "🏦";
  if (!institutionName) return res.status(400).json({ message: "Bank name is required" });
  if (!MANUAL_BANK_CURRENCIES[country]) {
    return res.status(400).json({ message: "Choose a supported GCC or Pakistan country" });
  }

  const currency = MANUAL_BANK_CURRENCIES[country];
  const itemId = `manual-${crypto.randomUUID()}`;
  const savedItemId = Number(db.prepare(
    `INSERT INTO plaid_items
      (itemId, institutionId, institutionName, accessToken, provider, country, icon, isManual)
     VALUES (?, '', ?, ?, 'manual', ?, ?, 1)`,
  ).run(
    itemId,
    institutionName,
    encryptSecret("manual-bank"),
    country,
    icon,
  ).lastInsertRowid);
  const accountId = `manual-account-${savedItemId}`;
  db.prepare(
    `INSERT INTO plaid_accounts
      (itemId, plaidAccountId, name, officialName, mask, type, subtype, isoCurrency,
       currentBalance, availableBalance)
     VALUES (?, ?, ?, ?, '', 'depository', 'checking', ?, NULL, NULL)`,
  ).run(
    savedItemId,
    accountId,
    `${institutionName} Operating`,
    `${institutionName} Operating Account`,
    currency,
  );
  res.status(201).json({
    itemId: savedItemId,
    institutionName,
    countryName: MANUAL_BANK_NAMES[country],
    currency,
  });
});

// Alias: the public-token exchange is documented both ways.
app.post(["/api/plaid/exchange", "/api/plaid/exchange-token"], async (req, res) => {
  const publicToken = String(req.body?.publicToken || "").trim();
  const institution = req.body?.institution || {};
  if (!publicToken) return res.status(400).json({ message: "Plaid public token is required" });

  try {
    const client = plaidClient();
    const exchange = await client.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchange.data.access_token;
    const plaidItemId = exchange.data.item_id;
    const accountsResponse = await client.accountsGet({ access_token: accessToken });
    const existing = db.prepare("SELECT id FROM plaid_items WHERE itemId = ?").get(plaidItemId) as { id: number } | undefined;
    const savedItemId = existing?.id || Number(db.prepare(
      `INSERT INTO plaid_items (itemId, institutionId, institutionName, accessToken)
       VALUES (?, ?, ?, ?)`,
    ).run(
      plaidItemId,
      String(institution.institution_id || ""),
      String(institution.name || "Connected institution"),
      encryptSecret(accessToken),
    ).lastInsertRowid);

    if (existing) {
      db.prepare(
        `UPDATE plaid_items
         SET institutionId = ?, institutionName = ?, accessToken = ?, updatedAt = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(
        String(institution.institution_id || ""),
        String(institution.name || "Connected institution"),
        encryptSecret(accessToken),
        existing.id,
      );
    }

    const insertAccount = db.prepare(
      `INSERT INTO plaid_accounts
        (itemId, plaidAccountId, name, officialName, mask, type, subtype, isoCurrency,
         currentBalance, availableBalance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plaidAccountId) DO UPDATE SET
        name = excluded.name, officialName = excluded.officialName, mask = excluded.mask,
        type = excluded.type, subtype = excluded.subtype, isoCurrency = excluded.isoCurrency,
        currentBalance = excluded.currentBalance, availableBalance = excluded.availableBalance`,
    );
    const saveAccounts = db.transaction((accounts: any[]) => accounts.forEach((account) => {
      insertAccount.run(
        savedItemId,
        account.account_id,
        account.name || "Bank account",
        account.official_name || "",
        account.mask || "",
        account.type || "",
        account.subtype || "",
        account.balances?.iso_currency_code || "USD",
        account.balances?.current ?? null,
        account.balances?.available ?? null,
      );
    }));
    saveAccounts(accountsResponse.data.accounts);
    console.log(`[plaid] exchange: linked "${institution.name || "Connected institution"}" — ${accountsResponse.data.accounts.length} account(s), item ${plaidItemId}`);
    // The accounts just linked are returned in full (2026-09-18). The
    // mapping step used to re-read a cached /plaid/accounts list and match
    // it by institution name, which showed "No new accounts to assign"
    // whenever that cache was stale or the name differed. It now maps what
    // this response hands it, with `alreadyMapped` telling the UI which
    // ones already back a bank feed instead of hiding them.
    const feedFor = db.prepare(
      "SELECT ba.id, ba.name, ba.entityId, e.name AS entityName FROM bank_accounts ba LEFT JOIN entities e ON e.id = ba.entityId WHERE ba.plaidAccountId = ?",
    );
    const linkedAccounts = accountsResponse.data.accounts.map((a: any) => {
      const feed = feedFor.get(a.account_id) as any;
      return {
        plaidAccountId: a.account_id,
        name: a.name || "Bank account",
        officialName: a.official_name || "",
        mask: a.mask || "",
        type: a.type || "",
        subtype: a.subtype || "",
        isoCurrency: a.balances?.iso_currency_code || "USD",
        alreadyMapped: feed
          ? { bankAccountId: feed.id, name: feed.name, entityId: feed.entityId, entityName: feed.entityName }
          : null,
      };
    });
    res.json({
      itemId: savedItemId,
      institutionName: institution.name || "Connected institution",
      accounts: accountsResponse.data.accounts.length,
      linkedAccounts,
    });
  } catch (error: any) {
    if (!error?.response) {
      console.error(`[plaid] exchange blocked by configuration: ${error?.message}`);
      return res.status(500).json({ message: error?.message || "Plaid is not configured", errorCode: "CONFIGURATION" });
    }
    res.status(502).json(logPlaidError("exchange", error));
  }
});

app.delete("/api/plaid/items/:id", async (req, res) => {
  const item = db.prepare("SELECT * FROM plaid_items WHERE id = ?").get(req.params.id) as any;
  if (!item) return res.status(404).json({ message: "Plaid item not found" });
  if (!item.isManual) {
    try {
      await plaidClient().itemRemove({ access_token: decryptSecret(item.accessToken) });
    } catch (error) {
      console.warn("Plaid item removal warning:", plaidErrorMessage(error));
    }
  }
  db.prepare("DELETE FROM plaid_items WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Last-resort JSON error handler (2026-09-17). Routes that don't catch their
// own errors — including access checks (AccessError) thrown from inside a
// handler — get a proper status + JSON body instead of Express's HTML 500.
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  if (hasHttpStatus(err)) return res.status(err.status).json({ error: err.message, code: (err as any).code });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// In production, serve the built React app from dist/public
if (process.env.NODE_ENV === "production") {
  const distPath = path.join(__dirname, "..", "dist", "public");
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const PORT = parseInt(
  process.env.NODE_ENV === "production"
    ? process.env.PORT || "5000"
    : process.env.SERVER_PORT || "3001",
);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TekRevol FinSys API server running on port ${PORT}`);
});
