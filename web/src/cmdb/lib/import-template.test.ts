import { describe, expect, it } from 'vitest';

import type { CIType, RelatedType, TypeAttribute } from '../api/citype';
import { attributeHeader, parentTemplates, templateColumns } from './import-template';

function attr(overrides: Partial<TypeAttribute> & Pick<TypeAttribute, 'id' | 'name'>): TypeAttribute {
  return {
    alias: overrides.name,
    value_type: '2',
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
    is_reference: false,
    is_computed: false,
    has_compute_script: false,
    has_choice_web_hook: false,
    has_choice_other: false,
    is_indexed: false,
    storage_table: '',
    is_required: false,
    order: 0,
    default_show: true,
    inherited: false,
    ...overrides,
  } as TypeAttribute;
}

const rack: CIType = {
  id: 2,
  name: 'rack',
  alias: '机柜',
  enabled: true,
  is_attached: true,
  order: 0,
  unique_key: 'rack_code',
  parent_ids: [],
};

function related(type: CIType, attributes: TypeAttribute[], ctrID = 9): RelatedType {
  return {
    ctr_id: ctrID,
    type,
    attributes,
    relation_type: { id: 1, name: 'running_on', color: '#1890ff' },
    constraint: '2',
    parent_attr_ids: [],
    child_attr_ids: [],
  };
}

describe('the import template', () => {
  it('offers only attributes a sheet can write, defaulting a parent to its identifier', () => {
    const rackAttributes = [
      attr({ id: 20, name: 'rack_code', alias: '机柜编号' }),
      attr({ id: 21, name: 'secret', alias: '密码', is_password: true }),
      attr({ id: 22, name: 'tags', alias: '标签', is_list: true }),
    ];
    const [parent] = parentTemplates([related(rack, rackAttributes)]);
    expect(parent.related.type.name).toBe('rack');
    expect(parent.attributes.map((attribute) => attribute.name)).toEqual(['rack_code']);
    expect(parent.defaultAttrID).toBe(20);
  });

  it('writes aliases, falls back to names on collisions, and appends relation columns', () => {
    const attributes = [
      attr({ id: 10, name: 'hostname', alias: '主机名', is_unique: true }),
      attr({
        id: 11,
        name: 'cpu',
        alias: 'CPU',
        is_choice: true,
        choice_value: [{ value: '4' }, { value: '8' }],
      }),
      attr({ id: 12, name: 'cpu_count', alias: 'CPU' }),
    ];
    const parents = parentTemplates([related(rack, [attr({ id: 20, name: 'rack_code', alias: '机柜编号' })])]);
    const columns = templateColumns({
      attributes,
      selectedAttrIDs: [10, 11, 12],
      parents,
      selectedParentIDs: [9],
      parentAttrIDs: { 9: 20 },
    });

    expect(columns.map((column) => column.header)).toEqual([
      '主机名',
      'cpu',
      'cpu_count',
      '$rack.机柜编号',
    ]);
    expect(columns[1].choices).toEqual(['4', '8']);
    expect(columns[3].choices).toBeUndefined();
    expect(columns[3].headerColor).toBe('FFFF0000');
  });

  it('uses the model name in a relation header, not its display alias', () => {
    const parent = related(rack, [attr({ id: 20, name: 'rack_code', alias: '机柜编号' })]);
    expect(attributeHeader(parent.attributes, parent.attributes[0])).toBe('机柜编号');
    expect(
      templateColumns({
        attributes: [attr({ id: 10, name: 'hostname', alias: '主机名' })],
        selectedAttrIDs: [10],
        parents: parentTemplates([parent]),
        selectedParentIDs: [9],
        parentAttrIDs: { 9: 20 },
      })[1].header,
    ).toBe('$rack.机柜编号');
  });
});
