import { useMemo, useState } from 'react';
import { Boxes, ChevronDown, Search } from 'lucide-react';

import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/Popover';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { CIType } from '../api/citype';
import { CMDBIcon } from './CMDBIcon';

/**
 * Multi-model scope for resource search.
 *
 * Cantor grouped the picker by read-scoped model groups. The console already
 * has a model-group rail on resource pages; for a search toolbar a flat,
 * searchable list is easier to scan and keeps the control small. Selection is
 * by model name because that is what the query language's `_type:` term uses.
 */
export function ModelMultiSelect({
  models,
  selected,
  onChange,
}: {
  models: CIType[];
  selected: string[];
  onChange(next: string[]): void;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');

  const ordered = useMemo(
    () => [...models].sort((left, right) => (left.alias || left.name).localeCompare(right.alias || right.name)),
    [models],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ordered;
    return ordered.filter((model) =>
      `${model.alias} ${model.name}`.toLowerCase().includes(needle),
    );
  }, [ordered, query]);

  const chosen = useMemo(() => new Set(selected), [selected]);
  const selectedModels = ordered.filter((model) => chosen.has(model.name));
  const label =
    selectedModels.length === 0
      ? tr('全部模型', 'All models')
      : selectedModels.length === 1
        ? selectedModels[0].alias || selectedModels[0].name
        : tr(`${selectedModels.length} 个模型`, `${selectedModels.length} models`);

  const toggle = (name: string) => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(ordered.filter((model) => next.has(model.name)).map((model) => model.name));
  };

  return (
    <Popover>
      <PopoverTrigger
        aria-label={tr('选择模型', 'Select models')}
        className={cn(
          'flex h-9 min-w-44 max-w-64 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs text-text transition-colors',
          'hover:bg-card/80 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
        )}
      >
        <Boxes size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {selectedModels.length > 0 && (
          <span className="shrink-0 rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[10px] leading-none text-indigo-400">
            {selectedModels.length}
          </span>
        )}
        <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" aria-label={tr('选择模型', 'Select models')}>
        <PopoverTitle className="sr-only">{tr('选择模型', 'Select models')}</PopoverTitle>
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden="true" />
            <Input
              type="search"
              aria-label={tr('搜索模型', 'Search models')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr('搜索模型…', 'Search models…')}
              className="pl-7"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-card">
            <Checkbox
              checked={selectedModels.length === 0}
              onCheckedChange={() => onChange([])}
              aria-label={tr('全部模型', 'All models')}
            />
            <span className="flex-1 text-left text-text">{tr('全部模型', 'All models')}</span>
          </label>
          {filtered.map((model) => (
            <label
              key={model.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-card"
            >
              <Checkbox
                checked={chosen.has(model.name)}
                onCheckedChange={() => toggle(model.name)}
                aria-label={model.alias || model.name}
              />
              <CMDBIcon value={model.icon} size={14} label={model.alias || model.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-text">{model.alias || model.name}</span>
                <span className="block truncate font-mono text-[10px] text-text-faint">{model.name}</span>
              </span>
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-text-muted">{tr('没有匹配的模型', 'No matching models')}</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border p-2">
          <span className="text-[11px] text-text-faint">
            {selectedModels.length === 0
              ? tr('搜索全部可读模型', 'Search every readable model')
              : tr(`已选 ${selectedModels.length} 个`, `${selectedModels.length} selected`)}
          </span>
          <PopoverClose className="rounded px-2 py-1 text-xs text-text-muted transition-colors hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500">
            {tr('完成', 'Done')}
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}
