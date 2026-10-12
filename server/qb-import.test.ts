// Unit tests for the QuickBooks import parser (Phase C, 2026-10-13).
// Run with `pnpm run test` — Node's built-in test runner, no new dependency.
//
// These are the safety net the importer is built on: the parser decides what
// becomes a journal entry, so each fixture below is a shape a real export
// takes, and each assertion is a number computed by hand.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount, parseDate, parseCsv, detectHeader,
  parseTransactionDetailByAccount, pairTransactions, inferAccountType,
} from "./qb-import.ts";

// A two-account export: one payment printed under both accounts.
const SIMPLE = `TekRevol LLC
Transaction Detail by Account
January - December 2026

,Date,Transaction Type,Num,Name,Memo/Description,Split,Amount,Balance
Checking
Beginning Balance,,,,,,,,"1,000.00"
,01/05/2026,Expense,101,Vendor X,Office supplies,Office Expenses,-250.00,750.00
Total for Checking,,,,,,,-250.00
Office Expenses
,01/05/2026,Expense,101,Vendor X,Office supplies,Checking,250.00,250.00
Total for Office Expenses,,,,,,,250.00
TOTAL,,,,,,,0.00
`;

test("parseAmount reads accounting formats", () => {
  assert.equal(parseAmount("1,234.56"), 1234.56);
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount("(250.00)"), -250);   // parentheses are negative
  assert.equal(parseAmount("250.00-"), -250);    // trailing minus
  assert.equal(parseAmount("-250.00"), -250);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("   "), null);
  assert.equal(parseAmount("n/a"), null);
});

test("parseDate reads the formats QuickBooks exports", () => {
  assert.equal(parseDate("01/05/2026"), "2026-01-05");  // US order by default
  assert.equal(parseDate("13/05/2026"), "2026-05-13");  // 13 can only be a day
  assert.equal(parseDate("2026-01-05"), "2026-01-05");
  assert.equal(parseDate("1/5/26"), "2026-01-05");
  assert.equal(parseDate("Jan 5, 2026"), "2026-01-05");
  assert.equal(parseDate("5 Jan 2026"), "2026-01-05");
  assert.equal(parseDate("not a date"), null);
  assert.equal(parseDate(""), null);
});

test("parseCsv handles quotes, embedded commas and newlines", () => {
  const rows = parseCsv('a,"b,c",d\n"line\nbreak",2,3\n');
  assert.deepEqual(rows[0], ["a", "b,c", "d"]);
  assert.deepEqual(rows[1], ["line\nbreak", "2", "3"]);
  assert.deepEqual(parseCsv('"say ""hi""",x\n')[0], ['say "hi"', "x"]);
});

test("detectHeader finds the column row below the report title", () => {
  const found = detectHeader(parseCsv(SIMPLE));
  assert.ok(found);
  assert.equal(found!.index, 4);
  assert.equal(found!.map.date, 1);
  assert.equal(found!.map.split, 6);
  assert.equal(found!.map.amount, 7);
});

test("the account banner, not a column, decides which account a row belongs to", () => {
  const parsed = parseTransactionDetailByAccount(SIMPLE);
  assert.deepEqual(parsed.accounts, ["Checking", "Office Expenses"]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].account, "Checking");
  assert.equal(parsed.rows[0].amount, -250);
  assert.equal(parsed.rows[1].account, "Office Expenses");
  assert.equal(parsed.rows[1].amount, 250);
  assert.equal(parsed.warnings.length, 0);
});

test("totals and beginning balances are skipped, never imported", () => {
  const parsed = parseTransactionDetailByAccount(SIMPLE);
  assert.ok(!parsed.rows.some((r) => r.memo.toLowerCase().includes("total")));
  // Beginning Balance, two Total rows, TOTAL and the blank line.
  assert.ok(parsed.skipped >= 4);
});

test("the two printed halves become ONE entry, not two", () => {
  const { entries, quarantine } = pairTransactions(parseTransactionDetailByAccount(SIMPLE));
  assert.equal(quarantine.length, 0);
  assert.equal(entries.length, 1, "a payment printed under two accounts is one transaction");
  const e = entries[0];
  assert.equal(e.amount, 250);
  assert.equal(e.lines.length, 2);
  assert.equal(e.lines.find((l) => l.account === "Office Expenses")!.amount, 250);
  assert.equal(e.lines.find((l) => l.account === "Checking")!.amount, -250);
  assert.equal(e.synthesized, false);
});

