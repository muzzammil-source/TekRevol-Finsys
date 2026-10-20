// Authentication & role-based access control (2026-09-17).
//
// Until now every request was anonymous (CLAUDE.md §6). This module adds:
//   - users, their entity access, and server-side sessions (SQLite);
//   - scrypt password hashing and an httpOnly session cookie;
//   - a deny-by-default ROUTE RULE TABLE checked before every /api request.
//
// The UI hides and disables controls per role, but that is only
// convenience — THIS module is the enforcement. Any /api route without an
// explicit rule is Admin-only and requires access to all entities, so a new
// endpoint is closed until someone deliberately opens it.
//
// Entity isolation is enforced in two places:
//   1. here, for report-style GETs that take ?entityId= (rule scope
//      "entityQuery") and for routes a restricted user may not touch at all
//      (scope "allEntitiesOnly");
//   2. inside the routes in index.ts that return or change entity-scoped
//      rows (lists are filtered; writes are checked) — via the helpers
//      exported below.

import crypto from "crypto";
import { sendPasswordResetEmail } from "./mailer";
import type { Express, NextFunction, Request, Response } from "express";
import type BetterSqlite3 from "better-sqlite3";

export const ROLES = ["Admin", "Manager", "Bookkeeper", "Auditor"] as const;
export type Role = (typeof ROLES)[number];

// What a role may do. Enforced server-side; mirrored in the UI for display.
//   read           view data (every role)
//   stage          prepare bank transactions: categorize / split / From-To, saved for review
//   import         upload statements into a bank feed
//   contacts.write create / edit customers & vendors (opening balances need `post`)
//   post           write to the General Ledger: post / unpost / bulk-post, opening balances
//   coa.write      create / edit / delete Chart of Accounts heads
//   admin          settings: users, entities, exchange rates, period closing, integrations
export type Capability = "read" | "stage" | "import" | "contacts.write" | "post" | "coa.write" | "admin";

const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  Admin: new Set<Capability>(["read", "stage", "import", "contacts.write", "post", "coa.write", "admin"]),
  Manager: new Set<Capability>(["read", "stage", "import", "contacts.write", "post", "coa.write"]),
  Bookkeeper: new Set<Capability>(["read", "stage", "import", "contacts.write"]),
  Auditor: new Set<Capability>(["read"]),
};

export function roleCan(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(cap) ?? false;
}

export type AuthUser = {
  id: number;
  fullName: string;
  email: string;
  role: Role;
  status: "Active" | "Disabled";
  mustChangePassword: boolean;
};

