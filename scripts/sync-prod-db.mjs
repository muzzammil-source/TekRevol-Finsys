#!/usr/bin/env node
// Pull the deployment's database down and put it where the next deploy will
// ship it back (2026-10-13).
//
// Why this exists: with no volume attached, the container's filesystem is
// rebuilt from git on every deploy, so the copy of server/finance.db that is
// COMMITTED is the only database production ever gets. Anything entered on
// the live site survives only until the next deploy — unless it is captured
// first. That is what this does.
//
//   node scripts/sync-prod-db.mjs            # fetch, show what changed, write it
//   node scripts/sync-prod-db.mjs --dry-run  # fetch and compare only
//
// Afterwards, commit it deliberately (the pre-commit hook blocks databases by
// design, which is why this one needs --no-verify):
//
//   git add -f server/finance.db
//   git commit --no-verify -m "chore: sync production database"
//
// This is a workaround, not the fix. The fix is a Railway volume plus
// DB_PATH — then production keeps its own books and none of this is needed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "server", "finance.db");
const dryRun = process.argv.includes("--dry-run");

// Checkpoint first: a SQLite file copied without folding in its write-ahead
// log is missing whatever had not been written back yet — which on a busy
// day is most of what you came for.
const remote = [
  "cd /app/server",
  `node -e "const D=require('better-sqlite3');const db=new D(process.env.DB_PATH||'finance.db');db.pragma('wal_checkpoint(TRUNCATE)');db.close()"`,
  `base64 -w0 "\${DB_PATH:-finance.db}"`,
].join(" && ");

console.log("Fetching the database from the deployment…");
let b64;
try {
  b64 = execFileSync("npx", ["--yes", "@railway/cli", "ssh", remote], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    shell: process.platform === "win32",
  }).trim();
} catch (err) {
  console.error("\nCould not reach the deployment.");
  console.error("Check you are logged in and linked:  npx @railway/cli status");
  console.error(String(err?.stderr || err?.message || err).trim().split("\n").slice(-5).join("\n"));
  process.exit(1);
}

const base64Only = b64.split(/\s+/).filter((l) => /^[A-Za-z0-9+/=]+$/.test(l) && l.length > 100).pop();
if (!base64Only) {
  console.error("The deployment did not return a database. Raw output:\n" + b64.slice(0, 400));
  process.exit(1);
}

const buffer = Buffer.from(base64Only, "base64");
if (buffer.subarray(0, 15).toString() !== "SQLite format 3") {
  console.error("What came back is not a SQLite database — refusing to write it.");
  process.exit(1);
}

const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
console.log(`Fetched ${(buffer.length / 1024).toFixed(0)} KB`);
if (existing) {
  console.log(`Local copy  ${(existing.length / 1024).toFixed(0)} KB`);
  if (existing.equals(buffer)) {
    console.log("Identical — production and the committed snapshot already match. Nothing to do.");
    process.exit(0);
  }
}

if (dryRun) {
  console.log("--dry-run: they differ; nothing written.");
  process.exit(0);
}

if (existing) {
  const backup = `${target}.bak-presync-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  fs.writeFileSync(backup, existing);
  console.log(`Previous copy kept at ${path.basename(backup)}`);
}
fs.writeFileSync(target, buffer);
console.log(`\nWrote ${target}`);
console.log("\nCommit it deliberately:");
console.log("  git add -f server/finance.db");
console.log('  git commit --no-verify -m "chore: sync production database"');
