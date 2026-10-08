import React from 'react';
import { Link, useLocation } from 'wouter';
import { cn } from '@/lib/utils';

const REPORTS_TABS = [
  { name: 'Brand P&L', href: '/reports/brand-pnl' },
  { name: 'Revenue Streams', href: '/reports/revenue-streams' },
  { name: 'Trends', href: '/reports/trends' },
  { name: 'Executive Dashboard', href: '/reports/executive' },
];

export function ReportsSubNav() {
  const [location] = useLocation();
  return (
    <div className="border-b px-8">
      <nav className="flex gap-1 -mb-px">
        {REPORTS_TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'px-3 py-2.5 text-sm font-medium border-b-2 transition-colors',
              location === tab.href
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
            )}
          >
            {tab.name}
          </Link>
        ))}
      </nav>
    </div>
  );
}
