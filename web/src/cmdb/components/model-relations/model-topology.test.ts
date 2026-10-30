import { describe, expect, it } from 'vitest';

import type { CIType, RelatedType } from '../../api/citype';
import type { ModelGroup } from '../../api/preferences';
import {
  CENTER_COLOR,
  GROUP_PALETTE,
  NEUTRAL_COLOR,
  badgeForNode,
  createInitialGraph,
  groupColorMap,
  hasLoadedChildren,
  hiddenDescendantCount,
  layoutModelGraph,
  mergeExpansion,
  visibleGraph,
  type ModelGraph,
  type ProbeEntry,
} from './model-topology';

const model = (id: number, name: string, alias = name): CIType => ({
  id,
  name,
  alias,
  enabled: true,
  is_attached: true,
  order: 0,
  parent_ids: [],
});

const relation = (
  ctrID: number,
  type: CIType,
  relationName = 'contain',
  color = '#0ea5e9',
): RelatedType => ({
  ctr_id: ctrID,
  type,
  show_key: 'name',
  attributes: [],
  relation_type: { id: 1, name: relationName, color },
  constraint: '0',
  parent_attr_ids: [],
  child_attr_ids: [],
});

const center = model(10, 'business_application', '业务应用');
const parent = model(20, 'service', '服务');
const child = model(30, 'certificate', '证书');
const grandparent = model(40, 'org_unit', '组织');
const grandchild = model(50, 'cert_item', '证书明细');

function initial(p: RelatedType[] = [], c: RelatedType[] = [], colors = new Map<number, string>()): ModelGraph {
  return createInitialGraph(center, p, c, colors);
}

describe('groupColorMap', () => {
  it('assigns palette colors in admin group order and skips the other bucket', () => {
    const groups: ModelGroup[] = [
      { id: 1, name: '基础设施', ci_types: [parent, child] },
      { id: 2, name: '人员', ci_types: [child, grandparent] },
      { id: 3, name: '其他', is_other: true, ci_types: [grandchild] },
    ];

    const colors = groupColorMap(groups);

    expect(colors.get(parent.id)).toBe(GROUP_PALETTE[0]);
    expect(colors.get(child.id)).toBe(GROUP_PALETTE[0]);
    expect(colors.get(grandparent.id)).toBe(GROUP_PALETTE[1]);
    expect(colors.has(grandchild.id)).toBe(false);
  });
});

describe('createInitialGraph', () => {
  it('places the center in the middle and one hop on each side', () => {
    const colors = new Map<number, string>([[parent.id, '#3b82f6']]);

    const graph = initial(
      [relation(1, parent, 'depend', '#f59e0b')],
      [relation(2, child, 'contain', '#0ea5e9')],
      colors,
    );

    expect(graph.nodes.get(center.id)).toMatchObject({
      side: 'center',
      depth: 0,
      groupColor: CENTER_COLOR,
      alias: '业务应用',
    });
    expect(graph.nodes.get(parent.id)).toMatchObject({ side: 'left', depth: 1, groupColor: '#3b82f6' });
    expect(graph.nodes.get(child.id)).toMatchObject({ side: 'right', depth: 1, groupColor: NEUTRAL_COLOR });
    expect(graph.edges).toEqual([
      expect.objectContaining({ source: parent.id, target: center.id, relationName: 'depend', direction: 'in' }),
      expect.objectContaining({ source: center.id, target: child.id, relationName: 'contain', direction: 'out' }),
    ]);
  });

  it('keeps one node when a model is both direct parent and child', () => {
    const graph = initial([relation(1, parent)], [relation(2, parent)]);

    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.get(parent.id)?.side).toBe('left');
    expect(graph.edges).toHaveLength(2);
  });
});

