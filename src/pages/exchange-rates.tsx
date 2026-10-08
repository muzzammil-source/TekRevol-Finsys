import React, { useState } from 'react';
import { useListExchangeRates, useUpsertExchangeRate, useDeleteExchangeRate, getListExchangeRatesQueryKey } from '@workspace/api-client-react';
import { PageContent, PageHeader } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { PlusCircle, Pencil, Trash2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { CURRENCIES, MONTH_NAMES } from '@/lib/constants';

// Month-based Exchange Rate system (2026-09-11): storage is still a single
// `effectiveMonth` string ("YYYY-MM") on the backend — that's already the
// full Currency+Year+Month+Rate shape the task asks for (UNIQUE(currency,
// effectiveMonth) already prevents two rates for the same currency/month),
// so no schema change was needed. What changed is the UI: Year and Month
// are now two explicit fields/columns instead of one native <input
// type="month"> picker, matching the literal "Currency: AED, Year: 2026,
// Month: September, Rate: 3.67" shape from the task.
const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - 2 + i);

function splitEffectiveMonth(effectiveMonth: string): { year: number; monthIndex: number } {
  const [y, m] = effectiveMonth.split('-');
  return { year: Number(y), monthIndex: Math.max(0, Number(m) - 1) };
}

function joinEffectiveMonth(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

const formSchema = z.object({
  currency: z.string().min(1, "Required"),
  year: z.coerce.number().min(2000, "Required"),
  monthIndex: z.coerce.number().min(0).max(11),
  rateToUsd: z.coerce.number().min(0, "Required"),
  notes: z.string().optional(),
});

function ExchangeRateFormModal({ open, onOpenChange, entryToEdit }: { open: boolean, onOpenChange: (open: boolean) => void, entryToEdit?: any }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const upsertRate = useUpsertExchangeRate();

  const isEdit = !!entryToEdit;
  const initial = isEdit ? splitEffectiveMonth(entryToEdit.effectiveMonth) : { year: CURRENT_YEAR, monthIndex: new Date().getMonth() };

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: isEdit ? {
      currency: entryToEdit.currency,
      year: initial.year,
      monthIndex: initial.monthIndex,
      rateToUsd: entryToEdit.rateToUsd,
      notes: entryToEdit.notes || '',
    } : {
      currency: 'PKR',
      year: initial.year,
      monthIndex: initial.monthIndex,
      rateToUsd: 1,
      notes: '',
    }
  });

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    const { year, monthIndex, ...rest } = values;
    upsertRate.mutate({ data: { ...rest, effectiveMonth: joinEffectiveMonth(year, monthIndex) } }, {
      onSuccess: () => {
        toast({ title: 'Exchange rate saved' });
        queryClient.invalidateQueries({ queryKey: getListExchangeRatesQueryKey() });
        // Bank cards and every report translate through these rates, so a
        // rate change has to invalidate them too or the app keeps showing
        // conversions at the old rate until a reload.
        queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
        queryClient.invalidateQueries({ queryKey: ['account-balances'] });
        queryClient.invalidateQueries({ queryKey: ['income-statement'] });
        queryClient.invalidateQueries({ queryKey: ['balance-sheet'] });
        queryClient.invalidateQueries({ queryKey: ['cash-flow'] });
        onOpenChange(false);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Rate' : 'Set Exchange Rate'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="currency" render={({ field }) => (
              <FormItem>
                <FormLabel>Currency</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value} disabled={isEdit}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>{CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="year" render={({ field }) => (
                <FormItem>
                  <FormLabel>Year</FormLabel>
                  <Select onValueChange={(v) => field.onChange(Number(v))} defaultValue={String(field.value)} disabled={isEdit}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>{YEAR_OPTIONS.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="monthIndex" render={({ field }) => (
                <FormItem>
                  <FormLabel>Month</FormLabel>
                  <Select onValueChange={(v) => field.onChange(Number(v))} defaultValue={String(field.value)} disabled={isEdit}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>{MONTH_NAMES.map((m, i) => <SelectItem key={m} value={String(i)}>{m}</SelectItem>)}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <FormField control={form.control} name="rateToUsd" render={({ field }) => (
              <FormItem><FormLabel>Rate (1 Local = X USD)</FormLabel><FormControl><Input type="number" step="0.000001" {...field} /></FormControl><FormMessage /></FormItem>
            )} />

            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem><FormLabel>Notes (Optional)</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={upsertRate.isPending}>
                Save Rate
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function ExchangeRates() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [entryToEdit, setEntryToEdit] = useState<any>(null);

  // Exchange Rate sheet (2026-09-11): the Month/Year filter dropdowns were
  // removed per an earlier task — this is a global rate table, always
  // showing every record continuously, not a view scoped to a selected
  // period.
  const { data: rates, isLoading } = useListExchangeRates({}, { query: { queryKey: ['exchange-rates'] } }) as { data: any[] | undefined; isLoading: boolean };
  const deleteRate = useDeleteExchangeRate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleEdit = (entry: any) => {
    setEntryToEdit(entry);
    setIsModalOpen(true);
  };

  const handleCreate = () => {
    setEntryToEdit(null);
    setIsModalOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this exchange rate?")) {
      deleteRate.mutate({ id }, {
        onSuccess: () => {
          toast({ title: 'Rate deleted' });
          queryClient.invalidateQueries({ queryKey: getListExchangeRatesQueryKey() });
        // Bank cards and every report translate through these rates, so a
        // rate change has to invalidate them too or the app keeps showing
        // conversions at the old rate until a reload.
        queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
        queryClient.invalidateQueries({ queryKey: ['account-balances'] });
        queryClient.invalidateQueries({ queryKey: ['income-statement'] });
        queryClient.invalidateQueries({ queryKey: ['balance-sheet'] });
        queryClient.invalidateQueries({ queryKey: ['cash-flow'] });
        }
      });
    }
  };

  const sortedRates = React.useMemo(() => {
    return [...((rates || []) as any[])].sort((a, b) => b.effectiveMonth.localeCompare(a.effectiveMonth) || a.currency.localeCompare(b.currency));
  }, [rates]);

  return (
    <>
      <PageHeader title="Exchange Rates" description="Monthly conversion rates to USD, by currency, year and month">
        <Button onClick={handleCreate} size="sm"><PlusCircle className="mr-2 size-4" /> Set Rate</Button>
      </PageHeader>
      <PageContent>
        <div className="border border-gray-100 rounded-2xl bg-white shadow-sm overflow-hidden max-w-4xl">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="font-mono text-xs font-semibold w-24">Year</TableHead>
                <TableHead className="font-mono text-xs font-semibold w-32">Month</TableHead>
                <TableHead className="font-mono text-xs font-semibold w-24">Currency</TableHead>
                <TableHead className="font-mono text-xs font-semibold text-right">Rate to USD</TableHead>
                <TableHead className="font-mono text-xs font-semibold">Notes</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))
              ) : sortedRates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground font-mono text-sm">No exchange rates found</TableCell>
                </TableRow>
              ) : (
                sortedRates.map((row) => {
                  const { year, monthIndex } = splitEffectiveMonth(row.effectiveMonth);
                  return (
                    <TableRow key={row.id} className="group">
                      <TableCell className="font-mono text-xs">{year}</TableCell>
                      <TableCell className="text-sm">{MONTH_NAMES[monthIndex]}</TableCell>
                      <TableCell className="font-semibold text-sm">{row.currency}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.rateToUsd}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.notes}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button variant="ghost" size="icon" className="size-6 h-6 w-6" onClick={() => handleEdit(row)}>
                            <Pencil className="size-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-6 h-6 w-6 text-destructive hover:text-destructive" onClick={() => handleDelete(row.id)}>
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </PageContent>

      {isModalOpen && (
        <ExchangeRateFormModal
          open={isModalOpen}
          onOpenChange={setIsModalOpen}
          entryToEdit={entryToEdit}
        />
      )}
    </>
  );
}
