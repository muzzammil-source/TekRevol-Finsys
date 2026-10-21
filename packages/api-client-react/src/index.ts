import { useQuery, useMutation } from '@tanstack/react-query';

const BASE = '/api';

export type ApiError = Error & { status?: number; code?: string };

// Fired when the server says the session is gone (401) or a temporary
// password must be changed first — the AuthProvider listens and re-checks
// who is signed in, which swaps the app for the sign-in screen.
export const AUTH_EVENT = 'finsys:auth-changed';

async function apiFetch(path: string, opts?: RequestInit) {
  // Same-origin session cookie (httpOnly) — sent explicitly for clarity.
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    // Server routes answer errors as { error: "human-readable reason" };
    // surface that sentence (it's written for the user) instead of the raw
    // JSON body. Anything else keeps the old diagnostic format.
    let reason: string | undefined;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text);
      // Most routes answer { error }; the Plaid routes answer { message,
      // errorCode } (Plaid's own wording and code) — surface either.
      if (parsed && typeof parsed.error === 'string') reason = parsed.error;
      else if (parsed && typeof parsed.message === 'string') reason = parsed.message;
      if (parsed && typeof parsed.code === 'string') code = parsed.code;
      else if (parsed && typeof parsed.errorCode === 'string') code = parsed.errorCode;
    } catch { /* not JSON */ }
    const error = new Error(reason ?? `API ${path}: ${res.status} ${text}`) as ApiError;
    error.status = res.status;
    error.code = code;
    if (typeof window !== 'undefined' && !path.startsWith('/auth/') && (res.status === 401 || code === 'PASSWORD_CHANGE_REQUIRED')) {
      window.dispatchEvent(new Event(AUTH_EVENT));
    }
    throw error;
  }
  return res.json();
}

// ===== AUTH & USERS (RBAC, 2026-09-17) =====
export type Role = 'Admin' | 'Manager' | 'Bookkeeper' | 'Auditor';
export type Capability = 'read' | 'stage' | 'import' | 'contacts.write' | 'post' | 'coa.write' | 'admin';
export type AppUser = {
  id: number;
  fullName: string;
  email: string;
  role: Role;
  status: 'Active' | 'Disabled';
  allEntities: boolean;
  entityIds: number[];
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

export function useAuthStatus() {
  return useQuery<{ needsSetup: boolean }>({ queryKey: ['auth', 'status'], queryFn: () => apiFetch('/auth/status'), retry: false });
}

/** Resolves to null when not signed in (401), instead of erroring. */
export function useMe() {
  return useQuery<{ user: AppUser; capabilities: Capability[] } | null>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        return await apiFetch('/auth/me');
      } catch (err) {
        if ((err as ApiError).status === 401) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

const jsonPost = (path: string, body?: unknown, method = 'POST') =>
  apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export function useLogin() {
  return useMutation({ mutationFn: (data: { email: string; password: string }) => jsonPost('/auth/login', data) });
}
export function useBootstrapAdmin() {
  return useMutation({ mutationFn: (data: { fullName: string; email: string; password: string }) => jsonPost('/auth/bootstrap', data) });
}
export function useLogout() {
  return useMutation({ mutationFn: () => jsonPost('/auth/logout') });
}
export function useChangePassword() {
  return useMutation({ mutationFn: (data: { currentPassword: string; newPassword: string }) => jsonPost('/auth/change-password', data) });
}
/** Always resolves, whether or not the address has an account — by design. */
export function useRequestPasswordReset() {
  return useMutation({ mutationFn: (data: { email: string }) => jsonPost('/auth/forgot-password', data) });
}
/** Consumes a reset token and signs the user in with the new password. */
export function useResetPassword() {
  return useMutation({ mutationFn: (data: { token: string; password: string }) => jsonPost('/auth/reset-password', data) });
}

export const getListUsersQueryKey = () => ['users'];
export function useListUsers(opts?: QueryOpts) {
  return useQuery<AppUser[]>({ queryKey: getListUsersQueryKey(), queryFn: () => apiFetch('/users'), enabled: opts?.query?.enabled ?? true });
}
export function useCreateUser() {
  return useMutation({
    mutationFn: (data: { fullName: string; email: string; password: string; role: Role; allEntities: boolean; entityIds: number[] }) => jsonPost('/users', data) as Promise<AppUser>,
  });
}
export function useUpdateUser() {
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number; fullName?: string; email?: string; role?: Role; allEntities?: boolean; entityIds?: number[]; status?: 'Active' | 'Disabled' }) =>
      jsonPost(`/users/${id}`, data, 'PUT') as Promise<AppUser>,
  });
}
export function useResetUserPassword() {
  return useMutation({ mutationFn: ({ id, password }: { id: number; password: string }) => jsonPost(`/users/${id}/reset-password`, { password }) as Promise<AppUser> });
}