describe('mergeExpansion', () => {
  it('grows a left node further left without moving existing nodes', () => {
    const graph = initial([relation(1, parent)]);
    const expanded = mergeExpansion(graph, parent.id, [relation(2, grandparent, 'member_of')], new Map());

    expect(expanded.nodes.get(grandparent.id)).toMatchObject({ side: 'left', depth: 2 });
    expect(expanded.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: grandparent.id, target: parent.id, relationName: 'member_of' }),
      ]),
    );

    const cycle = mergeExpansion(expanded, parent.id, [relation(3, center, 'cycles')], new Map());
    expect(cycle.nodes.get(center.id)).toMatchObject({ side: 'center', depth: 0 });
    expect(cycle.nodes.size).toBe(expanded.nodes.size);
    expect(cycle.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: center.id, target: parent.id })]),
    );
  });

  it('grows a right node further right', () => {
    const graph = initial([], [relation(1, child)]);
    const expanded = mergeExpansion(graph, child.id, [relation(2, grandchild)], new Map());

    expect(expanded.nodes.get(grandchild.id)).toMatchObject({ side: 'right', depth: 2 });
    expect(expanded.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: child.id, target: grandchild.id })]),
    );
  });

  it('does not duplicate an edge when the same relation arrives twice', () => {
    const graph = initial([relation(1, parent)]);
    const expanded = mergeExpansion(graph, parent.id, [relation(2, grandparent)], new Map());

    const again = mergeExpansion(expanded, parent.id, [relation(2, grandparent)], new Map());

    expect(again.edges).toHaveLength(expanded.edges.length);
    expect(again.nodes.size).toBe(expanded.nodes.size);
  });
});

describe('visibleGraph', () => {
  const base = (() => {
    const graph = initial([relation(1, parent)], [relation(2, child)]);
    const withLeftChild = mergeExpansion(graph, parent.id, [relation(3, grandparent)], new Map());
    return mergeExpansion(withLeftChild, child.id, [relation(4, grandchild)], new Map());
  })();

  it('shows the center alone when nothing is expanded', () => {
    const visible = visibleGraph(base, new Set(), center.id);

    expect([...visible.nodes.keys()]).toEqual([center.id]);
    expect(visible.edges).toHaveLength(0);
  });

  it('traverses only expanded nodes and keeps edges between visible endpoints', () => {
    const visible = visibleGraph(base, new Set([center.id]), center.id);

    expect(new Set(visible.nodes.keys())).toEqual(new Set([center.id, parent.id, child.id]));
    expect(visible.nodes.has(grandparent.id)).toBe(false);
    expect(visible.nodes.has(grandchild.id)).toBe(false);
    expect(visible.edges).toHaveLength(2);
  });

  it('adds a descendant when its side node is expanded', () => {
    const visible = visibleGraph(base, new Set([center.id, parent.id]), center.id);

    expect(visible.nodes.has(grandparent.id)).toBe(true);
    expect(visible.nodes.has(grandchild.id)).toBe(false);
    expect(visible.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: grandparent.id, target: parent.id })]),
    );
  });
});

describe('hiddenDescendantCount', () => {
  const chain = (() => {
    const graph = initial([], [relation(1, child)]);
    const withY = mergeExpansion(graph, child.id, [relation(2, grandchild)], new Map());
    const z = model(60, 'cert_owner', '证书持有人');
    const withZ = mergeExpansion(withY, grandchild.id, [relation(3, z, 'owned_by')], new Map());
    return { graph: withZ, z };
  })();

  it('counts every loaded descendant that the visible graph hides', () => {
    const visibleIDs = new Set([center.id]);

    expect(hiddenDescendantCount(chain.graph, child.id, visibleIDs)).toBe(2);
  });

  it('does not count a descendant that is still visible through another path', () => {
    const graph: ModelGraph = {
      nodes: chain.graph.nodes,
      edges: [...chain.graph.edges, {
        key: `${center.id}-${grandchild.id}-99`,
        source: center.id,
        target: grandchild.id,
        relationId: 99,
        relationName: 'contain',
        relationColor: '#0ea5e9',
        direction: 'out',
      }],
    };
    const visible = visibleGraph(graph, new Set([center.id]), center.id);

    expect(visible.nodes.has(grandchild.id)).toBe(true);
    expect(hiddenDescendantCount(graph, child.id, new Set(visible.nodes.keys()))).toBe(1);
  });

  it('reports whether a node has loaded away-direction children', () => {
    const left = initial([relation(1, parent)]);
    expect(hasLoadedChildren(left, left.nodes.get(parent.id)!)).toBe(false);
    expect(hasLoadedChildren(chain.graph, chain.graph.nodes.get(child.id)!)).toBe(true);
    expect(hasLoadedChildren(chain.graph, chain.graph.nodes.get(center.id)!)).toBe(false);
  });
});

