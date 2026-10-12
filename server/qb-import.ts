// QuickBooks "Transaction Detail by Account" parser (Phase C, 2026-10-13).
//
// This file is deliberately pure: no database, no Express, no filesystem. It
// turns the text of a QuickBooks export into proposed double-entry
// transactions, and says plainly which rows it could not account for. That
// makes it testable on its own (server/qb-import.test.ts) and keeps the
// decision to write anything to the ledger out of the parser entirely.
//
// What the export actually looks like:
//
//   TekRevol LLC
//   Transaction Detail by Account
//   January - December 2026
//
//   ,Date,Transaction Type,Num,Name,Memo/Description,Split,Amount,Balance
//   Checking
//   Beginning Balance,,,,,,,,1,000.00
//   ,01/05/2026,Expense,101,Vendor X,Office supplies,Office Expenses,-250.00,750.00
//   Total for Checking,,,,,,,-250.00
//   Office Expenses
//   ,01/05/2026,Expense,101,Vendor X,Office supplies,Checking,250.00,250.00
//   Total for Office Expenses,,,,,,,250.00
//   TOTAL,,,,,,,0.00
//
// Three properties of that shape drive everything below:
//
//  1. The account is a BANNER ROW, not a column — so parsing is a state
//     machine that remembers which section it is in.
//  2. A transaction appears ONCE PER ACCOUNT IT TOUCHES. The same payment is
//     printed under Checking and again under Office Expenses. Treating each
//     printed row as its own transaction would double the books, so rows are
//     paired back into one entry and the pair must sum to zero.
//  3. When the other side is outside the report's filter, only one row
//     exists and the Split column names the missing account — unless it says
//     "-SPLIT-", in which case the other side is several accounts and is
//     simply not recoverable from this file. Those go to quarantine; they
//     are never guessed at.

export type QbColumnMap = {
  date: number;
  transactionType: number;
  num: number;
  name: number;
  memo: number;
  split: number;
  amount: number;
  debit: number;
  credit: number;
  balance: number;
};

export type QbRow = {
  /** Account section this row was printed under. */
  account: string;
  date: string;
  transactionType: string;
  num: string;
  name: string;
  memo: string;
  split: string;
  /** Signed as printed: positive = debit to `account`, negative = credit. */
  amount: number;
  /** 1-based row in the source file, for error messages. */
  line: number;
};

export type QbWarning = { line: number; message: string };

export type ParsedQbReport = {
  rows: QbRow[];
  accounts: string[];
  warnings: QbWarning[];
  /** Rows the parser skipped on purpose (totals, beginning balances, blanks). */
  skipped: number;
};

export type ProposedLine = {
  account: string;
  /** Positive = debit, negative = credit. */
  amount: number;
  lines: number[];
  /** True when this side was reconstructed from the Split column. */
  synthesized?: boolean;
};

export type ProposedEntry = {
  key: string;
  date: string;
  transactionType: string;
  num: string;
  name: string;
  memo: string;
  lines: ProposedLine[];
  /** Sum of the debit side, which equals the credit side for a balanced entry. */
  amount: number;
  synthesized: boolean;
  sourceLines: number[];
};

export type QuarantineItem = {
  reason: string;
  detail: string;
  date: string;
  num: string;
  name: string;
  accounts: string[];
  amount: number;
  sourceLines: number[];
};

export type PairedQbReport = {
  entries: ProposedEntry[];
  quarantine: QuarantineItem[];
};

// --- CSV ---------------------------------------------------------------

/** RFC4180-ish reader: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A BOM is invisible but would otherwise become part of the first header.
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// --- scalars -----------------------------------------------------------

const MONEY_CHARS = /[$£€\s,]/g;

/**
 * "1,234.56" → 1234.56, "(250.00)" → -250, "250.00-" → -250, "" → null.
 * Accounting exports use parentheses for negatives far more often than a
 * leading minus, and a parenthesised number read as positive would silently
 * flip a credit into a debit.
 */