// Save for review: a Bookkeeper's categorization, stored on the pending
// transaction for a Manager/Admin to post. `clear: true` discards it.
export type StagedCategorization = {
  accountId?: number | null;
  chargedToEntityId?: number | null;
  contactId?: number | null;
  splits?: { accountId: number | null; entityId: number | null; contactId: number | null; amount: number | null }[] | null;
};
export function useStageBankTransaction() {
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number; clear?: boolean } & StagedCategorization) => jsonPost(`/bank-transactions/${id}/stage`, data, 'PUT'),
  });
}

function qs(params: Record<string, any>) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
}

type QueryOpts = { query?: { queryKey?: any[]; enabled?: boolean } };

// ===== ACCOUNTS =====
export const getListAccountsQueryKey = (params?: any) => ['accounts', params];

export function useListAccounts(params?: { type?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getListAccountsQueryKey(params),
    queryFn: () => apiFetch(`/accounts${qs(params ?? {})}`),
  });
}

export function useCreateAccount() {
  return useMutation({
    mutationFn: ({ data }: { data: any }) =>
      apiFetch('/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useUpdateAccount() {
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      apiFetch(`/accounts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) => apiFetch(`/accounts/${id}`, { method: 'DELETE' }),
  });
}

export function useBulkImportAccounts() {
  return useMutation({
    mutationFn: ({ rows }: { rows: any[] }) =>
      apiFetch('/accounts/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) }),
  });
}

export function useBulkDeleteAccounts() {
  return useMutation({
    mutationFn: ({ ids }: { ids: number[] }) =>
      apiFetch('/accounts/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }),
  });
}

export function useListAccountBalances(params?: { asOfDate?: string; currency?: string; entityId?: number }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['account-balances', params],
    queryFn: () => apiFetch(`/accounts/balances${qs(params ?? {})}`),
  });
}

export function useAccountRegister(accountId: number | null, opts?: QueryOpts, entityId?: number) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['account-register', accountId, entityId ?? null],
    queryFn: () => apiFetch(`/accounts/${accountId}/register${qs({ entityId })}`),
    enabled: (opts?.query?.enabled ?? true) && !!accountId,
  });
}

// ===== CONTACTS (Customer / Vendor sub-ledger) =====
export type ContactType = 'Customer' | 'Vendor';
export type Contact = {
  id: number;
  name: string;
  contactType: ContactType;
  entityId: number | null;
  email: string;
  /** Customers only ('' for vendors). */
  projectName: string;
  isActive: number;
  receivedUSD: number;
  paidUSD: number;
  /** Current Balance: open AR (customer) / AP (vendor) position, USD. */
  /** Running balance over every tagged posted line: Customer Dr−Cr, Vendor Cr−Dr. */
  outstandingUSD: number;
  /** The subset on Receivables / Payables heads — ties to the AR/AP control account. */
  openArApUSD: number;
  postedLineCount: number;
  lastActivityDate: string | null;
  /** Read back from the opening-balance journal entry (native currency). */
  openingBalance: number | null;
  openingBalanceCurrency: string | null;
  openingBalanceDate: string | null;
  openingBalanceEntryId: number | null;
};

/** Aging buckets, USD. Keys are days past due, not calendar months. */
export type AgingBuckets = { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
export type SubledgerItem = { contactId: number | null; contactName: string; contactType: ContactType | null; balanceUSD: number; lineCount: number; lastActivityDate: string; aging: AgingBuckets };
export type Subledger = {
  account: { id: number; code: string; name: string; type: string; category: string };
  entityId: number | null;
  asOfDate: string;
  /** Days added to each charge's date before it counts as overdue (0 = none configured). */
  netTermsDays: number;
  items: SubledgerItem[];
  controlBalanceUSD: number;
  itemsTotalUSD: number;
  agingTotals: AgingBuckets;
  /** False when the buckets don't add back to the open balance — the report says so rather than hiding it. */
  agingReconciles: boolean;
  reconciles: boolean;
};

export type IntercompanyCell = {
  ownerEntityId: number; ownerName: string;
  counterpartyEntityId: number; counterpartyName: string;
  receivableUSD: number; payableUSD: number; netUSD: number;
  /** What the other side's books say, which should be this cell negated. */
  mirrorNetUSD: number; difference: number; reciprocal: boolean;
  accounts: { accountId: number; code: string; name: string; type: string; balanceUSD: number }[];
};
export type IntercompanyBalances = {
  asOfDate: string;
  entities: { id: number; name: string; functionalCurrency: string }[];
  cells: IntercompanyCell[];
  mismatches: { entityAId: number; entityAName: string; entityBId: number; entityBName: string; aSaysUSD: number; bSaysUSD: number; differenceUSD: number }[];
  groupNetUSD: number;
  /** True when the group's intercompany positions cancel out, as they must on consolidation. */
  eliminates: boolean;
};

// AR / AP control account broken down by customer / vendor (drill-down),
// with aging buckets. netTermsDays shifts when a charge counts as overdue.
export function useSubledger(params: { accountId: number | null; entityId?: number; asOfDate?: string; netTermsDays?: number }) {
  return useQuery<Subledger>({
    queryKey: ['subledger', params],
    queryFn: () => apiFetch(`/reports/subledger${qs(params)}`),
    enabled: !!params.accountId,
  });
}

// Prefix key (no undefined tail) so invalidating ['contacts'] refreshes every
// filtered list and ledger.
export const getListContactsQueryKey = (params?: { entityId?: number; type?: ContactType; includeInactive?: boolean }) =>
  params ? ['contacts', params] : ['contacts'];

export function useListContacts(params?: { entityId?: number; type?: ContactType; includeInactive?: boolean }, opts?: QueryOpts) {
  return useQuery<Contact[]>({
    queryKey: opts?.query?.queryKey ?? getListContactsQueryKey(params),
    queryFn: () => apiFetch(`/contacts${qs({ ...(params ?? {}), includeInactive: params?.includeInactive ? 'true' : undefined })}`),
    enabled: opts?.query?.enabled ?? true,
  });
}

export type ContactLedgerLine = {
  lineId: number;
  journalEntryId: number;
  entryNumber: string;
  transactionDate: string;
  entityId: number;
  entityName: string | null;
  accountCode: string;
  accountName: string;
  accountCategory: string;
  debit: number;
  credit: number;
  currency: string;
  exchangeRate: number;
  debitUSD: number;
  creditUSD: number;
  description: string;
  /** Line on a Receivables (customer) / Payables (vendor) account — moves the balance. */
  /** Kept for older clients — every tagged line now moves the balance. */
  affectsBalance: boolean;
  /** This line sits on a Receivables / Payables head (the open A/R–A/P subset). */
  onArAp: boolean;
  /** Signed movement this line applied to the running balance, in USD. */
  deltaUSD: number;
  runningBalanceUSD: number;
};
export type ContactLedger = { contact: Contact; lines: ContactLedgerLine[] };

/** Non-hook fetch for one-off work such as exporting many ledgers at once. */
export function fetchContactLedger(contactId: number): Promise<ContactLedger> {
  return apiFetch(`/contacts/${contactId}/ledger`);
}

export function useContactLedger(contactId: number | null) {
  return useQuery({
    queryKey: ['contacts', 'ledger', contactId],
    queryFn: () => apiFetch(`/contacts/${contactId}/ledger`),
    enabled: !!contactId,
  });
}

export function useCreateContact() {
  return useMutation({
    mutationFn: (data: { name: string; contactType: ContactType; entityId: number | null; email?: string; projectName?: string; openingBalance?: number; openingBalanceDate?: string }) =>
      apiFetch('/contacts',{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) as Promise<Contact>,
  });
}

export function useUpdateContact() {
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; contactType?: ContactType; entityId?: number | null; email?: string; projectName?: string; isActive?: boolean; openingBalance?: number; openingBalanceDate?: string }) =>
      apiFetch(`/contacts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) as Promise<Contact>,
  });
}

export function useDeleteContact() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) => apiFetch(`/contacts/${id}`, { method: 'DELETE' }),
  });
}