describe('badgeForNode', () => {
  const base = initial([relation(1, parent)], [relation(2, child)]);
  const probe = (items: RelatedType[], status: ProbeEntry['status'] = 'ready'): ProbeEntry => ({ status, items });

  it('shows nothing for the center or an unprobed node', () => {
    expect(badgeForNode(base.nodes.get(center.id)!, new Set([center.id]), undefined, base, new Set())).toEqual({
      kind: 'none',
    });
    expect(
      badgeForNode(base.nodes.get(parent.id)!, new Set([center.id]), undefined, base, new Set([center.id])),
    ).toEqual({ kind: 'none' });
  });

  it('reflects expanded, loading, retry and leaf states', () => {
    const parentNode = base.nodes.get(parent.id)!;
    const visible = new Set([center.id, parent.id]);

    expect(badgeForNode(parentNode, new Set([center.id, parent.id]), undefined, base, visible)).toEqual({
      kind: 'expanded',
    });
    expect(badgeForNode(parentNode, new Set([center.id]), probe([], 'loading'), base, visible)).toEqual({
      kind: 'loading',
    });
    expect(badgeForNode(parentNode, new Set([center.id]), probe([], 'error'), base, visible)).toEqual({
      kind: 'retry',
    });
    expect(badgeForNode(parentNode, new Set([center.id]), probe([]), base, visible)).toEqual({ kind: 'none' });
  });

  it('counts unique probed models before the first expansion', () => {
    const items = [parent, child, grandparent, grandchild, center].map((item, index) =>
      relation(index + 20, item),
    );

    expect(
      badgeForNode(base.nodes.get(parent.id)!, new Set([center.id]), probe(items), base, new Set([center.id])),
    ).toEqual({ kind: 'count', count: 5 });
  });

  it('uses the loaded descendants after a collapse', () => {
    const graph = initial([], [relation(1, child)]);
    const withChild = mergeExpansion(graph, child.id, [relation(2, grandchild)], new Map());
    const visible = new Set([center.id]);

    expect(
      badgeForNode(
        withChild.nodes.get(child.id)!,
        new Set([center.id]),
        probe([relation(2, grandchild)]),
        withChild,
        visible,
      ),
    ).toEqual({ kind: 'count', count: 1 });
  });
});

describe('layoutModelGraph', () => {
  it('puts the center at the origin with parents left and children right', () => {
    const graph = initial([relation(1, parent)], [relation(2, child)]);
    const withLeaf = mergeExpansion(graph, child.id, [relation(3, grandchild)], new Map());

    const positions = layoutModelGraph(
      [...withLeaf.nodes.values()],
      withLeaf.edges,
      center.id,
    );

    expect(positions.get(center.id)).toMatchObject({ x: 0, y: 0 });
    expect(positions.get(parent.id)!.x).toBeLessThan(0);
    expect(positions.get(child.id)!.x).toBeGreaterThan(0);
    expect(positions.get(grandchild.id)!.x).toBeGreaterThan(positions.get(child.id)!.x);
  });

  it('is deterministic for the same input', () => {
    const graph = initial([relation(1, parent)], [relation(2, child)]);
    const nodes = [...graph.nodes.values()];

    expect(layoutModelGraph(nodes, graph.edges, center.id)).toEqual(
      layoutModelGraph(nodes, graph.edges, center.id),
    );
  });
});
