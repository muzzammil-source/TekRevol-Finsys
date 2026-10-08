import React, { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, X } from 'lucide-react';
import type { ColumnFilters, SortState } from '@/components/resizable-columns';

// Shared toolbar + view state for the Banking feed tables (2026-09-18).
//
// One instance of this state sits above the tabs, so the date range, the
// search text, the sort and the column filters all survive switching
// between Pending and Posted — the two tabs are two views of the same feed,
// and re-typing a search after every switch was the annoyance.
export type FeedView = {
  dateFrom: string;
  dateTo: string;
  search: string;
  sort: SortState;
  filters: ColumnFilters;
};

export function useFeedView() {
  const [view, setView] = useState<FeedView>({ dateFrom: '', dateTo: '', search: '', sort: null, filters: {} });
  const set = <K extends keyof FeedView>(key: K, value: FeedView[K]) => setView((prev) => ({ ...prev, [key]: value }));
  const activeFilterCount = Object.values(view.filters).reduce((n, values) => n + (values?.length ?? 0), 0);
  const reset = () => setView({ dateFrom: '', dateTo: '', search: '', sort: null, filters: {} });
  return { view, set, setView, activeFilterCount, reset };
}

/** A row reduced to the fields the toolbar searches and the headers sort on. */
export type FeedRowFields = {
  date: string;
  bank: string;
  description: string;
  amount: number;
  category: string;
};

/** Description, bank name or amount — matched case-insensitively. */
export function matchesSearch(fields: FeedRowFields, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  if (fields.description.toLowerCase().includes(q)) return true;
  if (fields.bank.toLowerCase().includes(q)) return true;
  if (fields.category.toLowerCase().includes(q)) return true;
  // Amounts match on the figure as typed, with or without the sign — "191"
  // and "-191.33" both find a $191.33 payment.
  const amount = fields.amount;
  const candidates = [String(amount), String(Math.abs(amount)), Math.abs(amount).toFixed(2), amount.toFixed(2)];
  return candidates.some((c) => c.includes(q.replace(/[$,]/g, '')));
}

export function passesFilters(fields: FeedRowFields, filters: ColumnFilters): boolean {
  for (const [key, values] of Object.entries(filters)) {
    if (!values || values.length === 0) continue;
    const value = key === 'bank' ? fields.bank : key === 'category' ? fields.category : '';
    if (!values.includes(value)) return false;
  }
  return true;
}

/** Sorts a copy of `rows` by the chosen field; unsorted keeps feed order. */
export function sortRows<T>(rows: T[], sort: SortState, fieldsOf: (row: T) => FeedRowFields): T[] {
  if (!sort) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const fa = fieldsOf(a);
    const fb = fieldsOf(b);
    switch (sort.key) {
      case 'date': return dir * fa.date.localeCompare(fb.date);
      case 'bank': return dir * fa.bank.localeCompare(fb.bank);
      case 'description': return dir * fa.description.localeCompare(fb.description);
      case 'category': return dir * fa.category.localeCompare(fb.category);
      // Spent sorts by money out, Received by money in; the other side sorts last.
      case 'spent': return dir * ((fa.amount < 0 ? -fa.amount : -Infinity) - (fb.amount < 0 ? -fb.amount : -Infinity));
      case 'received': return dir * ((fa.amount > 0 ? fa.amount : -Infinity) - (fb.amount > 0 ? fb.amount : -Infinity));
      default: return 0;
    }
  });
}

export function FeedToolbar({
  view,
  set,
  activeFilterCount,
  reset,
  resultCount,
  totalCount,
}: {
  view: FeedView;
  set: <K extends keyof FeedView>(key: K, value: FeedView[K]) => void;
  activeFilterCount: number;
  reset: () => void;
  resultCount: number;
  totalCount: number;
}) {
  const narrowed = view.search.trim() !== '' || !!view.dateFrom || !!view.dateTo || activeFilterCount > 0 || !!view.sort;
  return (
    <div className="flex flex-wrap items-center gap-2" data-feed-toolbar>
      <Input
        type="date"
        value={view.dateFrom}
        onChange={(e) => set('dateFrom', e.target.value)}
        className="h-8 w-[140px] text-xs"
        aria-label="From date"
      />
      <span className="text-xs text-muted-foreground">to</span>
      <Input
        type="date"
        value={view.dateTo}
        onChange={(e) => set('dateTo', e.target.value)}
        className="h-8 w-[140px] text-xs"
        aria-label="To date"
      />
      <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
        <Input
          value={view.search}
          onChange={(e) => set('search', e.target.value)}
          placeholder="Search description, bank, or amount..."
          className="h-8 pl-8 pr-7 text-xs"
          aria-label="Search transactions"
          data-feed-search
        />
        {view.search && (
          <button
            type="button"
            onClick={() => set('search', '')}
            className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {narrowed && (
        <>
          <span className="text-[11px] text-muted-foreground" data-feed-count>
            {resultCount} of {totalCount}
            {activeFilterCount > 0 ? ` · ${activeFilterCount} filter${activeFilterCount > 1 ? 's' : ''}` : ''}
          </span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={reset} data-feed-reset>Reset</Button>
        </>
      )}
    </div>
  );
}
