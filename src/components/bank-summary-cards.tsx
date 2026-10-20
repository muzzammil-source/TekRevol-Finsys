import React from 'react';
import { useBankingCards, useListBankAccounts } from '@workspace/api-client-react';
import { Skeleton } from '@/components/ui/skeleton';
import { SurfaceCard } from '@/components/layout';
import { entityLabel } from '@/lib/constants';
import { Link } from 'wouter';
import { AlertTriangle, ArrowRight, Landmark } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';

// Bank Summary Cards (2026-10-20) — one compact card per cash/bank head,
// showing what the bank says against what the books say.
//
// Strictly a view. It reads `GET /api/banking/cards` (the endpoint the Bank
// Transactions hub already uses, which returns both figures per account)
// and `GET /api/bank-accounts` for the last-synced timestamp. Nothing here
// recomputes a balance, writes anything, or adds an endpoint — a difference
// shown on a card is the server's own arithmetic, not this component's.
//
// Laid out to fit four or more across a desktop row: the grid is
// auto-fit/minmax rather than a fixed column count, so cards reflow from
// one column on a phone up to as many as the width allows.

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
};

/** Compact money: no currency symbol repetition inside a 220px card. */
function money(amount: number | null | undefined) {
  if (amount === null || amount === undefined) return null;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

function syncLabel(iso: string | null | undefined, connectionType: string): string {
  if (!iso) return connectionType === 'PLAID' ? 'Never synced' : 'Statement upload';
  try {
    return `Synced ${formatDistanceToNowStrict(new Date(iso), { addSuffix: true })}`;
  } catch {
    return 'Synced';
  }
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
  // Only for the "last synced" stamp — the balances themselves come from
  // the cards endpoint, so the two can never disagree.
  const { data: bankAccounts } = useListBankAccounts();
  const syncedAt = React.useMemo(() => {
    const map = new Map<number, string | null>();
    for (const a of ((bankAccounts || []) as any[])) map.set(a.id, a.currentBalanceUpdatedAt ?? null);
    return map;
  }, [bankAccounts]);

  const cards = (data?.cards || []).filter((c) => c.subType !== 'Intercompany Clearing');
  const entityName = (id: number | null) => {
    if (id == null) return 'Shared';
    const match = (entities || []).find((e) => e.id === id);
    return match ? entityLabel(match.name) : `Entity ${id}`;
  };

  // auto-fit + minmax: four across at ~1000px of content width, more on a
  // wider screen, gracefully down to one on a phone.
  const grid = 'grid gap-2 grid-cols-[repeat(auto-fit,minmax(220px,1fr))]';

  if (isLoading) {
    return (
      <div className={grid} data-bank-summary-loading>
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] w-full rounded-md" />)}
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
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-gray-900">{title}</span>
        <span className="truncate text-[10px] text-gray-400">{description}</span>
      </div>

      <div className={grid}>
        {cards.map((card) => {
          const currency = card.localCurrency || 'USD';
          const book = card.localBalance ?? 0;
          const bank = card.liveBalance;
          // Only a real comparison when the bank actually reported one. A
          // manually uploaded statement has no live balance, and showing a
          // difference against a missing number would invent a variance.
          const hasBank = bank !== null && bank !== undefined;
          const difference = hasBank ? Math.round((bank! - book) * 100) / 100 : null;
          const reconciled = difference !== null && Math.abs(difference) < 0.005;

          return (
            <div
              key={card.accountId}
              className="flex flex-col rounded-md border border-[#E2E8F0] bg-white px-2.5 py-1.5 shadow-sm transition-colors hover:border-slate-300"
              data-bank-card={card.accountId}
            >
              {/* Identity */}
              <div className="flex items-center gap-1.5">
                <Landmark className="size-3 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-tight text-gray-900" title={card.name}>
                  {card.name}
                </span>
                {card.connectionType === 'PLAID' && (
                  <span className="shrink-0 rounded bg-slate-100 px-1 text-[8px] font-medium uppercase tracking-wider text-slate-600">
                    Live
                  </span>
                )}
              </div>
              <div className="truncate text-[9.5px] leading-tight text-gray-400" title={`${card.code} · ${entityName(card.entityId)} · ${currency}`}>
                <span className="font-mono">{card.code}</span> · {entityName(card.entityId)} · {currency}
              </div>

              {/* The two figures, side by side */}
              <div className="mt-1 flex items-end gap-2 border-t border-gray-100 pt-1">
                <div className="min-w-0 flex-1">
                  <div className="text-[8.5px] font-semibold uppercase leading-tight tracking-wide text-gray-400">Bank</div>
                  <div className="truncate font-mono text-[12px] font-semibold leading-tight tabular-nums text-gray-900">
                    {hasBank ? money(bank) : <span className="font-sans text-[10px] font-normal text-gray-300">Not reported</span>}
                  </div>
                </div>
                <div className="mb-0.5 h-4 w-px shrink-0 bg-gray-100" />
                <div className="min-w-0 flex-1">
                  <div className="text-[8.5px] font-semibold uppercase leading-tight tracking-wide text-gray-400">Book (GL)</div>
                  <div className="truncate font-mono text-[12px] font-semibold leading-tight tabular-nums text-gray-900">{money(book)}</div>
                </div>
              </div>

              {/* Status, sync and the way in to reconciling — one line, so
                  the card stays four-across without a third band. */}
              <div className="mt-1 flex items-center justify-between gap-1.5 border-t border-gray-100 pt-1">
                <div className="flex min-w-0 items-center gap-1 text-[9.5px] leading-tight">
                  {difference === null ? (
                    <span className="shrink-0 text-gray-400">No bank bal.</span>
                  ) : reconciled ? (
                    <span className="shrink-0 font-medium text-emerald-700">Matches</span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-0.5 font-medium text-amber-700" data-bank-card-difference>
                      <AlertTriangle className="size-2.5 shrink-0" />
                      Off {money(Math.abs(difference!))}
                    </span>
                  )}
                  <span
                    className="truncate text-gray-400"
                    title={`${syncLabel(syncedAt.get(card.bankAccountId ?? -1), card.connectionType)}${card.unpostedCount ? ` · ${card.unpostedCount} unposted` : ''}${card.localRateFound ? '' : ` · no ${currency} rate configured`}`}
                  >
                    · {syncLabel(syncedAt.get(card.bankAccountId ?? -1), card.connectionType)}
                    {card.unpostedCount > 0 && ` · ${card.unpostedCount} unposted`}
                    {!card.localRateFound && <span className="text-amber-700"> · no rate</span>}
                  </span>
                </div>

                {card.bankAccountId ? (
                  <Link
                    href={`/banking/reconciliation?account=${card.bankAccountId}`}
                    className="flex shrink-0 items-center gap-0.5 rounded border border-[#E2E8F0] px-1.5 py-0.5 text-[9.5px] font-medium text-[#0F172A] transition-colors hover:bg-[#F1F5F9]"
                    title={`Reconcile ${card.name}`}
                    data-reconcile-link={card.bankAccountId}
                  >
                    Reconcile <ArrowRight className="size-2.5" />
                  </Link>
                ) : (
                  <Link
                    href="/banking"
                    className="shrink-0 rounded border border-dashed border-[#E2E8F0] px-1.5 py-0.5 text-[9.5px] text-gray-500 transition-colors hover:bg-[#F1F5F9]"
                    title="No bank feed yet — connect one or upload a statement"
                  >
                    Set up
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