test("a one-sided row is rebuilt from its Split account", () => {
  const ONE_SIDED = `,Date,Transaction Type,Num,Name,Memo/Description,Split,Amount
Checking
,02/01/2026,Check,200,Landlord,February rent,Rent Expense,-3000.00
`;
  const { entries, quarantine } = pairTransactions(parseTransactionDetailByAccount(ONE_SIDED));
  assert.equal(quarantine.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].synthesized, true);
  const rent = entries[0].lines.find((l) => l.account === "Rent Expense")!;
  assert.equal(rent.amount, 3000);
  assert.equal(rent.synthesized, true);
});

test('a one-sided row marked "-SPLIT-" is quarantined, never guessed', () => {
  const MULTI = `,Date,Transaction Type,Num,Name,Memo/Description,Split,Amount
Checking
,03/01/2026,Check,300,Supplier,Mixed invoice,-SPLIT-,-900.00
`;
  const { entries, quarantine } = pairTransactions(parseTransactionDetailByAccount(MULTI));
  assert.equal(entries.length, 0, "nothing may be invented for an unrecoverable split");
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].reason, "UNRECOVERABLE_SPLIT");
  assert.equal(quarantine[0].amount, 900);
});

test("rows that do not add to zero are quarantined, not plugged", () => {
  const UNBALANCED = `,Date,Transaction Type,Num,Name,Memo/Description,Split,Amount
Checking
,04/01/2026,Expense,400,Vendor Y,Partial,Office Expenses,-500.00
Office Expenses
,04/01/2026,Expense,400,Vendor Y,Partial,Checking,450.00
`;
  const { entries, quarantine } = pairTransactions(parseTransactionDetailByAccount(UNBALANCED));
  assert.equal(entries.length, 0);
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].reason, "UNBALANCED");
  assert.match(quarantine[0].detail, /-50\.00|50\.00/);
});

test("a three-account transaction pairs into one balanced entry", () => {
  const THREE = `,Date,Transaction Type,Num,Name,Memo/Description,Split,Amount
Checking
,05/01/2026,Check,500,Vendor Z,Invoice,-SPLIT-,-1000.00
Office Expenses
,05/01/2026,Check,500,Vendor Z,Supplies portion,Checking,600.00
Software
,05/01/2026,Check,500,Vendor Z,Licences portion,Checking,400.00
`;
  const { entries, quarantine } = pairTransactions(parseTransactionDetailByAccount(THREE));
  assert.equal(quarantine.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lines.length, 3);
  assert.equal(entries[0].amount, 1000);
  assert.equal(entries[0].synthesized, false, "all three sides were present; nothing was invented");
});

test("two transactions sharing a key are quarantined rather than merged", () => {
  const AMBIGUOUS = `,Date,Transaction Type,Num,Name,Memo/Description,Split,Amount
Checking
,06/01/2026,Expense,,Vendor Q,First,Office Expenses,-100.00
,06/01/2026,Expense,,Vendor Q,Second,Office Expenses,-200.00
Office Expenses
,06/01/2026,Expense,,Vendor Q,First,Checking,100.00
,06/01/2026,Expense,,Vendor Q,Second,Checking,200.00
`;
  const { entries, quarantine } = pairTransactions(parseTransactionDetailByAccount(AMBIGUOUS));
  assert.equal(entries.length, 0);
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].reason, "AMBIGUOUS_GROUP");
});

test("Debit/Credit columns are read when there is no single Amount column", () => {
  const DC = `,Date,Transaction Type,Num,Name,Memo/Description,Split,Debit,Credit
Checking
,07/01/2026,Deposit,700,Client A,Payment received,Sales Income,1500.00,
Sales Income
,07/01/2026,Deposit,700,Client A,Payment received,Checking,,1500.00
`;
  const { entries, quarantine } = pairTransactions(parseTransactionDetailByAccount(DC));
  assert.equal(quarantine.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lines.find((l) => l.account === "Checking")!.amount, 1500);
  assert.equal(entries[0].lines.find((l) => l.account === "Sales Income")!.amount, -1500);
});

test("a file with no recognisable header reports that instead of throwing", () => {
  const parsed = parseTransactionDetailByAccount("just,some,text\n1,2,3\n");
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0].message, /header/i);
});

test("inferAccountType is a guess, and says when it is a weak one", () => {
  assert.deepEqual(inferAccountType("Checking"), { type: "Asset", subType: "Cash & Equivalents", confidence: "high" });
  assert.equal(inferAccountType("Accounts Receivable").subType, "Receivables");
  assert.equal(inferAccountType("Accounts Payable").type, "Liability");
  assert.equal(inferAccountType("Sales Income").type, "Revenue");
  assert.equal(inferAccountType("Cost of Goods Sold").subType, "Cost of Sales");
  assert.equal(inferAccountType("Rent Expense").type, "Expense");
  assert.equal(inferAccountType("Retained Earnings").type, "Equity");
  // Nothing matched: still a guess, but flagged so the UI asks.
  assert.equal(inferAccountType("Zymurgy").confidence, "low");
});
