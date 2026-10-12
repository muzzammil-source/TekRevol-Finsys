import React, { useMemo, useState } from 'react';
import { useListAccounts, useListEntities, useSubledger, type AgingBuckets } from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { entityLabel } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import { AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';

// A/R & A/P Aging Summary (2026-10-12).
//
// Aged from each charge's transaction date, because these books carry no
// invoice documents and therefore no payment terms — open items are GL
// lines tagged with a contact. The server applies payments oldest-first so
// a recent payment can't make an old debt look current, and `netTermsDays`
// shifts the whole scale once terms exist.

const BUCKETS: { key: keyof AgingBuckets; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30' },
  { key: 'd31_60', label: '31–60' },
  { key: 'd61_90', label: '61–90' },
  { key: 'd90_plus', label: '90+' },
];

function money(n: number) {
  if (!n) return <span className="text-gray-300">—</span>;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export default function ReportsAging() {
  const [asOfDate, setAsOfDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [entityId, setEntityId] = useState('all');
  const [netTermsDays, setNetTermsDays] = useState('0');
  const [accountId, setAccountId] = useState('');

  const { allEntities } = useAuth();
  const { data: entities } = useListEntities();
  const { data: accounts } = useListAccounts();

  React.useEffect(() => {
    const first = ((entities || []) as any[])[0];
    if (!allEntities && entityId === 'all' && first) setEntityId(String(first.id));
  }, [allEntities, entityId, entities]);

  // Only control accounts make sense here: a receivable or payable head is
  // what a contact's open balance sits on.
  const controlAccounts = useMemo(() => {
    const list = (accounts || []) as any[];
    return list
      .filter((a) => {
        const text = `${a.subType || ''} ${a.category || ''} ${a.name || ''}`.toLowerCase();
        const isArAp = text.includes('receivable') || text.includes('payable');
        // Intercompany positions have their own report — they are not a
        // customer or vendor balance.
        return isArAp && (a.subType || '') !== 'Intercompany Clearing';
      })
      .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  }, [accounts]);

  React.useEffect(() => {
    if (!accountId && controlAccounts.length) setAccountId(String(controlAccounts[0].id));
  }, [accountId, controlAccounts]);

  const { data, isLoading } = useSubledger({
    accountId: accountId ? Number(accountId) : null,
    entityId: entityId === 'all' ? undefined : Number(entityId),
    asOfDate,
    netTermsDays: Number(netTermsDays) || 0,
  });

  const items = data?.items || [];
  const isReceivable = data?.account?.type === 'Asset';

  return (
    <>
      <PageHeader
        title="A/R & A/P Aging Summary"
        description="Open customer and vendor balances by age, derived from posted journal lines — stated in USD"
      >
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger className="h-9 w-60"><SelectValue placeholder="Control account" /></SelectTrigger>
          <SelectContent>
            {controlAccounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>{a.code} · {a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={entityId} onValueChange={setEntityId}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {allEntities && <SelectItem value="all">All Entities</SelectItem>}
            {((entities || []) as any[]).map((e) => (
              <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={netTermsDays} onValueChange={setNetTermsDays}>
          <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="0">On receipt</SelectItem>
            <SelectItem value="15">Net 15</SelectItem>
            <SelectItem value="30">Net 30</SelectItem>
            <SelectItem value="45">Net 45</SelectItem>
            <SelectItem value="60">Net 60</SelectItem>
          </SelectContent>
        </Select>
        <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="h-9 w-36" />
      </PageHeader>

      <PageContent>
        {controlAccounts.length === 0 ? (
          <SurfaceCard>
            <div className="py-10 text-center text-[13px] text-gray-400">
              No receivable or payable control account exists yet — create one in the Chart of Accounts.
            </div>
          </SurfaceCard>
        ) : isLoading ? (
          <SurfaceCard><Skeleton className="h-32 w-full" /></SurfaceCard>
        ) : (
          <>
            {/* Aging that doesn't add back to the open balance is wrong, and
                says so rather than showing a tidier number. */}
            {data && !data.agingReconciles && (
              <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-aging-warning>
                <AlertTriangle className="size-3.5 shrink-0" />
                The buckets don't add back to the open balance — treat this report as unreliable and check for lines posted without a contact.
              </div>
            )}

            <SurfaceCard padded={false}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3.5">
                <div>
                  <div className="text-[14px] font-semibold text-gray-900">
                    <span className="font-mono text-gray-400 mr-2">{data?.account?.code}</span>
                    {data?.account?.name}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    {isReceivable ? 'Receivable from customers' : 'Payable to vendors'} · aged from the transaction date
                    {data?.netTermsDays ? ` plus ${data.netTermsDays} days` : ''} · as of {data?.asOfDate}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Total Open</div>
                  <div className="text-[15px] font-bold font-mono tabular-nums text-gray-900" data-aging-total>
                    {new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(data?.itemsTotalUSD || 0)}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <Table data-aging-table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[28%]">{isReceivable ? 'Customer' : 'Vendor'}</TableHead>
                      {BUCKETS.map((b) => (
                        <TableHead key={b.key} className="text-right">{b.label}</TableHead>
                      ))}
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={BUCKETS.length + 2} className="py-8 text-center text-[13px] text-gray-400">
                          Nothing outstanding on this account as of {data?.asOfDate}
                        </TableCell>
                      </TableRow>
                    ) : (
                      items.map((item) => (
                        <TableRow key={String(item.contactId)} className="hover:bg-gray-50/60">
                          <TableCell className="text-[13px] text-gray-900">
                            {item.contactName}
                            {item.contactId === null && (
                              <span className="ml-1.5 text-[10px] text-amber-700">untagged</span>
                            )}
                          </TableCell>
                          {BUCKETS.map((b) => (
                            <TableCell
                              key={b.key}
                              className={`text-right font-mono text-[13px] tabular-nums ${b.key === 'd90_plus' && item.aging[b.key] ? 'text-rose-700 font-medium' : 'text-gray-700'}`}
                              data-bucket={b.key}
                            >
                              {money(item.aging[b.key])}
                            </TableCell>
                          ))}
                          <TableCell className="text-right font-mono text-[13px] font-semibold tabular-nums text-gray-900">
                            {money(item.balanceUSD)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                  {items.length > 0 && (
                    <tfoot>
                      <TableRow className="border-t bg-gray-50/60 hover:bg-gray-50/60">
                        <TableCell className="text-[13px] font-semibold text-gray-900">Total</TableCell>
                        {BUCKETS.map((b) => (
                          <TableCell key={b.key} className="text-right font-mono text-[13px] font-semibold tabular-nums text-gray-900" data-total-bucket={b.key}>
                            {money(data?.agingTotals?.[b.key] || 0)}
                          </TableCell>
                        ))}
                        <TableCell className="text-right font-mono text-[13px] font-bold tabular-nums text-gray-900">
                          {money(data?.itemsTotalUSD || 0)}
                        </TableCell>
                      </TableRow>
                    </tfoot>
                  )}
                </Table>
              </div>
            </SurfaceCard>

            <p className="text-[11px] text-gray-400">
              Payments are applied to the oldest open charge first. Balances without a customer or vendor tag appear as
              "Unassigned" — tag them on the originating entry to age them properly.
            </p>
          </>
        )}
      </PageContent>
    </>
  );
}
