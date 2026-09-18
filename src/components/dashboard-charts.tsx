import React, { useMemo, useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { format, parseISO, subDays, subMonths, subYears } from 'date-fns';
import { useCashFlowTrend, useTrends } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { entityLabel } from '@/lib/constants';

// Dashboard charts (2026-09-18). Both read the same derived report endpoints
// the statements use — nothing here holds its own figures.
//
//   Cash Flow Trend      /api/reports/cash-flow-trend — cash in / out per
//                        bucket plus the running cash position
//   Monthly Performance  /api/reports/trends — revenue / expenses / net
//
// Colours are fixed to the palette in the brief: emerald in, rose out, blue
// for the net line and Net Profit bar.
const IN = '#10B981';
const OUT = '#F43F5E';
const NET = '#3B82F6';
const GRID = '#E2E8F0';
const AXIS = '#64748B';

const money = (amount: number, currency: string, decimals = 0) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: decimals }).format(amount);
  } catch {
    return `${amount.toFixed(decimals)} ${currency}`;
  }
};

/** Compact axis ticks: 12.5k / 1.2M, with the currency symbol left to the tooltip. */
const compact = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
};

const bucketLabel = (bucket: string, granularity: 'day' | 'month') => {
  try {
    return granularity === 'day'
      ? format(parseISO(bucket), 'd MMM')
      : format(parseISO(`${bucket}-01`), 'MMM yy');
  } catch {
    return bucket;
  }
};

