// A journal line carries its own memo; the entry carries the header memo
// (journal_entries.description — the Journal Entry screen's Description).
// Audit trails show both, unless one already repeats the other, which is
// what bank postings do when they copy the statement text into the memo.
export function showEntryMemo(lineMemo?: string, entryDescription?: string): boolean {
  const memo = (lineMemo || '').trim();
  const header = (entryDescription || '').trim();
  if (!memo || !header) return false;
  return !memo.includes(header) && !header.includes(memo);
}
