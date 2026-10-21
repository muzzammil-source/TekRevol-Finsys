import React from 'react';
import { Undo2 } from 'lucide-react';
import { useReverseJournalEntry } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth';

// Reversing a posted entry (2026-10-21). Shared by the General Ledger
// report and the Chart of Accounts register so both describe the same
// operation in the same words.
//
// Deliberately NOT a delete. A posted entry is the book of record, so the
// correction is a mirror entry posted alongside it — both halves stay
// visible and the net effect on every balance is zero. The server refuses
// the cases where that would be the wrong tool (bank-feed postings, bills
// and invoices, an entry already reversed) and says which action to use
// instead; that message is surfaced verbatim rather than reworded here,
// because it names the specific screen to go to.
export function ReverseEntryAction({
  journalEntryId,
  entryNumber,
  description,
  transactionType,
  compact = false,
}: {
  journalEntryId: number;
  entryNumber?: string;
  description?: string;
  transactionType?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const { toast } = useToast();
  const { can } = useAuth();
  const reverse = useReverseJournalEntry();

  // Posting is what a reversal does, so the same capability gates it. A
  // Bookkeeper or Auditor sees no button at all rather than one that 403s.
  if (!can('post')) return null;

  const label = entryNumber || `entry ${journalEntryId}`;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={compact ? 'h-6 px-1.5 text-[11px] text-muted-foreground hover:text-rose-700' : 'h-7 px-2 text-xs text-muted-foreground hover:text-rose-700'}
        onClick={() => setOpen(true)}
        disabled={reverse.isPending}
        title={`Reverse ${label}`}
        data-reverse-entry={journalEntryId}
      >
        <Undo2 className="h-3.5 w-3.5" />
        {!compact && <span className="ml-1">Reverse</span>}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse {label}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This posts a <strong>mirror entry</strong> dated today, with every debit and credit
                  swapped. The original stays in the books and both entries remain visible — that is how a
                  posted entry is corrected, so the audit trail is never broken.
                </p>
                <p className="text-muted-foreground">
                  Net effect on every balance, report and statement is zero. Nothing is deleted.
                </p>
                {description && (
                  <p className="rounded border bg-muted/40 px-2 py-1 font-mono text-[11px]">
                    {transactionType ? `${transactionType} · ` : ''}{description}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverse.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={reverse.isPending}
              onClick={(e) => {
                // Kept open until the server answers, so a refusal is read
                // in place instead of the dialog vanishing on a failure.
                e.preventDefault();
                reverse.mutate(
                  { id: journalEntryId },
                  {
                    onSuccess: (res) => {
                      setOpen(false);
                      toast({
                        title: `Reversed ${label}`,
                        description: `Posted ${res.reversalEntryNumber} as its mirror. Both entries stay in the books.`,
                      });
                    },
                    onError: (err: any) =>
                      toast({ title: `Could not reverse ${label}`, description: err.message, variant: 'destructive' }),
                  },
                );
              }}
            >
              {reverse.isPending ? 'Reversing…' : 'Post reversal'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
