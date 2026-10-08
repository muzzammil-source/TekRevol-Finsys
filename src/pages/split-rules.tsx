import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListSplitRulesQueryKey, useCreateSplitRule, useDeleteSplitRule, useListEntities, useListSplitRules, useUpdateSplitRule,
  type SplitRule,
} from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { entityLabel } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import { ResizableColGroup, ResizableHeaderCells, defaultWidths, useResizableColumns, type ResizableColumnDef } from '@/components/resizable-columns';
import { PlusCircle, Trash2 } from 'lucide-react';

// Split Rules (2026-09-17) — reusable multi-entity percentage templates
// ("50/50 Dual Entity", "3-Way 33/33/34"), applied from the Banking Hub's
// Split Transaction modal.
//
// A rule is configuration, never a figure in the books: applying one only
// fills the modal's lines, and posting still runs the split engine's
// cent-exact checks. Percentages are held to 4 dp and must total 100.

const COLUMNS: ResizableColumnDef[] = [
  { key: 'name', label: 'Rule', width: 260 },
  { key: 'split', label: 'Split', width: 420 },
  { key: 'status', label: 'Status', width: 110 },
  { key: 'actions', label: 'Actions', width: 150, align: 'right' },
];
const DEFAULT_WIDTHS = defaultWidths(COLUMNS);

const PCT_SCALE = 10000;
const units = (v: string | number) => Math.round((Number(v) || 0) * PCT_SCALE);
const fmtPct = (n: number) => `${Number(n.toFixed(4))}%`;

type DraftLine = { id: string; entityId: string; percent: string };
const newDraftLine = (patch: Partial<DraftLine> = {}): DraftLine => ({ id: Math.random().toString(36).slice(2), entityId: '', percent: '', ...patch });

