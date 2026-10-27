import { describe, expect, it } from 'vitest';

import type { CIType, RelatedType, TypeAttribute } from '../api/citype';
import type { SearchRow } from '../api/instance';
import {
  buildInitialTree,
  collectNodeIDs,
  computeTopoLayout,
  findTreeNode,
  planExpansion,
  rowLabel,
  type InitialTopoInput,
} from './instance-topology';

const model: CIType = {
  id: 1,
  name: 'host',
  alias: '主机',
  enabled: true,
  is_attached: true,
  icon: '',
  order: 0,
  unique_key: 'hostname',
  parent_ids: [],
};

function related(id: number, name: string, alias: string): RelatedType {
  return {
    ctr_id: id,
    type: { ...model, id, name, alias, unique_key: 'name' },
    show_key: 'name',
    attributes: [{ id, name: 'name', alias: '名称', value_type: '2' } as TypeAttribute],
    relation_type: { id, name: '包含', color: '#123456' },
    constraint: '0',
    parent_attr_ids: [],
    child_attr_ids: [],
  };
}

const parentType = related(2, 'rack', '机柜');
const childType = related(3, 'disk', '磁盘');

function row(id: number, typeID: number, name: string): SearchRow {
  return { _id: id, _type: typeID, ci_id: id, ci_type: typeID === 2 ? 'rack' : 'disk', unique: 'name', name };
}

function input(): InitialTopoInput {
  return {
    rootID: 'Root_1',
    rootTitle: '主机',
    rootLabel: 'host-01',
    rootAttrs: [],
    rootValues: {},
    rootCIID: 1,
    rootTypeID: 1,
    parentTypes: [parentType],
    childTypes: [childType],
    parentRows: [row(10, 2, 'rack-01')],
    childRows: [row(11, 3, 'sda')],
  };
}

describe('the instance topology tree', () => {
  it('puts parents left, children right and labels the edges from the relation type', () => {
    const tree = buildInitialTree(input());
    expect(tree.root.children.map((node) => node.side)).toEqual(['left', 'right']);
    expect(tree.edges.map((edge) => [edge.sourceId, edge.targetId, edge.label])).toEqual([
      ['10', 'Root_1', '包含'],
      ['Root_1', '11', '包含'],
    ]);
    expect(rowLabel(row(10, 2, 'rack-01'), parentType)).toBe('rack-01');
    const ipRow: SearchRow = { ...row(20, 6, 'id-339'), unique: 'ipam_address_id', ipam_address_id: 339, ip: '172.30.16.6' };
    const ipType = { ...related(6, 'ipam_address', 'IP地址'), show_key: 'ip', type: { ...model, id: 6, name: 'ipam_address', alias: 'IP地址', unique_key: 'ipam_address_id' } };
    expect(rowLabel(ipRow, ipType)).toBe('172.30.16.6');
  });

  it('keeps a CI reached by two paths as one node with two edges', () => {
    const same = related(4, 'room', '机房');
    const tree = buildInitialTree({ ...input(), parentTypes: [parentType, same], parentRows: [row(10, 2, 'rack-01')] });
    expect(tree.root.children).toHaveLength(2);
    expect(new Set(collectNodeIDs(tree.root).values()).size).toBe(3);
  });

  it('adds only outward nodes on expansion and links inward rows to existing nodes', () => {
    const tree = buildInitialTree(input());
    const left = findTreeNode(tree.root, '10');
    expect(left).not.toBeNull();
    const expanded = planExpansion(
      tree,
      '10',
      { rows: [row(20, 5, 'room-01')], types: [related(5, 'room', '机房')], parents: true, allowNewNodes: true },
      { rows: [row(11, 3, 'sda')], types: [childType], parents: false, allowNewNodes: false },
    );
    expect(expanded.added).toBe(true);
    expect(findTreeNode(expanded.tree.root, '20')?.title).toBe('机房');
    expect(expanded.tree.edges.some((edge) => edge.sourceId === 'Root_1' && edge.targetId === '11')).toBe(true);
    expect(expanded.tree.edges.some((edge) => edge.sourceId === 'Root_1' && edge.targetId === '20')).toBe(false);
  });

  it('reports no change when an expansion has nothing new', () => {
    const tree = buildInitialTree(input());
    const expanded = planExpansion(
      tree,
      '10',
      { rows: [], types: [], parents: true, allowNewNodes: true },
      { rows: [], types: [], parents: false, allowNewNodes: false },
    );
    expect(expanded.added).toBe(false);
    expect(expanded.tree).toBe(tree);
  });

  it('lays mindmap sides apart and compactBox levels in one direction', () => {
    const tree = buildInitialTree(input());
    const mindmap = computeTopoLayout(tree.root, 'mindmap');
    expect(mindmap.get('10')?.x).toBe(-280);
    expect(mindmap.get('11')?.x).toBe(280);
    const compact = computeTopoLayout(tree.root, 'compactBox');
    expect(compact.get('10')?.x).toBe(280);
    expect(compact.get('11')?.x).toBe(280);
  });
});
