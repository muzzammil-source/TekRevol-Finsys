import React, { useState } from 'react';
import { useGeneralLedger, useListEntities, useListAccounts } from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { entityLabel } from '@/lib/constants';
import { naturalBalance } from '@/lib/account-balance';
import { showEntryMemo } from '@/lib/entry-memo';
import { useAuth } from '@/lib/auth';
import { ResizableColGroup, ResizableHeaderCells, defaultWidths, useResizableColumns, type ResizableColumnDef } from '@/components/resizable-columns';
import { format, startOfYear } from 'date-fns';

// Streamlined transaction columns — the entity lives in the account title
// badge above, never as a column here. All drag-resizable, one shared set of
// widths so every account card stays aligned.
// Laid out as a QuickBooks "Transaction Detail by Account" report
// (2026-10-12): Type / Num / Name / Memo / Split are the columns an
// accountant reads across, and Split — the other account the entry hit — is
// what makes a line interpretable without opening the entry.
const GL_COLUMNS: ResizableColumnDef[] = [
  { key: 'date', label: 'Date', width: 94 },
  { key: 'type', label: 'Type', width: 86 },
  { key: 'entry', label: 'Num', width: 104 },
  { key: 'name', label: 'Name', width: 120 },
  { key: 'description', label: 'Memo / Description', width: 230 },
  { key: 'split', label: 'Split', width: 140 },
  { key: 'debit', label: 'Debit', width: 100, align: 'right' },
  { key: 'credit', label: 'Credit', width: 100, align: 'right' },
  { key: 'balance', label: 'Balance', width: 110, align: 'right' },
];
const GL_DEFAULT_WIDTHS = defaultWidths(GL_COLUMNS);

// journal_entries.source in the words a reader of this report expects.
const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  Manual: 'Journal',
  BankFeed: 'Bank',
  Import: 'Import',
  Opening: 'Opening',
};

type SplitAccount = { accountId: number; code: string; name: string };

function splitLabel(splits: SplitAccount[] = []) {
  if (splits.length === 0) return <span className="text-gray-300">—</span>;
  if (splits.length === 1) return splits[0].name;
  return <span className="font-medium text-gray-500">-SPLIT-</span>;
}

function splitTitle(splits: SplitAccount[] = []) {
  return splits.map((s) => `${s.code} ${s.name}`).join('\n');
}

