import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useI18n } from '@/i18n/locale';

import type { CIType, TypeAttribute } from '../../api/citype';
import { escapeValue } from '../../lib/dsl';
import { choiceText } from '../../lib/choice-labels';
import { referenceLabel } from '../../lib/reference-labels';
import { searchInstances } from '../../api/instance';

// A lazy facet tree over a model's configured hierarchy levels.
//
// EACH LEVEL IS ONE FACET QUERY: the parent path is folded into the expression,
// and only the next level's values are aggregated. Nothing is preloaded, so a
// model with ten thousand distinct hostnames does not build a ten-thousand-node
// tree before the first click.
//
// FACET VALUES ARE STORED CODES. A choice level stores `critical`, and a
// reference level stores the target instance's id (2352), which is not a word
// an operator can use. Choice labels come from the attribute dictionary; the
// ids of a reference level are resolved once per sibling list through the
// search endpoint, so the tree reads as 黄金 → 业务系统 instead of
// 2352 → 3785. The raw value stays in the title and remains the query value.

export type FacetEntry = { value: string; count: number };

const LABEL_BATCH_SIZE = 100;

export function treeQuery(typeID: number, levels: TypeAttribute[], path: string[]): string {
  // THE VALUE IS DATA, not query syntax: a comma in a hierarchy value must not
  // become the next term. dsl.ts owns the escape rule for every other clause.
  return `_type:${typeID}` + path.map((value, index) => `,${levels[index]?.name ?? ''}:${escapeValue(value)}`).join('');
}

function pathKey(path: string[]): string {
  return path.join('\u0000');
}