// ===== EXCHANGE RATES =====
export const getListExchangeRatesQueryKey = (params?: any) => ['exchange-rates', params];

export function useListExchangeRates(params?: { month?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getListExchangeRatesQueryKey(params),
    queryFn: () => apiFetch(`/exchange-rates${qs(params ?? {})}`),
  });
}

export function useUpsertExchangeRate() {
  return useMutation({
    mutationFn: ({ data }: { data: any }) =>
      apiFetch('/exchange-rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useDeleteExchangeRate() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) => apiFetch(`/exchange-rates/${id}`, { method: 'DELETE' }),
  });
}

// ===== INTERCOMPANY TRANSACTIONS =====
export const getListIntercompanyTransactionsQueryKey = (params?: any) => ['intercompany-transactions', params];

export function useListIntercompanyTransactions(params?: { month?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getListIntercompanyTransactionsQueryKey(params),
    queryFn: () => apiFetch(`/intercompany-transactions${qs(params ?? {})}`),
  });
}

export function useCreateIntercompanyTransaction() {
  return useMutation({
    mutationFn: ({ data }: { data: any }) =>
      apiFetch('/intercompany-transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useUpdateIntercompanyTransaction() {
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      apiFetch(`/intercompany-transactions/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useDeleteIntercompanyTransaction() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) => apiFetch(`/intercompany-transactions/${id}`, { method: 'DELETE' }),
  });
}

// ===== ENTITIES / BRANDS (Phase 1.1 GL — numeric ids, distinct from the
// string entity codes in src/lib/constants.ts) =====
export function useListEntities(opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['entities'],
    queryFn: () => apiFetch('/entities'),
  });
}

export const getListEntitiesQueryKey = () => ['entities'];

export function useCreateEntity() {
  return useMutation({
    mutationFn: ({ data }: { data: any }) =>
      apiFetch('/entities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useUpdateEntity() {
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      apiFetch(`/entities/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useDeleteEntity() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) => apiFetch(`/entities/${id}`, { method: 'DELETE' }),
  });
}

export function useListBrands(params?: { entityId?: number }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['brands', params],
    queryFn: () => apiFetch(`/brands${qs(params ?? {})}`),
  });
}

