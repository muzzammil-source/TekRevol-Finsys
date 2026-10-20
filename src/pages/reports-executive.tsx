import React, { useState } from 'react';
import { useListEntities, useExecutiveDashboard } from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { entityLabel } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import { format } from 'date-fns';
import { CashFlowTrendCard, MonthlyPerformanceCard } from '@/components/dashboard-charts';
import { BankSummaryCards } from '@/components/bank-summary-cards';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Gauge, Landmark, Scale, TrendingDown } from 'lucide-react';

function formatMoney(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toFixed(0)} ${currency}`;
  }
}

function formatPct(pct: number | null) {
  if (pct === null || Number.isNaN(pct)) return '—';
  return `${(pct * 100).toFixed(1)}%`;
}

function KpiCard({
  title,
  value,
  icon: Icon,
  loading,
  tone,
  sub,
}: {
  title: string;
  value: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  loading?: boolean;
  tone?: 'default' | 'good' | 'bad' | 'warn';
  sub?: React.ReactNode;
}) {
  const toneClass = tone === 'good' ? 'text-green-700' : tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : '';
  return (
    <Card className="rounded-sm border-sidebar-border shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{title}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <>
            <div className={`text-2xl font-bold tracking-tight ${toneClass}`}>{value}</div>
            {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function ReportsExecutive() {
  const { data: entities } = useListEntities();
  const entitiesList = (entities || []) as any[];

  const [selectedEntityId, setEntityId] = useState('');
  const [trailingMonths, setTrailingMonths] = useState('3');
  // No consolidated dashboard without all-entity access (server-enforced):
  // such users always see one of their own entities, defaulting to the first.
  const { allEntities } = useAuth();
  const entityId = selectedEntityId || (!allEntities && entitiesList[0] ? String(entitiesList[0].id) : '');

  const { data, isLoading } = useExecutiveDashboard({
    entityId: entityId ? Number(entityId) : undefined,
    trailingMonths: Number(trailingMonths),
  });
  const currency = data?.currency || 'USD';
  const today = format(new Date(), 'yyyy-MM-dd');

  // Figures follow the entity being looked at: one entity is shown in its
  // own functional currency (FZCO in AED), consolidated stays in USD, the
  // reporting currency. The conversion happens server-side at each month's
  // configured rate — the label and the numbers can't disagree.
  const currencyOf = React.useCallback((id: string) => {
    if (!id) return 'USD';
    return entitiesList.find((e) => String(e.id) === String(id))?.functionalCurrency || 'USD';
  }, [entitiesList]);

  // The performance chart carries its own entity filter (per the brief); it
  // starts from the page-level selection.
  const [performanceEntityId, setPerformanceEntityId] = useState<string | null>(null);
  const effectivePerformanceEntityId = performanceEntityId ?? entityId;

  const runwayLabel =
    data?.cashRunwayDays === null || data?.cashRunwayDays === undefined
      ? 'No burn in period'
      : `${Math.round(data.cashRunwayDays).toLocaleString()} days`;
  const runwayTone =
    data?.cashRunwayDays === null || data?.cashRunwayDays === undefined
      ? 'good'
      : data.cashRunwayDays < 90 ? 'bad' : data.cashRunwayDays < 180 ? 'warn' : 'good';
  const marginTone = (data?.netOperatingMargin ?? 0) >= 0 ? 'good' : 'bad';
  const intercompanyNet = data?.intercompany?.net ?? 0;

  return (
    <>
      {/* The Management sub-nav (Brand P&L / Revenue Streams / Trends) is
          deliberately not rendered here: this page is the statutory nav's
          "Dashboard", and Management analytics are off the menu as of the
          2026-09-11 refactor. The other pages that strip links to are only
          reachable by deep link now, and keep their own sub-nav. */}
      <PageHeader title="Dashboard" description="High-level KPIs derived live from posted GL journal entries" />
      <PageContent>
        <div className="border border-gray-100 rounded-2xl bg-white shadow-sm p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium mb-1 block">Entity</label>
            <Select value={entityId} onValueChange={(v) => setEntityId(v === '__all' ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="All Consolidated" /></SelectTrigger>
              <SelectContent>
                {allEntities && <SelectItem value="__all">All Consolidated</SelectItem>}
                {entitiesList.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Trailing Window (Burn / Margin)</label>
            <Select value={trailingMonths} onValueChange={setTrailingMonths}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Last 1 Month</SelectItem>
                <SelectItem value="3">Last 3 Months</SelectItem>
                <SelectItem value="6">Last 6 Months</SelectItem>
                <SelectItem value="12">Last 12 Months</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {!isLoading && data && !data.rateFound && currency !== 'USD' && (
          <div className="text-xs text-amber-700 flex items-center gap-1">
            <AlertTriangle className="size-3.5" /> No exchange rate configured for {currency} — showing raw USD figures.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Monthly Burn Rate"
            icon={TrendingDown}
            loading={isLoading}
            value={formatMoney(data?.monthlyBurnRate || 0, currency)}
            sub={`Avg. expenses / month, trailing ${data?.trailingMonths ?? trailingMonths}mo`}
          />
          <KpiCard
            title="Cash Runway"
            icon={Gauge}
            loading={isLoading}
            tone={runwayTone as any}
            value={runwayLabel}
            sub={`${formatMoney(data?.cashOnHand || 0, currency)} cash on hand`}
          />
          <KpiCard
            title="Intercompany Net Position"
            icon={Scale}
            loading={isLoading}
            tone={intercompanyNet >= 0 ? 'good' : 'bad'}
            value={formatMoney(intercompanyNet, currency)}
            sub={
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-0.5"><ArrowUpRight className="size-3 text-green-700" /> {formatMoney(data?.intercompany?.receivables || 0, currency)}</span>
                <span className="flex items-center gap-0.5"><ArrowDownRight className="size-3 text-red-700" /> {formatMoney(data?.intercompany?.payables || 0, currency)}</span>
              </span>
            }
          />
          <KpiCard
            title="Net Operating Margin"
            icon={Landmark}
            loading={isLoading}
            tone={marginTone as any}
            value={formatPct(data?.netOperatingMargin ?? null)}
            sub={`Net income ${formatMoney(data?.netOperatingIncome || 0, currency)} on revenue ${formatMoney(data?.totalRevenue || 0, currency)}`}
          />
        </div>

        {/* Bank against book, per account — the first thing to look at when
            a cash figure above looks wrong. Each card links into
            reconciling that account. */}
        <BankSummaryCards
          entityId={entityId ? Number(entityId) : undefined}
          entities={entitiesList}
          description="Bank-reported balance against the posted GL balance, per account"
        />

        {/* Cash movement (left) against what the P&L earned (right), side by
            side on wide screens and stacked on narrow ones. */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" data-dashboard-charts>
          <CashFlowTrendCard entityId={entityId ? Number(entityId) : undefined} currency={currency} asOfDate={today} />
          <MonthlyPerformanceCard
            entities={entitiesList}
            entityId={effectivePerformanceEntityId}
            onEntityChange={setPerformanceEntityId}
            currencyOf={currencyOf}
            asOfDate={today}
            allowConsolidated={allEntities}
          />
        </div>
      </PageContent>
    </>
  );
}
