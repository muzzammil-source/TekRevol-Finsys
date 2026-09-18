import React, { useState } from 'react';
import { useManagementTrends } from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { EntityBrandSelect } from '@/components/entity-brand-select';
import { ReportsSubNav } from '@/components/reports-nav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { format, subMonths } from 'date-fns';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

function formatMoney(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toFixed(0)} ${currency}`;
  }
}

function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

function defaultStartIso() {
  return format(subMonths(new Date(), 11), 'yyyy-MM-01');
}

export default function ReportsTrends() {
  const [entityBrand, setEntityBrand] = useState<{ entityId?: number; brandId?: number }>({});
  const [startDate, setStartDate] = useState(defaultStartIso());
  const [endDate, setEndDate] = useState(todayIso());

  const { data, isLoading } = useManagementTrends({
    entityId: entityBrand.entityId,
    brandId: entityBrand.brandId,
    startDate,
    endDate,
  });
  const series = (data?.series || []) as any[];
  const currency = data?.currency || 'USD';

  return (
    <>
      <PageHeader title="Multi-Period Trends & Comparisons" description="Month-over-month revenue, expenses and net income, derived from posted GL journal entries" />
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

        <Card className="rounded-sm">
          <CardHeader><CardTitle className="text-sm font-semibold">Revenue vs. Expenses vs. Net Income</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[320px] w-full" />
            ) : series.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">No posted activity in this range.</div>
            ) : (
              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" tick={{ fontSize: 12, fontFamily: 'monospace' }} />
                    <YAxis tickFormatter={(v) => `$${v / 1000}k`} tick={{ fontSize: 12, fontFamily: 'monospace' }} />
                    <Tooltip formatter={(v: number) => formatMoney(v, currency)} cursor={{ fill: 'hsl(var(--muted))' }} />
                    <Legend />
                    <Line type="monotone" dataKey="revenue" name="Revenue" stroke="hsl(var(--chart-2))" strokeWidth={2} activeDot={{ r: 6 }} />
                    <Line type="monotone" dataKey="expenses" name="Expenses" stroke="hsl(var(--destructive))" strokeWidth={2} />
                    <Line type="monotone" dataKey="netIncome" name="Net Income" stroke="hsl(var(--chart-1))" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="border border-gray-100 rounded-2xl bg-white shadow-sm overflow-x-auto">
          {isLoading || !data ? (
            <div className="p-6 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Expenses</TableHead>
                  <TableHead className="text-right">Net Income</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {series.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-6">No posted activity in this range.</TableCell></TableRow>
                ) : series.map((s) => (
                  <TableRow key={s.month}>
                    <TableCell className="font-mono">{s.month}</TableCell>
                    <TableCell className="text-right font-mono">{formatMoney(s.revenue, currency)}</TableCell>
                    <TableCell className="text-right font-mono">{formatMoney(s.expenses, currency)}</TableCell>
                    <TableCell className={`text-right font-mono font-semibold ${s.netIncome < 0 ? 'text-red-700' : 'text-green-700'}`}>
                      {formatMoney(s.netIncome, currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </PageContent>
    </>
  );
}
