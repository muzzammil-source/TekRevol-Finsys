// Natural (normal-side) balance presentation — 2026-09-16.
//
// The ledger stores and the API returns every balance as DEBIT − CREDIT
// (computeGlAccountBalance, /api/accounts/balances, the GL report). That is
// the right storage convention, but shown raw it prints every healthy
// Revenue, Liability and Equity balance as a negative ("-$3,365.00").
//
// Presentation rule, as in any statutory ledger:
//   Asset / Expense               (debit-normal)  → shown as DEBIT − CREDIT
//   Liability / Equity / Revenue  (credit-normal) → shown as CREDIT − DEBIT
//
// This is deliberately a sign flip by normal side, NOT Math.abs: a minus
// sign must survive for a genuinely abnormal position — an overdrawn bank
// (credit balance on an Asset), a revenue account in debit after refunds, a
// contra account — because hiding that would misstate the books.

const CREDIT_NORMAL_TYPES = new Set(['liability', 'equity', 'revenue', 'income']);

export function isCreditNormal(accountType: string | null | undefined): boolean {
  return CREDIT_NORMAL_TYPES.has(String(accountType || '').trim().toLowerCase());
}

/** Converts a raw debit−credit figure into the account's natural balance. */
export function naturalBalance(accountType: string | null | undefined, debitMinusCredit: number): number {
  const value = isCreditNormal(accountType) ? -debitMinusCredit : debitMinusCredit;
  // Avoid rendering "-$0.00" for a zero credit-normal balance.
  return Object.is(value, -0) || Math.abs(value) < 0.005 ? 0 : value;
}
