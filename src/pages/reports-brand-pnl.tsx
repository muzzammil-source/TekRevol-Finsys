import React, { useState } from 'react';
import { useBrandPnl } from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { EntityBrandSelect } from '@/components/entity-brand-select';
import { ReportsSubNav } from '@/components/reports-nav';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
// Used in the Entity column; its absence was a ReferenceError waiting for
// anyone who opened this page with data (found by the type-check gate,
// 2026-10-13).
import { entityLabel } from '@/lib/constants';
import { format } from 'date-fns';

function formatMoney(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatPct(pct: number | null) {
  if (pct === null) return '—';
  return `${(pct * 100).toFixed(1)}%`;
}

function yearStartIso() {
  return `${new Date().getFullYear()}-01-01`;
}

function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

export default function ReportsBrandPnl() {
  const [entityBrand, setEntityBrand] = useState<{ entityId?: number; brandId?: number }>({});
  const [startDate, setStartDate] = useState(yearStartIso());
  const [endDate, setEndDate] = useState(todayIso());

  const { data, isLoading } = useBrandPnl({
    entityId: entityBrand.entityId,
    startDate,
    endDate,
  });
  const brands = (data?.brands || []) as any[];
  const currency = data?.currency || 'USD';

  const totals = brands.reduce(
    (acc, b) => ({
      revenue: acc.revenue + b.revenue,
      costOfGoodsSold: acc.costOfGoodsSold + b.costOfGoodsSold,
      grossProfit: acc.grossProfit + b.grossProfit,
      operatingExpenses: acc.operatingExpenses + b.operatingExpenses,
      netIncome: acc.netIncome + b.netIncome,
    }),
    { revenue: 0, costOfGoodsSold: 0, grossProfit: 0, operatingExpenses: 0, netIncome: 0 },
  );

  return (
    <>
      <PageHeader title="Brand P&L Analytics" description="Cross-brand comparison, derived live from posted GL journal entries" />
      <ReportsSubNav />
      <PageContent>
        <div className="border border-gray-100 rounded-2xl bg-white shadow-sm p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <EntityBrandSelect value={entityBrand} onChange={setEntityBrand} allLabel="All Entities" />
          <div>
            <label className="text-xs font-medium mb-1 block">Start Date</label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">End Date</label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>

        <div className="border border-gray-100 rounded-2xl bg-white shadow-sm overflow-x-auto">
          {isLoading || !data ? (
            <div className="p-6 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
          ) : brands.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No active brands found for this filter.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Brand</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">COGS</TableHead>
                  <TableHead className="text-right">Gross Profit</TableHead>
                  <TableHead className="text-right">Gross Margin</TableHead>
                  <TableHead className="text-right">Opex</TableHead>
                  <TableHead className="text-right">Net Income</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {brands.map((b) => (
                  <TableRow key={b.brandId}>
                    <TableCell className="font-medium">{b.brandName}</TableCell>
                    <TableCell className="text-muted-foreground">{entityLabel(b.entityName)}</TableCell>
                    <TableCell className="text-right font-mono">{formatMoney(b.revenue, currency)}</TableCell>
                    <TableCell className="text-right font-mono">{formatMoney(b.costOfGoodsSold, currency)}</TableCell>
                    <TableCell className="text-right font-mono">{formatMoney(b.grossProfit, currency)}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{formatPct(b.grossMarginPct)}</TableCell>
                    <TableCell className="text-right font-mono">{formatMoney(b.operatingExpenses, currency)}</TableCell>
                    <TableCell className={`text-right font-mono font-semibold ${b.netIncome < 0 ? 'text-red-700' : 'text-green-700'}`}>
                      {formatMoney(b.netIncome, currency)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 bg-muted/40 font-semibold">
                  <TableCell colSpan={2}>Total (Consolidated)</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(totals.revenue, currency)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(totals.costOfGoodsSold, currency)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(totals.grossProfit, currency)}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {formatPct(totals.revenue !== 0 ? totals.grossProfit / totals.revenue : null)}
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(totals.operatingExpenses, currency)}</TableCell>
                  <TableCell className={`text-right font-mono ${totals.netIncome < 0 ? 'text-red-700' : 'text-green-700'}`}>
                    {formatMoney(totals.netIncome, currency)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </div>
      </PageContent>
    </>
  );
}
