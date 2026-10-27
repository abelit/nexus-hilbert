import { useEffect, useMemo, useState } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { Check, ChevronDown, Search, X } from 'lucide-react';

import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { CIType, TypeAttribute } from '../api/citype';
import { describeError } from '../api/http';
import { searchInstances, type SearchRow } from '../api/instance';
import type { ReferenceLabels } from '../lib/reference-labels';
import { referenceID, referenceLabel } from '../lib/reference-labels';
import { displayValue, isEmptyValue } from '../lib/valuetype';

// A reference is an id in the value tables, but an operator edits the thing the
// id points at. This picker searches the referenced model through the same
// `/ci/s` endpoint as 资源搜索, so it works for models with thousands of rows
// instead of preloading every instance into a select.

type Option = { value: string; label: string };

const PAGE_SIZE = 20;
const SEARCH_DELAY = 250;

function selectedIDs(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => referenceID(item))
    .filter((id): id is number => id !== null);
}

function queryFor(typeID: number, needle: string): string {
  const text = needle
    .trim()
    // A comma separates terms and a trailing backslash escapes one; the
    // picker's text is a value, not an expression.
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,');
  return text ? `_type:${typeID},*${text}*` : `_type:${typeID}`;
}

function optionFromHit(hit: SearchRow, model: CIType): Option {
  const label = referenceLabel(hit, model) || `#${hit._id}`;
  return { value: String(hit._id), label };
}

export function ReferencePicker({
  id,
  attribute,
  target,
  labels,
  value,
  onChange,
  disabled = false,
  required = false,
  placeholder,
}: {
  id: string;
  attribute: TypeAttribute;
  target: CIType;
  labels: ReferenceLabels;
  value: unknown;
  onChange(next: unknown): void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  const { tr } = useI18n();
  const multiple = attribute.is_list;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Option[]>([]);
  const [known, setKnown] = useState<Map<number, string>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = useMemo(() => selectedIDs(value), [value]);
  // `labels` and `known` both change the rendered label; `ids` decides which
  // rows are selected.
  const selected = useMemo(
    () =>
      ids.map((ciID) => ({
        value: String(ciID),
        label: labels.get(ciID) ?? known.get(ciID) ?? `#${ciID}`,
      })),
    [ids, labels, known],
  );

  // The current value stays in the list even when the remote query no longer
  // returns it, so a single-select trigger keeps its label while results load.
  const options = useMemo(() => {
    const seen = new Set(results.map((option) => option.value));
    return [...results, ...selected.filter((option) => !seen.has(option.value))];
  }, [results, selected]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void searchInstances(
        { q: queryFor(Number(target.id), search), count: PAGE_SIZE, page: 1 },
        controller.signal,
      )
        .then((page) => {
          if (controller.signal.aborted) return;
          const next = page.result.map((hit) => optionFromHit(hit, target));
          setResults(next);
          setKnown((current) => {
            const merged = new Map(current);
            for (const option of next) merged.set(Number(option.value), option.label);
            return merged;
          });
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setError(describeError(cause, tr('无法搜索引用实例', 'Could not search referenced instances')));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, search.trim() ? SEARCH_DELAY : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, search, target, tr]);

  const remember = (next: Option[]) => {
    setKnown((current) => {
      const merged = new Map(current);
      for (const option of next) merged.set(Number(option.value), option.label);
      return merged;
    });
  };

  const handleValueChange = (next: Option | Option[] | null) => {
    if (multiple) {
      const list = Array.isArray(next) ? next : [];
      remember(list);
      onChange(list.map((option) => Number(option.value)));
      return;
    }
    if (!next || Array.isArray(next)) {
      onChange(null);
      return;
    }
    remember([next]);
    onChange(Number(next.value));
  };

  const selectedValue = multiple ? selected : selected[0] ?? null;
  const hasValue = selected.length > 0;
  const legacy =
    !hasValue && !isEmptyValue(value) ? displayValue(value) : '';
  const triggerText =
    selected.length > 0 ? selected.map((option) => option.label).join(', ') : legacy || placeholder || '';
  const fieldLabel = attribute.alias || attribute.name;

  return (
    <Combobox.Root
      id={id}
      items={options}
      value={selectedValue}
      onValueChange={handleValueChange}
      onInputValueChange={(next, details) => {
        if (details.isItemPress) {
          // In multiple mode the popup must stay open after a pick; in single
          // mode the selected label replaces the filter.
          if (multiple) details.cancel();
          return;
        }
        setSearch(next);
      }}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
      itemToStringLabel={(option: Option) => option.label}
      isItemEqualToValue={(left: Option, right: Option) => left.value === right.value}
      multiple={multiple}
      filter={null}
      autoHighlight
      disabled={disabled}
    >
      <div className="relative min-w-0">
        <Combobox.Trigger
          aria-label={fieldLabel}
          aria-required={required || undefined}
          className={cn(
            'og-select-trigger w-full pr-14',
            !triggerText && 'text-text-faint',
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{triggerText}</span>
          <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
        </Combobox.Trigger>
        {hasValue && (
          <Combobox.Clear
            aria-label={tr('清除选择', 'Clear selection')}
            className="absolute right-8 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-text-faint hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
          >
            <X size={12} aria-hidden="true" />
          </Combobox.Clear>
        )}
      </div>

      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start" className="og-select-positioner">
          <Combobox.Popup
            className="og-select-popup"
            aria-label={tr(`选择${fieldLabel}`, `Select ${fieldLabel}`)}
            aria-busy={loading || undefined}
          >
            <div className="og-select-search">
              <Search size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
              <Combobox.Input
                aria-label={tr(`搜索${fieldLabel}`, `Search ${fieldLabel}`)}
                placeholder={tr('搜索并选择…', 'Search and select…')}
              />
            </div>
            <Combobox.Status>
              {loading ? (
                <div className="px-3 py-2 text-xs text-text-muted">{tr('搜索中…', 'Searching…')}</div>
              ) : error ? (
                <div role="alert" className="px-3 py-2 text-xs text-red-500 dark:text-red-300">
                  {error}
                </div>
              ) : null}
            </Combobox.Status>
            <Combobox.Empty>
              {!loading && !error ? (
                <div className="px-3 py-5 text-center text-xs text-text-muted">
                  {tr('没有匹配项', 'No results found')}
                </div>
              ) : null}
            </Combobox.Empty>
            <Combobox.List className="og-select-list">
              {(option: Option) => (
                <Combobox.Item key={option.value} value={option} className="og-select-item">
                  <span className="min-w-0 flex-1 break-words">{option.label}</span>
                  <Combobox.ItemIndicator className="absolute right-2">
                    <Check size={14} aria-hidden="true" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
