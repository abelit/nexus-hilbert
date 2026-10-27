import { describe, expect, it } from 'vitest';

import type {
  AttributeGroup,
  CIType,
  RelatedType,
  Trigger,
  TypeAttribute,
  UniqueConstraint,
} from '../api/citype';
import { buildModelDefinition } from './model-definition';

const model: CIType = {
  id: 1,
  name: 'host',
  alias: '主机',
  enabled: true,
  is_attached: false,
  icon: 'server$$#6366f1$$false$$',
  order: 2,
  default_order_attr: '-hostname',
  unique_key: 'hostname',
  show_name: 'hostname',
  parent_ids: [9],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
};

function attribute(id: number, name: string, overrides: Partial<TypeAttribute> = {}): TypeAttribute {
  return {
    id,
    name,
    alias: name,
    value_type: '2',
    is_choice: false,
    is_list: false,
    is_unique: false,
    is_index: true,
    is_link: false,
    is_password: false,
    is_sortable: true,
    is_dynamic: false,
    is_bool: false,
    is_file: false,
    is_reference: false,
    is_computed: false,
    has_compute_script: false,
    has_choice_web_hook: false,
    has_choice_other: false,
    is_indexed: true,
    storage_table: 'c_value_index_texts',
    is_required: false,
    order: 0,
    default_show: true,
    inherited: false,
    ...overrides,
  };
}

const hostname = attribute(10, 'hostname', { is_unique: true, is_required: true });
const serial = attribute(40, 'serial', { inherited: true, inherited_from: '资产' });

const groups: AttributeGroup[] = [
  {
    id: 5,
    name: '基本信息',
    type_id: 1,
    order: 1,
    inherited: false,
    attributes: [hostname],
    is_other: false,
  },
  {
    id: 0,
    name: '',
    type_id: 1,
    order: 99,
    inherited: false,
    attributes: [serial],
    is_other: true,
  },
];

function related(
  role: number,
  constraint: string,
  parentIDs: number[],
  childIDs: number[],
): RelatedType {
  return {
    ctr_id: role,
    type: {
      ...model,
      id: role === 1 ? 2 : 3,
      name: role === 1 ? 'disk' : 'rack',
      alias: role === 1 ? '磁盘' : '机柜',
      unique_key: role === 1 ? 'sn' : 'name',
    },
    show_key: role === 1 ? 'sn' : '',
    attributes: role === 1 ? [attribute(30, 'sn')] : [attribute(50, 'rack_name')],
    relation_type: { id: 7, name: '包含', color: '#6366f1' },
    constraint,
    parent_attr_ids: parentIDs,
    child_attr_ids: childIDs,
  };
}

const childRelation = related(1, '0', [10], [30]);
const parentRelation = related(2, '1', [50], [10]);

const constraints: UniqueConstraint[] = [
  {
    id: 70,
    type_id: 1,
    attr_ids: [10, 99],
    attributes: [hostname],
  },
];

const triggers: Trigger[] = [
  {
    id: 80,
    type_id: 1,
    attr_id: 10,
    option: {
      name: 'notify',
      webhooks: {
        url: 'https://example.test/hook',
        authorization: { token: 'must-not-leak' },
      },
    },
    has_webhook_authorization: true,
  },
];

