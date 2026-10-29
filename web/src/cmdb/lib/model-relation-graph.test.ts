import { describe, expect, it } from 'vitest';

import type { CIType, ModelRelation } from '../api/citype';
import type { TypePair } from '../api/preferences';
import {
  buildModelGraph,
  definitionModelIDs,
  definitionRoot,
  layoutModelGraph,
  pairsFromSelection,
  serviceTreeChainTokens,
} from './model-relation-graph';

const model = (id: number, name: string) =>
  ({ id, name, alias: name, icon: '', unique_key: 'name' }) as CIType;

const models = [model(1, 'idc'), model(2, 'rack'), model(3, 'host'), model(4, 'switch')];

const relation = (parent: number, child: number, name = '包含'): ModelRelation => {
  const side = (type: CIType) => ({
    ctr_id: 1,
    type,
    attributes: [],
    relation_type: { id: 1, name, color: '' },
    constraint: '1-N',
    parent_attr_ids: [],
    child_attr_ids: [],
  });
  return { id: parent * 10 + child, parent: side(models[parent - 1]), child: side(models[child - 1]) };
};

const relations = [relation(1, 2), relation(2, 3), relation(1, 4), relation(1, 2)];

describe('the type graph', () => {
  it('dedupes parallel relations and finds the root', () => {
    const graph = buildModelGraph(models, relations);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([1, 2, 3, 4]);
    // Two relation types between 1 and 2 still draw one edge.
    expect(graph.links).toHaveLength(3);
    expect(graph.rootID).toBe(1);
    expect(graph.childrenOf.get(1)).toEqual(new Set([2, 4]));
    expect(graph.parentsOf.get(3)).toEqual(new Set([2]));
  });

  it('lays every node out deterministically for every mode', () => {
    const graph = buildModelGraph(models, relations);
    for (const mode of ['tree', 'radial', 'concentric', 'mindmap'] as const) {
      const first = layoutModelGraph(graph, mode);
      const second = layoutModelGraph(graph, mode);
      expect(first.size).toBe(graph.nodes.length);
      for (const node of graph.nodes) {
        expect(first.get(node.id)).toBeDefined();
        expect(first.get(node.id)).toEqual(second.get(node.id));
      }
      // Two cards must not occupy the same point, whatever the layout.
      const seen = new Set<string>();
      for (const position of first.values()) {
        const key = `${position.x.toFixed(2)}:${position.y.toFixed(2)}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('centres a tree parent over its children', () => {
    const graph = buildModelGraph(models, relations);
    const positions = layoutModelGraph(graph, 'tree');
    const parent = positions.get(1)!;
    const first = positions.get(2)!;
    const last = positions.get(4)!;
    expect(parent.y).toBeCloseTo((first.y + last.y) / 2);
  });

  it('balances a mind map on both sides of its root', () => {
    const graph = buildModelGraph(models, relations);
    const positions = layoutModelGraph(graph, 'mindmap');
    const root = positions.get(1)!;
    expect(positions.get(2)!.x).toBeGreaterThan(root.x);
    expect(positions.get(4)!.x).toBeLessThan(root.x);
  });

  it('puts each concentric layer on one ring', () => {
    const graph = buildModelGraph(models, relations);
    const positions = layoutModelGraph(graph, 'concentric');
    const centre = positions.get(1)!;
    const radius = (id: number) => {
      const point = positions.get(id)!;
      return Math.hypot(point.x - centre.x, point.y - centre.y);
    };
    expect(radius(2)).toBeCloseTo(radius(4));
    expect(radius(3)).toBeGreaterThan(radius(2));
  });

  it('derives pairs only from selected models that are actually related', () => {
    const selection = new Set([1, 2, 3]);
    expect(pairsFromSelection(relations, selection)).toEqual([
      { parent_id: 1, child_id: 2 },
      { parent_id: 2, child_id: 3 },
    ]);
    expect(pairsFromSelection(relations, new Set([1, 3]))).toEqual([]);
    expect(definitionModelIDs([{ parent_id: 1, child_id: 2 }, { parent_id: 2, child_id: 3 }])).toEqual([1, 2, 3]);
  });

  it('finds the definition root and tolerates a cycle', () => {
    expect(definitionRoot([{ parent_id: 1, child_id: 2 }, { parent_id: 2, child_id: 3 }])).toBe(1);
    expect(definitionRoot([{ parent_id: 1, child_id: 2 }, { parent_id: 2, child_id: 1 }])).toBe(1);
    expect(definitionRoot([])).toBeNull();
  });

  it('renders a chain and keeps branching visible', () => {
    const chain: TypePair[] = [
      { parent_id: 1, child_id: 2 },
      { parent_id: 2, child_id: 3 },
    ];
    expect(serviceTreeChainTokens(chain, (id) => `m${id}`)).toEqual(['m1', 'm2', 'm3']);
    expect(
      serviceTreeChainTokens(
        [
          { parent_id: 1, child_id: 2 },
          { parent_id: 1, child_id: 4 },
        ],
        (id) => `m${id}`,
      ),
    ).toEqual(['m1', '+2']);
  });
});