export function parseAmount(raw: string): number | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negative = true; s = s.slice(0, -1); }
  s = s.replace(MONEY_CHARS, "");
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  if (!s || !/^\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Returns `YYYY-MM-DD`, or null when the text isn't a date at all.
 *
 * Slash dates are read US-style (MM/DD/YYYY, QuickBooks' default) unless the
 * first part is above 12, which can only be a day. A file where every date
 * is ambiguous (01/02/2026) is read US-style and the caller is expected to
 * show the parsed dates back for confirmation — there is no way to settle it
 * from the file alone.
 */
export function parseDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    let [, a, b, y] = m;
    let month = a, day = b;
    if (Number(a) > 12 && Number(b) <= 12) { month = b; day = a; }
    const year = y.length === 2 ? `20${y}` : y;
    const mm = month.padStart(2, "0");
    const dd = day.padStart(2, "0");
    if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
    return `${year}-${mm}-${dd}`;
  }
  // "Jan 5, 2026" / "5 Jan 2026"
  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return `${m[3]}-${MONTHS[m[1].slice(0, 3).toLowerCase()]}-${m[2].padStart(2, "0")}`;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return `${m[3]}-${MONTHS[m[2].slice(0, 3).toLowerCase()]}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

// --- header ------------------------------------------------------------

const ALIASES: Record<keyof QbColumnMap, string[]> = {
  date: ["date", "trans date", "transaction date"],
  transactionType: ["transaction type", "type", "txn type"],
  num: ["num", "no", "number", "doc num", "ref", "ref no", "reference"],
  name: ["name", "payee", "customer", "vendor", "customer/vendor", "payee/customer"],
  memo: ["memo/description", "memo", "description", "memo / description"],
  split: ["split", "splits", "account", "offset account"],
  amount: ["amount", "amount (usd)", "value"],
  debit: ["debit"],
  credit: ["credit"],
  balance: ["balance", "running balance"],
};

function findColumn(header: string[], aliases: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
  for (const alias of aliases) {
    const i = norm.indexOf(alias);
    if (i >= 0) return i;
  }
  return -1;
}

export function detectHeader(rows: string[][]): { index: number; map: QbColumnMap } | null {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const row = rows[i];
    const map: QbColumnMap = {
      date: findColumn(row, ALIASES.date),
      transactionType: findColumn(row, ALIASES.transactionType),
      num: findColumn(row, ALIASES.num),
      name: findColumn(row, ALIASES.name),
      memo: findColumn(row, ALIASES.memo),
      split: findColumn(row, ALIASES.split),
      amount: findColumn(row, ALIASES.amount),
      debit: findColumn(row, ALIASES.debit),
      credit: findColumn(row, ALIASES.credit),
      balance: findColumn(row, ALIASES.balance),
    };
    // A header must at minimum say where the date and the money are. Some
    // exports carry Debit/Credit columns instead of one signed Amount.
    if (map.date >= 0 && (map.amount >= 0 || (map.debit >= 0 && map.credit >= 0))) {
      return { index: i, map };
    }
  }
  return null;
}

// --- the state machine -------------------------------------------------

const SKIP_PATTERNS = [
  /^total\b/i,          // "Total for Checking", "Total Checking"
  /^beginning balance/i,
  /^ending balance/i,
  /^closing balance/i,
];

const cell = (row: string[], i: number) => (i >= 0 && i < row.length ? String(row[i] ?? "").trim() : "");

/** True when a row carries nothing but one label — a section banner. */
function bannerLabel(row: string[]): string | null {
  const filled = row.map((c) => String(c ?? "").trim()).filter(Boolean);
  if (filled.length !== 1) return null;
  return filled[0];
}

export function parseTransactionDetailByAccount(text: string): ParsedQbReport {
  const rows = parseCsv(text);
  const header = detectHeader(rows);
  const warnings: QbWarning[] = [];
  if (!header) {
    return {
      rows: [], accounts: [], skipped: 0,
      warnings: [{ line: 0, message: "No header row found — expected columns including Date and Amount (or Debit and Credit)." }],
    };
  }

  const { map } = header;
  const out: QbRow[] = [];
  const accounts: string[] = [];
  let account = "";
  let skipped = 0;

  for (let i = header.index + 1; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 1;
    const nonEmpty = row.map((c) => String(c ?? "").trim()).filter(Boolean);
    if (nonEmpty.length === 0) { skipped++; continue; }

    const label = bannerLabel(row);
    if (label) {
      if (SKIP_PATTERNS.some((p) => p.test(label))) { skipped++; continue; }
      account = label;
      if (!accounts.includes(account)) accounts.push(account);
      continue;
    }

    // Rows whose first cell is a label (Total …, Beginning Balance …) carry
    // subtotals, not transactions.
    const first = cell(row, 0);
    if (first && SKIP_PATTERNS.some((p) => p.test(first))) { skipped++; continue; }

    const dateRaw = cell(row, map.date);
    if (!dateRaw) { skipped++; continue; }
    const date = parseDate(dateRaw);
    if (!date) {
      warnings.push({ line, message: `Could not read the date "${dateRaw}" — row skipped.` });
      skipped++;
      continue;
    }

    let amount: number | null;
    if (map.amount >= 0) {
      amount = parseAmount(cell(row, map.amount));
    } else {
      const debit = parseAmount(cell(row, map.debit)) ?? 0;
      const credit = parseAmount(cell(row, map.credit)) ?? 0;
      amount = debit - credit;
    }
    if (amount === null) {
      warnings.push({ line, message: `Could not read an amount — row skipped.` });
      skipped++;
      continue;
    }

    // An account banner is the only thing that says which account a row
    // belongs to; a row before the first banner cannot be placed at all.
    if (!account) {
      warnings.push({ line, message: "Transaction appears before any account heading — row skipped." });
      skipped++;
      continue;
    }

    out.push({
      account,
      date,
      transactionType: cell(row, map.transactionType),
      num: cell(row, map.num),
      name: cell(row, map.name),
      memo: cell(row, map.memo),
      split: cell(row, map.split),
      amount,
      line,
    });
  }

  return { rows: out, accounts, warnings, skipped };
}

// --- pairing -----------------------------------------------------------

const SPLIT_MARKERS = /^-?\s*split\s*-?$/i;

/** Rows printed for the same transaction share this. */
function groupKey(r: QbRow): string {
  // Memo is deliberately not part of the key: QuickBooks prints a
  // per-line memo, so the two halves of one payment often differ.
  return [r.date, r.transactionType.toLowerCase(), r.num.toLowerCase(), r.name.toLowerCase()].join("|");
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function pairTransactions(parsed: ParsedQbReport): PairedQbReport {
  const groups = new Map<string, QbRow[]>();
  for (const r of parsed.rows) {
    const key = groupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const entries: ProposedEntry[] = [];
  const quarantine: QuarantineItem[] = [];

  for (const [key, rows] of groups) {
    const first = rows[0];
    const sourceLines = rows.map((r) => r.line);
    const accountsInGroup = [...new Set(rows.map((r) => r.account))];

    // One row per account: the same account printed twice in a group is a
    // sign the key merged two different transactions (blank Num, same payee,
    // same day), which is not safe to post.
    if (accountsInGroup.length !== rows.length) {
      quarantine.push({
        reason: "AMBIGUOUS_GROUP",
        detail:
          "Several rows share the same account under one transaction key — most likely two separate transactions with the same date, type, number and payee. Import these by hand.",
        date: first.date, num: first.num, name: first.name,
        accounts: accountsInGroup, amount: round2(rows.reduce((s, r) => s + Math.abs(r.amount), 0) / 2),
        sourceLines,
      });
      continue;
    }

    const lines: ProposedLine[] = rows.map((r) => ({ account: r.account, amount: round2(r.amount), lines: [r.line] }));
    let synthesized = false;

    if (rows.length === 1) {
      // The other side was filtered out of the report. The Split column
      // names it — unless it says "-SPLIT-", which means several accounts
      // and nothing here can reconstruct them.
      const split = first.split.trim();
      if (!split || SPLIT_MARKERS.test(split)) {
        quarantine.push({
          reason: "UNRECOVERABLE_SPLIT",
          detail: split
            ? 'Only one side of this transaction is in the file and its Split column says "-SPLIT-", so the other accounts cannot be recovered. Re-export with every account included.'
            : "Only one side of this transaction is in the file and it has no Split account to pair with.",
          date: first.date, num: first.num, name: first.name,
          accounts: [first.account], amount: round2(Math.abs(first.amount)),
          sourceLines,
        });
        continue;
      }
      lines.push({ account: split, amount: round2(-first.amount), lines: [first.line], synthesized: true });
      synthesized = true;
    }

    const sum = round2(lines.reduce((s, l) => s + l.amount, 0));
    if (Math.abs(sum) >= 0.005) {
      quarantine.push({
        reason: "UNBALANCED",
        detail: `The rows for this transaction add up to ${sum.toFixed(2)} instead of zero — a leg is missing from the export, or an amount was edited. Nothing is plugged to make it balance.`,
        date: first.date, num: first.num, name: first.name,
        accounts: accountsInGroup, amount: round2(lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0)),
        sourceLines,
      });
      continue;
    }

    entries.push({
      key,
      date: first.date,
      transactionType: first.transactionType,
      num: first.num,
      name: first.name,
      // The memo that carries the most information, rather than an arbitrary side's.
      memo: rows.map((r) => r.memo).filter(Boolean).sort((a, b) => b.length - a.length)[0] || "",
      lines,
      amount: round2(lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0)),
      synthesized,
      sourceLines,
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.sourceLines[0] - b.sourceLines[0]);
  quarantine.sort((a, b) => a.date.localeCompare(b.date) || a.sourceLines[0] - b.sourceLines[0]);
  return { entries, quarantine };
}

// --- account type inference -------------------------------------------

/**
 * A first guess at an account's type, shown for confirmation and never
 * applied silently: `type` decides the sign of every report, and a
 * contra-asset filed under Expense corrupts the P&L invisibly.
 */
export function inferAccountType(name: string): { type: string; subType: string; confidence: "high" | "low" } {
  const n = name.toLowerCase();
  const has = (...words: string[]) => words.some((w) => n.includes(w));

  if (has("accounts receivable", "a/r")) return { type: "Asset", subType: "Receivables", confidence: "high" };
  if (has("accounts payable", "a/p")) return { type: "Liability", subType: "Payables", confidence: "high" };
  if (has("checking", "savings", "bank", "cash", "petty")) return { type: "Asset", subType: "Cash & Equivalents", confidence: "high" };
  if (has("undeposited")) return { type: "Asset", subType: "Cash & Equivalents", confidence: "high" };
  if (has("due from", "due to", "intercompany")) return { type: has("due to") ? "Liability" : "Asset", subType: "Intercompany Clearing", confidence: "low" };
  if (has("depreciation", "accumulated")) return { type: "Asset", subType: "Fixed Assets", confidence: "low" };
  if (has("prepaid", "inventory", "equipment", "furniture", "deposit")) return { type: "Asset", subType: "", confidence: "low" };
  if (has("credit card", "loan", "note payable", "payroll liab", "tax payable", "accrued")) return { type: "Liability", subType: "", confidence: "low" };
  if (has("opening balance equity", "retained earnings", "owner", "equity", "capital", "distribution")) return { type: "Equity", subType: "", confidence: "low" };
  if (has("income", "revenue", "sales", "fees earned")) return { type: "Revenue", subType: "", confidence: "high" };
  if (has("cost of goods", "cogs")) return { type: "Expense", subType: "Cost of Sales", confidence: "high" };
  if (has("expense", "rent", "salar", "wage", "utilities", "insurance", "advertis", "travel", "supplies", "software", "fee")) {
    return { type: "Expense", subType: "", confidence: "high" };
  }
  // Nothing matched. Expense is the commonest line in these reports, but the
  // guess is marked low so the UI asks rather than assumes.
  return { type: "Expense", subType: "", confidence: "low" };
}
