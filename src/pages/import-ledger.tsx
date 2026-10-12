import React, { useMemo, useRef, useState } from 'react';
import {
  useListAccounts, useListEntities, usePreviewQuickBooksImport, useCommitQuickBooksImport,
  usePostImportBatch, useDiscardImportBatch, useImportBatches,
  type ImportPreview, type ImportAccountDecision,
} from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { entityLabel } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileUp, Upload } from 'lucide-react';

// Import Ledger — QuickBooks "Transaction Detail by Account" (Phase C).
//
// Upload → preview & confirm accounts → import as Draft → post. Nothing
// touches the book of record until the last step, and that step is refused
// while any source transaction sits in quarantine.

const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

function money(n: number) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-rose-700' : 'text-gray-900';
  return (
    <div className="rounded-md border border-gray-100 bg-white px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</div>
      <div className={`mt-0.5 text-[18px] font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

export default function ImportLedger() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { allEntities, can } = useAuth();
  const { data: entities } = useListEntities();
  const { data: accounts } = useListAccounts();
  const fileInput = useRef<HTMLInputElement>(null);

  const [entityId, setEntityId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, { accountId?: string; type?: string }>>({});
  const [committed, setCommitted] = useState<{ batchId: number; createdEntries: number; skippedDuplicates: number } | null>(null);

  const previewMutation = usePreviewQuickBooksImport();
  const commitMutation = useCommitQuickBooksImport();
  const postMutation = usePostImportBatch();
  const discardMutation = useDiscardImportBatch();
  const { data: batches } = useImportBatches();

  React.useEffect(() => {
    const first = ((entities || []) as any[])[0];
    if (!entityId && first) setEntityId(String(first.id));
  }, [entities, entityId]);

  const accountOptions = useMemo(
    () => ((accounts || []) as any[]).slice().sort((a, b) => String(a.code).localeCompare(String(b.code))),
    [accounts],
  );

  const newAccounts = (preview?.accounts || []).filter((a) => !a.existingAccountId);
  const quarantined = preview?.quarantine || [];
  const importable = (preview?.entries || []).filter((e) => !e.duplicateOf);

  const reset = () => {
    setPreview(null);
    setFile(null);
    setDecisions({});
    setCommitted(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const runPreview = () => {
    if (!file || !entityId) return;
    previewMutation.mutate(
      { file, entityId: Number(entityId) },
      {
        onSuccess: (data) => {
          setPreview(data);
          // Seed each new account with the parser's guess so a clean file is
          // one click, while every value stays visible and editable.
          const seeded: Record<string, { accountId?: string; type?: string }> = {};
          for (const a of data.accounts) {
            if (!a.existingAccountId) seeded[a.name] = { type: a.suggestedType };
          }
          setDecisions(seeded);
        },
        onError: (err: any) => toast({ title: 'Could not read that file', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const runCommit = () => {
    if (!preview) return;
    const payload: ImportAccountDecision[] = preview.accounts.map((a) => {
      const d = decisions[a.name] || {};
      if (d.accountId) return { name: a.name, accountId: Number(d.accountId) };
      if (a.existingAccountId && !d.type) return { name: a.name, accountId: a.existingAccountId };
      return { name: a.name, create: { type: d.type || a.suggestedType, subType: a.suggestedSubType } };
    });
    commitMutation.mutate(
      { batchId: preview.batchId, accounts: payload },
      {
        onSuccess: (data: any) => {
          setCommitted({ batchId: preview.batchId, createdEntries: data.createdEntries, skippedDuplicates: data.skippedDuplicates });
          queryClient.invalidateQueries({ queryKey: ['import-batches'] });
          toast({ title: `${data.createdEntries} draft entr${data.createdEntries === 1 ? 'y' : 'ies'} created`, description: 'Review them, then post the batch.' });
        },
        onError: (err: any) => toast({ title: 'Import failed', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const runPost = () => {
    if (!committed) return;
    if (!confirm('Post this batch to the ledger? Posted entries cannot be edited — only voided.')) return;
    postMutation.mutate(
      { batchId: committed.batchId },
      {
        onSuccess: (data: any) => {
          toast({ title: `Posted ${data.postedEntries} entries`, description: 'They are now part of the book of record.' });
          queryClient.invalidateQueries();
          reset();
        },
        onError: (err: any) => toast({ title: 'Could not post the batch', description: err.message, variant: 'destructive' }),
      },
    );
  };

  const runDiscard = () => {
    const batchId = committed?.batchId ?? preview?.batchId;
    if (!batchId) return;
    discardMutation.mutate(
      { batchId },
      {
        onSuccess: () => { toast({ title: 'Import discarded' }); queryClient.invalidateQueries({ queryKey: ['import-batches'] }); reset(); },
        onError: (err: any) => toast({ title: 'Could not discard', description: err.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Import Ledger"
        description="Bring a QuickBooks “Transaction Detail by Account” export into the books — reviewed first, posted only when you say so"
      />

      <PageContent>
        {/* ---- Step 1: the file ---- */}
        {!preview && (
          <SurfaceCard>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium">Entity</label>
                <Select value={entityId} onValueChange={setEntityId}>
                  <SelectTrigger><SelectValue placeholder="Choose entity" /></SelectTrigger>
                  <SelectContent>
                    {((entities || []) as any[]).map((e) => (
                      <SelectItem key={e.id} value={String(e.id)}>{entityLabel(e.name)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium">QuickBooks export (.csv)</label>
                <Input ref={fileInput} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button onClick={runPreview} disabled={!file || !entityId || previewMutation.isPending}>
                <FileUp className="mr-2 size-4" />
                {previewMutation.isPending ? 'Reading…' : 'Read file'}
              </Button>
              <span className="text-[11px] text-gray-400">
                Nothing is written yet — the next screen shows exactly what would be created.
              </span>
            </div>
          </SurfaceCard>
        )}

        {previewMutation.isPending && <SurfaceCard><Skeleton className="h-24 w-full" /></SurfaceCard>}

        {/* ---- Step 2: what was found ---- */}
        {preview && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-import-summary>
              <Stat label="Transactions" value={preview.entries.length} />
              <Stat label="New accounts" value={preview.newAccountCount} tone={preview.newAccountCount ? 'warn' : undefined} />
              <Stat label="Already imported" value={preview.duplicateCount} tone={preview.duplicateCount ? 'warn' : undefined} />
              <Stat label="Quarantined" value={quarantined.length} tone={quarantined.length ? 'bad' : 'good'} />
            </div>

            <div className="text-[11px] text-gray-400">
              {preview.filename} · {preview.rowCount} transaction rows read, {preview.skippedRows} skipped (totals, balances, blanks)
            </div>

            {/* Quarantine first: it is the thing that blocks posting. */}
            {quarantined.length > 0 && (
              <SurfaceCard padded={false}>
                <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-5 py-3 text-[13px] font-semibold text-amber-900">
                  <AlertTriangle className="size-4" />
                  {quarantined.length} transaction(s) could not be read as balanced entries
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Date</TableHead>
                        <TableHead>Num</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Accounts</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Why</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {quarantined.map((q, i) => (
                        <TableRow key={i} data-quarantine-row>
                          <TableCell className="font-mono text-xs">{q.date}</TableCell>
                          <TableCell className="font-mono text-xs">{q.num || '—'}</TableCell>
                          <TableCell className="text-[13px]">{q.name || '—'}</TableCell>
                          <TableCell className="text-[12px] text-gray-500">{q.accounts.join(', ')}</TableCell>
                          <TableCell className="text-right font-mono text-[13px]">{money(q.amount)}</TableCell>
                          <TableCell className="text-[11px] text-gray-500">
                            <div className="font-medium text-amber-800">{q.reason}</div>
                            {q.detail}
                            <div className="mt-0.5 text-gray-400">source line{q.sourceLines.length > 1 ? 's' : ''} {q.sourceLines.join(', ')}</div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </SurfaceCard>
            )}

            {/* Account confirmation — the step that must never be automatic. */}
            {!committed && (
              <SurfaceCard padded={false}>
                <div className="border-b border-gray-100 px-5 py-3.5">
                  <div className="text-[14px] font-semibold text-gray-900">Accounts in this file</div>
                  <div className="mt-0.5 text-[11px] text-gray-400">
                    Account type decides the sign of every report, so the guesses below are confirmed by you, not applied automatically.
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[32%]">Name in file</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-[28%]">Map to existing head</TableHead>
                        <TableHead className="w-[20%]">…or create as</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.accounts.map((a) => {
                        const d = decisions[a.name] || {};
                        return (
                          <TableRow key={a.name} data-account-row={a.name}>
                            <TableCell className="text-[13px] text-gray-900">{a.name}</TableCell>
                            <TableCell className="text-[12px]">
                              {a.existingAccountId && !d.accountId ? (
                                <span className="text-emerald-700">Matched {a.existingCode} ({a.existingType})</span>
                              ) : d.accountId ? (
                                <span className="text-emerald-700">Mapped</span>
                              ) : (
                                <span className={a.confidence === 'high' ? 'text-gray-500' : 'text-amber-700'}>
                                  New {a.confidence === 'low' && '· weak guess, please check'}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Select
                                value={d.accountId || (a.existingAccountId ? String(a.existingAccountId) : '__new')}
                                onValueChange={(v) => setDecisions((p) => ({ ...p, [a.name]: v === '__new' ? { type: a.suggestedType } : { accountId: v } }))}
                              >
                                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__new">— create a new account —</SelectItem>
                                  {accountOptions.map((acc) => (
                                    <SelectItem key={acc.id} value={String(acc.id)}>{acc.code} · {acc.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              {d.accountId ? (
                                <span className="text-[11px] text-gray-300">—</span>
                              ) : (
                                <Select
                                  value={d.type || a.suggestedType}
                                  onValueChange={(v) => setDecisions((p) => ({ ...p, [a.name]: { type: v } }))}
                                >
                                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {ACCOUNT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </SurfaceCard>
            )}

            {/* The transactions themselves. */}
            <SurfaceCard padded={false}>
              <div className="border-b border-gray-100 px-5 py-3.5 text-[14px] font-semibold text-gray-900">
                Transactions to import ({importable.length}{preview.duplicateCount ? `, ${preview.duplicateCount} skipped as already imported` : ''})
              </div>
              <div className="max-h-[420px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Num</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Lines</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.entries.map((e) => (
                      <TableRow key={e.importRowHash} className={e.duplicateOf ? 'opacity-50' : ''} data-entry-row>
                        <TableCell className="font-mono text-xs">{e.date}</TableCell>
                        <TableCell className="text-[12px]">{e.transactionType || '—'}</TableCell>
                        <TableCell className="font-mono text-xs">{e.num || '—'}</TableCell>
                        <TableCell className="text-[13px]">{e.name || '—'}</TableCell>
                        <TableCell className="text-[11px] text-gray-500">
                          {e.lines.map((l) => `${l.account} ${l.amount > 0 ? 'Dr' : 'Cr'} ${money(Math.abs(l.amount))}`).join(' · ')}
                          {e.synthesized && <span className="ml-1 text-amber-700" title="One side was rebuilt from the Split column">· rebuilt from Split</span>}
                          {e.duplicateOf && <span className="ml-1 text-gray-400">· already imported as {e.duplicateOf.entryNumber}</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[13px]">{money(e.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SurfaceCard>

            {/* ---- Steps 3 and 4 ---- */}
            <SurfaceCard>
              {!committed ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={runCommit} disabled={commitMutation.isPending || importable.length === 0}>
                    <Upload className="mr-2 size-4" />
                    {commitMutation.isPending ? 'Importing…' : `Import ${importable.length} as Draft`}
                  </Button>
                  <Button variant="outline" onClick={reset}>Start over</Button>
                  <span className="text-[11px] text-gray-400">Draft entries are editable and are not part of any report until posted.</span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-[13px] text-emerald-800">
                    <CheckCircle2 className="size-4" />
                    {committed.createdEntries} draft entr{committed.createdEntries === 1 ? 'y' : 'ies'} created
                    {committed.skippedDuplicates > 0 && ` · ${committed.skippedDuplicates} skipped as already imported`}
                  </div>
                  {quarantined.length > 0 && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      Posting is blocked while {quarantined.length} transaction(s) are quarantined. Fix the export and re-import, or
                      enter those by hand — the drafts stay here until then.
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={runPost} disabled={postMutation.isPending || quarantined.length > 0 || !can('post')}>
                      {postMutation.isPending ? 'Posting…' : 'Post batch to ledger'}
                    </Button>
                    <Button variant="outline" onClick={runDiscard} disabled={discardMutation.isPending}>Discard drafts</Button>
                  </div>
                </div>
              )}
            </SurfaceCard>
          </>
        )}

        {/* ---- History ---- */}
        {!preview && (batches || []).length > 0 && (
          <SurfaceCard padded={false}>
            <div className="border-b border-gray-100 px-5 py-3.5 text-[14px] font-semibold text-gray-900">Previous imports</div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>File</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">Entries</TableHead>
                    <TableHead className="text-right">Quarantined</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(batches || []).map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="text-[13px]">{b.filename || '—'}</TableCell>
                      <TableCell className="text-[12px] text-gray-500">
                        {entityLabel(((entities || []) as any[]).find((e) => e.id === b.entityId)?.name || String(b.entityId))}
                      </TableCell>
                      <TableCell className="text-[12px]">{b.status}</TableCell>
                      <TableCell className="text-right font-mono text-[12px]">{b.rowCount}</TableCell>
                      <TableCell className="text-right font-mono text-[12px]">{b.entryCount}</TableCell>
                      <TableCell className={`text-right font-mono text-[12px] ${b.quarantineCount ? 'text-amber-700' : ''}`}>{b.quarantineCount}</TableCell>
                      <TableCell className="text-[12px] text-gray-500">{b.createdAt}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SurfaceCard>
        )}
      </PageContent>
    </>
  );
}
