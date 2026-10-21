import React, { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { fetchExchangeRate, useCreateJournalEntry, useDeleteJournalEntry, useListAccounts, useListEntities, useListJournalEntries, useReverseJournalEntry } from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { CURRENCIES, entityLabel } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import { GLAccountSelect } from '@/components/gl-account-select';
import { QuickAccountDialog } from '@/components/quick-account-dialog';
import { ResizableColGroup, ResizableHeaderCells, defaultWidths, useResizableColumns, type ResizableColumnDef } from '@/components/resizable-columns';
import { invalidateLedgerDerivedQueries } from '@/lib/ledger-queries';
import { PlusCircle, Trash2, Undo2 } from 'lucide-react';

// Manual Journal Entry (2026-09-17). The one screen where a line hits the
// ledger without a bank transaction behind it — corrections, accruals,
// depreciation, opening positions.
//
// Statutory rules, mirrored from the server (which re-checks all of them):
//   - every line is EITHER a debit or a credit, greater than zero
//   - total debits = total credits, to the cent
//   - each entity's own lines balance on their own, because a journal entry
//     belongs to one set of books (move value between entities with the
//     Due From / To Affiliates heads)
//   - a line's account must be that entity's own or a Shared head
// Posting writes Posted entries (one per entity) and invalidates every
// ledger-derived query, so the Chart of Accounts, General Ledger and the
// entity-scoped reports show it immediately — nothing is stored twice.

// Account · Entity · Currency · Debit · Credit · Line memo · remove — the
// amounts sit next to the account they hit, with the memo to their right.
// As soon as a line is in a foreign currency the sheet also shows that
// line's Rate and its converted USD Debit / USD Credit.
const BASE_COLUMNS: ResizableColumnDef[] = [
  { key: 'account', label: 'Account', width: 230 },
  { key: 'entity', label: 'Entity', width: 130 },
  { key: 'currency', label: 'Currency', width: 95 },
  { key: 'debit', label: 'Debit', width: 120, align: 'right' },
  { key: 'credit', label: 'Credit', width: 120, align: 'right' },
  { key: 'description', label: 'Description / Line Memo', width: 200 },
  { key: 'remove', label: '', width: 44, resizable: false },
];
const FX_COLUMNS: ResizableColumnDef[] = [
  { key: 'account', label: 'Account', width: 200 },
  { key: 'entity', label: 'Entity', width: 120 },
  { key: 'currency', label: 'Currency', width: 95 },
  { key: 'debit', label: 'Debit', width: 110, align: 'right' },
  { key: 'credit', label: 'Credit', width: 110, align: 'right' },
  { key: 'rate', label: 'Rate → USD', width: 110, align: 'right' },
  { key: 'debitUsd', label: 'USD Debit', width: 110, align: 'right' },
  { key: 'creditUsd', label: 'USD Credit', width: 110, align: 'right' },
  { key: 'description', label: 'Description / Line Memo', width: 160 },
  { key: 'remove', label: '', width: 44, resizable: false },
];
const BASE_WIDTHS = defaultWidths(BASE_COLUMNS);
const FX_WIDTHS = defaultWidths(FX_COLUMNS);

type JeLine = {
  id: string; accountId: string; entityId: string; description: string; debit: string; credit: string;
  currency: string;
  /** Pre-filled from the configured rate for the entry's month; editable. */
  rate: string;
  /** True once the user edits the rate, so it is never re-filled under them. */
  rateTouched?: boolean;
};

const newLine = (patch: Partial<JeLine> = {}): JeLine => ({
  id: Math.random().toString(36).slice(2),
  accountId: '',
  entityId: '',
  description: '',
  debit: '',
  credit: '',
  currency: 'USD',
  rate: '',
  ...patch,
});

const toCents = (v: string) => Math.round((Number(v) || 0) * 100);
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const native = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

// Reverse (Posted) or Delete (Draft) for ONE manual journal entry
// (2026-10-21). Lives only on this screen: a JV is entered here, so it is
// corrected here. Bank-feed postings are undone on the banking screen and
// bills/invoices are voided from their own, because each of those has a
// record alongside the entry that has to move with it — the server refuses
// them too, this is not just a UI choice.
//
// Reversing is not deleting. A posted entry is the book of record, so the
// correction is a mirror entry posted beside it: both halves stay visible
// and the net effect on every balance is zero.
function JournalEntryAction({
  entry,
  isReversal,
  reversedByEntryNumber,
  onDone,
}: {
  entry: any;
  isReversal: boolean;
  reversedByEntryNumber?: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const { can } = useAuth();
  const reverse = useReverseJournalEntry();
  const remove = useDeleteJournalEntry();

  const isDraft = entry.status !== 'Posted';
  const busy = reverse.isPending || remove.isPending;
  // Posting is what a reversal does, so the same capability gates both.
  // Without it the column is simply empty rather than offering a 403.
  if (!can('post')) return null;
  // Already-corrected entries have nothing left to do: reversing a reversal
  // only re-posts the original, and reversing twice is refused server-side.
  if (!isDraft && (isReversal || reversedByEntryNumber)) {
    return (
      <span className="text-[11px] text-muted-foreground" title={reversedByEntryNumber ? `Reversed by ${reversedByEntryNumber}` : 'This entry is a reversal'}>
        —
      </span>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground hover:text-rose-700"
        onClick={() => setOpen(true)}
        disabled={busy}
        data-jv-action={isDraft ? 'delete' : 'reverse'}
        data-jv-entry={entry.entryNumber}
      >
        {isDraft ? <Trash2 className="mr-1 h-3.5 w-3.5" /> : <Undo2 className="mr-1 h-3.5 w-3.5" />}
        {isDraft ? 'Delete' : 'Reverse'}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isDraft ? `Delete draft ${entry.entryNumber}?` : `Reverse ${entry.entryNumber}?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {isDraft ? (
                  <p>This draft was never posted, so nothing in the books changes. It is removed along with its lines.</p>
                ) : (
                  <>
                    <p>
                      This posts a <strong>mirror entry</strong> dated today, with every debit and credit
                      swapped. The original stays in the books and both entries remain visible — that is how a
                      posted entry is corrected, so the audit trail is never broken.
                    </p>
                    <p className="text-muted-foreground">
                      Net effect on every balance, report and statement is zero. Nothing is deleted.
                    </p>
                  </>
                )}
                <p className="rounded border bg-muted/40 px-2 py-1 font-mono text-[11px]">
                  {entry.transactionDate} · {entry.description || 'journal entry'}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(ev) => {
                // Held open until the server answers, so a refusal is read
                // in place instead of the dialog vanishing on a failure.
                ev.preventDefault();
                const done = (title: string, description: string) => {
                  setOpen(false);
                  onDone();
                  toast({ title, description });
                };
                const failed = (title: string) => (err: any) =>
                  toast({ title, description: err.message, variant: 'destructive' });

                if (isDraft) {
                  remove.mutate({ id: entry.id }, {
                    onSuccess: () => done(`Deleted ${entry.entryNumber}`, 'The draft and its lines are gone. Nothing was posted, so no balance moved.'),
                    onError: failed(`Could not delete ${entry.entryNumber}`),
                  });
                } else {
                  reverse.mutate({ id: entry.id }, {
                    onSuccess: (res) => done(`Reversed ${entry.entryNumber}`, `Posted ${res.reversalEntryNumber} as its mirror. Both entries stay in the books.`),
                    onError: failed(`Could not reverse ${entry.entryNumber}`),
                  });
                }
              }}
            >
              {busy ? (isDraft ? 'Deleting…' : 'Reversing…') : isDraft ? 'Delete draft' : 'Post reversal'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function JournalEntryPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canPost = can('post');
  const canWriteCoa = can('coa.write');
  const createEntry = useCreateJournalEntry();

  const { data: entitiesData } = useListEntities();
  const entities = useMemo(() => (entitiesData || []) as any[], [entitiesData]);
  const { data: accountsData } = useListAccounts();
  const accounts = useMemo(() => (accountsData || []) as any[], [accountsData]);
  const { data: recentData } = useListJournalEntries();
  const manualEntries = useMemo(
    () => ((recentData || []) as any[]).filter((e) => e.source === 'ManualJournal'),
    [recentData],
  );
  const recent = useMemo(() => manualEntries.slice(0, 15), [manualEntries]);
  // originalId -> the reversal that already cancels it. Built from the
  // [REVERSAL-OF-n] tag in the reference (there is no column for it), so a
  // reversed entry can say so and stop offering to reverse it again.
  const reversalByOriginalId = useMemo(() => {
    const map = new Map<number, any>();
    for (const e of manualEntries) {
      const m = String(e.reference || '').match(/\[REVERSAL-OF-(\d+)\]/);
      if (m && e.status === 'Posted') map.set(Number(m[1]), e);
    }
    return map;
  }, [manualEntries]);

  const defaultEntityId = entities[0] ? String(entities[0].id) : '';
  const [transactionDate, setTransactionDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<JeLine[]>(() => [newLine(), newLine()]);
  const [newCategory, setNewCategory] = useState<{ lineId: string; entityId: string; name: string } | null>(null);

  // Configured rates for the entry's month, fetched per currency from the
  // same resolver the posting engine uses — so the pre-filled rate is what
  // would post. A typed rate overrides it.
  const period = transactionDate.slice(0, 7);
  const [rateDefaults, setRateDefaults] = useState<Record<string, { rate: number; found: boolean; source: string; effectiveMonth?: string }>>({});
  const foreignCurrencies = useMemo(
    () => [...new Set(lines.map((l) => l.currency).filter((c) => c && c !== 'USD'))],
    [lines],
  );
  React.useEffect(() => {
    let cancelled = false;
    for (const currency of foreignCurrencies) {
      const key = `${currency}|${period}`;
      if (rateDefaults[key]) continue;
      fetchExchangeRate(currency, transactionDate)
        .then((r) => {
          if (cancelled) return;
          setRateDefaults((prev) => ({ ...prev, [key]: { rate: r.rate, found: r.found, source: r.source, effectiveMonth: r.effectiveMonth } }));
          // Fill the rate on lines still holding the default (never on one
          // the user has typed into).
          if (r.found) {
            setLines((prev) => prev.map((l) => (l.currency === currency && !l.rateTouched ? { ...l, rate: String(Number(r.rate.toFixed(6))) } : l)));
          }
        })
        .catch(() => { /* leave it unset — the line shows "no rate" */ });
    }
    return () => { cancelled = true; };
  }, [foreignCurrencies, period, transactionDate, rateDefaults]);

  const defaultRateFor = (currency: string) => (currency === 'USD' ? { rate: 1, found: true, source: 'usd' } : rateDefaults[`${currency}|${period}`]);
  /** The rate this line would post at: typed override, else the configured rate. */
  const rateOf = (l: JeLine) => {
    if (l.currency === 'USD') return 1;
    if (l.rate.trim() !== '') return Number(l.rate);
    return defaultRateFor(l.currency)?.rate ?? NaN;
  };
  const usdCentsOf = (l: JeLine, side: 'debit' | 'credit') => {
    const rate = rateOf(l);
    if (!Number.isFinite(rate) || rate <= 0) return 0;
    return Math.round(toCents(l[side]) * rate);
  };
  const multiCurrency = foreignCurrencies.length > 0;
  const columnDefs = multiCurrency ? FX_COLUMNS : BASE_COLUMNS;
  const baseColumns = useResizableColumns('finsys.journal-entry.columns.v2', BASE_WIDTHS);
  const fxColumns = useResizableColumns('finsys.journal-entry.fx-columns.v1', FX_WIDTHS);
  const columns = multiCurrency ? fxColumns : baseColumns;

  // Seed the entity once the list arrives.
  React.useEffect(() => {
    if (!defaultEntityId) return;
    setLines((prev) => prev.map((l) => (l.entityId ? l : { ...l, entityId: defaultEntityId })));
  }, [defaultEntityId]);

  const update = (id: string, patch: Partial<JeLine>) =>
    setLines((prev) => prev.map((l) => {
      if (l.id !== id) return l;
      const next = { ...l, ...patch };
      // A line is one-sided: typing in one column clears the other.
      if (patch.debit !== undefined && patch.debit !== '') next.credit = '';
      if (patch.credit !== undefined && patch.credit !== '') next.debit = '';
      // A new currency re-pulls its configured rate (see the effect below).
      if (patch.currency !== undefined) {
        next.rate = patch.currency === 'USD' ? '' : (defaultRateFor(patch.currency)?.rate ? String(Number(defaultRateFor(patch.currency)!.rate.toFixed(6))) : '');
        next.rateTouched = false;
      }
      if (patch.rate !== undefined) next.rateTouched = true;
      // Changing the entity drops an account that entity can't book.
      if (patch.entityId !== undefined && next.accountId) {
        const account = accounts.find((a) => String(a.id) === String(next.accountId));
        if (account && account.entityId != null && String(account.entityId) !== String(next.entityId)) next.accountId = '';
      }
      return next;
    }));

  const addLine = () => setLines((prev) => [...prev, newLine({ entityId: prev[prev.length - 1]?.entityId || defaultEntityId })]);
  const removeLine = (id: string) => setLines((prev) => (prev.length > 2 ? prev.filter((l) => l.id !== id) : prev));

  // Balancing is judged on the CONVERTED USD amounts (the server re-checks).
  const totalDebit = lines.reduce((s, l) => s + usdCentsOf(l, 'debit'), 0);
  const totalCredit = lines.reduce((s, l) => s + usdCentsOf(l, 'credit'), 0);
  const difference = totalDebit - totalCredit;
  const missingRate = lines.some((l) => l.currency !== 'USD' && !(rateOf(l) > 0));
  const balanced = difference === 0 && totalDebit > 0 && !missingRate;

  // Per-entity balance — a journal entry belongs to one set of books.
  const perEntity = useMemo(() => {
    const map = new Map<string, { debit: number; credit: number }>();
    for (const l of lines) {
      if (!l.entityId) continue;
      const acc = map.get(l.entityId) || { debit: 0, credit: 0 };
      acc.debit += usdCentsOf(l, 'debit');
      acc.credit += usdCentsOf(l, 'credit');
      map.set(l.entityId, acc);
    }
    return [...map.entries()].map(([entityId, v]) => ({
      entityId,
      name: entityLabel(entities.find((e) => String(e.id) === entityId)?.name || `Entity ${entityId}`),
      ...v,
      balanced: v.debit === v.credit,
    }));
  }, [lines, entities]);
  const entityImbalance = perEntity.filter((e) => !e.balanced);

  const incomplete = lines.some((l) => !l.accountId || !l.entityId || (toCents(l.debit) === 0 && toCents(l.credit) === 0));
  const canSubmit = canPost && balanced && entityImbalance.length === 0 && !incomplete && !createEntry.isPending;

  const post = () => {
    if (!canSubmit) return;
    createEntry.mutate(
      {
        transactionDate,
        reference: reference.trim(),
        description: description.trim(),
        lines: lines.map((l) => ({
          accountId: Number(l.accountId),
          entityId: Number(l.entityId),
          // Native amounts, with the currency and the exact rate shown on
          // screen — so what posts is what the sheet converted.
          debit: toCents(l.debit) / 100,
          credit: toCents(l.credit) / 100,
          currency: l.currency,
          ...(l.currency === 'USD' ? {} : { exchangeRate: rateOf(l) }),
          description: l.description.trim(),
        })),
      },
      {
        onSuccess: (res) => {
          toast({
            title: `Posted ${res.entryNumbers.join(', ')}`,
            description: res.entryNumbers.length > 1 ? 'One balanced entry per entity.' : undefined,
          });
          // Ledger-derived views (COA balances, GL, reports) refresh now.
          invalidateLedgerDerivedQueries(queryClient);
          setLines([newLine({ entityId: defaultEntityId }), newLine({ entityId: defaultEntityId })]);
          setReference('');
          setDescription('');
        },
        onError: (err: any) => toast({ title: 'Could not post the entry', description: err.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <>
      <PageHeader title="New Journal Entry" description="Post a balanced entry straight to the General Ledger">
        <Button onClick={post} disabled={!canSubmit} data-post-journal-entry>
          {createEntry.isPending ? 'Posting…' : 'Post Journal Entry'}
        </Button>
      </PageHeader>

      <PageContent>
        {!canPost && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-readonly-banner>
            Read-only access — a Manager or Admin posts journal entries.
          </div>
        )}

        <SurfaceCard padded={false}>
          <div className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Date</span>
              <Input type="date" value={transactionDate} onChange={(e) => setTransactionDate(e.target.value)} className="h-9 w-40" aria-label="Date" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Reference # <span className="font-normal text-gray-400">(optional)</span></span>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. ADJ-2026-04" className="h-9 w-48" aria-label="Reference" />
            </label>
            <label className="block flex-1 min-w-[220px]">
              <span className="mb-1 block text-xs font-medium">Description <span className="font-normal text-gray-400">(optional)</span></span>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this entry records" className="h-9" aria-label="Description" />
            </label>
          </div>

          <div className="overflow-x-auto">
            <Table className="table-fixed [&_td]:overflow-hidden [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-4 [&_th:first-child]:pl-4" style={columns.tableStyle} data-resizable-table="journal-entry">
              <ResizableColGroup widths={columns.widths} />
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ResizableHeaderCells columns={columnDefs} table={columns} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, idx) => (
                  <TableRow key={l.id} data-je-line={idx + 1}>
                    <TableCell>
                      <GLAccountSelect
                        accounts={accounts}
                        value={l.accountId}
                        onChange={(v) => update(l.id, { accountId: v })}
                        entityId={l.entityId ? Number(l.entityId) : null}
                        className="w-full"
                        placeholder="Account"
                        disabled={!canPost}
                        onCreateNew={canWriteCoa ? (typed) => setNewCategory({ lineId: l.id, entityId: l.entityId, name: typed }) : undefined}
                      />
                    </TableCell>
                    <TableCell>
                      <Select value={l.entityId} onValueChange={(v) => update(l.id, { entityId: v })} disabled={!canPost}>
                        <SelectTrigger className="h-8 w-full px-2 text-xs" aria-label={`Line ${idx + 1} entity`}><SelectValue placeholder="Entity" /></SelectTrigger>
                        <SelectContent>
                          {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    {/* Currency — USD by default; a foreign one reveals the
                        line's rate and its converted USD amounts. */}
                    <TableCell>
                      <Select value={l.currency} onValueChange={(v) => update(l.id, { currency: v })} disabled={!canPost}>
                        <SelectTrigger className="h-8 w-full px-2 text-xs" aria-label={`Line ${idx + 1} currency`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number" inputMode="decimal" min="0" step="0.01"
                        value={l.debit}
                        onChange={(e) => update(l.id, { debit: e.target.value })}
                        placeholder="0.00"
                        className="h-8 text-right font-mono text-xs"
                        aria-label={`Line ${idx + 1} debit`}
                        disabled={!canPost}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number" inputMode="decimal" min="0" step="0.01"
                        value={l.credit}
                        onChange={(e) => update(l.id, { credit: e.target.value })}
                        placeholder="0.00"
                        className="h-8 text-right font-mono text-xs"
                        aria-label={`Line ${idx + 1} credit`}
                        disabled={!canPost}
                      />
                    </TableCell>
                    {/* Rate + converted USD, once any line is foreign. */}
                    {multiCurrency && (
                      <>
                        <TableCell>
                          {l.currency === 'USD' ? (
                            <div className="text-right font-mono text-xs text-muted-foreground" data-line-rate="1">1.0000</div>
                          ) : (
                            <Input
                              type="number" inputMode="decimal" min="0" step="0.000001"
                              value={l.rate}
                              onChange={(e) => update(l.id, { rate: e.target.value })}
                              placeholder={defaultRateFor(l.currency)?.rate ? String(Number(defaultRateFor(l.currency)!.rate.toFixed(6))) : 'rate'}
                              className={`h-8 text-right font-mono text-xs ${!(rateOf(l) > 0) ? 'border-red-400' : ''}`}
                              aria-label={`Line ${idx + 1} exchange rate`}
                              title={defaultRateFor(l.currency)?.found
                                ? `Configured ${l.currency} rate for ${defaultRateFor(l.currency)!.effectiveMonth ?? period} — type to override`
                                : `No ${l.currency} rate configured for ${period} — enter one`}
                              data-line-rate={rateOf(l) > 0 ? rateOf(l) : ''}
                              disabled={!canPost}
                            />
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums" data-usd-debit={usdCentsOf(l, 'debit') / 100}>
                          {toCents(l.debit) > 0 ? money(usdCentsOf(l, 'debit')) : <span className="text-muted-foreground/60">-</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums" data-usd-credit={usdCentsOf(l, 'credit') / 100}>
                          {toCents(l.credit) > 0 ? money(usdCentsOf(l, 'credit')) : <span className="text-muted-foreground/60">-</span>}
                        </TableCell>
                      </>
                    )}
                    <TableCell>
                      <Input
                        value={l.description}
                        onChange={(e) => update(l.id, { description: e.target.value })}
                        placeholder={description ? `Defaults to "${description}"` : 'Line memo'}
                        className="h-8 text-xs"
                        aria-label={`Line ${idx + 1} description`}
                        disabled={!canPost}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 min-h-7 text-muted-foreground hover:text-destructive"
                        onClick={() => removeLine(l.id)}
                        disabled={lines.length <= 2 || !canPost}
                        aria-label={`Remove line ${idx + 1}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <Button variant="outline" size="sm" onClick={addLine} disabled={!canPost} data-add-je-line>
              <PlusCircle className="mr-2 size-3.5" /> Add Line
            </Button>
            {/* Live debit / credit validation, on the converted USD figures. */}
            <div
              className={`flex flex-wrap items-center gap-4 rounded-md border px-3 py-2 font-mono text-xs ${balanced && entityImbalance.length === 0 ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}
              data-je-balanced={balanced && entityImbalance.length === 0}
              data-je-difference={difference}
            >
              <span>{multiCurrency ? 'USD Debits' : 'Debits'} <span className="font-semibold">{money(totalDebit)}</span></span>
              <span>{multiCurrency ? 'USD Credits' : 'Credits'} <span className="font-semibold">{money(totalCredit)}</span></span>
              <span className={balanced ? 'text-green-700' : 'font-semibold text-red-700'}>
                {missingRate ? 'Enter a rate' : balanced ? 'Balanced ✓' : `Out by ${money(Math.abs(difference))}`}
              </span>
            </div>
          </div>

          {multiCurrency && (
            <div className="border-t px-4 py-2 text-[11px] text-muted-foreground" data-je-fx-note>
              {foreignCurrencies.map((c) => {
                const d = defaultRateFor(c);
                const total = lines.filter((l) => l.currency === c).reduce((s, l) => s + toCents(l.debit) + toCents(l.credit), 0);
                return (
                  <span key={c} className="mr-3">
                    {native(total, c)} at {d?.found ? `the configured ${d.effectiveMonth ?? period} rate` : 'a rate you enter'}
                    {d && !d.found ? ' (none configured)' : ''} ·
                  </span>
                );
              })}
              <span>Balancing and the ledger use the converted USD amounts; each line stores its currency, native amount and rate.</span>
            </div>
          )}

          {entityImbalance.length > 0 && (
            <div className="border-t px-4 py-2 text-xs text-red-700" data-je-entity-imbalance>
              Each entity's own lines must balance:{' '}
              {entityImbalance.map((e) => `${e.name} is out by ${money(Math.abs(e.debit - e.credit))}`).join('; ')}. Use a Due From / To Affiliates line to move value between entities.
            </div>
          )}
          {perEntity.length > 1 && entityImbalance.length === 0 && (
            <div className="border-t px-4 py-2 text-[11px] text-muted-foreground" data-je-multi-entity>
              {perEntity.length} entities on this sheet — one balanced entry is posted per entity.
            </div>
          )}
        </SurfaceCard>

        {recent.length > 0 && (
          <SurfaceCard>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manual journal entries</div>
              <div className="text-[11px] text-muted-foreground">
                Posted entries are corrected by posting a reversal, never by editing or deleting them.
              </div>
            </div>
            <div className="overflow-x-auto">
              <Table className="table-fixed min-w-[760px]">
                <colgroup>
                  <col className="w-[96px]" />
                  <col className="w-[128px]" />
                  <col className="w-[120px]" />
                  <col />
                  <col className="w-[84px]" />
                  <col className="w-[96px]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Entry #</TableHead>
                    <TableHead className="text-xs">Entity</TableHead>
                    <TableHead className="text-xs">Description</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((e) => {
                    const isReversal = /\[REVERSAL-OF-\d+\]/.test(String(e.reference || ''));
                    const reversedBy = reversalByOriginalId.get(e.id);
                    return (
                      <TableRow key={e.id} data-recent-entry={e.entryNumber}>
                        <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">{e.transactionDate}</TableCell>
                        <TableCell className="font-mono text-xs font-medium whitespace-nowrap truncate">{e.entryNumber}</TableCell>
                        <TableCell className="truncate">
                          <Badge variant="outline" className="border-transparent bg-muted text-[10px]">
                            {entityLabel(entities.find((x) => x.id === e.entityId)?.name || `Entity ${e.entityId}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="min-w-0 text-xs text-muted-foreground">
                          <div className="truncate" title={e.description}>{e.description}</div>
                        </TableCell>
                        <TableCell>
                          {/* A reversed entry is still Posted — the books
                              keep both halves — so the status column says
                              which half this is rather than implying the
                              original went away. */}
                          {e.status !== 'Posted' ? (
                            <Badge variant="outline" className="text-[10px]">{e.status}</Badge>
                          ) : isReversal ? (
                            <Badge variant="outline" className="border-transparent bg-amber-50 text-[10px] text-amber-800">Reversal</Badge>
                          ) : reversedBy ? (
                            <Badge variant="outline" className="border-transparent bg-slate-100 text-[10px] text-slate-700" title={`Reversed by ${reversedBy.entryNumber}`}>Reversed</Badge>
                          ) : (
                            <Badge variant="outline" className="border-transparent bg-emerald-50 text-[10px] text-emerald-800">Posted</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <JournalEntryAction
                            entry={e}
                            isReversal={isReversal}
                            reversedByEntryNumber={reversedBy?.entryNumber}
                            onDone={() => invalidateLedgerDerivedQueries(queryClient)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </SurfaceCard>
        )}
      </PageContent>

      {newCategory && (
        <QuickAccountDialog
          key={`je-category-${newCategory.lineId}-${newCategory.name}`}
          open={!!newCategory}
          onOpenChange={(o) => { if (!o) setNewCategory(null); }}
          entities={entities}
          defaultEntityId={newCategory.entityId}
          defaultName={newCategory.name}
          onCreated={(account) => {
            const line = lines.find((l) => l.id === newCategory.lineId);
            if (line && (account.entityId == null || String(account.entityId) === String(line.entityId))) {
              update(newCategory.lineId, { accountId: String(account.id) });
            }
          }}
        />
      )}
    </>
  );
}
