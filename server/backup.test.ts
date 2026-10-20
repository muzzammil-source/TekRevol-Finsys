// Tests for the backup module (2026-10-20).
//
// A backup system that silently produces unusable files is worse than none,
// so these check the things that fail quietly: that the snapshot actually
// contains the data, that it is a valid database, and that retention keeps
// the NEWEST files rather than whichever ones the filesystem listed first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { backupConfigFor, backupFileName, listBackups, pruneBackups, runBackup, isBackupDue } from "./backup.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "finsys-backup-test-"));
}

function makeDb(dir: string) {
  const file = path.join(dir, "finance.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE journal_entries (id INTEGER PRIMARY KEY, description TEXT)");
  const insert = db.prepare("INSERT INTO journal_entries (description) VALUES (?)");
  for (let i = 1; i <= 25; i++) insert.run(`entry ${i}`);
  return { db, file };
}

test("config defaults put backups beside the database", () => {
  const cfg = backupConfigFor("/data/finance.db", {} as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, true, "on by default — an opt-in backup gets forgotten");
  assert.equal(cfg.dir, path.join("/data", "backups"));
  assert.equal(cfg.keep, 14);
  assert.equal(cfg.intervalHours, 24);
});

test("config is overridable, and ignores nonsense values", () => {
  const cfg = backupConfigFor("/data/finance.db", {
    BACKUP_ENABLED: "false", BACKUP_KEEP: "3", BACKUP_INTERVAL_HOURS: "6",
  } as any);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.keep, 3);
  assert.equal(cfg.intervalHours, 6);

  const junk = backupConfigFor("/data/finance.db", { BACKUP_KEEP: "-5", BACKUP_INTERVAL_HOURS: "abc" } as any);
  assert.equal(junk.keep, 14, "a negative retention would delete everything");
  assert.equal(junk.intervalHours, 24);
});

test("file names sort chronologically as plain text", () => {
  const a = backupFileName(new Date(2026, 0, 5, 9, 3, 1));
  const b = backupFileName(new Date(2026, 9, 20, 14, 30, 5));
  assert.equal(a, "finance-20260105-090301.db");
  assert.equal(b, "finance-20261020-143005.db");
  assert.ok(a < b, "plain string ordering must match time ordering");
});

test("a snapshot is a real database containing the data", async () => {
  const dir = tempDir();
  const { db } = makeDb(dir);
  const cfg = { enabled: true, dir: path.join(dir, "backups"), keep: 5, intervalHours: 24 };

  const result = await runBackup(db, cfg);
  assert.ok(fs.existsSync(result.file.path));
  assert.ok(result.file.bytes > 0);

  const copy = new Database(result.file.path, { readonly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM journal_entries").get().n, 25);
  assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
  copy.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writes that happen after a snapshot are not in it", async () => {
  const dir = tempDir();
  const { db } = makeDb(dir);
  const cfg = { enabled: true, dir: path.join(dir, "backups"), keep: 5, intervalHours: 24 };

  const first = await runBackup(db, cfg, new Date(2026, 9, 20, 1, 0, 0));
  db.prepare("INSERT INTO journal_entries (description) VALUES ('added later')").run();
  const second = await runBackup(db, cfg, new Date(2026, 9, 20, 2, 0, 0));

  const older = new Database(first.file.path, { readonly: true });
  const newer = new Database(second.file.path, { readonly: true });
  assert.equal(older.prepare("SELECT COUNT(*) n FROM journal_entries").get().n, 25);
  assert.equal(newer.prepare("SELECT COUNT(*) n FROM journal_entries").get().n, 26);
  older.close(); newer.close(); db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("retention keeps the newest and deletes the rest", async () => {
  const dir = tempDir();
  const { db } = makeDb(dir);
  const backups = path.join(dir, "backups");
  const cfg = { enabled: true, dir: backups, keep: 3, intervalHours: 24 };

  for (let day = 1; day <= 6; day++) {
    await runBackup(db, cfg, new Date(2026, 9, day, 3, 0, 0));
  }

  const left = listBackups(backups).map((b) => b.name);
  assert.equal(left.length, 3, "should have pruned down to the retention count");
  assert.deepEqual(left, [
    "finance-20261006-030000.db",
    "finance-20261005-030000.db",
    "finance-20261004-030000.db",
  ], "the three newest survive, newest first");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pruning never removes the only copy, whatever the retention says", async () => {
  const dir = tempDir();
  const { db } = makeDb(dir);
  const backups = path.join(dir, "backups");
  await runBackup(db, { enabled: true, dir: backups, keep: 1, intervalHours: 24 });
  pruneBackups(backups, 0);
  assert.equal(listBackups(backups).length, 1, "a zero retention must not wipe the last backup");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a backup is due when there are none, and not due right after one", async () => {
  const dir = tempDir();
  const { db } = makeDb(dir);
  const cfg = { enabled: true, dir: path.join(dir, "backups"), keep: 5, intervalHours: 24 };

  assert.equal(isBackupDue(cfg), true, "no snapshots yet");
  await runBackup(db, cfg);
  assert.equal(isBackupDue(cfg), false, "one was just taken");
  assert.equal(
    isBackupDue(cfg, new Date(Date.now() + 25 * 3600_000)),
    true,
    "due again once the interval has passed",
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a snapshot leaves no WAL sidecars behind", async () => {
  const dir = tempDir();
  const { db } = makeDb(dir);
  const backups = path.join(dir, "backups");
  const result = await runBackup(db, { enabled: true, dir: backups, keep: 5, intervalHours: 24 });

  assert.ok(!fs.existsSync(result.file.path + "-wal"), "-wal must be cleaned up");
  assert.ok(!fs.existsSync(result.file.path + "-shm"), "-shm must be cleaned up");
  assert.deepEqual(fs.readdirSync(backups), [result.file.name], "only the snapshot itself");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listing ignores files that are not snapshots", async () => {
  const dir = tempDir();
  const { db } = makeDb(dir);
  const backups = path.join(dir, "backups");
  await runBackup(db, { enabled: true, dir: backups, keep: 5, intervalHours: 24 });
  fs.writeFileSync(path.join(backups, "notes.txt"), "hello");
  fs.writeFileSync(path.join(backups, "finance.db"), "not a snapshot name");

  const found = listBackups(backups);
  assert.equal(found.length, 1);
  assert.match(found[0].name, /^finance-\d{8}-\d{6}\.db$/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