// ===== JOURNAL ENTRIES (read-only GL drill-down) =====
// ---- Split rules (reusable multi-entity percentage templates) ----
export type SplitRuleLine = { id: number; ruleId: number; entityId: number; entityName: string; percent: number; sortOrder: number };
export type SplitRule = { id: number; name: string; description: string; isActive: number; createdAt: string; lines: SplitRuleLine[] };

export const getListSplitRulesQueryKey = () => ['split-rules'];

export function useListSplitRules(opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getListSplitRulesQueryKey(),
    queryFn: () => apiFetch('/split-rules') as Promise<SplitRule[]>,
  });
}

type SplitRuleInput = { name: string; description?: string; lines: { entityId: number; percent: number }[] };

export function useCreateSplitRule() {
  return useMutation({
    mutationFn: (data: SplitRuleInput) =>
      apiFetch('/split-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) as Promise<SplitRule>,
  });
}

export function useUpdateSplitRule() {
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<SplitRuleInput> & { id: number; isActive?: boolean }) =>
      apiFetch(`/split-rules/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) as Promise<SplitRule>,
  });
}

export function useDeleteSplitRule() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) => apiFetch(`/split-rules/${id}`, { method: 'DELETE' }),
  });
}

export type ResolvedRate = { currency: string; date: string; period: string; rate: number; found: boolean; source: string; effectiveMonth?: string };

/** Non-hook lookup, for forms that resolve a rate per line as currencies change. */
export function fetchExchangeRate(currency: string, date: string): Promise<ResolvedRate> {
  return apiFetch(`/exchange-rates/resolve${qs({ currency, date })}`) as Promise<ResolvedRate>;
}

/** The rate a posting would use for this currency on this date (pre-fills the JE form). */
export function useResolveExchangeRate(currency: string, date: string, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['exchange-rate-resolve', currency, date],
    queryFn: () => apiFetch(`/exchange-rates/resolve${qs({ currency, date })}`) as Promise<ResolvedRate>,
    enabled: (opts?.query?.enabled ?? true) && !!currency && !!date,
  });
}

/** Manual journal entry — posts one balanced entry per entity on the sheet. */
export function useCreateJournalEntry() {
  return useMutation({
    mutationFn: (data: {
      transactionDate: string;
      reference?: string;
      description?: string;
      /** `debit`/`credit` are NATIVE amounts in `currency`; balancing is on the converted USD. */
      lines: { accountId: number; entityId: number; debit: number; credit: number; description?: string; currency?: string; exchangeRate?: number }[];
    }) => apiFetch('/journal-entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) as Promise<{ ok: boolean; journalEntries: any[]; entryNumbers: string[] }>,
  });
}

export function useListJournalEntries(params?: { entityId?: number; brandId?: number; status?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['journal-entries', params],
    queryFn: () => apiFetch(`/journal-entries${qs(params ?? {})}`),
  });
}

// ===== BANK ACCOUNTS (Phase 1.2 GL staging — distinct from the legacy
// /plaid/* connections below) =====
// Called with no args this is a PREFIX (['bank-accounts']), so the existing
// `invalidateQueries({ queryKey: getListBankAccountsQueryKey() })` calls keep
// matching every variant of the query — including the currency-scoped ones
// the Bank Hub's Global Currency Switcher creates (2026-09-11). A literal
// ['bank-accounts', undefined] would NOT partial-match ['bank-accounts',
// { currency: 'AED' }], so those invalidations would silently stop working.
export const getListBankAccountsQueryKey = (params?: any) =>
  params === undefined ? ['bank-accounts'] : ['bank-accounts', params];

export function useListBankAccounts(params?: { entityId?: number; currency?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getListBankAccountsQueryKey(params),
    queryFn: () => apiFetch(`/bank-accounts${qs(params ?? {})}`),
  });
}

// COA-driven Banking Hub (2026-09-11): the card list comes from the Chart
// of Accounts, not from bank_accounts. Shares the ['bank-accounts'] key
// prefix so the hub's existing invalidations refresh the cards too.
export function useBankingCards(params?: { currency?: string; entityId?: number }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['bank-accounts', 'cards', params],
    queryFn: () => apiFetch(`/banking/cards${qs(params ?? {})}`),
  });
}

export function useEnsureBankFeed() {
  return useMutation({
    mutationFn: ({ accountId, entityId }: { accountId: number; entityId?: number }) =>
      apiFetch('/banking/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, entityId }),
      }),
  });
}

export function useCreateBankAccount() {
  return useMutation({
    mutationFn: ({ data }: { data: any }) =>
      apiFetch('/bank-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

/** Rename or re-assign a bank feed (the server refuses to move one that has posted lines). */
export function useUpdateBankAccount() {
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      apiFetch(`/bank-accounts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useRefreshBankAccountBalance() {
  return useMutation({
    mutationFn: ({ bankAccountId }: { bankAccountId: number }) =>
      apiFetch(`/bank-accounts/${bankAccountId}/refresh-balance`, { method: 'POST' }),
  });
}

// ===== BANK TRANSACTIONS (Phase 1.2/1.3 GL staging + posting engine) =====
// Bare call returns a PREFIX so `invalidateQueries` matches every
// parameterised variant. `['bank-transactions', undefined]` would NOT
// partial-match `['bank-transactions', { bankAccountId: 1 }]`, so once the
// Banking Hub started scoping these queries by bank account, posting would
// have silently stopped refreshing the visible list.
export const getListBankTransactionsQueryKey = (params?: any) =>
  params === undefined ? ['bank-transactions'] : ['bank-transactions', params];

// `enabled` is forwarded so a caller can hold the query until it knows
// which bank account to scope to — without it the hook fired once
// unscoped and then again scoped, briefly showing every account's
// transactions. The queryKey already carries `params`, so changing the
// bank account refetches on its own; no manual dependency array needed.
export function useListBankTransactions(params?: { bankAccountId?: number; status?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getListBankTransactionsQueryKey(params),
    queryFn: () => apiFetch(`/bank-transactions${qs(params ?? {})}`),
    enabled: opts?.query?.enabled ?? true,
  });
}

export const getUnpostedBankTransactionsQueryKey = (params?: any) =>
  params === undefined ? ['bank-transactions-unposted'] : ['bank-transactions-unposted', params];

export function useUnpostedBankTransactions(params?: { bankAccountId?: number }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getUnpostedBankTransactionsQueryKey(params),
    queryFn: () => apiFetch(`/bank-transactions/unposted${qs(params ?? {})}`),
    enabled: opts?.query?.enabled ?? true,
  });
}

