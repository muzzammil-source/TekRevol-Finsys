import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  useListEntities,
  useIncomeStatement,
  useBalanceSheet,
  useCashFlowStatement,
} from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { EntityBrandSelect } from '@/components/entity-brand-select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { entityLabel } from '@/lib/constants';
import { CheckCircle2, ChevronRight, Download, Printer, XCircle } from 'lucide-react';
import { SubledgerDialog, hasSubledger } from '@/components/subledger-dialogs';
import { format } from 'date-fns';

export type ReportKind = 'pnl' | 'balance-sheet' | 'cash-flow';

type ExportRow = Record<string, string | number>;
type ExportSheet = { sheetName: string; rows: ExportRow[] };

type ReportFilters = {
  entityId?: number;
  brandId?: number;
  startDate: string;
  endDate: string;
  currency: string;
};

type ReportViewProps = {
  filters: ReportFilters;
  // Each view publishes its own export payload so the page-level Export
  // button only ever exports the statement that is actually on screen.
  onExportReady: (sheet: ExportSheet | null) => void;
};

const REPORT_TABS: { kind: ReportKind; label: string; href: string; title: string }[] = [
  { kind: 'pnl', label: 'Profit & Loss', href: '/reports/profit-loss', title: 'Profit & Loss' },
  { kind: 'balance-sheet', label: 'Balance Sheet', href: '/reports/balance-sheet', title: 'Balance Sheet' },
  { kind: 'cash-flow', label: 'Statement of Cash Flows', href: '/reports/cash-flow', title: 'Statement of Cash Flows' },
];

