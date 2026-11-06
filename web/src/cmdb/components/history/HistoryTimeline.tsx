import { useMemo, type ComponentProps, type ReactNode } from 'react';

import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/i18n/locale';
import { clockTime } from '@/lib/format';

// The history timeline: the same page of records as the table, grouped by day.
//
// IT IS A SECOND RENDER OF THE SAME ROWS, not a second query. The page owns the
// fetch, filters and pagination; this component only arranges what came back so
// an auditor can read a day in order instead of scanning a table. Day grouping
// is therefore per page, which is what the footer's range describes.

export type HistoryTimelineEntry = {
  key: string | number;
  createdAt?: string;
  user: string;
  /** The model or record the change belongs to, shown as a chip. */
  entity: string;
  action?: string;
  actionTone?: ComponentProps<typeof Chip>['tone'];
  /** The before/after lines, already rendered by the caller. */
  changes: ReactNode;
  /** Accessible name of the details action. */
  detailLabel: string;
  onOpen(): void;
};

type DayGroup = { key: string; label: string; entries: HistoryTimelineEntry[] };

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sameDay(left: Date, right: Date): boolean {
  return dayKey(left) === dayKey(right);
}

function dayLabel(date: Date, tr: (zh: string, en: string) => string, now: Date): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const zh = `${month} 月 ${day} 日`;
  const en = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (sameDay(date, now)) return tr(`今天 · ${zh}`, `Today · ${en}`);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return tr(`昨天 · ${zh}`, `Yesterday · ${en}`);
  if (date.getFullYear() !== now.getFullYear()) {
    return tr(`${date.getFullYear()} 年 ${zh}`, `${en}, ${date.getFullYear()}`);
  }
  return tr(zh, en);
}

export function HistoryTimeline({
  entries,
  loading,
  empty,
}: {
  entries: HistoryTimelineEntry[];
  loading: boolean;
  empty: string;
}) {
  const { tr } = useI18n();

  const groups = useMemo<DayGroup[]>(() => {
    const now = new Date();
    const out: DayGroup[] = [];
    const byKey = new Map<string, DayGroup>();
    for (const entry of entries) {
      const parsed = entry.createdAt ? new Date(entry.createdAt) : null;
      const valid = parsed !== null && !Number.isNaN(parsed.getTime());
      const key = valid ? dayKey(parsed) : 'unknown';
      let group = byKey.get(key);
      if (!group) {
        group = { key, label: valid ? dayLabel(parsed, tr, now) : '—', entries: [] };
        byKey.set(key, group);
        out.push(group);
      }
      group.entries.push(entry);
    }
    return out;
  }, [entries, tr]);

  if (loading && entries.length === 0) {
    return <p className="py-8 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>;
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        title={empty}
        className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
      {groups.map((group) => (
        <section key={group.key}>
          <div className="flex items-center justify-between gap-3 px-1 pb-1 pt-3 text-[11px] font-medium text-text-muted">
            <span>{group.label}</span>
            <span className="font-normal text-text-faint">
              {tr(`${group.entries.length} 条`, `${group.entries.length} items`)}
            </span>
          </div>
          <div className="relative">
            {/* The rule runs through the dots; it is decoration for the day
                grouping, not a control. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-1 left-[5.375rem] top-1 w-px bg-border/70"
            />
            {group.entries.map((entry) => (
              <div
                key={entry.key}
                className="grid grid-cols-[4.5rem_0.75rem_minmax(0,1fr)] items-start gap-2 py-1.5"
              >
                <span className="pt-0.5 text-right font-mono text-[10px] leading-4 text-text-faint">
                  {entry.createdAt ? clockTime(entry.createdAt) : '—'}
                </span>
                <span
                  aria-hidden="true"
                  className="relative z-10 mt-1 size-2 justify-self-center rounded-full border-2 border-border bg-card"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-text">{entry.user}</span>
                    <Chip tone="info" dense>{entry.entity}</Chip>
                    {entry.action && <Chip tone={entry.actionTone ?? 'default'} dense>{entry.action}</Chip>}
                    <button
                      type="button"
                      onClick={entry.onOpen}
                      aria-label={entry.detailLabel}
                      className="ms-auto shrink-0 rounded text-[10px] text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                    >
                      {tr('详情', 'Details')}
                    </button>
                  </div>
                  <div className="mt-0.5 flex flex-col gap-0.5">{entry.changes}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