export function useUnpostBankTransaction() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) => apiFetch(`/bank-transactions/${id}/unpost`, { method: 'POST' }),
  });
}

export function usePostBankTransaction() {
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: { id: number; accountId?: number; entityId?: number; brandId?: number; postingDate?: string; description?: string; reference?: string; chargedToEntityId?: number | null; accountingPeriod?: string | null; contactId?: number | null }) =>
      apiFetch(`/bank-transactions/${id}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
  });
}

export type CrossBrandSplitLine = {
  accountId: number;
  /** Optional Payee / Contact, validated against the line's charged-to entity. */
  contactId?: number | null;
  /** Charged-to entity for the line (brand is derived server-side). */
  entityId?: number;
  brandId?: number;
  percentage?: number;
  amount?: number;
  effectiveStartMonth?: string;
  effectiveEndMonth?: string;
};

export function usePostBankTransactionSplit() {
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: { id: number; splits: CrossBrandSplitLine[]; postingDate?: string; description?: string; reference?: string }) =>
      apiFetch(`/bank-transactions/${id}/post-split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
  });
}

/**
 * Undoes several postings at once — all or nothing. If any row is refused
 * (reconciled, locked period, not yours) nothing is written and the error
 * names it, so the ledger is never left half-undone.
 */
export function useBulkUnpostBankTransactions() {
  return useMutation({
    mutationFn: ({ ids }: { ids: number[] }) =>
      jsonPost('/bank-transactions/bulk-unpost', { ids }) as Promise<{
        unposted: number;
        removedJournalEntryCount: number;
        items: { bankTransactionId: number; removedJournalEntryIds: number[] }[];
      }>,
  });
}

/**
 * Reverses a POSTED manual journal entry (JV) by posting its mirror image —
 * both the original and the reversal stay in the books, which is how a
 * posted entry is corrected (the ledger is a book of record; see
 * server/index.ts).
 *
 * Manual JVs only. Bank-feed postings, bills, invoices and imports are
 * refused server-side with the screen that owns them, because each of those
 * has something alongside the entry that must move with it.
 */
/**
 * One journal entry with its lines — read on demand when the JV screen
 * pre-fills a correction. Not a hook: it is fetched in response to a click,
 * not rendered from, so a query would only add a cache entry nothing reads.
 */
export function fetchJournalEntry(id: number): Promise<JournalEntryDetail> {
  return apiFetch(`/journal-entries/${id}`) as Promise<JournalEntryDetail>;
}

export type JournalEntryDetail = {
  id: number;
  entryNumber: string;
  entityId: number;
  brandId: number | null;
  transactionDate: string;
  description: string;
  reference: string;
  status: string;
  source: string;
  lines: {
    id: number;
    accountId: number;
    code: string;
    accountName: string;
    accountEntityId: number | null;
    debit: number;
    credit: number;
    currency: string;
    exchangeRate: number;
    memo: string;
  }[];
};

export function useReverseJournalEntry() {
  return useMutation({
    mutationFn: ({ id, reversalDate, memo }: { id: number; reversalDate?: string; memo?: string }) =>
      jsonPost(`/journal-entries/${id}/reverse`, { reversalDate, memo }) as Promise<{
        reversed: true;
        originalEntryId: number;
        reversalEntryId: number;
        reversalEntryNumber: string;
      }>,
  });
}

