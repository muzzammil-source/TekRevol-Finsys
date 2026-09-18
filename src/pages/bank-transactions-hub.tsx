import React, { useMemo, useRef, useState } from 'react';
import {
  useListBankAccounts,
  useListEntities,
  useListBrands,
  useListAccounts,
  useUnpostedBankTransactions,
  useListBankTransactions,
  usePostBankTransaction,
  usePostBankTransactionSplit,
  useStageBankTransaction,
  useListSplitRules,
  type SplitRule,
  useListContacts,
  useCreateContact,
  getListContactsQueryKey,
  type Contact,
  type ContactType,
  useBulkPostBankTransactions,
  useImportBankStatement,
  useRefreshBankAccountBalance,
  useSyncPlaidBankAccount,
  useCreateBankAccount,
  useUpdateBankAccount,
  useBankingCards,
  useEnsureBankFeed,
  useUnpostBankTransaction,
  useCreatePlaidLinkToken,
  useExchangePlaidPublicToken,
  usePlaidAccounts,
  getUnpostedBankTransactionsQueryKey,
  getListBankTransactionsQueryKey,
  getListBankAccountsQueryKey,
} from '@workspace/api-client-react';
import { PageContent, PageHeader, SectionLabel } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { entityLabel, CURRENCIES } from '@/lib/constants';
import { CheckCircle2, Link2, PlusCircle, RefreshCw, Send, Split, Trash2, Undo2, UploadCloud } from 'lucide-react';
import { GLAccountSelect } from '@/components/gl-account-select';
import { ContactSelect } from '@/components/contact-select';
import { ContactFormDialog } from '@/components/contact-form-dialog';
import { ResizableColGroup, ResizableHeaderCells, defaultWidths, useResizableColumns, type ResizableColumnDef } from '@/components/resizable-columns';
import { QuickAccountDialog } from '@/components/quick-account-dialog';
import { invalidateLedgerDerivedQueries } from '@/lib/ledger-queries';
import { FeedToolbar, matchesSearch, passesFilters, sortRows, useFeedView, type FeedRowFields, type FeedView } from '@/components/feed-toolbar';
import { useAuth } from '@/lib/auth';
import { detectColumnMapping, parseCsvHeaderLine, type ColumnMapping } from '@/lib/csv-column-mapping';

// Plaid Link's hosted JS SDK — loaded on demand (only when "Connect Bank" is
// actually clicked) rather than unconditionally in index.html, since most
// sessions never touch it and it's a third-party script.
let plaidLinkScriptPromise: Promise<void> | null = null;
function loadPlaidLinkScript(): Promise<void> {
  if ((window as any).Plaid) return Promise.resolve();
  if (plaidLinkScriptPromise) return plaidLinkScriptPromise;
  plaidLinkScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Plaid Link'));
    document.head.appendChild(script);
  });
  return plaidLinkScriptPromise;
}

// GL account types eligible as a posting target for a bank transaction —
// the Title-Case Phase 1.1 GL accounts, minus Cash & Equivalents (that's the
// *other* leg of the entry, resolved automatically from the bank account).
const GL_TARGET_TYPES = new Set(['Asset', 'Liability', 'Equity', 'Revenue', 'Expense']);


function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// Bank amount shown QuickBooks-style as two unsigned columns: money out
// under Spent, money in under Received (the other cell shows "-").
function SpentReceivedCells({ amount, currency }: { amount: number; currency: string }) {
  const value = formatMoney(Math.abs(amount), currency);
  return (
    <>
      <TableCell className="text-right font-mono text-xs tabular-nums whitespace-nowrap" data-spent>
        {amount < 0
          ? <span className="inline-block rounded px-1 py-0.5 bg-tint-negative text-tint-negative-foreground">{value}</span>
          : <span className="text-muted-foreground/60">-</span>}
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums whitespace-nowrap" data-received>
        {amount > 0
          ? <span className="inline-block rounded px-1 py-0.5 bg-tint-positive text-tint-positive-foreground">{value}</span>
          : <span className="text-muted-foreground/60">-</span>}
      </TableCell>
    </>
  );
}

