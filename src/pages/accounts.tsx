import React, { useState, useRef } from 'react';
import { naturalBalance } from '@/lib/account-balance';
import { buildAccountTree, descendantIds, ancestorPath } from '@/lib/coa-tree';
import { useAuth } from '@/lib/auth';
import { useListAccounts, useCreateAccount, useUpdateAccount, useDeleteAccount, useBulkImportAccounts, useBulkDeleteAccounts, useListEntities, useListAccountBalances, useAccountRegister, getListAccountsQueryKey } from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { PlusCircle, Pencil, Trash2, Download, Upload, Search, X, ChevronDown, MoreHorizontal, BookOpen } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { ReverseEntryAction } from '@/components/reverse-entry-action';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { ACCOUNT_TYPES, ACCOUNT_SUBTYPES, entityLabel } from '@/lib/constants';
import { format } from 'date-fns';
import { ResizableColGroup, ResizableHeaderCells, defaultWidths, useResizableColumns, type ResizableColumnDef } from '@/components/resizable-columns';
import { showEntryMemo } from '@/lib/entry-memo';

const TYPE_FILTER_LABELS: Record<string, string> = {
  Asset: 'Assets',
  Liability: 'Liabilities',
  Equity: 'Equity',
  Revenue: 'Revenue',
  Expense: 'Expenses',
};

