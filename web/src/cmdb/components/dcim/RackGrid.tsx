import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui';
import { EmptyStateCard } from '@/components/ui/EmptyState';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { RackRow } from '../../lib/dcim';
import { rackImage } from '../../lib/dcim-images';

// Racks as objects, not rows. A data centre operator recognises a rack by its
// front panel and its fill level, so the card leads with the name, the height,
// and the capacity track; the table is there for comparing subscribed fields.
export function RackGrid({
  racks,
  loading,
  error,
  onRetry,
  onOpen,
  onCreate,
  hasRacks,
  onClearFilters,
}: {
  racks: RackRow[];
  loading: boolean;
  error?: string | null;
  onRetry?(): void;
  onOpen(rack: RackRow): void;
  onCreate?(): void;
  /** Whether the room has racks at all, before the toolbar's filters. */
  hasRacks: boolean;
  onClearFilters?(): void;
}) {
  const { tr } = useI18n();

  if (error && racks.length === 0) {
    return (
      <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
        <p className="break-words">{error}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-2 rounded border border-red-500/40 px-2 py-1 text-[11px] hover:bg-red-500/10">
            {tr('重试', 'Retry')}
          </button>
        )}
      </div>
    );
  }

  if (loading && racks.length === 0) {
    return (
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-40 rounded-lg border border-border bg-card/60" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (racks.length === 0) {
    return hasRacks ? (
      <EmptyStateCard
        title={tr('没有匹配的机柜', 'No matching racks')}
        hint={tr('换一个名称或机柜类型，或清除筛选。', 'Try another name or rack type, or clear the filters.')}
        action={onClearFilters ? (
          <Button variant="outline" size="sm" type="button" onClick={onClearFilters}>
            {tr('清除全部筛选', 'Clear all filters')}
          </Button>
        ) : undefined}
      />
    ) : (
      <EmptyStateCard
        title={tr('这个机房还没有机柜', 'This room has no racks yet')}
        hint={tr('新建机柜时填写高度和可用 U 数，之后就可以上架设备。', 'A rack needs a height and a free-unit count before devices can be mounted.')}
        action={onCreate ? (
          <Button variant="primary" size="sm" type="button" onClick={onCreate}>
            {tr('新建机柜', 'New rack')}
          </Button>
        ) : undefined}
      />
    );
  }

  const grid = (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {racks.map((rack) => (
        <button
          key={rack.id}
          type="button"
          onClick={() => onOpen(rack)}
          aria-label={tr(`打开机柜 ${rack.name}`, `Open rack ${rack.name}`)}
          title={tr(`空闲 ${rack.freeUCount}U`, `${rack.freeUCount}U free`)}
          className={cn(
            'group relative flex min-h-[210px] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card text-left transition-colors',
            'hover:border-indigo-500/40 hover:bg-indigo-500/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500',
          )}
        >
          {rack.abnormal && (
            <span className="absolute left-1/2 top-7 z-10 flex -translate-x-1/2 items-center gap-1 rounded-sm bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">
              <AlertTriangle size={10} aria-hidden="true" />
              {tr('U 位异常', 'U conflict')}
            </span>
          )}

          <span className="flex h-7 items-center justify-between bg-indigo-500/[0.04]">
            <span
              className="max-w-[78%] truncate rounded-br-2xl bg-zinc-500/80 px-2 text-xs font-bold leading-7 text-white group-hover:bg-indigo-500"
              title={rack.name}
            >
              {rack.name}
            </span>
            <span className="me-2 shrink-0 text-[11px] tabular-nums text-text-muted">{rack.uCount}U</span>
          </span>

          <img
            src={rackImage}
            alt=""
            draggable={false}
            className="mx-auto mt-3 h-28 w-auto object-contain transition-[height,margin] group-hover:mt-2 group-hover:h-32"
          />

          <span className="mt-auto flex items-center justify-center gap-2 px-4 pb-2 text-[11px] text-text-muted">
            <span className="whitespace-nowrap font-semibold text-text" title={tr(`空闲 ${rack.freeUCount}U`, `${rack.freeUCount}U free`)}>
              {rack.usedUCount}/{rack.uCount}
            </span>
            <span className="relative h-0.5 w-20 shrink-0 rounded-full bg-border group-hover:w-24">
              <span
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full',
                  rack.abnormal || rack.usedRatio > 100
                    ? 'bg-red-500'
                    : rack.usedRatio >= 80
                      ? 'bg-amber-500'
                      : 'bg-indigo-500',
                )}
                style={{ width: `${Math.min(100, Math.max(0, rack.usedRatio))}%` }}
              />
              <span
                className="absolute top-1/2 size-2 -translate-y-1/2 rounded-full border border-indigo-500/50 bg-card"
                style={{ left: `calc(${Math.min(100, Math.max(0, rack.usedRatio))}% - 4px)` }}
              />
            </span>
            <span className="w-8 shrink-0 text-right tabular-nums">{rack.usedRatio}%</span>
          </span>
        </button>
      ))}
    </div>
  );

  if (!error) return grid;
  return (
    <div className="flex flex-col gap-2">
      <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
        <span className="break-words">{error}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="ms-2 rounded border border-red-500/40 px-2 py-0.5 text-[11px] hover:bg-red-500/10">
            {tr('重试', 'Retry')}
          </button>
        )}
      </div>
      {grid}
    </div>
  );
}
