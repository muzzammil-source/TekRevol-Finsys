// Chart of Accounts hierarchy helpers (2026-09-16).
//
// Accounts carry an optional `parentId`. The server guarantees a parent has
// the same statutory type and compatible ownership, with no cycles; these
// helpers only arrange rows for display.

export const STATUTORY_TYPE_ORDER = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;

export type TreeRow<T> = { account: T; depth: number; hasChildren: boolean; path: string[] };

type AccountLike = { id: number; code: string; name: string; type: string; parentId?: number | null };

const typeRank = (t: string) => {
  const i = (STATUTORY_TYPE_ORDER as readonly string[]).indexOf(t);
  return i === -1 ? STATUTORY_TYPE_ORDER.length : i;
};

const byTypeThenCode = (a: AccountLike, b: AccountLike) =>
  typeRank(a.type) - typeRank(b.type) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true });

function childrenIndex<T extends AccountLike>(accounts: T[]): Map<number | null, T[]> {
  const ids = new Set(accounts.map((a) => a.id));
  const index = new Map<number | null, T[]>();
  for (const a of accounts) {
    // A parent outside the given set (e.g. filtered away) makes the row a root.
    const key = a.parentId != null && ids.has(a.parentId) ? a.parentId : null;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(a);
  }
  for (const list of index.values()) list.sort(byTypeThenCode);
  return index;
}

/** Depth-first ordering: statutory type order, then code; children directly under their parent. */
export function buildAccountTree<T extends AccountLike>(accounts: T[]): TreeRow<T>[] {
  const index = childrenIndex(accounts);
  const out: TreeRow<T>[] = [];
  const visited = new Set<number>();
  const walk = (parentKey: number | null, depth: number, path: string[]) => {
    for (const a of index.get(parentKey) ?? []) {
      if (visited.has(a.id)) continue; // defensive: never loop on bad data
      visited.add(a.id);
      const kids = index.get(a.id) ?? [];
      out.push({ account: a, depth, hasChildren: kids.length > 0, path });
      walk(a.id, depth + 1, [...path, a.name]);
    }
  };
  walk(null, 0, []);
  // Anything unreachable (only possible with corrupt cyclic data) still shows.
  for (const a of accounts) if (!visited.has(a.id)) out.push({ account: a, depth: 0, hasChildren: false, path: [] });
  return out;
}

/** Ids of every descendant of `accountId` (not including itself). */
export function descendantIds<T extends AccountLike>(accounts: T[], accountId: number): Set<number> {
  const index = childrenIndex(accounts);
  const out = new Set<number>();
  const stack = [...(index.get(accountId) ?? [])];
  while (stack.length) {
    const a = stack.pop()!;
    if (out.has(a.id)) continue;
    out.add(a.id);
    stack.push(...(index.get(a.id) ?? []));
  }
  return out;
}

/** Ancestor names from the root down, e.g. ["Operating Expenses", "Payroll"]. */
export function ancestorPath<T extends AccountLike>(accounts: T[], accountId: number): string[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const path: string[] = [];
  const seen = new Set<number>();
  let cursor = byId.get(accountId)?.parentId ?? null;
  while (cursor != null && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    path.unshift(parent.name);
    cursor = parent.parentId ?? null;
  }
  return path;
}
