import React, { useState } from 'react';
import {
  useListEntities, useListBrands, useListBankAccounts,
  useCreateEntity, useUpdateEntity, useDeleteEntity, getListEntitiesQueryKey,
} from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PlusCircle, Pencil, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

// Entities are the spine of the ledger: every journal entry and every bank
// account is keyed to one. They used to exist only as a boot seed, which
// meant they couldn't be managed at all; as of the 2026-09-11 hard reset
// this screen is the only way they come into existence.
//
// Creating one here also provisions its brand and, server-side, reciprocal
// counterparty-specific clearing accounts with every existing entity ("Due
// From / Due To Affiliates — <other entity>" in both sets of books), so the
// intercompany posting engine has somewhere to post from day one.
function EntityFormModal({
  open, onOpenChange, entryToEdit,
}: { open: boolean; onOpenChange: (o: boolean) => void; entryToEdit?: any }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createEntity = useCreateEntity();
  const updateEntity = useUpdateEntity();
  const isEdit = !!entryToEdit;

  const [name, setName] = useState(isEdit ? entryToEdit.name : '');
  const [country, setCountry] = useState(isEdit ? entryToEdit.country : '');
  const [functionalCurrency, setFunctionalCurrency] = useState(isEdit ? entryToEdit.functionalCurrency : 'USD');

  const canSubmit = !!name.trim() && !!country.trim();
  const pending = createEntity.isPending || updateEntity.isPending;

  const onDone = (title: string) => {
    toast({ title });
    queryClient.invalidateQueries({ queryKey: getListEntitiesQueryKey() });
    queryClient.invalidateQueries({ queryKey: ['brands'] });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    onOpenChange(false);
  };
  const onFail = (err: any) => toast({ title: 'Could not save entity', description: err.message, variant: 'destructive' });

  const handleSubmit = () => {
    if (!canSubmit) return;
    const data = { name: name.trim(), country: country.trim(), functionalCurrency: functionalCurrency.trim().toUpperCase() };
    if (isEdit) updateEntity.mutate({ id: entryToEdit.id, data }, { onSuccess: () => onDone('Entity updated'), onError: onFail });
    else createEntity.mutate({ data }, {
      onSuccess: (res: any) => onDone(res?.intercompanyAccountsCreated
        ? `Entity created · ${res.intercompanyAccountsCreated} intercompany clearing accounts added`
        : 'Entity created'),
      onError: onFail,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Entity' : 'New Entity'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Renaming an entity does not touch its posted history. Other entities’ “Due From / Due To Affiliates — …” accounts are renamed to match.'
              : 'A matching brand is created, plus “Due From / Due To Affiliates” accounts pairing this entity with every existing entity — in both sets of books.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Entity Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TekRevol US" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Country</label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. US" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Functional Currency</label>
              <Input value={functionalCurrency} onChange={(e) => setFunctionalCurrency(e.target.value)} placeholder="USD" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSubmit || pending} onClick={handleSubmit}>
            {pending ? 'Saving…' : isEdit ? 'Save Entity' : 'Create Entity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SettingsEntities() {
  const { data: entities, isLoading } = useListEntities();
  const { data: brands } = useListBrands();
  const { data: bankAccounts } = useListBankAccounts();
  const deleteEntity = useDeleteEntity();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [entryToEdit, setEntryToEdit] = useState<any>(null);

  const entityList = (entities || []) as any[];
  const brandList = (brands || []) as any[];
  const bankList = (bankAccounts || []) as any[];

  const handleDelete = (e: any) => {
    if (!confirm(`Delete "${e.name}"? Its brand, its own accounts, and every other entity's "Due From / Due To Affiliates — ${e.name}" accounts go with it.`)) return;
    deleteEntity.mutate({ id: e.id }, {
      onSuccess: () => {
        toast({ title: `${e.name} deleted` });
        queryClient.invalidateQueries({ queryKey: getListEntitiesQueryKey() });
        queryClient.invalidateQueries({ queryKey: ['brands'] });
        queryClient.invalidateQueries({ queryKey: ['accounts'] });
      },
      onError: (err: any) => toast({ title: 'Cannot delete entity', description: err.message, variant: 'destructive' }),
    });
  };

  return (
    <>
      <PageHeader title="Entities" description="Entities the books are kept for">
        <Button onClick={() => { setEntryToEdit(null); setModalOpen(true); }}>
          <PlusCircle className="mr-2 size-4" /> New Entity
        </Button>
      </PageHeader>
      <PageContent>
        <SurfaceCard padded={false}>
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50/80 hover:bg-gray-50/80">
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Entity</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Country</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Functional Currency</TableHead>
                {/* Brand and Entity are one concept here (one same-named
                    brand per entity), so this column shows the posting
                    tag rather than a second, differently-named thing. */}
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Posting Tag</TableHead>
                <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 text-right">Bank Accounts (COA)</TableHead>
                <TableHead className="w-[90px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}><Skeleton className="h-4 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : entityList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center">
                    <div className="text-[14px] font-semibold text-gray-900">No entities yet</div>
                    <div className="mt-1 text-[13px] text-gray-500">
                      Create the first legal entity to start keeping books. Journal entries and bank accounts are keyed to one.
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                entityList.map((e) => (
                  <TableRow key={e.id} className="group hover:bg-gray-50/60">
                    <TableCell className="text-[13px] font-medium text-gray-900">{e.name}</TableCell>
                    <TableCell className="text-[13px] text-gray-600">{e.country || '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-gray-600">{e.functionalCurrency}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {brandList.filter((b) => b.entityId === e.id).map((b) => (
                          <Badge key={b.id} variant="outline" className="border-transparent bg-gray-100 text-gray-600 text-[10px] font-medium">
                            {b.name}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    {/* Server-derived: counts this entity's Asset/Bank
                        heads in the Chart of Accounts, which is what the
                        Banking hub renders one-for-one. Counting
                        bank_accounts feed rows here reported 0 until a
                        statement had been uploaded. */}
                    <TableCell className="text-right font-mono text-[13px] tabular-nums text-gray-600">
                      {e.bankAccountCount ?? 0}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => { setEntryToEdit(e); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" onClick={() => handleDelete(e)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </SurfaceCard>

        <p className="text-[13px] text-gray-500 max-w-2xl">
          An entity can only be deleted while it has no journal entries and no bank accounts — deleting one never
          deletes its books. Exchange rates used to translate foreign-currency bank activity into USD are managed
          under <span className="font-medium text-gray-700">Settings → Currency</span>.
        </p>
      </PageContent>

      {modalOpen && (
        <EntityFormModal
          key={entryToEdit ? `edit-${entryToEdit.id}` : 'create'}
          open={modalOpen}
          onOpenChange={setModalOpen}
          entryToEdit={entryToEdit}
        />
      )}
    </>
  );
}
