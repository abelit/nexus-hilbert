import { useI18n } from '@/i18n/locale';

import {
  derivedStatus,
  derivedStatusLabel,
  type AddressRecord,
  type DerivedStatus,
} from '../../lib/ipam';
import { cn } from '@/lib/cn';

const STATUS_CLASS: Record<DerivedStatus, string> = {
  '0': 'bg-emerald-500',
  '1': 'bg-orange-500',
  '2': 'bg-indigo-500',
  '3': 'bg-zinc-400',
};

export function AddressGrid({
  rows,
  selected,
  onSelect,
}: {
  rows: AddressRecord[];
  selected: ReadonlySet<string>;
  onSelect(row: AddressRecord, gesture: { shift: boolean; toggle: boolean; ordered: string[] }): void;
}) {
  const { tr } = useI18n();
  const ordered = rows.map((row) => row.ip);

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5">
      {rows.map((row) => {
        const status = derivedStatus(row);
        const isSelected = selected.has(row.ip);
        const title = [row.ip, derivedStatusLabel(status, tr), row.usage, row.useObj]
          .filter(Boolean)
          .join(' — ');
        return (
          <button
            key={row.ip}
            type="button"
            aria-pressed={isSelected}
            aria-label={row.ip}
            title={title}
            onClick={(event) =>
              onSelect(row, {
                shift: event.shiftKey,
                toggle: event.metaKey || event.ctrlKey,
                ordered,
              })
            }
            className={cn(
              'aspect-square rounded text-[11px] font-semibold text-white transition-transform duration-150 ease-out',
              'motion-safe:hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400',
              STATUS_CLASS[status],
              isSelected && 'ring-2 ring-foreground ring-offset-1 ring-offset-background',
            )}
          >
            {row.ip.split('.').pop()}
          </button>
        );
      })}
      {rows.length === 0 && (
        <p className="col-span-full py-10 text-center text-xs text-text-muted">
          {tr('没有匹配的地址', 'No address matches')}
        </p>
      )}
    </div>
  );
}

export function AddressLegend() {
  const { tr } = useI18n();
  const items: DerivedStatus[] = ['0', '1', '2', '3'];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-text-muted">
      {items.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <span className={cn('size-2.5 rounded-sm', STATUS_CLASS[status])} aria-hidden="true" />
          {derivedStatusLabel(status, tr)}
        </span>
      ))}
    </div>
  );
}
