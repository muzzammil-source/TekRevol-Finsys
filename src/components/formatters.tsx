import React from 'react';
import { Badge } from '@/components/ui/badge';

export function EntityBadge({ entity }: { entity: string }) {
  const getStyle = (e: string) => {
    switch (e.toUpperCase()) {
      case 'CA': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 hover:bg-blue-100';
      case 'TX': return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300 hover:bg-red-100';
      case 'UAE': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300 hover:bg-emerald-100';
      case 'PK': return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300 hover:bg-amber-100';
      case 'BUZZFLICK': return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300 hover:bg-purple-100';
      default: return 'bg-gray-100 text-gray-800 hover:bg-gray-100';
    }
  };

  return <Badge variant="outline" className={`${getStyle(entity)} border-transparent font-mono uppercase text-xs px-2`}>{entity}</Badge>;
}

export function RevenueTypeBadge({ type }: { type: string }) {
  const getStyle = (t: string) => {
    switch (t) {
      case 'Fresh': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
      case 'Recurring': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
      case 'Upsell': return 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400';
      default: return 'bg-gray-100 text-gray-800';
    }
  };
  return (
    <Badge variant="outline" className={`${getStyle(type)} border-transparent font-mono uppercase text-[10px]`}>
      {type}
    </Badge>
  );
}

export function FormatCurrency({ amount, currency = 'USD', decimals = 0 }: { amount: number, currency?: string, decimals?: number }) {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);

  const isNegative = amount < 0;

  return (
    <span className={`font-mono ${isNegative ? 'text-destructive' : ''}`}>
      {formatted}
    </span>
  );
}

export function FormatPct({ amount }: { amount: number }) {
  return (
    <span className="font-mono">
      {amount.toFixed(1)}%
    </span>
  );
}
