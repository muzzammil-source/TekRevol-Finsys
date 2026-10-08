// Client-side mirror of the header auto-detection in server/index.ts
// (detectColumnMapping / parseStatementFile). Bank CSV exports use wildly
// inconsistent header names, so the upload modal tries to guess the mapping
// from the header row before falling back to asking the user. Matching is
// whole word/phrase, not substring — a naive substring check on short
// aliases like "in"/"out"/"dr"/"cr" would false-match inside unrelated words
// (e.g. "Interest" contains "in").
export type ColumnMapping = {
  dateColumn: string;
  descriptionColumn: string;
  amountColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
  hasHeaderRow?: boolean;
};

const DATE_COLUMN_ALIASES = ['date', 'txn date', 'transaction date', 'posting date'];
const DESCRIPTION_COLUMN_ALIASES = ['description', 'narrative', 'particulars', 'memo', 'payee', 'details'];
const AMOUNT_COLUMN_ALIASES = ['amount', 'net amount', 'val'];
const DEBIT_COLUMN_ALIASES = ['debit', 'withdrawal', 'dr', 'out'];
const CREDIT_COLUMN_ALIASES = ['credit', 'deposit', 'cr', 'in'];

function tokenizeHeader(h: string): string[] {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function headerMatchesAlias(headerTokens: string[], alias: string): boolean {
  const aliasTokens = tokenizeHeader(alias);
  if (aliasTokens.length === 0) return false;
  for (let i = 0; i <= headerTokens.length - aliasTokens.length; i++) {
    if (aliasTokens.every((t, j) => headerTokens[i + j] === t)) return true;
  }
  return false;
}

function findColumnByAliases(headers: string[], aliases: string[]): string | undefined {
  return headers.find((h) => {
    const tokens = tokenizeHeader(h);
    return aliases.some((a) => headerMatchesAlias(tokens, a));
  });
}

// Returns null when the header row doesn't contain enough to build a usable
// mapping — the caller falls back to manual column-mapping dropdowns.
export function detectColumnMapping(headerRow: string[]): ColumnMapping | null {
  const dateColumn = findColumnByAliases(headerRow, DATE_COLUMN_ALIASES);
  const descriptionColumn = findColumnByAliases(headerRow, DESCRIPTION_COLUMN_ALIASES);
  if (!dateColumn || !descriptionColumn) return null;

  const amountColumn = findColumnByAliases(headerRow, AMOUNT_COLUMN_ALIASES);
  const debitColumn = findColumnByAliases(headerRow, DEBIT_COLUMN_ALIASES);
  const creditColumn = findColumnByAliases(headerRow, CREDIT_COLUMN_ALIASES);
  if (!amountColumn && !debitColumn && !creditColumn) return null;

  return { dateColumn, descriptionColumn, amountColumn, debitColumn, creditColumn, hasHeaderRow: true };
}

// Naive CSV header-line split — good enough for a header row (quoted commas
// in a header are rare) and consistent with the modal's existing line-preview
// parsing. The real import is still parsed server-side with the full
// RFC4180-ish tokenizer.
export function parseCsvHeaderLine(firstLine: string): string[] {
  return firstLine.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}