function money(n: number) {
  if (!n) return '';
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function signed(n: number) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export default function GeneralLedger() {
  // Year-to-date by default (was month-to-date, which hid every posting
  // from earlier months until the user widened the range) — matches P&L.
  const [startDate, setStartDate] = useState(format(startOfYear(new Date()), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [entityId, setEntityId] = useState('all');
  const [accountId, setAccountId] = useState('all');

  const { data: entities } = useListEntities();
  // No consolidated ledger without all-entity access (server-enforced).
  const { allEntities } = useAuth();
  React.useEffect(() => {
    const first = ((entities || []) as any[])[0];
    if (!allEntities && entityId === 'all' && first) setEntityId(String(first.id));
  }, [allEntities, entityId, entities]);
  const { data: allAccounts } = useListAccounts();
  const { data, isLoading } = useGeneralLedger({
    startDate,
    endDate,
    entityId: entityId === 'all' ? undefined : Number(entityId),
    accountId: accountId === 'all' ? undefined : Number(accountId),
  }) as { data: any; isLoading: boolean };

  const accounts = (data?.accounts || []) as any[];
  const entityById = React.useMemo(
    () => new Map(((entities || []) as any[]).map((e) => [e.id, e])),
    [entities],
  );
  const columns = useResizableColumns('finsys.gl.columns.v2', GL_DEFAULT_WIDTHS);
  const accountOptions = ((allAccounts || []) as any[]).slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));

  return (
    <>
      <PageHeader
        title="General Ledger"
        description="Every posted line, account by account, with opening and closing balances — stated in USD"
      >
        <Select value={entityId} onValueChange={setEntityId}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {allEntities && <SelectItem value="all">All Entities</SelectItem>}
            {((entities || []) as any[]).map((e) => (
              <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger className="h-9 w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Accounts</SelectItem>
            {accountOptions.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>{a.code} · {a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-9 w-36" />
        <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-9 w-36" />
      </PageHeader>

      <PageContent>
        {isLoading ? (
          <SurfaceCard><Skeleton className="h-32 w-full" /></SurfaceCard>
        ) : accounts.length === 0 ? (
          <SurfaceCard>
            <div className="py-10 text-center text-[13px] text-gray-400">
              No posted activity between {startDate} and {endDate}
            </div>
          </SurfaceCard>
        ) : (
          accounts.map((acct) => (
            <SurfaceCard key={acct.accountId} padded={false}>
              <div className="flex items-center justify-between gap-4 flex-wrap border-b border-gray-100 px-5 py-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-gray-900">
                    <span>
                      <span className="font-mono text-gray-400 mr-2">{acct.code}</span>
                      {acct.name}
                    </span>
                    {/* Whose books this head belongs to — a Shared head is
                        posted to by every entity. */}
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${acct.entityId ? 'bg-slate-100 text-slate-700' : 'border border-border text-muted-foreground'}`}
                      data-gl-entity-badge={acct.entityId ?? 'shared'}
                    >
                      {acct.entityId ? entityLabel(entityById.get(acct.entityId)?.name || `Entity ${acct.entityId}`) : 'Shared / Global'}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{acct.type}{acct.subType ? ` · ${acct.subType}` : ''}</div>
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Opening</div>
                    <div className="text-[13px] font-mono tabular-nums text-gray-600">{signed(naturalBalance(acct.type, acct.openingBalance))}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Closing</div>
                    <div className={`text-[15px] font-bold font-mono tabular-nums ${naturalBalance(acct.type, acct.closingBalance) < 0 ? 'text-rose-700' : 'text-gray-900'}`}>
                      {signed(naturalBalance(acct.type, acct.closingBalance))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Fixed layout, one shared set of widths for EVERY account
                  card (columns line up down the whole report however long a
                  description is) — and every column is drag-resizable. */}
              <div className="overflow-x-auto">
                <Table className="table-fixed [&_td]:overflow-hidden" style={columns.tableStyle} data-resizable-table="general-ledger">
                  <ResizableColGroup widths={columns.widths} />
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <ResizableHeaderCells columns={GL_COLUMNS} table={columns} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {acct.lines.map((l: any) => (
                    <TableRow key={l.lineId} className="hover:bg-gray-50/60">
                      <TableCell className="font-mono text-xs text-gray-500 whitespace-nowrap">{l.transactionDate}</TableCell>
                      <TableCell className="text-[11px] text-gray-500 truncate" title={l.transactionType}>
                        {TRANSACTION_TYPE_LABELS[l.transactionType] ?? l.transactionType}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-gray-500 whitespace-nowrap truncate">{l.entryNumber}</TableCell>
                      <TableCell className="text-[12px] text-gray-700 truncate" title={l.contactName ? `${l.contactType}: ${l.contactName}` : ''} data-contact={l.contactName || undefined}>
                        {l.contactName || <span className="text-gray-300">—</span>}
                      </TableCell>
                      <TableCell className="min-w-0 text-[13px] text-gray-900">
                        <div className="truncate" title={l.description}>{l.description}</div>
                        {/* The entry's own header memo, when the line carries
                            a different one — the audit trail shows both.
                            Skipped when one already repeats the other (bank
                            postings copy the statement text into the memo). */}
                        {showEntryMemo(l.lineMemo, l.entryDescription) && (
                          <div className="truncate text-[11px] text-gray-400" title={l.entryDescription} data-entry-memo>
                            Entry: {l.entryDescription}
                          </div>
                        )}
                      </TableCell>
                      {/* The other side of the entry. More than one and this
                          reads "-SPLIT-", as QuickBooks does — the detail is
                          in the tooltip and on the entry itself. */}
                      <TableCell className="text-[12px] text-gray-600 truncate" title={splitTitle(l.splitAccounts)} data-split>
                        {splitLabel(l.splitAccounts)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] tabular-nums whitespace-nowrap">{money(l.debit)}</TableCell>
                      <TableCell className="text-right font-mono text-[13px] tabular-nums whitespace-nowrap">{money(l.credit)}</TableCell>
                      <TableCell className={`text-right font-mono text-[13px] tabular-nums whitespace-nowrap ${naturalBalance(acct.type, l.runningBalance) < 0 ? 'text-rose-700' : 'text-gray-700'}`}>
                        {signed(naturalBalance(acct.type, l.runningBalance))}
                      </TableCell>
                    </TableRow>
                  ))}
                  </TableBody>
                </Table>
              </div>
            </SurfaceCard>
          ))
        )}
      </PageContent>
    </>
  );
}
