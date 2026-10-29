import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

// A small label/value pill for a workspace bar's metadata row: the model's
// identifier and counts on the detail page, the instance counts on the resource
// list. It stays a pill, not a card, so four or five of them read as one line.
export function MetaPill({ label, value, mono }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-[11px] text-text-muted">
      <span className="shrink-0">{label}</span>
      <span className={cn('min-w-0 truncate font-semibold text-text', mono && 'font-mono')}>{value}</span>
    </span>
  );
}