function formatMoney(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// COA table columns (2026-09-17): no Currency column (everything is shown
// in USD), type and entity as their own columns, all resizable.
const COA_COLUMNS: ResizableColumnDef[] = [
  { key: 'select', label: '', width: 40, resizable: false },
  { key: 'name', label: 'Account Name', width: 290 },
  { key: 'type', label: 'Type / Classification', width: 196 },
  { key: 'entity', label: 'Entity Scope', width: 148 },
  { key: 'balance', label: 'Balance ($)', width: 136, align: 'right' },
  { key: 'action', label: 'Action', width: 123, align: 'right' },
];
const COA_DEFAULT_WIDTHS = defaultWidths(COA_COLUMNS);

const TYPE_BADGE_CLASS: Record<string, string> = {
  Asset: 'bg-blue-100 text-blue-800',
  Liability: 'bg-amber-100 text-amber-800',
  Equity: 'bg-purple-100 text-purple-800',
  Revenue: 'bg-green-100 text-green-800',
  Expense: 'bg-red-100 text-red-800',
};

// COA form (2026-09-10, second pass): Brand stays permanently out of this
// form — `accounts` has no `brandId` column at all, only `entityId` (used
// only by the Phase 1.1 seed for a handful of intentionally entity-scoped
// rows like "Cash in Bank - CA"), and Brand itself is a per-transaction
// posting tag set on a journal line, never a property of the account
// definition. Sub-Type is back, but as a real dropdown (options come from
// ACCOUNT_SUBTYPES[type] in src/lib/constants.ts, re-filtered whenever
// Main Type changes) with a "+ Add Custom Sub-Type" escape hatch that
// switches to a plain text input — the account is still required to have
// SOME sub-type, built-in or custom, since it's what the backend derives
// `category` from (Cash & Equivalents, Cost of Goods Sold, etc — see
// deriveCategory in server/index.ts) for the load-bearing report/posting
// logic documented there.
const CUSTOM_SUBTYPE_SENTINEL = '__custom__';

// Account Code is no longer asked for (2026-09-11) — the backend numbers
// each account from its Main Type's standard band (Assets 1000s,
// Liabilities 2000s, Equity 3000s, Revenue 4000s, Expenses 5000s). On
// edit the existing code is preserved server-side.
// Ownership is a REQUIRED, explicit choice: either a specific entity, or
// "Shared / Master" which stores entityId = null so every entity can post
// to the head. The sentinel exists so the dropdown always shows a decision
// that was actually made — an empty value would be indistinguishable from
// "not filled in yet".
const SHARED_ENTITY_SENTINEL = 'shared';

// "No parent" sentinel — Radix Select can't hold an empty-string value.
const NO_PARENT_SENTINEL = 'none';

const formSchema = z.object({
  name: z.string().min(1, "Required"),
  type: z.string().min(1, "Required"),
  subType: z.string().min(1, "Required"),
  entityId: z.string().min(1, "Select which entity this account belongs to"),
  parentId: z.string(),
  isActive: z.boolean(),
});

function AccountFormModal({ open, onOpenChange, entryToEdit, entities, accounts }: { open: boolean, onOpenChange: (open: boolean) => void, entryToEdit?: any, entities: any[], accounts: any[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canCreateShared = useAuth().allEntities;
  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount();

  const isEdit = !!entryToEdit;

  const initialType = isEdit ? entryToEdit.type : 'Expense';
  const initialSubType = isEdit ? (entryToEdit.subType || '') : (ACCOUNT_SUBTYPES[initialType]?.[0] || '');
  const initialIsCustomSubType = isEdit && !!initialSubType && !(ACCOUNT_SUBTYPES[initialType] || []).includes(initialSubType);
  // New accounts default to the first available entity — there is no
  // logged-in user or global entity switcher in this app yet, so "the
  // active entity" is simply the first one configured in Settings.
  const initialEntityId = isEdit
    ? (entryToEdit.entityId ? String(entryToEdit.entityId) : SHARED_ENTITY_SENTINEL)
    : (entities[0] ? String(entities[0].id) : SHARED_ENTITY_SENTINEL);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: isEdit ? entryToEdit.name : '',
      type: initialType,
      subType: initialSubType,
      entityId: initialEntityId,
      parentId: isEdit && entryToEdit.parentId ? String(entryToEdit.parentId) : NO_PARENT_SENTINEL,
      isActive: isEdit ? !!entryToEdit.isActive : true,
    }
  });

  const [customSubType, setCustomSubType] = useState(initialIsCustomSubType);
  const currentType = form.watch('type');
  const subtypeOptions = ACCOUNT_SUBTYPES[currentType] || [];

  // Re-filter Sub-Type options whenever Main Type changes; if the current
  // Sub-Type doesn't belong to the newly-selected type's list (and isn't a
  // custom value already being edited), default back to that type's first
  // built-in option so the form is never left pointing at a mismatched pair.
  const prevTypeRef = React.useRef(currentType);
  React.useEffect(() => {
    if (prevTypeRef.current === currentType) return;
    prevTypeRef.current = currentType;
    if (!customSubType) {
      form.setValue('subType', (ACCOUNT_SUBTYPES[currentType] || [])[0] || '');
    }
  }, [currentType]);

  // Valid parents mirror the server rule (validateParentAssignment): same
  // Main Type; an entity's account may sit under that entity's own or a
  // Shared parent, a Shared account only under a Shared parent; never
  // itself or one of its own sub-accounts (that would be a cycle).
  const currentEntity = form.watch('entityId');
  const currentParent = form.watch('parentId');
  const parentOptions = React.useMemo(() => {
    const excluded = isEdit ? descendantIds(accounts, entryToEdit.id) : new Set<number>();
    if (isEdit) excluded.add(entryToEdit.id);
    const eligible = accounts.filter((a) =>
      a.type === currentType &&
      !excluded.has(a.id) &&
      (a.entityId == null || (currentEntity !== SHARED_ENTITY_SENTINEL && Number(a.entityId) === Number(currentEntity))),
    );
    const eligibleIds = new Set(eligible.map((a) => a.id));
    // Keep tree order (and indentation) so the picker reads like the chart.
    return buildAccountTree(accounts).filter((r) => eligibleIds.has(r.account.id));
  }, [accounts, currentType, currentEntity, isEdit, entryToEdit?.id]);

  // Drop a parent that stopped being valid after a Type/Entity change.
  React.useEffect(() => {
    if (currentParent !== NO_PARENT_SENTINEL && !parentOptions.some((r) => String(r.account.id) === currentParent)) {
      form.setValue('parentId', NO_PARENT_SENTINEL);
    }
  }, [parentOptions, currentParent]);

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    // The sentinels are UI-only; a shared head is stored as entityId null,
    // a top-level account as parentId null.
    const data = {
      ...values,
      entityId: values.entityId === SHARED_ENTITY_SENTINEL ? null : Number(values.entityId),
      parentId: values.parentId === NO_PARENT_SENTINEL ? null : Number(values.parentId),
    };
    const afterSave = (title: string) => () => {
      toast({ title });
      queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      // The Banking hub renders its cards straight off the Chart of
      // Accounts, so a new/edited bank head must refresh those too.
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
      onOpenChange(false);
    };
    if (isEdit) {
      updateAccount.mutate({ id: entryToEdit.id, data }, {
        onSuccess: afterSave('Account updated'),
        onError: (err: any) => toast({ title: 'Failed to update account', description: err.message, variant: 'destructive' }),
      });
    } else {
      createAccount.mutate({ data }, {
        onSuccess: afterSave('Account created'),
        onError: (err: any) => toast({ title: 'Failed to create account', description: err.message, variant: 'destructive' }),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Account' : 'Add New Account'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="type" render={({ field }) => (
              <FormItem>
                <FormLabel>Main Type</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>{ACCOUNT_TYPES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="subType" render={({ field }) => (
              <FormItem>
                <FormLabel>Sub-Type</FormLabel>
                {customSubType ? (
                  <div className="flex items-center gap-2">
                    <FormControl>
                      <Input {...field} placeholder="e.g. Payroll Clearing" autoFocus />
                    </FormControl>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs shrink-0"
                      onClick={() => { setCustomSubType(false); form.setValue('subType', subtypeOptions[0] || ''); }}
                    >
                      Choose from list
                    </Button>
                  </div>
                ) : (
                  <Select
                    onValueChange={(v) => {
                      if (v === CUSTOM_SUBTYPE_SENTINEL) {
                        setCustomSubType(true);
                        form.setValue('subType', '');
                      } else {
                        field.onChange(v);
                      }
                    }}
                    value={field.value}
                  >
                    <FormControl><SelectTrigger><SelectValue placeholder="Select a sub-type" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {subtypeOptions.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      <SelectItem value={CUSTOM_SUBTYPE_SENTINEL} className="font-medium text-primary">+ Add Custom Sub-Type</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="entityId" render={({ field }) => (
              <FormItem>
                <FormLabel>Entity</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select an entity" /></SelectTrigger></FormControl>
                  <SelectContent>
                    {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                    {/* Shared heads affect every entity — all-entity users only (server-enforced). */}
                    {canCreateShared && <SelectItem value={SHARED_ENTITY_SENTINEL}>Shared / Master (All Entities)</SelectItem>}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-gray-500">
                  {form.watch('entityId') === SHARED_ENTITY_SENTINEL
                    ? 'Every entity can post to this account.'
                    : 'Only this entity can post to this account.'}
                </p>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="parentId" render={({ field }) => (
              <FormItem>
                <FormLabel>Parent Account <span className="font-normal text-gray-400">(optional)</span></FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NO_PARENT_SENTINEL}>None — top-level {currentType} account</SelectItem>
                    {parentOptions.map(({ account: a, depth }) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        <span style={{ paddingLeft: depth * 12 }} className="font-mono text-gray-400 mr-1.5">{a.code}</span>{a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-gray-500">
                  {parentOptions.length === 0
                    ? `No eligible parent — a sub-account's parent must also be ${currentType === 'Asset' ? 'an' : 'a'} ${currentType} account with compatible ownership.`
                    : `Only ${currentType} accounts this entity can use are listed.`}
                </p>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Account Name</FormLabel><FormControl><Input {...field} placeholder="e.g. Software Cost, Engineering Salaries" /></FormControl><FormMessage /></FormItem>
            )} />

            {isEdit && (
              <FormField control={form.control} name="isActive" render={({ field }) => (
                <FormItem className="flex items-start gap-2 space-y-0 rounded-md border p-3">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(!!v)} />
                  </FormControl>
                  <div>
                    <FormLabel className="font-medium">Active</FormLabel>
                    <p className="text-[11px] text-gray-500">
                      Untick to retire an account that has history. It stays in reports for past periods but is hidden from posting pickers.
                    </p>
                  </div>
                </FormItem>
              )} />
            )}

            {isEdit ? (
              <div className="text-[12px] text-gray-500">
                Account code <span className="font-mono text-gray-900">{entryToEdit.code}</span> — assigned automatically, not editable.
              </div>
            ) : (
              <div className="text-[12px] text-gray-500">
                An account code will be assigned automatically from the Main Type
                (Assets 1000s, Liabilities 2000s, Equity 3000s, Revenue 4000s, Expenses 5000s).
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={createAccount.isPending || updateAccount.isPending}>
                {createAccount.isPending || updateAccount.isPending ? 'Saving…' : isEdit ? 'Update Account' : 'Create Account'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// "View register" (2026-09-11, QBO-style COA table): a read-only drill-down
// into one account's own posted journal lines, in date order with a running
// balance — backed by GET /api/accounts/:id/register (server/index.ts),
// which reuses the same debit-minus-credit convention as
// computeGlAccountBalance so the final running total always ties out to the
// account's own Balance figure in the COA table.
function AccountRegisterModal({ account, onOpenChange, entityId, entityName }: { account: any | null; onOpenChange: (open: boolean) => void; entityId?: number; entityName?: string }) {
  // Scoped to the COA entity filter, so the closing balance ties to the row.
  const { data, isLoading } = useAccountRegister(account?.id ?? null, undefined, entityId);
  const lines = (data?.lines || []) as any[];
  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{account?.name} — Register</DialogTitle>
          <DialogDescription>Posted journal lines for account {account?.code}{entityName ? ` in ${entityName}` : ' (all entities)'}, oldest first</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto border rounded-md">
          {/* Same fixed column geometry as the General Ledger report. */}
          <Table className="table-fixed min-w-[752px]">
            <colgroup>
              <col className="w-[100px]" />
              <col className="w-[120px]" />
              <col />
              <col className="w-[110px]" />
              <col className="w-[110px]" />
              <col className="w-[120px]" />
              <col className="w-[52px]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Entry #</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-xs text-right">Debit</TableHead>
                <TableHead className="text-xs text-right">Credit</TableHead>
                <TableHead className="text-xs text-right">Balance</TableHead>
                <TableHead className="text-xs sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground text-sm">Loading…</TableCell></TableRow>
              ) : lines.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground font-mono text-sm">No posted activity for this account</TableCell></TableRow>
              ) : (
                lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{l.transactionDate}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap truncate">{l.entryNumber}</TableCell>
                    <TableCell className="min-w-0 text-xs">
                      <div className="truncate" title={l.memo || l.description}>{l.memo || l.description}</div>
                      {/* Entry header memo, when the line has its own. */}
                      {showEntryMemo(l.memo, l.description) && (
                        <div className="truncate text-[10px] text-muted-foreground" title={l.description} data-entry-memo>Entry: {l.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums whitespace-nowrap">{l.debit ? formatMoney(l.debit) : ''}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums whitespace-nowrap">{l.credit ? formatMoney(l.credit) : ''}</TableCell>
                    {(() => {
                      const shown = naturalBalance(account?.type, l.runningBalanceUSD);
                      return <TableCell className={`text-right font-mono text-xs tabular-nums whitespace-nowrap ${shown < 0 ? 'text-red-700' : ''}`}>{formatMoney(shown)}</TableCell>;
                    })()}
                    {/* Same operation as the General Ledger's — a register
                        row IS a posted journal line, so the correction is a
                        mirror entry, never an edit of what is here. */}
                    <TableCell className="px-1">
                      <ReverseEntryAction
                        journalEntryId={l.journalEntryId}
                        entryNumber={l.entryNumber}
                        description={l.memo || l.description}
                        transactionType={l.source}
                        compact
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Accounts() {
  const { can, allEntities } = useAuth();
  const canEditCoa = can('coa.write');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [entryToEdit, setEntryToEdit] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [importSummary, setImportSummary] = useState<{ totalRows: number; successCount: number; failedCount: number; errors: { row: number; reason: string }[]; warnings?: { row: number; reason: string }[] } | null>(null);
  const [registerAccount, setRegisterAccount] = useState<any | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Currency switcher removed globally (2026-09-11). Every figure in the
  // UI is shown in USD, the functional reporting currency of the books.
  // The backend's month-wise translation machinery is untouched — it still
  // converts each foreign-currency transaction into USD at its own
  // month's rate; what's gone is the per-user display toggle on top.
  const displayCurrency = 'USD';
  const { data: accounts, isLoading } = useListAccounts({}, { query: { queryKey: ['accounts'] } });
  const { data: entities } = useListEntities();
  const entityById = React.useMemo(() => {
    const map = new Map<number, any>();
    ((entities || []) as any[]).forEach((e) => map.set(e.id, e));
    return map;
  }, [entities]);
  // Entity filter (2026-09-17): 'ALL' = consolidated. A specific entity shows
  // its own heads plus Shared heads, with every balance computed from that
  // entity's postings only (server-side, ?entityId).
  const [entityFilter, setEntityFilter] = useState<string>('ALL');
  const filterEntityId = entityFilter === 'ALL' ? undefined : Number(entityFilter);
  const filterEntityName = filterEntityId ? entityLabel(entityById.get(filterEntityId)?.name || `Entity ${filterEntityId}`) : undefined;
  const { data: balancesResult, isLoading: balancesLoading } = useListAccountBalances({ currency: displayCurrency, entityId: filterEntityId });
  const balanceByAccountId = React.useMemo(() => {
    const map = new Map<number, { amount: number; usdAmount: number }>();
    ((balancesResult?.balances || []) as any[]).forEach((b) => map.set(b.accountId, b));
    return map;
  }, [balancesResult]);
  const deleteAccount = useDeleteAccount();
  const bulkImport = useBulkImportAccounts();
  const bulkDelete = useBulkDeleteAccounts();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // "Filter by name or number" (2026-09-11, QBO-style COA table): instant
  // client-side filtering over already-fetched rows — never re-fetches or
  // mutates query state, so it can't corrupt the underlying accounts cache.
  // Hierarchy (2026-09-16): with no search, rows are shown as a tree —
  // statutory type order, then code, sub-accounts indented under their
  // parent. A search shows matching rows flat (a match's parent may not
  // match), each labelled with its parent path so context isn't lost.
  const allAccounts = React.useMemo(() => {
    const list = (accounts || []) as any[];
    return filterEntityId ? list.filter((a) => a.entityId == null || Number(a.entityId) === filterEntityId) : list;
  }, [accounts, filterEntityId]);
  // Totals by statutory type for the current scope: each account's OWN
  // balance summed (no roll-ups, so nothing double counts), natural side.
  const typeTotals = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const a of allAccounts) {
      const raw = balanceByAccountId.get(a.id)?.amount;
      if (raw == null) continue;
      totals.set(a.type, (totals.get(a.type) || 0) + raw);
    }
    return ACCOUNT_TYPES.map((t) => ({ type: t, amount: naturalBalance(t, totals.get(t) || 0) }));
  }, [allAccounts, balanceByAccountId]);
  const displayedRows = React.useMemo(() => {
    let rows = [...allAccounts];
    if (typeFilter !== 'All') {
      rows = rows.filter(r => r.type === typeFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return buildAccountTree(rows)
        .filter(({ account: r }) => [r.name, r.code].some(v => String(v ?? '').toLowerCase().includes(q)))
        .map((row) => ({ ...row, depth: 0, path: ancestorPath(allAccounts, row.account.id) }));
    }
    return buildAccountTree(rows);
  }, [allAccounts, search, typeFilter]);
  const displayedAccounts = React.useMemo(() => displayedRows.map((r) => r.account), [displayedRows]);

  // A parent's Balance is its roll-up: its own postings plus every
  // sub-account's (raw debit − credit summed, then presented on the
  // account's natural side). Statements are unaffected — they read ledger
  // lines per account and never double count.
  const rolledUpRawBalance = React.useCallback((accountId: number): number | undefined => {
    if (!balanceByAccountId.has(accountId)) return undefined;
    let total = balanceByAccountId.get(accountId)!.amount;
    for (const id of descendantIds(allAccounts, accountId)) total += balanceByAccountId.get(id)?.amount ?? 0;
    return total;
  }, [allAccounts, balanceByAccountId]);

  const coaColumns = useResizableColumns('finsys.coa.columns.v1', COA_DEFAULT_WIDTHS);
  const allSelected = displayedAccounts.length > 0 && displayedAccounts.every(r => selectedIds.has(r.id));

  const toggleSelectAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(displayedAccounts.map(r => r.id)));
  };

  const toggleSelectRow = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleEdit = (entry: any) => {
    setEntryToEdit(entry);
    setIsModalOpen(true);
  };

  const handleCreate = () => {
    setEntryToEdit(null);
    setIsModalOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this account?")) {
      deleteAccount.mutate({ id }, {
        onSuccess: () => {
          toast({ title: 'Account deleted' });
          queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        },
        // The server refuses to delete an account that has history,
        // sub-accounts or a bank feed — surface its reason.
        onError: (err: any) => toast({ title: 'Account not deleted', description: err.message, variant: 'destructive' }),
      });
    }
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} selected account(s)? This cannot be undone.`)) return;
    bulkDelete.mutate({ ids: [...selectedIds] }, {
      onSuccess: (res: any) => {
        const skipped = (res?.skipped || []) as { name: string; reason: string }[];
        toast({
          title: `Deleted ${res?.deleted ?? 0} of ${selectedIds.size} account(s)`,
          description: skipped.length
            ? `Kept ${skipped.length} still in use: ${skipped.slice(0, 3).map((s) => `${s.name} (${s.reason})`).join('; ')}${skipped.length > 3 ? '…' : ''}. Deactivate those instead.`
            : undefined,
          variant: skipped.length ? 'destructive' : 'default',
        });
        setSelectedIds(new Set());
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      },
      onError: (err: any) => toast({ title: 'Bulk delete failed', description: err.message, variant: 'destructive' }),
    });
  };

  // "Export COA" (2026-09-11): matches the table's own standard template
  // column-for-column — Account Code, Account Name, Main Type, Sub-Type,
  // Balance, Status — rather than the old Code/Type/Category/Name/
  // Description shape. Balance is pulled from the same balanceByAccountId
  // map the table renders from, so the export always matches what's on
  // screen (same currency, same as-of-today figure) rather than
  // re-deriving it separately.
  // Export/Template/Import field-name parity (2026-09-11): all three now
  // agree on the exact same header set — Account Code, Account Name, Main
  // Type, Sub-Type (Export additionally shows Balance/Status, which are
  // read-only derived columns, not something Import needs back). This is
  // what makes round-tripping (export, edit in Excel, re-import) actually
  // work: importing your own export no longer hits a field-name mismatch.
  const handleExport = async () => {
    const { utils, writeFile } = await import('xlsx');
    // Tree order, with Parent Account as the parent's code — the import
    // resolves it back, so export → edit → re-import keeps the hierarchy.
    // Balance here is each account's OWN balance (not the roll-up), so a
    // column sum never double counts.
    const byId = new Map(allAccounts.map((a) => [a.id, a]));
    const ws = utils.json_to_sheet(buildAccountTree(allAccounts).map(({ account: r }) => ({
      'Account Code': r.code,
      'Account Name': r.name,
      'Main Type': r.type,
      'Sub-Type': r.subType || '',
      'Parent Account': r.parentId ? (byId.get(r.parentId)?.code ?? '') : '',
      Balance: balanceByAccountId.has(r.id) ? naturalBalance(r.type, balanceByAccountId.get(r.id)!.amount) : '',
      Status: r.isActive ? 'Active' : 'Inactive',
    })));
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Chart of Accounts');
    writeFile(wb, `chart-of-accounts-export-${format(new Date(), 'yyyy-MM-dd')}.xlsx`);
  };

  // Template carries only what a user actually has to supply. Account
  // Code is deliberately absent (2026-09-11): it's generated from Main
  // Type on save, so asking for it in the upload file would invite
  // collisions with codes the system already assigned.
  const handleDownloadTemplate = async () => {
    const { utils, writeFile } = await import('xlsx');
    // Parent Account is optional: an existing account's code or exact name,
    // or another row in the same file.
    const ws = utils.json_to_sheet([
      { 'Account Name': 'Payroll', 'Main Type': 'Expense', 'Sub-Type': 'Operating Expense', 'Parent Account': '' },
      { 'Account Name': 'Engineering Salaries', 'Main Type': 'Expense', 'Sub-Type': 'Operating Expense', 'Parent Account': 'Payroll' },
    ]);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Chart of Accounts');
    writeFile(wb, 'chart-of-accounts-import-template.xlsx');
  };

  // Case-insensitive, punctuation-and-spacing-insensitive header matching —
  // "Account Code", "account_code", "accountCode", and plain "code" (or
  // "Code") all resolve to the same field. Mirrors the backend's own
  // pickField() in server/index.ts so a file that imports cleanly here
  // would also import cleanly via a direct API call, and vice versa.
  const pickCell = (row: Record<string, any>, ...aliases: string[]): string => {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = new Set(aliases.map(normalize));
    for (const key of Object.keys(row)) {
      if (wanted.has(normalize(key))) {
        const v = row[key];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
    return '';
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { read, utils } = await import('xlsx');
      const ab = await file.arrayBuffer();
      const wb = read(ab);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = utils.sheet_to_json(ws) as any[];
      const rows = raw.map(r => ({
        code: pickCell(r, 'code', 'Account Code', 'account_code', 'accountCode'),
        name: pickCell(r, 'name', 'Account Name', 'account_name', 'accountName'),
        type: pickCell(r, 'type', 'Main Type', 'main_type', 'mainType'),
        subType: pickCell(r, 'subType', 'Sub-Type', 'sub_type', 'subtype'),
        parentAccount: pickCell(r, 'parentAccount', 'Parent Account', 'parent', 'parent_account', 'Parent Code'),
      }));

      if (rows.length === 0) { toast({ title: 'No rows found in file', variant: 'destructive' }); return; }

      bulkImport.mutate({ rows }, {
        onSuccess: (res) => {
          setImportSummary(res);
          if (res.successCount > 0) {
            toast({ title: `Imported ${res.successCount} of ${res.totalRows} rows` });
            queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
          }
          if (res.failedCount > 0) {
            toast({ title: `${res.failedCount} row(s) failed validation`, variant: 'destructive' });
          }
        },
        onError: () => toast({ title: 'Import failed', variant: 'destructive' }),
      });
    } catch {
      toast({ title: 'Failed to read file', variant: 'destructive' });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <PageHeader title="Chart of Accounts">
        {/* QBO-style split button (2026-09-11): primary "New account" action
            with an attached chevron dropdown for Import/Export/Template —
            replaces the old row of four separate buttons. */}
        {/* RBAC: creating / importing heads needs coa.write (Manager/Admin;
            import additionally needs all-entity access — server-enforced).
            Export and the template stay available to every role. */}
        <div className="flex items-center">
          {canEditCoa && (
            <Button onClick={handleCreate} size="sm" className="rounded-r-none">
              <PlusCircle className="mr-2 size-4" /> New account
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant={canEditCoa ? 'default' : 'outline'} className={canEditCoa ? 'rounded-l-none border-l border-l-primary-foreground/20 px-2' : ''} aria-label="Chart of Accounts options">
                {!canEditCoa && <Download className="mr-2 size-4" />}{!canEditCoa && 'Export'}
                <ChevronDown className={canEditCoa ? 'size-4' : 'ml-1 size-4'} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEditCoa && allEntities && (
                <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                  <Upload className="mr-2 size-4" /> Import COA
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleExport}>
                <Download className="mr-2 size-4" /> Export COA
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleDownloadTemplate}>
                <Download className="mr-2 size-4" /> Download Template
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} />
      </PageHeader>
      <PageContent>
        <div className="flex items-center gap-3 mb-3">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name or number"
              className="pl-8 pr-8"
            />
            {search && (
              <button className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground" onClick={() => setSearch('')}>
                <X className="size-4" />
              </button>
            )}
          </div>
          <Select value={entityFilter} onValueChange={(v) => { setEntityFilter(v); setSelectedIds(new Set()); }}>
            <SelectTrigger className="h-9 w-56" aria-label="Entity filter" data-coa-entity-filter><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Entities (Consolidated)</SelectItem>
              {((entities || []) as any[]).map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All</SelectItem>
              {ACCOUNT_TYPES.map((t) => <SelectItem key={t} value={t}>{TYPE_FILTER_LABELS[t] || t}</SelectItem>)}
            </SelectContent>
          </Select>
          {canEditCoa && allEntities && selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-mono">{selectedIds.size} selected</span>
              <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
                <Trash2 className="mr-2 size-4" /> Delete Selected
              </Button>
            </div>
          )}
        </div>
        {/* Totals for the selected scope, derived from the same balances as the table. */}
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5" data-coa-totals={filterEntityId ?? 'ALL'}>
          {typeTotals.map(({ type, amount }) => (
            <div key={type} className="rounded-lg border bg-card px-3 py-2 shadow-sm" data-coa-total={type}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{TYPE_FILTER_LABELS[type] || type}</div>
              <div className={`font-mono text-sm font-semibold tabular-nums ${amount < 0 ? 'text-red-700' : ''}`}>
                {balancesLoading ? '…' : formatMoney(amount, displayCurrency)}
              </div>
            </div>
          ))}
        </div>
        <div className="mb-2 text-[11px] text-muted-foreground" data-coa-scope>
          {filterEntityName
            ? <>Showing <span className="font-medium text-foreground">{filterEntityName}</span> accounts and Shared accounts, with balances from {filterEntityName}'s postings only.</>
            : 'All entities, consolidated.'}
        </div>
        <div className="border border-gray-100 rounded-2xl bg-white shadow-sm overflow-hidden">
          <Table
            className="table-fixed [&_td]:overflow-hidden"
            style={coaColumns.tableStyle}
            data-resizable-table="coa"
          >
            <ResizableColGroup widths={coaColumns.widths} />
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <ResizableHeaderCells
                  table={coaColumns}
                  columns={COA_COLUMNS.map((c) => c.key === 'select'
                    ? { ...c, header: canEditCoa && allEntities ? <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select all accounts" /> : null }
                    : c)}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))
              ) : displayedAccounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COA_COLUMNS.length} className="text-center py-8 text-muted-foreground font-mono text-sm">No accounts found</TableCell>
                </TableRow>
              ) : (
                displayedRows.map(({ account: row, depth, hasChildren, path }) => (
                  <TableRow key={row.id} className="group" data-state={selectedIds.has(row.id) ? 'selected' : undefined} data-depth={depth}>
                    <TableCell>
                      {canEditCoa && allEntities && <Checkbox checked={selectedIds.has(row.id)} onCheckedChange={() => toggleSelectRow(row.id)} aria-label={`Select ${row.name}`} />}
                    </TableCell>
                    {/* Account Name — tree indent, name and code only. */}
                    <TableCell className="text-sm">
                      {path.length > 0 && depth === 0 && (
                        <div className="truncate text-[10px] text-muted-foreground" data-parent-path title={path.join(' › ')}>{path.join(' › ')} ›</div>
                      )}
                      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 20 }}>
                        {depth > 0 && <span className="text-gray-300 select-none" aria-hidden>└</span>}
                        <span className={`truncate ${!row.isActive ? 'text-muted-foreground line-through' : ''} ${hasChildren ? 'font-semibold' : ''}`} title={row.name}>{row.name}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono" style={{ paddingLeft: depth * 20 + (depth > 0 ? 14 : 0) }}>
                        #{row.code}
                        {!row.isActive ? ' · Inactive' : ''}
                      </div>
                    </TableCell>
                    {/* Type / Classification — statutory type badge + sub-type. */}
                    <TableCell data-coa-type={row.type}>
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge variant="outline" className={`shrink-0 font-mono uppercase text-[9px] ${TYPE_BADGE_CLASS[row.type] || 'bg-muted text-muted-foreground'} border-transparent`}>
                          {row.type}
                        </Badge>
                        <span className="truncate text-xs text-muted-foreground" title={row.subType || undefined}>{row.subType || '—'}</span>
                      </div>
                    </TableCell>
                    {/* Entity Scope — which company's books, or Shared / Global. */}
                    <TableCell className="text-xs" data-coa-entity-scope={row.entityId ?? 'shared'}>
                      {row.entityId ? (
                        <span className="inline-block max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                          {entityLabel(entityById.get(row.entityId)?.name || `Entity ${row.entityId}`)}
                        </span>
                      ) : (
                        <span className="inline-block max-w-full truncate rounded border border-border px-1.5 py-0.5 text-muted-foreground">Shared / Global</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs whitespace-nowrap">
                      {balancesLoading ? (
                        <Skeleton className="h-4 w-20 ml-auto" />
                      ) : balanceByAccountId.has(row.id) ? (() => {
                        // Natural-side balance: credit-normal accounts show
                        // positive in credit; a minus survives only for an
                        // abnormal position (e.g. overdrawn bank). Parents
                        // show the roll-up including their sub-accounts.
                        const shown = naturalBalance(row.type, rolledUpRawBalance(row.id) ?? 0);
                        return (
                          <span
                            className={`${shown < 0 ? 'text-red-700' : ''} ${hasChildren ? 'font-semibold' : ''}`}
                            title={hasChildren ? 'Total including sub-accounts' : undefined}
                            data-balance={shown}
                          >
                            {formatMoney(shown, displayCurrency)}
                          </span>
                        );
                      })() : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 text-xs">
                            View register <ChevronDown className="ml-1 size-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setRegisterAccount(row)}>
                            <BookOpen className="mr-2 size-3.5" /> View register
                          </DropdownMenuItem>
                          {/* Edit/Delete: coa.write, and a Shared head needs all-entity access. */}
                          {canEditCoa && (allEntities || row.entityId != null) && (
                            <>
                              <DropdownMenuItem onClick={() => handleEdit(row)}>
                                <Pencil className="mr-2 size-3.5" /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleDelete(row.id)}>
                                <Trash2 className="mr-2 size-3.5" /> Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </PageContent>

      {isModalOpen && (
        <AccountFormModal
          key={entryToEdit ? `edit-${entryToEdit.id}` : 'create'}
          open={isModalOpen}
          onOpenChange={setIsModalOpen}
          entryToEdit={entryToEdit}
          entities={(entities || []) as any[]}
          accounts={allAccounts}
        />
      )}

      <AccountRegisterModal account={registerAccount} onOpenChange={(open) => !open && setRegisterAccount(null)} entityId={filterEntityId} entityName={filterEntityName} />

      <Dialog open={!!importSummary} onOpenChange={(o) => !o && setImportSummary(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Summary</DialogTitle>
            <DialogDescription>Results of the Chart of Accounts import</DialogDescription>
          </DialogHeader>
          {importSummary && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-md border p-3">
                  <div className="text-2xl font-bold">{importSummary.totalRows}</div>
                  <div className="text-xs text-muted-foreground">Total Rows</div>
                </div>
                <div className="rounded-md border p-3 border-green-200 bg-green-50">
                  <div className="text-2xl font-bold text-green-700">{importSummary.successCount}</div>
                  <div className="text-xs text-muted-foreground">Succeeded</div>
                </div>
                <div className="rounded-md border p-3 border-red-200 bg-red-50">
                  <div className="text-2xl font-bold text-red-700">{importSummary.failedCount}</div>
                  <div className="text-xs text-muted-foreground">Failed</div>
                </div>
              </div>
              {(importSummary.errors.length > 0 || (importSummary.warnings?.length ?? 0) > 0) && (
                <div className="max-h-48 overflow-y-auto border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Row</TableHead>
                        <TableHead className="text-xs">Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {importSummary.errors.map((err, i) => (
                        <TableRow key={`e${i}`}>
                          <TableCell className="text-xs font-mono">{err.row}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{err.reason}</TableCell>
                        </TableRow>
                      ))}
                      {(importSummary.warnings || []).map((w, i) => (
                        <TableRow key={`w${i}`}>
                          <TableCell className="text-xs font-mono">{w.row}</TableCell>
                          <TableCell className="text-xs text-amber-700">{w.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setImportSummary(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