export type AuthContext = {
  user: AuthUser;
  /** Admins always; other roles when granted "All Entities". */
  allEntities: boolean;
  /** Explicit entity ids (ignored when allEntities). */
  entityIds: Set<number>;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export class AccessError extends Error {
  constructor(public status: number, message: string, public code = "FORBIDDEN") {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Entity helpers used by routes in index.ts
// ---------------------------------------------------------------------------

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw new AccessError(401, "Not signed in", "UNAUTHENTICATED");
  return req.auth;
}

/** null = unrestricted; otherwise the ids this user may see. */
export function visibleEntityIds(req: Request): number[] | null {
  const a = authOf(req);
  return a.allEntities ? null : [...a.entityIds];
}

export function canAccessEntity(req: Request, entityId: number | null | undefined): boolean {
  const a = authOf(req);
  if (a.allEntities) return true;
  return entityId != null && a.entityIds.has(Number(entityId));
}

/**
 * Throws 403 unless the user may act on `entityId`. `null` means a Shared
 * (entity-less) record: anyone may READ shared structure, but only users with
 * access to all entities may CREATE or CHANGE one, since it affects every
 * entity's books.
 */
export function assertEntityAccess(req: Request, entityId: number | null | undefined, what = "this entity"): void {
  const a = authOf(req);
  if (a.allEntities) return;
  if (entityId == null) {
    throw new AccessError(403, `Changing shared (all-entity) records requires access to all entities`);
  }
  if (!a.entityIds.has(Number(entityId))) {
    throw new AccessError(403, `You don't have access to ${what}`);
  }
}

export function assertCapability(req: Request, cap: Capability, action: string): void {
  const a = authOf(req);
  if (!roleCan(a.user.role, cap)) {
    throw new AccessError(403, `Your role (${a.user.role}) can't ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function passwordProblem(password: unknown): string | null {
  const pw = String(password ?? "");
  if (pw.length < 10) return "Password must be at least 10 characters";
  if (pw.length > 200) return "Password is too long";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain at least one letter and one number";
  return null;
}

// ---------------------------------------------------------------------------
// Route rule table (deny by default)
// ---------------------------------------------------------------------------

type Scope = "none" | "entityQuery" | "allEntitiesOnly";
type Rule = { method: string; path: RegExp; access: "public" | "session" | Capability; scope?: Scope };

const R = (method: string, path: RegExp, access: Rule["access"], scope: Scope = "none"): Rule => ({ method, path, access, scope });
const ANY = "*";

// First match wins. Paths are matched against the path WITHOUT query string.
const RULES: Rule[] = [
  // --- auth ---
  R("GET", /^\/api\/auth\/status$/, "public"),
  R("POST", /^\/api\/auth\/(login|bootstrap)$/, "public"),
  // Public by necessity: someone who can't sign in has to be able to ask
  // for a link, and the link itself is the only credential on the reset.
  R("POST", /^\/api\/auth\/(forgot-password|reset-password)$/, "public"),
  R("GET", /^\/api\/auth\/me$/, "session"),
  R("POST", /^\/api\/auth\/(logout|change-password)$/, "session"),
  R(ANY, /^\/api\/users(\/.*)?$/, "admin", "allEntitiesOnly"),

  // --- structure (lists filtered per entity inside the route) ---
  R("GET", /^\/api\/entities$/, "read"),
  R(ANY, /^\/api\/entities(\/\d+)?$/, "admin", "allEntitiesOnly"),
  R("GET", /^\/api\/brands$/, "read"),
  R("GET", /^\/api\/journal-entries$/, "read"),
  // Manual journal entries hit the ledger directly — same capability as
  // posting a bank transaction; entity access is checked per line inside.
  R("POST", /^\/api\/journal-entries$/, "post"),
  // Split rules are configuration that spans entities: anyone may read them,
  // only an Admin with every entity may change them.
  R("GET", /^\/api\/split-rules$/, "read"),
  R(ANY, /^\/api\/split-rules(\/\d+)?$/, "admin", "allEntitiesOnly"),
  R("GET", /^\/api\/exchange-rates$/, "read"),
  // Rate lookup for the Journal Entry screen's Exchange Rate field.
  R("GET", /^\/api\/exchange-rates\/resolve$/, "read"),
  R(ANY, /^\/api\/exchange-rates(\/\d+)?$/, "admin", "allEntitiesOnly"),

  // --- Chart of Accounts ---
  R("GET", /^\/api\/accounts$/, "read"),
  R("GET", /^\/api\/accounts\/balances$/, "read"),
  R("GET", /^\/api\/accounts\/\d+\/register$/, "read"),
  R("POST", /^\/api\/accounts\/(bulk|bulk-delete)$/, "coa.write", "allEntitiesOnly"),
  R("POST", /^\/api\/accounts$/, "coa.write"),
  R("PUT", /^\/api\/accounts\/\d+$/, "coa.write"),
  R("DELETE", /^\/api\/accounts\/\d+$/, "coa.write"),

  // --- Banking ---
  R("GET", /^\/api\/banking\/cards$/, "read"),
  R("POST", /^\/api\/banking\/feeds$/, "import"),
  R("GET", /^\/api\/bank-accounts$/, "read"),
  R("POST", /^\/api\/bank-accounts\/\d+\/refresh-balance$/, "import"),
  R("GET", /^\/api\/bank-transactions$/, "read"),
  R("GET", /^\/api\/bank-transactions\/unposted$/, "read"),
  R("POST", /^\/api\/bank-transactions\/import$/, "import"),
  R("PUT", /^\/api\/bank-transactions\/\d+\/stage$/, "stage"),
  R("POST", /^\/api\/bank-transactions\/\d+\/(post|unpost|post-split)$/, "post"),
  R("POST", /^\/api\/bank-transactions\/bulk-post$/, "post"),
  // Dismissing feed rows decides what never reaches the books, so it needs
  // the same authority as posting them.
  R("POST", /^\/api\/bank-transactions\/bulk-ignore$/, "post"),
  R("PATCH", /^\/api\/bank-transactions\/\d+\/status$/, "post"),

  // --- Contacts / sub-ledgers ---
  R("GET", /^\/api\/contacts$/, "read"),
  R("GET", /^\/api\/contacts\/\d+\/ledger$/, "read"),
  R("POST", /^\/api\/contacts$/, "contacts.write"),
  R("PUT", /^\/api\/contacts\/\d+$/, "contacts.write"),
  R("DELETE", /^\/api\/contacts\/\d+$/, "contacts.write"),

  // --- Statutory reports: restricted users must name one of their entities ---
  R("GET", /^\/api\/reports\/(income-statement|balance-sheet|trial-balance|general-ledger|cash-flow|cash-flow-trend|executive|subledger)$/, "read", "entityQuery"),
  // Management analytics (not in the nav) — not entity-isolated, so only
  // for users who can already see every entity.
  R("GET", /^\/api\/reports\/(brand-pnl|revenue-streams|trends)$/, "read", "allEntitiesOnly"),
  // The intercompany matrix is inherently a group-wide view — every cell
  // names two entities and its point is the pair reconciling — so it can
  // only be shown to someone who may see them all.
  R("GET", /^\/api\/reports\/intercompany-balances$/, "read", "allEntitiesOnly"),

  // --- Backups ---
  // A snapshot is the entire book of record plus the users table, so
  // listing, triggering and downloading one are all Admin + all entities.
  R(ANY, /^\/api\/backups(\/.*)?$/, "admin", "allEntitiesOnly"),

  // --- Ledger import (Phase C) ---
  // Reading and staging a file is the `import` capability, the same one that
  // governs bank statements. Turning a batch into the book of record is
  // `post`, because that is what it is.
  R("POST", /^\/api\/imports\/quickbooks\/preview$/, "import"),
  R("POST", /^\/api\/imports\/quickbooks\/\d+\/commit$/, "import"),
  R("GET", /^\/api\/import-batches(\/\d+)?$/, "read"),
  R("POST", /^\/api\/import-batches\/\d+\/post$/, "post"),
  R("POST", /^\/api\/import-batches\/\d+\/discard$/, "import"),

  // --- Bank reconciliation & period locking (Phase 1.5) ---
  // Stated explicitly as of 2026-10-12 rather than left to the catch-all:
  // these decide when a period is signed off and locked, so who may run
  // them should be readable here instead of inferred from the absence of a
  // rule. The access level is unchanged (Admin, all entities) — if
  // Bookkeepers should reconcile, this is the one line to change.
  R(ANY, /^\/api\/reconciliations(\/.*)?$/, "admin", "allEntitiesOnly"),
  R("GET", /^\/api\/reconciliation\/status$/, "admin", "allEntitiesOnly"),
  R("POST", /^\/api\/reconciliation\/lock-period$/, "admin", "allEntitiesOnly"),

  R("GET", /^\/api\/plaid\/status$/, "read"),
  // Everything else (legacy AP/AR, Plaid management, categorization rules,
  // intercompany recharges …) falls through to the default: Admin + all
  // entities.
];

function ruleFor(method: string, path: string): Rule {
  for (const rule of RULES) {
    if ((rule.method === ANY || rule.method === method) && rule.path.test(path)) return rule;
  }
  return { method, path: /.*/, access: "admin", scope: "allEntitiesOnly" };
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "finsys_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, sliding
const SESSION_REFRESH_MS = 30 * 60 * 1000; // extend at most every 30 min
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
// Short-lived on purpose: the link is a bearer credential sitting in an inbox.
const RESET_TTL_MS = 60 * 60 * 1000; // 1h
const RESET_MAX_REQUESTS = 5;
const RESET_THROTTLE_MS = 15 * 60 * 1000;

/**
 * Where the reset link should point.
 *
 * APP_BASE_URL wins and is what production should set: a link built from
 * request headers can be aimed somewhere else by whoever sends the request
 * (classic host-header injection), and this link carries a token that
 * resets an account.
 *
 * Falling back to headers keeps local dev working unconfigured, but it
 * prefers the browser's Origin over Host — in dev the API sits behind
 * Vite's proxy, so Host is the API's own port (3001) while Origin is the
 * address the person actually has open (5000).
 */
function appBaseUrl(req: Request): string {
  const configured = String(process.env.APP_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const origin = String(req.headers.origin || "").trim().replace(/\/$/, "");
  if (/^https?:\/\//.test(origin)) return origin;
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}

export function createAuth(db: BetterSqlite3.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fullName TEXT NOT NULL,
      email TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Admin','Manager','Bookkeeper','Auditor')),
      allEntities INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Disabled')),
      mustChangePassword INTEGER NOT NULL DEFAULT 1,
      lastLoginAt TEXT DEFAULT NULL,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (lower(email));
    CREATE TABLE IF NOT EXISTS user_entities (
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entityId INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      PRIMARY KEY (userId, entityId)
    );
    -- Only a SHA-256 of the session token is stored, so a copy of the
    -- database can't be used to hijack live sessions.
    CREATE TABLE IF NOT EXISTS sessions (
      tokenHash TEXT PRIMARY KEY,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      lastSeenAt INTEGER NOT NULL,
      userAgent TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (userId);
    -- Password-reset links. Like sessions, only a SHA-256 of the token is
    -- stored: the email carries the only copy, so a leaked database can't
    -- be used to seize an account.
    CREATE TABLE IF NOT EXISTS password_resets (
      tokenHash TEXT PRIMARY KEY,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      usedAt INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_password_resets_user ON password_resets (userId);
  `);

  const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const normalizeEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();

  function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of String(header || "").split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function setSessionCookie(req: Request, res: Response, token: string, maxAgeMs: number) {
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    const attrs = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (secure) attrs.push("Secure");
    res.setHeader("Set-Cookie", attrs.join("; "));
  }

  function userRow(id: number): any {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }

  function toAuthUser(u: any): AuthUser {
    return { id: u.id, fullName: u.fullName, email: u.email, role: u.role, status: u.status, mustChangePassword: !!u.mustChangePassword };
  }

  function contextFor(u: any): AuthContext {
    const ids = (db.prepare("SELECT entityId FROM user_entities WHERE userId = ?").all(u.id) as { entityId: number }[]).map((r) => r.entityId);
    return { user: toAuthUser(u), allEntities: u.role === "Admin" || !!u.allEntities, entityIds: new Set(ids) };
  }

  function publicUser(u: any) {
    const ctx = contextFor(u);
    return {
      id: u.id, fullName: u.fullName, email: u.email, role: u.role, status: u.status,
      allEntities: ctx.allEntities, entityIds: [...ctx.entityIds],
      mustChangePassword: !!u.mustChangePassword, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
    };
  }

  function createSession(req: Request, res: Response, userId: number) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    db.prepare("INSERT INTO sessions (tokenHash, userId, expiresAt, createdAt, lastSeenAt, userAgent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(token), userId, now + SESSION_TTL_MS, now, now, String(req.headers["user-agent"] || "").slice(0, 200));
    db.prepare("UPDATE users SET lastLoginAt = CURRENT_TIMESTAMP WHERE id = ?").run(userId);
    setSessionCookie(req, res, token, SESSION_TTL_MS);
  }

  function resolveSession(req: Request, res: Response): AuthContext | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = sha256(token);
    const s = db.prepare("SELECT * FROM sessions WHERE tokenHash = ?").get(tokenHash) as any;
    const now = Date.now();
    if (!s || s.expiresAt <= now) {
      if (s) db.prepare("DELETE FROM sessions WHERE tokenHash = ?").run(tokenHash);
      return null;
    }
    const u = userRow(s.userId);
    if (!u || u.status !== "Active") return null;
    if (now - s.lastSeenAt > SESSION_REFRESH_MS) {
      db.prepare("UPDATE sessions SET expiresAt = ?, lastSeenAt = ? WHERE tokenHash = ?").run(now + SESSION_TTL_MS, now, tokenHash);
      setSessionCookie(req, res, token, SESSION_TTL_MS);
    }
    return contextFor(u);
  }

  // In-memory login throttle, keyed by email + IP.
  const failures = new Map<string, { count: number; lockedUntil: number; first: number }>();
  const throttleKey = (req: Request, email: string) => `${email}|${req.ip}`;

  // ---- gate: runs before every /api handler ----
  function gate(req: Request, res: Response, next: NextFunction) {
    if (!req.path.startsWith("/api/")) return next();
    const rule = ruleFor(req.method, req.path);
    if (rule.access === "public") return next();

    const ctx = resolveSession(req, res);
    if (!ctx) return res.status(401).json({ error: "Please sign in", code: "UNAUTHENTICATED" });
    req.auth = ctx;

    // A temporary password must be replaced before anything else.
    if (ctx.user.mustChangePassword && rule.access !== "session") {
      return res.status(403).json({ error: "Change your temporary password to continue", code: "PASSWORD_CHANGE_REQUIRED" });
    }
    if (rule.access === "session") return next();

    if (!roleCan(ctx.user.role, rule.access)) {
      return res.status(403).json({ error: `Your role (${ctx.user.role}) doesn't have permission for this action`, code: "FORBIDDEN" });
    }

    if (!ctx.allEntities) {
      if (rule.scope === "allEntitiesOnly") {
        return res.status(403).json({ error: "This requires access to all entities", code: "ENTITY_FORBIDDEN" });
      }
      if (rule.scope === "entityQuery") {
        const raw = (req.query as any).entityId;
        if (raw) {
          if (!ctx.entityIds.has(Number(raw))) {
            return res.status(403).json({ error: "You don't have access to that entity", code: "ENTITY_FORBIDDEN" });
          }
        } else if (ctx.entityIds.size === 1) {
          // One entity: scope silently to it rather than returning consolidated data.
          (req.query as any).entityId = String([...ctx.entityIds][0]);
        } else {
          return res.status(403).json({ error: "Select one of your entities — consolidated reports require access to all entities", code: "ENTITY_REQUIRED" });
        }
        const brandId = (req.query as any).brandId;
        if (brandId) {
          const b = db.prepare("SELECT entityId FROM brands WHERE id = ?").get(Number(brandId)) as { entityId: number } | undefined;
          if (!b || !ctx.entityIds.has(b.entityId)) {
            return res.status(403).json({ error: "You don't have access to that entity", code: "ENTITY_FORBIDDEN" });
          }
        }
      }
    }
    next();
  }

  // ---- routes ----
  function registerRoutes(app: Express) {
    const userCount = () => (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
    const activeAdminCount = (excludeId?: number) =>
      (db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'Admin' AND status = 'Active' AND id <> ?").get(excludeId ?? -1) as { n: number }).n;

    const validEntityIds = (raw: unknown): number[] => {
      const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      const existing = new Set((db.prepare("SELECT id FROM entities").all() as { id: number }[]).map((r) => r.id));
      const unknown = ids.filter((id) => !existing.has(id));
      if (unknown.length) throw new AccessError(400, `Unknown entity id(s): ${unknown.join(", ")}`, "BAD_REQUEST");
      return ids;
    };

    const sendError = (res: Response, err: any, fallback: string) => {
      if (err instanceof AccessError) return res.status(err.status).json({ error: err.message, code: err.code });
      if (String(err?.message || "").includes("UNIQUE")) return res.status(409).json({ error: "A user with that email already exists" });
      return res.status(400).json({ error: err?.message || fallback });
    };

    app.get("/api/auth/status", (_req, res) => {
      res.json({ needsSetup: userCount() === 0 });
    });

    // First-run only: creates the first Admin while the users table is empty.
    app.post("/api/auth/bootstrap", (req, res) => {
      try {
        const fullName = String(req.body?.fullName ?? "").trim();
        const email = normalizeEmail(req.body?.email);
        const password = String(req.body?.password ?? "");
        if (!fullName || !email.includes("@")) return res.status(400).json({ error: "Full name and a valid email are required" });
        const problem = passwordProblem(password);
        if (problem) return res.status(400).json({ error: problem });
        const id = db.transaction(() => {
          if (userCount() > 0) throw new AccessError(409, "Setup is already complete — sign in instead", "SETUP_DONE");
          return Number(db.prepare(
            "INSERT INTO users (fullName, email, passwordHash, role, allEntities, mustChangePassword) VALUES (?, ?, ?, 'Admin', 1, 0)",
          ).run(fullName, email, hashPassword(password)).lastInsertRowid);
        })();
        createSession(req, res, id);
        res.json({ user: publicUser(userRow(id)) });
      } catch (err) {
        sendError(res, err, "Setup failed");
      }
    });

    app.post("/api/auth/login", (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password ?? "");
      const key = throttleKey(req, email);
      const f = failures.get(key);
      const now = Date.now();
      if (f && f.lockedUntil > now) {
        return res.status(429).json({ error: `Too many failed attempts — try again in ${Math.ceil((f.lockedUntil - now) / 60000)} min` });
      }
      const u = db.prepare("SELECT * FROM users WHERE lower(email) = ?").get(email) as any;
      // Same message for unknown email and wrong password (no account enumeration).
      const ok = !!u && verifyPassword(password, u.passwordHash);
      if (!ok || u.status !== "Active") {
        const next = f && now - f.first < LOGIN_LOCK_MS ? { ...f, count: f.count + 1 } : { count: 1, first: now, lockedUntil: 0 };
        if (next.count >= LOGIN_MAX_FAILURES) next.lockedUntil = now + LOGIN_LOCK_MS;
        failures.set(key, next);
        return res.status(401).json({ error: ok ? "This account is disabled" : "Incorrect email or password" });
      }
      failures.delete(key);
      createSession(req, res, u.id);
      res.json({ user: publicUser(u) });
    });

    // ---- password reset by email ----
    // Both routes answer the same way whether or not the address is known:
    // the login route already refuses to confirm which emails exist, and a
    // reset form that leaks it would undo that.
    app.post("/api/auth/forgot-password", async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const key = `reset|${throttleKey(req, email)}`;
      const now = Date.now();
      const f = failures.get(key);
      // Rate-limited per email+IP so the form can't be used to flood an
      // inbox (or burn the mail quota). Still answers 200 when throttled.
      if (!(f && f.lockedUntil > now)) {
        const next = f && now - f.first < RESET_THROTTLE_MS ? { ...f, count: f.count + 1 } : { count: 1, first: now, lockedUntil: 0 };
        if (next.count >= RESET_MAX_REQUESTS) next.lockedUntil = now + RESET_THROTTLE_MS;
        failures.set(key, next);

        const u = db.prepare("SELECT * FROM users WHERE lower(email) = ?").get(email) as any;
        if (u && u.status === "Active") {
          const token = crypto.randomBytes(32).toString("base64url");
          db.transaction(() => {
            // One live link per account: asking again retires the previous.
            db.prepare("DELETE FROM password_resets WHERE userId = ? AND usedAt IS NULL").run(u.id);
            db.prepare("INSERT INTO password_resets (tokenHash, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)")
              .run(sha256(token), u.id, now + RESET_TTL_MS, now);
          })();
          const link = `${appBaseUrl(req)}/reset-password?token=${token}`;
          const minutes = Math.round(RESET_TTL_MS / 60000);
          try {
            const sent = await sendPasswordResetEmail(u.email, u.fullName, link, minutes);
            // No SMTP configured (local dev): the link goes to the server
            // log so the flow is still usable end to end.
            if (!sent) console.log(`[auth] password reset for ${u.email} (no SMTP configured): ${link}`);
          } catch (err: any) {
            // Never surfaced to the caller — that would confirm the address.
            console.error(`[auth] could not send the reset email for ${u.email}:`, err?.message || err);
          }
        }
      }
      res.json({ ok: true });
    });

    app.post("/api/auth/reset-password", (req, res) => {
      const token = String(req.body?.token ?? "");
      const password = String(req.body?.password ?? "");
      const row = token ? (db.prepare("SELECT * FROM password_resets WHERE tokenHash = ?").get(sha256(token)) as any) : null;
      const now = Date.now();
      if (!row || row.usedAt || row.expiresAt <= now) {
        return res.status(400).json({ error: "This reset link has expired or has already been used — request a new one." });
      }
      const problem = passwordProblem(password);
      if (problem) return res.status(400).json({ error: problem });
      const u = userRow(row.userId);
      if (!u || u.status !== "Active") return res.status(400).json({ error: "This account is not active" });
      db.transaction(() => {
        db.prepare("UPDATE users SET passwordHash = ?, mustChangePassword = 0 WHERE id = ?").run(hashPassword(password), u.id);
        db.prepare("UPDATE password_resets SET usedAt = ? WHERE tokenHash = ?").run(now, row.tokenHash);
        db.prepare("DELETE FROM password_resets WHERE userId = ? AND usedAt IS NULL").run(u.id);
        // Whoever was signed in as this user is signed out: a reset is also
        // how someone takes an account back.
        db.prepare("DELETE FROM sessions WHERE userId = ?").run(u.id);
      })();
      // Control of the mailbox was just proven, so sign them straight in.
      createSession(req, res, u.id);
      res.json({ user: publicUser(userRow(u.id)) });
    });

    app.post("/api/auth/logout", (req, res) => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) db.prepare("DELETE FROM sessions WHERE tokenHash = ?").run(sha256(token));
      setSessionCookie(req, res, "", 0);
      res.json({ ok: true });
    });

    app.get("/api/auth/me", (req, res) => {
      const ctx = authOf(req);
      const u = userRow(ctx.user.id);
      const capabilities = (["read", "stage", "import", "contacts.write", "post", "coa.write", "admin"] as Capability[]).filter((c) => roleCan(ctx.user.role, c));
      res.json({ user: publicUser(u), capabilities });
    });

    app.post("/api/auth/change-password", (req, res) => {
      const ctx = authOf(req);
      const u = userRow(ctx.user.id);
      if (!verifyPassword(String(req.body?.currentPassword ?? ""), u.passwordHash)) {
        return res.status(400).json({ error: "Current password is incorrect" });
      }
      const next = String(req.body?.newPassword ?? "");
      const problem = passwordProblem(next);
      if (problem) return res.status(400).json({ error: problem });
      if (verifyPassword(next, u.passwordHash)) return res.status(400).json({ error: "Choose a password different from the current one" });
      db.transaction(() => {
        db.prepare("UPDATE users SET passwordHash = ?, mustChangePassword = 0 WHERE id = ?").run(hashPassword(next), u.id);
        // Sign out every other session for this user.
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        db.prepare("DELETE FROM sessions WHERE userId = ? AND tokenHash <> ?").run(u.id, token ? sha256(token) : "");
      })();
      res.json({ user: publicUser(userRow(u.id)) });
    });

    // ---- user management (Admin; rule table enforces) ----
    app.get("/api/users", (_req, res) => {
      res.json((db.prepare("SELECT * FROM users ORDER BY lower(fullName)").all() as any[]).map(publicUser));
    });

    app.post("/api/users", (req, res) => {
      try {
        const fullName = String(req.body?.fullName ?? "").trim();
        const email = normalizeEmail(req.body?.email);
        const role = String(req.body?.role ?? "") as Role;
        const password = String(req.body?.password ?? "");
        if (!fullName) return res.status(400).json({ error: "Full name is required" });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "A valid email address is required" });
        if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}` });
        const problem = passwordProblem(password);
        if (problem) return res.status(400).json({ error: problem });
        const allEntities = role === "Admin" || !!req.body?.allEntities;
        const entityIds = allEntities ? [] : validEntityIds(req.body?.entityIds);
        if (!allEntities && entityIds.length === 0) return res.status(400).json({ error: "Give the user access to at least one entity, or All Entities" });
        const id = db.transaction(() => {
          const r = db.prepare(
            "INSERT INTO users (fullName, email, passwordHash, role, allEntities, mustChangePassword) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(fullName, email, hashPassword(password), role, allEntities ? 1 : 0, req.body?.mustChangePassword === false ? 0 : 1);
          const newId = Number(r.lastInsertRowid);
          const ins = db.prepare("INSERT INTO user_entities (userId, entityId) VALUES (?, ?)");
          for (const e of entityIds) ins.run(newId, e);
          return newId;
        })();
        res.json(publicUser(userRow(id)));
      } catch (err) {
        sendError(res, err, "Failed to create user");
      }
    });

    app.put("/api/users/:id", (req, res) => {
      try {
        const id = Number(req.params.id);
        const existing = userRow(id);
        if (!existing) return res.status(404).json({ error: "User not found" });
        const me = authOf(req).user;
        const fullName = req.body?.fullName !== undefined ? String(req.body.fullName).trim() : existing.fullName;
        const email = req.body?.email !== undefined ? normalizeEmail(req.body.email) : existing.email;
        const role = (req.body?.role !== undefined ? String(req.body.role) : existing.role) as Role;
        const status = req.body?.status !== undefined ? String(req.body.status) : existing.status;
        if (!fullName) return res.status(400).json({ error: "Full name is required" });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "A valid email address is required" });
        if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}` });
        if (!["Active", "Disabled"].includes(status)) return res.status(400).json({ error: "Status must be Active or Disabled" });
        // Never lock the organisation out of its own settings.
        const losesAdmin = existing.role === "Admin" && existing.status === "Active" && (role !== "Admin" || status !== "Active");
        if (losesAdmin && activeAdminCount(id) === 0) {
          return res.status(409).json({ error: "This is the last active Admin — promote someone else to Admin first" });
        }
        if (id === me.id && status !== "Active") return res.status(409).json({ error: "You can't disable your own account" });
        const allEntities = role === "Admin" || (req.body?.allEntities !== undefined ? !!req.body.allEntities : !!existing.allEntities);
        const entityIds = allEntities ? [] : (req.body?.entityIds !== undefined ? validEntityIds(req.body.entityIds) : [...contextFor(existing).entityIds]);
        if (!allEntities && entityIds.length === 0) return res.status(400).json({ error: "Give the user access to at least one entity, or All Entities" });
        db.transaction(() => {
          db.prepare("UPDATE users SET fullName = ?, email = ?, role = ?, status = ?, allEntities = ? WHERE id = ?")
            .run(fullName, email, role, status, allEntities ? 1 : 0, id);
          db.prepare("DELETE FROM user_entities WHERE userId = ?").run(id);
          const ins = db.prepare("INSERT INTO user_entities (userId, entityId) VALUES (?, ?)");
          for (const e of entityIds) ins.run(id, e);
          // Disabling ends every session immediately.
          if (status !== "Active") db.prepare("DELETE FROM sessions WHERE userId = ?").run(id);
        })();
        res.json(publicUser(userRow(id)));
      } catch (err) {
        sendError(res, err, "Failed to update user");
      }
    });

    // Admin sets a new temporary password; the user must change it at next sign-in.
    app.post("/api/users/:id/reset-password", (req, res) => {
      const id = Number(req.params.id);
      const u = userRow(id);
      if (!u) return res.status(404).json({ error: "User not found" });
      const password = String(req.body?.password ?? "");
      const problem = passwordProblem(password);
      if (problem) return res.status(400).json({ error: problem });
      db.transaction(() => {
        db.prepare("UPDATE users SET passwordHash = ?, mustChangePassword = 1 WHERE id = ?").run(hashPassword(password), id);
        db.prepare("DELETE FROM sessions WHERE userId = ?").run(id);
      })();
      res.json(publicUser(userRow(id)));
    });

    // Housekeeping: purge expired sessions hourly.
    setInterval(() => db.prepare("DELETE FROM sessions WHERE expiresAt <= ?").run(Date.now()), 60 * 60 * 1000).unref();
  }

  return { gate, registerRoutes };
}
