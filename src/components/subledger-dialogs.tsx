import React, { useState } from 'react';
import { useContactLedger, useListEntities, useSubledger, type Contact } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { exportStatementsExcel, exportStatementsPdf, toStatement } from '@/lib/ledger-export';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { entityLabel } from '@/lib/constants';
import { CheckCircle2, ChevronRight, FileSpreadsheet, FileText, XCircle } from 'lucide-react';

// Customer / Vendor sub-ledger dialogs (2026-09-16), shared by the Contacts
// page and the Trial Balance / Balance Sheet drill-downs. Every figure comes
// from Posted journal lines via the API — nothing here is computed from a
// stored balance.

export function usd(n: number | null | undefined) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
}

function native(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** Statement of Account: every posted line for the contact, with the AR/AP running balance. */
export function ContactStatementDialog({ contactId, onOpenChange }: { contactId: number | null; onOpenChange: (o: boolean) => void }) {
  const { data, isLoading } = useContactLedger(contactId) as { data: any; isLoading: boolean };
  const contact = data?.contact as Contact | undefined;
  const lines = (data?.lines || []) as any[];
  const balanceLabel = contact?.contactType === 'Vendor' ? 'We owe' : 'Owes us';
  const { data: entitiesData } = useListEntities();
  const { toast } = useToast();
  const [exporting, setExporting] = useState<'pdf' | 'xlsx' | null>(null);

  // One-click export of exactly what this statement shows.
  const exportAs = async (kind: 'pdf' | 'xlsx') => {
    if (!data || !contact) return;
    setExporting(kind);
    try {
      const entityName = contact.entityId
        ? entityLabel(((entitiesData || []) as any[]).find((e) => e.id === contact.entityId)?.name || `Entity ${contact.entityId}`)
        : 'Shared (all entities)';
      const statement = toStatement(data, entityName);
      const fileBase = `statement-${contact.name}`;
      if (kind === 'pdf') await exportStatementsPdf([statement], fileBase);
      else await exportStatementsExcel([statement], fileBase);
    } catch (err: any) {
      toast({ title: 'Export failed', description: err.message, variant: 'destructive' });
    } finally {
      setExporting(null);
    }
  };
  return (
    <Dialog open={!!contactId} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-5xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-2">
            Statement of Account — {contact?.name ?? '…'}
            {contact && <Badge variant="outline" className="border-transparent bg-gray-100 text-[10px] uppercase">{contact.contactType}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {contact
              ? <>{contact.contactType === 'Customer' && contact.projectName ? <span data-statement-project>Project: <span className="font-medium text-foreground">{contact.projectName}</span> · </span> : null}Current balance <span className="font-mono font-semibold text-foreground" data-statement-balance={contact.outstandingUSD}>{usd(contact.outstandingUSD)}</span> ({balanceLabel.toLowerCase()})
                {/* The strict open-invoice subset, when it differs — cash-settled
                    lines move the running balance but never sat in A/R–A/P. */}
                {Math.abs((contact.openArApUSD ?? 0) - (contact.outstandingUSD ?? 0)) > 0.005 && (
                  <> · open {contact.contactType === 'Vendor' ? 'A/P' : 'A/R'} <span className="font-mono text-foreground" data-statement-open-arap={contact.openArApUSD}>{usd(contact.openArApUSD)}</span></>
                )}
                {contact.openingBalanceEntryId ? <> · Opening {native(contact.openingBalance || 0, contact.openingBalanceCurrency || 'USD')} as of {contact.openingBalanceDate}</> : null}</>
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <Table className="table-fixed min-w-[860px]">
            <colgroup>
              <col className="w-[96px]" /><col className="w-[118px]" /><col /><col className="w-[170px]" /><col className="w-[108px]" /><col className="w-[108px]" /><col className="w-[118px]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Entry #</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-xs">Account</TableHead>
                <TableHead className="text-xs text-right">Debit (USD)</TableHead>
                <TableHead className="text-xs text-right">Credit (USD)</TableHead>
                <TableHead className="text-xs text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">Loading…</TableCell></TableRow>
              ) : lines.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="py-6 text-center font-mono text-sm text-muted-foreground">No posted activity for this contact</TableCell></TableRow>
              ) : lines.map((l) => (
                <TableRow key={l.lineId} data-affects-balance={l.affectsBalance}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{l.transactionDate}</TableCell>
                  <TableCell className="font-mono text-xs truncate">{l.entryNumber}</TableCell>
                  <TableCell className="min-w-0 text-xs">
                    <div className="truncate" title={l.description}>{l.description}</div>
                    <div className="text-[10px] text-muted-foreground">{entityLabel(l.entityName || '')}{l.onArAp ? ' · open A/R–A/P' : ''}</div>
                  </TableCell>
                  <TableCell className="text-xs truncate" title={`${l.accountCode} ${l.accountName}`}><span className="mr-1 font-mono text-gray-400">{l.accountCode}</span>{l.accountName}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums whitespace-nowrap">{l.debitUSD ? usd(l.debitUSD) : ''}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums whitespace-nowrap">{l.creditUSD ? usd(l.creditUSD) : ''}</TableCell>
                  <TableCell className={`text-right font-mono text-xs tabular-nums whitespace-nowrap font-semibold ${l.runningBalanceUSD < 0 ? 'text-red-700' : ''}`}>
                    {usd(l.runningBalanceUSD)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!data || !!exporting} onClick={() => exportAs('xlsx')} data-export-ledger="xlsx">
              <FileSpreadsheet className="mr-2 size-4" /> {exporting === 'xlsx' ? 'Exporting…' : 'Export Excel'}
            </Button>
            <Button variant="outline" size="sm" disabled={!data || !!exporting} onClick={() => exportAs('pdf')} data-export-ledger="pdf">
              <FileText className="mr-2 size-4" /> {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
            </Button>
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** AR / AP control account → itemized customers / vendors, reconciled to the control balance. */
export function SubledgerDialog({
  account,
  entityId,
  asOfDate,
  onOpenChange,
}: {
  account: { accountId: number; code: string; name: string } | null;
  entityId?: number;
  asOfDate?: string;
  onOpenChange: (o: boolean) => void;
}) {
  const { data, isLoading } = useSubledger({ accountId: account?.accountId ?? null, entityId, asOfDate });
  const [statementId, setStatementId] = useState<number | null>(null);
  return (
    <>
      <Dialog open={!!account} onOpenChange={onOpenChange}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl">
          <DialogHeader>
            <DialogTitle>{account ? `${account.code} ${account.name}` : ''} — by {data?.account.category === 'Payables' ? 'vendor' : 'customer'}</DialogTitle>
            <DialogDescription>
              As of {data?.asOfDate ?? asOfDate} · {entityId ? 'single entity' : 'all entities (consolidated)'} · click a row for its statement
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{data?.account.category === 'Payables' ? 'Vendor' : 'Customer'}</TableHead>
                  <TableHead className="text-xs whitespace-nowrap">Last activity</TableHead>
                  <TableHead className="text-xs text-right">Balance (USD)</TableHead>
                  <TableHead className="w-6" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading || !data ? (
                  <TableRow><TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">Loading…</TableCell></TableRow>
                ) : data.items.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-6 text-center font-mono text-sm text-muted-foreground">No open balances</TableCell></TableRow>
                ) : data.items.map((it) => (
                  <TableRow
                    key={it.contactId ?? 'unassigned'}
                    data-subledger-row={it.contactName}
                    className={it.contactId ? 'cursor-pointer hover:bg-muted/50' : ''}
                    onClick={() => it.contactId && setStatementId(it.contactId)}
                  >
                    <TableCell className={`text-sm ${it.contactId ? '' : 'italic text-amber-700'}`}>{it.contactName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{it.lastActivityDate}</TableCell>
                    <TableCell className={`text-right font-mono text-xs tabular-nums ${it.balanceUSD < 0 ? 'text-red-700' : ''}`}>{usd(it.balanceUSD)}</TableCell>
                    <TableCell>{it.contactId && <ChevronRight className="size-3.5 text-muted-foreground" />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {data && (
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-xs" data-subledger-reconciles={data.reconciles}>
              <span className="flex items-center gap-1.5">
                {data.reconciles
                  ? <><CheckCircle2 className="size-3.5 text-green-600" /> Ties to the control account</>
                  : <><XCircle className="size-3.5 text-red-600" /> Does not tie — sub-ledger {usd(data.itemsTotalUSD)}</>}
              </span>
              <span className="font-mono">Control balance <span className="font-semibold">{usd(data.controlBalanceUSD)}</span></span>
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ContactStatementDialog contactId={statementId} onOpenChange={(o) => { if (!o) setStatementId(null); }} />
    </>
  );
}

/** True for the control accounts that have a customer / vendor sub-ledger. */
export function hasSubledger(category: string | null | undefined): boolean {
  return category === 'Receivables' || category === 'Payables';
}
