import type { Instance, SearchRow } from '../api/instance';

// The query string shared by instance pickers. The needle is a VALUE, not an
// expression: commas separate DSL terms and a trailing backslash escapes one,
// so both are escaped before the free-text wildcard is added.
export function instanceSearchQuery(typeID: number | string, needle: string): string {
  const text = needle
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,');
  return text ? `_type:${typeID},*${text}*` : `_type:${typeID}`;
}

// `/ci/s` returns FLAT rows; the resource list renders the nested shape the list
// endpoint returns. The metadata keys are cantor's built-ins, not attributes —
// keeping them would make them appear as searchable "values" and could shadow a
// real attribute named like one of them.
const SEARCH_META_KEYS = new Set([
  '_id',
  '_type',
  'ci_id',
  'ci_type',
  'ci_type_alias',
  'unique',
  'unique_alias',
  '_updated_at',
  '_updated_by',
]);

/** A `/ci/s` hit in the shape the resource list and cards already render. */
export function searchRowToInstance(row: SearchRow): Instance {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!SEARCH_META_KEYS.has(key)) values[key] = value;
  }
  return {
    ci_id: Number(row.ci_id ?? row._id),
    type_id: Number(row._type),
    updated_at: typeof row._updated_at === 'string' ? row._updated_at : undefined,
    updated_by: typeof row._updated_by === 'string' ? row._updated_by : undefined,
    values,
  };
}
