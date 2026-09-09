import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import fs from "fs";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from "plaid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "finance.db"));
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

  CREATE TABLE IF NOT EXISTS revenue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    brand TEXT NOT NULL,
    projectName TEXT DEFAULT '',
    client TEXT NOT NULL,
    revenueType TEXT NOT NULL DEFAULT 'Fresh',
    originalCurrency TEXT NOT NULL DEFAULT 'USD',
    originalAmount REAL NOT NULL DEFAULT 0,
    exchangeRate REAL NOT NULL DEFAULT 1,
    usdAmount REAL NOT NULL DEFAULT 0,
    notes TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    vendor TEXT NOT NULL,
    expenseCategory TEXT DEFAULT '',
    expenseHead TEXT NOT NULL,
    department TEXT DEFAULT '',
    description TEXT DEFAULT '',
    originalCurrency TEXT NOT NULL DEFAULT 'USD',
    originalAmount REAL NOT NULL DEFAULT 0,
    exchangeRate REAL NOT NULL DEFAULT 1,
    usdAmount REAL NOT NULL DEFAULT 0,
    paidByEntity TEXT NOT NULL DEFAULT 'PK',
    paidFromBank TEXT NOT NULL DEFAULT 'PK Bank',
    costOwner TEXT NOT NULL DEFAULT 'Shared',
    allocationMethod TEXT NOT NULL DEFAULT 'Percentage',
    caPct REAL DEFAULT 0,
    txPct REAL DEFAULT 0,
    uaePct REAL DEFAULT 0,
    pkPct REAL DEFAULT 0,
    buzzPct REAL DEFAULT 0,
    notes TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS exchange_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT NOT NULL,
    rateToUsd REAL NOT NULL DEFAULT 1,
    effectiveMonth TEXT NOT NULL,
    notes TEXT DEFAULT '',
    UNIQUE(currency, effectiveMonth)
  );

  CREATE TABLE IF NOT EXISTS allocation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    caPct REAL DEFAULT 0,
    txPct REAL DEFAULT 0,
    uaePct REAL DEFAULT 0,
    pkPct REAL DEFAULT 0,
    buzzPct REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS expense_monthly_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expenseId INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    caPct REAL DEFAULT 0,
    txPct REAL DEFAULT 0,
    uaePct REAL DEFAULT 0,
    pkPct REAL DEFAULT 0,
    buzzPct REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS revenue_monthly_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revenueId INTEGER NOT NULL REFERENCES revenue(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0
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

  CREATE TABLE IF NOT EXISTS plaid_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId INTEGER NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
    plaidTransactionId TEXT NOT NULL UNIQUE,
    plaidAccountId TEXT NOT NULL,
    date TEXT NOT NULL,
    authorizedDate TEXT DEFAULT '',
    name TEXT NOT NULL,
    merchantName TEXT DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    isoCurrency TEXT DEFAULT 'USD',
    pending INTEGER NOT NULL DEFAULT 0,
    category TEXT DEFAULT '',
    rawJson TEXT NOT NULL DEFAULT '{}',
    isSample INTEGER NOT NULL DEFAULT 0,
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

ensureColumn("expenses", "department", "department TEXT DEFAULT ''");
ensureColumn("expenses", "accountId", "accountId INTEGER");
ensureColumn("expenses", "actualMonth", "actualMonth TEXT DEFAULT ''");
ensureColumn("revenue", "actualMonth", "actualMonth TEXT DEFAULT ''");
ensureColumn("revenue", "cashReceivedIn", "cashReceivedIn TEXT DEFAULT ''");
ensureColumn("plaid_items", "provider", "provider TEXT NOT NULL DEFAULT 'plaid'");
ensureColumn("plaid_items", "country", "country TEXT DEFAULT ''");
ensureColumn("plaid_items", "icon", "icon TEXT DEFAULT ''");
ensureColumn("plaid_items", "isManual", "isManual INTEGER NOT NULL DEFAULT 0");
ensureColumn("plaid_transactions", "isSample", "isSample INTEGER NOT NULL DEFAULT 0");
ensureColumn("plaid_transactions", "reviewStatus", "reviewStatus TEXT NOT NULL DEFAULT 'pending'");
ensureColumn("plaid_accounts", "currentBalance", "currentBalance REAL DEFAULT NULL");
ensureColumn("plaid_accounts", "availableBalance", "availableBalance REAL DEFAULT NULL");

// Remove the temporary demo feed that was created while validating the
// unsupported-bank UI. Manual banks added by users are retained.
try {
  db.prepare("DELETE FROM plaid_transactions WHERE isSample = 1").run();
  db.prepare(
    "DELETE FROM plaid_items WHERE isManual = 1 AND lower(institutionName) LIKE '%demo%'",
  ).run();
} catch (e) {
  console.error("Migration error (remove demo bank feed):", e);
}

// Backfill Actual Month from the entry Date for any pre-existing rows so every
// report (which now keys off Actual Month) keeps working for old data.
try {
  db.prepare(
    `UPDATE expenses SET actualMonth = substr(date, 1, 7) WHERE (actualMonth IS NULL OR actualMonth = '') AND date IS NOT NULL AND date != ''`,
  ).run();
  db.prepare(
    `UPDATE revenue SET actualMonth = substr(date, 1, 7) WHERE (actualMonth IS NULL OR actualMonth = '') AND date IS NOT NULL AND date != ''`,
  ).run();
} catch (e) {
  console.error("Migration error (actualMonth backfill):", e);
}

// Seed default departments (no-op if already present)
try {
  const defaultDepartments = [
    "Engineering",
    "Sales",
    "Marketing",
    "Operations",
    "Finance",
    "HR",
    "Admin",
    "Other",
  ];
  const insertDept = db.prepare(
    "INSERT OR IGNORE INTO departments (name) VALUES (?)",
  );
  const seed = db.transaction((names: string[]) => {
    names.forEach((n) => insertDept.run(n));
  });
  seed(defaultDepartments);
  // Backfill departments from any existing expense rows
  const existingDeptRows = db
    .prepare(
      "SELECT DISTINCT department FROM expenses WHERE department IS NOT NULL AND department != ''",
    )
    .all() as any[];
  seed(existingDeptRows.map((r) => r.department));
} catch (e) {
  console.error("Migration error (seed departments):", e);
}

// Data integrity: migrate legacy Expense Head values into Expense Category where category is blank
try {
  db.prepare(
    `UPDATE expenses SET expenseCategory = expenseHead WHERE (expenseCategory IS NULL OR expenseCategory = '') AND expenseHead IS NOT NULL AND expenseHead != ''`,
  ).run();
} catch (e) {
  console.error("Migration error (expenseHead -> expenseCategory backfill):", e);
}

function upsertDepartment(name?: string) {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  try {
    db.prepare("INSERT OR IGNORE INTO departments (name) VALUES (?)").run(
      trimmed,
    );
  } catch (e) {
    console.error("Failed to upsert department:", e);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function plaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error("Plaid credentials are not configured in Replit Secrets");
  }
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
        },
      },
    }),
  );
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

