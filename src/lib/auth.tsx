import React, { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_EVENT, useLogout, useMe, type AppUser, type Capability, type Role } from '@workspace/api-client-react';

// Client-side auth state (2026-09-17).
//
// The session lives in an httpOnly cookie set by the server; this context
// only mirrors "who is signed in and what may they do" from GET /api/auth/me
// so the UI can hide/disable what the role can't use. It is NOT the security
// boundary — server/auth.ts enforces every rule, so a hidden button that is
// forced back on still gets a 403.

type AuthState = {
  user: AppUser;
  role: Role;
  capabilities: ReadonlySet<Capability>;
  can: (cap: Capability) => boolean;
  /** Auditor: may look, may not change anything. */
  isReadOnly: boolean;
  /** True for Admins and users granted All Entities. */
  allEntities: boolean;
  entityIds: number[];
  canAccessEntity: (entityId: number | null | undefined) => boolean;
  /** Re-read /api/auth/me (e.g. after an admin edits their own user). */
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

/**
 * Call after sign-in / sign-out / setup. Drops every cached query except the
 * auth ones (so one user never sees another's data), then force-refetches
 * the auth queries so the gate re-renders. NOT queryClient.clear(): that
 * also removes the auth queries while their observers stay mounted, and the
 * gate keeps showing its last (signed-out) value.
 */
export async function resetSessionQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
  await queryClient.invalidateQueries({ queryKey: ['auth'], refetchType: 'all' });
}

export function AuthProvider({ user, capabilities, children }: { user: AppUser; capabilities: Capability[]; children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const logoutMutation = useLogout();

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ['auth'] }), [queryClient]);
  const logout = useCallback(async () => {
    try { await logoutMutation.mutateAsync(); } finally {
      // Drop every cached query so the next user never sees this user's data.
      await resetSessionQueries(queryClient);
    }
  }, [logoutMutation, queryClient]);

  const value = useMemo<AuthState>(() => {
    const caps = new Set(capabilities);
    const allEntities = user.role === 'Admin' || user.allEntities;
    const ids = new Set(user.entityIds);
    return {
      user,
      role: user.role,
      capabilities: caps,
      can: (cap) => caps.has(cap),
      isReadOnly: !caps.has('stage') && !caps.has('contacts.write') && !caps.has('coa.write') && !caps.has('post'),
      allEntities,
      entityIds: user.entityIds,
      canAccessEntity: (id) => allEntities || (id != null && ids.has(Number(id))),
      refresh,
      logout,
    };
  }, [user, capabilities, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Re-checks the session whenever any API call reports it is gone. */
export function useAuthEventListener() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const onChange = () => queryClient.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener(AUTH_EVENT, onChange);
    return () => window.removeEventListener(AUTH_EVENT, onChange);
  }, [queryClient]);
}

export { useMe };

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  Admin: 'Everything, across all entities — including settings, users and period closing.',
  Manager: 'Banking, sub-ledgers, Chart of Accounts and reports. Can post to the ledger.',
  Bookkeeper: 'Prepares bank transactions (categorize, split, From/To) and saves them for review. Cannot post or change the Chart of Accounts.',
  Auditor: 'Read-only access to everything in their entities.',
};

export function NoAccess({ what = 'this page' }: { what?: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="max-w-sm rounded-2xl border border-gray-100 bg-white p-6 text-center shadow-sm">
        <div className="text-sm font-semibold text-gray-900">You don't have access to {what}</div>
        <div className="mt-1 text-xs text-gray-500">Ask an Admin if you need it.</div>
      </div>
    </div>
  );
}
