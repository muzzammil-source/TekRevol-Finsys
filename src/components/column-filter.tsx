import React from 'react';
import { Filter, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ColumnFilter({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const toggle = (opt: string) => {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange(next);
  };

  const active = selected.size > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`inline-flex items-center ml-1 rounded-sm p-0.5 hover:bg-muted ${active ? 'text-primary' : 'text-muted-foreground'}`}
          onClick={(e) => e.stopPropagation()}
        >
          <Filter className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto w-56 p-1">
        {active && (
          <button
            className="w-full text-left text-xs px-2 py-1 text-primary hover:bg-muted rounded-sm mb-1"
            onClick={() => onChange(new Set())}
          >
            Clear filter
          </button>
        )}
        {options.length === 0 && (
          <div className="text-xs text-muted-foreground px-2 py-1">No values</div>
        )}
        {options.map((opt) => (
          <label
            key={opt}
            className="flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-muted cursor-pointer"
          >
            <Checkbox checked={selected.has(opt)} onCheckedChange={() => toggle(opt)} />
            <span className="truncate">{opt || '(blank)'}</span>
          </label>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SortIcon({ dir }: { dir?: 'asc' | 'desc' }) {
  if (dir === 'asc') return <ChevronUp className="size-3" />;
  if (dir === 'desc') return <ChevronDown className="size-3" />;
  return <ChevronsUpDown className="size-3 opacity-40" />;
}

export type SortState = { key: string; dir: 'asc' | 'desc' } | null;

export function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  filterOptions,
  filterSelected,
  onFilterChange,
  className,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  filterOptions?: string[];
  filterSelected?: Set<string>;
  onFilterChange?: (next: Set<string>) => void;
  className?: string;
}) {
  const dir = sort?.key === sortKey ? sort.dir : undefined;
  return (
    <div className={`flex items-center gap-1 ${className || ''}`}>
      <button className="flex items-center gap-1 hover:text-foreground" onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        <SortIcon dir={dir} />
      </button>
      {filterOptions && filterSelected && onFilterChange && (
        <ColumnFilter options={filterOptions} selected={filterSelected} onChange={onFilterChange} />
      )}
    </div>
  );
}
