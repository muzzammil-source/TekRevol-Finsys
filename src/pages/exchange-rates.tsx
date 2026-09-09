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
import { MonthFilter } from '@/components/month-filter';
import { CURRENCIES } from '@/lib/constants';
import { format } from 'date-fns';

const formSchema = z.object({
  currency: z.string().min(1, "Required"),
  rateToUsd: z.coerce.number().min(0, "Required"),
  effectiveMonth: z.string().min(1, "Required"),
  notes: z.string().optional(),
});

function ExchangeRateFormModal({ open, onOpenChange, entryToEdit, monthContext }: { open: boolean, onOpenChange: (open: boolean) => void, entryToEdit?: any, monthContext?: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const upsertRate = useUpsertExchangeRate();

  const isEdit = !!entryToEdit;

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: isEdit ? {
      ...entryToEdit,
      notes: entryToEdit.notes || '',
    } : {
      currency: 'PKR',
      rateToUsd: 1,
      effectiveMonth: monthContext || format(new Date(), 'yyyy-MM'),
      notes: '',
    }
  });

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    upsertRate.mutate({ data: values }, {
      onSuccess: () => {
        toast({ title: 'Exchange rate saved' });
        queryClient.invalidateQueries({ queryKey: getListExchangeRatesQueryKey() });
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
            <div className="grid grid-cols-2 gap-4">
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
              <FormField control={form.control} name="effectiveMonth" render={({ field }) => (
                <FormItem><FormLabel>Effective Month</FormLabel><FormControl><Input type="month" {...field} disabled={isEdit} /></FormControl><FormMessage /></FormItem>
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
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [entryToEdit, setEntryToEdit] = useState<any>(null);

  const { data: rates, isLoading } = useListExchangeRates({ month }, { query: { queryKey: ['exchange-rates', month] } }) as { data: any[] | undefined; isLoading: boolean };
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
        }
      });
    }
  };

  return (
    <>
      <PageHeader title="Exchange Rates" description="Manage monthly conversion rates to USD">
        <MonthFilter value={month} onChange={setMonth} />
        <Button onClick={handleCreate} size="sm"><PlusCircle className="mr-2 size-4" /> Set Rate</Button>
      </PageHeader>
      <PageContent>
        <div className="border rounded-sm bg-card overflow-hidden max-w-4xl">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
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
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))
              ) : rates?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground font-mono text-sm">No exchange rates found</TableCell>
                </TableRow>
              ) : (
                rates?.map((row) => (
                  <TableRow key={row.id} className="group">
                    <TableCell className="font-mono text-xs">{row.effectiveMonth}</TableCell>
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
                ))
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
          monthContext={month}
        />
      )}
    </>
  );
}
