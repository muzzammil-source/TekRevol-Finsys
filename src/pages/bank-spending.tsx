import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useCreateManualPlaidItem,
  useCreatePlaidLinkToken,
  useDeletePlaidItem,
  useExchangePlaidPublicToken,
  usePlaidAccounts,
  usePlaidItems,
  usePlaidStatements,
  usePlaidStatus,
  usePlaidUnpostedTransactions,
  useSyncPlaidItem,
  useUpdatePlaidTransactionReview,
  useUploadPlaidStatement,
} from '@workspace/api-client-react';
import { usePlaidLink } from 'react-plaid-link';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Download,
  FileText,
  Filter,
  Landmark,
  Link2,
  ListFilter,
  MoreHorizontal,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Upload,
  WalletCards,
  X,
} from 'lucide-react';
import { PageContent, PageHeader } from '@/components/layout';
import { FormatCurrency } from '@/components/formatters';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const MANUAL_BANK_COUNTRIES = [
  { value: 'AE', label: 'United Arab Emirates', currency: 'AED' },
  { value: 'SA', label: 'Saudi Arabia', currency: 'SAR' },
  { value: 'QA', label: 'Qatar', currency: 'QAR' },
  { value: 'KW', label: 'Kuwait', currency: 'KWD' },
  { value: 'BH', label: 'Bahrain', currency: 'BHD' },
  { value: 'OM', label: 'Oman', currency: 'OMR' },
  { value: 'PK', label: 'Pakistan', currency: 'PKR' },
];

const BANK_ICON_OPTIONS = ['◆', '◈', '▣', '▤', '◌'];
type ReviewTab = 'pending' | 'posted' | 'excluded';
type DateRange = 'all' | '30' | '90';
type RowDisposition = 'posted' | 'excluded';
type ReviewStatus = 'pending' | RowDisposition;
type RowReview = 'matched' | 'categorized';

function BankMark({ item, large = false }: { item: any; large?: boolean }) {
  const fallback = String(item?.institutionName || 'B').trim().slice(0, 2).toUpperCase();
  return (
    <div className={`flex shrink-0 items-center justify-center rounded-md border border-[#c5d4d0] bg-[#e7efeb] font-mono font-semibold text-[#1f5d63] ${large ? 'size-11 text-lg' : 'size-8 text-[11px]'}`}>
      {item?.icon || fallback}
    </div>
  );
}

