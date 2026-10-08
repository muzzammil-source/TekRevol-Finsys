import React, { useState } from 'react';
import { useTrialBalance, useListEntities } from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, ChevronRight, XCircle } from 'lucide-react';
import { SubledgerDialog, hasSubledger } from '@/components/subledger-dialogs';
import { useAuth } from '@/lib/auth';
import { entityLabel } from '@/lib/constants';
import { format } from 'date-fns';

function money(n: number) {
  if (!n) return '';
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

const TYPE_BADGE: Record<string, string> = {
  Asset: 'bg-blue-50 text-blue-700',
  Liability: 'bg-amber-50 text-amber-700',
  Equity: 'bg-violet-50 text-violet-700',
  Revenue: 'bg-emerald-50 text-emerald-700',
  Expense: 'bg-rose-50 text-rose-700',
};

export default function TrialBalance() {
  const [asOfDate, setAsOfDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const { allEntities } = useAuth();
  const [entityId, setEntityId] = useState('all');
  const [drill, setDrill] = useState<{ accountId: number; code: string; name: string } | null>(null);
  const { data: entities } = useListEntities();
  // No consolidated view without all-entity access: default to the first
  // entity the user can see (the server refuses consolidated anyway).
  React.useEffect(() => {
    const first = ((entities || []) as any[])[0];
    if (!allEntities && entityId === 'all' && first) setEntityId(String(first.id));
  }, [allEntities, entityId, entities]);
  const { data, isLoading } = useTrialBalance({
    endDate: asOfDate,
    entityId: entityId === 'all' ? undefined : Number(entityId),
  }) as { data: any; isLoading: boolean };

  const accounts = (data?.accounts || []) as any[];

  return (
    <>
      <PageHeader
        title="Trial Balance"
        description="Every account carrying a balance, netted to its debit or credit side — stated in USD, the functional reporting currency"
      >
        <Select value={entityId} onValueChange={setEntityId}>
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {allEntities && <SelectItem value="all">All Consolidated</SelectItem>}
            {((entities || []) as any[]).map((e) => (
              <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="h-9 w-40" />
      </PageHeader>

      <PageContent>
        {data && (
          <SurfaceCard accent={data.verification?.balanced ? 'emerald' : 'rose'}>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                {data.verification?.balanced ? (
                  <>
                    <CheckCircle2 className="size-4 text-emerald-600" />
                    <span className="text-[13px] font-medium text-gray-900">Debits equal credits</span>
                  </>
                ) : (
                  <>
                    <XCircle className="size-4 text-rose-600" />
                    <span className="text-[13px] font-medium text-gray-900">
                      Out of balance by {money(data.verification?.variance || 0)}
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-6">
                <div className="text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Total Debits</div>
                  <div className="text-lg font-bold tabular-nums text-gray-900">{money(data.totals?.debit || 0) || '0.00'}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Total Credits</div>
                  <div className="text-lg font-bold tabular-nums text-gray-900">{money(data.totals?.credit || 0) || '0.00'}</div>
                </div>
              </div>
            </div>
          </SurfaceCard>
        )}

        <SurfaceCard padded={false}>
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50/80 hover:bg-gray-50/80">
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 w-24">Code</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Account</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Type</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 text-right">Debit</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-10 text-[13px] text-gray-400">
                    No posted activity as of {asOfDate}
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {accounts.map((a) => (
                    <TableRow key={a.accountId} className="hover:bg-gray-50/60">
                      <TableCell className="font-mono text-xs text-gray-500">{a.code}</TableCell>
                      <TableCell className="text-[13px] text-gray-900">
                        {/* AR / AP control accounts drill down to their customer / vendor sub-ledger. */}
                        {hasSubledger(a.category) ? (
                          <button
                            type="button"
                            data-drilldown={a.code}
                            onClick={() => setDrill({ accountId: a.accountId, code: a.code, name: a.name })}
                            className="inline-flex items-center gap-1 text-left text-blue-700 underline-offset-2 hover:underline"
                            title={`View ${a.category === 'Payables' ? 'vendors' : 'customers'} behind this balance`}
                          >
                            {a.name} <ChevronRight className="size-3.5" />
                          </button>
                        ) : a.name}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`border-transparent text-[10px] font-medium ${TYPE_BADGE[a.type] || 'bg-gray-100 text-gray-600'}`}>
                          {a.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] tabular-nums text-gray-900">{money(a.debit)}</TableCell>
                      <TableCell className="text-right font-mono text-[13px] tabular-nums text-gray-900">{money(a.credit)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-gray-50/80 hover:bg-gray-50/80 font-semibold">
                    <TableCell colSpan={3} className="text-[13px] text-gray-900">Total</TableCell>
                    <TableCell className="text-right font-mono text-[13px] tabular-nums text-gray-900">{money(data.totals.debit) || '0.00'}</TableCell>
                    <TableCell className="text-right font-mono text-[13px] tabular-nums text-gray-900">{money(data.totals.credit) || '0.00'}</TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </SurfaceCard>
      </PageContent>
      <SubledgerDialog
        account={drill}
        entityId={entityId === 'all' ? undefined : Number(entityId)}
        asOfDate={asOfDate}
        onOpenChange={(o) => { if (!o) setDrill(null); }}
      />
    </>
  );
}
