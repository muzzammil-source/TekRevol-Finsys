import React, { useMemo, useState } from 'react';
import {
  useListBankAccounts,
  useListEntities,
  useListJournalEntries,
  useListReconciliations,
  useGetReconciliation,
  useCreateReconciliation,
  useAutoMatchReconciliation,
  useAddReconciliationMatch,
  useDeleteReconciliationMatch,
  useCompleteReconciliation,
  useLockPeriod,
  getReconciliationQueryKey,
  getListReconciliationsQueryKey,
} from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { BankSummaryCards } from '@/components/bank-summary-cards';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { entityLabel } from '@/lib/constants';
import { CheckCircle2, Lock, ScanSearch, XCircle } from 'lucide-react';
import { format } from 'date-fns';

function formatMoney(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

function monthAgoIso() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return format(d, 'yyyy-MM-dd');
}

export default function BankReconciliation() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: bankAccounts } = useListBankAccounts();
  const { data: entities } = useListEntities();
  const { data: journalEntries } = useListJournalEntries();

  const bankAccountsList = (bankAccounts || []) as any[];
  const entitiesList = (entities || []) as any[];

  const entityById = useMemo(() => {
    const map = new Map<number, any>();
    entitiesList.forEach((e) => map.set(e.id, e));
    return map;
  }, [entitiesList]);

  const journalEntryById = useMemo(() => {
    const map = new Map<number, any>();
    ((journalEntries || []) as any[]).forEach((je) => map.set(je.id, je));
    return map;
  }, [journalEntries]);

  // `?account=<bankAccountId>` preselects the account, so the summary cards
  // can link straight into reconciling a specific one. Read once on mount:
  // after that the dropdown owns the selection.
  const [bankAccountId, setBankAccountId] = useState<string>(
    () => new URLSearchParams(window.location.search).get('account') || '',
  );
  const [startDate, setStartDate] = useState(monthAgoIso());
  const [endDate, setEndDate] = useState(todayIso());
  const [statementEndingBalance, setStatementEndingBalance] = useState('');
  const [activeReconciliationId, setActiveReconciliationId] = useState<number | null>(null);

  const selectedBankAccount = bankAccountsList.find((a) => a.id === Number(bankAccountId));

  const { data: sessionsForAccount } = useListReconciliations(
    bankAccountId ? { bankAccountId: Number(bankAccountId) } : undefined,
    { query: { enabled: !!bankAccountId } },
  );

  const createReconciliation = useCreateReconciliation();
  const autoMatch = useAutoMatchReconciliation();
  const addMatch = useAddReconciliationMatch();
  const deleteMatch = useDeleteReconciliationMatch();
  const completeReconciliation = useCompleteReconciliation();
  const lockPeriod = useLockPeriod();

  const { data: reconciliation, isLoading: reconciliationLoading } = useGetReconciliation(activeReconciliationId ?? undefined);

  const invalidateActive = () => {
    if (activeReconciliationId) queryClient.invalidateQueries({ queryKey: getReconciliationQueryKey(activeReconciliationId) });
    if (bankAccountId) queryClient.invalidateQueries({ queryKey: getListReconciliationsQueryKey({ bankAccountId: Number(bankAccountId) }) });
  };

  const handleStartReconciliation = () => {
    if (!bankAccountId || !startDate || !endDate) return;
    createReconciliation.mutate(
      {
        data: {
          bankAccountId: Number(bankAccountId),
          statementStartDate: startDate,
          statementEndDate: endDate,
          statementEndingBalance: statementEndingBalance ? Number(statementEndingBalance) : 0,
        },
      },
      {
        onSuccess: (res) => {
          setActiveReconciliationId(res.id);
          toast({ title: 'Reconciliation session started' });
          queryClient.invalidateQueries({ queryKey: getListReconciliationsQueryKey({ bankAccountId: Number(bankAccountId) }) });
        },
        onError: (err: any) => toast({ title: 'Failed to start reconciliation', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const handleAutoMatch = () => {
    if (!activeReconciliationId) return;
    autoMatch.mutate(
      { id: activeReconciliationId },
      {
        onSuccess: (matches) => {
          toast({ title: `Auto-match found ${matches.length} pair(s)` });
          invalidateActive();
        },
        onError: (err: any) => toast({ title: 'Auto-match failed', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const [selectedBankTxnId, setSelectedBankTxnId] = useState<number | null>(null);
  const [selectedJournalLineId, setSelectedJournalLineId] = useState<number | null>(null);

  const handleConfirmMatch = () => {
    if (!activeReconciliationId || !selectedBankTxnId || !selectedJournalLineId) return;
    addMatch.mutate(
      { id: activeReconciliationId, bankTransactionId: selectedBankTxnId, journalLineId: selectedJournalLineId },
      {
        onSuccess: () => {
          toast({ title: 'Matched' });
          setSelectedBankTxnId(null);
          setSelectedJournalLineId(null);
          invalidateActive();
        },
        onError: (err: any) => toast({ title: 'Match failed', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const handleUnmatch = (matchId: number) => {
    if (!activeReconciliationId) return;
    deleteMatch.mutate(
      { id: activeReconciliationId, matchId },
      {
        onSuccess: () => { toast({ title: 'Match removed' }); invalidateActive(); },
        onError: (err: any) => toast({ title: 'Failed to remove match', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const handleComplete = () => {
    if (!activeReconciliationId) return;
    completeReconciliation.mutate(
      { id: activeReconciliationId },
      {
        onSuccess: () => { toast({ title: 'Reconciliation completed' }); invalidateActive(); },
        onError: (err: any) => toast({ title: 'Cannot complete', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const handleLockPeriod = () => {
    if (!selectedBankAccount) return;
    const periodMonth = endDate.slice(0, 7);
    lockPeriod.mutate(
      { entityId: selectedBankAccount.entityId, periodMonth },
      {
        onSuccess: () => {
          toast({ title: `Period ${periodMonth} locked for ${entityLabel(entityById.get(selectedBankAccount.entityId)?.name || '')}` });
          invalidateActive();
        },
        onError: (err: any) => toast({ title: 'Cannot lock period', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const matchBadge = (matchType: string) => {
    const variant = matchType === 'EXACT' ? 'default' : matchType === 'SUGGESTED' ? 'secondary' : 'outline';
    return <Badge variant={variant as any} className="text-[10px] uppercase">{matchType}</Badge>;
  };

  return (
    <>
      <PageHeader title="Bank Reconciliation" description="Match bank statement activity against posted GL cash movements, then lock the period">
        {reconciliation && reconciliation.status === 'DRAFT' && (
          <Button variant="outline" onClick={handleAutoMatch} disabled={autoMatch.isPending}>
            <ScanSearch className="mr-2 size-4" /> {autoMatch.isPending ? 'Matching…' : 'Auto-Match Statement'}
          </Button>
        )}
        {reconciliation && reconciliation.status === 'DRAFT' && (
          <Button onClick={handleComplete} disabled={!reconciliation.isReconciled || completeReconciliation.isPending}>
            <CheckCircle2 className="mr-2 size-4" /> Complete Reconciliation
          </Button>
        )}
        {reconciliation && reconciliation.status !== 'DRAFT' && (
          <Button onClick={handleLockPeriod} disabled={lockPeriod.isPending}>
            <Lock className="mr-2 size-4" /> {lockPeriod.isPending ? 'Locking…' : 'Lock Period'}
          </Button>
        )}
      </PageHeader>
      <PageContent>
        {/* Where every account stands before picking one to reconcile. */}
        <BankSummaryCards entities={entitiesList} />

        {/* Period & Account Selector */}
        <div className="border border-gray-100 rounded-2xl bg-white shadow-sm p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block">Bank Account</label>
              <Select value={bankAccountId} onValueChange={(v) => { setBankAccountId(v); setActiveReconciliationId(null); }}>
                <SelectTrigger><SelectValue placeholder="Select bank account" /></SelectTrigger>
                <SelectContent>
                  {bankAccountsList.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.bankName} — {a.name} ({entityLabel(entityById.get(a.entityId)?.name || '')})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Statement Start Date</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Statement End Date</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Statement Ending Balance</label>
              <Input type="number" step="0.01" placeholder="0.00" value={statementEndingBalance} onChange={(e) => setStatementEndingBalance(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Button size="sm" onClick={handleStartReconciliation} disabled={!bankAccountId || createReconciliation.isPending}>
              {createReconciliation.isPending ? 'Starting…' : 'Start New Reconciliation'}
            </Button>
            {!!(sessionsForAccount as any[])?.length && (
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <span className="text-xs text-muted-foreground">Existing sessions:</span>
                {(sessionsForAccount as any[]).map((s) => (
                  <Button
                    key={s.id}
                    size="sm"
                    variant={activeReconciliationId === s.id ? 'default' : 'outline'}
                    className="h-7 text-xs"
                    onClick={() => setActiveReconciliationId(s.id)}
                  >
                    {s.statementStartDate} → {s.statementEndDate} · {s.status}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>

        {activeReconciliationId && reconciliationLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}

        {reconciliation && (
          <>
            {/* Variance Summary Bar */}
            <div className={`border rounded-sm p-4 flex flex-wrap items-center justify-between gap-4 ${reconciliation.isReconciled ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <div className="text-xs text-muted-foreground">Statement Ending Balance</div>
                  <div className="text-lg font-semibold font-mono">{formatMoney(reconciliation.statementEndingBalance, selectedBankAccount?.currency)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Reconciled GL Cash Balance</div>
                  <div className="text-lg font-semibold font-mono">{formatMoney(reconciliation.glEndingBalance, selectedBankAccount?.currency)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Variance</div>
                  <div className={`text-lg font-semibold font-mono ${reconciliation.isReconciled ? 'text-green-700' : 'text-amber-700'}`}>
                    {formatMoney(reconciliation.variance, selectedBankAccount?.currency)}
                  </div>
                </div>
              </div>
              <Badge variant={reconciliation.isReconciled ? 'default' : 'secondary'} className={reconciliation.isReconciled ? 'bg-green-600 text-white' : ''}>
                {reconciliation.isReconciled ? <><CheckCircle2 className="mr-1 size-3.5" /> Balanced</> : <><XCircle className="mr-1 size-3.5" /> Out of Balance</>}
              </Badge>
              <Badge variant="outline" className="uppercase text-[10px]">{reconciliation.status}</Badge>
            </div>

            {/* Matched pairs */}
            {reconciliation.matches?.length > 0 && (
              <div className="border border-gray-100 rounded-2xl bg-white shadow-sm">
                <div className="px-4 py-2 text-xs font-medium text-muted-foreground border-b">Matched ({reconciliation.matches.length})</div>
                <Table>
                  <TableBody>
                    {reconciliation.matches.map((m: any) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs">{matchBadge(m.matchType)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">score {m.matchScore}</TableCell>
                        <TableCell className="text-xs">{m.bankTransactionId ? `Bank txn #${m.bankTransactionId}` : '—'}</TableCell>
                        <TableCell className="text-xs">{m.journalLineId ? `GL line #${m.journalLineId}` : '—'}</TableCell>
                        <TableCell className="text-right">
                          {reconciliation.status === 'DRAFT' && (
                            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleUnmatch(m.id)}>Unmatch</Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Side-by-side matching view */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="border border-gray-100 rounded-2xl bg-white shadow-sm">
                <div className="px-4 py-2 text-xs font-medium text-muted-foreground border-b">Unreconciled Bank Statement Lines ({reconciliation.unmatchedBankTransactions.length})</div>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead className="text-xs">Date</TableHead>
                      <TableHead className="text-xs">Description</TableHead>
                      <TableHead className="text-xs text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconciliation.unmatchedBankTransactions.length === 0 ? (
                      <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground text-xs">All bank lines reconciled</TableCell></TableRow>
                    ) : (
                      reconciliation.unmatchedBankTransactions.map((bt: any) => (
                        <TableRow
                          key={bt.id}
                          className="cursor-pointer"
                          data-state={selectedBankTxnId === bt.id ? 'selected' : undefined}
                          onClick={() => setSelectedBankTxnId(selectedBankTxnId === bt.id ? null : bt.id)}
                        >
                          <TableCell className="text-xs whitespace-nowrap">{bt.transactionDate}</TableCell>
                          <TableCell className="text-xs max-w-[200px] truncate">{bt.description}</TableCell>
                          <TableCell className={`text-right font-mono text-xs ${bt.amount >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {formatMoney(bt.amount, bt.currency)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="border border-gray-100 rounded-2xl bg-white shadow-sm">
                <div className="px-4 py-2 text-xs font-medium text-muted-foreground border-b">Unreconciled Ledger Lines ({reconciliation.unmatchedJournalLines.length})</div>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead className="text-xs">Date</TableHead>
                      <TableHead className="text-xs">Journal Entry</TableHead>
                      <TableHead className="text-xs text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconciliation.unmatchedJournalLines.length === 0 ? (
                      <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground text-xs">All ledger lines reconciled</TableCell></TableRow>
                    ) : (
                      reconciliation.unmatchedJournalLines.map((jl: any) => {
                        const je = journalEntryById.get(jl.journalEntryId);
                        // Matches server's bankLineSignedAmount() convention (debit - credit),
                        // the same sign convention as bank_transactions.amount (positive =
                        // credit/money in) — so this visually lines up with the left column.
                        const signed = (jl.debit || 0) - (jl.credit || 0);
                        return (
                          <TableRow
                            key={jl.id}
                            className="cursor-pointer"
                            data-state={selectedJournalLineId === jl.id ? 'selected' : undefined}
                            onClick={() => setSelectedJournalLineId(selectedJournalLineId === jl.id ? null : jl.id)}
                          >
                            <TableCell className="text-xs whitespace-nowrap">{je?.transactionDate || '—'}</TableCell>
                            <TableCell className="text-xs max-w-[200px] truncate">{je?.entryNumber} — {je?.description || jl.memo}</TableCell>
                            <TableCell className={`text-right font-mono text-xs ${signed >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                              {formatMoney(signed, jl.currency)}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            {reconciliation.status === 'DRAFT' && (
              <div className="flex justify-end">
                <Button size="sm" disabled={!selectedBankTxnId || !selectedJournalLineId || addMatch.isPending} onClick={handleConfirmMatch}>
                  {addMatch.isPending ? 'Matching…' : 'Confirm Manual Match'}
                </Button>
              </div>
            )}
          </>
        )}
      </PageContent>
    </>
  );
}