function CountBadge({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${active ? 'bg-[#d7e8e4] text-[#174e53]' : 'bg-[#e8ece9] text-[#61706e]'}`}>{children}</span>;
}

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function dateIsWithin(value: string | undefined, range: DateRange) {
  if (!value || range === 'all') return true;
  const date = new Date(`${value}T00:00:00`).getTime();
  return Date.now() - date <= Number(range) * 24 * 60 * 60 * 1000;
}

function transactionKey(transaction: any) {
  return String(transaction.plaidTransactionId || `${transaction.date}-${transaction.name}-${transaction.amount}`);
}

function transactionDisposition(transaction: any): ReviewStatus {
  return transaction.reviewStatus === 'posted' || transaction.reviewStatus === 'excluded'
    ? transaction.reviewStatus
    : 'pending';
}

export default function BankSpending() {
  const queryClient = useQueryClient();
  const { data: plaidStatus, isLoading: isLoadingStatus } = usePlaidStatus();
  const { data: plaidItems, isLoading: isLoadingBanks, isError: isBanksError } = usePlaidItems();
  const { data: plaidAccounts } = usePlaidAccounts();
  const [selectedBankId, setSelectedBankId] = useState<number>();
  const banks = useMemo(() => (plaidItems as any[]) || [], [plaidItems]);
  const selectedBank = banks.find((item) => item.id === selectedBankId);
  const { data: unpostedTransactions, isLoading: isLoadingUnposted, isError: isTransactionsError, refetch: refetchTransactions } = usePlaidUnpostedTransactions(selectedBankId);
  const { data: statements, isLoading: isLoadingStatements } = usePlaidStatements(selectedBankId);
  const createLinkToken = useCreatePlaidLinkToken();
  const createManualBank = useCreateManualPlaidItem();
  const exchangeToken = useExchangePlaidPublicToken();
  const syncItem = useSyncPlaidItem();
  const updateTransactionReview = useUpdatePlaidTransactionReview();
  const deleteItem = useDeletePlaidItem();
  const uploadStatement = useUploadPlaidStatement();
  const [linkToken, setLinkToken] = useState<string>();
  const [manualBankOpen, setManualBankOpen] = useState(false);
  const [statementUploadOpen, setStatementUploadOpen] = useState(false);
  const [statementFile, setStatementFile] = useState<File>();
  const [manualBank, setManualBank] = useState({ institutionName: '', country: 'PK', icon: '◆' });
  const [tab, setTab] = useState<ReviewTab>('pending');
  const [query, setQuery] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [classFilter, setClassFilter] = useState('all');
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [reviews, setReviews] = useState<Record<string, RowReview>>({});
  const [visibleColumns, setVisibleColumns] = useState({ class: true, location: true, account: true });
  const [notice, setNotice] = useState('');

  const transactionFeed = useMemo(() => (unpostedTransactions as any) || {}, [unpostedTransactions]);
  const allTransactions = useMemo<any[]>(() => transactionFeed.transactions || [], [transactionFeed]);
  const accounts = useMemo(() => (plaidAccounts as any[]) || [], [plaidAccounts]);

  useEffect(() => {
    if (banks.length && !banks.some((item) => item.id === selectedBankId)) setSelectedBankId(banks[0].id);
    if (!banks.length) setSelectedBankId(undefined);
  }, [banks, selectedBankId]);

  useEffect(() => {
    setSelectedRows(new Set());
    setExpandedRows(new Set());
  }, [tab, selectedBankId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const onPlaidSuccess = useCallback((publicToken: string | null, metadata: any) => {
    if (!publicToken) return;
    exchangeToken.mutate(
      {
        publicToken,
        institution: metadata?.institution ? { institution_id: metadata.institution.institution_id, name: metadata.institution.name } : undefined,
      },
      {
        onSuccess: (result: any) => {
          setLinkToken(undefined);
          if (result?.itemId) setSelectedBankId(result.itemId);
          queryClient.invalidateQueries({ queryKey: ['plaid-items'] });
          queryClient.invalidateQueries({ queryKey: ['plaid-accounts'] });
        },
      },
    );
  }, [exchangeToken, queryClient]);

  const { open, ready } = usePlaidLink({ token: linkToken || '', onSuccess: onPlaidSuccess, onExit: () => setLinkToken(undefined) });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const refreshPlaidData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['plaid-items'] });
    queryClient.invalidateQueries({ queryKey: ['plaid-accounts'] });
    queryClient.invalidateQueries({ queryKey: ['plaid-unposted-transactions', selectedBankId] });
    queryClient.invalidateQueries({ queryKey: ['plaid-statements', selectedBankId] });
  }, [queryClient, selectedBankId]);

  const connectBank = () => {
    createLinkToken.mutate(undefined, { onSuccess: (result: any) => setLinkToken(result.linkToken) });
  };

  const addManualBank = () => {
    if (!manualBank.institutionName.trim()) return;
    createManualBank.mutate(manualBank, {
      onSuccess: (result: any) => {
        setManualBankOpen(false);
        setManualBank({ institutionName: '', country: 'PK', icon: '◆' });
        if (result?.itemId) setSelectedBankId(result.itemId);
        refreshPlaidData();
      },
    });
  };

  const disconnectBank = (item: any) => {
    if (!window.confirm(`Disconnect ${item.institutionName}? Its stored statements will no longer be available here.`)) return;
    deleteItem.mutate({ id: item.id }, {
      onSuccess: () => {
        if (selectedBankId === item.id) setSelectedBankId(undefined);
        refreshPlaidData();
      },
    });
  };

  const openStatementUpload = (itemId: number) => {
    setSelectedBankId(itemId);
    setStatementFile(undefined);
    setStatementUploadOpen(true);
  };

  const submitStatementUpload = () => {
    if (!selectedBankId || !statementFile) return;
    uploadStatement.mutate({ itemId: selectedBankId, file: statementFile }, {
      onSuccess: () => {
        setStatementFile(undefined);
        setStatementUploadOpen(false);
        queryClient.invalidateQueries({ queryKey: ['plaid-statements', selectedBankId] });
      },
    });
  };

  const rowsForTab = useMemo(() => {
    return allTransactions.filter((transaction) => {
      return transactionDisposition(transaction) === tab;
    });
  }, [allTransactions, tab]);

  const filteredTransactions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rowsForTab.filter((transaction) => {
      const id = transactionKey(transaction);
      const text = [transaction.name, transaction.merchantName, transaction.accountName, transaction.institutionName, transaction.category].filter(Boolean).join(' ').toLowerCase();
      const isReviewed = Boolean(reviews[id]);
      const hasClass = Boolean(transaction.category || reviews[id] === 'categorized');
      return (!normalizedQuery || text.includes(normalizedQuery))
        && dateIsWithin(transaction.date, dateRange)
        && (statusFilter === 'all' || (statusFilter === 'reviewed' ? isReviewed : !isReviewed))
        && (classFilter === 'all' || (classFilter === 'classified' ? hasClass : !hasClass));
    });
  }, [classFilter, dateRange, query, reviews, rowsForTab, statusFilter]);

  const pendingCount = Number(transactionFeed.counts?.pending || 0);
  const postedCount = Number(transactionFeed.counts?.posted || 0);
  const excludedCount = Number(transactionFeed.counts?.excluded || 0);
  const currentIds: string[] = filteredTransactions.map(transactionKey);
  const allSelected = currentIds.length > 0 && currentIds.every((id) => selectedRows.has(id));

  const toggleRow = (id: string) => {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (allSelected) currentIds.forEach((id) => next.delete(id));
      else currentIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const setDisposition = (ids: string[], reviewStatus: ReviewStatus) => {
    if (!selectedBankId || !ids.length) return;
    updateTransactionReview.mutate(
      { itemId: selectedBankId, transactionIds: ids, reviewStatus },
      {
        onSuccess: () => {
          setSelectedRows(new Set());
          refreshPlaidData();
          setNotice(`${ids.length} transaction${ids.length === 1 ? '' : 's'} moved to ${reviewStatus}.`);
        },
        onError: () => setNotice('That review update could not be saved. Try again.'),
      },
    );
  };

  const reviewRow = (id: string, review: RowReview) => {
    setReviews((current) => ({ ...current, [id]: review }));
    setNotice(review === 'matched' ? 'Transaction marked as matched.' : 'Transaction marked for categorization.');
  };

  const exportTransactions = () => {
    if (!filteredTransactions.length) {
      setNotice('There are no transactions in this view to export.');
      return;
    }
    const headers = ['Date', 'Description', 'Spent', 'Received', 'Account', 'Class', 'Location', 'Status'];
    const lines = filteredTransactions.map((transaction) => {
      const amount = Number(transaction.amount || 0);
      return [transaction.date, transaction.merchantName || transaction.name, amount > 0 ? amount.toFixed(2) : Math.abs(amount).toFixed(2), amount > 0 ? amount.toFixed(2) : '', transaction.accountName || '', transaction.category || '', transaction.location || '', tab].map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',');
    });
    const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `finsys-${tab}-transactions.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(`${filteredTransactions.length} transaction${filteredTransactions.length === 1 ? '' : 's'} exported.`);
  };

  const formatFileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div className="min-h-[100dvh] bg-[#f4f6f3] text-[#1b2d35]">
      <PageHeader title="Bank transactions" description="Review connected activity, post cleanly, and keep the audit trail intact.">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <a href="/bank-spending?version=previous" className="hidden text-xs text-[#61706e] underline-offset-4 transition-colors hover:text-[#1f5d63] hover:underline sm:inline-flex">Previous version</a>
          <a href="/bank-register" className="hidden text-xs text-[#61706e] underline-offset-4 transition-colors hover:text-[#1f5d63] hover:underline sm:inline-flex">Bank register <ChevronRight className="ml-0.5 size-3" /></a>
          <span className="mx-1 hidden h-4 w-px bg-[#d4ddd9] sm:block" />
          <Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="size-3.5" />Print</Button>
          <Button variant="outline" size="sm" onClick={exportTransactions}><Download className="size-3.5" />Export</Button>
          <Button variant="outline" size="icon" className="size-8" title="Transaction table settings" aria-label="Transaction table settings" onClick={() => setNotice('Use the column menu beside the table to customize visible fields.')}><Settings2 className="size-3.5" /></Button>
        </div>
      </PageHeader>

      <PageContent>
        <div className="space-y-5 pb-12">
          <section className="rounded-lg border border-[#cedbd6] bg-[#fbfcfa] shadow-[0_8px_24px_rgba(31,65,65,0.04)]">
            <div className="flex flex-col gap-4 border-b border-[#dce5e1] px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-9 items-center justify-center rounded-md bg-[#d9e9e4] text-[#1f5d63]"><Landmark className="size-[18px]" /></div>
                <div>
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#70807c]">Connected accounts</p>
                  <h2 className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-[#1b2d35]">Choose a feed to review</h2>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setManualBankOpen(true)}><Plus className="size-3.5" />Add manual bank</Button>
                <Button size="sm" onClick={connectBank} disabled={!plaidStatus?.configured || createLinkToken.isPending || exchangeToken.isPending}>
                  <Link2 className="size-3.5" />{createLinkToken.isPending ? 'Preparing…' : 'Connect bank'}
                </Button>
              </div>
            </div>

            {isLoadingBanks || isLoadingStatus ? (
              <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                {[1, 2, 3].map((item) => <Skeleton key={item} className="h-[126px] rounded-md bg-[#e6eeea]" />)}
              </div>
            ) : isBanksError ? (
              <div className="flex flex-col items-center justify-center gap-3 px-5 py-10 text-center">
                <CircleAlert className="size-7 text-[#b36b3a]" />
                <div><p className="text-sm font-semibold">Bank feeds could not be loaded</p><p className="mt-1 text-xs text-[#687773]">The connection service did not respond. Nothing was changed.</p></div>
                <Button size="sm" variant="outline" onClick={refreshPlaidData}><RefreshCw className="size-3.5" />Try again</Button>
              </div>
            ) : banks.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-5 py-12 text-center">
                <div className="mb-3 flex size-12 items-center justify-center rounded-full border border-dashed border-[#9db8b1] bg-[#edf4f0] text-[#397379]"><WalletCards className="size-5" /></div>
                <p className="text-sm font-semibold text-[#23373d]">No bank feeds connected</p>
                <p className="mt-1 max-w-md text-xs leading-5 text-[#687773]">Connect a supported institution through Plaid, or add a manual profile for a bank without an API connection.</p>
                {!plaidStatus?.configured && <p className="mt-3 rounded-md border border-[#e5c9aa] bg-[#fff7ec] px-3 py-2 text-left text-xs text-[#9b6234]">Plaid credentials are not configured. A manual bank profile is still available.</p>}
              </div>
            ) : (
              <div className="overflow-x-auto p-4 sm:p-5">
                <div className="flex min-w-max gap-3">
                  {banks.map((item) => {
                    const itemAccounts = accounts.filter((account) => account.institutionName === item.institutionName || account.plaidItemId === item.id);
                    const active = selectedBankId === item.id;
                    return (
                      <button key={item.id} type="button" onClick={() => setSelectedBankId(item.id)} className={`group w-[255px] rounded-md border p-3.5 text-left transition-[border-color,background-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[#8aada7] hover:shadow-[0_7px_16px_rgba(31,65,65,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397379] ${active ? 'border-[#397379] bg-[#eef6f2] shadow-[inset_3px_0_0_#397379]' : 'border-[#d6e0dc] bg-[#fdfefd]'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2.5"><BankMark item={item} /><span className="min-w-0 truncate text-sm font-semibold text-[#23373d]">{item.institutionName}</span></div>
                          <span className={`mt-1 size-1.5 rounded-full ${item.isManual ? 'bg-[#b7834c]' : 'bg-[#4e9587]'}`} title={item.isManual ? 'Manual bank profile' : 'Connected and active'} />
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-[#dce6e1] pt-3">
                          <div><p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#7b8985]">Synced balance</p><p className="mt-1 font-mono text-[13px] font-semibold tabular-nums text-[#21383d]">{item.hasBalance ? <FormatCurrency amount={item.currentBalance} currency={item.balanceCurrency || 'USD'} decimals={2} /> : '—'}</p></div>
                          <div><p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#7b8985]">FinSys / posted</p><p className="mt-1 font-mono text-[13px] font-semibold tabular-nums text-[#21383d]">{item.hasBalance && item.availableBalance !== null && item.availableBalance !== undefined ? <FormatCurrency amount={item.availableBalance} currency={item.balanceCurrency || 'USD'} decimals={2} /> : '—'}</p></div>
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-[#6e7c78]">
                          <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-[#4e9587]" />{item.isManual ? 'Manual profile' : 'Connected'} · {itemAccounts.length || item.accountCount || 0} account{(itemAccounts.length || item.accountCount || 0) === 1 ? '' : 's'}</span>
                          <span className={item.pendingCount ? 'font-semibold text-[#ae623f]' : ''}>{item.pendingCount || 0} to review</span>
                        </div>
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => setManualBankOpen(true)} className="flex w-[150px] shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-[#b4c8c1] bg-[#f7faf8] text-xs font-semibold text-[#53706c] transition-colors hover:border-[#397379] hover:bg-[#edf5f1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397379]"><Plus className="size-4" />Add bank</button>
                </div>
              </div>
            )}
            {banks.length > 0 && selectedBank && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#dce5e1] bg-[#f4f8f5] px-4 py-2.5 text-xs sm:px-5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[#64736f]"><span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-[#4e9587]" />{selectedBank.isManual ? 'Manual profile' : 'Connection healthy'}</span><span>Last update {selectedBank.updatedAt ? new Date(selectedBank.updatedAt).toLocaleString() : 'not available'}</span></div>
                <div className="flex items-center gap-2">
                  {!selectedBank.isManual && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-[#397379]" onClick={() => syncItem.mutate({ id: selectedBank.id }, { onSuccess: refreshPlaidData })} disabled={syncItem.isPending}><RefreshCw className={`size-3 ${syncItem.isPending ? 'animate-spin' : ''}`} />Update feed</Button>}
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-[#397379]" onClick={() => openStatementUpload(selectedBank.id)}><Upload className="size-3" />Upload statement</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 text-[#64736f]" aria-label="Bank actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuLabel>{selectedBank.institutionName}</DropdownMenuLabel>
                      <DropdownMenuItem onSelect={() => setSelectedBankId(selectedBank.id)}>View transactions</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => disconnectBank(selectedBank)}><Trash2 className="size-3.5" />Disconnect bank</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-[#cedbd6] bg-[#fbfcfa] shadow-[0_8px_24px_rgba(31,65,65,0.04)]">
            <div className="border-b border-[#dce5e1] px-4 pt-4 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#70807c]">Review queue</p><h2 className="mt-1 text-[15px] font-semibold text-[#1b2d35]">{selectedBank ? selectedBank.institutionName : 'Bank activity'}</h2></div>
                <span className="font-mono text-[10px] text-[#75837f]">Source: connected feed · no synthetic rows</span>
              </div>
              <div className="mt-4 flex items-end gap-5 overflow-x-auto">
                {([['pending', 'Pending', pendingCount], ['posted', 'Posted', postedCount], ['excluded', 'Excluded', excludedCount]] as const).map(([value, label, count]) => (
                  <button key={value} type="button" onClick={() => setTab(value)} className={`flex shrink-0 items-center gap-2 border-b-2 pb-3 text-xs font-semibold transition-colors ${tab === value ? 'border-[#397379] text-[#1f5d63]' : 'border-transparent text-[#77837f] hover:text-[#2b454a]'}`}><span>{label}</span><CountBadge active={tab === value}>{count}</CountBadge></button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 border-b border-[#e0e7e4] bg-[#f6f8f6] p-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-4">
              <div className="relative min-w-[220px] flex-1 sm:max-w-[310px]"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-[#85918d]" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search description, account…" className="h-8 border-[#d2dfda] bg-[#fcfdfc] pl-8 text-xs shadow-none focus-visible:ring-[#397379]" />{query && <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-2 text-[#85918d] hover:text-[#1f5d63]" aria-label="Clear search"><X className="size-3.5" /></button>}</div>
              <Select value={dateRange} onValueChange={(value) => setDateRange(value as DateRange)}><SelectTrigger className="h-8 w-full border-[#d2dfda] bg-[#fcfdfc] text-xs shadow-none sm:w-[130px]"><CalendarRange className="mr-1.5 size-3.5 text-[#71817d]" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All dates</SelectItem><SelectItem value="30">Last 30 days</SelectItem><SelectItem value="90">Last 90 days</SelectItem></SelectContent></Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="h-8 w-full border-[#d2dfda] bg-[#fcfdfc] text-xs shadow-none sm:w-[125px]"><Filter className="mr-1.5 size-3.5 text-[#71817d]" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All status</SelectItem><SelectItem value="unreviewed">Needs review</SelectItem><SelectItem value="reviewed">Reviewed</SelectItem></SelectContent></Select>
              <Select value={classFilter} onValueChange={setClassFilter}><SelectTrigger className="h-8 w-full border-[#d2dfda] bg-[#fcfdfc] text-xs shadow-none sm:w-[130px]"><ListFilter className="mr-1.5 size-3.5 text-[#71817d]" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All classes</SelectItem><SelectItem value="classified">Classified</SelectItem><SelectItem value="unclassified">Unclassified</SelectItem></SelectContent></Select>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-8 border-[#d2dfda] bg-[#fcfdfc] text-xs"><SlidersHorizontal className="size-3.5" />Columns<ChevronDown className="size-3" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuLabel>Show columns</DropdownMenuLabel><DropdownMenuCheckboxItem checked={visibleColumns.class} onCheckedChange={(checked) => setVisibleColumns((current) => ({ ...current, class: Boolean(checked) }))}>Class</DropdownMenuCheckboxItem><DropdownMenuCheckboxItem checked={visibleColumns.location} onCheckedChange={(checked) => setVisibleColumns((current) => ({ ...current, location: Boolean(checked) }))}>Location</DropdownMenuCheckboxItem><DropdownMenuCheckboxItem checked={visibleColumns.account} onCheckedChange={(checked) => setVisibleColumns((current) => ({ ...current, account: Boolean(checked) }))}>Account</DropdownMenuCheckboxItem></DropdownMenuContent>
              </DropdownMenu>
              <div className="ml-auto flex items-center gap-2 text-[10px] text-[#7a8884]"><span className="hidden sm:inline">{filteredTransactions.length} shown</span><Button variant="ghost" size="icon" className="size-8" title="Refresh transactions" aria-label="Refresh transactions" onClick={() => refetchTransactions()}><RefreshCw className={`size-3.5 ${isLoadingUnposted ? 'animate-spin' : ''}`} /></Button></div>
            </div>

            {selectedRows.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-[#dce5e1] bg-[#edf5f1] px-3 py-2.5 sm:px-4">
                <span className="mr-2 font-mono text-xs font-semibold text-[#1f5d63]">{selectedRows.size} selected</span>
                {tab === 'pending' && <><Button size="sm" className="h-7 bg-[#28666c] px-2.5 text-[11px]" onClick={() => setDisposition(Array.from(selectedRows), 'posted')}><ClipboardCheck className="size-3.5" />Mark posted</Button><Button size="sm" variant="outline" className="h-7 border-[#c6d8d1] px-2.5 text-[11px]" onClick={() => setDisposition(Array.from(selectedRows), 'excluded')}>Exclude</Button></>}
                {tab !== 'pending' && <Button size="sm" variant="outline" className="h-7 border-[#c6d8d1] px-2.5 text-[11px]" onClick={() => setDisposition(Array.from(selectedRows), 'pending')}>Return to pending</Button>}
                <button type="button" className="ml-auto text-xs text-[#61706e] hover:text-[#1f5d63]" onClick={() => setSelectedRows(new Set())}>Clear</button>
              </div>
            )}

            {!selectedBank ? (
              <div className="flex flex-col items-center justify-center px-5 py-16 text-center"><Landmark className="mb-3 size-7 text-[#98aaa4]" /><p className="text-sm font-semibold text-[#42575a]">Select a bank feed to begin</p><p className="mt-1 text-xs text-[#77847f]">Your pending activity will appear here once an account is selected.</p></div>
            ) : isLoadingUnposted ? (
              <div className="space-y-2 p-4">{[1, 2, 3, 4, 5].map((item) => <Skeleton key={item} className="h-12 rounded-md bg-[#e7efeb]" />)}</div>
            ) : isTransactionsError ? (
              <div className="flex flex-col items-center justify-center gap-3 px-5 py-14 text-center"><CircleAlert className="size-7 text-[#b36b3a]" /><div><p className="text-sm font-semibold">Transactions are temporarily unavailable</p><p className="mt-1 text-xs text-[#77847f]">Try the feed again. Saved review decisions will remain available.</p></div><Button size="sm" variant="outline" onClick={() => refetchTransactions()}><RefreshCw className="size-3.5" />Retry</Button></div>
            ) : filteredTransactions.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-5 py-16 text-center"><div className="mb-3 flex size-10 items-center justify-center rounded-full bg-[#edf4f0] text-[#397379]"><Check className="size-5" /></div><p className="text-sm font-semibold text-[#42575a]">{tab === 'pending' ? 'Nothing needs posting' : `No ${tab} transactions in this view`}</p><p className="mt-1 max-w-sm text-xs leading-5 text-[#77847f]">{tab === 'pending' ? 'This feed is clear for now. New activity will appear after the next update.' : 'Transactions move here only when you review them on this page; no records are fabricated.'}</p>{(query || dateRange !== 'all' || statusFilter !== 'all' || classFilter !== 'all') && <Button size="sm" variant="ghost" className="mt-3 text-xs text-[#397379]" onClick={() => { setQuery(''); setDateRange('all'); setStatusFilter('all'); setClassFilter('all'); }}>Clear filters</Button>}</div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="min-w-[1030px]">
                  <TableHeader><TableRow className="border-[#dce5e1] bg-[#f7f9f7] hover:bg-[#f7f9f7]"><TableHead className="w-10 px-4"><input type="checkbox" aria-label="Select all transactions" checked={allSelected} onChange={toggleAll} className="size-3.5 accent-[#397379]" /></TableHead><TableHead className="w-[92px] font-mono text-[10px] uppercase tracking-wider text-[#75837f]">Date</TableHead><TableHead className="min-w-[230px] font-mono text-[10px] uppercase tracking-wider text-[#75837f]">Bank description</TableHead><TableHead className="w-[112px] text-right font-mono text-[10px] uppercase tracking-wider text-[#75837f]">Spent</TableHead><TableHead className="w-[112px] text-right font-mono text-[10px] uppercase tracking-wider text-[#75837f]">Received</TableHead>{visibleColumns.account && <TableHead className="w-[145px] font-mono text-[10px] uppercase tracking-wider text-[#75837f]">From / To</TableHead>}{visibleColumns.class && <TableHead className="w-[130px] font-mono text-[10px] uppercase tracking-wider text-[#75837f]">Class</TableHead>}{visibleColumns.location && <TableHead className="w-[120px] font-mono text-[10px] uppercase tracking-wider text-[#75837f]">Location</TableHead>}<TableHead className="w-[145px] font-mono text-[10px] uppercase tracking-wider text-[#75837f]">Match / categorize</TableHead><TableHead className="w-12" /></TableRow></TableHeader>
                  <TableBody>
                    {filteredTransactions.map((transaction) => {
                      const id = transactionKey(transaction);
                      const amount = Number(transaction.amount || 0);
                      const expanded = expandedRows.has(id);
                      const review = reviews[id];
                      return (
                        <React.Fragment key={id}>
                          <TableRow data-state={selectedRows.has(id) ? 'selected' : undefined} className={`group border-[#e2e9e6] ${selectedRows.has(id) ? 'bg-[#edf5f1]' : ''}`}>
                            <TableCell className="px-4"><input type="checkbox" aria-label={`Select ${transaction.name || 'transaction'}`} checked={selectedRows.has(id)} onChange={() => toggleRow(id)} className="size-3.5 accent-[#397379]" /></TableCell>
                            <TableCell className="whitespace-nowrap font-mono text-[11px] tabular-nums text-[#586b6c]">{formatDate(transaction.date)}</TableCell>
                            <TableCell><button type="button" className="flex max-w-[270px] items-center gap-2 text-left" onClick={() => setExpandedRows((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}><span className={`flex size-5 shrink-0 items-center justify-center rounded-sm ${amount < 0 ? 'bg-[#fff0e7] text-[#b66d40]' : 'bg-[#e4f1ed] text-[#2c7771]'}`}>{amount < 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownLeft className="size-3" />}</span><span className="min-w-0"><span className="block truncate text-xs font-semibold text-[#293d42] group-hover:text-[#1f5d63]">{transaction.merchantName || transaction.name || 'Unnamed transaction'}</span><span className="block truncate text-[10px] text-[#7a8884]">{transaction.institutionName || selectedBank.institutionName}{transaction.pending ? ' · Pending at bank' : ''}</span></span></button></TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums text-[#9d5f3b]">{amount < 0 ? <FormatCurrency amount={Math.abs(amount)} currency={transaction.isoCurrency || 'USD'} decimals={2} /> : <span className="text-[#a6b0ac]">—</span>}</TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums text-[#34756e]">{amount > 0 ? <FormatCurrency amount={amount} currency={transaction.isoCurrency || 'USD'} decimals={2} /> : <span className="text-[#a6b0ac]">—</span>}</TableCell>
                            {visibleColumns.account && <TableCell className="max-w-[145px] truncate text-xs text-[#586b6c]">{transaction.accountName || '—'}</TableCell>}
                            {visibleColumns.class && <TableCell>{transaction.category ? <span className="rounded-sm bg-[#edf2ef] px-1.5 py-1 text-[10px] text-[#526966]">{transaction.category}</span> : <span className="text-[11px] text-[#9aaba5]">Unassigned</span>}</TableCell>}
                            {visibleColumns.location && <TableCell className="max-w-[120px] truncate text-xs text-[#687875]">{transaction.location || '—'}</TableCell>}
                            <TableCell><div className="flex items-center gap-1.5">{review ? <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#397379]"><Check className="size-3" />{review === 'matched' ? 'Matched' : 'Categorized'}</span> : <><Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-[#397379]" onClick={() => reviewRow(id, 'matched')}>Match</Button><Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-[#697a75]" onClick={() => reviewRow(id, 'categorized')}>Categorize</Button></>}</div></TableCell>
                            <TableCell><button type="button" onClick={() => setExpandedRows((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} className="flex size-7 items-center justify-center rounded-sm text-[#80908b] transition-colors hover:bg-[#e8f0ec] hover:text-[#397379]" aria-label={expanded ? 'Collapse transaction details' : 'Expand transaction details'}>{expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button></TableCell>
                          </TableRow>
                          {expanded && <TableRow className="bg-[#f5f9f6] hover:bg-[#f5f9f6]"><TableCell colSpan={10} className="px-12 py-3"><div className="grid max-w-4xl gap-3 text-xs sm:grid-cols-4"><div><p className="font-mono text-[9px] uppercase tracking-wider text-[#879590]">Transaction ID</p><p className="mt-1 break-all font-mono text-[10px] text-[#526966]">{transaction.plaidTransactionId || 'Not provided'}</p></div><div><p className="font-mono text-[9px] uppercase tracking-wider text-[#879590]">Authorized date</p><p className="mt-1 text-[#526966]">{formatDate(transaction.authorizedDate)}</p></div><div><p className="font-mono text-[9px] uppercase tracking-wider text-[#879590]">Bank account</p><p className="mt-1 text-[#526966]">{transaction.accountName || 'Not provided'}</p></div><div><p className="font-mono text-[9px] uppercase tracking-wider text-[#879590]">Review status</p><p className="mt-1 text-[#526966]">{review || 'Needs review'}</p></div></div></TableCell></TableRow>}
                        </React.Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="flex flex-col gap-2 border-t border-[#e0e7e4] px-4 py-3 text-[10px] text-[#84918d] sm:flex-row sm:items-center sm:justify-between"><span>Showing {filteredTransactions.length} of {rowsForTab.length} {tab} transaction{rowsForTab.length === 1 ? '' : 's'}</span><span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-[#4e9587]" />Review decisions are saved to this bank feed.</span></div>
          </section>

          {selectedBank && (
            <section className="rounded-lg border border-[#cedbd6] bg-[#fbfcfa]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dce5e1] px-4 py-3 sm:px-5"><div className="flex items-center gap-2"><FileText className="size-4 text-[#397379]" /><div><h2 className="text-sm font-semibold text-[#2a3e43]">Statement archive</h2><p className="text-[10px] text-[#7a8884]">{selectedBank.institutionName} · source documents for audit</p></div></div><Button size="sm" variant="outline" onClick={() => openStatementUpload(selectedBank.id)}><Upload className="size-3.5" />Upload statement</Button></div>
              <div className="p-4 sm:p-5">{isLoadingStatements ? <Skeleton className="h-10 w-full bg-[#e7efeb]" /> : !(statements as any[])?.length ? <div className="flex items-center gap-3 rounded-md border border-dashed border-[#c6d7d1] bg-[#f7faf8] px-3 py-4 text-xs text-[#71807b]"><FileText className="size-4 text-[#8ca19a]" /><span>No statements uploaded for this bank yet.</span></div> : <div className="space-y-2">{(statements as any[]).map((statement) => <div key={statement.id} className="flex items-center justify-between gap-3 rounded-md border border-[#e0e8e4] px-3 py-2.5"><div className="flex min-w-0 items-center gap-2"><FileText className="size-4 shrink-0 text-[#78908a]" /><div className="min-w-0"><p className="truncate text-xs font-semibold text-[#465c5e]">{statement.originalName}</p><p className="text-[10px] text-[#879590]">{formatFileSize(statement.fileSize)} · {new Date(statement.createdAt).toLocaleString()}</p></div></div><a href={`/api/plaid/statements/${statement.id}/download`} target="_blank" rel="noreferrer" className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm border border-[#d5e0dc] text-[#607772] transition-colors hover:bg-[#edf5f1] hover:text-[#1f5d63]" aria-label={`Download ${statement.originalName}`}><Download className="size-3.5" /></a></div>)}</div>}</div>
            </section>
          )}
        </div>
      </PageContent>

      {notice && <div role="status" className="fixed bottom-5 right-5 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-md border border-[#9fc1b9] bg-[#214e54] px-3 py-2.5 text-xs text-[#eff8f3] shadow-lg"><Check className="size-3.5" />{notice}<button type="button" onClick={() => setNotice('')} className="ml-2 opacity-70 hover:opacity-100" aria-label="Dismiss notification"><X className="size-3.5" /></button></div>}

      <Dialog open={statementUploadOpen} onOpenChange={(openState) => { setStatementUploadOpen(openState); if (!openState) setStatementFile(undefined); }}>
        <DialogContent className="max-w-md border-[#cedbd6]">
          <DialogHeader><DialogTitle>Upload bank statement</DialogTitle></DialogHeader>
          <div className="space-y-4"><p className="text-sm text-muted-foreground">Store a source document for {selectedBank?.institutionName || 'the selected bank'}.</p><div className="space-y-2"><Label htmlFor="bank-statement-file">Statement file</Label><Input id="bank-statement-file" type="file" accept=".csv,.xls,.xlsx,.pdf" onChange={(event) => setStatementFile(event.target.files?.[0])} /><p className="text-xs text-muted-foreground">CSV, XLS, XLSX, or PDF · maximum 15 MB</p></div>{statementFile && <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm">Selected: <span className="font-medium">{statementFile.name}</span></div>}</div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setStatementUploadOpen(false)}>Cancel</Button><Button type="button" onClick={submitStatementUpload} disabled={!statementFile || !selectedBankId || uploadStatement.isPending}>{uploadStatement.isPending ? 'Uploading…' : 'Upload statement'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={manualBankOpen} onOpenChange={setManualBankOpen}>
        <DialogContent className="max-w-md border-[#cedbd6]">
          <DialogHeader><DialogTitle>Add bank without API</DialogTitle></DialogHeader>
          <div className="space-y-4"><p className="text-sm text-muted-foreground">Create a manual profile for an institution not supported by Plaid. It will not invent balances or transactions.</p><div className="space-y-2"><Label htmlFor="manual-bank-name">Bank name</Label><Input id="manual-bank-name" value={manualBank.institutionName} onChange={(event) => setManualBank((current) => ({ ...current, institutionName: event.target.value }))} placeholder="e.g. Meezan Bank, Emirates NBD" /></div><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label>Country / currency</Label><Select value={manualBank.country} onValueChange={(country) => setManualBank((current) => ({ ...current, country }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{MANUAL_BANK_COUNTRIES.map((country) => <SelectItem key={country.value} value={country.value}>{country.label} · {country.currency}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>Bank mark</Label><Select value={manualBank.icon} onValueChange={(icon) => setManualBank((current) => ({ ...current, icon }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{BANK_ICON_OPTIONS.map((icon) => <SelectItem key={icon} value={icon}>{icon} Mark</SelectItem>)}</SelectContent></Select></div></div></div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setManualBankOpen(false)}>Cancel</Button><Button type="button" onClick={addManualBank} disabled={!manualBank.institutionName.trim() || createManualBank.isPending}>{createManualBank.isPending ? 'Adding…' : 'Add bank profile'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}