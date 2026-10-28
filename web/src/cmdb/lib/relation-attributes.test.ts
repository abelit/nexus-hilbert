import { describe, expect, it } from 'vitest';

import type { TypeAttribute } from '../api/citype';
import { relationAttributeCandidates } from './relation-attributes';

const attribute = (id: number, name: string, extra: Partial<TypeAttribute> = {}): TypeAttribute =>
  ({
    id,
    name,
    alias: name,
    value_type: '2',
    is_index: true,
    is_list: false,
    is_password: false,
    is_bool: false,
    is_reference: false,
    is_choice: false,
    is_unique: false,
    is_sortable: false,
    is_computed: false,
    is_required: false,
    order: id,
    default_show: true,
    inherited: false,
    ...extra,
  }) as TypeAttribute;

describe('relation attribute candidates', () => {
  it('drops unindexed text, secrets, JSON, booleans and references', () => {
    const attributes = [
      attribute(1, 'hostname'),
      attribute(2, 'note', { is_index: false }),
      attribute(3, 'secret', { is_password: true }),
      attribute(4, 'metadata', { value_type: '6' }),
      attribute(5, 'enabled', { value_type: '7', is_bool: true }),
      attribute(6, 'owner', { is_reference: true }),
    ];
    expect(relationAttributeCandidates(attributes, '', [], 'source', '0').map((row) => row.name)).toEqual([
      'hostname',
    ]);
  });

  it('keeps only the opposite side’s value type', () => {
    const target = [attribute(10, 'serial', { value_type: '2' }), attribute(11, 'port', { value_type: '0' })];
    expect(
      relationAttributeCandidates(target, '1', [attribute(1, 'hostname', { value_type: '2' })], 'target', '0').map(
        (row) => row.name,
      ),
    ).toEqual(['serial']);
  });

  it('applies the constraint’s list rules', () => {
    const values = [attribute(1, 'plain'), attribute(2, 'many', { is_list: true })];
    // One-to-many forbids lists on the target side only.
    expect(relationAttributeCandidates(values, '', [], 'source', '0').map((row) => row.name)).toEqual(['plain', 'many']);
    expect(relationAttributeCandidates(values, '', [], 'target', '0').map((row) => row.name)).toEqual(['plain']);
    // One-to-one forbids them on both sides.
    expect(relationAttributeCandidates(values, '', [], 'source', '1').map((row) => row.name)).toEqual(['plain']);
    expect(relationAttributeCandidates(values, '', [], 'target', '1').map((row) => row.name)).toEqual(['plain']);
    // Many-to-many forbids them only when the opposite side is a list.
    expect(relationAttributeCandidates(values, '9', [attribute(9, 'peers', { is_list: true })], 'source', '2').map((row) => row.name)).toEqual(['plain']);
  });
});
