import { describe, expect, it } from 'vitest';

import type { CIType, RelatedType, TypeAttribute } from '../api/citype';
import { relatedKeyAttributes, relatedRowIdentifier, relatedRowTitle } from './related-row';

const type: CIType = {
  id: 85,
  name: 'service',
  alias: '业务服务',
  enabled: true,
  is_attached: true,
  order: 0,
  unique_key: 'uuid',
  show_name: 'name',
  parent_ids: [],
};

const attribute = (name: string, extra: Partial<TypeAttribute> = {}): TypeAttribute => ({
  id: 1,
  name,
  alias: name,
  value_type: '2',
  is_choice: false,
  is_list: false,
  is_unique: false,
  is_index: true,
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
  is_indexed: true,
  storage_table: 'c_value_index_texts',
  is_required: false,
  order: 1,
  default_show: true,
  inherited: false,
  ...extra,
});

const related: RelatedType = {
  ctr_id: 1,
  type,
  show_key: 'name',
  attributes: [
    attribute('uuid', { alias: 'ID' }),
    attribute('code', { alias: '代码' }),
    attribute('name', { alias: '名称' }),
    attribute('environment', { alias: '环境类型' }),
    attribute('data_status', { alias: '数据状态' }),
    attribute('description', { alias: '描述' }),
  ],
  relation_type: { id: 3, name: '包含', color: '' },
  constraint: '0',
  parent_attr_ids: [],
  child_attr_ids: [],
};

describe('related rows', () => {
  it('uses the model display name and keeps the unique key as the subtitle', () => {
    const row = {
      _id: 900,
      _type: 85,
      ci_id: 900,
      ci_type: 'service',
      unique: 'uuid',
      name: '业务服务 A',
      uuid: 'dd09aace-6c48-4f37-9674-2b36ea98a9a2',
    };
    expect(relatedRowTitle(row, related)).toBe('业务服务 A');
    expect(relatedRowIdentifier(row, related)).toBe('dd09aace-6c48-4f37-9674-2b36ea98a9a2');
  });

  it('falls back to the instance id when the unique value is the title', () => {
    const row = {
      _id: 901,
      _type: 85,
      ci_id: 901,
      ci_type: 'service',
      unique: 'uuid',
      name: 'SAME',
      uuid: 'SAME',
    };
    expect(relatedRowIdentifier(row, related)).toBe('#901');
  });

  it('picks two operational fields and excludes display, unique and JSON fields', () => {
    const withJson = {
      ...related,
      attributes: [...related.attributes, attribute('metadata', { value_type: '6' })],
    };
    expect(relatedKeyAttributes(withJson).map((item) => item.name)).toEqual([
      'environment',
      'data_status',
    ]);
  });
});
