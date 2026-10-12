import React, { useState } from 'react';
import { useIntercompanyBalances } from '@workspace/api-client-react';
import { PageContent, PageHeader, SurfaceCard } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { entityLabel } from '@/lib/constants';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';

// Intercompany Balance Ledger (2026-10-12).
//
// Read straight from the counterparty-specific Due From / Due To Affiliates
// heads. Row = the entity whose books are talking, column = who it is
// talking about. A positive cell is owed TO the row entity.
//
// The pair must mirror: A's receivable from B is B's payable to A. Anything
// that doesn't cancel survives consolidation as a phantom asset or
// liability, so a mismatch is shown loudly rather than netted away.

function money(n: number) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export default function ReportsIntercompany() {
  const [asOfDate, setAsOfDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const { data, isLoading } = useIntercompanyBalances({ asOfDate });

  const entities = data?.entities || [];
  const cellFor = (ownerId: number, counterpartyId: number) =>
    data?.cells.find((c) => c.ownerEntityId === ownerId && c.counterpartyEntityId === counterpartyId);
  const rowTotal = (ownerId: number) =>
    (data?.cells || []).filter((c) => c.ownerEntityId === ownerId).reduce((s, c) => s + c.netUSD, 0);

  return (
    <>
      <PageHeader
        title="Intercompany Balance Ledger"
        description="What each entity owes the others, from the Due From / Due To Affiliates heads — stated in USD"
      >
        <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="h-9 w-36" />
      </PageHeader>

      <PageContent>
        {isLoading ? (
          <SurfaceCard><Skeleton className="h-32 w-full" /></SurfaceCard>
        ) : entities.length === 0 || (data?.cells.length ?? 0) === 0 ? (
          <SurfaceCard>
            <div className="py-10 text-center text-[13px] text-gray-400">
              No intercompany positions as of {asOfDate}. These appear once one entity pays for another.
            </div>
          </SurfaceCard>
        ) : (
          <>
            {data && (
              <div
                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                  data.eliminates ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'
                }`}
                data-elimination-status={data.eliminates ? 'ok' : 'mismatch'}
              >
                {data.eliminates ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
                <div>
                  {data.eliminates ? (
                    <>Every position mirrors its counterpart — the group eliminates to {money(data.groupNetUSD)} on consolidation.</>
                  ) : (
                    <>
                      <div className="font-medium">These balances don't cancel: {money(data.groupNetUSD)} would survive consolidation.</div>
                      {data.mismatches.map((m) => (
                        <div key={`${m.entityAId}-${m.entityBId}`} className="mt-0.5">
                          {entityLabel(m.entityAName)} says {money(m.aSaysUSD)}, {entityLabel(m.entityBName)} says {money(m.bSaysUSD)} — out by {money(m.differenceUSD)}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}

            <SurfaceCard padded={false}>
              <div className="border-b border-gray-100 px-5 py-3.5">
                <div className="text-[14px] font-semibold text-gray-900">Owner × Counterparty</div>
                <div className="mt-0.5 text-[11px] text-gray-400">
                  Positive = the row entity is owed by the column entity. Negative = the row entity owes it.
                </div>
              </div>
              <div className="overflow-x-auto">
                <Table data-intercompany-matrix>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-48">Entity</TableHead>
                      {entities.map((e) => (
                        <TableHead key={e.id} className="text-right">{entityLabel(e.name)}</TableHead>
                      ))}
                      <TableHead className="text-right">Net Position</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entities.map((owner) => (
                      <TableRow key={owner.id} className="hover:bg-gray-50/60">
                        <TableCell className="text-[13px] font-medium text-gray-900">{entityLabel(owner.name)}</TableCell>
                        {entities.map((counterparty) => {
                          if (owner.id === counterparty.id) {
                            return <TableCell key={counterparty.id} className="bg-gray-50/60 text-center text-gray-300">·</TableCell>;
                          }
                          const cell = cellFor(owner.id, counterparty.id);
                          if (!cell) {
                            return <TableCell key={counterparty.id} className="text-right text-gray-300">—</TableCell>;
                          }
                          return (
                            <TableCell
                              key={counterparty.id}
                              className={`text-right font-mono text-[13px] tabular-nums ${cell.netUSD < 0 ? 'text-rose-700' : 'text-gray-900'}`}
                              title={cell.accounts.map((a) => `${a.code} ${a.name}: ${money(a.balanceUSD)}`).join('\n')}
                              data-cell={`${owner.id}:${counterparty.id}`}
                            >
                              {money(cell.netUSD)}
                              {!cell.reciprocal && (
                                <span className="ml-1 text-[10px] text-amber-700" title={`The other side's books say ${money(cell.mirrorNetUSD)}`}>⚠</span>
                              )}
                            </TableCell>
                          );
                        })}
                        <TableCell className={`text-right font-mono text-[13px] font-semibold tabular-nums ${rowTotal(owner.id) < 0 ? 'text-rose-700' : 'text-gray-900'}`}>
                          {money(rowTotal(owner.id))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SurfaceCard>

            <SurfaceCard padded={false}>
              <div className="border-b border-gray-100 px-5 py-3.5 text-[14px] font-semibold text-gray-900">Positions in detail</div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Entity</TableHead>
                      <TableHead>Counterparty</TableHead>
                      <TableHead>Clearing account</TableHead>
                      <TableHead className="text-right">Receivable</TableHead>
                      <TableHead className="text-right">Payable</TableHead>
                      <TableHead className="text-right">Counterparty says</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.cells.map((c) => (
                      <TableRow key={`${c.ownerEntityId}-${c.counterpartyEntityId}`} className="hover:bg-gray-50/60">
                        <TableCell className="text-[13px] text-gray-900">{entityLabel(c.ownerName)}</TableCell>
                        <TableCell className="text-[13px] text-gray-700">{entityLabel(c.counterpartyName)}</TableCell>
                        <TableCell className="text-[12px] text-gray-500">
                          {c.accounts.map((a) => `${a.code} ${a.name}`).join(', ') || '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[13px] tabular-nums">{c.receivableUSD ? money(c.receivableUSD) : <span className="text-gray-300">—</span>}</TableCell>
                        <TableCell className="text-right font-mono text-[13px] tabular-nums">{c.payableUSD ? money(c.payableUSD) : <span className="text-gray-300">—</span>}</TableCell>
                        <TableCell className={`text-right font-mono text-[13px] tabular-nums ${c.reciprocal ? 'text-gray-500' : 'text-amber-700 font-medium'}`}>
                          {money(c.mirrorNetUSD)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SurfaceCard>
          </>
        )}
      </PageContent>
    </>
  );
}
