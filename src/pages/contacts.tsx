import React, { useMemo, useState } from 'react';
import {
  useListContacts, useDeleteContact, useListEntities, fetchContactLedger,
  type Contact, type ContactType,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageContent, PageHeader } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { entityLabel } from '@/lib/constants';
import { ContactStatementDialog, usd } from '@/components/subledger-dialogs';
import { ContactFormDialog, CONTACT_LEDGER_KEYS } from '@/components/contact-form-dialog';
import { exportStatementsExcel, exportStatementsPdf, toStatement } from '@/lib/ledger-export';
import { useAuth } from '@/lib/auth';
import { ResizableColGroup, ResizableHeaderCells, defaultWidths, useResizableColumns, type ResizableColumnDef } from '@/components/resizable-columns';
import { BookOpen, ChevronDown, Download, FileSpreadsheet, FileText, MoreHorizontal, Pencil, PlusCircle, Search, Trash2 } from 'lucide-react';

// Contacts — Customer & Vendor sub-ledger directory (2026-09-16, reworked
// 2026-09-17 with ledger export).
//
// Every figure is DERIVED from Posted journal lines tagged with the contact
// (see /api/contacts in server/index.ts); nothing is stored on the contact.
//   Current Running Balance  open A/R (customer owes us) / A/P (we owe the
//                            vendor), USD — includes the opening balance entry
// Posting a bank transaction with From/To = this contact updates it live.

const TYPE_BADGE: Record<ContactType, string> = {
  Customer: 'bg-emerald-50 text-emerald-700',
  Vendor: 'bg-amber-50 text-amber-700',
};

// Resizable directory columns — Project Name exists on the Customers tab only.
const VENDOR_COLUMNS: ResizableColumnDef[] = [
  { key: 'name', label: 'Name', width: 280 },
  { key: 'type', label: 'Contact Type', width: 130 },
  { key: 'entity', label: 'Assigned Entity', width: 170 },
  { key: 'balance', label: 'Current Running Balance', width: 200, align: 'right' },
  { key: 'actions', label: 'Actions', width: 90, align: 'right' },
];
// Narrower defaults on the Customers tab so the extra Project Name column
// still fits a 1280px window.
const CUSTOMER_COLUMNS: ResizableColumnDef[] = [
  { key: 'name', label: 'Name', width: 240 },
  { key: 'project', label: 'Project Name', width: 170 },
  { key: 'type', label: 'Contact Type', width: 110 },
  { key: 'entity', label: 'Assigned Entity', width: 150 },
  { key: 'balance', label: 'Current Running Balance', width: 180, align: 'right' },
  { key: 'actions', label: 'Actions', width: 80, align: 'right' },
];
const VENDOR_DEFAULT_WIDTHS = defaultWidths(VENDOR_COLUMNS);
const CUSTOMER_DEFAULT_WIDTHS = defaultWidths(CUSTOMER_COLUMNS);

