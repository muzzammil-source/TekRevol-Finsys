import React, { useMemo, useState } from 'react';
import type { Contact, ContactType } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

// Payee / Contact picker (2026-09-16) for the Customer/Vendor sub-ledger.
//
// - Scoped like accounts: the entity whose ledger the line lands in sees its
//   own contacts plus Shared ones.
// - Both Customers and Vendors are ALWAYS listed, whatever the sign — a
//   deposit can be a customer receipt or a vendor refund, a payout can be a
//   vendor bill or a customer refund. Direction only decides which group is
//   shown first (Vendors for money out, Customers for money in). The server
//   accepts either type in either direction.
// - Quick-create: typing a name with no exact match offers "Add as Vendor /
//   Customer", created for this line's entity.
export function ContactSelect({
  contacts,
  entityId,
  direction,
  value,
  onChange,
  onCreate,
  className,
  placeholder = 'From/To',
  disabled = false,
  canCreate = true,
  onAddNew,
  crossEntityType,
  entityNameOf,
}: {
  contacts: Contact[];
  entityId: number | null;
  direction: 'in' | 'out';
  value: string;
  onChange: (contactId: string) => void;
  onCreate: (name: string, contactType: ContactType) => Promise<Contact>;
  className?: string;
  placeholder?: string;
  /** Read-only roles see the value but can't change it. */
  disabled?: boolean;
  /** Hide quick-create for roles that can't write contacts. */
  canCreate?: boolean;
  /**
   * Opens the full "Add New Contact" form (type, email, entity/shared scope,
   * opening balance) with whatever was typed pre-filled. When provided it
   * replaces the inline one-click "Add as Vendor/Customer" rows.
   */
  onAddNew?: (typedName: string) => void;
  /**
   * Contacts of this type are listed from EVERY entity, not just `entityId`'s
   * (labelled with their entity). Used for money-in rows, where choosing a
   * customer re-points Charged To to that customer's entity.
   */
  crossEntityType?: ContactType;
  entityNameOf?: (entityId: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const preferred: ContactType = direction === 'out' ? 'Vendor' : 'Customer';
  const other: ContactType = preferred === 'Vendor' ? 'Customer' : 'Vendor';

  const visible = useMemo(
    () => contacts.filter((c) => c.isActive !== 0 && (
      c.entityId == null || entityId == null || Number(c.entityId) === Number(entityId) || c.contactType === crossEntityType
    )),
    [contacts, entityId, crossEntityType],
  );
  const byType = (t: ContactType) => visible.filter((c) => c.contactType === t).sort((a, b) => a.name.localeCompare(b.name));

  // Show the chosen contact even if it has since fallen out of scope, rather
  // than silently blanking the trigger.
  const selected = contacts.find((c) => String(c.id) === String(value));
  const query = search.trim();
  const exactMatch = query && visible.some((c) => c.name.toLowerCase() === query.toLowerCase());

  const create = async (t: ContactType) => {
    if (!query || creating) return;
    setCreating(true);
    try {
      const created = await onCreate(query, t);
      onChange(String(created.id));
      setSearch('');
      setOpen(false);
    } finally {
      setCreating(false);
    }
  };

  const groupFor = (t: ContactType) => {
    const list = byType(t);
    // Both groups always render (even empty) so it's clear either type can
    // be chosen for any transaction; an empty group explains how to add one.
    if (list.length === 0) {
      if (query) return null;
      return (
        <CommandGroup heading={t === 'Vendor' ? 'Vendors' : 'Customers'} data-contact-group={t}>
          <CommandItem value={`__empty_${t}`} disabled className="text-[11px] text-muted-foreground">
            No {t === 'Vendor' ? 'vendors' : 'customers'} yet — type a name to add one
          </CommandItem>
        </CommandGroup>
      );
    }
    return (
      <CommandGroup heading={t === 'Vendor' ? 'Vendors' : 'Customers'} data-contact-group={t}>
        {list.map((c) => (
          <CommandItem
            key={c.id}
            value={`${c.name} ${c.contactType} ${c.id}`}
            onSelect={() => { onChange(String(c.id)); setSearch(''); setOpen(false); }}
            className="text-xs"
          >
            <Check className={cn('mr-2 size-3', String(value) === String(c.id) ? 'opacity-100' : 'opacity-0')} />
            <span className="truncate flex-1">{c.name}</span>
            {c.entityId == null && <span className="ml-2 text-[9px] text-gray-400">Shared</span>}
            {c.entityId != null && entityId != null && Number(c.entityId) !== Number(entityId) && (
              <span className="ml-2 shrink-0 text-[9px] text-blue-700" data-other-entity>{entityNameOf ? entityNameOf(Number(c.entityId)) : `Entity ${c.entityId}`}</span>
            )}
          </CommandItem>
        ))}
      </CommandGroup>
    );
  };

  return (
    <Popover open={open && !disabled} onOpenChange={(o) => { if (disabled) return; setOpen(o); if (!o) setSearch(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          disabled={disabled}
          aria-expanded={open}
          aria-label="From/To"
          data-contact-select
          className={cn('h-8 min-h-8 justify-between px-2.5 text-xs font-normal shadow-xs', className)}
        >
          <span className={cn('min-w-0 truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.name : placeholder}
          </span>
          <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command
          filter={(itemValue, s) => {
            const q = s.trim().toLowerCase();
            if (!q) return 1;
            // Action rows (none/create) always stay visible.
            if (itemValue.startsWith('__')) return 1;
            return itemValue.toLowerCase().includes(q) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search or add customer / vendor…" className="h-9" value={search} onValueChange={setSearch} />
          <CommandList className="max-h-64 overflow-y-auto">
            {!(canCreate && onAddNew) && <CommandEmpty>No matching contact.</CommandEmpty>}
            {canCreate && onAddNew && (
              <CommandGroup>
                <CommandItem
                  value="__add_new"
                  onSelect={() => { const typed = query; setSearch(''); setOpen(false); onAddNew(typed); }}
                  className="text-xs font-medium text-primary"
                  data-add-new-contact
                >
                  <Plus className="mr-2 size-3" /> Add New Contact{query ? ` “${query}”` : ''}
                </CommandItem>
              </CommandGroup>
            )}
            {value && (
              <CommandGroup>
                <CommandItem value="__none" onSelect={() => { onChange(''); setOpen(false); }} className="text-xs text-muted-foreground">
                  Clear From/To
                </CommandItem>
              </CommandGroup>
            )}
            {groupFor(preferred)}
            {groupFor(other)}
            {canCreate && !onAddNew && query && !exactMatch && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Add new">
                  {[preferred, other].map((t) => (
                    <CommandItem key={t} value={`__create_${t}`} onSelect={() => create(t)} disabled={creating} className="text-xs">
                      <Plus className="mr-2 size-3" /> Add “{query}” as {t}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