function RuleDialog({
  rule,
  open,
  onOpenChange,
  entities,
}: {
  rule: SplitRule | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entities: any[];
}) {
  const isEdit = !!rule;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const create = useCreateSplitRule();
  const update = useUpdateSplitRule();

  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [lines, setLines] = useState<DraftLine[]>(
    rule
      ? rule.lines.map((l) => newDraftLine({ entityId: String(l.entityId), percent: String(Number(l.percent.toFixed(4))) }))
      : [newDraftLine(), newDraftLine()],
  );

  const total = lines.reduce((s, l) => s + units(l.percent), 0);
  const duplicateEntity = new Set(lines.map((l) => l.entityId).filter(Boolean)).size !== lines.filter((l) => l.entityId).length;
  const complete = lines.every((l) => l.entityId && units(l.percent) > 0);
  const canSave = !!name.trim() && lines.length >= 2 && complete && !duplicateEntity && total === 100 * PCT_SCALE && !create.isPending && !update.isPending;

  const setLine = (id: string, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLine = () => {
    // Seed the new line with whatever percentage is still unallocated.
    const remaining = 100 * PCT_SCALE - total;
    setLines((prev) => [...prev, newDraftLine({ percent: remaining > 0 ? String(remaining / PCT_SCALE) : '' })]);
  };
  const removeLine = (id: string) => setLines((prev) => (prev.length > 2 ? prev.filter((l) => l.id !== id) : prev));
  /** Even split across the current lines, last line taking the remainder. */
  const splitEvenly = () => setLines((prev) => {
    const each = Math.floor((100 * PCT_SCALE) / prev.length);
    return prev.map((l, i) => ({ ...l, percent: String((i === prev.length - 1 ? 100 * PCT_SCALE - each * (prev.length - 1) : each) / PCT_SCALE) }));
  });

  const save = () => {
    const payload = { name: name.trim(), description: description.trim(), lines: lines.map((l) => ({ entityId: Number(l.entityId), percent: Number(l.percent) })) };
    const done = (title: string) => () => {
      toast({ title });
      queryClient.invalidateQueries({ queryKey: getListSplitRulesQueryKey() });
      onOpenChange(false);
    };
    const fail = (err: any) => toast({ title: 'Could not save rule', description: err.message, variant: 'destructive' });
    if (isEdit) update.mutate({ id: rule!.id, ...payload }, { onSuccess: done('Rule updated'), onError: fail });
    else create.mutate(payload, { onSuccess: done('Rule created'), onError: fail });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-rule-form>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit split rule' : 'New split rule'}</DialogTitle>
          <DialogDescription>Percentages must total exactly 100%. Applying the rule fills a Split Transaction; it never posts on its own.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium">Rule Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 50/50 Dual Entity" autoFocus aria-label="Rule Name" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium">Description <span className="font-normal text-gray-400">(optional)</span></span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When to use this rule" aria-label="Description" />
          </label>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium">Entities</span>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={splitEvenly} data-split-evenly>Split evenly</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, idx) => (
                <div key={l.id} className="grid grid-cols-[1fr_110px_32px] items-center gap-2" data-rule-line={idx + 1}>
                  <Select value={l.entityId} onValueChange={(v) => setLine(l.id, { entityId: v })}>
                    <SelectTrigger className="h-8 text-xs" aria-label={`Line ${idx + 1} entity`}><SelectValue placeholder="Entity" /></SelectTrigger>
                    <SelectContent>
                      {entities.map((e) => <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Input
                      type="number" inputMode="decimal" min="0" max="100" step="0.01"
                      value={l.percent}
                      onChange={(e) => setLine(l.id, { percent: e.target.value })}
                      placeholder="0"
                      className="h-8 pr-6 text-right font-mono text-xs"
                      aria-label={`Line ${idx + 1} percentage`}
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" onClick={() => removeLine(l.id)} disabled={lines.length <= 2} aria-label={`Remove line ${idx + 1}`}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" className="mt-2" onClick={addLine} data-add-rule-line>
              <PlusCircle className="mr-2 size-3.5" /> Add entity
            </Button>
          </div>

          <div
            className={`rounded-md border px-3 py-2 font-mono text-xs ${total === 100 * PCT_SCALE && !duplicateEntity ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}
            data-rule-total={total / PCT_SCALE}
          >
            Total {fmtPct(total / PCT_SCALE)}
            {total === 100 * PCT_SCALE ? ' ✓' : ` — ${fmtPct(Math.abs(100 - total / PCT_SCALE))} ${total > 100 * PCT_SCALE ? 'over' : 'remaining'}`}
            {duplicateEntity && ' · an entity is listed twice'}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!canSave} data-rule-save>
            {create.isPending || update.isPending ? 'Saving…' : isEdit ? 'Save rule' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SplitRulesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Rules span entities, so only an Admin with every entity may edit them
  // (server-enforced); everyone else can read and apply them.
  const { can, allEntities } = useAuth();
  const canEdit = can('admin') && allEntities;
  const { data, isLoading } = useListSplitRules();
  const rules = useMemo(() => (data || []) as SplitRule[], [data]);
  const { data: entitiesData } = useListEntities();
  const entities = useMemo(() => (entitiesData || []) as any[], [entitiesData]);
  const del = useDeleteSplitRule();
  const [editing, setEditing] = useState<SplitRule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const columns = useResizableColumns('finsys.split-rules.columns.v1', DEFAULT_WIDTHS);

  const handleDelete = (rule: SplitRule) => {
    if (!confirm(`Delete "${rule.name}"? Postings already made with it are unaffected.`)) return;
    del.mutate({ id: rule.id }, {
      onSuccess: () => {
        toast({ title: 'Rule deleted' });
        queryClient.invalidateQueries({ queryKey: getListSplitRulesQueryKey() });
      },
      onError: (err: any) => toast({ title: 'Could not delete rule', description: err.message, variant: 'destructive' }),
    });
  };

  return (
    <>
      <PageHeader title="Rules" description="Reusable multi-entity split templates, applied from a bank transaction's Split view">
        {canEdit && (
          <Button onClick={() => { setEditing(null); setFormOpen(true); }} data-new-rule>
            <PlusCircle className="mr-2 size-4" /> New rule
          </Button>
        )}
      </PageHeader>

      <PageContent>
        <SurfaceCard padded={false}>
          <div className="overflow-x-auto">
            <Table className="table-fixed [&_td]:overflow-hidden [&_td:first-child]:pl-4 [&_th:first-child]:pl-4" style={columns.tableStyle} data-resizable-table="split-rules">
              <ResizableColGroup widths={columns.widths} />
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ResizableHeaderCells columns={COLUMNS} table={columns} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>{COLUMNS.map((c) => <TableCell key={c.key}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
                  ))
                ) : rules.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLUMNS.length} className="py-8 text-center font-mono text-sm text-muted-foreground">
                      No split rules yet{canEdit ? ' — create one, e.g. 50/50 across two entities' : ''}
                    </TableCell>
                  </TableRow>
                ) : rules.map((rule) => (
                  <TableRow key={rule.id} data-rule-row={rule.name}>
                    <TableCell className="text-sm">
                      <div className="truncate font-medium" title={rule.name}>{rule.name}</div>
                      {rule.description && <div className="truncate text-[11px] text-muted-foreground" title={rule.description}>{rule.description}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {rule.lines.map((l) => (
                          <Badge key={l.id} variant="outline" className="border-transparent bg-muted text-[10px] font-medium" data-rule-part={l.entityName}>
                            {entityLabel(l.entityName)} {fmtPct(l.percent)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`border-transparent text-[10px] ${rule.isActive ? 'bg-tint-positive text-tint-positive-foreground' : 'bg-muted text-muted-foreground'}`}>
                        {rule.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canEdit && (
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setEditing(rule); setFormOpen(true); }}>Edit</Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => handleDelete(rule)}>Delete</Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SurfaceCard>
      </PageContent>

      {formOpen && (
        <RuleDialog
          key={editing ? `edit-${editing.id}` : 'new'}
          rule={editing}
          open={formOpen}
          onOpenChange={(o) => { setFormOpen(o); if (!o) setEditing(null); }}
          entities={entities}
        />
      )}
    </>
  );
}