function allocated(e: any) {
  const u = e.usdAmount || 0;
  return {
    ca: (u * (e.caPct || 0)) / 100,
    tx: (u * (e.txPct || 0)) / 100,
    uae: (u * (e.uaePct || 0)) / 100,
    pk: (u * (e.pkPct || 0)) / 100,
    buzz: (u * (e.buzzPct || 0)) / 100,
  };
}

const BRAND_ALLOC_KEY: Record<string, string> = {
  CA: "caPct",
  TX: "txPct",
  UAE: "uaePct",
  PK: "pkPct",
  BuzzFlick: "buzzPct",
};

// ======= LEDGER HELPERS =======
// Every report reads from these flattened ledgers so Actual Month, Monthly
// Allocation, and per-month Brand Allocation are automatically respected
// everywhere, while records with no monthly split fall back to their single
// top-level Actual Month / percentages (fully backward compatible).

function replaceExpenseMonthlyAllocations(expenseId: number, rows: any[] | undefined) {
  db.prepare("DELETE FROM expense_monthly_allocations WHERE expenseId = ?").run(expenseId);
  if (!Array.isArray(rows) || rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO expense_monthly_allocations (expenseId, month, amount, caPct, txPct, uaePct, pkPct, buzzPct) VALUES (?,?,?,?,?,?,?,?)`,
  );
  rows.forEach((r) => {
    if (!r || !r.month) return;
    insert.run(
      expenseId,
      r.month,
      Number(r.amount) || 0,
      Number(r.caPct) || 0,
      Number(r.txPct) || 0,
      Number(r.uaePct) || 0,
      Number(r.pkPct) || 0,
      Number(r.buzzPct) || 0,
    );
  });
}

function replaceRevenueMonthlyAllocations(revenueId: number, rows: any[] | undefined) {
  db.prepare("DELETE FROM revenue_monthly_allocations WHERE revenueId = ?").run(revenueId);
  if (!Array.isArray(rows) || rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO revenue_monthly_allocations (revenueId, month, amount) VALUES (?,?,?)`,
  );
  rows.forEach((r) => {
    if (!r || !r.month) return;
    insert.run(revenueId, r.month, Number(r.amount) || 0);
  });
}

function getExpenseMonthlyAllocations(expenseId: number) {
  return db
    .prepare("SELECT month, amount, caPct, txPct, uaePct, pkPct, buzzPct FROM expense_monthly_allocations WHERE expenseId = ? ORDER BY month")
    .all(expenseId);
}

function getRevenueMonthlyAllocations(revenueId: number) {
  return db
    .prepare("SELECT month, amount FROM revenue_monthly_allocations WHERE revenueId = ? ORDER BY month")
    .all(revenueId);
}

function hydrateExpense(e: any) {
  return { ...e, monthlyAllocations: getExpenseMonthlyAllocations(e.id) };
}

function hydrateRevenue(r: any) {
  return { ...r, monthlyAllocations: getRevenueMonthlyAllocations(r.id) };
}

function buildExpenseLedger(monthFilter?: string) {
  const expenses = db
    .prepare(
      `SELECT e.*, a.category as accountCategory, a.name as accountName FROM expenses e LEFT JOIN accounts a ON a.id = e.accountId`,
    )
    .all() as any[];
  const allAllocRows = db.prepare(`SELECT * FROM expense_monthly_allocations`).all() as any[];
  const allocByExpense: Record<number, any[]> = {};
  allAllocRows.forEach((r) => {
    (allocByExpense[r.expenseId] ||= []).push(r);
  });

  const ledger: any[] = [];
  for (const e of expenses) {
    const expenseType = e.accountName || e.expenseCategory || e.vendor;
    const expenseCategory = e.accountCategory || e.expenseCategory || "Other";
    const rows = allocByExpense[e.id];
    if (rows && rows.length > 0) {
      for (const r of rows) {
        ledger.push({
          expenseId: e.id,
          month: r.month,
          usdAmount: r.amount,
          caPct: r.caPct,
          txPct: r.txPct,
          uaePct: r.uaePct,
          pkPct: r.pkPct,
          buzzPct: r.buzzPct,
          paidByEntity: e.paidByEntity,
          paidFromBank: e.paidFromBank,
          expenseType,
          expenseCategory,
          vendor: e.vendor,
          department: e.department,
        });
      }
    } else {
      const month = e.actualMonth || (e.date ? String(e.date).slice(0, 7) : "");
      ledger.push({
        expenseId: e.id,
        month,
        usdAmount: e.usdAmount,
        caPct: e.caPct,
        txPct: e.txPct,
        uaePct: e.uaePct,
        pkPct: e.pkPct,
        buzzPct: e.buzzPct,
        paidByEntity: e.paidByEntity,
        paidFromBank: e.paidFromBank,
        expenseType,
        expenseCategory,
        vendor: e.vendor,
        department: e.department,
      });
    }
  }
  return monthFilter ? ledger.filter((r) => monthMatches(r.month, monthFilter)) : ledger;
}

function buildRevenueLedger(monthFilter?: string) {
  const revenue = db.prepare(`SELECT * FROM revenue`).all() as any[];
  const allAllocRows = db.prepare(`SELECT * FROM revenue_monthly_allocations`).all() as any[];
  const allocByRevenue: Record<number, any[]> = {};
  allAllocRows.forEach((r) => {
    (allocByRevenue[r.revenueId] ||= []).push(r);
  });

  const ledger: any[] = [];
  for (const r of revenue) {
    const rows = allocByRevenue[r.id];
    if (rows && rows.length > 0) {
      for (const alloc of rows) {
        ledger.push({
          revenueId: r.id,
          month: alloc.month,
          usdAmount: alloc.amount,
          brand: r.brand,
          revenueType: r.revenueType,
          client: r.client,
          cashReceivedIn: r.cashReceivedIn,
        });
      }
    } else {
      const month = r.actualMonth || (r.date ? String(r.date).slice(0, 7) : "");
      ledger.push({
        revenueId: r.id,
        month,
        usdAmount: r.usdAmount,
        brand: r.brand,
        revenueType: r.revenueType,
        client: r.client,
        cashReceivedIn: r.cashReceivedIn,
      });
    }
  }
  return monthFilter ? ledger.filter((x) => monthMatches(x.month, monthFilter)) : ledger;
}

// ======= ACCOUNTS (Chart of Accounts: Expense/Revenue Category + Type) =======
app.get("/api/accounts", (req, res) => {
  const { type } = req.query as any;
  let q = "SELECT * FROM accounts";
  if (type) q += ` WHERE type = '${type}'`;
  q += " ORDER BY code";
  res.json(db.prepare(q).all());
});

