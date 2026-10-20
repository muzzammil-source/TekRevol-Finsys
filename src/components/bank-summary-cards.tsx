import React from 'react';
import { useBankingCards } from '@workspace/api-client-react';
import { Skeleton } from '@/components/ui/skeleton';
import { SurfaceCard } from '@/components/layout';
import { entityLabel } from '@/lib/constants';
import { Link } from 'wouter';
import { AlertTriangle, ArrowRight, Landmark, RefreshCw } from 'lucide-react';

// Bank Summary Cards (2026-10-20) — one card per cash/bank head, showing
// what the bank says against what the books say.
//
// Strictly a view. It reads `GET /api/banking/cards`, the same endpoint the
// Bank Transactions hub already uses, which returns both figures per
// account: `liveBalance` (the feed's reported balance) and `ledgerBalance`
// (the GL balance, computed server-side from posted lines). Nothing here
// recomputes a balance, writes anything, or adds an endpoint — a difference
// shown on a card is the server's own arithmetic, not this component's.

type BankCard = {
  accountId: number;
  code: string;
  name: string;
  subType: string;
  entityId: number | null;
  bankAccountId: number | null;
  connectionType: 'PLAID' | 'MANUAL_UPLOAD';
  unpostedCount: number;
  localCurrency: string;
  localBalance: number;
  localRateFound: boolean;
  liveBalance: number | null;
  liveRateFound: boolean | null;
};

function money(amount: number | null | undefined, currency: string) {
  if (amount === null || amount === undefined) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function Figure({ label, value, muted, tone }: { label: string; value: React.ReactNode; muted?: string; tone?: 'plain' | 'bad' }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-[15px] font-semibold tabular-nums ${tone === 'bad' ? 'text-rose-700' : 'text-gray-900'}`}>
        {value}
      </div>
      {muted && <div className="mt-0.5 truncate text-[10px] text-gray-400">{muted}</div>}
    </div>
  );
}

export function BankSummaryCards({
  entityId,
  entities,
  title = 'Bank & Cash Accounts',
  description = 'What the bank reports against what the books say',
}: {
  entityId?: number;
  entities?: { id: number; name: string }[];
  title?: string;
  description?: string;
}) {
  const { data, isLoading } = useBankingCards(entityId ? { entityId } : undefined) as {
    data: { cards: BankCard[] } | undefined;
    isLoading: boolean;
  };

  const cards = (data?.cards || []).filter((c) => c.subType !== 'Intercompany Clearing');
  const entityName = (id: number | null) => {
    if (id == null) return 'Shared / Global';
    const match = (entities || []).find((e) => e.id === id);
    return match ? entityLabel(match.name) : `Entity ${id}`;
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-bank-summary-loading>
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[136px] w-full rounded-md" />)}
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <SurfaceCard>
        <div className="py-6 text-center text-[13px] text-gray-400">
          No bank or cash accounts yet — add one in the Chart of Accounts, then connect or upload a statement.
        </div>
      </SurfaceCard>
    );
  }

  return (
    <div data-bank-summary>
      <div className="mb-2">
        <div className="text-[13px] font-semibold text-gray-900">{title}</div>
        <div className="text-[11px] text-gray-400">{description}</div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => {
          const currency = card.localCurrency || 'USD';
          const book = card.localBalance ?? 0;
          const bank = card.liveBalance;
          // Only a real comparison when the bank actually reported one.
          // A manually uploaded statement has no live balance, and showing
          // a difference against a missing number would invent a variance.
          const hasBank = bank !== null && bank !== undefined;
          const difference = hasBank ? Math.round((bank! - book) * 100) / 100 : null;
          const reconciled = difference !== null && Math.abs(difference) < 0.005;

          return (
            <div
              key={card.accountId}
              className="rounded-md border border-[#E2E8F0] bg-white p-4 shadow-sm transition-colors hover:border-slate-300"
              data-bank-card={card.accountId}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-gray-900">
                    <Landmark className="size-3.5 shrink-0 text-gray-400" />
                    <span className="truncate" title={card.name}>{card.name}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400">
                    <span className="font-mono">{card.code}</span> · {entityName(card.entityId)} · {currency}
                  </div>
                </div>
                {card.connectionType === 'PLAID' && (
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-600">
                    Live
                  </span>
                )}
              </div>

              <div className="mt-3 flex items-start gap-3 border-t border-gray-100 pt-3">
                <Figure
                  label="Bank Balance"
                  value={hasBank ? money(bank, currency) : <span className="text-[13px] font-normal text-gray-300">Not reported</span>}
                  muted={hasBank ? undefined : card.connectionType === 'MANUAL_UPLOAD' ? 'Uploaded statements carry no balance' : undefined}
                />
                <div className="mt-3 h-6 w-px shrink-0 bg-gray-100" />
                <Figure label="Book Balance (GL)" value={money(book, currency)} />
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-2.5">
                <div className="min-w-0 text-[11px]">
                  {difference === null ? (
                    <span className="text-gray-400">No bank balance to compare</span>
                  ) : reconciled ? (
                    <span className="font-medium text-emerald-700">Matches the books</span>
                  ) : (
                    <span className="flex items-center gap-1 font-medium text-amber-700" data-bank-card-difference>
                      <AlertTriangle className="size-3 shrink-0" />
                      Off by {money(Math.abs(difference), currency)}
                    </span>
                  )}
                  {card.unpostedCount > 0 && (
                    <div className="mt-0.5 flex items-center gap-1 text-gray-500">
                      <RefreshCw className="size-3 shrink-0" />
                      {card.unpostedCount} transaction{card.unpostedCount === 1 ? '' : 's'} not yet posted
                    </div>
                  )}
                  {!card.localRateFound && (
                    <div className="mt-0.5 text-amber-700">No {currency} rate configured — figure is unconverted</div>
                  )}
                </div>

                {/* Opens the reconciliation workflow with this account
                    already chosen. Accounts with no feed have nothing to
                    reconcile against, so they link to the hub instead. */}
                {card.bankAccountId ? (
                  <Link
                    href={`/banking/reconciliation?account=${card.bankAccountId}`}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-[#E2E8F0] px-2 py-1 text-[11px] font-medium text-[#0F172A] transition-colors hover:bg-[#F1F5F9]"
                    data-reconcile-link={card.bankAccountId}
                  >
                    Reconcile <ArrowRight className="size-3" />
                  </Link>
                ) : (
                  <Link
                    href="/banking"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-dashed border-[#E2E8F0] px-2 py-1 text-[11px] text-gray-500 transition-colors hover:bg-[#F1F5F9]"
                    title="This account has no bank feed yet — connect one or upload a statement"
                  >
                    Set up feed <ArrowRight className="size-3" />
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
