// Automated database backups (2026-10-20).
//
// Why this exists: the books used to be committed to git, so every push was
// an accidental backup. Now that production keeps them on a volume and the
// database is out of the repository, the volume is the ONLY copy — so the
// system has to make its own.
//
// How a SQLite database must be copied: through the online backup API
// (`db.backup()`), never `cp`. A plain file copy of a live database can
// capture a page mid-write, and the result looks fine until the day you try
// to restore it. The backup API takes a consistent snapshot while writers
// continue, and every snapshot here is re-opened and integrity-checked
// before it is allowed to count.
//
// Scope, stated plainly: these snapshots sit on the same volume as the
// database. That protects against the losses that actually happen — a bad
// import, a deletion, a corrupted file — but NOT against losing the volume
// itself. Pull copies off the box periodically (GET /api/backups/:name/
// download, Admin only) or point BACKUP_DIR at a second mount.
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

export type BackupConfig = {
  enabled: boolean;
  dir: string;
  /** How many snapshots to keep; older ones are pruned after each run. */
  keep: number;
  intervalHours: number;
};

export type BackupFile = {
  name: string;
  path: string;
  bytes: number;
  createdAt: string;
};

export type BackupResult = {
  file: BackupFile;
  durationMs: number;
  pruned: string[];
};

const FILE_PATTERN = /^finance-(\d{8})-(\d{6})\.db$/;

export function backupConfigFor(dbPath: string, env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const configuredDir = String(env.BACKUP_DIR || "").trim();
  const keep = Number(env.BACKUP_KEEP);
  const intervalHours = Number(env.BACKUP_INTERVAL_HOURS);
  return {
    // On by default: a backup you have to remember to switch on is not a
    // backup. BACKUP_ENABLED=false opts out (tests, throwaway instances).
    enabled: String(env.BACKUP_ENABLED ?? "true").toLowerCase() !== "false",
    dir: configuredDir
      ? (path.isAbsolute(configuredDir) ? configuredDir : path.resolve(configuredDir))
      : path.join(path.dirname(dbPath), "backups"),
    keep: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 14,
    intervalHours: Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 24,
  };
}

/** `finance-20261020-143005.db` — sorts chronologically as plain text. */
export function backupFileName(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `finance-${stamp}.db`;
}

/** Newest first. Ignores anything that isn't one of our snapshots. */
export function listBackups(dir: string): BackupFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => FILE_PATTERN.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, path: full, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Deletes all but the newest `keep` snapshots. Returns what it removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  const removed: string[] = [];
  for (const old of listBackups(dir).slice(Math.max(1, keep))) {
    try {
      fs.unlinkSync(old.path);
      removed.push(old.name);
    } catch (e) {
      console.error(`[backup] could not remove ${old.name}:`, e);
    }
  }
  return removed;
}

/**
 * Takes one snapshot. Throws if the result fails its integrity check, and
 * deletes the bad file rather than leaving something that looks like a
 * backup but isn't.
 */
export async function runBackup(db: BetterSqlite3.Database, config: BackupConfig, now: Date = new Date()): Promise<BackupResult> {
  fs.mkdirSync(config.dir, { recursive: true });
  const name = backupFileName(now);
  const target = path.join(config.dir, name);
  const started = Date.now();

  await db.backup(target);

  let verified = false;
  try {
    const copy = new Database(target, { readonly: true });
    try {
      const check = copy.pragma("integrity_check", { simple: true });
      verified = check === "ok";
    } finally {
      copy.close();
    }
  } catch (e) {
    verified = false;
  }
  if (!verified) {
    try { fs.unlinkSync(target); } catch { /* nothing more to do */ }
    throw new Error(`Backup ${name} failed its integrity check and was discarded`);
  }

  // Opening the snapshot to check it leaves empty -wal/-shm files beside it.
  // The backup API already checkpointed everything into the file itself, so
  // they carry nothing — and leaving them makes a backup folder look like it
  // holds live databases.
  for (const suffix of ["-wal", "-shm"]) {
    try { if (fs.existsSync(target + suffix)) fs.unlinkSync(target + suffix); } catch { /* harmless */ }
  }

  const stat = fs.statSync(target);
  return {
    file: { name, path: target, bytes: stat.size, createdAt: stat.mtime.toISOString() },
    durationMs: Date.now() - started,
    pruned: pruneBackups(config.dir, config.keep),
  };
}

/** True when the newest snapshot is older than the configured interval. */
export function isBackupDue(config: BackupConfig, now: Date = new Date()): boolean {
  const newest = listBackups(config.dir)[0];
  if (!newest) return true;
  return now.getTime() - new Date(newest.createdAt).getTime() >= config.intervalHours * 3600_000;
}

/**
 * Runs one backup shortly after boot if the last is stale, then on the
 * interval. Deliberately in-process: no cron, no extra service, nothing to
 * configure on the host — a container that is running is backing itself up.
 * The timers are unref'd so they never hold the process open.
 */
export function scheduleBackups(db: BetterSqlite3.Database, config: BackupConfig): void {
  if (!config.enabled) {
    console.log("[backup] disabled (BACKUP_ENABLED=false)");
    return;
  }
  const attempt = async (reason: string) => {
    try {
      const result = await runBackup(db, config);
      const kb = (result.file.bytes / 1024).toFixed(0);
      console.log(
        `[backup] ${reason}: ${result.file.name} (${kb} KB, ${result.durationMs}ms)` +
          (result.pruned.length ? ` — pruned ${result.pruned.length}` : ""),
      );
    } catch (e: any) {
      // Never throw out of the scheduler: a failed backup must not take the
      // server down, but it must be loud in the log.
      console.error(`[backup] FAILED (${reason}):`, e?.message || e);
    }
  };

  // A short delay so boot-time schema work finishes first.
  const first = setTimeout(() => {
    if (isBackupDue(config)) void attempt("startup");
    else console.log(`[backup] recent snapshot exists; next in ≤${config.intervalHours}h`);
  }, 60_000);
  first.unref?.();

  const timer = setInterval(() => void attempt("scheduled"), config.intervalHours * 3600_000);
  timer.unref?.();

  console.log(`[backup] every ${config.intervalHours}h → ${config.dir} (keeping ${config.keep})`);
}