app.post("/api/accounts", (req, res) => {
  const { code, category, name, type, description } = req.body;
  const r = db
    .prepare(
      "INSERT INTO accounts (code,category,name,type,description) VALUES (?,?,?,?,?)",
    )
    .run(code, category, name, type, description || "");
  res.json(
    db.prepare("SELECT * FROM accounts WHERE id=?").get(r.lastInsertRowid),
  );
});

app.put("/api/accounts/:id", (req, res) => {
  const { code, category, name, type, description } = req.body;
  db.prepare(
    "UPDATE accounts SET code=?,category=?,name=?,type=?,description=? WHERE id=?",
  ).run(code, category, name, type, description || "", req.params.id);
  res.json(db.prepare("SELECT * FROM accounts WHERE id=?").get(req.params.id));
});

app.delete("/api/accounts/:id", (req, res) => {
  db.prepare("DELETE FROM accounts WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/accounts/bulk-delete", (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ deleted: 0 });
  const del = db.prepare("DELETE FROM accounts WHERE id=?");
  const delMany = db.transaction((ids: number[]) =>
    ids.map((id) => del.run(id)),
  );
  const results = delMany(ids);
  res.json({ deleted: results.length });
});

app.post("/api/accounts/bulk", (req, res) => {
  const rows: any[] = Array.isArray(req.body) ? req.body : [];
  const insert = db.prepare(
    "INSERT INTO accounts (code,category,name,type,description) VALUES (?,?,?,?,?)",
  );

  const totalRows = rows.length;
  const errors: { row: number; reason: string }[] = [];
  const validRows: any[] = [];

  rows.forEach((r, idx) => {
    const rowNum = idx + 2; // account for header row in spreadsheet
    const code = String(r.code ?? "").trim();
    const category = String(r.category ?? "").trim();
    const name = String(r.name ?? "").trim();
    const type = String(r.type ?? "").trim().toLowerCase();
    const description = String(r.description ?? "").trim();

    if (!code) {
      errors.push({ row: rowNum, reason: "Account Code is required" });
      return;
    }
    if (!category) {
      errors.push({ row: rowNum, reason: "Account Category is required" });
      return;
    }
    if (!name) {
      errors.push({ row: rowNum, reason: "Account Name is required" });
      return;
    }
    if (type !== "revenue" && type !== "expense") {
      errors.push({
        row: rowNum,
        reason: `Type must be "revenue" or "expense" (got "${r.type}")`,
      });
      return;
    }
    validRows.push({ code, category, name, type, description });
  });

  const insertMany = db.transaction((rows: any[]) =>
    rows.map((d) => insert.run(d.code, d.category, d.name, d.type, d.description)),
  );
  const results = validRows.length > 0 ? insertMany(validRows) : [];

  res.json({
    totalRows,
    successCount: results.length,
    failedCount: errors.length,
    errors,
  });
});

// ======= REVENUE =======
app.get("/api/revenue", (req, res) => {
  const { month } = req.query as any;
  const rows = db
    .prepare(
      `SELECT * FROM revenue WHERE 1=1 ${dateFilter(month, "actualMonth")} ORDER BY date DESC`,
    )
    .all() as any[];
  res.json(rows.map(hydrateRevenue));
});

app.post("/api/revenue", (req, res) => {
  const d = req.body;
  const usd = (d.originalAmount || 0) * (d.exchangeRate || 1);
  const actualMonth = d.actualMonth || (d.date ? String(d.date).slice(0, 7) : "");
  const r = db
    .prepare(
      `INSERT INTO revenue (date,brand,projectName,client,revenueType,originalCurrency,originalAmount,exchangeRate,usdAmount,notes,actualMonth,cashReceivedIn) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      d.date,
      d.brand,
      d.projectName || "",
      d.client,
      d.revenueType || "Fresh",
      d.originalCurrency || "USD",
      d.originalAmount || 0,
      d.exchangeRate || 1,
      usd,
      d.notes || "",
      actualMonth,
      d.cashReceivedIn || "",
    );
  replaceRevenueMonthlyAllocations(Number(r.lastInsertRowid), d.monthlyAllocations);
  res.json(
    hydrateRevenue(db.prepare("SELECT * FROM revenue WHERE id=?").get(r.lastInsertRowid)),
  );
});

app.post("/api/revenue/bulk", (req, res) => {
  const rows: any[] = Array.isArray(req.body) ? req.body : [];
  const insert = db.prepare(
    `INSERT INTO revenue (date,brand,projectName,client,revenueType,originalCurrency,originalAmount,exchangeRate,usdAmount,notes,actualMonth,cashReceivedIn) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const totalRows = rows.length;
  const errors: { row: number; reason: string }[] = [];
  const validRows: any[] = [];

  rows.forEach((d, idx) => {
    const rowNum = idx + 2;
    const date = String(d.date ?? "").trim();
    const client = String(d.client ?? "").trim();
    if (!date) {
      errors.push({ row: rowNum, reason: "Date is required" });
      return;
    }
    if (!client) {
      errors.push({ row: rowNum, reason: "Client is required" });
      return;
    }
    validRows.push({ ...d, date, client });
  });

  const insertMany = db.transaction((rows: any[]) =>
    rows.map((d) => {
      const usd = (d.originalAmount || 0) * (d.exchangeRate || 1);
      const actualMonth = d.actualMonth || (d.date ? String(d.date).slice(0, 7) : "");
      return insert.run(
        d.date,
        d.brand || "CA",
        d.projectName || "",
        d.client,
        d.revenueType || "Fresh",
        d.originalCurrency || "USD",
        d.originalAmount || 0,
        d.exchangeRate || 1,
        usd,
        d.notes || "",
        actualMonth,
        d.cashReceivedIn || "",
      );
    }),
  );
  const results = validRows.length > 0 ? insertMany(validRows) : [];

  res.json({
    inserted: results.length,
    totalRows,
    successCount: results.length,
    failedCount: errors.length,
    errors,
  });
});

app.put("/api/revenue/:id", (req, res) => {
  const d = req.body;
  const usd = (d.originalAmount || 0) * (d.exchangeRate || 1);
  const actualMonth = d.actualMonth || (d.date ? String(d.date).slice(0, 7) : "");
  db.prepare(
    `UPDATE revenue SET date=?,brand=?,projectName=?,client=?,revenueType=?,originalCurrency=?,originalAmount=?,exchangeRate=?,usdAmount=?,notes=?,actualMonth=?,cashReceivedIn=? WHERE id=?`,
  ).run(
    d.date,
    d.brand,
    d.projectName || "",
    d.client,
    d.revenueType || "Fresh",
    d.originalCurrency || "USD",
    d.originalAmount || 0,
    d.exchangeRate || 1,
    usd,
    d.notes || "",
    actualMonth,
    d.cashReceivedIn || "",
    req.params.id,
  );
  replaceRevenueMonthlyAllocations(Number(req.params.id), d.monthlyAllocations);
  res.json(hydrateRevenue(db.prepare("SELECT * FROM revenue WHERE id=?").get(req.params.id)));
});

app.post("/api/revenue/bulk-delete", (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ deleted: 0 });
  const del = db.prepare("DELETE FROM revenue WHERE id=?");
  const delMany = db.transaction((ids: number[]) =>
    ids.map((id) => del.run(id)),
  );
  const results = delMany(ids);
  res.json({ deleted: results.length });
});

