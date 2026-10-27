import { useEffect, useMemo, useState } from 'react';

import type { CIType, TypeAttribute } from '../api/citype';
import { searchInstances, type SearchRow } from '../api/instance';
import { displayValue, isEmptyValue } from './valuetype';

// Reference values are CI ids in the EAV tables. Printing the id makes an
// operator memorize the referenced model; the list should show the instance's
// own display name and keep the id available as the title.
//
// ONE BATCH PER REFERENCED MODEL. A page of twenty products can reference
// members, SLA and resource categories; resolving each cell with `GET
// /instances/{id}` would turn one page into hundreds of requests. The search
// endpoint already accepts an `_id:(…)` restriction, so the page asks once per
// target model and maps the hits back by CI id.

export type ReferenceLabels = Map<number, string>;

const BATCH_SIZE = 100;

type RowLike = { values?: Record<string, unknown> | null };

export function referenceID(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Group the ids a page references by the model each attribute points at. */
export function collectReferenceIDs(
  rows: readonly RowLike[],
  attributes: readonly TypeAttribute[],
): Map<number, Set<number>> {
  const groups = new Map<number, Set<number>>();
  const references = attributes.filter(
    (attribute) => attribute.is_reference && (attribute.reference_type_id ?? 0) > 0,
  );
  if (references.length === 0) return groups;

  for (const row of rows) {
    for (const attribute of references) {
      const typeID = attribute.reference_type_id;
      if (!typeID) continue;
      const raw = row.values?.[attribute.name];
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        const id = referenceID(value);
        if (id === null) continue;
        let ids = groups.get(typeID);
        if (!ids) {
          ids = new Set();
          groups.set(typeID, ids);
        }
        ids.add(id);
      }
    }
  }
  return groups;
}

/** The name the referenced model itself would use for one of its instances. */
export function referenceLabel(row: SearchRow, model?: CIType): string {
  const keys = new Set(
    [model?.show_name, model?.unique_key, 'name', 'alias'].filter(
      (key): key is string => Boolean(key),
    ),
  );
  for (const key of keys) {
    const value = row[key];
    if (isEmptyValue(value)) continue;
    const text = displayValue(value).trim();
    if (text) return text;
  }
  return '';
}

/**
 * Render a stored reference for display.
 *
 * `undefined` means "not resolved" so the caller keeps its normal raw-value
 * path. A missing target stays visible as the id rather than disappearing from
 * the row.
 */
export function referenceText(value: unknown, labels: ReferenceLabels): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  const parts: string[] = [];
  let resolved = false;
  for (const item of values) {
    if (isEmptyValue(item)) continue;
    const id = referenceID(item);
    const label = id === null ? undefined : labels.get(id);
    if (label) {
      parts.push(label);
      resolved = true;
    } else {
      parts.push(displayValue(item));
    }
  }
  return resolved && parts.length > 0 ? parts.join(', ') : undefined;
}

/** The raw stored values, used for a title while the name is what is visible. */
export function referenceRawText(value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item) => !isEmptyValue(item)).map(displayValue).join(', ');
}

function groupsKey(groups: ReadonlyMap<number, ReadonlySet<number>>): string {
  return JSON.stringify(
    [...groups]
      .map(([typeID, ids]) => [typeID, [...ids].sort((left, right) => left - right)])
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
}

export async function resolveReferenceLabels(
  groups: ReadonlyMap<number, ReadonlySet<number>>,
  models: readonly CIType[],
  signal?: AbortSignal,
): Promise<ReferenceLabels> {
  const labels: ReferenceLabels = new Map();
  await Promise.all(
    [...groups].map(async ([typeID, ids]) => {
      const model = models.find((candidate) => Number(candidate.id) === Number(typeID));
      if (!model) return;
      const list = [...ids];
      for (let offset = 0; offset < list.length; offset += BATCH_SIZE) {
        const chunk = list.slice(offset, offset + BATCH_SIZE);
        const page = await searchInstances(
          {
            q: `_type:${model.id},_id:(${chunk.join(';')})`,
            count: chunk.length,
            page: 1,
          },
          signal,
        );
        for (const hit of page.result) {
          const label = referenceLabel(hit, model);
          if (label) labels.set(hit._id, label);
        }
      }
    }),
  );
  return labels;
}

/** Resolve every reference on the given page, re-running when the page changes. */
export function useReferenceLabels(
  rows: readonly RowLike[],
  attributes: readonly TypeAttribute[],
  models: readonly CIType[],
): ReferenceLabels {
  const groups = useMemo(() => collectReferenceIDs(rows, attributes), [rows, attributes]);
  // The caller may hand us a fresh `[instance]` array on every render. Key the
  // request on the ids themselves, not on the array's identity, or the effect
  // would refetch, set state and render again forever.
  const key = useMemo(() => groupsKey(groups), [groups]);
  const [labels, setLabels] = useState<ReferenceLabels>(() => new Map());

  useEffect(() => {
    const parsed: Array<[number, number[]]> = JSON.parse(key);
    if (parsed.length === 0) {
      setLabels((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    const pending = new Map(parsed.map(([typeID, ids]) => [typeID, new Set(ids)]));
    let live = true;
    const controller = new AbortController();
    void resolveReferenceLabels(pending, models, controller.signal)
      .then((got) => {
        if (live) setLabels(got);
      })
      .catch(() => {
        // A reference label is an enhancement: a failed lookup must leave the
        // stored id visible, not break the instance page.
        if (live) setLabels(new Map());
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [key, models]);

  return labels;
}
