import React from 'react';
export { PageContent, PageHeader, SectionLabel, SurfaceCard, StatCard, DeltaPill } from '@/components/page-components';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from '@/components/ui/sidebar';
import { Link, useLocation } from 'wouter';
import {
  BookOpen, Building2, Coins, CreditCard, FileBarChart, Gauge,
  Landmark, List, LogOut, NotebookPen, Scale, ShieldCheck, Users, Workflow,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';

// Statutory / tax-accounting navigation (2026-09-11). The sidebar now
// mirrors how a statutory accountant actually works through the books —
// money in (Banking), the ledger itself (Accounting), the statements
// (Reports), then configuration (Settings). The placeholder "Transactions —
// Soon" entry was removed on 2026-09-17.
//
// Deliberately NOT in this menu:
//  - "Planning" (budget/forecast) — not built, and out of scope for a
//    statutory book of record.
//  - "Management" (allocation engine, consolidation, brand analytics) —
//    the ENGINE stays fully live. Cross-brand split posting, the per-entity
//    Due From/To Affiliates heads and the consolidation eliminations in the
//    Balance Sheet all keep running exactly as before; only their
//    standalone analytics screens are off the menu, to keep the app focused
//    on the statutory workflow. Those routes are still registered in
//    App.tsx, so existing deep links keep working.
//
// `disabled: true` marks a module with backend support but no screen yet —
// shown greyed with a "Soon" chip rather than linking to a dead route, the
// same convention the hub has used since Phase 1.
const navGroups = [
  {
    label: 'Overview',
    items: [{ name: 'Dashboard', href: '/', icon: Gauge }],
  },
  {
    // One unified Banking screen: bank cards and the transaction feed they
    // produce on the same page. Reconciliation keeps its route but is off
    // the menu as of the 2026-09-11 hard reset ("Banking — 1 tab").
    label: 'Banking',
    items: [{ name: 'Bank Transactions', href: '/banking', icon: Landmark }],
  },
  {
    label: 'Accounting',
    items: [
      { name: 'Chart of Accounts', href: '/accounting/chart-of-accounts', icon: List },
      { name: 'General Ledger', href: '/accounting/general-ledger', icon: BookOpen },
      { name: 'Trial Balance', href: '/accounting/trial-balance', icon: Scale },
      // Manual journal entries post straight to the ledger.
      { name: 'Journal Entry', href: '/accounting/journal-entry', icon: NotebookPen },
      { name: 'Directory', href: '/accounting/contacts', icon: Users },
    ],
  },
  {
    label: 'Reports',
    items: [
      { name: 'Profit & Loss', href: '/reports/profit-loss', icon: FileBarChart },
      { name: 'Balance Sheet', href: '/reports/balance-sheet', icon: CreditCard },
    ],
  },
  {
    // Settings are Admin-only (server-enforced; hidden here for other roles).
    label: 'Settings',
    adminOnly: true,
    items: [
      { name: 'Entities', href: '/settings/entities', icon: Building2 },
      { name: 'Rules', href: '/settings/rules', icon: Workflow },
      { name: 'Currency', href: '/settings/currency', icon: Coins },
      { name: 'Team & Access', href: '/settings/team', icon: ShieldCheck },
    ],
  },
];

const ROLE_CHIP: Record<string, string> = {
  Admin: 'bg-gray-900 text-white',
  Manager: 'bg-blue-100 text-blue-800',
  Bookkeeper: 'bg-emerald-100 text-emerald-800',
  Auditor: 'bg-amber-100 text-amber-800',
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
}

// Older paths that still resolve to a nav item's page (see App.tsx), so the
// sidebar highlights that item instead of looking like nothing is selected.
const ROUTE_ALIASES: Record<string, string> = {
  '/banking/accounts': '/banking',
  '/banking/transactions': '/banking',
  '/bank-transactions-hub': '/banking',
  '/accounts': '/accounting/chart-of-accounts',
  '/exchange-rates': '/settings/currency',
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, can, logout } = useAuth();
  const visibleGroups = navGroups.filter((g: any) => !g.adminOnly || can('admin'));
  const activeHref = ROUTE_ALIASES[location] ?? location;

  return (
    <SidebarProvider>
      <div className="flex h-screen w-full bg-[#F8FAFC] overflow-hidden">
        <Sidebar className="border-r border-[#E2E8F0] shadow-none bg-white">
          <SidebarHeader className="px-4 py-4">
            <div className="flex items-center gap-2.5">
              <img src="/logo.png" alt="TekRevol FinSys" className="size-7 object-contain" />
              <div className="leading-tight">
                <div className="text-[13px] font-bold tracking-tight text-gray-900">TekRevol FinSys</div>
                <div className="text-[10px] uppercase tracking-wider text-gray-400">Finance Platform</div>
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent className="px-2">
            {visibleGroups.map((group) => (
              <SidebarGroup key={group.label} className="py-1">
                <SidebarGroupLabel className="px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  {group.label}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu className="gap-0.5">
                    {group.items.map((item: any) => (
                      <SidebarMenuItem key={item.name}>
                        {item.disabled ? (
                          <SidebarMenuButton
                            disabled
                            tooltip={`${item.name} — not built yet`}
                            className="rounded-lg text-gray-400 cursor-not-allowed hover:bg-transparent"
                          >
                            <item.icon className="size-4" />
                            <span className="text-[13px]">{item.name}</span>
                            <span className="ml-auto text-[9px] font-medium uppercase tracking-wider text-gray-300">Soon</span>
                          </SidebarMenuButton>
                        ) : (
                          <SidebarMenuButton
                            asChild
                            isActive={activeHref === item.href}
                            tooltip={item.name}
                            className="rounded-md text-[#475569] transition-colors hover:bg-[#F1F5F9] hover:text-[#0F172A] data-[active=true]:bg-[#F1F5F9] data-[active=true]:text-[#0F172A] data-[active=true]:font-medium data-[active=true]:shadow-[inset_2px_0_0_#0F172A]"
                          >
                            <Link href={item.href} className="flex items-center gap-2.5">
                              <item.icon className="size-4" />
                              <span className="text-[13px]">{item.name}</span>
                            </Link>
                          </SidebarMenuButton>
                        )}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>

          <SidebarFooter className="p-3">
            {/* Signed-in user, role and sign out. */}
            <div className="flex items-center gap-2.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-2.5" data-current-user={user.email}>
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[#0F172A] text-[11px] font-bold text-white">
                {initials(user.fullName)}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[12px] font-semibold text-gray-900" title={user.email}>{user.fullName}</div>
                <span className={`mt-0.5 inline-block rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${ROLE_CHIP[user.role] || 'bg-gray-100 text-gray-600'}`} data-current-role={user.role}>
                  {user.role}
                </span>
              </div>
              <button
                type="button"
                onClick={() => logout()}
                className="shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-900"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
