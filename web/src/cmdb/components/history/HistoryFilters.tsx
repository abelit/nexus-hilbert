import { useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import type { User } from '@/api/users';

import type { CIType } from '../../api/citype';

// The history filter band.
//
// THE TIME FIELDS ARE `datetime-local`, not free text: the backend accepts two
// formats, and a person should not have to remember either. The value is
// converted to the API's `YYYY-MM-DD HH:MM:SS` at the edge.
//
// THE QUICK RANGES ARE THE DEFAULT ENTRY POINT. An audit starts with "what
// happened recently", so the common spans are one click; the date fields stay
// for anything else. Editing a field clears the highlighted range, because the
// range no longer describes what is being sent.

export type FilterState = {
  start: string;
  end: string;
  uid: string;
  typeID: string;
  operate: string;
};

export const EMPTY_FILTERS: FilterState = { start: '', end: '', uid: '', typeID: '', operate: '' };

export type OperateOption = { value: string; label: string };

type PresetID = 'hour' | 'today' | 'week' | 'month';

const PRESETS: Array<{ id: PresetID; zh: string; en: string }> = [
  { id: 'hour', zh: '近 1 小时', en: 'Last hour' },
  { id: 'today', zh: '今天', en: 'Today' },
  { id: 'week', zh: '近 7 天', en: 'Last 7 days' },
  { id: 'month', zh: '近 30 天', en: 'Last 30 days' },
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A `datetime-local` value in the browser's own zone. */
function localInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The start/end values a quick range stands for, evaluated at click time. */
export function presetRange(id: PresetID, now: Date = new Date()): { start: string; end: string } {
  const start = new Date(now);
  switch (id) {
    case 'hour':
      start.setHours(start.getHours() - 1);
      break;
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'week':
      start.setDate(start.getDate() - 7);
      break;
    case 'month':
      start.setDate(start.getDate() - 30);
      break;
  }
  return { start: localInputValue(start), end: localInputValue(now) };
}

export function HistoryFilters({
  value,
  models,
  users,
  operateOptions,
  onChange,
  onReset,
}: {
  value: FilterState;
  models: CIType[];
  users: User[];
  operateOptions: OperateOption[];
  onChange(next: FilterState): void;
  onReset(): void;
}) {
  const { tr } = useI18n();
  const [preset, setPreset] = useState<PresetID | null>(null);

  const update = (patch: Partial<FilterState>) => {
    setPreset(null);
    onChange({ ...value, ...patch });
  };

  const applyPreset = (id: PresetID) => {
    setPreset(id);
    onChange({ ...value, ...presetRange(id) });
  };

  const reset = () => {
    setPreset(null);
    onReset();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-4 py-2">
      <div
        role="group"
        aria-label={tr('快捷时间范围', 'Quick time ranges')}
        className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
      >
        {PRESETS.map((item) => {
          const active = preset === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => applyPreset(item.id)}
              className={cn(
                'rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
                active ? 'bg-card font-medium text-text shadow-sm' : 'text-text-muted hover:text-text',
              )}
            >
              {tr(item.zh, item.en)}
            </button>
          );
        })}
      </div>

      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

      <div className="flex items-center gap-1.5">
        <label htmlFor="history-start" className="text-[11px] text-text-faint">
          {tr('开始', 'From')}
        </label>
        <Input
          id="history-start"
          type="datetime-local"
          value={value.start}
          onChange={(event) => update({ start: event.target.value })}
          className="w-48"
        />
      </div>
      <span className="text-[11px] text-text-faint">{tr('至', 'to')}</span>
      <div className="flex items-center gap-1.5">
        <label htmlFor="history-end" className="text-[11px] text-text-faint">
          {tr('结束', 'To')}
        </label>
        <Input
          id="history-end"
          type="datetime-local"
          value={value.end}
          onChange={(event) => update({ end: event.target.value })}
          className="w-48"
        />
      </div>

      <Select
        label={tr('用户', 'User')}
        value={value.uid}
        onValueChange={(uid) => update({ uid })}
        options={[
          { value: '', label: tr('全部用户', 'Every user') },
          ...users.map((user) => ({
            value: String(user.id),
            label: user.display_name || user.email || `#${user.id}`,
          })),
        ]}
        searchable
        className="w-32"
      />
      <Select
        label={tr('模型', 'Model')}
        value={value.typeID}
        onValueChange={(typeID) => update({ typeID })}
        options={[
          { value: '', label: tr('全部模型', 'Every model') },
          ...models.map((model) => ({ value: String(model.id), label: model.alias || model.name })),
        ]}
        searchable
        className="w-32"
      />
      <Select
        label={tr('操作', 'Action')}
        value={value.operate}
        onValueChange={(operate) => update({ operate })}
        options={[{ value: '', label: tr('全部操作', 'Every action') }, ...operateOptions]}
        className="w-28"
      />

      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={reset}
        className="ms-auto inline-flex items-center gap-1.5"
      >
        <RotateCcw size={12} aria-hidden="true" />
        {tr('重置', 'Reset')}
      </Button>
    </div>
  );
}

/**
 * Converts a `datetime-local` value to an RFC 3339 instant.
 *
 * THE PICKER IS A WALL CLOCK WITH NO ZONE, and the server compares instants.
 * `new Date('2026-10-26T00:00')` reads that wall clock in the browser's zone,
 * and toISOString() states which instant that is; sending the bare wall clock
 * made a UTC+8 operator filter the UTC day instead of their own.
 */
export function toAPITime(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}