/** Frosted tooltip shared by both charts. */
function GlassTooltip({ title, rows, currency }: { title: string; rows: { label: string; value: number; color: string }[]; currency: string }) {
  return (
    <div className="rounded-lg border border-white/20 bg-slate-900/80 px-3 py-2 text-white shadow-lg backdrop-blur-md" data-chart-tooltip>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/70">{title}</div>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: r.color }} />
              {r.label}
            </span>
            <span className="font-mono font-semibold tabular-nums">{money(r.value, currency, 2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const RANGES = [
  { key: '3M', label: '3M', months: 3 },
  { key: '6M', label: '6M', months: 6 },
  { key: '1Y', label: '1Y', months: 12 },
] as const;
type RangeKey = typeof RANGES[number]['key'];

export function CashFlowTrendCard({ entityId, currency, asOfDate }: { entityId?: number; currency: string; asOfDate: string }) {
  const [range, setRange] = useState<RangeKey>('6M');
  const startDate = useMemo(() => {
    const months = RANGES.find((r) => r.key === range)!.months;
    return format(subMonths(parseISO(asOfDate), months), 'yyyy-MM-01');
  }, [range, asOfDate]);

  const { data, isLoading } = useCashFlowTrend({ entityId, startDate, endDate: asOfDate, currency, granularity: 'month' });
  const series = useMemo(
    () => (data?.series || []).map((p) => ({ ...p, label: bucketLabel(p.bucket, data?.granularity || 'month') })),
    [data],
  );
  const hasActivity = series.some((p) => p.cashIn !== 0 || p.cashOut !== 0);

  return (
    <Card className="flex h-full flex-col border-border shadow-sm" data-chart="cash-flow-trend">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-semibold">Cash Flow Trend</CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Cash in and out of the bank accounts, with the running position — in {currency}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md bg-muted p-0.5" role="group" aria-label="Time period">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
              data-range={r.key}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                range === r.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-end px-2 pb-3">
        {isLoading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !hasActivity ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground" data-chart-empty>
            No cash movement posted in this period
          </div>
        ) : (
          // ComposedChart, not AreaChart: an AreaChart silently drops a
          // <Line> child, so the net-position stroke never rendered.
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="cashInFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={IN} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={IN} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="cashOutFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={OUT} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={OUT} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} width={52} tickFormatter={compact} />
              <Tooltip
                cursor={{ stroke: GRID }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as any;
                  return (
                    <GlassTooltip
                      title={String(label)}
                      currency={currency}
                      rows={[
                        { label: 'Cash In', value: p.cashIn, color: IN },
                        { label: 'Cash Out', value: p.cashOut, color: OUT },
                        { label: 'Net Flow', value: p.net, color: NET },
                        { label: 'Position', value: p.position, color: '#94A3B8' },
                      ]}
                    />
                  );
                }}
              />
              <Area type="monotone" dataKey="cashIn" name="Cash In" stroke={IN} strokeWidth={2} fill="url(#cashInFill)" />
              <Area type="monotone" dataKey="cashOut" name="Cash Out" stroke={OUT} strokeWidth={2} fill="url(#cashOutFill)" />
              {/* Net cash position across the period. */}
              <Line type="monotone" dataKey="position" name="Net Position" stroke={NET} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div className="flex flex-wrap items-center gap-4 px-2 pt-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: IN }} /> Cash In</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: OUT }} /> Cash Out</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded" style={{ background: NET }} /> Net Position</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function MonthlyPerformanceCard({
  entities,
  entityId,
  onEntityChange,
  currencyOf,
  asOfDate,
  allowConsolidated,
}: {
  entities: any[];
  /** '' = all entities consolidated. */
  entityId: string;
  onEntityChange: (id: string) => void;
  /** The currency figures are shown in for a given entity selection. */
  currencyOf: (entityId: string) => string;
  asOfDate: string;
  allowConsolidated: boolean;
}) {
  const currency = currencyOf(entityId);
  // Jan–Dec of the year being viewed, so the twelve bars are a calendar year
  // rather than a rolling window.
  const year = asOfDate.slice(0, 4);
  const { data, isLoading } = useTrends({
    entityId: entityId ? Number(entityId) : undefined,
    startDate: `${year}-01-01`,
    endDate: asOfDate,
    currency,
  });
  // /reports/trends only returns months that have postings; the twelve
  // months are padded here so the axis always reads Jan → Dec.
  const series = useMemo(() => {
    const byMonth = new Map((data?.series || []).map((p) => [p.month, p]));
    return Array.from({ length: 12 }, (_, i) => {
      const month = `${year}-${String(i + 1).padStart(2, '0')}`;
      const p = byMonth.get(month);
      return {
        month,
        label: format(parseISO(`${month}-01`), 'MMM'),
        revenue: p?.revenue ?? 0,
        expenses: p?.expenses ?? 0,
        netIncome: p?.netIncome ?? 0,
      };
    });
  }, [data, year]);
  const hasActivity = series.some((p) => p.revenue !== 0 || p.expenses !== 0);

  return (
    <Card className="flex h-full flex-col border-border shadow-sm" data-chart="monthly-performance">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-semibold">Monthly Performance</CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{year} · revenue, expenses and net profit by month — in {currency}</p>
          {/* Legend at the top of the card, as the brief asks. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground" data-performance-legend>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: IN }} /> Revenue</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: OUT }} /> Expense</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: NET }} /> Net Profit</span>
          </div>
        </div>
        <div className="w-[190px] shrink-0">
          <Select value={entityId || '__all'} onValueChange={(v) => onEntityChange(v === '__all' ? '' : v)}>
            <SelectTrigger className="h-8 text-xs" aria-label="Filter Entity" data-performance-entity>
              <SelectValue placeholder="All Consolidated" />
            </SelectTrigger>
            <SelectContent>
              {allowConsolidated && <SelectItem value="__all">All Consolidated</SelectItem>}
              {entities.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {entityLabel(e.name)}{e.functionalCurrency && e.functionalCurrency !== 'USD' ? ` (${e.functionalCurrency})` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-end px-2 pb-3">
        {isLoading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !hasActivity ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground" data-chart-empty>
            No posted revenue or expenses in {year}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={8} />
              <YAxis tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} width={52} tickFormatter={compact} />
              <Tooltip
                cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as any;
                  return (
                    <GlassTooltip
                      title={String(label)}
                      currency={currency}
                      rows={[
                        { label: 'Revenue', value: p.revenue, color: IN },
                        { label: 'Expense', value: p.expenses, color: OUT },
                        { label: 'Net Profit', value: p.netIncome, color: NET },
                      ]}
                    />
                  );
                }}
              />
              {/* One bar per month, split into three segments. Note that the
                  segments are three separate measures, not parts of a whole:
                  net profit is already revenue minus expenses, so the bar's
                  total height is not a meaningful figure — the tooltip gives
                  each exact amount. */}
              <Bar dataKey="revenue" name="Revenue" stackId="month" fill={IN} isAnimationActive={false} />
              <Bar dataKey="expenses" name="Expense" stackId="month" fill={OUT} isAnimationActive={false} />
              <Bar dataKey="netIncome" name="Net Profit" stackId="month" fill={NET} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
