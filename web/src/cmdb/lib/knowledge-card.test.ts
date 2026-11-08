import { describe, expect, it } from 'vitest';

import type { CIType, TypeAttribute } from '../api/citype';
import type { Instance } from '../api/instance';
import { cmdbKnowledgeItem } from './knowledge-card';

const model = {
  id: 1,
  name: 'host',
  alias: '主机',
  enabled: true,
  is_attached: true,
  order: 0,
  parent_ids: [],
  unique_key: 'hostname',
} as CIType;

function attribute(patch: Partial<TypeAttribute>): TypeAttribute {
  return {
    id: 1,
    name: 'hostname',
    alias: '主机名',
    value_type: '2',
    is_required: false,
    is_list: false,
    is_index: false,
    is_sortable: false,
    is_unique: false,
    is_dynamic: false,
    is_bool: false,
    is_password: false,
    is_link: false,
    is_reference: false,
    is_computed: false,
    is_file: false,
    ...patch,
  } as TypeAttribute;
}

const instance = {
  ci_id: 42,
  values: { hostname: 'web-01', owner: '张三', secret: 'hunter2', note: 'line one\nline two' },
} as unknown as Instance;

describe('cmdbKnowledgeItem', () => {
  it('builds a stable title, path and tags', () => {
    const item = cmdbKnowledgeItem({
      model,
      attributes: [attribute({})],
      instance,
    });

    expect(item.title).toBe('[CMDB] 主机 web-01 (#42)');
    expect(item.path).toBe('CMDB/主机');
    expect(item.tags).toEqual(['cmdb', 'ci_type:host', 'ci_id:42']);
    expect(item.markdown).toContain('# [CMDB] 主机 web-01 (#42)');
    expect(item.markdown).toContain('**主机名** (`hostname`): web-01');
  });

  it('omits secrets and files and flattens whitespace', () => {
    const item = cmdbKnowledgeItem({
      model,
      attributes: [
        attribute({ id: 1, name: 'hostname', alias: '主机名' }),
        attribute({ id: 2, name: 'secret', alias: '密码', is_password: true }),
        attribute({ id: 3, name: 'note', alias: '备注' }),
        attribute({ id: 4, name: 'attachment', alias: '附件', is_file: true }),
      ],
      instance,
    });

    expect(item.markdown).not.toContain('hunter2');
    expect(item.markdown).not.toContain('密码');
    expect(item.markdown).not.toContain('附件');
    expect(item.markdown).toContain('line one line two');
  });

  it('caps the body so one document stays within the ingestion window', () => {
    const long = 'x'.repeat(5000);
    const item = cmdbKnowledgeItem({
      model,
      attributes: [attribute({})],
      instance: { ci_id: 1, values: { hostname: long } } as unknown as Instance,
    });

    expect(item.markdown.length).toBeLessThanOrEqual(2400);
  });
});