/**
 * Deletes a DRAFT manual journal entry outright — it was never in the
 * books. A posted one is refused with a pointer to
 * `useReverseJournalEntry`, and a non-manual entry with the screen that
 * owns it.
 */
export function useDeleteJournalEntry() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) =>
      apiFetch(`/journal-entries/${id}`, { method: 'DELETE' }) as Promise<{
        deleted: true;
        entryId: number;
        entryNumber: string;
      }>,
  });
}

/**
 * Dismisses pending feed rows (status → IGNORED). Rows already posted are
 * refused server-side and come back in `skipped`, so a stale selection can
 * never detach a transaction from its journal entry.
 */
export function useBulkIgnoreBankTransactions() {
  return useMutation({
    mutationFn: ({ ids }: { ids: number[] }) =>
      jsonPost('/bank-transactions/bulk-ignore', { ids }) as Promise<{
        ignored: number;
        ignoredIds: number[];
        skipped: { id: number; reason: string }[];
      }>,
  });
}

export function useBulkPostBankTransactions() {
  return useMutation({
    mutationFn: ({ items }: { items: { bankTransactionId: number; accountId?: number; entityId?: number; brandId?: number; chargedToEntityId?: number; contactId?: number | null }[] }) =>
      apiFetch('/bank-transactions/bulk-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      }),
  });
}

export function useImportBankStatement() {
  return useMutation({
    mutationFn: ({ bankAccountId, file, columnMapping }: { bankAccountId: number; file: File; columnMapping?: any }) => {
      const formData = new FormData();
      formData.append('statement', file);
      formData.append('bankAccountId', String(bankAccountId));
      if (columnMapping) formData.append('columnMapping', JSON.stringify(columnMapping));
      return apiFetch('/bank-transactions/import', { method: 'POST', body: formData });
    },
  });
}

export function useSyncPlaidBankAccount() {
  return useMutation({
    mutationFn: ({ bankAccountId }: { bankAccountId: number }) =>
      apiFetch('/bank-transactions/plaid-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankAccountId }),
      }),
  });
}

// ===== CATEGORIZATION RULES (Phase 1.3) =====
export function useListCategorizationRules(opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['categorization-rules'],
    queryFn: () => apiFetch('/categorization-rules'),
  });
}

// ===== RECONCILIATION (Phase 1.5) =====
export const getListReconciliationsQueryKey = (params?: any) => ['reconciliations', params];

export function useListReconciliations(params?: { bankAccountId?: number; status?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getListReconciliationsQueryKey(params),
    queryFn: () => apiFetch(`/reconciliations${qs(params ?? {})}`),
  });
}

export const getReconciliationQueryKey = (id?: number) => ['reconciliation', id];

export function useGetReconciliation(id?: number, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? getReconciliationQueryKey(id),
    queryFn: () => apiFetch(`/reconciliations/${id}`),
    enabled: opts?.query?.enabled ?? Boolean(id),
  });
}

export function useCreateReconciliation() {
  return useMutation({
    mutationFn: ({ data }: { data: any }) =>
      apiFetch('/reconciliations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

export function useAutoMatchReconciliation() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) => apiFetch(`/reconciliations/${id}/auto-match`, { method: 'POST' }),
  });
}

export function useAddReconciliationMatch() {
  return useMutation({
    mutationFn: ({ id, bankTransactionId, journalLineId }: { id: number; bankTransactionId?: number; journalLineId?: number }) =>
      apiFetch(`/reconciliations/${id}/matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankTransactionId, journalLineId }),
      }),
  });
}

export function useDeleteReconciliationMatch() {
  return useMutation({
    mutationFn: ({ id, matchId }: { id: number; matchId: number }) =>
      apiFetch(`/reconciliations/${id}/matches/${matchId}`, { method: 'DELETE' }),
  });
}

export function useCompleteReconciliation() {
  return useMutation({
    mutationFn: ({ id, reconciledBy }: { id: number; reconciledBy?: string }) =>
      apiFetch(`/reconciliations/${id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reconciledBy }),
      }),
  });
}

export function useReconciliationStatus(
  params?: { reconciliationId?: number; bankAccountId?: number; statementStartDate?: string; statementEndDate?: string; statementEndingBalance?: number },
  opts?: QueryOpts,
) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['reconciliation-status', params],
    queryFn: () => apiFetch(`/reconciliation/status${qs(params ?? {})}`),
    enabled: opts?.query?.enabled ?? Boolean(params?.reconciliationId || (params?.bankAccountId && params?.statementEndDate)),
  });
}

// ===== ACCOUNTING PERIODS (Phase 1.5 period locking) =====
export function useListAccountingPeriods(params?: { entityId?: number }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['accounting-periods', params],
    queryFn: () => apiFetch(`/accounting-periods${qs(params ?? {})}`),
  });
}

