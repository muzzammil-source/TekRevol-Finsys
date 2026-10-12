import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Route, Switch, Router as WouterRouter } from "wouter";
import { AppLayout } from "@/components/layout";

import BankTransactionsHub from "@/pages/bank-transactions-hub";
import BankReconciliation from "@/pages/bank-reconciliation";
import FinancialStatements from "@/pages/financial-statements";
import ReportsBrandPnl from "@/pages/reports-brand-pnl";
import ReportsRevenueStreams from "@/pages/reports-revenue-streams";
import ReportsTrends from "@/pages/reports-trends";
import ReportsExecutive from "@/pages/reports-executive";
import ImportLedger from "@/pages/import-ledger";
import ReportsAging from "@/pages/reports-aging";
import ReportsIntercompany from "@/pages/reports-intercompany";
import Accounts from "@/pages/accounts";
import ExchangeRates from "@/pages/exchange-rates";
import TrialBalance from "@/pages/trial-balance";
import Contacts from "@/pages/contacts";
import GeneralLedger from "@/pages/general-ledger";
import JournalEntry from "@/pages/journal-entry";
import SplitRules from "@/pages/split-rules";
import SettingsEntities from "@/pages/settings-entities";
import TeamAccess from "@/pages/settings-team";
import { LoginScreen, SetupScreen, ChangePasswordScreen, ResetPasswordScreen } from "@/pages/auth-screens";
import { AuthProvider, NoAccess, useAuth, useAuthEventListener } from "@/lib/auth";
import { useAuthStatus, useMe } from "@workspace/api-client-react";

// Admin-only screens render a "no access" panel for other roles (the server
// refuses their API calls regardless).
function AdminOnly({ children, what }: { children: React.ReactNode; what: string }) {
  const { can } = useAuth();
  return can("admin") ? <>{children}</> : <NoAccess what={what} />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

function Router() {
  return (
    <AppLayout>
      <Switch>
        {/* Statutory navigation (2026-09-11). Paths mirror the sidebar
            hierarchy: /banking/*, /accounting/*, /reports/*, /settings/*. */}
        <Route path="/" component={ReportsExecutive} />

        {/* Banking — one merged screen (cards + transaction feed).
            /banking/accounts and /banking/transactions were separate views
            for one revision; both now resolve to the same merged page so
            links made in between keep working. */}
        <Route path="/banking" component={BankTransactionsHub} />
        <Route path="/banking/accounts" component={BankTransactionsHub} />
        <Route path="/banking/transactions" component={BankTransactionsHub} />
        <Route path="/banking/reconciliation">{() => <AdminOnly what="reconciliation"><BankReconciliation /></AdminOnly>}</Route>

        {/* Accounting */}
        <Route path="/accounting/chart-of-accounts" component={Accounts} />
        <Route path="/accounting/general-ledger" component={GeneralLedger} />
        <Route path="/accounting/trial-balance" component={TrialBalance} />
        <Route path="/accounting/contacts" component={Contacts} />
        <Route path="/accounting/journal-entry" component={JournalEntry} />
        {/* Staging a file needs `import`; posting the batch needs `post`,
            both enforced server-side. The page itself is open to anyone who
            can see the books. */}
        <Route path="/accounting/import" component={ImportLedger} />

        {/* Reports */}
        <Route path="/reports/profit-loss">{() => <FinancialStatements report="pnl" />}</Route>
        <Route path="/reports/balance-sheet">{() => <FinancialStatements report="balance-sheet" />}</Route>
        <Route path="/reports/cash-flow">{() => <FinancialStatements report="cash-flow" />}</Route>
        <Route path="/reports/aging" component={ReportsAging} />
        {/* The matrix names every entity in the group, so it is only for
            users who may see them all (the server rule says the same). */}
        <Route path="/reports/intercompany">
          {() => <AdminOnly what="the intercompany ledger"><ReportsIntercompany /></AdminOnly>}
        </Route>

        {/* Settings — Admin only */}
        <Route path="/settings/entities">{() => <AdminOnly what="entity settings"><SettingsEntities /></AdminOnly>}</Route>
        <Route path="/settings/currency">{() => <AdminOnly what="currency settings"><ExchangeRates /></AdminOnly>}</Route>
        <Route path="/settings/team">{() => <AdminOnly what="team & access"><TeamAccess /></AdminOnly>}</Route>
        {/* Split rules are readable by every role; the page hides editing
            for anyone but an all-entity Admin (server-enforced too). */}
        <Route path="/settings/rules" component={SplitRules} />

        {/* Management analytics — deliberately off the sidebar (see
            components/layout.tsx) but kept routed so existing deep links
            and bookmarks keep working. The allocation/consolidation ENGINE
            itself is untouched and still runs on every post. */}
        <Route path="/reports/brand-pnl" component={ReportsBrandPnl} />
        <Route path="/reports/revenue-streams" component={ReportsRevenueStreams} />
        <Route path="/reports/trends" component={ReportsTrends} />
        <Route path="/reports/executive" component={ReportsExecutive} />

        {/* Pre-refactor paths, kept as redirect-equivalents so nothing 404s. */}
        <Route path="/bank-transactions-hub" component={BankTransactionsHub} />
        <Route path="/accounting/reconciliation">{() => <AdminOnly what="reconciliation"><BankReconciliation /></AdminOnly>}</Route>
        {/* Legacy deep link. Rendered through a child so the page's own
            optional `report` prop isn't mistaken for wouter's route props. */}
        <Route path="/accounting/reports">{() => <FinancialStatements />}</Route>
        <Route path="/accounts" component={Accounts} />
        <Route path="/exchange-rates">{() => <AdminOnly what="currency settings"><ExchangeRates /></AdminOnly>}</Route>

        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

// Auth gate (2026-09-17): first-run setup → sign in → forced password change
// → the app. The server enforces every permission; this only decides which
// screen to show.
function AuthGate() {
  useAuthEventListener();
  const status = useAuthStatus();
  const me = useMe();

  // A reset link lands here signed out, so it has to be answered before the
  // sign-in screen gets a say — and before the loading gate, since it needs
  // no session of its own. Read once: the token is stripped from the URL on
  // success, and re-reading it would unmount the screen mid-flight.
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  if (resetToken && window.location.pathname.replace(/\/$/, '').endsWith('/reset-password')) {
    return <ResetPasswordScreen token={resetToken} />;
  }

  if (status.isLoading || me.isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading…</div>;
  }
  if (status.data?.needsSetup) return <SetupScreen />;
  if (!me.data) return <LoginScreen />;
  if (me.data.user.mustChangePassword) return <ChangePasswordScreen name={me.data.user.fullName} />;

  return (
    // key: remount the whole app when the signed-in user changes, so no
    // component keeps another user's local state.
    <AuthProvider key={me.data.user.id} user={me.data.user} capabilities={me.data.capabilities}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
    </AuthProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthGate />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
