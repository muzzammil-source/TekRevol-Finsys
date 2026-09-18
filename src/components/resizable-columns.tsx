import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TableHead } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ArrowDown, ArrowUp, ChevronsUpDown, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';

// Drag-to-resize table columns — the standard for every data table
// (2026-09-17: Banking Pending/Posted, Chart of Accounts, Contacts).
//
// Usage:
//   const columns = useResizableColumns('finsys.<table>.columns.v1', DEFAULT_WIDTHS);
//   <Table className="table-fixed [&_td]:overflow-hidden" style={columns.tableStyle}>
//     <ResizableColGroup widths={columns.widths} />
//     <TableHeader><TableRow><ResizableHeaderCells columns={COLUMNS} table={columns} /></TableRow></TableHeader>
// Define DEFAULT_WIDTHS at module level (a stable array). Widths are
// per-viewer conveniences, remembered in localStorage when available.
// Drag a header's right border to resize; double-click it to reset.

export type ResizableColumnDef = {
  key: string;
  label: string;
  width: number;
  align?: 'left' | 'right';
  /** Default true. Fixed columns (e.g. a select-all checkbox) set false. */
  resizable?: boolean;
  /** Custom header content (e.g. a checkbox); `label` still names the handle. */
  header?: React.ReactNode;
  /** Set to make the header click-to-sort on this field. */
  sortKey?: string;
  /** Set to offer a checkbox filter popover over this field's values. */
  filterKey?: string;
};

export const defaultWidths = (columns: ResizableColumnDef[]) => columns.map((c) => c.width);

const MIN_WIDTH = 48;

function readStored(storageKey: string, defaults: number[]): number[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length === defaults.length && parsed.every((n) => typeof n === 'number' && n > 0)) {
      return parsed;
    }
  } catch {
    // Storage blocked or corrupt — fall back to defaults.
  }
  return defaults;
}

export function useResizableColumns(storageKey: string, defaults: number[]) {
  const [widths, setWidths] = useState<number[]>(() => readStored(storageKey, defaults));
  const drag = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(widths)); } catch { /* ignore */ }
  }, [storageKey, widths]);

  const startResize = useCallback((index: number, event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    drag.current = { index, startX: event.clientX, startWidth: widths[index] };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const next = Math.max(MIN_WIDTH, Math.round(d.startWidth + e.clientX - d.startX));
      setWidths((prev) => (prev[d.index] === next ? prev : prev.map((w, i) => (i === d.index ? next : w))));
    };
    const onUp = () => {
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [widths]);

  const resetColumn = useCallback((index: number) => {
    setWidths((prev) => prev.map((w, i) => (i === index ? defaults[index] : w)));
  }, [defaults]);

  const total = widths.reduce((s, w) => s + w, 0);
  // Never narrower than the card; wider columns make the card scroll.
  const tableStyle: React.CSSProperties = { width: `max(${total}px, 100%)` };

  return { widths, startResize, resetColumn, tableStyle };
}

export function ColumnResizeHandle({
  index,
  label,
  onStart,
  onReset,
}: {
  index: number;
  label: string;
  onStart: (index: number, event: React.PointerEvent) => void;
  onReset: (index: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      title="Drag to resize · double-click to reset"
      data-col-resize={index}
      onPointerDown={(e) => onStart(index, e)}
      onDoubleClick={() => onReset(index)}
      onClick={(e) => e.stopPropagation()}
      className="group absolute right-0 top-0 z-10 flex h-full w-2 cursor-col-resize touch-none select-none justify-end"
    >
      <span className="h-full w-px bg-border transition-colors group-hover:w-0.5 group-hover:bg-ring group-active:bg-primary" />
    </div>
  );
}

export function ResizableColGroup({ widths }: { widths: number[] }) {
  return <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>;
}

export type SortState = { key: string; dir: 'asc' | 'desc' } | null;
/** Chosen values per filterable column; an absent/empty set means "all". */
export type ColumnFilters = Record<string, string[]>;

/**
 * Header cells with a drag handle on each resizable column, and — for
 * columns that declare `sortKey` / `filterKey` — a click-to-sort label with
 * an arrow and a checkbox filter popover (2026-09-18). Sorting and filtering
 * state lives with the caller, so it survives tab switches.
 */
export function ResizableHeaderCells({
  columns,
  table,
  sort,
  onSortChange,
  filters,
  onFiltersChange,
  filterOptions,
}: {
  columns: ResizableColumnDef[];
  table: Pick<ReturnType<typeof useResizableColumns>, 'startResize' | 'resetColumn'>;
  sort?: SortState;
  onSortChange?: (next: SortState) => void;
  filters?: ColumnFilters;
  onFiltersChange?: (next: ColumnFilters) => void;
  /** Distinct values offered per `filterKey`. */
  filterOptions?: Record<string, string[]>;
}) {
  const toggleSort = (key: string) => {
    if (!onSortChange) return;
    if (sort?.key !== key) onSortChange({ key, dir: 'asc' });
    else if (sort.dir === 'asc') onSortChange({ key, dir: 'desc' });
    else onSortChange(null); // third click clears the sort
  };

  return (
    <>
      {columns.map((col, i) => {
        const sortable = !!col.sortKey && !!onSortChange;
        const options = col.filterKey ? filterOptions?.[col.filterKey] ?? [] : [];
        const active = col.filterKey ? filters?.[col.filterKey] ?? [] : [];
        const sorted = sortable && sort?.key === col.sortKey;
        return (
          <TableHead
            key={col.key}
            className={cn('relative', col.align === 'right' && 'text-right')}
            title={col.label || undefined}
          >
            <div className={cn('flex min-w-0 items-center gap-1', col.align === 'right' && 'justify-end')}>
              {sortable ? (
                <button
                  type="button"
                  onClick={() => toggleSort(col.sortKey!)}
                  className="flex min-w-0 items-center gap-1 truncate uppercase hover:text-foreground"
                  aria-label={`Sort by ${col.label}`}
                  data-sort-button={col.sortKey}
                  data-sort-active={sorted ? sort!.dir : undefined}
                >
                  <span className="truncate">{col.header ?? col.label}</span>
                  {sorted
                    ? (sort!.dir === 'asc' ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)
                    : <ChevronsUpDown className="size-3 shrink-0 opacity-30" />}
                </button>
              ) : (
                <span className="truncate">{col.header ?? col.label}</span>
              )}

              {col.filterKey && onFiltersChange && options.length > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn('shrink-0 rounded p-0.5 hover:bg-background', active.length > 0 ? 'text-primary' : 'opacity-40 hover:opacity-100')}
                      aria-label={`Filter by ${col.label}`}
                      data-filter-button={col.filterKey}
                      data-filter-active={active.length || undefined}
                    >
                      <Filter className="size-3" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-56 p-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{col.label}</span>
                      {active.length > 0 && (
                        <button
                          type="button"
                          className="text-[11px] text-primary hover:underline"
                          onClick={() => onFiltersChange({ ...filters, [col.filterKey!]: [] })}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="max-h-56 space-y-1 overflow-y-auto">
                      {options.map((value) => {
                        const checked = active.includes(value);
                        return (
                          <label key={value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => onFiltersChange({
                                ...filters,
                                [col.filterKey!]: checked ? active.filter((v) => v !== value) : [...active, value],
                              })}
                              aria-label={value}
                            />
                            <span className="truncate" title={value}>{value}</span>
                          </label>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            {col.resizable !== false && (
              <ColumnResizeHandle index={i} label={col.label} onStart={table.startResize} onReset={table.resetColumn} />
            )}
          </TableHead>
        );
      })}
    </>
  );
}
