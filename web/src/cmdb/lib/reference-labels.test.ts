import { describe, expect, it } from 'vitest';

import type { CIType, TypeAttribute } from '../api/citype';
import type { Instance, SearchRow } from '../api/instance';
import { collectReferenceIDs, referenceLabel, referenceText } from './reference-labels';

const attribute = (id: number, name: string, extra: Partial<TypeAttribute> = {}): TypeAttribute =>
  ({
    id,
    name,
    alias: name,
    value_type: '0',
    is_choice: false,
    is_list: false,
    is_unique: false,
    is_index: false,
    is_link: false,
    is_password: false,
    is_sortable: false,
    is_dynamic: false,
    is_bool: false,
    is_file: false,
    is_reference: true,
    is_computed: false,
    has_compute_script: false,
    has_choice_web_hook: false,
    has_choice_other: false,
    is_indexed: false,
    storage_table: 'c_value_index_ints',
    ...extra,
  }) as TypeAttribute;

const model = (extra: Partial<CIType>): CIType =>
  ({
    id: 1,
    name: 'host',
    alias: '主机',
    enabled: true,
    is_attached: true,
    order: 0,
    parent_ids: [],
    ...extra,
  }) as CIType;

const instance = (ciID: number, values: Record<string, unknown>): Instance => ({
  ci_id: ciID,
  type_id: 1,
  values,
});

describe('reference labels', () => {
  it('collects numeric reference ids once, grouped by the referenced model', () => {
    const attributes = [
      attribute(1, 'ops_owner', { reference_type_id: 54 }),
      attribute(2, 'sla', { reference_type_id: 97 }),
      attribute(3, 'hostname', { is_reference: false }),
    ];
    const groups = collectReferenceIDs(
      [
        instance(1, { ops_owner: 374, sla: '2353', hostname: 'web-01' }),
        instance(2, { ops_owner: ['374', 375, ''], sla: null }),
      ],
      attributes,
    );
    expect([...groups.get(54) ?? []]).toEqual([374, 375]);
    expect([...groups.get(97) ?? []]).toEqual([2353]);
    expect(groups.has(1)).toBe(false);
  });

  it('uses the referenced model show name before its unique key', () => {
    const members = model({ id: 54, name: 'members', unique_key: 'userid', show_name: 'name' });
    const sla = model({ id: 97, name: 'sla', unique_key: 'uuid', show_name: 'alias' });
    const row = (values: Record<string, unknown>): SearchRow => ({
      _id: 1,
      _type: 54,
      ci_id: 1,
      ci_type: 'members',
      ...values,
    });
    expect(referenceLabel(row({ name: '何忠贵', userid: 'A01492' }), members)).toBe('何忠贵');
    expect(referenceLabel(row({ name: '', userid: 'A01492' }), members)).toBe('A01492');
    expect(referenceLabel(row({ alias: '白银', name: 'silver' }), sla)).toBe('白银');
  });

  it('turns stored ids into names and leaves a missing reference visible as its id', () => {
    const labels = new Map<number, string>([
      [374, '何忠贵'],
      [2353, '白银'],
    ]);
    expect(referenceText(374, labels)).toBe('何忠贵');
    expect(referenceText([374, 999], labels)).toBe('何忠贵, 999');
    expect(referenceText('2353', labels)).toBe('白银');
    expect(referenceText('silver', labels)).toBeUndefined();
    expect(referenceText(null, labels)).toBeUndefined();
  });
});
