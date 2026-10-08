export const ENTITIES = ['CA', 'TX', 'UAE', 'PK', 'BuzzFlick'];
export const CURRENCIES = ['USD', 'PKR', 'AED', 'GBP', 'EUR'];
// The 5 fundamental accounting categories the GL posting engine and every
// report understands. A handful of pre-GL rows still carry the legacy
// lowercase 'expense'/'revenue' values (a known casing wart, see
// .claude/PHASE_TRACKER.md) — the Chart of Accounts UI only ever writes
// these Title-Case values going forward.
export const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

// Suggested sub-types per account type, shown as a datalist in the Chart of
// Accounts form — free-text underneath (accounts.subType has no CHECK
// constraint), so a user can type a new one without a schema change.
export const ACCOUNT_SUBTYPES: Record<string, string[]> = {
  Asset: ['Bank', 'Current Assets', 'Fixed Assets', 'Receivables', 'Intercompany Clearing'],
  Liability: ['Accounts Payable', 'Accrued Liabilities', 'Intercompany Clearing'],
  Equity: ['Equity'],
  Revenue: ['Operating Revenue', 'Other Revenue'],
  Expense: ['COGS', 'Operating Expense', 'Intercompany Clearing'],
};

// Display labels for each entity code (internal codes stay stable for backward compatibility
// with existing data; only the labels shown to users changed per the entity rename request).
export const ENTITY_LABELS: Record<string, string> = {
  CA: 'TekRevol CA',
  TX: 'TekRevol TX',
  UAE: 'TekRevol AE',
  PK: 'TekRevol PK',
  BuzzFlick: 'BuzzFlick',
};
export function entityLabel(code: string): string {
  return ENTITY_LABELS[code] || code;
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
