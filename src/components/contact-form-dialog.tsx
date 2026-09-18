import React, { useState } from 'react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateContact, useUpdateContact, type Contact, type ContactType } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useToast } from '@/hooks/use-toast';
import { entityLabel } from '@/lib/constants';
import { useAuth } from '@/lib/auth';

// Customer / Vendor create & edit form (2026-09-17) — shared by the Contacts
// directory and the Banking Hub's "+ Add New Contact" (so a contact can be
// created without leaving the feed).
//
// Rules (also enforced server-side):
//   - Customer: exactly ONE entity (its receivable sits in one set of books).
//   - Vendor:   Specific Entity, or Shared Across All Entities (all-entity
//               users only).
//   - Opening Balance: optional (blank = none). It posts a real journal entry
//     (Dr AR / Cr Opening Balance Equity, or Dr OBE / Cr AP) in the contact's
//     entity, so it needs the `post` capability and a specific entity.

// Posting an opening balance changes the books → refresh ledger-derived views.
export const CONTACT_LEDGER_KEYS = [['contacts'], ['trial-balance'], ['balance-sheet'], ['general-ledger'], ['account-balances'], ['account-register'], ['accounts'], ['journal-entries'], ['subledger']];

export function ContactFormDialog({
  contact,
  defaultType = 'Vendor',
  defaultEntityId,
  defaultName = '',
  open,
  onOpenChange,
  entities,
  onSaved,
}: {
  contact: Contact | null;
  defaultType?: ContactType;
  /** Pre-selected entity for a new contact (e.g. the bank row's charged-to entity). */
  defaultEntityId?: string;
  /** Pre-filled name for a new contact (e.g. what was typed in the From/To search). */
  defaultName?: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entities: any[];
  onSaved?: (contact: Contact) => void;
}) {
  const isEdit = !!contact;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { can, allEntities } = useAuth();
  const canPostOpening = can('post');
  const create = useCreateContact();
  const update = useUpdateContact();

  const [name, setName] = useState(contact?.name ?? defaultName);
  const [email, setEmail] = useState(contact?.email ?? '');
  const [projectName, setProjectName] = useState(contact?.projectName ?? '');
  const [contactType, setContactType] = useState<ContactType>(contact?.contactType ?? defaultType);
  const [scope, setScope] = useState<'entity' | 'shared'>(isEdit && contact!.entityId == null ? 'shared' : 'entity');
  const [entityId, setEntityId] = useState<string>(
    contact?.entityId ? String(contact.entityId) : (defaultEntityId || (entities[0] ? String(entities[0].id) : '')),
  );
  const [openingBalance, setOpeningBalance] = useState<string>(isEdit && contact!.openingBalanceEntryId ? String(contact!.openingBalance ?? '') : '');
  const [openingBalanceDate, setOpeningBalanceDate] = useState<string>(contact?.openingBalanceDate ?? format(new Date(), 'yyyy-MM-dd'));
  const [isActive, setIsActive] = useState(contact ? contact.isActive !== 0 : true);

  // A legacy Shared customer (pre-dating the single-entity rule) may still be
  // edited without being forced to pick an entity; a new/changed one may not.
  const legacySharedCustomer = isEdit && contact!.contactType === 'Customer' && contact!.entityId == null;
  const sharedAllowed = contactType === 'Vendor' || legacySharedCustomer;
  const isShared = sharedAllowed && scope === 'shared';
  // Type/scope lock once the contact has activity beyond its own opening balance.
  const otherActivity = isEdit && (contact!.postedLineCount ?? 0) > (contact!.openingBalanceEntryId ? 1 : 0);

  const entity = entities.find((e) => String(e.id) === entityId);
  const currency = entity?.functionalCurrency || 'USD';
  const openingAmount = openingBalance.trim() === '' ? 0 : Number(openingBalance);
  const openingValid = Number.isFinite(openingAmount);
  const sharedWithOpening = isShared && openingAmount !== 0;
  const canSave = !!name.trim() && (isShared || !!entityId) && openingValid && !sharedWithOpening;

  const onTypeChange = (t: ContactType) => {
    setContactType(t);
    if (t === 'Customer' && !legacySharedCustomer) setScope('entity');
  };

  const save = () => {
    const payload = {
      name: name.trim(),
      contactType,
      entityId: isShared ? null : Number(entityId),
      email: email.trim(),
      projectName: contactType === 'Customer' ? projectName.trim() : '',
      openingBalance: isShared ? 0 : openingAmount,
      openingBalanceDate,
    };
    const done = (title: string) => (saved: any) => {
      toast({ title });
      for (const key of CONTACT_LEDGER_KEYS) queryClient.invalidateQueries({ queryKey: key });
      onSaved?.(saved as Contact);
      onOpenChange(false);
    };
    const fail = (err: any) => toast({ title: 'Could not save contact', description: err.message, variant: 'destructive' });
    if (isEdit) update.mutate({ id: contact!.id, ...payload, isActive }, { onSuccess: done(`${contactType} updated`), onError: fail });
    else create.mutate(payload, { onSuccess: done(openingAmount ? `${contactType} added · opening balance posted` : `${contactType} added`), onError: fail });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-contact-form>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${contact!.contactType}` : 'Add New Contact'}</DialogTitle>
          <DialogDescription>
            {otherActivity ? 'Type and entity are locked — this contact already has ledger activity.' : 'Name, type and entity are required. Email and opening balance are optional.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* Contact Type */}
          <div>
            <span className="mb-1 block text-xs font-medium">Contact Type</span>
            <RadioGroup value={contactType} onValueChange={(v) => onTypeChange(v as ContactType)} disabled={otherActivity} className="grid grid-cols-2 gap-2" aria-label="Contact Type">
              {(['Customer', 'Vendor'] as const).map((t) => (
                <label key={t} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${contactType === t ? 'border-gray-900 bg-gray-50' : ''}`}>
                  <RadioGroupItem value={t} aria-label={t} /> {t}
                </label>
              ))}
            </RadioGroup>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={contactType === 'Customer' ? 'e.g. Acme Corp' : 'e.g. Amazon Web Services'} autoFocus aria-label="Name" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Email <span className="font-normal text-gray-400">(optional)</span></span>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            </label>
          </div>

          {contactType === 'Customer' && (
            <label className="block" data-project-name-field>
              <span className="mb-1 block text-xs font-medium">Project Name <span className="font-normal text-gray-400">(optional)</span></span>
              <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="e.g. Mobile App Redesign" aria-label="Project Name" />
            </label>
          )}

          {/* Entity Assignment */}
          <div>
            <span className="mb-1 block text-xs font-medium">Entity Assignment</span>
            {sharedAllowed && (
              <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'entity' | 'shared')} disabled={otherActivity} className="mb-2 grid grid-cols-2 gap-2" aria-label="Entity Scope">
                <label className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${!isShared ? 'border-gray-900 bg-gray-50' : ''}`}>
                  <RadioGroupItem value="entity" aria-label="Specific Entity" /> Specific Entity
                </label>
                <label
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${isShared ? 'border-gray-900 bg-gray-50' : ''} ${allEntities ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                  title={allEntities ? undefined : 'Shared contacts affect every entity — requires access to all entities'}
                >
                  <RadioGroupItem value="shared" aria-label="Shared Across All Entities" disabled={!allEntities && !isShared} /> Shared Across All Entities
                </label>
              </RadioGroup>
            )}
            {isShared ? (
              <p className="text-[11px] text-gray-500" data-scope-note="shared">
                Available in the From/To picker for every entity's bank transactions, including entities added later.
              </p>
            ) : (
              <>
                <Select value={entityId} onValueChange={setEntityId} disabled={otherActivity}>
                  <SelectTrigger aria-label="Entity"><SelectValue placeholder="Select entity" /></SelectTrigger>
                  <SelectContent>
                    {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                  </SelectContent>
                </Select>
                {contactType === 'Customer' && (
                  <p className="mt-1 text-[11px] text-gray-500" data-customer-single-entity>A customer belongs to one entity — only vendors can be shared.</p>
                )}
              </>
            )}
          </div>

          {/* Opening Balance (optional) */}
          {isShared ? (
            <p className={`text-[11px] ${sharedWithOpening ? 'text-red-700' : 'text-gray-500'}`} data-opening-shared>
              {sharedWithOpening
                ? 'This contact has an opening balance, which lives in one entity’s books — clear it under Specific Entity before sharing.'
                : 'Shared vendors have no opening balance: it would belong to one entity’s books.'}
            </p>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">Opening Balance ({currency}) <span className="font-normal text-gray-400">(optional)</span></span>
                  <Input
                    type="number" inputMode="decimal" step="0.01"
                    value={openingBalance}
                    onChange={(e) => setOpeningBalance(e.target.value)}
                    placeholder="0.00"
                    className="text-right font-mono"
                    aria-label="Opening Balance"
                    disabled={!canPostOpening}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">As of</span>
                  <Input type="date" value={openingBalanceDate} onChange={(e) => setOpeningBalanceDate(e.target.value)} aria-label="Opening balance date" disabled={!canPostOpening || openingAmount === 0} />
                </label>
              </div>
              <p className={`mt-1 text-[11px] ${canPostOpening ? 'text-gray-500' : 'text-amber-700'}`} data-opening-help>
                {!canPostOpening
                  ? 'Opening balances post to the ledger — a Manager or Admin sets them.'
                  : contactType === 'Customer'
                    ? 'What this customer already owed you — starts their A/R balance (Dr Accounts Receivable / Cr Opening Balance Equity).'
                    : 'What you already owed this vendor — starts their A/P balance (Dr Opening Balance Equity / Cr Accounts Payable).'}
              </p>
            </div>
          )}

          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(!!v)} /> Active
              <span className="text-[11px] text-gray-500">— inactive contacts keep history but can't be picked for new postings</span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!canSave || create.isPending || update.isPending} data-contact-save>
            {create.isPending || update.isPending ? 'Saving…' : isEdit ? 'Save' : `Add ${contactType}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