function useEntries(
  typeID: number,
  levels: TypeAttribute[],
  path: string[],
  enabled: boolean,
): { entries: FacetEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<FacetEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const field = levels[path.length]?.name;
  const key = pathKey(path);

  useEffect(() => {
    if (!enabled || !field) {
      setEntries([]);
      return;
    }
    let live = true;
    setLoading(true);
    void searchInstances({ q: treeQuery(typeID, levels, path), facet: [field], count: 1 })
      .then((page) => {
        if (!live) return;
        const buckets = page.facet?.[field] ?? [];
        setEntries(buckets.map(([value, count]) => ({ value: String(value), count })));
      })
      .catch(() => live && setEntries([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // `key` is the stable identity of `path`; `levels` is the view's array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeID, levels, key, field, enabled]);

  return { entries, loading };
}

/**
 * The display label for a facet's stored value.
 *
 * Pure for choice and plain levels; reference ids are looked up in `labels`.
 * An unresolved reference keeps the raw id, the same fallback the resource
 * tables use when a target no longer exists.
 */
function labelFor(
  attribute: TypeAttribute | undefined,
  value: string,
  labels: ReadonlyMap<string, string>,
): string {
  if (!attribute) return value;
  if (attribute.is_choice) return choiceText(attribute, value) ?? value;
  if (attribute.is_reference) return labels.get(value) ?? value;
  return value;
}

/** One batch per sibling list: the ids shown at this level, not the whole model. */
function useFacetLabels(
  attribute: TypeAttribute | undefined,
  entries: FacetEntry[],
  models: CIType[] | undefined,
): ReadonlyMap<string, string> {
  const [labels, setLabels] = useState<Map<string, string>>(() => new Map());
  const referenceTypeID = attribute?.is_reference ? attribute.reference_type_id : undefined;
  const values = useMemo(() => entries.map((entry) => entry.value), [entries]);
  // The joined values are the stable identity; `values` itself is derived from
  // the entries array and would re-run the effect on every parent render.
  const key = values.join('\u0000');

  useEffect(() => {
    if (!referenceTypeID || values.length === 0) {
      setLabels(new Map());
      return;
    }
    const ids = [
      ...new Set(
        values
          .map((value) => Number(value))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ];
    if (ids.length === 0) {
      setLabels(new Map());
      return;
    }
    const target = models?.find((model) => model.id === referenceTypeID);
    let live = true;
    void (async () => {
      const next = new Map<string, string>();
      for (let offset = 0; offset < ids.length; offset += LABEL_BATCH_SIZE) {
        const chunk = ids.slice(offset, offset + LABEL_BATCH_SIZE);
        try {
          const got = await searchInstances({
            q: `_id:(${chunk.join(';')})`,
            count: chunk.length,
            page: 1,
          });
          for (const row of got.result ?? []) {
            const id = Number(row.ci_id ?? row._id);
            if (!Number.isSafeInteger(id)) continue;
            const label = referenceLabel(row, target);
            if (label) next.set(String(id), label);
          }
        } catch {
          // A failed label lookup leaves the raw value in place; the facet
          // query itself still works.
        }
      }
      if (live) setLabels(next);
    })();
    return () => {
      live = false;
    };
    // `key` is the stable identity of `values`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, referenceTypeID, models]);

  return labels;
}

function FacetEntryList({
  typeID,
  levels,
  path,
  pathLabels,
  entries,
  selected,
  onSelect,
  models,
}: {
  typeID: number;
  levels: TypeAttribute[];
  path: string[];
  pathLabels: string[];
  entries: FacetEntry[];
  selected: string[];
  onSelect(path: string[], labels: string[]): void;
  models?: CIType[];
}) {
  const attribute = levels[path.length];
  const labels = useFacetLabels(attribute, entries, models);
  return (
    <ul className="min-w-0">
      {entries.map((entry) => {
        const label = labelFor(attribute, entry.value, labels);
        const nodePath = [...path, entry.value];
        const nodeLabels = [...pathLabels, label];
        return (
          <FacetNode
            key={entry.value}
            typeID={typeID}
            levels={levels}
            path={nodePath}
            pathLabels={nodeLabels}
            count={entry.count}
            label={label}
            rawValue={entry.value}
            selected={selected}
            onSelect={onSelect}
            models={models}
          />
        );
      })}
    </ul>
  );
}

function FacetNode({
  typeID,
  levels,
  path,
  pathLabels,
  count,
  label,
  rawValue,
  selected,
  onSelect,
  models,
}: {
  typeID: number;
  levels: TypeAttribute[];
  path: string[];
  pathLabels: string[];
  count: number;
  label: string;
  rawValue: string;
  selected: string[];
  onSelect(path: string[], labels: string[]): void;
  models?: CIType[];
}) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const { entries, loading } = useEntries(typeID, levels, path, open);
  const isLeaf = path.length >= levels.length;
  const isSelected = pathKey(path) === pathKey(selected);

  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={isLeaf ? undefined : open}
        onClick={() => {
          onSelect(path, pathLabels);
          if (!isLeaf) setOpen(true);
        }}
        title={label !== rawValue ? `${label} (${rawValue})` : label}
        className={cn(
          'group flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors',
          isSelected
            ? 'bg-indigo-500/10 font-medium text-indigo-300'
            : 'text-text hover:bg-card',
        )}
      >
        {isLeaf ? (
          <span className="w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight
            size={12}
            className={cn('shrink-0 text-text-faint transition-transform', open && 'rotate-90')}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-start">{label}</span>
        <span className="shrink-0 text-[11px] text-text-faint">{count}</span>
        {loading && <Loader2 size={11} className="shrink-0 animate-spin text-text-faint" aria-hidden="true" />}
      </button>
      {open && !isLeaf && (
        <div className="ms-4 border-s border-border/60 ps-1">
          {loading && entries.length === 0 ? (
            <p className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-faint">
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {tr('加载中…', 'Loading…')}
            </p>
          ) : entries.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-text-faint">{tr('没有下一层', 'No next level')}</p>
          ) : (
            <FacetEntryList
              typeID={typeID}
              levels={levels}
              path={path}
              pathLabels={pathLabels}
              entries={entries}
              selected={selected}
              onSelect={onSelect}
              models={models}
            />
          )}
        </div>
      )}
    </li>
  );
}

export function FacetTree({
  typeID,
  levels,
  selected,
  onSelect,
  models,
}: {
  typeID: number;
  levels: TypeAttribute[];
  selected: string[];
  onSelect(path: string[], labels: string[]): void;
  /** Reference levels are resolved against these models' display fields. */
  models?: CIType[];
}) {
  const { tr } = useI18n();
  const { entries, loading } = useEntries(typeID, levels, [], true);

  if (!levels.length) {
    return <p className="px-2 py-4 text-xs text-text-muted">{tr('这个模型还没有层级', 'This model has no levels')}</p>;
  }
  if (loading && entries.length === 0) {
    return (
      <p className="flex items-center gap-1.5 px-2 py-4 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        {tr('加载中…', 'Loading…')}
      </p>
    );
  }
  if (entries.length === 0) {
    return <p className="px-2 py-4 text-xs text-text-muted">{tr('没有可用的层级值', 'No values at this level')}</p>;
  }
  return (
    <FacetEntryList
      typeID={typeID}
      levels={levels}
      path={[]}
      pathLabels={[]}
      entries={entries}
      selected={selected}
      onSelect={onSelect}
      models={models}
    />
  );
}
