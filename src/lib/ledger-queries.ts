import type { QueryClient } from '@tanstack/react-query';
import { getListBankTransactionsQueryKey, getUnpostedBankTransactionsQueryKey } from '@workspace/api-client-react';

// Anything that writes to the General Ledger (posting or unposting a bank
// transaction, a manual journal entry) has to refetch every ledger-DERIVED
// view — reports, balances, sub-ledgers. Without these keys a screen keeps
// showing its pre-posting figures until a full reload, which reads exactly
// like "posting didn't do anything".
export function invalidateLedgerDerivedQueries(queryClient: QueryClient) {
  for (const key of [
    getUnpostedBankTransactionsQueryKey(),
    getListBankTransactionsQueryKey(),
    ['bank-accounts'],          // card balances are the account's posted GL balance
    ['general-ledger'],
    ['trial-balance'],
    ['income-statement'],
    ['balance-sheet'],
    ['cash-flow'],
    ['account-balances'],
    ['account-register'],
    ['journal-entries'],
    ['executive'],
    ['contacts'],               // customer/vendor sub-ledger balances are derived from posted lines
  ]) {
    queryClient.invalidateQueries({ queryKey: key as any });
  }
}