// COA-driven bank card (2026-09-11). One card per active Chart of
// Accounts bank head — the card list IS the COA, there is no separate
// "manual bank" record for a user to create or keep in sync.
//
// The headline figure is the LEDGER balance (posted journal lines, the
// same derivation the COA's own Balance column uses), because that is the
// only balance a manual CSV account has. A Plaid-linked head additionally
// shows what the bank itself reports, on its own line — the two are
// deliberately not merged, since the gap between them is exactly what
// reconciliation exists to close.
//
// Amounts render plainly (e.g. "AED 4,500.00", "$1,250.00") with no
// visibility toggle or icon beside them.
//
// Since 2026-09-17: a balanced 232px 4:3 box (tags / bank + balance /
// unposted), and no per-card "Upload Statement" button. The page header's Upload Statement is
// the single entry point, and it preselects the currently selected card.
function BankAccountCard({
  card,
  entityName,
  onSyncNow,
  syncing,
  selected,
  onSelect,
}: {
  card: any;
  entityName?: string;
  onSyncNow?: () => void;
  syncing?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const unpostedCount = card.unpostedCount || 0;
  const isPlaid = card.connectionType === 'PLAID';
  const hasLive = card.liveBalance !== null && card.liveBalance !== undefined;
  const localCurrency = card.localCurrency || 'USD';
  // Only show the USD line when it would say something different.
  const isForeignCurrency = localCurrency !== 'USD';

  return (
    // Balanced 4:3 box (232 × 174px), 16px padding: tags on top, bank +
    // balance in the middle, unposted count at the bottom.
    // The whole card is the filter control, so it's a button for keyboard
    // and screen-reader users. Sync Now (Plaid only) stops propagation so
    // it doesn't also toggle the filter.
    <div
      role="button"
      tabIndex={0}
      aria-pressed={!!selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(); }
      }}
      data-bank-card={card.code}
      className={`w-[232px] aspect-[4/3] rounded-lg border bg-card p-4 flex flex-col justify-between gap-2 text-left transition-all duration-150 cursor-pointer ${
        selected
          ? 'border-primary ring-1 ring-primary shadow-sm'
          : 'border-border shadow-sm hover:border-input hover:shadow'
      }`}
    >
      {/* Top — entity tag and feed type. */}
      <div className="flex items-center justify-between gap-2">
        <Badge
          variant="outline"
          className={`h-5 min-w-0 truncate rounded px-1.5 py-0 text-[10px] font-medium ${entityName ? 'border-transparent bg-muted text-slate-700' : 'border-border bg-transparent text-muted-foreground'}`}
        >
          {entityName ? entityLabel(entityName) : 'Shared'}
        </Badge>
        <Badge variant="outline" className="h-5 shrink-0 whitespace-nowrap rounded border-border px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
          {isPlaid ? 'Plaid Live' : 'Manual CSV'}
        </Badge>
      </div>

      {/* Middle — bank name and the ledger balance in the account's LOCAL
          currency (its entity's functional currency), derived from the same
          USD ledger balance as the Chart of Accounts. */}
      <div className="min-w-0">
        {/* Bank name only — the COA account code isn't shown on the card. */}
        <div className="truncate text-[13px] font-medium text-foreground">{card.name}</div>
        <div className={`mt-0.5 truncate font-mono text-[19px] font-semibold leading-tight tabular-nums ${card.localBalance < 0 ? 'text-rose-700' : 'text-foreground'}`}>
          {card.localRateFound
            ? formatMoney(card.localBalance, localCurrency)
            : formatMoney(card.ledgerBalanceUsd, 'USD')}
        </div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          Ledger balance
          {isForeignCurrency && (card.localRateFound
            ? <> · ≈ {formatMoney(card.ledgerBalanceUsd, 'USD')}</>
            : <span className="text-amber-700"> · no {localCurrency} rate</span>)}
          {hasLive && <> · Bank {formatMoney(card.liveBalance, card.currency)}</>}
        </div>
      </div>

      {/* Bottom — unposted count (and Sync for live Plaid feeds). */}
      <div className="flex h-5 items-center justify-between gap-2">
        {unpostedCount > 0 ? (
          <Badge variant="outline" className="h-5 whitespace-nowrap rounded border-transparent bg-tint-negative px-1.5 py-0 text-[10px] font-medium text-tint-negative-foreground">
            {unpostedCount} Unposted
          </Badge>
        ) : (
          <span className="text-[10px] text-muted-foreground">All posted</span>
        )}
        {isPlaid && onSyncNow && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded px-1 text-[10px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
            onClick={(e) => { e.stopPropagation(); onSyncNow?.(); }}
            disabled={syncing}
          >
            <RefreshCw className={`size-3 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Syncing…' : 'Sync'}
          </button>
        )}
      </div>
    </div>
  );
}

function UploadStatementModal({
  open,
  onOpenChange,
  cards,
  entities,
  preselectedAccountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: any[];
  entities: any[];
  preselectedAccountId?: number | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const importStatement = useImportBankStatement();
  const ensureFeed = useEnsureBankFeed();
  // Holds the selected COA account id (the head), not a bank_accounts id.
  const [bankAccountId, setBankAccountId] = useState<string>(preselectedAccountId ? String(preselectedAccountId) : '');
  const [entityId, setEntityId] = useState<string>('');

  React.useEffect(() => {
    if (open) {
      setBankAccountId(preselectedAccountId ? String(preselectedAccountId) : '');
      setEntityId('');
    }
  }, [open, preselectedAccountId]);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewRows, setPreviewRows] = useState<string[][] | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[] | null>(null);
  const [autoMapping, setAutoMapping] = useState<ColumnMapping | null>(null);
  const [showManualMapping, setShowManualMapping] = useState(false);
  const [manualDateColumn, setManualDateColumn] = useState('');
  const [manualDescriptionColumn, setManualDescriptionColumn] = useState('');
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('single');
  const [manualAmountColumn, setManualAmountColumn] = useState('');
  const [manualDebitColumn, setManualDebitColumn] = useState('');
  const [manualCreditColumn, setManualCreditColumn] = useState('');
  const [result, setResult] = useState<{ format: string; totalRows: number; inserted: number; duplicatesSkipped: number; errors: { row: number; reason: string }[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isCsv = !!file && /\.csv$/i.test(file.name);

  const reset = () => {
    setFile(null);
    setBankAccountId('');
    setEntityId('');
    setPreviewRows(null);
    setCsvHeaders(null);
    setAutoMapping(null);
    setShowManualMapping(false);
    setManualDateColumn('');
    setManualDescriptionColumn('');
    setAmountMode('single');
    setManualAmountColumn('');
    setManualDebitColumn('');
    setManualCreditColumn('');
    setResult(null);
  };

  const handleFile = async (f: File) => {
    setFile(f);
    setResult(null);
    setAutoMapping(null);
    setCsvHeaders(null);
    setShowManualMapping(false);
    if (/\.csv$/i.test(f.name)) {
      const text = await f.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 6);
      setPreviewRows(lines.map((l) => l.split(',').map((c) => c.trim())));

      const headers = lines[0] ? parseCsvHeaderLine(lines[0]) : [];
      setCsvHeaders(headers);
      const detected = detectColumnMapping(headers);
      if (detected) {
        setAutoMapping(detected);
      } else {
        // Auto-detection failed — pre-fill the manual dropdowns with
        // whatever it could still find, and force the mapping step open.
        setManualDateColumn(headers.find((h) => /date/i.test(h)) || '');
        setManualDescriptionColumn(headers.find((h) => /desc|narrative|particulars|memo|payee|detail/i.test(h)) || '');
        setShowManualMapping(true);
      }
    } else {
      // OFX/QBO preview happens server-side (see server/index.ts parseStatementFile) —
      // there's no cheap client-side equivalent for that format, and neither
      // format needs a column mapping.
      setPreviewRows(null);
    }
  };

  const manualMappingValid =
    !!manualDateColumn &&
    !!manualDescriptionColumn &&
    (amountMode === 'single' ? !!manualAmountColumn : !!manualDebitColumn || !!manualCreditColumn);

  const effectiveMapping: ColumnMapping | null = !isCsv
    ? null
    : autoMapping && !showManualMapping
      ? autoMapping
      : manualMappingValid
        ? {
            dateColumn: manualDateColumn,
            descriptionColumn: manualDescriptionColumn,
            amountColumn: amountMode === 'single' ? manualAmountColumn : undefined,
            debitColumn: amountMode === 'split' ? manualDebitColumn : undefined,
            creditColumn: amountMode === 'split' ? manualCreditColumn : undefined,
          }
        : null;

  // The picker selects a COA bank head. A head only needs an entity when
  // the Chart of Accounts doesn't already scope it to one — every journal
  // entry this import eventually produces has to be booked to a legal
  // entity, so it can't be guessed.
  const selectedCard = cards.find((c) => String(c.accountId) === bankAccountId);
  const needsEntity = !!selectedCard && !selectedCard.entityId;
  const canSubmit = !!file && !!bankAccountId && (!needsEntity || !!entityId) && (!isCsv || !!effectiveMapping);

  const handleSubmit = () => {
    if (!canSubmit || !file || !selectedCard) return;
    // Create (or look up) the feed row that will own these transactions,
    // then import into it. Idempotent, so re-uploading to the same head
    // never creates a second feed.
    ensureFeed.mutate(
      { accountId: selectedCard.accountId, entityId: entityId ? Number(entityId) : undefined },
      {
        onError: (err: any) => toast({ title: 'Could not prepare this account', description: err.message, variant: 'destructive' }),
        onSuccess: (feed: any) => doImport(feed.id),
      },
    );
  };

  const doImport = (resolvedBankAccountId: number) => {
    if (!file) return;
    importStatement.mutate(
      { bankAccountId: resolvedBankAccountId, file, columnMapping: effectiveMapping || undefined },
      {
        onSuccess: (res) => {
          setResult(res);
          queryClient.invalidateQueries({ queryKey: getUnpostedBankTransactionsQueryKey() });
          if (res.inserted > 0) {
            toast({ title: `Imported ${res.inserted} transaction(s)`, description: res.duplicatesSkipped ? `${res.duplicatesSkipped} duplicate(s) skipped` : undefined });
          } else {
            toast({ title: 'No new transactions imported', description: res.duplicatesSkipped ? `${res.duplicatesSkipped} duplicate(s) skipped` : undefined });
          }
        },
        onError: (err: any) => toast({ title: 'Import failed', description: err.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Bank Statement</DialogTitle>
          <DialogDescription>CSV, OFX, or QBO. Duplicate transactions are detected automatically.</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="size-4 text-green-600" />
              Parsed as {result.format.toUpperCase()}
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-md border p-3">
                <div className="text-2xl font-bold">{result.totalRows}</div>
                <div className="text-xs text-muted-foreground">Total Rows</div>
              </div>
              <div className="rounded-md border p-3 border-green-200 bg-green-50">
                <div className="text-2xl font-bold text-green-700">{result.inserted}</div>
                <div className="text-xs text-muted-foreground">Inserted</div>
              </div>
              <div className="rounded-md border p-3 border-amber-200 bg-amber-50">
                <div className="text-2xl font-bold text-amber-700">{result.duplicatesSkipped}</div>
                <div className="text-xs text-muted-foreground">Duplicates Skipped</div>
              </div>
            </div>
            {result.errors.length > 0 && (
              <div className="max-h-40 overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead className="text-xs">Row</TableHead><TableHead className="text-xs">Reason</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.errors.map((e, i) => (
                      <TableRow key={i}><TableCell className="text-xs font-mono">{e.row}</TableCell><TableCell className="text-xs text-muted-foreground">{e.reason}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Bank Account</label>
              {preselectedAccountId ? (
                <div className="text-sm rounded-md border bg-muted/40 px-3 py-2">
                  {cards.find((c) => c.accountId === preselectedAccountId)?.code} — {cards.find((c) => c.accountId === preselectedAccountId)?.name}
                </div>
              ) : (
                <Select value={bankAccountId} onValueChange={setBankAccountId}>
                  <SelectTrigger><SelectValue placeholder="Select a bank account" /></SelectTrigger>
                  <SelectContent>
                    {cards.map((c) => (
                      <SelectItem key={c.accountId} value={String(c.accountId)}>{c.code} — {c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {needsEntity && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">Entity</label>
                <Select value={entityId} onValueChange={setEntityId}>
                  <SelectTrigger><SelectValue placeholder="Which entity's books?" /></SelectTrigger>
                  <SelectContent>
                    {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-gray-500 mt-1">
                  “{selectedCard?.name}” isn’t scoped to an entity in the Chart of Accounts, and every posted entry must belong to one.
                </p>
              </div>
            )}

            <div
              className={`rounded-md border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-input'}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
            >
              <UploadCloud className="mx-auto size-6 text-muted-foreground mb-2" />
              {file ? (
                <div className="text-sm font-medium">{file.name} <span className="text-muted-foreground">({(file.size / 1024).toFixed(1)} KB)</span></div>
              ) : (
                <div className="text-sm text-muted-foreground">Drag a file here, or click to browse (.csv, .ofx, .qbo)</div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.ofx,.qbo"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
            </div>

            {previewRows && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Preview (first {previewRows.length} lines)</div>
                <div className="max-h-40 overflow-auto border rounded-md">
                  <Table>
                    <TableBody>
                      {previewRows.map((row, i) => (
                        <TableRow key={i}>
                          {row.map((cell, j) => <TableCell key={j} className="text-xs font-mono whitespace-nowrap">{cell}</TableCell>)}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {isCsv && autoMapping && !showManualMapping && (
              <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <div className="space-y-0.5">
                  <div className="font-medium flex items-center gap-1.5"><CheckCircle2 className="size-3.5 text-green-600" /> Columns auto-detected</div>
                  <div className="text-muted-foreground">
                    Date: <span className="font-mono">{autoMapping.dateColumn}</span> · Description: <span className="font-mono">{autoMapping.descriptionColumn}</span> ·{' '}
                    {autoMapping.amountColumn ? <>Amount: <span className="font-mono">{autoMapping.amountColumn}</span></> : (
                      <>Debit: <span className="font-mono">{autoMapping.debitColumn || '—'}</span> / Credit: <span className="font-mono">{autoMapping.creditColumn || '—'}</span></>
                    )}
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowManualMapping(true)}>Change</Button>
              </div>
            )}

            {isCsv && csvHeaders && (!autoMapping || showManualMapping) && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="text-xs font-medium text-muted-foreground">
                  {autoMapping ? 'Adjust column mapping' : "Couldn't auto-detect columns — map them manually"}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium mb-1 block">Date Column</label>
                    <Select value={manualDateColumn} onValueChange={setManualDateColumn}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>{csvHeaders.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-medium mb-1 block">Description Column</label>
                    <Select value={manualDescriptionColumn} onValueChange={setManualDescriptionColumn}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>{csvHeaders.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium mb-1 block">Amount</label>
                  <div className="flex gap-2 mb-2">
                    <Button type="button" size="sm" variant={amountMode === 'single' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setAmountMode('single')}>Single Amount Column</Button>
                    <Button type="button" size="sm" variant={amountMode === 'split' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setAmountMode('split')}>Split Debit/Credit</Button>
                  </div>
                  {amountMode === 'single' ? (
                    <Select value={manualAmountColumn} onValueChange={setManualAmountColumn}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select amount column" /></SelectTrigger>
                      <SelectContent>{csvHeaders.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <Select value={manualDebitColumn} onValueChange={setManualDebitColumn}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Debit column" /></SelectTrigger>
                        <SelectContent>{csvHeaders.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select value={manualCreditColumn} onValueChange={setManualCreditColumn}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Credit column" /></SelectTrigger>
                        <SelectContent>{csvHeaders.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
                {autoMapping && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowManualMapping(false)}>Use auto-detected mapping instead</Button>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => { reset(); onOpenChange(false); }}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={!canSubmit || importStatement.isPending} onClick={handleSubmit}>
                {importStatement.isPending ? 'Uploading…' : 'Upload & Parse'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// "Connect Bank" (task item 1, "Plaid Live Sync popup for US accounts"):
// launches the real Plaid Link hosted popup. Link itself only produces a
// Plaid item + its raw plaid_accounts rows (via /plaid/exchange) — it has
// no notion of this app's entities, so after a successful link this opens
// a second step (`LinkNewAccountsModal`) to assign each newly-linked
// account to an entity and create the corresponding bank_accounts row(s).
// No intermediate "are you sure" modal before Link itself — the task asked
// for the button to trigger the popup directly.
// Plaid's own code (INVALID_API_KEYS, PRODUCT_NOT_READY, …) alongside its
// message, so a failure names itself instead of just "request failed".
function withCode(err: any): string {
  const code = err?.code ? ` (${err.code})` : '';
  return `${err?.message || 'Plaid request failed'}${code}`;
}

function useConnectBank(onLinked: (institutionName: string, linkedAccounts: any[]) => void) {
  const { toast } = useToast();
  const createLinkToken = useCreatePlaidLinkToken();
  const exchangeToken = useExchangePlaidPublicToken();
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    setConnecting(true);
    try {
      await loadPlaidLinkScript();
      const { linkToken } = await createLinkToken.mutateAsync();
      const handler = (window as any).Plaid.create({
        token: linkToken,
        onSuccess: (publicToken: string, metadata: any) => {
          exchangeToken.mutate(
            { publicToken, institution: metadata?.institution },
            {
              onSuccess: (res: any) => {
                toast({ title: `Connected ${res.institutionName}`, description: `${res.accounts} account(s) found — assign them to an entity to finish setup.` });
                // Hand the mapping step exactly what Plaid just linked, so it
                // never depends on a cached list being refreshed in time.
                onLinked(res.institutionName, (res.linkedAccounts || []) as any[]);
              },
              onError: (err: any) => toast({
                title: 'Failed to finish linking',
                description: withCode(err),
                variant: 'destructive',
              }),
              onSettled: () => setConnecting(false),
            },
          );
        },
        // Link hands its own failure here (institution down, bad config…).
        // Without this an error inside Link just closed the popup silently.
        onExit: (err: any, metadata: any) => {
          setConnecting(false);
          if (err) {
            toast({
              title: 'Plaid Link closed with an error',
              description: [err.display_message || err.error_message, err.error_code, metadata?.institution?.name].filter(Boolean).join(' · ') || 'Unknown Plaid error',
              variant: 'destructive',
            });
          }
        },
      });
      handler.open();
    } catch (err: any) {
      toast({ title: 'Could not open Plaid Link', description: withCode(err), variant: 'destructive' });
      setConnecting(false);
    }
  };

  return { connect, connecting };
}

// Step 2 of "Connect Bank": lists plaid_accounts rows for the just-linked
// institution that don't have a matching bank_accounts row yet (matched by
// plaidAccountId) and lets the user assign each to an entity before it
// becomes a usable Bank Hub card.
// "Map Linked Account" (2026-09-18) — step 2 of Connect Bank, shown as soon
// as Link succeeds and BEFORE any bank_accounts row exists. Per account:
//   1. Account Name   — pre-filled from Plaid ("Chase Checking ...4321"), editable
//   2. Entity / Brand — whose books this cash sits in (required)
//   3. COA account    — an existing Bank head for that entity, or a new one
//                       created automatically and tagged to it
// The chosen entity is stored on bank_accounts, and every transaction this
// feed ingests (Plaid /transactions/sync included) reads its entity from
// there — the feed rows resolve `entityId` through bank_accounts on read,
// so nothing has to be re-tagged later.
const NEW_COA_HEAD = '__new__';
// One Plaid item often exposes accounts you don't keep books for (loans,
// credit cards, a 401k). Those can be left out rather than forced into an
// entity — nothing is created for them and they can be mapped later.
const SKIP_ACCOUNT = '__skip__';

function LinkNewAccountsModal({
  open,
  onOpenChange,
  institutionName,
  entities,
  accounts,
  linkedGlAccountIds,
  linkedAccounts,
  bankAccounts,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  institutionName: string | null;
  entities: any[];
  /** Full Chart of Accounts, for picking an existing Bank head. */
  accounts: any[];
  /** COA heads already backing another bank feed — never offered twice. */
  linkedGlAccountIds: Set<number>;
  /** Exactly what the exchange just linked (each with `alreadyMapped`). */
  linkedAccounts: any[];
  /** Current bank feeds, so "already mapped" reflects live state. */
  bankAccounts: any[];
  onDone: () => void;
}) {
  const { toast } = useToast();
  const { data: plaidAccounts } = usePlaidAccounts();
  const createBankAccount = useCreateBankAccount();
  const updateBankAccount = useUpdateBankAccount();
  type Mapping = { name: string; entityId: string; glAccountId: string };
  const [mapping, setMapping] = useState<Record<string, Mapping>>({});
  const [creating, setCreating] = useState(false);

  // What this link produced, straight from the exchange response. The
  // cached /plaid/accounts list is only a fallback (e.g. the modal reopened
  // later) — it used to be the sole source, which is why a stale cache or a
  // differing institution name showed "No new accounts to assign".
  const fromLink = linkedAccounts.length > 0
    ? linkedAccounts
    : ((plaidAccounts || []) as any[]).filter((a) => !institutionName || a.institutionName === institutionName);
  // `alreadyMapped` is recomputed from the live feed list rather than trusted
  // from the exchange response alone, so it stays right if a feed was mapped
  // or removed since — and so the fallback path carries it too.
  const newAccounts = fromLink.map((a) => {
    const feed = bankAccounts.find((b) => b.plaidAccountId && b.plaidAccountId === a.plaidAccountId);
    return {
      ...a,
      alreadyMapped: feed
        ? { bankAccountId: feed.id, name: feed.name, entityId: feed.entityId, entityName: entities.find((e) => e.id === feed.entityId)?.name }
        : null,
    };
  });

  // Plaid's own naming, e.g. "Chase Checking ...4321".
  const defaultName = (a: any) => `${a.name}${a.mask ? ` ...${a.mask}` : ''}`;
  // An already-mapped account opens on its current feed's name and entity,
  // so picking a different entity is a re-assignment rather than a blank row.
  const mapFor = (a: any): Mapping => mapping[a.plaidAccountId] ?? {
    name: a.alreadyMapped?.name ?? defaultName(a),
    entityId: a.alreadyMapped ? String(a.alreadyMapped.entityId) : '',
    glAccountId: NEW_COA_HEAD,
  };
  const setMap = (plaidAccountId: string, patch: Partial<Mapping>, a: any) =>
    setMapping((prev) => ({ ...prev, [plaidAccountId]: { ...mapFor(a), ...patch } }));

  // Bank heads this entity can post to: its own or Shared, not already
  // backing another feed.
  const bankHeadsFor = (entityId: string) => accounts.filter((acc) =>
    acc.type === 'Asset'
    && (acc.subType === 'Bank' || acc.category === 'Cash & Equivalents')
    && acc.isActive !== 0
    && !linkedGlAccountIds.has(acc.id)
    && (acc.entityId == null || String(acc.entityId) === String(entityId)),
  );

  const handleCreateAll = async () => {
    // Only accounts given an entity are imported; the rest are left out and
    // can be mapped later — one Plaid item often carries accounts you don't
    // keep books for.
    const rows = newAccounts
      .map((a) => ({ a, m: mapFor(a) }))
      .filter(({ m }) => m.entityId && m.entityId !== SKIP_ACCOUNT);
    if (rows.length === 0) {
      toast({ title: 'Assign an entity to at least one account', variant: 'destructive' });
      return;
    }
    if (rows.some(({ m }) => !m.name.trim())) {
      toast({ title: 'Every account needs a name', variant: 'destructive' });
      return;
    }
    // An account that already backs a feed is UPDATED (name / entity), never
    // linked a second time — two feeds on one Plaid account would ingest the
    // same transactions into two sets of books.
    const toCreate = rows.filter(({ a }) => !a.alreadyMapped);
    const toUpdate = rows.filter(({ a, m }) => a.alreadyMapped && (
      String(m.entityId) !== String(a.alreadyMapped.entityId) || m.name.trim() !== a.alreadyMapped.name
    ));
    setCreating(true);
    try {
      for (const { a, m } of toCreate) {
        await createBankAccount.mutateAsync({
          data: {
            name: m.name.trim(),
            bankName: institutionName,
            entityId: Number(m.entityId),
            currency: a.isoCurrency || 'USD',
            accountNumberLast4: a.mask || '',
            connectionType: 'PLAID',
            plaidAccountId: a.plaidAccountId,
            // Blank = the server creates a Bank head tagged to this entity.
            ...(m.glAccountId && m.glAccountId !== NEW_COA_HEAD ? { glAccountId: Number(m.glAccountId) } : {}),
          },
        });
      }
      for (const { a, m } of toUpdate) {
        await updateBankAccount.mutateAsync({
          id: a.alreadyMapped.bankAccountId,
          data: {
            name: m.name.trim(),
            bankName: institutionName,
            entityId: Number(m.entityId),
            currency: a.isoCurrency || 'USD',
            accountNumberLast4: a.mask || '',
            connectionType: 'PLAID',
            plaidAccountId: a.plaidAccountId,
          },
        });
      }
      const parts = [
        toCreate.length ? `${toCreate.length} mapped` : '',
        toUpdate.length ? `${toUpdate.length} re-assigned` : '',
      ].filter(Boolean).join(' · ');
      toast({ title: parts || 'Nothing to change', description: 'Their transactions will post to the assigned entity.' });
      onDone();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: 'Failed to finish setup', description: err.message, variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-map-linked-account>
        <DialogHeader>
          <DialogTitle>Map Linked Account{newAccounts.length > 1 ? 's' : ''}</DialogTitle>
          <DialogDescription>
            {institutionName} — name each linked account, say whose books it belongs to, and point it at a Chart of Accounts bank head. Accounts you leave without an entity aren't imported.
          </DialogDescription>
        </DialogHeader>
        {newAccounts.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground" data-map-empty>
            Plaid returned no accounts for this connection. Try Connect Bank again, or check the API log for the exchange response.
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            {newAccounts.map((a) => {
              const m = mapFor(a);
              const heads = bankHeadsFor(m.entityId);
              return (
                <div key={a.plaidAccountId} className="rounded-md border p-3" data-map-row={a.plaidAccountId}>
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>From Plaid: {a.name}{a.mask ? ` ••••${a.mask}` : ''} · {a.isoCurrency || 'USD'}{a.subtype ? ` · ${a.subtype}` : ''}</span>
                    {a.alreadyMapped && (
                      <Badge variant="outline" className="border-transparent bg-muted text-[9.5px]" data-already-mapped>
                        Already mapped → {a.alreadyMapped.name}{a.alreadyMapped.entityName ? ` · ${entityLabel(a.alreadyMapped.entityName)}` : ''}
                      </Badge>
                    )}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium">Account Name</span>
                      <Input
                        value={m.name}
                        onChange={(e) => setMap(a.plaidAccountId, { name: e.target.value }, a)}
                        className="h-8 text-xs"
                        aria-label={`Account name for ${a.name}`}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium">Entity / Brand</span>
                      <Select
                        value={m.entityId}
                        onValueChange={(v) => setMap(a.plaidAccountId, { entityId: v, glAccountId: NEW_COA_HEAD }, a)}
                      >
                        <SelectTrigger className="h-8 text-xs" aria-label={`Entity for ${a.name}`}><SelectValue placeholder="Entity" /></SelectTrigger>
                        <SelectContent>
                          {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                          <SelectItem value={SKIP_ACCOUNT}>Don't import this account</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium">Chart of Accounts head</span>
                      <Select
                        value={m.glAccountId}
                        onValueChange={(v) => setMap(a.plaidAccountId, { glAccountId: v }, a)}
                        // An existing feed keeps the head it already posts to.
                        disabled={!m.entityId || m.entityId === SKIP_ACCOUNT || !!a.alreadyMapped}
                      >
                        <SelectTrigger className="h-8 text-xs" aria-label={`COA head for ${a.name}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NEW_COA_HEAD}>Create a new bank head</SelectItem>
                          {heads.map((acc) => (
                            <SelectItem key={acc.id} value={String(acc.id)}>
                              {acc.code} — {acc.name}{acc.entityId == null ? ' (Shared)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  </div>
                  <div className="mt-1.5 text-[11px] text-muted-foreground">
                    {a.alreadyMapped
                      ? (String(m.entityId) === String(a.alreadyMapped.entityId) && m.name.trim() === a.alreadyMapped.name
                        ? 'Connected already — change the entity or name here to re-assign this feed.'
                        : 'Will re-assign the existing feed (allowed while nothing has been posted from it).')
                      : m.entityId === SKIP_ACCOUNT || !m.entityId
                      ? 'Left out unless you pick an entity — its books would hold this cash, and every transaction from this feed posts there.'
                      : m.glAccountId === NEW_COA_HEAD
                        ? `A new Asset · Bank account will be created in the Chart of Accounts, tagged to ${entityLabel(entities.find((e) => String(e.id) === m.entityId)?.name || '')}.`
                        : 'Existing head — its balance already reflects this account\'s postings.'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {newAccounts.length > 0 && (
            <Button disabled={creating} onClick={handleCreateAll} data-map-save>
              {creating ? 'Saving…' : `Save Mapping${(() => {
                const n = newAccounts.filter((a) => {
                  const m = mapFor(a);
                  if (!m.entityId || m.entityId === SKIP_ACCOUNT) return false;
                  return !a.alreadyMapped || String(m.entityId) !== String(a.alreadyMapped.entityId) || m.name.trim() !== a.alreadyMapped.name;
                }).length;
                return n ? ` (${n})` : '';
              })()}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type RowOverride = {
  accountId?: string;
  brandId?: string;
  entityId?: string;
  /** Who bears the cost — may differ from the paying (bank) entity. */
  chargedToEntityId?: string;
  /** Optional Payee / Contact (Customer or Vendor) for the sub-ledger. */
  contactId?: string;
  /** Name of the customer whose entity auto-filled Charged To (UI hint only). */
  chargedToSuggestedBy?: string;
  /** Charged To was picked by hand — customer selection no longer overrides it. */
  chargedToManual?: boolean;
};

// True when the chosen Categorize account is an Expense head — on a deposit
// that makes the post a refund (Dr Bank / Cr Expense), which the row hints.
function isExpenseAccount(glAccounts: any[], accountId: string | undefined): boolean {
  if (!accountId) return false;
  return glAccounts.find((a) => String(a.id) === String(accountId))?.type === 'Expense';
}

// A contact can tag a line booked in an entity only if it is that entity's
// own contact or a Shared one. Mirrors resolveContactForEntity on the server.
function contactFitsEntity(contacts: Contact[], contactId: string | undefined, entityId: string | undefined): boolean {
  if (!contactId || !entityId) return false;
  const c = contacts.find((x) => String(x.id) === String(contactId));
  return !!c && (c.entityId == null || Number(c.entityId) === Number(entityId));
}

// A GL head can be booked in an entity's ledger only if it is that entity's
// own account or a Shared (entity-less) one. Mirrors the server-side rule.
function accountFitsEntity(glAccounts: any[], accountId: string | undefined, entityId: string | undefined): boolean {
  if (!accountId || !entityId) return false;
  const account = glAccounts.find((a) => String(a.id) === String(accountId));
  return !!account && (!account.entityId || Number(account.entityId) === Number(entityId));
}

// Posting outcome toast. Conversion to USD is silent — the only exception is
// the 1:1 parity fallback (no rate for the currency exists at all), because
// then the consolidated USD figure is knowingly wrong and must be fixed.
function postedToast(toast: ReturnType<typeof useToast>['toast'], res: any) {
  const entries = res.journalEntries ?? (res.journalEntry ? [res.journalEntry] : []);
  const numbers = entries.map((je: any) => je.entryNumber).join(', ');
  if (res.exchangeRateSource === 'parity') {
    toast({ title: `Posted ${numbers} — no exchange rate on file`, description: res.rateWarning, variant: 'destructive' });
    return;
  }
  toast({
    title: `Posted ${numbers}`,
    description: entries.length > 1 ? `${entries.length} balanced entries incl. intercompany Due From / Due To` : undefined,
  });
}

// Every line shows BOTH an Amount and a Percentage input (2026-09-17 — the
// mode toggle is gone). Typing in one derives the other; `source` remembers
// which was typed last, so a percentage-driven line can absorb the cent
// rounding residual when the percentages total exactly 100%. The amount
// string is always what posts.
type SplitLine = { id: string; entityId: string; accountId: string; contactId: string; amount: string; pct: string; source: 'amount' | 'pct' };

const toCents = (v: string | number) => Math.round((Number(v) || 0) * 100);

// Percentages are carried to 4 dp (0.0001% of even AED 10m is AED 10), then
// shown without trailing zeros.
const PCT_SCALE = 10_000;
const toPctUnits = (v: string | number) => Math.round((Number(v) || 0) * PCT_SCALE);
const HUNDRED_PCT = 100 * PCT_SCALE;
function formatPct(units: number): string {
  return String(Number((units / PCT_SCALE).toFixed(4)));
}

function newSplitLine(patch: Partial<SplitLine> = {}): SplitLine {
  return { id: Math.random().toString(36).slice(2), entityId: '', accountId: '', contactId: '', amount: '', pct: '', source: 'amount', ...patch };
}

// When the percentages total exactly 100% but rounding leaves the amounts a
// few cents off the bank total (e.g. 3 × 33.3333%), the last
// percentage-driven line takes the residual so the split posts to the cent.
function absorbRoundingResidual(lines: SplitLine[], totalCents: number): SplitLine[] {
  const pctSum = lines.reduce((s, l) => s + toPctUnits(l.pct), 0);
  if (pctSum !== HUNDRED_PCT) return lines;
  const diff = totalCents - lines.reduce((s, l) => s + toCents(l.amount), 0);
  if (diff === 0 || Math.abs(diff) > lines.length) return lines;
  const idx = lines.map((l) => l.source).lastIndexOf('pct');
  if (idx < 0) return lines;
  return lines.map((l, i) => (i === idx ? { ...l, amount: ((toCents(l.amount) + diff) / 100).toFixed(2) } : l));
}

// Statutory split (2026-09-16). Breaks one bank transaction into line items
// in the bank's NATIVE currency, entered either by amount or by percentage
// (the other value is derived live). Each line picks its own charged-to
// entity and GL head. Posting is allowed only when the lines total exactly
// 100% / the bank amount to the cent — and the server re-checks the cents.
// Lines charged to another entity post automatically as intercompany (Due
// From Affiliates in the paying entity; the expense plus Due To Affiliates
// in the charged-to entity). USD conversion is silent.
function SplitTransactionModal({
  row,
  bankEntityId,
  defaultAccountId,
  defaultEntityId,
  defaultContactId,
  entities,
  glAccounts,
  contacts,
  onCreateContact,
  onOpenChange,
  onPosted,
  postMode = true,
  canCreateContacts = true,
  onContactCreated,
}: {
  row: any | null;
  bankEntityId: string;
  defaultAccountId: string;
  defaultEntityId: string;
  defaultContactId: string;
  entities: any[];
  glAccounts: any[];
  contacts: Contact[];
  onCreateContact: (entityId: string) => (name: string, contactType: ContactType) => Promise<Contact>;
  onOpenChange: (open: boolean) => void;
  onPosted: () => void;
  /** false = the user can't post (Bookkeeper): the split is saved for review instead. */
  postMode?: boolean;
  canCreateContacts?: boolean;
  onContactCreated?: (contact: Contact) => void;
}) {
  const { toast } = useToast();
  const postSplit = usePostBankTransactionSplit();
  // "+ Add New Contact" from a split line's From/To.
  const [addContact, setAddContact] = useState<{ lineId: string; entityId: string; name: string } | null>(null);
  const stage = useStageBankTransaction();
  const [lines, setLines] = useState<SplitLine[]>([]);
  // Reusable multi-entity templates from Settings → Rules.
  const { data: splitRulesData } = useListSplitRules();
  const splitRules = useMemo(() => ((splitRulesData || []) as SplitRule[]).filter((r) => r.isActive !== 0), [splitRulesData]);
  const [appliedRule, setAppliedRule] = useState<string | null>(null);

  const currency = row?.currency || 'USD';
  const totalCents = row ? Math.abs(toCents(row.amount)) : 0;

  const pctFromCents = (cents: number) => (totalCents > 0 ? formatPct(Math.round((cents * HUNDRED_PCT) / totalCents)) : '0');
  const centsFromPct = (pct: string) => Math.round((totalCents * toPctUnits(pct)) / HUNDRED_PCT);

  React.useEffect(() => {
    if (!row) return;
    // A split saved for review opens exactly as it was saved.
    const stagedSplits = Array.isArray(row.staged?.splits) ? row.staged.splits : null;
    if (stagedSplits && stagedSplits.length > 0) {
      setLines(stagedSplits.map((s: any) => {
        const cents = toCents(s.amount ?? 0);
        return newSplitLine({
          entityId: s.entityId ? String(s.entityId) : '',
          accountId: s.accountId ? String(s.accountId) : '',
          contactId: s.contactId ? String(s.contactId) : '',
          amount: (cents / 100).toFixed(2),
          pct: totalCents > 0 ? formatPct(Math.round((cents * HUNDRED_PCT) / totalCents)) : '0',
        });
      }));
      return;
    }
    setAppliedRule(null);
    setLines([newSplitLine({ entityId: defaultEntityId, accountId: defaultAccountId, contactId: defaultContactId, amount: (totalCents / 100).toFixed(2), pct: '100' })]);
    // Re-seed only when a different transaction is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  // Amounts are authoritative (cents must tie exactly). The percentage total
  // is the sum of the percentages as shown on the lines, so typing 40% reads
  // back as 40% rather than a cent-rounded 39.999%.
  const lineCents = lines.map((l) => toCents(l.amount));
  const allocatedCents = lineCents.reduce((s, c) => s + c, 0);
  const allocatedPctUnits = lines.reduce((s, l) => s + toPctUnits(l.pct), 0);
  const remainingCents = totalCents - allocatedCents;
  const remainingPctUnits = HUNDRED_PCT - allocatedPctUnits;
  const balanced = remainingCents === 0;

  const incomplete = lines.some((l, i) => lineCents[i] <= 0 || !l.accountId || !l.entityId);
  const invalidAccount = lines.some((l) => l.accountId && l.entityId && !accountFitsEntity(glAccounts, l.accountId, l.entityId));
  const canPost = !!row && lines.length > 0 && balanced && !incomplete && !invalidAccount && !postSplit.isPending;

  const update = (id: string, patch: Partial<SplitLine>) =>
    setLines((prev) => absorbRoundingResidual(prev.map((l) => {
      if (l.id !== id) return l;
      const next = { ...l, ...patch };
      // Bidirectional sync: whichever field was typed drives the other.
      if (patch.amount !== undefined) {
        next.pct = patch.amount === '' ? '' : pctFromCents(toCents(patch.amount));
        next.source = 'amount';
      }
      if (patch.pct !== undefined) {
        next.amount = patch.pct === '' ? '' : (centsFromPct(patch.pct) / 100).toFixed(2);
        next.source = 'pct';
      }
      // Changing the entity drops a GL head that entity can't book.
      if (patch.entityId !== undefined && next.accountId && !accountFitsEntity(glAccounts, next.accountId, next.entityId)) {
        next.accountId = '';
      }
      // …and a payee that isn't that entity's own or Shared.
      if (patch.entityId !== undefined && next.contactId && !contactFitsEntity(contacts, next.contactId, next.entityId)) {
        next.contactId = '';
      }
      return next;
    }), totalCents));

  // A new line is seeded with whatever is still unallocated.
  const addLine = () =>
    setLines((prev) => {
      const seed = remainingCents > 0
        ? { amount: (remainingCents / 100).toFixed(2), pct: remainingPctUnits > 0 ? formatPct(remainingPctUnits) : pctFromCents(remainingCents) }
        : {};
      return [...prev, newSplitLine({ entityId: bankEntityId, ...seed })];
    });
  const removeLine = (id: string) => setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));

  // Apply a saved rule: one line per entity at its percentage. Amounts are
  // derived from the percentages and the last line absorbs the rounding
  // residual, so the set ties to the bank amount to the cent. The GL head
  // and payee are carried over where the new entity can still book them.
  const applyRule = (ruleId: string) => {
    const rule = splitRules.find((r) => String(r.id) === ruleId);
    if (!rule || totalCents <= 0) return;
    const seed = lines[0];
    const built = rule.lines.map((rl, i) => {
      const entityId = String(rl.entityId);
      const pct = formatPct(toPctUnits(rl.percent));
      const keepAccount = seed?.accountId && accountFitsEntity(glAccounts, seed.accountId, entityId) ? seed.accountId : '';
      const keepContact = seed?.contactId && contactFitsEntity(contacts, seed.contactId, entityId) ? seed.contactId : '';
      return newSplitLine({
        entityId,
        accountId: keepAccount,
        contactId: keepContact,
        pct,
        amount: (centsFromPct(pct) / 100).toFixed(2),
        source: 'pct',
      });
    });
    setLines(absorbRoundingResidual(built, totalCents));
    setAppliedRule(rule.name);
  };

  const handleSubmit = () => {
    if (!row || !canPost) return;
    const splits = lines.map((l, i) => ({
      accountId: Number(l.accountId),
      entityId: Number(l.entityId),
      contactId: l.contactId ? Number(l.contactId) : null,
      amount: lineCents[i] / 100,
    }));
    if (!postMode) {
      // Bookkeeper: record the split for a Manager/Admin to post.
      stage.mutate({ id: row.id, splits }, {
        onSuccess: () => {
          toast({ title: 'Split saved for review', description: 'A Manager or Admin can now post it.' });
          onPosted();
          onOpenChange(false);
        },
        onError: (err: any) => toast({ title: 'Could not save split', description: err.message, variant: 'destructive' }),
      });
      return;
    }
    postSplit.mutate(
      {
        id: row.id,
        // Always posted as exact amounts; the server re-validates the cents.
        splits,
      },
      {
        onSuccess: (res: any) => {
          postedToast(toast, res);
          onPosted();
          onOpenChange(false);
        },
        onError: (err: any) => toast({ title: 'Split posting failed', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const money = (cents: number) => formatMoney(cents / 100, currency);
  // Same order as the feed row: From/To · Categorize · Charged To · Amount · Percentage · remove
  const GRID = 'grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_minmax(0,140px)_116px_120px_32px] items-center gap-2';
  const direction: 'in' | 'out' = row && row.amount >= 0 ? 'in' : 'out';

  return (
    <Dialog open={!!row} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-5xl overflow-hidden">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle>Split Transaction</DialogTitle>
          <DialogDescription className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono">{row?.transactionDate}</span>
            <span className="shrink-0 font-mono font-medium text-foreground">{row ? formatMoney(row.amount, currency) : ''}</span>
            <span className="min-w-0 truncate" title={row?.description}>{row?.description}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {/* Apply a saved multi-entity rule (Settings → Rules): it fills one
              line per entity at the rule's percentage, with the last line
              taking the cent residual. Everything stays editable, and the
              posting still runs the cent-exact checks. */}
          {splitRules.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">Apply Rule</span>
              <Select value="" onValueChange={applyRule}>
                <SelectTrigger className="h-8 w-64 text-xs" aria-label="Apply Rule" data-apply-rule>
                  <SelectValue placeholder="Choose a split rule…" />
                </SelectTrigger>
                <SelectContent>
                  {splitRules.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name} — {r.lines.map((l) => `${entityLabel(l.entityName)} ${Number(l.percent.toFixed(4))}%`).join(' / ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {appliedRule && <span className="text-[11px] text-blue-700" data-applied-rule>{appliedRule} applied — edit any line as needed</span>}
            </div>
          )}

          <div className={`${GRID} px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground`}>
            <span>From/To</span>
            <span>Categorize</span>
            <span>Charged To</span>
            <span className="whitespace-nowrap text-right">Amount ({currency === 'USD' ? '$' : currency})</span>
            <span className="whitespace-nowrap text-right">Percentage (%)</span>
            <span />
          </div>

          <div className="max-h-[45vh] space-y-2 overflow-y-auto overflow-x-hidden pr-1">
            {lines.map((l, idx) => {
              const intercompany = l.entityId && bankEntityId && l.entityId !== bankEntityId;
              return (
                <div key={l.id} data-split-line={idx + 1} className="rounded-md border p-2">
                  <div className={GRID}>
                    <div className="min-w-0">
                      <ContactSelect
                        contacts={contacts}
                        entityId={l.entityId ? Number(l.entityId) : null}
                        direction={direction}
                        value={l.contactId}
                        onChange={(v) => update(l.id, { contactId: v })}
                        onCreate={onCreateContact(l.entityId)}
                        canCreate={canCreateContacts}
                        onAddNew={(typed) => setAddContact({ lineId: l.id, entityId: l.entityId, name: typed })}
                        className="w-full min-w-0"
                        placeholder="From/To"
                      />
                    </div>
                    <div className="min-w-0">
                      <GLAccountSelect
                        accounts={glAccounts}
                        value={l.accountId}
                        onChange={(v) => update(l.id, { accountId: v })}
                        entityId={l.entityId ? Number(l.entityId) : null}
                        className="w-full min-w-0"
                        placeholder="Categorize"
                      />
                    </div>
                    <Select value={l.entityId} onValueChange={(v) => update(l.id, { entityId: v })}>
                      <SelectTrigger className="h-8 min-w-0 text-xs" aria-label={`Line ${idx + 1} charged to`}><SelectValue placeholder="Charged to" /></SelectTrigger>
                      <SelectContent>
                        {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number" inputMode="decimal" min="0" step="0.01"
                      value={l.amount}
                      onChange={(e) => update(l.id, { amount: e.target.value })}
                      placeholder="0.00"
                      aria-label={`Line ${idx + 1} amount`}
                      data-split-amount
                      className="h-8 text-right font-mono text-xs"
                    />
                    <div className="relative">
                      <Input
                        type="number" inputMode="decimal" min="0" max="100" step="0.01"
                        value={l.pct}
                        onChange={(e) => update(l.id, { pct: e.target.value })}
                        placeholder="0"
                        aria-label={`Line ${idx + 1} percentage`}
                        data-split-pct
                        className="h-8 pr-6 text-right font-mono text-xs"
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                    </div>
                    <Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => removeLine(l.id)} disabled={lines.length === 1} aria-label={`Remove line ${idx + 1}`}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  {intercompany && (
                    <div className="mt-1 text-[10px] text-amber-700">Intercompany — posts Due From / Due To automatically</div>
                  )}
                </div>
              );
            })}
          </div>

          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <PlusCircle className="mr-2 size-3.5" /> Add Line
          </Button>

          {/* Live validation bar */}
          <div
            data-split-balanced={balanced}
            data-split-remaining={remainingCents}
            className={`grid grid-cols-1 gap-2 rounded-md border px-3 py-2 font-mono text-xs sm:grid-cols-3 ${balanced ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}
          >
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Bank Total</div>
              <div>{money(totalCents)} (100%)</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total Split</div>
              <div>{money(allocatedCents)} ({formatPct(allocatedPctUnits)}%)</div>
            </div>
            <div className={balanced ? 'text-green-700' : 'font-semibold text-red-700'}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {!balanced && remainingCents < 0 ? 'Over-allocated' : 'Remaining Balance'}
              </div>
              <div>{balanced ? 'Balanced ✓' : `${money(Math.abs(remainingCents))} (${formatPct(Math.abs(remainingPctUnits))}%)`}</div>
            </div>
          </div>
          {invalidAccount && (
            <div className="text-xs text-red-700">A GL account doesn't belong to its line's charged-to entity — pick that entity's own or a Shared account.</div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={handleSubmit} disabled={!canPost || stage.isPending}>
            {postMode
              ? (postSplit.isPending ? 'Posting…' : 'Post Split')
              : (stage.isPending ? 'Saving…' : 'Save split for review')}
          </Button>
        </DialogFooter>
      </DialogContent>
      {addContact && (
        <ContactFormDialog
          key={`split-add-${addContact.lineId}-${addContact.name}`}
          contact={null}
          defaultType={direction === 'in' ? 'Customer' : 'Vendor'}
          defaultEntityId={addContact.entityId}
          defaultName={addContact.name}
          open={!!addContact}
          onOpenChange={(o) => { if (!o) setAddContact(null); }}
          entities={entities}
          onSaved={(created) => {
            onContactCreated?.(created);
            const line = lines.find((x) => x.id === addContact.lineId);
            if (line && (created.entityId == null || String(created.entityId) === String(line.entityId))) {
              update(addContact.lineId, { contactId: String(created.id) });
            }
          }}
        />
      )}
    </Dialog>
  );
}

function PendingTransactionsTab({
  bankAccounts,
  entities,
  brands,
  glAccounts,
  bankAccountById,
  filterBankAccountId,
  enabled = true,
  view,
  setView,
  onCounts,
}: {
  bankAccounts: any[];
  entities: any[];
  brands: any[];
  glAccounts: any[];
  bankAccountById: Map<number, any>;
  filterBankAccountId?: number;
  enabled?: boolean;
  /** Date range / search / sort / filters, shared with the Posted tab. */
  view: FeedView;
  setView: React.Dispatch<React.SetStateAction<FeedView>>;
  onCounts: (counts: { shown: number; total: number }) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // RBAC (2026-09-17) — mirrors server rules for display only:
  //   post  (Manager/Admin): Post to Ledger, Bulk Post, Post Split
  //   stage (Bookkeeper+):   categorize / split / From-To, "Save for review"
  //   neither (Auditor):     every control disabled, no actions
  const { can } = useAuth();
  const canPost = can('post');
  const canStage = can('stage');
  const canWriteContacts = can('contacts.write');
  const canWriteCoa = can('coa.write');
  const stage = useStageBankTransaction();
  const [stagingId, setStagingId] = useState<number | null>(null);
  // Scoped server-side to the selected bank card, so the list can't drift
  // from the card's own unposted count. Held (`enabled: false`) until the
  // hub has decided which card is selected, so the table never flashes
  // every account's rows before settling on the first card's.
  const { data: unposted, isLoading: unpostedLoading } = useUnpostedBankTransactions(
    filterBankAccountId !== undefined ? { bankAccountId: filterBankAccountId } : undefined,
    { query: { enabled } },
  );
  const isLoading = unpostedLoading || !enabled;
  const postTransaction = usePostBankTransaction();
  // All active contacts; each picker scopes them to its line's entity.
  const { data: contactsData } = useListContacts();
  const contacts = useMemo(() => (contactsData || []) as Contact[], [contactsData]);
  const createContact = useCreateContact();
  // Quick-create from a picker, owned by the entity whose ledger the line
  // lands in. Appended to the cache immediately so the new payee shows as
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
  const bulkPost = useBulkPostBankTransactions();

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [overrides, setOverrides] = useState<Record<number, RowOverride>>({});
  const [postingId, setPostingId] = useState<number | null>(null);
  const [splitRow, setSplitRow] = useState<any>(null);
  // "+ Add New Contact" from a row's From/To — full form, without leaving Banking.
  const [addContact, setAddContact] = useState<{ rowId: number; entityId: string; type: ContactType; name: string } | null>(null);

  const allRows = useMemo(() => (unposted || []) as any[], [unposted]);

  const overrideFor = (row: any): RowOverride => {
    if (overrides[row.id]) return overrides[row.id];
    const bankAccount = bankAccountById.get(row.bankAccountId);
    const suggestion = row.suggestedCategorization;
    // A categorization saved for review wins over the rule suggestion.
    const staged = row.staged;
    if (staged && !staged.splits) {
      return {
        accountId: staged.accountId ? String(staged.accountId) : (suggestion?.suggestedAccountId ? String(suggestion.suggestedAccountId) : ''),
        brandId: '',
        entityId: String(row.entityId ?? bankAccount?.entityId ?? ''),
        chargedToEntityId: String(staged.chargedToEntityId ?? row.entityId ?? bankAccount?.entityId ?? ''),
        contactId: staged.contactId ? String(staged.contactId) : '',
      };
    }
    return {
      accountId: suggestion?.suggestedAccountId ? String(suggestion.suggestedAccountId) : '',
      // Brand is derived from the entity server-side, so it isn't staged
      // here any more — leaving it settable was how a line's brand could
      // disagree with its entry's entity.
      brandId: '',
      // Always the owning bank account's entity. The feed now returns it
      // (row.entityId) resolved through the bank account, so it can't
      // drift from the Bank Card; the fallback covers an older cached row.
      entityId: String(row.entityId ?? bankAccount?.entityId ?? ''),
      // Charged-to defaults to the bank account's entity. There is no
      // period override: the transaction date dictates the statutory period.
      chargedToEntityId: String(row.chargedToEntityId ?? row.entityId ?? bankAccount?.entityId ?? ''),
      contactId: '',
    };
  };

  const setOverride = (rowId: number, patch: Partial<RowOverride>) => {
    setOverrides((prev) => ({ ...prev, [rowId]: { ...overrideFor(rows.find((r) => r.id === rowId)), ...prev[rowId], ...patch } }));
  };

  const invalidateAll = () => invalidateLedgerDerivedQueries(queryClient);

  // Smart Charged To (2026-09-17): money IN + a Customer in From/To → Charged
  // To becomes the entity that customer belongs to (its receivable lives in
  // that entity's books). When that differs from the bank's entity the post
  // raises Due From / Due To automatically. It is only a pre-fill: once
  // Charged To has been picked by hand, choosing a customer leaves it alone.
  const selectContact = (row: any, contactId: string, known?: Contact) => {
    const o = overrideFor(row);
    const contact = known ?? contacts.find((c) => String(c.id) === String(contactId));
    const patch: Partial<RowOverride> = { contactId, chargedToSuggestedBy: undefined };
    const currentBooking = o.chargedToEntityId || o.entityId;
    if (
      row.amount > 0 &&
      contact?.contactType === 'Customer' &&
      contact.entityId != null &&
      !o.chargedToManual
    ) {
      const target = String(contact.entityId);
      if (target !== String(currentBooking)) {
        patch.chargedToEntityId = target;
        // Drop a GL head the customer's entity can't book.
        if (!accountFitsEntity(glAccounts, o.accountId, target)) patch.accountId = '';
      }
      patch.chargedToSuggestedBy = contact.name;
    }
    setOverride(row.id, patch);
  };

  // "+ Create New Category" from a row's Categorize picker.
  const [newCategory, setNewCategory] = useState<{ rowId: number; entityId: string; type: string; name: string } | null>(null);

  const handlePost = (row: any) => {
    const o = overrideFor(row);
    if (!o.accountId || !o.entityId) {
      toast({ title: 'GL Account and Entity are required to post', variant: 'destructive' });
      return;
    }
    setPostingId(row.id);
    postTransaction.mutate(
      {
        id: row.id,
        accountId: Number(o.accountId),
        entityId: Number(o.entityId),
        brandId: o.brandId ? Number(o.brandId) : undefined,
        chargedToEntityId: o.chargedToEntityId ? Number(o.chargedToEntityId) : undefined,
        contactId: o.contactId ? Number(o.contactId) : null,
      },
      {
        onSuccess: (res: any) => {
          postedToast(toast, res);
          invalidateAll();
        },
        onError: (err: any) => toast({ title: 'Failed to post', description: err.message, variant: 'destructive' }),
        onSettled: () => setPostingId(null),
      },
    );
  };

  // Bookkeeper: save the row's categorization for a Manager/Admin to post.
  const handleSaveForReview = (row: any) => {
    const o = overrideFor(row);
    if (!o.accountId) {
      toast({ title: 'Pick a Categorize account before saving', variant: 'destructive' });
      return;
    }
    setStagingId(row.id);
    stage.mutate(
      {
        id: row.id,
        accountId: Number(o.accountId),
        chargedToEntityId: o.chargedToEntityId ? Number(o.chargedToEntityId) : null,
        contactId: o.contactId ? Number(o.contactId) : null,
      },
      {
        onSuccess: () => {
          toast({ title: 'Saved for review', description: 'A Manager or Admin can now post it.' });
          queryClient.invalidateQueries({ queryKey: getUnpostedBankTransactionsQueryKey() });
          setOverrides((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
        },
        onError: (err: any) => toast({ title: 'Could not save', description: err.message, variant: 'destructive' }),
        onSettled: () => setStagingId(null),
      },
    );
  };

  const handleBulkPost = () => {
    const items: { bankTransactionId: number; accountId: number; entityId: number; brandId?: number; chargedToEntityId?: number; contactId?: number | null }[] = [];
    const missing: number[] = [];
    for (const id of selectedIds) {
      const row = rows.find((r) => r.id === id);
      if (!row) continue;
      const o = overrideFor(row);
      if (!o.accountId || !o.entityId) { missing.push(id); continue; }
      items.push({
        bankTransactionId: id,
        accountId: Number(o.accountId),
        entityId: Number(o.entityId),
        brandId: o.brandId ? Number(o.brandId) : undefined,
        // Charged-To is statutory (drives Due From/To), so bulk must honour
        // it exactly like the single-row Post does.
        chargedToEntityId: o.chargedToEntityId ? Number(o.chargedToEntityId) : undefined,
        contactId: o.contactId ? Number(o.contactId) : null,
      });
    }
    if (missing.length > 0) {
      toast({ title: `${missing.length} selected row(s) missing GL Account/Entity — skipped`, variant: 'destructive' });
    }
    if (items.length === 0) return;
    bulkPost.mutate(
      { items },
      {
        onSuccess: (res) => {
          toast({ title: `Posted ${res.posted} of ${items.length}`, description: res.failed ? `${res.failed} failed — see console` : undefined });
          if (res.failed) console.error('Bulk post errors:', res.errors);
          setSelectedIds(new Set());
          invalidateAll();
        },
        onError: (err: any) => toast({ title: 'Bulk post failed', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const columns = useResizableColumns('finsys.banking.pending.columns.v3', PENDING_DEFAULT_WIDTHS);

  // The fields the toolbar searches and the headers sort / filter on. The
  // category is whatever the row is currently categorized as (a staged or
  // suggested account counts), so filtering matches what's on screen.
  const fieldsOf = React.useCallback((row: any): FeedRowFields => {
    const o = overrideFor(row);
    const account = glAccounts.find((a) => String(a.id) === String(o.accountId));
    return {
      date: row.transactionDate || '',
      bank: bankAccountById.get(row.bankAccountId)?.name || row.bankAccountName || '',
      description: row.description || '',
      amount: Number(row.amount) || 0,
      category: row.staged?.splits ? 'Split' : account ? account.name : 'Uncategorized',
    };
  }, [glAccounts, bankAccountById, overrides]);

  const rows = useMemo(() => {
    const filtered = allRows.filter((r) => {
      const f = fieldsOf(r);
      if (view.dateFrom && f.date < view.dateFrom) return false;
      if (view.dateTo && f.date > view.dateTo) return false;
      return matchesSearch(f, view.search) && passesFilters(f, view.filters);
    });
    return sortRows(filtered, view.sort, fieldsOf);
  }, [allRows, view, fieldsOf]);

  const filterOptions = useMemo(() => ({
    bank: [...new Set(allRows.map((r) => fieldsOf(r).bank).filter(Boolean))].sort(),
    category: [...new Set(allRows.map((r) => fieldsOf(r).category).filter(Boolean))].sort(),
  }), [allRows, fieldsOf]);

  React.useEffect(() => { onCounts({ shown: rows.length, total: allRows.length }); }, [rows.length, allRows.length, onCounts]);

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggleRow = (id: number) => setSelectedIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectedTotal = rows.filter((r) => selectedIds.has(r.id)).reduce((sum, r) => sum + r.amount, 0);

  return (
    <div>
      {/* Banners sit inside the feed card, above the flush table. */}
      <div className="space-y-2 px-4 pb-3 empty:hidden">
      {!canStage && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-readonly-banner>
          Read-only access — you can review transactions but not categorize or post them.
        </div>
      )}
      {canStage && !canPost && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800" data-stage-banner>
          Prepare each transaction (From/To, Categorize, Charged To or Split) and <span className="font-medium">Save for review</span> — a Manager or Admin posts it to the ledger.
        </div>
      )}
      {canPost && selectedIds.size > 0 && (
        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
          <span className="text-sm font-mono">{selectedIds.size} selected · net {formatMoney(selectedTotal, 'USD')}</span>
          <Button size="sm" onClick={handleBulkPost} disabled={bulkPost.isPending}>
            <Send className="mr-2 size-4" /> {bulkPost.isPending ? 'Posting…' : 'Bulk Post Selected'}
          </Button>
        </div>
      )}
      </div>
      <div className="border-t overflow-x-auto">
        {/* Fixed layout + draggable column borders. Default widths keep all
            nine columns inside a 1280px viewport; px-2 cells. */}
        <Table
          className="table-fixed [&_td]:overflow-hidden [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4"
          style={columns.tableStyle}
          data-resizable-table="pending"
        >
          <ResizableColGroup widths={columns.widths} />
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <ResizableHeaderCells
                table={columns}
                columns={PENDING_COLUMNS.map((c) => c.key === 'select'
                  ? { ...c, header: canPost ? <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select all" /> : null }
                  : c)}
                sort={view.sort}
                onSortChange={(sort) => setView((prev) => ({ ...prev, sort }))}
                filters={view.filters}
                onFiltersChange={(filters) => setView((prev) => ({ ...prev, filters }))}
                filterOptions={filterOptions}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>{Array.from({ length: 9 }).map((__, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground font-mono text-sm">
                {allRows.length === 0 ? 'No pending transactions' : 'No transactions match the current search or filters'}
              </TableCell></TableRow>
            ) : (
              rows.map((row) => {
                const o = overrideFor(row);
                const hasSuggestion = !!row.suggestedCategorization;
                // The GL head is booked in the CHARGED-TO entity's ledger, so
                // the picker is scoped to that entity (+ Shared heads).
                const bookingEntityId = o.chargedToEntityId || o.entityId;
                return (
                  <TableRow key={row.id} data-state={selectedIds.has(row.id) ? 'selected' : undefined}>
                    <TableCell>{canPost && <Checkbox checked={selectedIds.has(row.id)} onCheckedChange={() => toggleRow(row.id)} aria-label="Select row" />}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{row.transactionDate}</TableCell>
                    <TableCell className="text-xs truncate" title={row.description}>{row.description}</TableCell>
                    <SpentReceivedCells amount={row.amount} currency={row.currency} />
                    {/* From/To — optional Customer or Vendor (sub-ledger tag).
                        Both types are always listed, whatever the sign: a
                        deposit can be a customer receipt OR a vendor refund.
                        Scoped to the charged-to entity (the ledger the line
                        lands in). */}
                    <TableCell>
                      <ContactSelect
                        contacts={contacts}
                        entityId={bookingEntityId ? Number(bookingEntityId) : null}
                        direction={row.amount >= 0 ? 'in' : 'out'}
                        value={o.contactId || ''}
                        onChange={(v) => selectContact(row, v)}
                        /* Money in: every entity's customers are pickable —
                           choosing one re-points Charged To to its entity. */
                        crossEntityType={row.amount > 0 && !o.chargedToManual ? 'Customer' : undefined}
                        entityNameOf={(id) => entityLabel(entities.find((e) => Number(e.id) === Number(id))?.name || `Entity ${id}`)}
                        onCreate={handleCreateContact(bookingEntityId || '')}
                        canCreate={canWriteContacts}
                        onAddNew={(typed) => setAddContact({ rowId: row.id, entityId: bookingEntityId || '', type: row.amount >= 0 ? 'Customer' : 'Vendor', name: typed })}
                        disabled={!canStage || !!row.staged?.splits}
                        className="w-full"
                        placeholder="From/To"
                      />
                    </TableCell>

                    {/* Categorize — the GL account the non-bank side posts to. */}
                    <TableCell>
                      {row.staged?.splits ? (
                        <div className="text-[11px] text-blue-700" data-staged-split>Split into {row.staged.splits.length} lines — open Split to review</div>
                      ) : (
                        <GLAccountSelect
                          accounts={glAccounts}
                          value={o.accountId || ''}
                          onChange={(v) => setOverride(row.id, { accountId: v })}
                          entityId={bookingEntityId ? Number(bookingEntityId) : null}
                          className="w-full"
                          placeholder="Categorize"
                          disabled={!canStage}
                          onCreateNew={canWriteCoa ? (typed) => setNewCategory({
                            rowId: row.id,
                            entityId: bookingEntityId || '',
                            type: row.amount > 0 ? 'Revenue' : 'Expense',
                            name: typed,
                          }) : undefined}
                        />
                      )}
                      {hasSuggestion && <div className="text-[10px] text-muted-foreground mt-0.5">Auto-suggested (rule match)</div>}
                      {row.amount > 0 && isExpenseAccount(glAccounts, o.accountId) && (
                        <div className="text-[10px] text-emerald-700 mt-0.5">Refund — credits the expense</div>
                      )}
                    </TableCell>

                    {/* Who bears the cost. Defaults to the paying bank's
                        entity; choosing another routes the post through
                        the cross-brand split engine, which raises the
                        Due From / To Affiliates pair automatically. */}
                    <TableCell>
                      <Select
                        value={o.chargedToEntityId || ''}
                        disabled={!canStage || !!row.staged?.splits}
                        onValueChange={(v) => setOverride(row.id, {
                          chargedToEntityId: v,
                          /* A manual choice overrides (and stops) the customer suggestion. */
                          chargedToManual: true,
                          chargedToSuggestedBy: undefined,
                          // Drop a GL head / payee the new charged-to entity can't book.
                          ...(accountFitsEntity(glAccounts, o.accountId, v) ? {} : { accountId: '' }),
                          ...(o.contactId && !contactFitsEntity(contacts, o.contactId, v) ? { contactId: '' } : {}),
                        })}
                      >
                        <SelectTrigger className="h-8 w-full px-2 text-xs" aria-label="Charged To"><SelectValue placeholder="Charged to" /></SelectTrigger>
                        <SelectContent>
                          {entities.map((e) => (
                            <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {o.chargedToSuggestedBy && (
                        <div className="text-[10px] text-blue-700 mt-0.5 truncate" data-charged-to-suggested title={`Set from ${o.chargedToSuggestedBy}'s entity — change it to override`}>
                          Suggested from customer
                        </div>
                      )}
                      {o.chargedToEntityId && Number(o.chargedToEntityId) !== Number(o.entityId) && (
                        <div className="text-[10px] text-amber-700 mt-0.5">Intercompany — raises Due From/To</div>
                      )}
                    </TableCell>

                    {/* Statutory row only: no Bank Account / Entity column
                        (the selected bank card shows both), no period
                        (transaction date dictates it), no rate (USD
                        conversion happens silently at posting). */}
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {canPost ? (
                          row.staged?.splits ? (
                            // A split saved for review is posted from the Split modal.
                            <Button size="sm" variant="outline" onClick={() => setSplitRow(row)} data-review-split>Review split</Button>
                          ) : (
                            <Button size="sm" disabled={postingId === row.id} onClick={() => handlePost(row)} className="h-8 min-h-8 px-2.5" data-post-row>
                              {postingId === row.id ? 'Posting…' : 'Post to Ledger'}
                            </Button>
                          )
                        ) : canStage ? (
                          <Button size="sm" variant="outline" disabled={stagingId === row.id || !!row.staged?.splits} onClick={() => handleSaveForReview(row)} data-save-for-review>
                            {stagingId === row.id ? 'Saving…' : 'Save for review'}
                          </Button>
                        ) : null}
                        {canStage && (
                          <Button size="icon" variant="outline" className="size-7 min-h-7 text-muted-foreground hover:text-foreground" onClick={() => setSplitRow(row)} title="Split transaction" aria-label="Split">
                            <Split className="size-3.5" />
                          </Button>
                        )}
                      </div>
                      {row.staged && (
                        <div className="mt-0.5 text-[10px] text-blue-700" data-staged-by={row.stagedByName || ''}>
                          Saved for review{row.stagedByName ? ` · ${row.stagedByName}` : ''}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <SplitTransactionModal
        row={splitRow}
        bankEntityId={splitRow ? overrideFor(splitRow).entityId || '' : ''}
        defaultAccountId={splitRow ? overrideFor(splitRow).accountId || '' : ''}
        defaultEntityId={splitRow ? overrideFor(splitRow).chargedToEntityId || overrideFor(splitRow).entityId || '' : ''}
        defaultContactId={splitRow ? overrideFor(splitRow).contactId || '' : ''}
        entities={entities}
        glAccounts={glAccounts}
        contacts={contacts}
        onCreateContact={handleCreateContact}
        postMode={canPost}
        canCreateContacts={canWriteContacts}
        onOpenChange={(open) => { if (!open) setSplitRow(null); }}
        onContactCreated={(created) => queryClient.setQueryData<Contact[]>(getListContactsQueryKey(), (old) => [...(old || []).filter((c) => c.id !== created.id), created])}
        onPosted={() => {
          const postedId = splitRow?.id;
          setSelectedIds((prev) => { const next = new Set(prev); if (postedId != null) next.delete(postedId); return next; });
          invalidateAll();
        }}
      />

      {newCategory && (
        <QuickAccountDialog
          key={`new-category-${newCategory.rowId}-${newCategory.name}`}
          open={!!newCategory}
          onOpenChange={(o) => { if (!o) setNewCategory(null); }}
          entities={entities}
          defaultEntityId={newCategory.entityId}
          defaultType={newCategory.type}
          defaultName={newCategory.name}
          onCreated={(account) => {
            const target = rows.find((r) => r.id === newCategory.rowId);
            if (!target) return;
            const o = overrideFor(target);
            const booking = o.chargedToEntityId || o.entityId;
            if (account.entityId == null || String(account.entityId) === String(booking)) {
              setOverride(target.id, { accountId: String(account.id) });
            } else {
              toast({ title: `${account.name} belongs to another entity`, description: "It can't be booked in this transaction's Charged To entity, so it wasn't selected." });
            }
          }}
        />
      )}

      {addContact && (
        <ContactFormDialog
          key={`add-${addContact.rowId}-${addContact.name}`}
          contact={null}
          defaultType={addContact.type}
          defaultEntityId={addContact.entityId}
          defaultName={addContact.name}
          open={!!addContact}
          onOpenChange={(o) => { if (!o) setAddContact(null); }}
          entities={entities}
          onSaved={(created) => {
            // Show it immediately and select it on the row it was created from —
            // if its entity/scope lets that row's entity use it.
            queryClient.setQueryData<Contact[]>(getListContactsQueryKey(), (old) => [...(old || []).filter((c) => c.id !== created.id), created]);
            const target = rows.find((r) => r.id === addContact.rowId);
            if (target) {
              const o = overrideFor(target);
              const booking = o.chargedToEntityId || o.entityId;
              const suggests = target.amount > 0 && created.contactType === 'Customer' && created.entityId != null && !o.chargedToManual;
              if (suggests || created.entityId == null || String(created.entityId) === String(booking)) {
                // A money-in customer also re-points Charged To to its entity.
                selectContact(target, String(created.id), created);
              } else {
                toast({ title: `${created.name} was created for another entity`, description: "It isn't available for this transaction's Charged To entity, so it wasn't selected." });
              }
            }
          }}
        />
      )}
    </div>
  );
}

// Resizable column specs for the two feed tables (index 0 of Pending is the
// select-all checkbox, which stays fixed).
const PENDING_COLUMNS: ResizableColumnDef[] = [
  { key: 'select', label: '', width: 36, resizable: false },
  // Description gets whatever the compact dropdown columns can spare — the
  // statement text is the part that needs reading (drag any border for more).
  { key: 'date', label: 'Date', width: 88, sortKey: 'date' },
  // Label is plain "Description" in both tables; the cells still render what
  // each view holds — the raw statement text here, the posted entry's
  // description on the Posted tab.
  { key: 'description', label: 'Description', width: 140, sortKey: 'description' },
  { key: 'spent', label: 'Spent', width: 86, align: 'right', sortKey: 'spent' },
  { key: 'received', label: 'Received', width: 86, align: 'right', sortKey: 'received' },
  { key: 'contact', label: 'From/To', width: 108 },
  { key: 'category', label: 'Categorize', width: 132, sortKey: 'category', filterKey: 'category' },
  { key: 'chargedTo', label: 'Charged To', width: 106, },
  { key: 'actions', label: 'Actions', width: 150 },
];
const PENDING_DEFAULT_WIDTHS = defaultWidths(PENDING_COLUMNS);
// No Bank Account column (2026-09-18): the selected bank card above the feed
// already says which account these rows belong to, so the width went to
// Description — long statement text is what actually needs the room. The
// bank name is still searchable from the toolbar.
// Same column sequence as Pending (2026-09-18), minus the select checkbox:
// the two tabs are two views of one feed, so From/To and Charged To sit in
// the same place on both — read-only here, since the values are whatever the
// journal entry recorded at posting time.
const POSTED_COLUMNS: ResizableColumnDef[] = [
  { key: 'date', label: 'Date', width: 88, sortKey: 'date' },
  { key: 'description', label: 'Description', width: 164, sortKey: 'description' },
  { key: 'spent', label: 'Spent', width: 92, align: 'right', sortKey: 'spent' },
  { key: 'received', label: 'Received', width: 92, align: 'right', sortKey: 'received' },
  { key: 'contact', label: 'From/To', width: 118 },
  { key: 'category', label: 'Categorize', width: 150, sortKey: 'category', filterKey: 'category' },
  { key: 'chargedTo', label: 'Charged To', width: 110 },
  // Wide enough for the Unpost button at its default width.
  { key: 'action', label: 'Action', width: 124, align: 'right' },
];
const POSTED_DEFAULT_WIDTHS = defaultWidths(POSTED_COLUMNS);

function PostedTransactionsTab({ bankAccountById, onLedgerChanged, filterBankAccountId, enabled = true, view, setView, onCounts }: {
  bankAccountById: Map<number, any>;
  onLedgerChanged: () => void;
  filterBankAccountId?: number;
  enabled?: boolean;
  /** Date range / search / sort / filters, shared with the Pending tab. */
  view: FeedView;
  setView: React.Dispatch<React.SetStateAction<FeedView>>;
  onCounts: (counts: { shown: number; total: number }) => void;
}) {
  const [unpostingId, setUnpostingId] = useState<number | null>(null);
  const canPost = useAuth().can('post');
  const { toast } = useToast();
  const unpost = useUnpostBankTransaction();

  // The selected bank card scopes the posted list.
  const { data: posted, isLoading: postedLoading } = useListBankTransactions(
    { status: 'POSTED', bankAccountId: filterBankAccountId },
    { query: { enabled } },
  );
  const isLoading = postedLoading || !enabled;

  // Undo a post: deletes the journal entry and returns the row to the
  // Pending tab. Confirmed first because it removes a ledger entry.
  const handleUnpost = (row: any) => {
    if (!confirm('Undo this posting? Its journal entry will be deleted and the transaction returns to the unposted feed.')) return;
    setUnpostingId(row.id);
    unpost.mutate(
      { id: row.id },
      {
        onSuccess: () => {
          toast({ title: 'Posting undone', description: 'The transaction is back in the unposted feed.' });
          onLedgerChanged();
        },
        onError: (err: any) => toast({ title: 'Could not undo posting', description: err.message, variant: 'destructive' }),
        onSettled: () => setUnpostingId(null),
      },
    );
  };

  const columns = useResizableColumns('finsys.banking.posted.columns.v5', POSTED_DEFAULT_WIDTHS);

  const allRows = useMemo(() => (posted || []) as any[], [posted]);
  const fieldsOf = React.useCallback((row: any): FeedRowFields => {
    const bankAccount = bankAccountById.get(row.bankAccountId);
    const categories = (row.categoryAccounts || []) as { name: string }[];
    return {
      date: row.transactionDate || '',
      bank: bankAccount ? `${bankAccount.bankName} — ${bankAccount.name}` : String(row.bankAccountId),
      description: row.description || '',
      amount: Number(row.amount) || 0,
      category: categories.map((c) => c.name).join(', '),
    };
  }, [bankAccountById]);

  const rows = useMemo(() => {
    const filtered = allRows.filter((r) => {
      const f = fieldsOf(r);
      if (view.dateFrom && f.date < view.dateFrom) return false;
      if (view.dateTo && f.date > view.dateTo) return false;
      return matchesSearch(f, view.search) && passesFilters(f, view.filters);
    });
    return sortRows(filtered, view.sort, fieldsOf);
  }, [allRows, view, fieldsOf]);

  const filterOptions = useMemo(() => ({
    bank: [...new Set(allRows.map((r) => fieldsOf(r).bank).filter(Boolean))].sort(),
    category: [...new Set(allRows.map((r) => fieldsOf(r).category).filter(Boolean))].sort(),
  }), [allRows, fieldsOf]);

  React.useEffect(() => { onCounts({ shown: rows.length, total: allRows.length }); }, [rows.length, allRows.length, onCounts]);

  return (
    <div>

      <div className="border-t overflow-x-auto">
        <Table
          className="table-fixed [&_td]:overflow-hidden [&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4"
          style={columns.tableStyle}
          data-resizable-table="posted"
        >
          <ResizableColGroup widths={columns.widths} />
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <ResizableHeaderCells
                columns={POSTED_COLUMNS}
                table={columns}
                sort={view.sort}
                onSortChange={(sort) => setView((prev) => ({ ...prev, sort }))}
                filters={view.filters}
                onFiltersChange={(filters) => setView((prev) => ({ ...prev, filters }))}
                filterOptions={filterOptions}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>{POSTED_COLUMNS.map((c) => <TableCell key={c.key}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={POSTED_COLUMNS.length} className="text-center py-8 text-muted-foreground font-mono text-sm">
                {allRows.length === 0 ? 'No posted transactions' : 'No transactions match the current search or filters'}
              </TableCell></TableRow>
            ) : (
              rows.map((row) => {
                const categories = (row.categoryAccounts || []) as { accountId: number; code: string; name: string }[];
                const categoryLabel = categories.map((c) => c.name).join(', ');
                // Derived from the ledger on every read (server-side): the
                // contact(s) tagged on the posted lines, and the entity that
                // bears the cost — not necessarily the one that paid.
                const rowContacts = (row.contacts || []) as { id: number; name: string; contactType: string }[];
                const chargedTo = (row.chargedToEntities || []) as { entityId: number; name: string }[];
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs whitespace-nowrap">{row.transactionDate}</TableCell>
                    {/* Wraps rather than truncating: this is the read-only
                        view, and statement text routinely runs longer than
                        any sane column width. */}
                    <TableCell className="whitespace-normal break-words text-xs leading-snug" title={row.description}>{row.description}</TableCell>
                    <SpentReceivedCells amount={row.amount} currency={row.currency} />
                    {/* Payee / customer recorded on the posted lines. */}
                    <TableCell className="text-xs" data-posted-contact>
                      {rowContacts.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="truncate" title={rowContacts.map((c) => `${c.name} (${c.contactType})`).join('\n')}>
                          {rowContacts.map((c) => c.name).join(', ')}
                        </div>
                      )}
                    </TableCell>
                    {/* The GL account(s) the transaction was categorized to when posted. */}
                    <TableCell className="text-xs" data-posted-category>
                      {categories.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="truncate" title={categories.map((c) => `${c.code} ${c.name}`).join('\n')}>
                          {categoryLabel}
                          {categories.length > 1 && <span className="ml-1 text-[10px] text-muted-foreground">(split)</span>}
                        </div>
                      )}
                    </TableCell>
                    {/* Entity that bears the cost. Flagged when it isn't the
                        entity whose bank account paid — that post raised an
                        intercompany Due From / Due To pair. */}
                    <TableCell className="text-xs" data-posted-charged-to>
                      {chargedTo.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          <div className="truncate" title={chargedTo.map((e) => entityLabel(e.name)).join('\n')}>
                            {chargedTo.map((e) => entityLabel(e.name)).join(', ')}
                          </div>
                          {chargedTo.some((e) => Number(e.entityId) !== Number(bankAccountById.get(row.bankAccountId)?.entityId)) && (
                            <div className="text-[10px] text-blue-700">Intercompany</div>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Unposting removes journal entries — posting roles only. */}
                      {canPost && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground hover:text-foreground"
                          disabled={unpostingId === row.id}
                          onClick={() => handleUnpost(row)}
                        >
                          <Undo2 className="mr-1.5 size-3" />
                          {unpostingId === row.id ? 'Undoing…' : 'Unpost'}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// Unified Banking screen (2026-09-11, second nav pass). Accounts and
// transactions were briefly two nav entries; they are now one page —
// bank cards on top, the transaction feed directly below — because the
// two are a single workflow: you look at what a bank is holding, then
// post what came through it, without a nav round trip. Both halves
// already shared this component's account list, modals and posting
// mutations, so merging the views removed the `view` prop rather than
// adding anything.
export default function BankTransactionsHub() {
  const { can } = useAuth();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTargetAccountId, setUploadTargetAccountId] = useState<number | null>(null);
  // Which bank card the transaction feed below is scoped to: a COA account
  // id (cards are COA-driven), 'ALL', or null meaning "not decided yet".
  //
  // null is the key state (2026-09-11). It is distinct from 'ALL': null
  // means the cards haven't loaded so we don't yet know which account to
  // default to, whereas 'ALL' is a deliberate choice the user made with
  // the pill. Without that distinction the auto-select effect below would
  // either never fire, or would fight the user every time they clicked
  // "View All Accounts".
  const [selectedAccountId, setSelectedAccountId] = useState<number | 'ALL' | null>(null);
  const [linkNewAccountsOpen, setLinkNewAccountsOpen] = useState(false);
  const [linkedInstitution, setLinkedInstitution] = useState<string | null>(null);
  // Exactly what the exchange returned, handed to the mapping modal.
  const [linkedAccounts, setLinkedAccounts] = useState<any[]>([]);
  // Date range, search, sort and column filters — shared by both tabs.
  const feedView = useFeedView();
  const [feedCounts, setFeedCounts] = useState<{ shown: number; total: number }>({ shown: 0, total: 0 });
  // Currency switcher removed globally (2026-09-11) — every figure is
  // shown in USD, the functional reporting currency. The backend still
  // translates each foreign-currency bank balance into USD at its own
  // month's rate; only the per-user display toggle is gone.
  const displayCurrency = 'USD';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Cards come from the Chart of Accounts, not from bank_accounts.
  const { data: cardsResult, isLoading: bankAccountsLoading } = useBankingCards({ currency: displayCurrency });
  const { data: bankAccounts } = useListBankAccounts();
  const { data: entities } = useListEntities();
  const { data: brands } = useListBrands();
  const { data: accounts } = useListAccounts();
  const refreshBalance = useRefreshBankAccountBalance();
  const syncPlaid = useSyncPlaidBankAccount();
  const [syncingId, setSyncingId] = useState<number | null>(null);

  const invalidateBankAccounts = () => queryClient.invalidateQueries({ queryKey: getListBankAccountsQueryKey() });
  const invalidateLedgerViews = () => invalidateLedgerDerivedQueries(queryClient);

  const { connect: connectBank, connecting } = useConnectBank((institutionName, accountsFromLink) => {
    setLinkedInstitution(institutionName);
    setLinkedAccounts(accountsFromLink);
    setLinkNewAccountsOpen(true);
  });

  const handleSyncNow = (bankAccountId: number) => {
    setSyncingId(bankAccountId);
    syncPlaid.mutate(
      { bankAccountId },
      {
        onSuccess: (res: any) => {
          toast({ title: `Synced ${res.added} new transaction(s)`, description: res.duplicatesSkipped ? `${res.duplicatesSkipped} already up to date` : undefined });
          queryClient.invalidateQueries({ queryKey: getUnpostedBankTransactionsQueryKey() });
          refreshBalance.mutate({ bankAccountId }, { onSuccess: invalidateBankAccounts });
        },
        onError: (err: any) => toast({ title: 'Sync failed', description: err.message, variant: 'destructive' }),
        onSettled: () => setSyncingId(null),
      },
    );
  };

  const bankCards = ((cardsResult as any)?.cards || []) as any[];

  // Auto-select the first card as soon as the cards arrive. Only fires
  // while the selection is still null, so it never overrides a user who
  // has picked a different card or "View All Accounts".
  React.useEffect(() => {
    if (selectedAccountId === null && bankCards.length > 0) {
      setSelectedAccountId(bankCards[0].accountId);
    }
  }, [selectedAccountId, bankCards]);

  // With zero bank cards there is nothing to auto-select, so fall through
  // to the unscoped view rather than holding the feed hidden forever.
  const selectionResolved = selectedAccountId !== null || (!bankAccountsLoading && bankCards.length === 0);

  const selectedCard = selectedAccountId === 'ALL' || selectedAccountId === null
    ? null
    : bankCards.find((c) => c.accountId === selectedAccountId) || null;
  // Transactions hang off the FEED row (bank_accounts.id), not the COA
  // account. A card with no feed yet has never had a statement uploaded,
  // so -1 is used to force an empty result rather than falling back to
  // "show everything", which would be a silent lie about the filter.
  const selectedFeedId = selectedCard ? (selectedCard.bankAccountId ?? -1) : undefined;
  const bankAccountsList = (bankAccounts || []) as any[];
  const entitiesList = (entities || []) as any[];
  const brandsList = (brands || []) as any[];

  const entityById = useMemo(() => {
    const map = new Map<number, any>();
    entitiesList.forEach((e) => map.set(e.id, e));
    return map;
  }, [entitiesList]);

  const bankAccountById = useMemo(() => {
    const map = new Map<number, any>();
    bankAccountsList.forEach((a) => map.set(a.id, a));
    return map;
  }, [bankAccountsList]);

  const linkedPlaidAccountIds = useMemo(
    () => new Set(bankAccountsList.filter((a) => a.plaidAccountId).map((a) => a.plaidAccountId as string)),
    [bankAccountsList],
  );
  // COA heads already backing a feed — not offered again when mapping.
  const linkedGlAccountIds = useMemo(
    () => new Set(bankAccountsList.map((a) => a.glAccountId).filter(Boolean) as number[]),
    [bankAccountsList],
  );

  const glAccounts = useMemo(
    () => ((accounts || []) as any[]).filter((a) => GL_TARGET_TYPES.has(a.type) && a.category !== 'Cash & Equivalents'),
    [accounts],
  );

  return (
    <>
      <PageHeader title="Bank Transactions" description="Bank balances and the transaction feed they produce, in one place">
        {can('import') && (
          // The only Upload Statement entry point — preselects the selected card, if any.
          <Button variant="outline" onClick={() => { setUploadTargetAccountId(typeof selectedAccountId === 'number' ? selectedAccountId : null); setUploadOpen(true); }}>
            <UploadCloud className="mr-2 size-4" /> Upload Statement
          </Button>
        )}
        {/* Linking a live bank integration is an Admin setting. */}
        {can('admin') && (
          <Button onClick={connectBank} disabled={connecting}>
            <Link2 className="mr-2 size-4" /> {connecting ? 'Opening…' : 'Connect Bank'}
          </Button>
        )}
      </PageHeader>

      <PageContent>
        {/* Top section — one card per active Chart of Accounts bank head.
            Clicking a card scopes the transaction feed below to it. */}
        <div>
          {/* Label only. To see every account's feed, click the selected
              card again — it toggles back to all accounts. */}
          <div className="mb-2.5">
            <SectionLabel>Bank Accounts</SectionLabel>
          </div>
          {/* Fixed-size square-ish cards that wrap, rather than columns that stretch. */}
          <div className="flex flex-wrap gap-3">
            {bankAccountsLoading ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="w-[232px] aspect-[4/3] rounded-lg" />)
            ) : bankCards.length === 0 ? (
              <div className="w-full rounded-lg border border-dashed border-gray-200 bg-white/60 px-6 py-10 text-center">
                <div className="text-[14px] font-semibold text-gray-900">No Connected Accounts</div>
                <div className="mt-1 text-[13px] text-gray-500">
                  Click “Connect Bank” for a live Plaid feed, or add an Asset account with sub-type “Bank” in the
                  Chart of Accounts to track one by CSV statement.
                </div>
              </div>
            ) : (
              bankCards.map((c) => (
                <BankAccountCard
                  key={c.accountId}
                  card={c}
                  entityName={c.entityId ? entityById.get(c.entityId)?.name : undefined}
                  selected={selectedAccountId === c.accountId}
                  onSelect={() =>
                    // Clicking the active card clears the filter, so the
                    // card doubles as its own toggle.
                    setSelectedAccountId((prev) => (prev === c.accountId ? 'ALL' : c.accountId))
                  }
                  onSyncNow={can('admin') ? () => c.bankAccountId && handleSyncNow(c.bankAccountId) : undefined}
                  syncing={!!c.bankAccountId && syncingId === c.bankAccountId}
                />
              ))
            )}
          </div>
        </div>

        {/* Bottom section — the feed those accounts produce, with the
            same 1-click posting actions as before. Scoped to the selected
            card when one is active. */}
        <div>
          <div className="mb-2.5 flex items-center gap-2 flex-wrap">
            <SectionLabel>Transaction Feed</SectionLabel>
            {selectedCard && (
              <span className="text-[11px] text-gray-500">
                showing <span className="font-medium text-gray-900">{selectedCard.name}</span>
                <span className="font-mono text-gray-400"> ({selectedCard.code})</span> only
              </span>
            )}
          </div>
          {/* One card: underline tabs as its header, filters/banners, then
              the table flush to the card edges. */}
          <Tabs defaultValue="pending" className="overflow-hidden rounded-lg border bg-card shadow-sm" data-feed-card>
            <TabsList className="h-auto w-full justify-start gap-5 rounded-none bg-transparent px-4 pt-1 pb-0">
              {(['pending', 'posted'] as const).map((v) => (
                <TabsTrigger
                  key={v}
                  value={v}
                  className="relative rounded-none px-0.5 pt-2.5 pb-2 text-[13px] font-medium text-muted-foreground shadow-none transition-colors hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                >
                  {v === 'pending' ? 'Pending Transactions' : 'Posted Transactions'}
                </TabsTrigger>
              ))}
            </TabsList>
            {/* Date range + search live ABOVE the tab panels, so both tabs
                share them and they survive switching. */}
            <div className="border-t px-4 py-2.5">
              <FeedToolbar
                view={feedView.view}
                set={feedView.set}
                activeFilterCount={feedView.activeFilterCount}
                reset={feedView.reset}
                resultCount={feedCounts.shown}
                totalCount={feedCounts.total}
              />
            </div>
            <TabsContent value="pending" className="mt-0">
              <PendingTransactionsTab
                bankAccounts={bankAccountsList}
                entities={entitiesList}
                brands={brandsList}
                glAccounts={glAccounts}
                bankAccountById={bankAccountById}
                filterBankAccountId={selectedFeedId}
                enabled={selectionResolved}
                view={feedView.view}
                setView={feedView.setView}
                onCounts={setFeedCounts}
              />
            </TabsContent>
            <TabsContent value="posted" className="mt-0">
              <PostedTransactionsTab
                view={feedView.view}
                setView={feedView.setView}
                onCounts={setFeedCounts}
                bankAccountById={bankAccountById}
                onLedgerChanged={invalidateLedgerViews}
                filterBankAccountId={selectedFeedId}
                enabled={selectionResolved}
              />
            </TabsContent>
          </Tabs>
        </div>
      </PageContent>

      <UploadStatementModal
        open={uploadOpen}
        onOpenChange={(o) => { setUploadOpen(o); if (!o) setUploadTargetAccountId(null); }}
        cards={bankCards}
        entities={entitiesList}
        preselectedAccountId={uploadTargetAccountId}
      />
      <LinkNewAccountsModal
        open={linkNewAccountsOpen}
        onOpenChange={(o) => { setLinkNewAccountsOpen(o); if (!o) setLinkedAccounts([]); }}
        institutionName={linkedInstitution}
        entities={entitiesList}
        accounts={(accounts || []) as any[]}
        linkedGlAccountIds={linkedGlAccountIds}
        linkedAccounts={linkedAccounts}
        bankAccounts={bankAccountsList}
        onDone={invalidateBankAccounts}
      />
    </>
  );
}
