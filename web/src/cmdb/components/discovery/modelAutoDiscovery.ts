import type { Rule, Target, TargetRelation, TargetRelationInput, TargetSyncHistory } from '../../api/discovery';

// The model-level auto-discovery editor's pure parts.
//
// THE MAPPING AND THE RELATION SET ARE BOTH FULL REPLACES. Keeping their
// conversion out of the component makes the rules testable without a browser:
// which provider fields a target offers, what an empty mapping row means, and
// which relation rows the backend will refuse.

/** A target's stored `provider field → model attribute` mapping, as strings. */
export function targetMapping(target: Target | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(target?.attributes ?? {})) {
    out[key] = String(value ?? '');
  }
  return out;
}

/**
 * Every provider field a target can map.
 *
 * THE RULE'S FIELDS COME FIRST, because that is the provider's own order and
 * the one an operator expects. The catalogue follows (a cloud resource's
 * fields are not on the rule), then what other targets of this model already
 * reported, then the keys this target has stored — the last group is what
 * keeps an old mapping editable after a rule loses its field list.
 */
export function mappingKeys(
  rule: Rule | null,
  target: Target | null,
  catalogKeys: string[],
  discoverableKeys: string[],
  extraKeys: string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string | undefined | null) => {
    const key = value?.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };
  for (const field of rule?.attributes ?? []) add(field.name);
  for (const key of catalogKeys) add(key);
  for (const key of Object.keys(target?.attributes ?? {})) add(key);
  for (const key of extraKeys) add(key);
  for (const key of discoverableKeys) add(key);
  return out;
}

/** The write payload: an empty selection is an unmapping, not a mapping to "". */
export function mappingPayload(mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    const attr = value.trim();
    if (attr) out[key] = attr;
  }
  return out;
}

/** Whether the model's identifying attribute appears among the mapped values. */
export function uniqueMapped(mapping: Record<string, string>, uniqueKey: string): boolean {
  if (!uniqueKey) return true;
  return Object.values(mapping).some((value) => value.trim() === uniqueKey);
}

/**
 * A stable identity for a mapping, for "has this form changed?".
 *
 * KEY ORDER IS NOT A CHANGE. The editor builds its rows from a rule, a
 * catalogue and stored keys, so two equal mappings can enumerate their entries
 * in different orders; sorting makes the comparison say what it means.
 */
export function mappingSignature(mapping: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(mapping)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value !== '')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function sameMapping(left: Record<string, string>, right: Record<string, string>): boolean {
  return mappingSignature(left) === mappingSignature(right);
}

export type EditableRelation = {
  key: string;
  adKey: string;
  peerTypeID: string;
  peerAttrID: string;
};

export type RelationPayload = {
  relations: TargetRelationInput[];
  error: 'incomplete' | 'duplicate' | null;
};

/**
 * The relation set as the API returns it, in editable string form.
 *
 * The select components speak strings; keeping the editable row string-valued
 * avoids a second conversion in every `onValueChange`.
 */
export function editableRelations(rows: TargetRelation[], makeKey: () => string): EditableRelation[] {
  if (rows.length === 0) return [{ key: makeKey(), adKey: '', peerTypeID: '', peerAttrID: '' }];
  return rows.map((row) => ({
    key: makeKey(),
    adKey: row.ad_key ?? '',
    peerTypeID: row.peer_type_id ? String(row.peer_type_id) : '',
    peerAttrID: row.peer_attr_id ? String(row.peer_attr_id) : '',
  }));
}

/**
 * The replace payload.
 *
 * A FULLY BLANK ROW IS IGNORED because the editor always keeps one row open for
 * the next relation. A HALF-FILLED ROW IS AN ERROR: the backend refuses it, and
 * silently dropping it would make Save report a success that saved less than
 * the operator saw.
 */
export function relationPayload(rows: EditableRelation[]): RelationPayload {
  const seen = new Set<string>();
  const relations: TargetRelationInput[] = [];
  for (const row of rows) {
    const adKey = row.adKey.trim();
    const peerTypeID = Number(row.peerTypeID);
    const peerAttrID = Number(row.peerAttrID);
    if (!adKey && !peerTypeID && !peerAttrID) continue;
    if (!adKey || !Number.isFinite(peerTypeID) || peerTypeID <= 0 || !Number.isFinite(peerAttrID) || peerAttrID <= 0) {
      return { relations: [], error: 'incomplete' };
    }
    const key = `${adKey}\u0000${peerTypeID}\u0000${peerAttrID}`;
    if (seen.has(key)) return { relations: [], error: 'duplicate' };
    seen.add(key);
    relations.push({ ad_key: adKey, peer_type_id: peerTypeID, peer_attr_id: peerAttrID });
  }
  return { relations, error: null };
}

/** The newest handover record, or null when this target has never been pulled. */
export function latestSync(histories: TargetSyncHistory[]): TargetSyncHistory | null {
  let newest: TargetSyncHistory | null = null;
  let newestAt = -Infinity;
  for (const row of histories) {
    const at = syncTime(row);
    if (at != null && at > newestAt) {
      newest = row;
      newestAt = at;
    }
  }
  return newest;
}

/**
 * A CMDB timestamp in milliseconds.
 *
 * THE BACKEND FORMATS TIMES AS `YYYY-MM-DD HH:mm:ss`, which Safari does not
 * parse as a date. The space is replaced by `T`, the same normalization the
 * rest of the console uses for CMDB timestamps.
 */
export function cmdbTimeValue(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const at = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T')).getTime();
  return Number.isNaN(at) ? null : at;
}

export function syncTime(row: TargetSyncHistory): number | null {
  return cmdbTimeValue(row.sync_at || row.created_at);
}
