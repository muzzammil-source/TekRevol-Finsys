import React, { ReactNode } from 'react';

// Design system (2026-09-11 SaaS revamp). The whole app renders on a light
// slate canvas with pure-white cards floating on it — page chrome lives
// here so a page only has to say *what* it shows, never how the surface is
// painted. Typography scale: page titles 24-26px bold, metrics 22-28px
// bold, section labels 10-11px uppercase tracking-wider, body 13-14px.

export function PageHeader({ title, description, children }: { title: ReactNode, description?: ReactNode, children?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-6 md:px-8 pt-7 pb-5 bg-white border-b border-gray-100">
      <div>
        <h1 className="text-2xl md:text-[26px] font-bold tracking-tight text-gray-900">{title}</h1>
        {description && <p className="text-[13px] text-gray-500 mt-1">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function PageContent({ children }: { children: ReactNode }) {
  return (
    <div className="bg-[#F8FAFC] min-h-full p-6 md:p-8 space-y-6">
      {children}
    </div>
  );
}

// The small grey all-caps label that separates bands of content.
export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-semibold uppercase tracking-wider text-gray-400 ${className}`}>
      {children}
    </div>
  );
}

const ACCENTS: Record<string, string> = {
  blue: 'from-blue-500 to-indigo-500',
  emerald: 'from-emerald-500 to-teal-500',
  amber: 'from-amber-500 to-orange-500',
  violet: 'from-violet-500 to-purple-500',
  rose: 'from-rose-500 to-pink-500',
  slate: 'from-slate-400 to-slate-500',
};

const ICON_BADGE: Record<string, string> = {
  blue: 'bg-blue-50 text-blue-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  violet: 'bg-violet-50 text-violet-600',
  rose: 'bg-rose-50 text-rose-600',
  slate: 'bg-slate-100 text-slate-600',
};

// The standard white surface everything sits on. `accent` paints the 2px
// gradient strip along the top edge.
export function SurfaceCard({
  children,
  className = '',
  accent,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  accent?: keyof typeof ACCENTS;
  padded?: boolean;
}) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden ${className}`}>
      {accent && <div className={`h-0.5 w-full bg-gradient-to-r ${ACCENTS[accent]}`} />}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </div>
  );
}

// "+248.9% vs last mo" — green when up, red when down, grey when flat or
// when there's no comparison basis.
export function DeltaPill({ value, suffix = 'vs last mo' }: { value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
        — {suffix}
      </span>
    );
  }
  const up = value > 0;
  const flat = Math.abs(value) < 0.05;
  const tone = flat ? 'bg-gray-100 text-gray-600' : up ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700';
  const sign = flat ? '' : up ? '+' : '';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {sign}{value.toFixed(1)}% {suffix}
    </span>
  );
}

export function StatCard({
  label,
  value,
  sublabel,
  icon: Icon,
  accent = 'blue',
  delta,
  deltaSuffix,
}: {
  label: ReactNode;
  value: ReactNode;
  sublabel?: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  accent?: keyof typeof ACCENTS;
  delta?: number | null;
  deltaSuffix?: string;
}) {
  return (
    <SurfaceCard accent={accent}>
      <div className="flex items-start justify-between gap-3">
        <SectionLabel>{label}</SectionLabel>
        {Icon && (
          <div className={`flex size-8 shrink-0 items-center justify-center rounded-xl ${ICON_BADGE[accent]}`}>
            <Icon className="size-4" />
          </div>
        )}
      </div>
      <div className="mt-2 text-[26px] font-bold tracking-tight text-gray-900 tabular-nums">{value}</div>
      {(sublabel || delta !== undefined) && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {delta !== undefined && <DeltaPill value={delta} suffix={deltaSuffix} />}
          {sublabel && <span className="text-[12px] text-gray-500">{sublabel}</span>}
        </div>
      )}
    </SurfaceCard>
  );
}
