import React, { useState } from 'react';
import { useRevenueStreams } from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { EntityBrandSelect } from '@/components/entity-brand-select';
import { ReportsSubNav } from '@/components/reports-nav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';
import {
  Bar,
  BarChart,
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

function yearStartIso() {
  return `${new Date().getFullYear()}-01-01`;
}

function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

export default function ReportsRevenueStreams() {
  const [entityBrand, setEntityBrand] = useState<{ entityId?: number; brandId?: number }>({});
  const [startDate, setStartDate] = useState(yearStartIso());
  const [endDate, setEndDate] = useState(todayIso());

  const { data, isLoading } = useRevenueStreams({
    entityId: entityBrand.entityId,
    brandId: entityBrand.brandId,
    startDate,
    endDate,
  });
  const series = (data?.series || []) as any[];
  const totals = data?.totals;
  const currency = data?.currency || 'USD';

  return (
    <>
      <PageHeader title="Revenue Stream Breakdown" description="Fresh Sales, Recurring Subscriptions and Upsell Revenue, segmented by GL account" />
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="rounded-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Fresh Sales</CardTitle></CardHeader>
            <CardContent>{isLoading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-bold">{formatMoney(totals?.freshSales || 0, currency)}</div>}</CardContent>
          </Card>
          <Card className="rounded-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Recurring Subscriptions</CardTitle></CardHeader>
            <CardContent>{isLoading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-bold">{formatMoney(totals?.recurringSubscriptions || 0, currency)}</div>}</CardContent>
          </Card>
          <Card className="rounded-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Upsell Revenue</CardTitle></CardHeader>
            <CardContent>{isLoading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-bold">{formatMoney(totals?.upsellRevenue || 0, currency)}</div>}</CardContent>
          </Card>
        </div>

        <Card className="rounded-sm">
          <CardHeader><CardTitle className="text-sm font-semibold">Revenue Composition by Month</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : series.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">No revenue posted in this range.</div>
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" tick={{ fontSize: 12, fontFamily: 'monospace' }} />
                    <YAxis tickFormatter={(v) => `$${v / 1000}k`} tick={{ fontSize: 12, fontFamily: 'monospace' }} />
                    <Tooltip formatter={(v: number) => formatMoney(v, currency)} cursor={{ fill: 'hsl(var(--muted))' }} />
                    <Legend />
                    <Bar dataKey="freshSales" name="Fresh Sales" stackId="rev" fill="hsl(var(--chart-1))" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="recurringSubscriptions" name="Recurring Subscriptions" stackId="rev" fill="hsl(var(--chart-2))" />
                    <Bar dataKey="upsellRevenue" name="Upsell Revenue" stackId="rev" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-sm">
          <CardHeader><CardTitle className="text-sm font-semibold">Total Revenue Trend</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : series.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">No revenue posted in this range.</div>
            ) : (
              <div className="h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" tick={{ fontSize: 12, fontFamily: 'monospace' }} />
                    <YAxis tickFormatter={(v) => `$${v / 1000}k`} tick={{ fontSize: 12, fontFamily: 'monospace' }} />
                    <Tooltip formatter={(v: number) => formatMoney(v, currency)} cursor={{ fill: 'hsl(var(--muted))' }} />
                    <Line type="monotone" dataKey="total" name="Total Revenue" stroke="hsl(var(--chart-2))" strokeWidth={2} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </PageContent>
    </>
  );
}
