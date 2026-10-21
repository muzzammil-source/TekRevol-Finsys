import React, { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { fetchExchangeRate, fetchJournalEntry, getListContactsQueryKey, useCreateContact, useCreateJournalEntry, useDeleteJournalEntry, useListAccounts, useListContacts, useListEntities, useListJournalEntries, useReverseJournalEntry, type Contact, type ContactType } from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { CURRENCIES, entityLabel } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import { GLAccountSelect } from '@/components/gl-account-select';
import { ContactSelect } from '@/components/contact-select';
import { QuickAccountDialog } from '@/components/quick-account-dialog';
import { ResizableColGroup, ResizableHeaderCells, defaultWidths, useResizableColumns, type ResizableColumnDef } from '@/components/resizable-columns';
import { invalidateLedgerDerivedQueries } from '@/lib/ledger-queries';
import { MoreHorizontal, Pencil, PlusCircle, Trash2, Undo2 } from 'lucide-react';

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
  { key: 'fromTo', label: 'From / To', width: 170 },
  { key: 'currency', label: 'Currency', width: 95 },
  { key: 'debit', label: 'Debit', width: 120, align: 'right' },
  { key: 'credit', label: 'Credit', width: 120, align: 'right' },
  { key: 'description', label: 'Description / Line Memo', width: 200 },
  { key: 'remove', label: '', width: 44, resizable: false },
];
const FX_COLUMNS: ResizableColumnDef[] = [
  { key: 'account', label: 'Account', width: 200 },
  { key: 'entity', label: 'Entity', width: 120 },
  { key: 'fromTo', label: 'From / To', width: 150 },
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
  /** Sub-ledger tag: the Customer/Vendor this line settles, if any. Only
      the line that actually hits A/R, A/P or the party's own account is
      tagged — never the cash or clearing side (see the contacts notes in
      server/index.ts). */
  contactId?: string;
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
  contactId: '',
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

// Row actions for ONE manual journal entry (2026-10-21), grouped into a
// single menu. Lives only on this screen: a JV is entered here, so it is
// corrected here. Bank-feed postings are undone on the banking screen and
// bills/invoices are voided from their own, because each of those has a
// record alongside the entry that has to move with it — the server refuses
// them too, this is not just a UI choice.
//
// What the menu offers depends on whether the entry is in the books:
//   Draft  → Edit (load it back into the form) · Delete (it was never posted)
//   Posted → Edit (reverse it, then re-enter the corrected version) · Reverse
//
// "Edit" on a Posted entry cannot mean editing it: a posted entry is the
// book of record and its lines are immutable. It means the two-step a
// bookkeeper would do by hand — post the mirror, then post the corrected
// entry — so the books show what was entered, that it was cancelled, and
// what replaced it.
function JournalEntryActions({
  entry,
  isReversal,
  reversedByEntryNumber,
  onEditDraft,
  onEditPosted,
  onDone,
}: {
  entry: any;
  isReversal: boolean;
  reversedByEntryNumber?: string;
  onEditDraft: (entry: any) => void;
  onEditPosted: (entry: any) => void;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState<null | 'reverse' | 'delete' | 'edit-posted'>(null);
  const { toast } = useToast();
  const { can } = useAuth();
  const reverse = useReverseJournalEntry();
  const remove = useDeleteJournalEntry();

  const isDraft = entry.status !== 'Posted';
  const busy = reverse.isPending || remove.isPending;
  // Posting is what a reversal does, so the same capability gates all of
  // this. Without it the column is simply empty rather than offering a 403.
  if (!can('post')) return null;
  // Already-corrected entries have nothing left to do: reversing a reversal
  // only re-posts the original, and reversing twice is refused server-side.
  if (!isDraft && (isReversal || reversedByEntryNumber)) {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        title={reversedByEntryNumber ? `Reversed by ${reversedByEntryNumber}` : 'This entry is a reversal'}
        data-jv-no-actions={entry.entryNumber}
      >
        —
      </span>
    );
  }

  const failed = (title: string) => (err: any) =>
    toast({ title, description: err.message, variant: 'destructive' });

  const runReverse = (then?: (res: any) => void) =>
    reverse.mutate(
      { id: entry.id },
      {
        onSuccess: (res) => {
          setConfirming(null);
          onDone();
          if (then) then(res);
          else
            toast({
              title: `Reversed ${entry.entryNumber}`,
              description: `Posted ${res.reversalEntryNumber} as its mirror. Both entries stay in the books.`,
            });
        },
        onError: failed(`Could not reverse ${entry.entryNumber}`),
      },
    );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground"
            disabled={busy}
            aria-label={`Actions for ${entry.entryNumber}`}
            data-jv-actions={entry.entryNumber}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {isDraft ? (
            <>
              <DropdownMenuItem onSelect={() => onEditDraft(entry)} data-jv-menu="edit-draft">
                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit draft
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(ev) => { ev.preventDefault(); setConfirming('delete'); }}
                className="text-rose-700 focus:text-rose-700"
                data-jv-menu="delete"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete draft
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem
                onSelect={(ev) => { ev.preventDefault(); setConfirming('edit-posted'); }}
                data-jv-menu="edit-posted"
              >
                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit (reverse &amp; re-enter)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(ev) => { ev.preventDefault(); setConfirming('reverse'); }}
                data-jv-menu="reverse"
              >
                <Undo2 className="mr-2 h-3.5 w-3.5" /> Reverse
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming !== null} onOpenChange={(o) => { if (!o) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === 'delete' && `Delete draft ${entry.entryNumber}?`}
              {confirming === 'reverse' && `Reverse ${entry.entryNumber}?`}
              {confirming === 'edit-posted' && `Edit ${entry.entryNumber} by reversing it?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {confirming === 'delete' && (
                  <p>This draft was never posted, so nothing in the books changes. It is removed along with its lines.</p>
                )}
                {confirming === 'reverse' && (
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
                {confirming === 'edit-posted' && (
                  <>
                    <p>
                      A posted entry can't be edited in place — it is the book of record. This does the two
                      steps a correction actually takes:
                    </p>
                    <ol className="ml-4 list-decimal space-y-1 text-muted-foreground">
                      <li>posts a mirror entry now, cancelling {entry.entryNumber};</li>
                      <li>loads its lines into the form above so you can adjust them and post the corrected entry.</li>
                    </ol>
                    <p className="text-muted-foreground">
                      The reversal posts immediately. Nothing replaces it until you post the form, so the books
                      are left net-zero for this entry in the meantime.
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
                if (confirming === 'delete') {
                  remove.mutate(
                    { id: entry.id },
                    {
                      onSuccess: () => {
                        setConfirming(null);
                        onDone();
                        toast({ title: `Deleted ${entry.entryNumber}`, description: 'The draft and its lines are gone. Nothing was posted, so no balance moved.' });
                      },
                      onError: failed(`Could not delete ${entry.entryNumber}`),
                    },
                  );
                } else if (confirming === 'reverse') {
                  runReverse();
                } else {
                  // Reverse first: if it is refused, nothing has been loaded
                  // into the form and the books are untouched.
                  runReverse((res) => {
                    onEditPosted(entry);
                    toast({
                      title: `Reversed ${entry.entryNumber} — now edit and post`,
                      description: `${res.reversalEntryNumber} cancels it. Its lines are in the form above; adjust them and post the corrected entry.`,
                    });
                  });
                }
              }}
            >
              {busy
                ? 'Working…'
                : confirming === 'delete'
                  ? 'Delete draft'
                  : confirming === 'reverse'
                    ? 'Post reversal'
                    : 'Reverse and edit'}
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
  // Retires the draft a form edit replaces (see the post handler).
  const deleteEntry = useDeleteJournalEntry();

  const { data: entitiesData } = useListEntities();
  const entities = useMemo(() => (entitiesData || []) as any[], [entitiesData]);
  const { data: accountsData } = useListAccounts();
  const accounts = useMemo(() => (accountsData || []) as any[], [accountsData]);
  // All active contacts; each line's picker scopes them to that line's
  // entity, exactly as the pending bank feed does.
  const { data: contactsData } = useListContacts();
  const contacts = useMemo(() => (contactsData || []) as Contact[], [contactsData]);
  const createContact = useCreateContact();
  const canWriteContacts = can('contacts.write');
  // Quick-create from a picker, owned by the entity whose ledger the line
  // lands in. Written into the cache immediately so the new party shows as
  // selected without waiting for the refetch.
  const handleCreateContact = (entityId: string) => async (name: string, contactType: ContactType): Promise<Contact> => {
    try {
      const created = await createContact.mutateAsync({ name, contactType, entityId: entityId ? Number(entityId) : null });
      queryClient.setQueryData<Contact[]>(getListContactsQueryKey(), (old) => [...(old || []), created]);
      queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
      toast({ title: `${contactType} “${created.name}” added` });
      return created;
    } catch (err: any) {
      toast({ title: 'Could not add contact', description: err.message, variant: 'destructive' });
      throw err;
    }
  };

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

  // The draft this form is editing, if any. Set only by "Edit draft": the
  // posted-entry correction loads the same lines but posts a NEW entry, so
  // it deliberately leaves this null.
  const [editingDraft, setEditingDraft] = useState<{ id: number; entryNumber: string } | null>(null);
  const formRef = React.useRef<HTMLDivElement | null>(null);

  // The entry's entity. Lines may still differ (a cross-entity sheet posts
  // one balanced entry per entity), so this drives them rather than locking
  // them: changing it moves every line still sitting on the old value.
  const [headerEntityId, setHeaderEntityId] = useState('');
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
  const baseColumns = useResizableColumns('finsys.journal-entry.columns.v3', BASE_WIDTHS);
  const fxColumns = useResizableColumns('finsys.journal-entry.fx-columns.v2', FX_WIDTHS);
  const columns = multiCurrency ? fxColumns : baseColumns;

  // Seed the entity once the list arrives.
  React.useEffect(() => {
    if (!defaultEntityId) return;
    setLines((prev) => prev.map((l) => (l.entityId ? l : { ...l, entityId: defaultEntityId })));
    setHeaderEntityId((prev) => prev || defaultEntityId);
  }, [defaultEntityId]);

  // A line left on the old entity would post to different books than the
  // header says, so the two are kept together.
  const previousHeaderEntity = React.useRef(headerEntityId);
  React.useEffect(() => {
    const before = previousHeaderEntity.current;
    previousHeaderEntity.current = headerEntityId;
    if (!headerEntityId || !before || before === headerEntityId) return;
    setLines((prev) => prev.map((l) => (l.entityId === before ? dropMismatchedRefs({ ...l, entityId: headerEntityId }) : l)));
    // dropMismatchedRefs reads the latest accounts/contacts; re-running on
    // their identity would re-fire this sync, so only the entity is watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerEntityId]);

  /** Clears an account or contact that this line's entity may not use. */
  const dropMismatchedRefs = (line: JeLine): JeLine => {
    const next = { ...line };
    if (next.accountId) {
      const account = accounts.find((a) => String(a.id) === String(next.accountId));
      if (account && account.entityId != null && String(account.entityId) !== String(next.entityId)) next.accountId = '';
    }
    if (next.contactId) {
      const contact = contacts.find((c) => String(c.id) === String(next.contactId));
      if (contact && contact.entityId != null && String(contact.entityId) !== String(next.entityId)) next.contactId = '';
    }
    return next;
  };

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
      // Changing the entity drops an account or contact that entity can't
      // use. Shared by the header-entity sync below, which moves lines
      // without going through this function — a line left tagged with
      // another entity's customer would be refused on posting, or worse,
      // move a sub-ledger balance that never belonged to it.
      if (patch.entityId !== undefined) return dropMismatchedRefs(next);
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

  /**
   * Pulls one entry's lines back into the form.
   *
   * `asDraftEdit` decides what posting the form then means: editing a draft
   * replaces it (the draft is deleted once the new entry posts), while a
   * posted entry has already been reversed by the time this runs, so the
   * form is simply a fresh entry that happens to start from its lines.
   *
   * Contact tags ARE carried across now that each line has a From / To
   * field: they are visible on screen, so a correction keeps the party's
   * sub-ledger balance moving with it instead of silently stranding it.
   */
  const loadIntoForm = async (entry: any, { asDraftEdit }: { asDraftEdit: boolean }) => {
    try {
      const full = await fetchJournalEntry(entry.id);
      setTransactionDate(asDraftEdit ? full.transactionDate : format(new Date(), 'yyyy-MM-dd'));
      setReference(String(full.reference || '').replace(/\[REVERSAL-OF-\d+\]\s*/, '').trim());
      setDescription(asDraftEdit ? full.description : `Correction of ${full.entryNumber} — ${full.description || 'journal entry'}`);
      setLines(
        full.lines.map((l) =>
          newLine({
            accountId: String(l.accountId),
            // A Shared account carries no entity of its own, so the line
            // keeps the entry's.
            entityId: String(l.accountEntityId ?? full.entityId),
            description: String(l.memo || ''),
            debit: l.debit ? String(l.debit) : '',
            credit: l.credit ? String(l.credit) : '',
            currency: l.currency || 'USD',
            // Stamped rate, marked as touched so the month's configured rate
            // is not filled in over it — a correction posts at the rate the
            // original used.
            rate: l.currency && l.currency !== 'USD' ? String(l.exchangeRate ?? '') : '',
            rateTouched: Boolean(l.currency && l.currency !== 'USD'),
            contactId: l.contactId ? String(l.contactId) : '',
          }),
        ),
      );
      setHeaderEntityId(String(full.entityId));
      setEditingDraft(asDraftEdit ? { id: full.id, entryNumber: full.entryNumber } : null);
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (asDraftEdit) {
        toast({ title: `Editing draft ${full.entryNumber}`, description: 'Posting replaces the draft. Use Cancel to leave it untouched.' });
      }
    } catch (err: any) {
      toast({ title: 'Could not load that entry', description: err.message, variant: 'destructive' });
    }
  };

  /** Leaves an in-progress draft edit without touching the draft. */
  const cancelDraftEdit = () => {
    setEditingDraft(null);
    setLines([newLine({ entityId: defaultEntityId }), newLine({ entityId: defaultEntityId })]);
    setReference('');
    setDescription('');
    setTransactionDate(format(new Date(), 'yyyy-MM-dd'));
  };

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
          // The sub-ledger tag, so the party's balance — derived from
          // tagged Posted lines — moves with this entry.
          ...(l.contactId ? { contactId: Number(l.contactId) } : {}),
          description: l.description.trim(),
        })),
      },
      {
        onSuccess: (res) => {
          toast({
            title: `Posted ${res.entryNumbers.join(', ')}`,
            description: res.entryNumbers.length > 1 ? 'One balanced entry per entity.' : undefined,
          });
          // The draft this form was editing is replaced by what just
          // posted, so it is removed now. Deliberately AFTER the post
          // succeeds: if the post is refused, the draft is still there to
          // come back to. A delete that fails leaves a stray draft, which
          // is visible on this screen and in nobody's books — the opposite
          // order could lose the entry entirely.
          if (editingDraft) {
            const draft = editingDraft;
            setEditingDraft(null);
            deleteEntry.mutate(
              { id: draft.id },
              {
                onError: (err: any) =>
                  toast({
                    title: `Posted, but draft ${draft.entryNumber} is still listed`,
                    description: `${err.message} It was never posted, so no balance is affected — delete it from the table when you can.`,
                    variant: 'destructive',
                  }),
              },
            );
          }
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
      <PageHeader
        title={editingDraft ? `Editing draft ${editingDraft.entryNumber}` : 'New Journal Entry'}
        description={editingDraft ? 'Posting replaces the draft with what you enter here' : 'Post a balanced entry straight to the General Ledger'}
      >
        {editingDraft && (
          <Button variant="outline" onClick={cancelDraftEdit} disabled={createEntry.isPending} data-cancel-draft-edit>
            Cancel edit
          </Button>
        )}
        <Button onClick={post} disabled={!canSubmit} data-post-journal-entry>
          {createEntry.isPending ? 'Posting…' : editingDraft ? 'Post & replace draft' : 'Post Journal Entry'}
        </Button>
      </PageHeader>

      <PageContent>
        <div ref={formRef} />
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
            <label className="block w-44" data-je-header-entity>
              <span className="mb-1 block text-xs font-medium">Entity</span>
              <Select value={headerEntityId} onValueChange={setHeaderEntityId} disabled={!canPost}>
                <SelectTrigger className="h-9 w-full px-2 text-xs" aria-label="Entity"><SelectValue placeholder="Entity" /></SelectTrigger>
                <SelectContent>
                  {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                </SelectContent>
              </Select>
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
                    {/* From / To — the Customer or Vendor this line settles,
                        the same picker and placement the pending bank feed
                        uses. Tag only the line that actually hits the
                        party's side (A/R, A/P, or the account they relate
                        to); tagging the cash or clearing leg would move a
                        sub-ledger balance that never belonged to them.
                        Scoped to the line's own entity, because a contact
                        must belong to that entity or be Shared. */}
                    <TableCell>
                      <ContactSelect
                        contacts={contacts}
                        entityId={l.entityId ? Number(l.entityId) : null}
                        // Which group is listed first, nothing more: a debit
                        // line is money arriving at this account, so its
                        // counterparty is most often a Customer.
                        direction={l.debit ? 'in' : 'out'}
                        value={l.contactId || ''}
                        onChange={(v) => update(l.id, { contactId: v })}
                        onCreate={handleCreateContact(l.entityId)}
                        canCreate={canWriteContacts}
                        className="w-full min-w-0"
                        placeholder="From/To"
                        disabled={!canPost}
                      />
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
                          <JournalEntryActions
                            entry={e}
                            isReversal={isReversal}
                            reversedByEntryNumber={reversedBy?.entryNumber}
                            onEditDraft={(entry) => loadIntoForm(entry, { asDraftEdit: true })}
                            onEditPosted={(entry) => loadIntoForm(entry, { asDraftEdit: false })}
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