export function useLockPeriod() {
  return useMutation({
    mutationFn: ({ entityId, periodMonth, lockedBy }: { entityId: number; periodMonth: string; lockedBy?: string }) =>
      apiFetch('/reconciliation/lock-period', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, periodMonth, lockedBy }),
      }),
  });
}

// ===== LEGAL FINANCIAL STATEMENTS (Phase 1.6) =====
export function useIncomeStatement(
  params: { entityId?: number; brandId?: number; startDate: string; endDate: string; currency?: string },
  opts?: QueryOpts,
) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['income-statement', params],
    queryFn: () => apiFetch(`/reports/income-statement${qs(params)}`),
    enabled: opts?.query?.enabled ?? Boolean(params.startDate && params.endDate),
  });
}

export function useBalanceSheet(params: { entityId?: number; asOfDate: string; currency?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['balance-sheet', params],
    queryFn: () => apiFetch(`/reports/balance-sheet${qs(params)}`),
    enabled: opts?.query?.enabled ?? Boolean(params.asOfDate),
  });
}

export function useTrialBalance(params: { entityId?: number; startDate?: string; endDate?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['trial-balance', params],
    queryFn: () => apiFetch(`/reports/trial-balance${qs(params)}`),
  });
}

export function useGeneralLedger(
  params: { entityId?: number; accountId?: number; startDate?: string; endDate?: string },
  opts?: QueryOpts,
) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['general-ledger', params],
    queryFn: () => apiFetch(`/reports/general-ledger${qs(params)}`),
  });
}

// --- Ledger import (QuickBooks Transaction Detail by Account) ---
export type ImportAccountDecision = { name: string; accountId?: number | null; create?: { type: string; subType?: string; code?: string } };
export type ImportPreviewAccount = {
  name: string; existingAccountId: number | null; existingCode: string | null; existingType: string | null;
  suggestedType: string; suggestedSubType: string; confidence: 'high' | 'low';
};
export type ImportPreviewEntry = {
  key: string; date: string; transactionType: string; num: string; name: string; memo: string;
  lines: { account: string; amount: number; synthesized?: boolean }[];
  amount: number; synthesized: boolean; sourceLines: number[]; importRowHash: string;
  duplicateOf: { id: number; entryNumber: string; status: string } | null;
};
export type ImportQuarantineItem = {
  reason: string; detail: string; date: string; num: string; name: string;
  accounts: string[]; amount: number; sourceLines: number[];
};
export type ImportPreview = {
  batchId: number; entityId: number; filename: string; rowCount: number; skippedRows: number;
  entries: ImportPreviewEntry[]; quarantine: ImportQuarantineItem[]; accounts: ImportPreviewAccount[];
  warnings: { line: number; message: string }[];
  duplicateCount: number; newAccountCount: number;
};
export type ImportBatch = {
  id: number; source: string; filename: string; entityId: number;
  status: 'PREVIEW' | 'DRAFT' | 'POSTED' | 'DISCARDED';
  rowCount: number; entryCount: number; quarantineCount: number; createdAt: string; postedAt: string | null;
};

/** Step 1: parse and show what WOULD be created. Writes no ledger rows. */
export function usePreviewQuickBooksImport() {
  return useMutation({
    mutationFn: async (data: { file: File; entityId: number }): Promise<ImportPreview> => {
      const form = new FormData();
      form.append('file', data.file);
      form.append('entityId', String(data.entityId));
      return apiFetch('/imports/quickbooks/preview', { method: 'POST', body: form });
    },
  });
}
/** Step 2: create the confirmed accounts and write Draft entries. */
export function useCommitQuickBooksImport() {
  return useMutation({
    mutationFn: (data: { batchId: number; accounts: ImportAccountDecision[] }) =>
      jsonPost(`/imports/quickbooks/${data.batchId}/commit`, { accounts: data.accounts }),
  });
}
/** Step 3: Draft → Posted, refused while anything is quarantined. */
export function usePostImportBatch() {
  return useMutation({ mutationFn: (data: { batchId: number }) => jsonPost(`/import-batches/${data.batchId}/post`) });
}
export function useDiscardImportBatch() {
  return useMutation({ mutationFn: (data: { batchId: number }) => jsonPost(`/import-batches/${data.batchId}/discard`) });
}
export function useImportBatches(opts?: QueryOpts) {
  return useQuery<ImportBatch[]>({
    queryKey: ['import-batches'],
    queryFn: () => apiFetch('/import-batches'),
    enabled: opts?.query?.enabled ?? true,
  });
}

/** Who owes whom across the group, as an owner × counterparty matrix. */
export function useIntercompanyBalances(params: { asOfDate?: string }, opts?: QueryOpts) {
  return useQuery<IntercompanyBalances>({
    queryKey: opts?.query?.queryKey ?? ['intercompany-balances', params],
    queryFn: () => apiFetch(`/reports/intercompany-balances${qs(params)}`),
    enabled: opts?.query?.enabled ?? true,
  });
}

