import type { ContactLedger } from '@workspace/api-client-react';
import { format } from 'date-fns';

// Statement of Account export — Excel (SheetJS) and PDF (jsPDF) — 2026-09-17.
//
// Every figure comes straight from GET /api/contacts/:id/ledger (Posted
// journal lines tagged with the contact); nothing is recomputed here except
// laying the rows out. Balance semantics match the on-screen statement:
//   - Customer balance = Receivables Dr − Cr (what they owe us)
//   - Vendor   balance = Payables    Cr − Dr (what we owe them)
//   - Lines on other accounts (e.g. an expense paid straight from the bank)
//     are listed as activity but don't move the balance; they're marked.
// Amounts are USD at each line's own stamped rate.

type Row = {
  date: string;
  entryNumber: string;
  entity: string;
  description: string;
  account: string;
  debit: number | null;
  credit: number | null;
  balance: number;
  note: string;
};

export type StatementForExport = {
  name: string;
  contactType: string;
  entityName: string;
  email: string;
  projectName: string;
  generatedAt: string;
  openingBalance: { amount: number; currency: string; date: string; usd: number } | null;
  rows: Row[];
  closingBalanceUSD: number;
  balanceLabel: string;
};

const round2 = (n: number) => Math.round((n || 0) * 100) / 100;

export function toStatement(ledger: ContactLedger, entityName: string): StatementForExport {
  const c = ledger.contact;
  const rows: Row[] = ledger.lines.map((l) => ({
    date: l.transactionDate,
    entryNumber: l.entryNumber,
    entity: l.entityName || '',
    description: l.description || '',
    account: `${l.accountCode} ${l.accountName}`,
    debit: l.debitUSD ? round2(l.debitUSD) : null,
    credit: l.creditUSD ? round2(l.creditUSD) : null,
    balance: round2(l.runningBalanceUSD),
    note: l.journalEntryId === c.openingBalanceEntryId ? 'Opening balance' : l.onArAp ? 'Open A/R–A/P' : '',
  }));
  const openingLine = ledger.lines.find((l) => l.journalEntryId === c.openingBalanceEntryId);
  return {
    name: c.name,
    contactType: c.contactType,
    entityName,
    email: c.email || '',
    projectName: c.contactType === 'Customer' ? c.projectName || '' : '',
    generatedAt: format(new Date(), 'yyyy-MM-dd HH:mm'),
    openingBalance: c.openingBalanceEntryId && openingLine
      ? { amount: Number(c.openingBalance || 0), currency: c.openingBalanceCurrency || 'USD', date: c.openingBalanceDate || '', usd: round2(openingLine.runningBalanceUSD) }
      : null,
    rows,
    closingBalanceUSD: round2(c.outstandingUSD),
    balanceLabel: c.contactType === 'Vendor' ? 'We owe (Accounts Payable)' : 'Owes us (Accounts Receivable)',
  };
}

const money = (n: number | null) =>
  n === null ? '' : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const safeFileName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'ledger';