app.delete("/api/revenue/:id", (req, res) => {
  db.prepare("DELETE FROM revenue WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/revenue/clients", (req, res) => {
  const rows = db
    .prepare("SELECT DISTINCT client FROM revenue ORDER BY client")
    .all() as any[];
  res.json(rows.map((r) => r.client));
});

// ======= DEPARTMENTS =======
app.get("/api/departments", (req, res) => {
  res.json(db.prepare("SELECT * FROM departments ORDER BY name").all());
});

app.post("/api/departments", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Department name is required" });
  const existing = db
    .prepare("SELECT * FROM departments WHERE name = ? COLLATE NOCASE")
    .get(name);
  if (existing) return res.json(existing);
  const r = db.prepare("INSERT INTO departments (name) VALUES (?)").run(name);
  res.json(db.prepare("SELECT * FROM departments WHERE id=?").get(r.lastInsertRowid));
});

// ======= EXPENSES =======
app.get("/api/expenses", (req, res) => {
  const { month } = req.query as any;
  const rows = db
    .prepare(
      `SELECT e.*, a.category as accountCategory, a.name as accountName FROM expenses e LEFT JOIN accounts a ON a.id = e.accountId WHERE 1=1 ${dateFilter(month, "e.actualMonth")} ORDER BY e.date DESC`,
    )
    .all() as any[];
  res.json(rows.map(hydrateExpense));
});

function resolveExpenseCategoryFromAccount(accountId?: number | null, fallback?: string) {
  if (accountId) {
    const acc = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as any;
    if (acc) return { expenseCategory: acc.category, expenseHead: acc.name };
  }
  return { expenseCategory: fallback || "", expenseHead: fallback || "" };
}

app.post("/api/expenses", (req, res) => {
  const d = req.body;
  const usd = (d.originalAmount || 0) * (d.exchangeRate || 1);
  upsertDepartment(d.department);
  const { expenseCategory, expenseHead } = resolveExpenseCategoryFromAccount(d.accountId, d.expenseCategory);
  const actualMonth = d.actualMonth || (d.date ? String(d.date).slice(0, 7) : "");
  const r = db
    .prepare(
      `INSERT INTO expenses (date,vendor,expenseCategory,expenseHead,department,description,originalCurrency,originalAmount,exchangeRate,usdAmount,paidByEntity,paidFromBank,costOwner,allocationMethod,caPct,txPct,uaePct,pkPct,buzzPct,notes,accountId,actualMonth) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      d.date,
      d.vendor,
      expenseCategory,
      expenseHead,
      d.department || "",
      d.description || "",
      d.originalCurrency || "USD",
      d.originalAmount || 0,
      d.exchangeRate || 1,
      usd,
      d.paidByEntity || "PK",
      d.paidFromBank || "PK Bank",
      d.costOwner || "Shared",
      d.allocationMethod || "Percentage",
      d.caPct || 0,
      d.txPct || 0,
      d.uaePct || 0,
      d.pkPct || 0,
      d.buzzPct || 0,
      d.notes || "",
      d.accountId || null,
      actualMonth,
    );
  replaceExpenseMonthlyAllocations(Number(r.lastInsertRowid), d.monthlyAllocations);
  res.json(
    hydrateExpense(db.prepare("SELECT e.*, a.category as accountCategory, a.name as accountName FROM expenses e LEFT JOIN accounts a ON a.id = e.accountId WHERE e.id=?").get(r.lastInsertRowid)),
  );
});

app.post("/api/expenses/bulk", (req, res) => {
  const rows: any[] = Array.isArray(req.body) ? req.body : [];

  const expenseAccounts = db.prepare("SELECT * FROM accounts WHERE type='expense'").all() as any[];
  const accountByName = new Map(expenseAccounts.map((a) => [String(a.name).trim().toLowerCase(), a]));

  const totalRows = rows.length;
  const errors: { row: number; reason: string }[] = [];
  const validRows: any[] = [];

  rows.forEach((d, idx) => {
    const rowNum = idx + 2; // account for header row in spreadsheet
    const date = String(d.date ?? "").trim();
    const vendor = String(d.vendor ?? "").trim();
    const expenseTypeName = String(d.expenseType ?? d.expenseCategory ?? "").trim();

    if (!date) {
      errors.push({ row: rowNum, reason: "Date is required" });
      return;
    }
    if (!vendor) {
      errors.push({ row: rowNum, reason: "Expense Name is required" });
      return;
    }
    if (!expenseTypeName) {
      errors.push({ row: rowNum, reason: "Expense Type is required" });
      return;
    }
    const account = accountByName.get(expenseTypeName.toLowerCase());
    if (expenseAccounts.length > 0 && !account) {
      errors.push({
        row: rowNum,
        reason: `Expense Type "${expenseTypeName}" does not exist in Chart of Accounts`,
      });
      return;
    }
    validRows.push({
      ...d,
      date,
      vendor,
      accountId: account ? account.id : null,
      expenseCategory: account ? account.category : expenseTypeName,
      expenseHead: account ? account.name : expenseTypeName,
    });
  });

  validRows.forEach((d) => upsertDepartment(d.department));

  const insert = db.prepare(
    `INSERT INTO expenses (date,vendor,expenseCategory,expenseHead,department,description,originalCurrency,originalAmount,exchangeRate,usdAmount,paidByEntity,paidFromBank,costOwner,allocationMethod,caPct,txPct,uaePct,pkPct,buzzPct,notes,accountId,actualMonth) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertMany = db.transaction((rows: any[]) =>
    rows.map((d) => {
      const usd = (d.originalAmount || 0) * (d.exchangeRate || 1);
      const actualMonth = d.actualMonth || (d.date ? String(d.date).slice(0, 7) : "");
      return insert.run(
        d.date,
        d.vendor,
        d.expenseCategory || "",
        d.expenseHead || "",
        d.department || "",
        d.description || "",
        d.originalCurrency || "USD",
        d.originalAmount || 0,
        d.exchangeRate || 1,
        usd,
        d.paidByEntity || "PK",
        d.paidFromBank || "PK Bank",
        d.costOwner || "Shared",
        d.allocationMethod || "Percentage",
        d.caPct || 0,
        d.txPct || 0,
        d.uaePct || 0,
        d.pkPct || 0,
        d.buzzPct || 0,
        d.notes || "",
        d.accountId || null,
        actualMonth,
      );
    }),
  );
  const results = validRows.length > 0 ? insertMany(validRows) : [];

  res.json({
    inserted: results.length,
    totalRows,
    successCount: results.length,
    failedCount: errors.length,
    errors,
  });
});

app.put("/api/expenses/:id", (req, res) => {
  const d = req.body;
  const usd = (d.originalAmount || 0) * (d.exchangeRate || 1);
  upsertDepartment(d.department);
  const { expenseCategory, expenseHead } = resolveExpenseCategoryFromAccount(d.accountId, d.expenseCategory);
  const actualMonth = d.actualMonth || (d.date ? String(d.date).slice(0, 7) : "");
  db.prepare(
    `UPDATE expenses SET date=?,vendor=?,expenseCategory=?,expenseHead=?,department=?,description=?,originalCurrency=?,originalAmount=?,exchangeRate=?,usdAmount=?,paidByEntity=?,paidFromBank=?,costOwner=?,allocationMethod=?,caPct=?,txPct=?,uaePct=?,pkPct=?,buzzPct=?,notes=?,accountId=?,actualMonth=? WHERE id=?`,
  ).run(
    d.date,
    d.vendor,
    expenseCategory,
    expenseHead,
    d.department || "",
    d.description || "",
    d.originalCurrency || "USD",
    d.originalAmount || 0,
    d.exchangeRate || 1,
    usd,
    d.paidByEntity || "PK",
    d.paidFromBank || "PK Bank",
    d.costOwner || "Shared",
    d.allocationMethod || "Percentage",
    d.caPct || 0,
    d.txPct || 0,
    d.uaePct || 0,
    d.pkPct || 0,
    d.buzzPct || 0,
    d.notes || "",
    d.accountId || null,
    actualMonth,
    req.params.id,
  );
  replaceExpenseMonthlyAllocations(Number(req.params.id), d.monthlyAllocations);
  res.json(
    hydrateExpense(db.prepare("SELECT e.*, a.category as accountCategory, a.name as accountName FROM expenses e LEFT JOIN accounts a ON a.id = e.accountId WHERE e.id=?").get(req.params.id)),
  );
});

app.post("/api/expenses/bulk-delete", (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ deleted: 0 });
  const del = db.prepare("DELETE FROM expenses WHERE id=?");
  const delMany = db.transaction((ids: number[]) =>
    ids.map((id) => del.run(id)),
  );
  const results = delMany(ids);
  res.json({ deleted: results.length });
});

