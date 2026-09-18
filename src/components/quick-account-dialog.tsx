import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListAccountsQueryKey, useCreateAccount } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth';
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, entityLabel } from '@/lib/constants';

// "+ Create New Category" from the Banking Hub's Categorize picker
// (2026-09-17): adds a Chart of Accounts head without leaving the feed.
// Same POST /api/accounts as the COA page (server validates entity access,
// Shared = all-entity users only, and rejects a duplicate code).
//
// Sub-types that create system-managed heads are left out: "Bank" would
// become a bank card / cash account and "Intercompany Clearing" heads are
// raised automatically by the intercompany engine.
const SYSTEM_SUBTYPES = new Set(['Bank', 'Intercompany Clearing']);
const CODE_BANDS: Record<string, string> = { Asset: '1000s', Liability: '2000s', Equity: '3000s', Revenue: '4000s', Expense: '5000s' };

export function QuickAccountDialog({
  open,
  onOpenChange,
  entities,
  defaultEntityId,
  defaultType = 'Expense',
  defaultName = '',
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entities: any[];
  /** The booking (charged-to) entity of the row the picker belongs to. */
  defaultEntityId?: string;
  defaultType?: string;
  defaultName?: string;
  onCreated: (account: any) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { allEntities } = useAuth();
  const createAccount = useCreateAccount();

  const [name, setName] = useState(defaultName);
  const [type, setType] = useState(defaultType);
  const [code, setCode] = useState('');
  const subtypesFor = (t: string) => (ACCOUNT_SUBTYPES[t] || []).filter((s) => !SYSTEM_SUBTYPES.has(s));
  const [subType, setSubType] = useState(() => {
    const list = subtypesFor(defaultType);
    return list.find((s) => s.startsWith('Operating')) || list[0] || '';
  });
  // Entity Scope: Entity-Specific (only that entity can book to it) or
  // Shared (every entity can; needs all-entity access, server-enforced).
  const [scope, setScope] = useState<'entity' | 'shared'>('entity');
  const [entityId, setEntityId] = useState(defaultEntityId || (entities[0] ? String(entities[0].id) : ''));
  const isShared = scope === 'shared';

  const onTypeChange = (t: string) => {
    setType(t);
    const list = subtypesFor(t);
    setSubType(list.find((s) => s.startsWith('Operating')) || list[0] || '');
  };

  const codeValid = code.trim() === '' || /^\d{3,6}$/.test(code.trim());
  const canSave = !!name.trim() && !!type && !!subType && (isShared || !!entityId) && codeValid && !createAccount.isPending;

  const save = () => {
    if (!canSave) return;
    createAccount.mutate(
      {
        data: {
          name: name.trim(),
          type,
          subType,
          ...(code.trim() ? { code: code.trim() } : {}),
          entityId: isShared ? null : Number(entityId),
          parentId: null,
          isActive: true,
        },
      },
      {
        onSuccess: (account: any) => {
          // Put it in the cached chart straight away so the picker can show
          // it selected before the refetch lands.
          queryClient.setQueryData<any[]>(getListAccountsQueryKey(), (old) => (old ? [...old.filter((a) => a.id !== account.id), account] : old));
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          toast({ title: 'Category created', description: `${account.code} — ${account.name}` });
          onCreated(account);
          onOpenChange(false);
        },
        onError: (err: any) => toast({ title: 'Could not create category', description: err.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-quick-account-form>
        <DialogHeader>
          <DialogTitle>Create New Category</DialogTitle>
          <DialogDescription>Adds a Chart of Accounts head and selects it on this transaction.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium">Account Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Software Subscriptions" autoFocus aria-label="Account Name" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Type</span>
              <Select value={type} onValueChange={onTypeChange}>
                <SelectTrigger aria-label="Type"><SelectValue /></SelectTrigger>
                <SelectContent>{ACCOUNT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Code <span className="font-normal text-gray-400">(optional)</span></span>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={`Auto (${CODE_BANDS[type] || ''})`}
                inputMode="numeric"
                className="font-mono"
                aria-label="Code"
              />
            </label>
          </div>
          {!codeValid && <p className="text-[11px] text-red-700">Code must be 3–6 digits, or leave it blank to auto-assign.</p>}
          <label className="block">
            <span className="mb-1 block text-xs font-medium">Sub-Type</span>
            <Select value={subType} onValueChange={setSubType}>
              <SelectTrigger aria-label="Sub-Type"><SelectValue placeholder="Sub-type" /></SelectTrigger>
              <SelectContent>{subtypesFor(type).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </label>

          {/* Entity Scope */}
          <div>
            <span className="mb-1 block text-xs font-medium">Entity Scope</span>
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'entity' | 'shared')} className="mb-2 grid grid-cols-2 gap-2" aria-label="Entity Scope">
              <label className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${!isShared ? 'border-primary bg-muted' : ''}`}>
                <RadioGroupItem value="entity" aria-label="Entity-Specific" /> Entity-Specific
              </label>
              <label
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${isShared ? 'border-primary bg-muted' : ''} ${allEntities ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                title={allEntities ? undefined : 'Shared accounts affect every entity — requires access to all entities'}
              >
                <RadioGroupItem value="shared" aria-label="Shared" disabled={!allEntities} /> Shared
              </label>
            </RadioGroup>
            {isShared ? (
              <p className="text-[11px] text-muted-foreground" data-scope-note="shared">Every entity can post to this account (Shared / Global).</p>
            ) : (
              <>
                <Select value={entityId} onValueChange={setEntityId}>
                  <SelectTrigger aria-label="Entity"><SelectValue placeholder="Entity" /></SelectTrigger>
                  <SelectContent>
                    {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-[11px] text-muted-foreground">Only this entity can post to this account.</p>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!canSave} data-quick-account-save>
            {createAccount.isPending ? 'Creating…' : 'Create & Select'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
