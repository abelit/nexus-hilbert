import { describe, expect, it } from 'vitest';

import type { CIType } from '../api/citype';
import type { ModelGroup } from '../api/preferences';
import { groupModels, type ModelGroupLabels } from './model-groups';

const labels: ModelGroupLabels = {
  other: '其他',
  all: '全部模型',
  unnamed: '未命名分组',
};

function model(id: number, name: string, order = id): CIType {
  return {
    id,
    name,
    alias: name,
    enabled: true,
    is_attached: true,
    icon: '',
    order,
    unique_key: 'key',
    parent_ids: [],
  };
}

function group(id: number | undefined, name: string, types: CIType[]): ModelGroup {
  return { id, name, ci_types: types };
}

const host = model(1, 'host', 20);
const switchModel = model(2, 'switch', 10);
const database = model(3, 'database', 30);
const router = model(4, 'router', 5);

describe('groupModels', () => {
  it('keeps the API group order and each group’s membership order', () => {
    const sections = groupModels(
      [host, switchModel, database, router],
      [
        group(10, '网络', [router, switchModel]),
        // Deliberately the reverse of the models' global order: the group's
        // own arrangement is what a drag stores, so it must win.
        group(11, '服务器', [database, host]),
      ],
      labels,
    );

    expect(sections.map((section) => section.name)).toEqual(['网络', '服务器']);
    expect(sections[0].rows.map((row) => row.name)).toEqual(['router', 'switch']);
    expect(sections[1].rows.map((row) => row.name)).toEqual(['database', 'host']);
  });

  it('deduplicates a model that appears in two groups, first group wins', () => {
    const sections = groupModels(
      [host, switchModel],
      [
        group(10, '服务器', [host]),
        group(11, '网络', [host, switchModel]),
      ],
      labels,
    );

    expect(sections.map((section) => section.name)).toEqual(['服务器', '网络']);
    expect(sections[0].rows.map((row) => row.id)).toEqual([host.id]);
    expect(sections[1].rows.map((row) => row.id)).toEqual([switchModel.id]);
  });

  it('drops stale ids and groups that become empty', () => {
    const missing = { ...host, id: 999 };
    const sections = groupModels(
      [host],
      [
        group(10, '过期', [missing]),
        group(11, '服务器', [host]),
      ],
      labels,
    );

    expect(sections.map((section) => section.name)).toEqual(['服务器']);
    expect(sections[0].rows.map((row) => row.id)).toEqual([host.id]);
  });

  it('appends ungrouped models to Other, last and sorted', () => {
    const sections = groupModels(
      [host, switchModel, router],
      [group(10, '服务器', [host])],
      labels,
    );

    expect(sections.map((section) => section.name)).toEqual(['服务器', '其他']);
    expect(sections[1].key).toBe('other');
    expect(sections[1].rows.map((row) => row.name)).toEqual(['router', 'switch']);
  });

  it('ignores a server-provided Other bucket and recomputes it', () => {
    const sections = groupModels(
      [host, switchModel, router],
      [
        group(10, '服务器', [host]),
        { id: undefined, name: undefined, is_other: true, ci_types: [host, switchModel, router] },
      ],
      labels,
    );

    expect(sections.map((section) => section.name)).toEqual(['服务器', '其他']);
    expect(sections[1].rows.map((row) => row.name)).toEqual(['router', 'switch']);
    expect(sections.flatMap((section) => section.rows).map((row) => row.id).sort((a, b) => a - b)).toEqual([
      host.id,
      switchModel.id,
      router.id,
    ]);
  });

  it('falls back to one All models section when no real groups exist', () => {
    const sections = groupModels([host, switchModel], [], labels);

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('all');
    expect(sections[0].name).toBe('全部模型');
    expect(sections[0].rows.map((row) => row.name)).toEqual(['switch', 'host']);
  });

  it('returns no sections when there are no models', () => {
    expect(groupModels([], [group(10, '服务器', [host])], labels)).toEqual([]);
  });

  it('gives unnamed groups a stable key and labels them', () => {
    const sections = groupModels([host], [group(undefined, '', [host])], labels);

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('g-anon-0');
    expect(sections[0].name).toBe('未命名分组');
  });

  it('keeps a real group named Other distinct from the synthetic bucket', () => {
    const sections = groupModels(
      [host, switchModel],
      [group(99, '其他', [host])],
      labels,
    );

    expect(sections.map((section) => [section.key, section.name])).toEqual([
      ['g:99', '其他'],
      ['other', '其他'],
    ]);
  });
});