export function useCashFlowStatement(
  params: { entityId?: number; brandId?: number; startDate: string; endDate: string; currency?: string },
  opts?: QueryOpts,
) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['cash-flow', params],
    queryFn: () => apiFetch(`/reports/cash-flow${qs(params)}`),
    enabled: opts?.query?.enabled ?? Boolean(params.startDate && params.endDate),
  });
}

// ===== PHASE 2: GROUPED MANAGEMENT REPORTING (reads posted GL only) =====
export function useBrandPnl(params: { entityId?: number; startDate: string; endDate: string; currency?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['brand-pnl', params],
    queryFn: () => apiFetch(`/reports/brand-pnl${qs(params)}`),
    enabled: opts?.query?.enabled ?? Boolean(params.startDate && params.endDate),
  });
}

export function useRevenueStreams(
  params: { entityId?: number; brandId?: number; startDate: string; endDate: string; currency?: string },
  opts?: QueryOpts,
) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['revenue-streams', params],
    queryFn: () => apiFetch(`/reports/revenue-streams${qs(params)}`),
    enabled: opts?.query?.enabled ?? Boolean(params.startDate && params.endDate),
  });
}

export function useManagementTrends(
  params: { entityId?: number; brandId?: number; startDate: string; endDate: string; currency?: string },
  opts?: QueryOpts,
) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['management-trends', params],
    queryFn: () => apiFetch(`/reports/trends${qs(params)}`),
    enabled: opts?.query?.enabled ?? Boolean(params.startDate && params.endDate),
  });
}

export function useExecutiveDashboard(params?: { entityId?: number; asOfDate?: string; trailingMonths?: number; currency?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['executive-dashboard', params],
    queryFn: () => apiFetch(`/reports/executive${qs(params ?? {})}`),
  });
}

export type CashFlowTrendPoint = { bucket: string; label: string; cashIn: number; cashOut: number; net: number; position: number };
export type CashFlowTrend = { startDate: string; endDate: string; currency: string; rateFound: boolean; granularity: 'day' | 'month'; openingPosition: number; series: CashFlowTrendPoint[] };

/** Cash in / out / running position per month (or per day for a short range). */
export function useCashFlowTrend(params: { entityId?: number; startDate: string; endDate: string; currency?: string; granularity?: 'day' | 'month' }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['cash-flow-trend', params],
    queryFn: () => apiFetch(`/reports/cash-flow-trend${qs(params)}`) as Promise<CashFlowTrend>,
    enabled: (opts?.query?.enabled ?? true) && !!params.startDate && !!params.endDate,
  });
}

export type TrendPoint = { month: string; revenue: number; expenses: number; netIncome: number };

/** Monthly revenue / expenses / net income — the dashboard's performance bars. */
export function useTrends(params: { entityId?: number; brandId?: number; startDate: string; endDate: string; currency?: string }, opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['trends', params],
    queryFn: () => apiFetch(`/reports/trends${qs(params)}`) as Promise<{ series: TrendPoint[]; currency: string; rateFound: boolean }>,
    enabled: (opts?.query?.enabled ?? true) && !!params.startDate && !!params.endDate,
  });
}

// ===== PLAID BANK CONNECTIONS =====
export function usePlaidStatus(opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['plaid-status'],
    queryFn: () => apiFetch('/plaid/status'),
  });
}

export function usePlaidItems(opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['plaid-items'],
    queryFn: () => apiFetch('/plaid/items'),
  });
}

export function usePlaidAccounts(opts?: QueryOpts) {
  return useQuery({
    queryKey: opts?.query?.queryKey ?? ['plaid-accounts'],
    queryFn: () => apiFetch('/plaid/accounts'),
  });
}

export function usePlaidStatements(itemId?: number) {
  return useQuery({
    queryKey: ['plaid-statements', itemId],
    queryFn: () => apiFetch(`/plaid/items/${itemId}/statements`),
    enabled: Boolean(itemId),
  });
}

export function useUploadPlaidStatement() {
  return useMutation({
    mutationFn: ({ itemId, file }: { itemId: number; file: File }) => {
      const formData = new FormData();
      formData.append('statement', file);
      return apiFetch(`/plaid/items/${itemId}/statements`, {
        method: 'POST',
        body: formData,
      });
    },
  });
}

export function useCreatePlaidLinkToken() {
  return useMutation({
    mutationFn: () => apiFetch('/plaid/link-token', { method: 'POST' }),
  });
}

export function useExchangePlaidPublicToken() {
  return useMutation({
    mutationFn: ({ publicToken, institution }: { publicToken: string; institution?: any }) =>
      apiFetch('/plaid/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicToken, institution }),
      }),
  });
}

export function useCreateManualPlaidItem() {
  return useMutation({
    mutationFn: ({
      institutionName,
      country,
      icon,
    }: {
      institutionName: string;
      country: string;
      icon: string;
    }) =>
      apiFetch('/plaid/manual-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ institutionName, country, icon }),
      }),
  });
}

export function useDeletePlaidItem() {
  return useMutation({
    mutationFn: ({ id }: { id: number }) =>
      apiFetch(`/plaid/items/${id}`, { method: 'DELETE' }),
  });
}
