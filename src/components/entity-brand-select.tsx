import React from 'react';
import { useListBrands } from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { entityLabel } from '@/lib/constants';
import { useAuth } from '@/lib/auth';

export interface EntityBrandValue {
  entityId?: number;
  brandId?: number;
}

/**
 * Unified Entity/Brand picker. An entity and its brand are the same
 * real-world thing today (one brand per entity, same name) — this renders
 * a single dropdown over `brands` (each row already carries its entityId)
 * so picking "BuzzFlick" sets entityId + brandId together instead of
 * requiring two separate selections.
 */
export function EntityBrandSelect({
  value,
  onChange,
  allLabel = 'All Consolidated',
  label = 'Entity / Brand',
}: {
  value: EntityBrandValue;
  onChange: (value: EntityBrandValue) => void;
  allLabel?: string;
  label?: string;
}) {
  const { data: brands } = useListBrands();
  const brandsList = (brands || []) as any[];
  // Entity isolation (2026-09-17): the list is already filtered server-side;
  // a user without all-entity access has no consolidated view, so the
  // "All" option is removed and their first entity is selected.
  const { allEntities } = useAuth();
  React.useEffect(() => {
    if (!allEntities && !value.brandId && brandsList.length > 0) {
      onChange({ entityId: brandsList[0].entityId, brandId: brandsList[0].id });
    }
  }, [allEntities, value.brandId, brandsList.length]);

  const selected = value.brandId ? String(value.brandId) : (allEntities ? '__all' : '');

  return (
    <div>
      <label className="text-xs font-medium mb-1 block">{label}</label>
      <Select
        value={selected}
        onValueChange={(v) => {
          if (v === '__all') {
            onChange({});
            return;
          }
          const brand = brandsList.find((b) => String(b.id) === v);
          onChange({ entityId: brand?.entityId, brandId: brand?.id });
        }}
      >
        <SelectTrigger><SelectValue placeholder={allLabel} /></SelectTrigger>
        <SelectContent>
          {allEntities && <SelectItem value="__all">{allLabel}</SelectItem>}
          {brandsList.map((b) => (
            <SelectItem key={b.id} value={String(b.id)}>{entityLabel(b.name)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
