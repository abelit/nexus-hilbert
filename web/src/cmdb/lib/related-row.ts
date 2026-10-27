import type { RelatedType, TypeAttribute } from '../api/citype';
import type { SearchRow } from '../api/instance';
import { displayValue } from './valuetype';

// How one row of a related model reads in the detail drawer. The schema is the
// same EAV shape as resources, so the same rules apply: use the model's display
// attribute, keep the unique key as the subtitle, and pick two useful fields
// for the compact table instead of printing every column.

const KEY_PREFERENCE = [
  'environment',
  'data_status',
  'level',
  'category',
  'code',
  'owner',
  'ops_owner',
  'data_owner',
  'manager',
];

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function relatedRowTitle(row: SearchRow, related: RelatedType): string {
  const keys = unique([
    related.type.show_name,
    related.show_key,
    'name',
    'alias',
    related.type.unique_key,
  ]);
  for (const key of keys) {
    const text = displayValue(row[key]).trim();
    if (text) return text;
  }
  return displayValue(row.ci_type_alias).trim() || `#${row._id}`;
}

export function relatedRowIdentifier(row: SearchRow, related: RelatedType, title = relatedRowTitle(row, related)): string {
  const uniqueKey = related.type.unique_key;
  const value = uniqueKey ? displayValue(row[uniqueKey]).trim() : '';
  return value && value !== title ? value : `#${row._id}`;
}

/** The two fields worth showing beside the resource name in the compact table. */
export function relatedKeyAttributes(related: RelatedType): TypeAttribute[] {
  const displayKeys = new Set(
    unique([related.type.show_name, related.show_key, 'name', 'alias', related.type.unique_key]),
  );
  const candidates = related.attributes.filter(
    (attribute) =>
      !attribute.is_password &&
      attribute.value_type !== '6' &&
      !displayKeys.has(attribute.name),
  );

  const ranked = [...candidates].sort((left, right) => {
    const leftPreferred = KEY_PREFERENCE.indexOf(left.name);
    const rightPreferred = KEY_PREFERENCE.indexOf(right.name);
    const leftScore = leftPreferred === -1 ? 100 : leftPreferred;
    const rightScore = rightPreferred === -1 ? 100 : rightPreferred;
    if (leftScore !== rightScore) return leftScore - rightScore;
    if (left.default_show !== right.default_show) return left.default_show ? -1 : 1;
    return left.order - right.order;
  });

  return ranked.slice(0, 2);
}