describe('buildModelDefinition', () => {
  it('builds a versioned snapshot with normalized sections and relation mappings', () => {
    const doc = buildModelDefinition({
      model,
      attributes: [hostname, serial],
      groups,
      childRelations: [childRelation],
      parentRelations: [parentRelation],
      constraints,
      triggers,
      isAdmin: true,
      exportedAt: '2026-10-27T08:00:00.000Z',
    });

    expect(doc.format).toBe('ongrid.cmdb.model');
    expect(doc.format_version).toBe(1);
    expect(doc.exported_at).toBe('2026-10-27T08:00:00.000Z');
    expect(doc.sections_omitted).toEqual([]);

    expect(doc.model).toEqual({
      id: 1,
      name: 'host',
      alias: '主机',
      enabled: true,
      icon: 'server$$#6366f1$$false$$',
      order: 2,
      default_order_attr: '-hostname',
      unique_key: 'hostname',
      show_name: 'hostname',
      parent_ids: [9],
    });
    // DERIVED / PHYSICAL / AUDIT FIELDS ARE NOT PART OF THE DEFINITION.
    expect('is_attached' in doc.model).toBe(false);
    expect('created_at' in doc.model).toBe(false);

    expect(doc.attributes).toHaveLength(2);
    expect(doc.attributes[0]).toMatchObject({
      id: 10,
      name: 'hostname',
      value_type: '2',
      is_unique: true,
      binding: {
        is_required: true,
        order: 0,
        default_show: true,
        inherited: false,
        inherited_from: null,
      },
    });
    expect('is_required' in doc.attributes[0]).toBe(false);
    expect('uid' in doc.attributes[0]).toBe(false);
    expect('is_indexed' in doc.attributes[0]).toBe(false);
    expect('storage_table' in doc.attributes[0]).toBe(false);
    expect(doc.attributes[1].binding).toMatchObject({ inherited: true, inherited_from: '资产' });
    expect(doc.attributes[0].reference_type_id).toBeNull();
    expect(doc.attributes[0].compute_expr).toBeNull();
    expect(doc.attributes[0].re_check).toBeNull();
    expect(doc.attributes[0].default).toBeNull();
    expect(doc.attributes[0].option).toBeNull();
    expect(doc.attributes[0].choice_value).toEqual([]);

    expect(doc.form_sections).toEqual([
      { name: '基本信息', order: 1, inherited: false, attribute_ids: [10] },
    ]);

    expect(doc.relations).toHaveLength(2);
    expect(doc.relations[0]).toMatchObject({
      other_model_role: 'child',
      other_model: { id: 2, name: 'disk', alias: '磁盘' },
      constraint: '0',
      cardinality: 'one_to_many',
      show_key: 'sn',
      attribute_mapping: [
        { parent_attribute: { id: 10, name: 'hostname' }, child_attribute: { id: 30, name: 'sn' } },
      ],
      unpaired_parent_attribute_ids: [],
      unpaired_child_attribute_ids: [],
    });
    expect(doc.relations[1]).toMatchObject({
      other_model_role: 'parent',
      constraint: '1',
      cardinality: 'one_to_one',
      show_key: null,
      attribute_mapping: [
        { parent_attribute: { id: 50, name: 'rack_name' }, child_attribute: { id: 10, name: 'hostname' } },
      ],
    });

    expect(doc.unique_constraints).toEqual([
      {
        attribute_ids: [10, 99],
        attributes: [{ id: 10, name: 'hostname' }],
        missing_attribute_ids: [99],
      },
    ]);

    expect(doc.triggers).toEqual([
      {
        attribute: { id: 10, name: 'hostname' },
        option: { name: 'notify', webhooks: { url: 'https://example.test/hook' } },
        has_webhook_authorization: true,
      },
    ]);
    expect(JSON.stringify(doc)).not.toContain('must-not-leak');
  });

  it('marks the admin-only sections as omitted for a non-admin', () => {
    const doc = buildModelDefinition({
      model,
      attributes: [hostname],
      groups,
      childRelations: [],
      parentRelations: [],
      isAdmin: false,
      exportedAt: '2026-10-27T08:00:00.000Z',
    });

    expect(doc.unique_constraints).toBeNull();
    expect(doc.triggers).toBeNull();
    expect(doc.sections_omitted).toEqual([
      { section: 'unique_constraints', reason: 'admin_required' },
      { section: 'triggers', reason: 'admin_required' },
    ]);
  });

  it('keeps empty lists stable and maps unmatched relation ids', () => {
    const relation = related(1, '2', [10, 999], [30]);
    const doc = buildModelDefinition({
      model,
      attributes: [hostname],
      groups: [],
      childRelations: [relation],
      parentRelations: [],
      constraints: [],
      triggers: [],
      isAdmin: true,
      exportedAt: '2026-10-27T08:00:00.000Z',
    });

    expect(doc.form_sections).toEqual([]);
    expect(doc.unique_constraints).toEqual([]);
    expect(doc.triggers).toEqual([]);
    expect(doc.relations[0].attribute_mapping).toEqual([
      { parent_attribute: { id: 10, name: 'hostname' }, child_attribute: { id: 30, name: 'sn' } },
    ]);
    expect(doc.relations[0].unpaired_parent_attribute_ids).toEqual([999]);
    expect(doc.relations[0].unpaired_child_attribute_ids).toEqual([]);
  });
});