export default function Contacts() {
  const { can, allEntities } = useAuth();
  const canWrite = can('contacts.write');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: entitiesData } = useListEntities();
  const entities = (entitiesData || []) as any[];
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const [tab, setTab] = useState<ContactType>('Customer');
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Contact | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [statementId, setStatementId] = useState<number | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const del = useDeleteContact();

  const { data, isLoading } = useListContacts({ includeInactive: showInactive });
  const all = (data || []) as Contact[];
  const counts = { Customer: all.filter((c) => c.contactType === 'Customer').length, Vendor: all.filter((c) => c.contactType === 'Vendor').length };
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all
      .filter((c) => c.contactType === tab)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.projectName || '').toLowerCase().includes(q));
  }, [all, tab, search]);
  const totalBalance = rows.reduce((s, c) => s + (c.outstandingUSD || 0), 0);
  // Project Name is a customer attribute — its column shows on the Customers tab only.
  const isCustomerTab = tab === 'Customer';
  // Resizable columns, remembered separately per tab (different column sets).
  const customerColumns = useResizableColumns('finsys.contacts.customers.columns.v1', CUSTOMER_DEFAULT_WIDTHS);
  const vendorColumns = useResizableColumns('finsys.contacts.vendors.columns.v1', VENDOR_DEFAULT_WIDTHS);
  const columns = isCustomerTab ? customerColumns : vendorColumns;
  const columnDefs = isCustomerTab ? CUSTOMER_COLUMNS : VENDOR_COLUMNS;
  const columnCount = columnDefs.length;

  const entityNameOf = (c: Contact) =>
    c.entityId ? entityLabel(entityById.get(c.entityId)?.name || `Entity ${c.entityId}`) : 'Shared (all entities)';

  // Export ledgers — one contact, or every contact currently listed in the tab
  // (Excel: summary sheet + one sheet each; PDF: summary page + one statement each).
  const exportLedgers = async (contacts: Contact[], kind: 'pdf' | 'xlsx', fileBase: string, key: string) => {
    if (contacts.length === 0) {
      toast({ title: 'Nothing to export', description: `No ${tab === 'Customer' ? 'customers' : 'vendors'} in this view.` });
      return;
    }
    setExporting(key);
    try {
      const ledgers = await Promise.all(contacts.map((c) => fetchContactLedger(c.id)));
      const statements = ledgers.map((l) => toStatement(l, entityNameOf(l.contact)));
      if (kind === 'pdf') await exportStatementsPdf(statements, fileBase);
      else await exportStatementsExcel(statements, fileBase);
      toast({ title: `Exported ${statements.length} ledger${statements.length === 1 ? '' : 's'}`, description: kind === 'pdf' ? 'PDF downloaded' : 'Excel workbook downloaded' });
    } catch (err: any) {
      toast({ title: 'Export failed', description: err.message, variant: 'destructive' });
    } finally {
      setExporting(null);
    }
  };

  const handleDelete = (c: Contact) => {
    if (!confirm(`Delete ${c.contactType.toLowerCase()} "${c.name}"?${c.openingBalanceEntryId ? ' Its opening-balance entry is removed too.' : ''}`)) return;
    del.mutate({ id: c.id }, {
      onSuccess: () => { toast({ title: 'Contact deleted' }); for (const key of CONTACT_LEDGER_KEYS) queryClient.invalidateQueries({ queryKey: key }); },
      onError: (err: any) => toast({ title: 'Contact not deleted', description: err.message, variant: 'destructive' }),
    });
  };

  const label = tab === 'Customer' ? 'Customers' : 'Vendors';

  return (
    <>
      <PageHeader title="Directory" description="Customer & vendor sub-ledgers — balances derived live from posted journal lines, stated in USD">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={!!exporting} data-export-all>
              <Download className="mr-2 size-4" /> {exporting?.startsWith('all') ? 'Exporting…' : 'Export Ledger'} <ChevronDown className="ml-1 size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">All {rows.length} {label.toLowerCase()} in this view</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => exportLedgers(rows, 'xlsx', `${label.toLowerCase()}-ledgers`, 'all-xlsx')} data-export-all-kind="xlsx">
              <FileSpreadsheet className="mr-2 size-4" /> Excel (.xlsx)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportLedgers(rows, 'pdf', `${label.toLowerCase()}-ledgers`, 'all-pdf')} data-export-all-kind="pdf">
              <FileText className="mr-2 size-4" /> PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {canWrite && (
          <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
            <PlusCircle className="mr-2 size-4" /> New {tab === 'Customer' ? 'customer' : 'vendor'}
          </Button>
        )}
      </PageHeader>
      <PageContent>
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Contact type" className="inline-flex rounded-lg bg-muted p-1">
            {(['Customer', 'Vendor'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                data-contacts-tab={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${tab === t ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t === 'Customer' ? 'Customers' : 'Vendors'} <span className="ml-1 text-xs text-muted-foreground">{counts[t]}</span>
              </button>
            ))}
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Filter ${label.toLowerCase()}`} className="pl-8" />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={showInactive} onCheckedChange={(v) => setShowInactive(!!v)} /> Show inactive
          </label>
          <div className="ml-auto text-right text-xs text-muted-foreground">
            Total {tab === 'Customer' ? 'receivable' : 'payable'} <span className="font-mono font-semibold text-foreground">{usd(totalBalance)}</span>
          </div>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-white shadow-sm">
          <Table
            className="table-fixed [&_td]:overflow-hidden"
            style={columns.tableStyle}
            data-resizable-table={isCustomerTab ? 'customers' : 'vendors'}
          >
            <ResizableColGroup widths={columns.widths} />
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <ResizableHeaderCells columns={columnDefs} table={columns} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>{Array.from({ length: columnCount }).map((__, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow><TableCell colSpan={columnCount}className="py-8 text-center font-mono text-sm text-muted-foreground">
                  No {label.toLowerCase()} yet — add one here or from the From/To field in Banking
                </TableCell></TableRow>
              ) : rows.map((c) => (
                <TableRow key={c.id} data-contact-row={c.name} className="cursor-pointer" onClick={() => setStatementId(c.id)}>
                  <TableCell className="text-sm">
                    <div className={`truncate font-medium ${c.isActive === 0 ? 'text-muted-foreground line-through' : ''}`} title={c.name}>{c.name}</div>
                    {c.email && <div className="truncate text-[11px] text-muted-foreground" title={c.email}>{c.email}</div>}
                  </TableCell>
                  {isCustomerTab && (
                    <TableCell className="truncate text-xs" data-project-name title={c.projectName || undefined}>
                      {c.projectName ? c.projectName : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  )}
                  <TableCell><Badge variant="outline" className={`border-transparent text-[10px] uppercase ${TYPE_BADGE[c.contactType]}`}>{c.contactType}</Badge></TableCell>
                  <TableCell className="truncate text-xs">{c.entityId ? entityNameOf(c) : <span className="text-gray-500">Shared (all entities)</span>}</TableCell>
                  <TableCell className={`text-right font-mono text-sm tabular-nums font-semibold whitespace-nowrap ${c.outstandingUSD < 0 ? 'text-red-700' : ''}`} data-current-balance={c.outstandingUSD}>
                    {usd(c.outstandingUSD)}
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${c.name}`}><MoreHorizontal className="size-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setStatementId(c.id)}><BookOpen className="mr-2 size-3.5" /> Statement of account</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => exportLedgers([c], 'xlsx', `statement-${c.name}`, `row-${c.id}`)}><FileSpreadsheet className="mr-2 size-3.5" /> Export ledger (Excel)</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => exportLedgers([c], 'pdf', `statement-${c.name}`, `row-${c.id}`)}><FileText className="mr-2 size-3.5" /> Export ledger (PDF)</DropdownMenuItem>
                        {/* A Shared contact affects every entity — editable only with all-entity access. */}
                        {canWrite && (allEntities || c.entityId != null) && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => { setEditing(c); setFormOpen(true); }}><Pencil className="mr-2 size-3.5" /> Edit</DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleDelete(c)}><Trash2 className="mr-2 size-3.5" /> Delete</DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </PageContent>

      {formOpen && (
        <ContactFormDialog
          key={editing ? `edit-${editing.id}` : `new-${tab}`}
          contact={editing}
          defaultType={tab}
          open={formOpen}
          onOpenChange={setFormOpen}
          entities={entities}
        />
      )}
      <ContactStatementDialog contactId={statementId} onOpenChange={(o) => { if (!o) setStatementId(null); }} />
    </>
  );
}
