import {
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  Database,
  History,
  Inbox,
  ScrollText,
  Target,
  type LucideIcon,
} from 'lucide-react';

import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { PoolCounters } from '../../../api/discovery';

// The pool's counters.
//
// THEY ARE DERIVED, NOT CACHED. cantor's c_ad_counter was a table of numbers a
// Celery task kept in step with the rows, which is a second source of truth that
// can disagree with the first. Three of these are COUNT(*) over the pool; the
// week/month buckets are the same count with a date filter.
//
// PENDING IS THE ONE DERIVED VALUE: it is not stored anywhere, because it is
// exactly "rows that are not accepted". `instance_count` is the pool's ROW
// count (the backend names it for cantor's column), so it is labelled 记录总数
// rather than 实例总数.

export function CounterStrip({ counters }: { counters: PoolCounters }) {
  const { tr } = useI18n();
  const pending = Math.max(0, counters.instance_count - counters.accept_count);

  const primary: Array<{ key: string; zh: string; en: string; value: number; icon: LucideIcon; tone?: string }> = [
    {
      key: 'pending',
      zh: '待接受',
      en: 'Pending',
      value: pending,
      icon: Inbox,
      // A backlog is the one number an operator acts on; it is the only one
      // allowed to take the warning colour.
      tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
    { key: 'accepted', zh: '已接受', en: 'Accepted', value: counters.accept_count, icon: CheckCircle2 },
    { key: 'records', zh: '记录总数', en: 'Pool records', value: counters.instance_count, icon: Database },
  ];

  const secondary: Array<{ key: string; zh: string; en: string; value: number; icon: LucideIcon }> = [
    { key: 'targets', zh: '执行目标', en: 'Targets', value: counters.exec_target_count, icon: Target },
    { key: 'rules', zh: '规则', en: 'Rules', value: counters.rule_count, icon: ScrollText },
    { key: 'week', zh: '本周新增', en: 'This week', value: counters.this_week_count, icon: CalendarDays },
    { key: 'month', zh: '本月新增', en: 'This month', value: counters.this_month_count, icon: CalendarRange },
    { key: 'lastMonth', zh: '上月新增', en: 'Last month', value: counters.last_month_count, icon: History },
  ];

  return (
    <section
      aria-label={tr('发现池统计', 'Pool counters')}
      className="overflow-hidden rounded-xl border border-border/60 bg-card/40"
    >
      <dl className="grid grid-cols-3 divide-x divide-border/50">
        {primary.map((item) => {
          const Icon = item.icon;
          const warn = item.key === 'pending' && item.value > 0;
          return (
            <div key={item.key} className="flex min-w-0 items-center gap-2 px-3 py-3 sm:gap-2.5 sm:px-4">
              {/* The labels carry the meaning; a phone-width cell cannot hold
                  both the icon and a four-character label. */}
              <span
                aria-hidden="true"
                className={cn(
                  'hidden size-7 shrink-0 items-center justify-center rounded-lg sm:flex',
                  warn ? item.tone : 'bg-text/5 text-text-muted',
                )}
              >
                <Icon size={15} />
              </span>
              <div className="min-w-0">
                <dt className="truncate text-[11px] text-text-faint">{tr(item.zh, item.en)}</dt>
                <dd
                  aria-label={tr(`${item.zh}数量`, `${item.en} count`)}
                  className={cn(
                    'mt-0.5 text-2xl font-semibold leading-tight tabular-nums',
                    warn ? 'text-amber-600 dark:text-amber-400' : 'text-text',
                  )}
                >
                  {item.value}
                </dd>
              </div>
            </div>
          );
        })}
      </dl>
      <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border/50 px-4 py-2">
        {secondary.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.key} className="flex items-center gap-1.5 text-[11px]">
              <Icon size={11} className="shrink-0 text-text-faint" aria-hidden="true" />
              <dt className="text-text-faint">{tr(item.zh, item.en)}</dt>
              <dd
                aria-label={tr(`${item.zh}数量`, `${item.en} count`)}
                className="font-medium tabular-nums text-text-muted"
              >
                {item.value}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
