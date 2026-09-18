import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

// Searchable GL account picker (2026-09-11). A plain <Select> made this
// unusable once a real chart of accounts was imported: no way to type, and
// hundreds of options in one long list. This is the shadcn combobox
// pattern — Popover + cmdk — so typing filters on BOTH the account code
// and the name ("5000" and "bank" both narrow), and the list scrolls.
//
// Shared vs entity-specific heads: when `entityId` is given, the list
// shows that entity's own accounts PLUS shared ones (entityId null), and
// nothing belonging to another entity. Shared heads are labelled so it's
// obvious which are group-wide.
export function GLAccountSelect({
  accounts,
  value,
  onChange,
  entityId,
  placeholder = 'Select account',
  className,
  disabled = false,
  onCreateNew,
}: {
  accounts: any[];
  value: string;
  onChange: (accountId: string) => void;
  entityId?: number | null;
  placeholder?: string;
  className?: string;
  /** Read-only roles (e.g. Auditor) see the value but can't change it. */
  disabled?: boolean;
  /**
   * Shows "+ Create New Category" at the top of the list; called with
   * whatever was typed in the search box (pre-fills the account name).
   */
  onCreateNew?: (typedName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    // Inactive (retired) accounts can't take new postings — the server
    // rejects them too — so they're left out of the picker.
    const active = accounts.filter((a) => a.isActive !== 0 && a.isActive !== false);
    const list = entityId
      ? active.filter((a) => !a.entityId || a.entityId === entityId)
      : active;
    return [...list].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  }, [accounts, entityId]);

  const selected = visible.find((a) => String(a.id) === String(value))
    // Keep a previously-chosen account visible in the trigger even if the
    // entity filter would now exclude it, rather than silently blanking.
    || accounts.find((a) => String(a.id) === String(value));

  return (
    <Popover open={open && !disabled} onOpenChange={(o) => { if (disabled) return; setOpen(o); if (!o) setSearch(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          disabled={disabled}
          aria-expanded={open}
          className={cn('h-8 min-h-8 justify-between px-2.5 text-xs font-normal shadow-xs', className)}
        >
          <span className={cn('min-w-0 truncate', !selected && 'text-muted-foreground')}>
            {selected ? `${selected.code} — ${selected.name}` : placeholder}
          </span>
          <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            // itemValue carries "<code> <name>" so a search matches either.
            const q = search.trim().toLowerCase();
            if (!q) return 1;
            // The create action always stays visible.
            if (itemValue === '__create_new') return 1;
            return itemValue.toLowerCase().includes(q) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search code or name…" className="h-9" value={search} onValueChange={setSearch} />
          <CommandList className="max-h-64 overflow-y-auto">
            {!onCreateNew && <CommandEmpty>No matching account.</CommandEmpty>}
            {onCreateNew && (
              <CommandGroup>
                <CommandItem
                  value="__create_new"
                  onSelect={() => { const typed = search.trim(); setSearch(''); setOpen(false); onCreateNew(typed); }}
                  className="text-xs font-medium text-primary"
                  data-create-category
                >
                  <Plus className="mr-2 size-3" /> Create New Category{search.trim() ? ` “${search.trim()}”` : ''}
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {visible.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`${a.code} ${a.name}`}
                  onSelect={() => { onChange(String(a.id)); setSearch(''); setOpen(false); }}
                  className="text-xs"
                >
                  <Check className={cn('mr-2 size-3', String(value) === String(a.id) ? 'opacity-100' : 'opacity-0')} />
                  <span className="font-mono text-muted-foreground mr-2">{a.code}</span>
                  <span className="truncate flex-1">{a.name}</span>
                  {!a.entityId && (
                    <Badge variant="outline" className="ml-2 border-transparent bg-gray-100 text-gray-500 text-[9px]">
                      Shared
                    </Badge>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