app.delete("/api/expenses/:id", (req, res) => {
  db.prepare("DELETE FROM expenses WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ======= EXCHANGE RATES =======
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

// ======= ALLOCATION RULES =======
app.get("/api/allocation-rules", (req, res) => {
  res.json(db.prepare("SELECT * FROM allocation_rules ORDER BY name").all());
});

app.post("/api/allocation-rules", (req, res) => {
  const { name, description, caPct, txPct, uaePct, pkPct, buzzPct } = req.body;
  const r = db
    .prepare(
      "INSERT INTO allocation_rules (name,description,caPct,txPct,uaePct,pkPct,buzzPct) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      name,
      description || "",
      caPct || 0,
      txPct || 0,
      uaePct || 0,
      pkPct || 0,
      buzzPct || 0,
    );
  res.json(
    db
      .prepare("SELECT * FROM allocation_rules WHERE id=?")
      .get(r.lastInsertRowid),
  );
});

app.put("/api/allocation-rules/:id", (req, res) => {
  const { name, description, caPct, txPct, uaePct, pkPct, buzzPct } = req.body;
  db.prepare(
    "UPDATE allocation_rules SET name=?,description=?,caPct=?,txPct=?,uaePct=?,pkPct=?,buzzPct=? WHERE id=?",
  ).run(
    name,
    description || "",
    caPct || 0,
    txPct || 0,
    uaePct || 0,
    pkPct || 0,
    buzzPct || 0,
    req.params.id,
  );
  res.json(
    db.prepare("SELECT * FROM allocation_rules WHERE id=?").get(req.params.id),
  );
});

app.delete("/api/allocation-rules/:id", (req, res) => {
  db.prepare("DELETE FROM allocation_rules WHERE id=?").run(req.params.id);
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

// ======= DASHBOARD =======
app.get("/api/dashboard", (req, res) => {
  try {
    const { month, brand } = req.query as any;
    const selectedBrand = brand && brand !== "all" ? String(brand) : undefined;

    let revRows = buildRevenueLedger(month);
    const expRows = buildExpenseLedger(month);

    if (selectedBrand) {
      revRows = revRows.filter((r) => r.brand === selectedBrand);
    }

    const totalRevenue = revRows.reduce((s, r) => s + (r.usdAmount || 0), 0);
    const totalExpenses = selectedBrand
      ? expRows.reduce(
          (s, e) =>
            s + (e.usdAmount || 0) * ((e[BRAND_ALLOC_KEY[selectedBrand]] || 0) / 100),
          0,
        )
      : expRows.reduce((s, e) => s + (e.usdAmount || 0), 0);

    const netProfit = totalRevenue - totalExpenses;
    const grossMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    const freshRevenue = revRows
      .filter((r) => r.revenueType === "Fresh")
      .reduce((s, r) => s + r.usdAmount, 0);
    const recurringRevenue = revRows
      .filter((r) => r.revenueType === "Recurring")
      .reduce((s, r) => s + r.usdAmount, 0);
    const upsellRevenue = revRows
      .filter((r) => r.revenueType === "Upsell")
      .reduce((s, r) => s + r.usdAmount, 0);

    const brandMap: Record<string, number> = { CA: 0, TX: 0, UAE: 0, BuzzFlick: 0 };
    revRows.forEach((r) => {
      if (brandMap[r.brand] !== undefined) brandMap[r.brand] += r.usdAmount;
    });

    res.json({
      totalRevenue,
      totalExpenses,
      netProfit,
      grossMargin,
      freshRevenue,
      recurringRevenue,
      upsellRevenue,
      revenueByBrand: Object.entries(brandMap).map(([name, value]) => ({ name, value })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// ======= MONTHLY TREND =======
app.get("/api/monthly-trend", (req, res) => {
  const revRows = buildRevenueLedger();
  const expRows = buildExpenseLedger();

  const revMap: Record<string, number> = {};
  const expMap: Record<string, number> = {};
  revRows.forEach((r) => {
    if (!r.month) return;
    revMap[r.month] = (revMap[r.month] || 0) + (r.usdAmount || 0);
  });
  expRows.forEach((e) => {
    if (!e.month) return;
    expMap[e.month] = (expMap[e.month] || 0) + (e.usdAmount || 0);
  });

  const months = [...new Set([...Object.keys(revMap), ...Object.keys(expMap)])]
    .filter((m): m is string => !!m)
    .sort()
    .slice(-12);

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  res.json(
    months.map((m) => {
      const [y, mo] = m.split("-");
      const revenue = revMap[m] || 0;
      const cost = expMap[m] || 0;
      return {
        month: `${MONTH_NAMES[parseInt(mo) - 1]} ${y}`,
        revenue,
        cost,
        profit: revenue - cost,
      };
    }),
  );
});

// ======= BRAND P&L =======
app.get("/api/brand-pl", (req, res) => {
  const { entity, month } = req.query as any;
  if (!entity) return res.status(400).json({ error: "entity required" });

  const brand = entity;
  const revRows = buildRevenueLedger(month).filter((r) => r.brand === brand);
  const expRows = buildExpenseLedger(month);

  const totalRevenue = revRows.reduce((s, r) => s + r.usdAmount, 0);

  const entityKey =
    brand === "CA" ? "ca" : brand === "TX" ? "tx" : brand === "UAE" ? "uae" : brand === "PK" ? "pk" : "buzz";
  let totalExpenses = 0;
  const expByType: Record<string, number> = {};
  expRows.forEach((e) => {
    const a = allocated(e);
    const share = a[entityKey as keyof typeof a] || 0;
    totalExpenses += share;
    const key = e.expenseType || "Other";
    expByType[key] = (expByType[key] || 0) + share;
  });

  const netProfit = totalRevenue - totalExpenses;
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
  const freshRevenue = revRows.filter((r) => r.revenueType === "Fresh").reduce((s, r) => s + r.usdAmount, 0);
  const recurringRevenue = revRows.filter((r) => r.revenueType === "Recurring").reduce((s, r) => s + r.usdAmount, 0);
  const upsellRevenue = revRows.filter((r) => r.revenueType === "Upsell").reduce((s, r) => s + r.usdAmount, 0);

  const revenueByType = [
    { type: "Fresh", amount: freshRevenue },
    { type: "Recurring", amount: recurringRevenue },
    { type: "Upsell", amount: upsellRevenue },
  ];
  const expensesByCategory = Object.entries(expByType).map(([category, amount]) => ({ category, amount }));

  res.json({
    totalRevenue,
    totalExpenses,
    netProfit,
    profitMargin,
    freshRevenue,
    recurringRevenue,
    upsellRevenue,
    revenueByType,
    expensesByCategory,
  });
});

// ======= CONSOLIDATED P&L =======
app.get("/api/consolidated-pl", (req, res) => {
  const { month } = req.query as any;

  const revRows = buildRevenueLedger(month);
  const expRows = buildExpenseLedger(month);

  const zeroRow = () => ({ ca: 0, tx: 0, uae: 0, buzz: 0 });
  const total = (o: any) => o.ca + o.tx + o.uae + o.buzz;

  const addRevTo = (o: any, r: any) => {
    if (r.brand === "CA") o.ca += r.usdAmount;
    else if (r.brand === "TX") o.tx += r.usdAmount;
    else if (r.brand === "UAE") o.uae += r.usdAmount;
    else if (r.brand === "BuzzFlick") o.buzz += r.usdAmount;
  };

  const rev = zeroRow();
  const freshRev = zeroRow();
  const recurringRev = zeroRow();
  const upsellRev = zeroRow();
  revRows.forEach((r) => {
    addRevTo(rev, r);
    if (r.revenueType === "Fresh") addRevTo(freshRev, r);
    else if (r.revenueType === "Recurring") addRevTo(recurringRev, r);
    else if (r.revenueType === "Upsell") addRevTo(upsellRev, r);
  });

  const exp = zeroRow();
  const expByType: Record<string, ReturnType<typeof zeroRow>> = {};
  expRows.forEach((e) => {
    const a = allocated(e);
    exp.ca += a.ca;
    exp.tx += a.tx;
    exp.uae += a.uae;
    exp.buzz += a.buzz;

    const key = e.expenseType || "Other";
    if (!expByType[key]) expByType[key] = zeroRow();
    expByType[key].ca += a.ca;
    expByType[key].tx += a.tx;
    expByType[key].uae += a.uae;
    expByType[key].buzz += a.buzz;
  });

  const profit = { ca: rev.ca - exp.ca, tx: rev.tx - exp.tx, uae: rev.uae - exp.uae, buzz: rev.buzz - exp.buzz };
  const margin = (entity: "ca" | "tx" | "uae" | "buzz") => (rev[entity] > 0 ? (profit[entity] / rev[entity]) * 100 : 0);

  const revenueBreakdown = [
    { label: "Fresh Revenue", ...freshRev, total: total(freshRev) },
    { label: "Recurring Revenue", ...recurringRev, total: total(recurringRev) },
    { label: "Upsell Revenue", ...upsellRev, total: total(upsellRev) },
  ];
  const expenseBreakdown = Object.entries(expByType)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, o]) => ({ label, ...o, total: total(o) }));

  res.json({
    revenueBreakdown,
    expenseBreakdown,
    rows: [
      { label: "Total Revenue", type: "revenue", ca: rev.ca, tx: rev.tx, uae: rev.uae, buzz: rev.buzz, total: total(rev) },
      { label: "Total Expenses", type: "expense", ca: exp.ca, tx: exp.tx, uae: exp.uae, buzz: exp.buzz, total: total(exp) },
      { label: "Net Profit", type: "profit", ca: profit.ca, tx: profit.tx, uae: profit.uae, buzz: profit.buzz, total: total(profit) },
      {
        label: "Profit Margin",
        type: "margin",
        ca: margin("ca"),
        tx: margin("tx"),
        uae: margin("uae"),
        buzz: margin("buzz"),
        total: total(rev) > 0 ? (total(profit) / total(rev)) * 100 : 0,
      },
    ],
  });
});

// ======= MONTHLY P&L (with Brand slicer) =======
app.get("/api/monthly-pl", (req, res) => {
  const { year, brand } = req.query as any;
  const y = year || new Date().getFullYear().toString();
  const selectedBrand = brand && brand !== "all" ? String(brand) : undefined;

  let revRows = buildRevenueLedger(y);
  const expRows = buildExpenseLedger(y);
  if (selectedBrand) revRows = revRows.filter((r) => r.brand === selectedBrand);

  const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
  const monthLabels = months.map((m) => `${MONTH_ABBR[parseInt(m.split("-")[1]) - 1]} ${y}`);

  const revMap: Record<string, number> = {};
  revRows.forEach((r) => {
    revMap[r.month] = (revMap[r.month] || 0) + (r.usdAmount || 0);
  });

  const expMap: Record<string, number> = {};
  expRows.forEach((e) => {
    const share = selectedBrand ? (e.usdAmount || 0) * ((e[BRAND_ALLOC_KEY[selectedBrand]] || 0) / 100) : e.usdAmount || 0;
    expMap[e.month] = (expMap[e.month] || 0) + share;
  });

  const revenues = months.map((m) => revMap[m] || 0);
  const expenses = months.map((m) => expMap[m] || 0);
  const profits = revenues.map((r, i) => r - expenses[i]);
  const margins = revenues.map((r, i) => (r > 0 ? (profits[i] / r) * 100 : 0));

  res.json({
    months: monthLabels,
    rows: [
      { label: "Total Revenue", type: "revenue", values: revenues },
      { label: "Total Expenses", type: "expense", values: expenses },
      { label: "Net Profit", type: "profit", values: profits },
      { label: "Profit Margin %", type: "margin", values: margins },
    ],
    totals: {
      revenue: revenues.reduce((a, b) => a + b, 0),
      expenses: expenses.reduce((a, b) => a + b, 0),
      profit: profits.reduce((a, b) => a + b, 0),
    },
  });
});

// ======= ALLOCATION ENGINE (grouped by Expense Type) =======
app.get("/api/allocation", (req, res) => {
  const { month } = req.query as any;
  const rows = buildExpenseLedger(month);

  const grouped: Record<string, any> = {};
  rows.forEach((e) => {
    const key = e.expenseType || "Other";
    if (!grouped[key])
      grouped[key] = {
        expenseCategory: key,
        caUsd: 0,
        txUsd: 0,
        uaeUsd: 0,
        pkUsd: 0,
        buzzUsd: 0,
        totalUsd: 0,
      };
    const a = allocated(e);
    grouped[key].caUsd += a.ca;
    grouped[key].txUsd += a.tx;
    grouped[key].uaeUsd += a.uae;
    grouped[key].pkUsd += a.pk;
    grouped[key].buzzUsd += a.buzz;
    grouped[key].totalUsd += e.usdAmount;
  });

  res.json(Object.values(grouped));
});

// ======= PLAID BANK CONNECTIONS =======
app.get("/api/plaid/status", (_req, res) => {
  res.json({
    configured: Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
    linkedItems: (db.prepare("SELECT COUNT(*) as count FROM plaid_items").get() as any).count,
  });
});

app.post("/api/plaid/link-token", async (_req, res) => {
  try {
    const response = await plaidClient().linkTokenCreate({
      client_name: "TekRevol FinSys",
      language: "en",
      country_codes: [CountryCode.Us],
      user: { client_user_id: "finance-app-user" },
      products: [Products.Transactions],
    });
    res.json({ linkToken: response.data.link_token });
  } catch (error) {
    res.status(502).json({ message: plaidErrorMessage(error) });
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
        MAX(a.isoCurrency) as balanceCurrency,
        (SELECT COUNT(*) FROM plaid_transactions pending_t
         WHERE pending_t.itemId = i.id AND pending_t.reviewStatus = 'pending') as pendingCount,
        (SELECT COUNT(*) FROM plaid_transactions posted_t
         WHERE posted_t.itemId = i.id AND posted_t.reviewStatus = 'posted') as postedCount,
        (SELECT COUNT(*) FROM plaid_transactions excluded_t
         WHERE excluded_t.itemId = i.id AND excluded_t.reviewStatus = 'excluded') as excludedCount
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

app.get("/api/plaid/transactions", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  res.json(db.prepare(
    `SELECT t.*, i.institutionName, i.icon, i.provider, a.name as accountName
     FROM plaid_transactions t
     JOIN plaid_items i ON i.id = t.itemId
     LEFT JOIN plaid_accounts a ON a.plaidAccountId = t.plaidAccountId
     ORDER BY t.date DESC, t.id DESC
     LIMIT ?`,
  ).all(limit));
});

app.get("/api/plaid/items/:id/unposted", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const itemId = Number(req.params.id);
  const transactions = db.prepare(
    `SELECT t.*, i.institutionName, i.icon, i.provider, a.name as accountName
     FROM plaid_transactions t
     JOIN plaid_items i ON i.id = t.itemId
     LEFT JOIN plaid_accounts a ON a.plaidAccountId = t.plaidAccountId
     WHERE t.itemId = ?
     ORDER BY t.date DESC, t.id DESC
     LIMIT ?`,
  ).all(itemId, limit);
  const counts = db.prepare(
    `SELECT reviewStatus as status, COUNT(*) as count
     FROM plaid_transactions
     WHERE itemId = ?
     GROUP BY reviewStatus`,
  ).all(itemId) as { status: string; count: number }[];
  const reviewCounts = { pending: 0, posted: 0, excluded: 0 };
  counts.forEach(({ status, count }) => {
    if (status in reviewCounts) reviewCounts[status as keyof typeof reviewCounts] = Number(count);
  });
  res.json({ transactions, counts: reviewCounts });
});

app.patch("/api/plaid/items/:id/transactions/review", (req, res) => {
  const itemId = Number(req.params.id);
  const transactionIds = Array.isArray(req.body?.transactionIds)
    ? [...new Set(req.body.transactionIds.map((id: unknown) => String(id).trim()).filter(Boolean))]
    : [];
  const reviewStatus = String(req.body?.reviewStatus || "");
  if (!Number.isInteger(itemId) || transactionIds.length === 0) {
    return res.status(400).json({ message: "At least one transaction is required" });
  }
  if (!["pending", "posted", "excluded"].includes(reviewStatus)) {
    return res.status(400).json({ message: "Review status must be pending, posted, or excluded" });
  }
  const item = db.prepare("SELECT id FROM plaid_items WHERE id = ?").get(itemId);
  if (!item) return res.status(404).json({ message: "Plaid item not found" });

  const placeholders = transactionIds.map(() => "?").join(", ");
  const result = db.prepare(
    `UPDATE plaid_transactions
     SET reviewStatus = ?
     WHERE itemId = ? AND plaidTransactionId IN (${placeholders})`,
  ).run(reviewStatus, itemId, ...transactionIds);
  res.json({ updated: result.changes, reviewStatus });
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

app.post("/api/plaid/exchange", async (req, res) => {
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
    res.json({
      itemId: savedItemId,
      institutionName: institution.name || "Connected institution",
      accounts: accountsResponse.data.accounts.length,
    });
  } catch (error) {
    res.status(502).json({ message: plaidErrorMessage(error) });
  }
});

app.post("/api/plaid/items/:id/sync", async (req, res) => {
  const item = db.prepare("SELECT * FROM plaid_items WHERE id = ?").get(req.params.id) as any;
  if (!item) return res.status(404).json({ message: "Plaid item not found" });

  try {
    const responseClient = plaidClient();
    const accessToken = decryptSecret(item.accessToken);
    let cursor = item.cursor || undefined;
    let hasMore = true;
    let added = 0;
    let modified = 0;
    let removed = 0;
    const upsert = db.prepare(
      `INSERT INTO plaid_transactions
        (itemId, plaidTransactionId, plaidAccountId, date, authorizedDate, name,
         merchantName, amount, isoCurrency, pending, category, rawJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plaidTransactionId) DO UPDATE SET
        plaidAccountId = excluded.plaidAccountId, date = excluded.date,
        authorizedDate = excluded.authorizedDate, name = excluded.name,
        merchantName = excluded.merchantName, amount = excluded.amount,
        isoCurrency = excluded.isoCurrency, pending = excluded.pending,
        category = excluded.category, rawJson = excluded.rawJson`,
    );
    const remove = db.prepare("DELETE FROM plaid_transactions WHERE plaidTransactionId = ?");

    while (hasMore) {
      const response = await responseClient.transactionsSync({
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
      });
      const data = response.data;
      for (const transaction of data.added || []) {
        upsert.run(
          item.id, transaction.transaction_id, transaction.account_id, transaction.date,
          transaction.authorized_date || "", transaction.name, transaction.merchant_name || "",
          transaction.amount, transaction.iso_currency_code || "USD", transaction.pending ? 1 : 0,
          transaction.personal_finance_category?.primary || "", JSON.stringify(transaction),
        );
        added += 1;
      }
      for (const transaction of data.modified || []) {
        upsert.run(
          item.id, transaction.transaction_id, transaction.account_id, transaction.date,
          transaction.authorized_date || "", transaction.name, transaction.merchant_name || "",
          transaction.amount, transaction.iso_currency_code || "USD", transaction.pending ? 1 : 0,
          transaction.personal_finance_category?.primary || "", JSON.stringify(transaction),
        );
        modified += 1;
      }
      for (const transaction of data.removed || []) {
        remove.run(transaction.transaction_id);
        removed += 1;
      }
      cursor = data.next_cursor;
      hasMore = Boolean(data.has_more);
    }
    const accountBalances = await responseClient.accountsGet({ access_token: accessToken });
    const updateBalance = db.prepare(
      `UPDATE plaid_accounts
       SET currentBalance = ?, availableBalance = ?, isoCurrency = ?
       WHERE itemId = ? AND plaidAccountId = ?`,
    );
    for (const account of accountBalances.data.accounts) {
      updateBalance.run(
        account.balances?.current ?? null,
        account.balances?.available ?? null,
        account.balances?.iso_currency_code || "USD",
        item.id,
        account.account_id,
      );
    }
    db.prepare("UPDATE plaid_items SET cursor = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?").run(cursor || "", item.id);
    res.json({ added, modified, removed });
  } catch (error) {
    res.status(502).json({ message: plaidErrorMessage(error) });
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

// ======= BANK SPENDING =======
app.get("/api/bank-spending", (req, res) => {
  const { month } = req.query as any;
  const rows = buildExpenseLedger(month);
  const grouped: Record<string, any> = {};
  rows.forEach((r) => {
    const key = `${r.paidFromBank}::${r.paidByEntity}`;
    if (!grouped[key]) grouped[key] = { bank: r.paidFromBank, entity: r.paidByEntity, transactionCount: 0, amountPaid: 0 };
    grouped[key].transactionCount += 1;
    grouped[key].amountPaid += r.usdAmount || 0;
  });
  const list = Object.values(grouped).sort((a: any, b: any) => b.amountPaid - a.amountPaid);
  const totalPaid = list.reduce((s: number, r: any) => s + (r.amountPaid || 0), 0);
  res.json(list.map((r: any) => ({ ...r, pctOfTotal: totalPaid > 0 ? (r.amountPaid / totalPaid) * 100 : 0 })));
});

// ======= INTERCOMPANY =======
const ENTITY_LIST = ["CA", "TX", "UAE", "PK", "BuzzFlick"];
const ENTITY_PCT_KEY: Record<string, keyof ReturnType<typeof allocated>> = {
  CA: "ca",
  TX: "tx",
  UAE: "uae",
  PK: "pk",
  BuzzFlick: "buzz",
};

app.get("/api/intercompany", (req, res) => {
  const { month } = req.query as any;
  const expRows = buildExpenseLedger(month);
  const txRows = db
    .prepare(`SELECT * FROM intercompany_transactions WHERE 1=1 ${dateFilter(month)}`)
    .all() as any[];

  // owed[X][Y] = amount Y owes X (X financed Y, directly or via allocation)
  const owed: Record<string, Record<string, number>> = {};
  ENTITY_LIST.forEach((x) => {
    owed[x] = {};
    ENTITY_LIST.forEach((y) => (owed[x][y] = 0));
  });

  expRows.forEach((e) => {
    const payer = e.paidByEntity;
    if (!owed[payer]) return;
    const shares = allocated(e);
    ENTITY_LIST.forEach((target) => {
      if (target === payer) return;
      const amt = shares[ENTITY_PCT_KEY[target]] || 0;
      if (amt) owed[payer][target] += amt;
    });
  });

  txRows.forEach((t) => {
    if (owed[t.fromEntity] && t.toEntity in owed[t.fromEntity]) {
      owed[t.fromEntity][t.toEntity] += t.usdAmount || 0;
    }
  });

  const result = ENTITY_LIST.map((entity) => {
    const actualPaid = expRows.filter((e) => e.paidByEntity === entity).reduce((s, e) => s + (e.usdAmount || 0), 0);
    const k = ENTITY_PCT_KEY[entity];
    const trueCost = expRows.reduce((s, e) => s + allocated(e)[k], 0);

    const brandBreakdown = ENTITY_LIST.filter((c) => c !== entity).map((counterparty) => {
      const net = owed[entity][counterparty] - owed[counterparty][entity];
      return { entity: counterparty, netAmount: net };
    });

    const difference = brandBreakdown.reduce((s, b) => s + b.netAmount, 0);
    const recoverable = difference > 0.01 ? difference : undefined;
    const payable = difference < -0.01 ? Math.abs(difference) : undefined;
    const netPosition = Math.abs(difference) < 0.01 ? "Balanced" : difference > 0 ? "Overpaid" : "Underpaid";

    return {
      entity,
      actualPaid,
      trueCost,
      difference,
      recoverable,
      payable,
      netPosition,
      brandBreakdown,
    };
  });

  const pkFunding = {
    totalReceived: txRows.filter((t) => t.toEntity === "PK").reduce((s, t) => s + (t.usdAmount || 0), 0),
    bySource: ENTITY_LIST.filter((e) => e !== "PK").map((source) => ({
      entity: source,
      amount: txRows.filter((t) => t.toEntity === "PK" && t.fromEntity === source).reduce((s, t) => s + (t.usdAmount || 0), 0),
    })).filter((s) => s.amount > 0),
  };

  res.json({ entities: result, pkFunding });
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