// Excel sheet names: ≤ 31 chars, no []:*?/\ , unique.
function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Contact';
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base.slice(0, 25)} (${i++})`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function exportStatementsExcel(statements: StatementForExport[], fileBase: string) {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();
  const used = new Set<string>();

  if (statements.length > 1) {
    const summary = utils.aoa_to_sheet([
      ['Contact ledgers — summary'],
      [`Generated ${format(new Date(), 'yyyy-MM-dd HH:mm')} · amounts in USD`],
      [],
      ['Name', 'Contact Type', 'Assigned Entity', 'Opening Balance (USD)', 'Current Balance (USD)', 'Posted lines'],
      ...statements.map((s) => [s.name, s.contactType, s.entityName, s.openingBalance ? s.openingBalance.usd : 0, s.closingBalanceUSD, s.rows.length]),
    ]);
    summary['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 20 }, { wch: 22 }, { wch: 22 }, { wch: 12 }];
    utils.book_append_sheet(wb, summary, sheetName('Summary', used));
  }

  for (const s of statements) {
    const aoa: (string | number | null)[][] = [
      [`Statement of Account — ${s.name}`],
      [`${s.contactType} · ${s.entityName}${s.projectName ? ` · Project: ${s.projectName}` : ''}${s.email ? ` · ${s.email}` : ''}`],
      [`Generated ${s.generatedAt} · amounts in USD`],
      [],
      ['Opening Balance', s.openingBalance ? `${money(s.openingBalance.amount)} ${s.openingBalance.currency} as of ${s.openingBalance.date}` : 'None', s.openingBalance ? s.openingBalance.usd : 0],
      [],
      ['Date', 'Entry #', 'Entity', 'Description', 'Account', 'Debit (USD)', 'Credit (USD)', 'Balance (USD)', 'Note'],
      ...s.rows.map((r) => [r.date, r.entryNumber, r.entity, r.description, r.account, r.debit, r.credit, r.balance, r.note]),
      [],
      ['Closing Balance', s.balanceLabel, null, null, null, null, null, s.closingBalanceUSD, ''],
    ];
    const ws = utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 48 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 28 }];
    utils.book_append_sheet(wb, ws, sheetName(s.name, used));
  }

  writeFile(wb, `${safeFileName(fileBase)}-${format(new Date(), 'yyyy-MM-dd')}.xlsx`);
}

export async function exportStatementsPdf(statements: StatementForExport[], fileBase: string) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = (autoTableModule as any).default ?? (autoTableModule as any).autoTable;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 36;

  if (statements.length > 1) {
    doc.setFontSize(15);
    doc.text('Contact ledgers — summary', margin, 44);
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(`Generated ${format(new Date(), 'yyyy-MM-dd HH:mm')} · amounts in USD`, margin, 60);
    doc.setTextColor(0);
    autoTable(doc, {
      startY: 74,
      margin: { left: margin, right: margin },
      head: [['Name', 'Contact Type', 'Assigned Entity', 'Opening Balance (USD)', 'Current Balance (USD)', 'Posted lines']],
      body: statements.map((s) => [s.name, s.contactType, s.entityName, money(s.openingBalance ? s.openingBalance.usd : 0), money(s.closingBalanceUSD), String(s.rows.length)]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [17, 24, 39] },
      columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    });
  }

  statements.forEach((s, idx) => {
    if (statements.length > 1 || idx > 0) doc.addPage();
    doc.setFontSize(15);
    doc.text(`Statement of Account — ${s.name}`, margin, 44);
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(`${s.contactType} · ${s.entityName}${s.projectName ? ` · Project: ${s.projectName}` : ''}${s.email ? ` · ${s.email}` : ''} · generated ${s.generatedAt} · amounts in USD`, margin, 60);
    doc.setTextColor(0);
    doc.setFontSize(10);
    doc.text(
      `Opening Balance: ${s.openingBalance ? `${money(s.openingBalance.amount)} ${s.openingBalance.currency} as of ${s.openingBalance.date} (USD ${money(s.openingBalance.usd)})` : 'None'}`,
      margin, 78,
    );

    autoTable(doc, {
      startY: 90,
      margin: { left: margin, right: margin },
      head: [['Date', 'Entry #', 'Entity', 'Description', 'Account', 'Debit', 'Credit', 'Balance']],
      body: s.rows.length
        ? s.rows.map((r) => [r.date, r.entryNumber, r.entity, r.note ? `${r.description}\n(${r.note})` : r.description, r.account, money(r.debit), money(r.credit), money(r.balance)])
        : [[{ content: 'No posted activity', colSpan: 8, styles: { halign: 'center', textColor: 120 } }]],
      foot: [[{ content: `Closing Balance — ${s.balanceLabel}`, colSpan: 7, styles: { halign: 'right' } }, { content: money(s.closingBalanceUSD), styles: { halign: 'right' } }]],
      styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
      headStyles: { fillColor: [17, 24, 39] },
      footStyles: { fillColor: [243, 244, 246], textColor: 20, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 60 }, 1: { cellWidth: 82 }, 2: { cellWidth: 70 }, 3: { cellWidth: 'auto' }, 4: { cellWidth: 120 },
        5: { cellWidth: 66, halign: 'right' }, 6: { cellWidth: 66, halign: 'right' }, 7: { cellWidth: 72, halign: 'right' },
      },
    });
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`TekRevol FinSys · page ${p} of ${pages}`, pageWidth - margin, doc.internal.pageSize.getHeight() - 18, { align: 'right' });
  }
  doc.save(`${safeFileName(fileBase)}-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
}