function formatMoney(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function yearStartIso() {
  return `${new Date().getFullYear()}-01-01`;
}

function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

function StatementRow({ label, amount, currency, bold, indent, onDrill }: { label: string; amount: number; currency: string; bold?: boolean; indent?: boolean; onDrill?: () => void }) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${bold ? 'border-t mt-1 pt-2 font-semibold' : ''}`}>
      {onDrill ? (
        // Drill-down (AR / AP → customer / vendor sub-ledger).
        <button type="button" onClick={onDrill} data-drilldown={label} className={`inline-flex items-center gap-1 text-left text-sm text-blue-700 underline-offset-2 hover:underline ${indent ? 'pl-4' : ''}`}>
          {label} <ChevronRight className="size-3.5" />
        </button>
      ) : (
        <span className={`text-sm ${indent ? 'pl-4 text-muted-foreground' : ''}`}>{label}</span>
      )}
      <span className={`font-mono text-sm ${amount < 0 ? 'text-red-700' : ''}`}>{formatMoney(amount, currency)}</span>
    </div>
  );
}

function StatementSkeleton() {
  return <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>;
}

function SectionHeading({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return <div className={`text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 ${first ? '' : 'mt-4'}`}>{children}</div>;
}

// ── Profit & Loss ──────────────────────────────────────────────────────────
export function ProfitAndLossView({ filters, onExportReady }: ReportViewProps) {
  const { data: incomeStatement, isLoading } = useIncomeStatement(filters);
  const { currency } = filters;

  useEffect(() => {
    if (!incomeStatement) return onExportReady(null);
    onExportReady({
      sheetName: 'Income Statement',
      rows: [
        ...incomeStatement.revenue.accounts.map((a: any) => ({ Section: 'Revenue', Line: a.name, Amount: a.amount })),
        { Section: 'Revenue', Line: 'Total Gross Revenue', Amount: incomeStatement.revenue.total },
        ...incomeStatement.costOfGoodsSold.accounts.map((a: any) => ({ Section: 'COGS', Line: a.name, Amount: a.amount })),
        { Section: 'COGS', Line: 'Total Cost of Goods Sold', Amount: incomeStatement.costOfGoodsSold.total },
        { Section: '', Line: 'Gross Profit', Amount: incomeStatement.grossProfit },
        ...incomeStatement.operatingExpenses.accounts.map((a: any) => ({ Section: 'Operating Expenses', Line: a.name, Amount: a.amount })),
        { Section: 'Operating Expenses', Line: 'Total Operating Expenses', Amount: incomeStatement.operatingExpenses.total },
        { Section: '', Line: 'Net Income', Amount: incomeStatement.netOperatingIncome },
      ],
    });
  }, [incomeStatement, onExportReady]);

  return (
    <div id="statement-print-area" data-report="pnl" className="border border-gray-100 rounded-2xl bg-white shadow-sm p-6 max-w-2xl">
      {isLoading || !incomeStatement ? <StatementSkeleton /> : (
        <>
          <SectionHeading first>Gross Revenue</SectionHeading>
          {incomeStatement.revenue.accounts.length === 0 ? (
            <div className="text-xs text-muted-foreground pl-4 py-1">No revenue posted in this range</div>
          ) : incomeStatement.revenue.accounts.map((a: any) => (
            <StatementRow key={a.code} label={a.name} amount={a.amount} currency={currency} indent />
          ))}
          <StatementRow label="Total Gross Revenue" amount={incomeStatement.revenue.total} currency={currency} bold />

          <SectionHeading>Cost of Goods Sold</SectionHeading>
          {incomeStatement.costOfGoodsSold.accounts.length === 0 ? (
            <div className="text-xs text-muted-foreground pl-4 py-1">None</div>
          ) : incomeStatement.costOfGoodsSold.accounts.map((a: any) => (
            <StatementRow key={a.code} label={a.name} amount={a.amount} currency={currency} indent />
          ))}
          <StatementRow label="Total Cost of Goods Sold" amount={incomeStatement.costOfGoodsSold.total} currency={currency} bold />

          <StatementRow label="Gross Margin" amount={incomeStatement.grossProfit} currency={currency} bold />

          <SectionHeading>Operating Expenses</SectionHeading>
          {incomeStatement.operatingExpenses.accounts.length === 0 ? (
            <div className="text-xs text-muted-foreground pl-4 py-1">None</div>
          ) : incomeStatement.operatingExpenses.accounts.map((a: any) => (
            <StatementRow key={a.code} label={a.name} amount={a.amount} currency={currency} indent />
          ))}
          <StatementRow label="Total Operating Expenses" amount={incomeStatement.operatingExpenses.total} currency={currency} bold />

          <div className="border-t-2 mt-3 pt-3 flex items-center justify-between">
            <span className="text-base font-bold">Net Income</span>
            <span className={`font-mono text-base font-bold ${incomeStatement.netOperatingIncome < 0 ? 'text-red-700' : 'text-green-700'}`}>
              {formatMoney(incomeStatement.netOperatingIncome, currency)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Balance Sheet ──────────────────────────────────────────────────────────
export function BalanceSheetView({ filters, onExportReady }: ReportViewProps) {
  const { currency } = filters;
  const { data: balanceSheet, isLoading } = useBalanceSheet({ entityId: filters.entityId, asOfDate: filters.endDate, currency });
  const [drill, setDrill] = useState<{ accountId: number; code: string; name: string } | null>(null);

  useEffect(() => {
    if (!balanceSheet) return onExportReady(null);
    onExportReady({
      sheetName: 'Balance Sheet',
      rows: [
        ...balanceSheet.assets.accounts.map((a: any) => ({ Section: 'Assets', Line: a.name, Amount: a.amount })),
        { Section: 'Assets', Line: 'Total Assets', Amount: balanceSheet.assets.total },
        ...balanceSheet.liabilities.accounts.map((a: any) => ({ Section: 'Liabilities', Line: a.name, Amount: a.amount })),
        { Section: 'Liabilities', Line: 'Total Liabilities', Amount: balanceSheet.liabilities.total },
        { Section: 'Equity', Line: "Owner's Equity", Amount: balanceSheet.equity.ownersEquity },
        { Section: 'Equity', Line: 'Retained Earnings', Amount: balanceSheet.equity.retainedEarnings },
        { Section: 'Equity', Line: 'Total Equity', Amount: balanceSheet.equity.total },
      ],
    });
  }, [balanceSheet, onExportReady]);

  return (
    <div id="statement-print-area" data-report="balance-sheet" className="border border-gray-100 rounded-2xl bg-white shadow-sm p-6 max-w-2xl">
      {isLoading || !balanceSheet ? <StatementSkeleton /> : (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs text-muted-foreground">As of {balanceSheet.asOfDate}</div>
            <Badge variant={balanceSheet.verification.balanced ? 'default' : 'destructive'} className={balanceSheet.verification.balanced ? 'bg-green-600 text-white' : ''}>
              {balanceSheet.verification.balanced ? <><CheckCircle2 className="mr-1 size-3.5" /> Balanced</> : <><XCircle className="mr-1 size-3.5" /> Out of Balance ({formatMoney(balanceSheet.verification.variance, currency)})</>}
            </Badge>
          </div>

          <SectionHeading first>Assets</SectionHeading>
          {balanceSheet.assets.accounts.map((a: any) => (
            <StatementRow key={a.code} label={a.name} amount={a.amount} currency={currency} indent
              onDrill={hasSubledger(a.category) ? () => setDrill({ accountId: a.accountId, code: a.code, name: a.name }) : undefined} />
          ))}
          <StatementRow label="Total Assets" amount={balanceSheet.assets.total} currency={currency} bold />

          <SectionHeading>Liabilities</SectionHeading>
          {balanceSheet.liabilities.accounts.map((a: any) => (
            <StatementRow key={a.code} label={a.name} amount={a.amount} currency={currency} indent
              onDrill={hasSubledger(a.category) ? () => setDrill({ accountId: a.accountId, code: a.code, name: a.name }) : undefined} />
          ))}
          <StatementRow label="Total Liabilities" amount={balanceSheet.liabilities.total} currency={currency} bold />

          <SectionHeading>Equity</SectionHeading>
          <StatementRow label="Owner's Equity" amount={balanceSheet.equity.ownersEquity} currency={currency} indent />
          <StatementRow label="Retained Earnings" amount={balanceSheet.equity.retainedEarnings} currency={currency} indent />
          <StatementRow label="Total Equity" amount={balanceSheet.equity.total} currency={currency} bold />

          <div className="border-t-2 mt-3 pt-3 flex items-center justify-between">
            <span className="text-sm font-semibold">Total Liabilities + Equity</span>
            <span className="font-mono text-sm font-semibold">{formatMoney(balanceSheet.liabilities.total + balanceSheet.equity.total, currency)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Total Assets</span>
            <span className="font-mono text-sm font-semibold">{formatMoney(balanceSheet.assets.total, currency)}</span>
          </div>
        </>
      )}
      <SubledgerDialog
        account={drill}
        entityId={filters.entityId}
        asOfDate={filters.endDate}
        onOpenChange={(o) => { if (!o) setDrill(null); }}
      />
    </div>
  );
}

// ── Statement of Cash Flows ────────────────────────────────────────────────
export function CashFlowView({ filters, onExportReady }: ReportViewProps) {
  const { data: cashFlow, isLoading } = useCashFlowStatement(filters);
  const { currency } = filters;

  useEffect(() => {
    if (!cashFlow) return onExportReady(null);
    const section = (name: string, bucket: any): ExportRow[] => [
      ...bucket.lines.map((l: any) => ({ Section: name, Line: l.description || l.counterpartyAccount, Amount: l.amountUsd })),
      { Section: name, Line: `Total ${name}`, Amount: bucket.total },
    ];
    onExportReady({
      sheetName: 'Cash Flow',
      rows: [
        ...section('Operating', cashFlow.operatingActivities),
        ...section('Investing', cashFlow.investingActivities),
        ...section('Financing', cashFlow.financingActivities),
        { Section: '', Line: 'Net Change in Cash', Amount: cashFlow.netChangeInCash },
        { Section: '', Line: 'Beginning Cash Balance', Amount: cashFlow.beginningCashBalance },
        { Section: '', Line: 'Ending Cash Balance', Amount: cashFlow.endingCashBalance },
      ],
    });
  }, [cashFlow, onExportReady]);

  return (
    <div id="statement-print-area" data-report="cash-flow" className="border border-gray-100 rounded-2xl bg-white shadow-sm p-6 max-w-3xl">
      {isLoading || !cashFlow ? <StatementSkeleton /> : (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs text-muted-foreground">{cashFlow.startDate} to {cashFlow.endDate}</div>
            <Badge variant={cashFlow.verification.reconciles ? 'default' : 'destructive'} className={cashFlow.verification.reconciles ? 'bg-green-600 text-white' : ''}>
              {cashFlow.verification.reconciles ? 'Reconciles' : 'Does not reconcile'}
            </Badge>
          </div>

          {(['operatingActivities', 'investingActivities', 'financingActivities'] as const).map((key, idx) => {
            const labels = ['Operating Activities', 'Investing Activities', 'Financing Activities'];
            const bucket = cashFlow[key];
            return (
              <div key={key} className="mb-4">
                <SectionHeading first>{labels[idx]}</SectionHeading>
                {bucket.lines.length === 0 ? (
                  <div className="text-xs text-muted-foreground pl-4 py-1">None</div>
                ) : bucket.lines.map((l: any, i: number) => (
                  <div key={i} className="flex items-center justify-between py-1 pl-4">
                    <span className="text-xs text-muted-foreground truncate max-w-[60%]">{l.transactionDate} · {l.description || l.counterpartyAccount}</span>
                    <span className={`font-mono text-xs ${l.amountUsd < 0 ? 'text-red-700' : ''}`}>{formatMoney(l.amountUsd, 'USD')}</span>
                  </div>
                ))}
                <StatementRow label={`Total ${labels[idx]}`} amount={bucket.total} currency={currency} bold />
              </div>
            );
          })}

          <div className="border-t-2 mt-3 pt-3 space-y-1">
            <StatementRow label="Net Change in Cash" amount={cashFlow.netChangeInCash} currency={currency} bold />
            <StatementRow label="Beginning Cash Balance" amount={cashFlow.beginningCashBalance} currency={currency} />
            <StatementRow label="Ending Cash Balance" amount={cashFlow.endingCashBalance} currency={currency} bold />
          </div>
        </>
      )}
    </div>
  );
}

const REPORT_VIEWS: Record<ReportKind, (props: ReportViewProps) => React.ReactElement> = {
  'pnl': ProfitAndLossView,
  'balance-sheet': BalanceSheetView,
  'cash-flow': CashFlowView,
};

// Reports shell: shared filter bar + export buttons + route-driven sub-tabs.
// The active statement comes ONLY from the route (`report` prop) — there is
// no local tab state, so the URL, the highlighted sub-tab and the rendered
// view can never disagree, and only that one statement is fetched/rendered.
export default function FinancialStatements({ report = 'pnl' }: { report?: ReportKind }) {
  const { data: entities } = useListEntities();
  const entitiesList = (entities || []) as any[];

  const [entityBrand, setEntityBrand] = useState<{ entityId?: number; brandId?: number }>({});
  const [startDate, setStartDate] = useState(yearStartIso());
  const [endDate, setEndDate] = useState(todayIso());
  // Currency selector removed globally (2026-09-11) — statements are
  // presented in USD, the functional reporting currency.
  const currency = 'USD';

  const exportSheet = useRef<ExportSheet | null>(null);
  const handleExportReady = React.useCallback((sheet: ExportSheet | null) => { exportSheet.current = sheet; }, []);

  const filters: ReportFilters = { entityId: entityBrand.entityId, brandId: entityBrand.brandId, startDate, endDate, currency };
  const activeTab = REPORT_TABS.find((t) => t.kind === report) ?? REPORT_TABS[0];
  const ActiveView = REPORT_VIEWS[activeTab.kind];

  const entityDescription = entityBrand.entityId ? entityLabel(entitiesList.find((e) => e.id === entityBrand.entityId)?.name || '') : 'All Consolidated (USD)';

  const handleExportCsv = async () => {
    const sheet = exportSheet.current;
    if (!sheet || sheet.rows.length === 0) return;
    const { utils, writeFile } = await import('xlsx');
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.json_to_sheet(sheet.rows), sheet.sheetName);
    writeFile(wb, `${sheet.sheetName.toLowerCase().replace(/\s+/g, '-')}-${endDate}.csv`, { bookType: 'csv' });
  };

  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #statement-print-area, #statement-print-area * { visibility: visible; }
          #statement-print-area { position: absolute; left: 0; top: 0; width: 100%; padding: 24px; }
        }
      `}</style>
      <PageHeader title={activeTab.title} description={`Derived live from posted journal lines — ${entityDescription}`}>
        <Button variant="outline" size="sm" onClick={handleExportCsv}><Download className="mr-2 size-4" /> Export CSV</Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="mr-2 size-4" /> Export PDF</Button>
      </PageHeader>
      <PageContent>
        <div className="border border-gray-100 rounded-2xl bg-white shadow-sm p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <EntityBrandSelect value={entityBrand} onChange={setEntityBrand} allLabel="All Consolidated (USD)" />
          {report !== 'balance-sheet' && (
            <div>
              <label className="text-xs font-medium mb-1 block">Start Date</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
          )}
          <div>
            <label className="text-xs font-medium mb-1 block">{report === 'balance-sheet' ? 'As Of Date' : 'End Date'}</label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>

        <nav role="tablist" aria-label="Financial statements" className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
          {REPORT_TABS.map((tab) => {
            const active = tab.kind === activeTab.kind;
            return (
              <Link
                key={tab.kind}
                href={tab.href}
                role="tab"
                aria-selected={active}
                className={`inline-flex items-center rounded-md px-3 py-1 text-sm font-medium transition-colors ${active ? 'bg-background text-foreground shadow' : 'hover:text-foreground'}`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        {/* key forces a clean mount per statement so no state or export
            payload from a previous statement can leak into this one. */}
        <ActiveView key={activeTab.kind} filters={filters} onExportReady={handleExportReady} />
      </PageContent>
    </>
  );
}
