import dagre from '@dagrejs/dagre';

import type { CIType, RelatedType } from '../../api/citype';
import type { ModelGroup } from '../../api/preferences';

// The model-relations graph, with no React in it.
//
// THE GRAPH IS LOADED INCREMENTALLY, THE PICTURE IS DERIVED. Expansion merges
// new relations into a complete graph; collapse only removes a node from the
// expanded set. The canvas therefore never loses data it already fetched, and
// re-expanding a branch is instant.
//
// DIRECTIONS ARE RELATIVE TO THE CENTER. A left node grows further left through
// its parents; a right node grows further right through its children. Following
// the other direction would pull siblings or back-edges into the picture, which
// is a different question from "what is underneath this model".

export type Side = 'center' | 'left' | 'right';

export type ModelNode = {
  id: number;
  alias: string;
  name: string;
  icon?: string;
  groupColor: string;
  side: Side;
  depth: number;
};

export type ModelEdge = {
  key: string;
  /** Parent model id. */
  source: number;
  /** Child model id. */
  target: number;
  relationId: number;
  relationName: string;
  relationColor: string;
  direction: 'in' | 'out';
};

export type ModelGraph = {
  nodes: Map<number, ModelNode>;
  edges: ModelEdge[];
};

export type ProbeEntry = {
  status: 'loading' | 'ready' | 'error';
  items: RelatedType[];
};

export type BadgeState =
  | { kind: 'none' }
  | { kind: 'expanded' }
  | { kind: 'loading' }
  | { kind: 'count'; count: number }
  | { kind: 'retry' };

export const CENTER_COLOR = '#6366f1';
export const NEUTRAL_COLOR = '#64748b';
export const EDGE_FALLBACK_COLOR = '#94a3b8';
export const GROUP_PALETTE = ['#3b82f6', '#0ea5e9', '#f59e0b', '#8b5cf6', '#10b981', '#f43f5e'];
export const MAX_VISIBLE_NODES = 300;

export const CENTER_SIZE = { width: 190, height: 64 };
export const NODE_SIZE = { width: 170, height: 56 };

function nodeFrom(model: CIType, side: Side, depth: number, colors: Map<number, string>): ModelNode {
  return {
    id: model.id,
    alias: model.alias || model.name,
    name: model.name,
    icon: model.icon,
    groupColor: side === 'center' ? CENTER_COLOR : (colors.get(model.id) ?? NEUTRAL_COLOR),
    side,
    depth,
  };
}

function edgeFrom(
  relation: RelatedType,
  source: number,
  target: number,
  direction: 'in' | 'out',
): ModelEdge {
  return {
    key: `${source}-${target}-${relation.ctr_id}`,
    source,
    target,
    relationId: relation.ctr_id,
    relationName: relation.relation_type.name || String(relation.relation_type.id),
    relationColor: relation.relation_type.color || EDGE_FALLBACK_COLOR,
    direction,
  };
}

/** Model id → color, in the admin-maintained group order. */
export function groupColorMap(groups: ModelGroup[]): Map<number, string> {
  const colors = new Map<number, string>();
  let paletteIndex = 0;
  for (const group of groups) {
    if (group.is_other) continue;
    const color = GROUP_PALETTE[paletteIndex % GROUP_PALETTE.length];
    paletteIndex += 1;
    for (const model of group.ci_types ?? []) {
      if (!colors.has(model.id)) colors.set(model.id, color);
    }
  }
  return colors;
}

export function createInitialGraph(
  center: CIType,
  parents: RelatedType[],
  children: RelatedType[],
  colors: Map<number, string>,
): ModelGraph {
  const nodes = new Map<number, ModelNode>();
  const edges: ModelEdge[] = [];
  const seen = new Set<string>();
  nodes.set(center.id, nodeFrom(center, 'center', 0, colors));

  for (const relation of parents) {
    if (!nodes.has(relation.type.id)) {
      nodes.set(relation.type.id, nodeFrom(relation.type, 'left', 1, colors));
    }
    const edge = edgeFrom(relation, relation.type.id, center.id, 'in');
    if (!seen.has(edge.key)) {
      seen.add(edge.key);
      edges.push(edge);
    }
  }
  for (const relation of children) {
    if (!nodes.has(relation.type.id)) {
      nodes.set(relation.type.id, nodeFrom(relation.type, 'right', 1, colors));
    }
    const edge = edgeFrom(relation, center.id, relation.type.id, 'out');
    if (!seen.has(edge.key)) {
      seen.add(edge.key);
      edges.push(edge);
    }
  }

  return { nodes, edges };
}

export function mergeExpansion(
  graph: ModelGraph,
  nodeId: number,
  items: RelatedType[],
  colors: Map<number, string>,
): ModelGraph {
  const node = graph.nodes.get(nodeId);
  if (!node || node.side === 'center') return graph;

  const nodes = new Map(graph.nodes);
  const edges = [...graph.edges];
  const seen = new Set(edges.map((edge) => edge.key));

  for (const item of items) {
    const other = item.type;
    if (!nodes.has(other.id)) {
      nodes.set(other.id, nodeFrom(other, node.side, node.depth + 1, colors));
    }
    const source = node.side === 'left' ? other.id : nodeId;
    const target = node.side === 'left' ? nodeId : other.id;
    const edge = edgeFrom(item, source, target, node.side === 'left' ? 'in' : 'out');
    if (!seen.has(edge.key)) {
      seen.add(edge.key);
      edges.push(edge);
    }
  }

  return { nodes, edges };
}

function centerIDOf(graph: ModelGraph): number | null {
  for (const node of graph.nodes.values()) {
    if (node.side === 'center') return node.id;
  }
  return null;
}

/** The neighbors a node is allowed to grow toward, away from the center. */
function awayNeighbors(graph: ModelGraph, node: ModelNode, centerId: number): number[] {
  const neighbors: number[] = [];
  for (const edge of graph.edges) {
    if (node.side === 'center') {
      if (edge.source === node.id) neighbors.push(edge.target);
      else if (edge.target === node.id) neighbors.push(edge.source);
    } else if (node.side === 'left') {
      if (edge.target === node.id && edge.source !== centerId) neighbors.push(edge.source);
    } else if (edge.source === node.id && edge.target !== centerId) {
      neighbors.push(edge.target);
    }
  }
  return neighbors;
}

export function visibleGraph(graph: ModelGraph, expanded: Set<number>, centerId: number): ModelGraph {
  const start = graph.nodes.get(centerId);
  if (!start) return { nodes: new Map(), edges: [] };

  const visible = new Set<number>([centerId]);
  const queue: number[] = [centerId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = graph.nodes.get(id);
    if (!node) continue;
    // The caller keeps the center in `expanded`; without it the graph is the
    // center alone, which is also the calm state before the first render.
    if (!expanded.has(id)) continue;
    for (const next of awayNeighbors(graph, node, centerId)) {
      const nextNode = graph.nodes.get(next);
      if (!nextNode) continue;
      if (!visible.has(next)) {
        visible.add(next);
        queue.push(next);
      }
    }
  }

  const nodes = new Map<number, ModelNode>();
  for (const id of visible) {
    const node = graph.nodes.get(id);
    if (node) nodes.set(id, node);
  }
  const edges = graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
  return { nodes, edges };
}

export function hiddenDescendantCount(
  graph: ModelGraph,
  nodeId: number,
  visibleIds: Set<number>,
): number {
  const node = graph.nodes.get(nodeId);
  const centerId = centerIDOf(graph);
  if (!node || node.side === 'center' || centerId === null) return 0;

  const seen = new Set<number>([nodeId]);
  const queue: number[] = [nodeId];
  let count = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    const current = graph.nodes.get(id);
    if (!current) continue;
    for (const next of awayNeighbors(graph, current, centerId)) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (!visibleIds.has(next)) count += 1;
      queue.push(next);
    }
  }
  return count;
}

export function hasLoadedChildren(graph: ModelGraph, node: ModelNode): boolean {
  const centerId = centerIDOf(graph);
  if (node.side === 'center' || centerId === null) return false;
  return graph.edges.some((edge) =>
    node.side === 'left'
      ? edge.target === node.id && edge.source !== centerId
      : edge.source === node.id && edge.target !== centerId,
  );
}

export function badgeForNode(
  node: ModelNode,
  expanded: Set<number>,
  probe: ProbeEntry | undefined,
  graph: ModelGraph,
  visibleIds: Set<number>,
): BadgeState {
  if (node.side === 'center') return { kind: 'none' };
  if (expanded.has(node.id)) return { kind: 'expanded' };
  if (!probe) return { kind: 'none' };
  if (probe.status === 'loading') return { kind: 'loading' };
  if (probe.status === 'error') return { kind: 'retry' };

  const count = hasLoadedChildren(graph, node)
    ? hiddenDescendantCount(graph, node.id, visibleIds)
    : new Set(probe.items.map((item) => item.type.id)).size;
  return count > 0 ? { kind: 'count', count } : { kind: 'none' };
}

export type ModelNodePosition = { x: number; y: number; width: number; height: number };

/** Facing handles for an edge. A right-to-left edge must leave the left side. */
export function edgeHandles(
  sourceX: number,
  targetX: number,
): { sourceHandle: string; targetHandle: string } {
  return targetX >= sourceX
    ? { sourceHandle: 'source-right', targetHandle: 'target-left' }
    : { sourceHandle: 'source-left', targetHandle: 'target-right' };
}

/**
 * Only the edges that point away from the center define the hierarchy. A
 * reverse or cross edge is still drawn, but letting dagre rank it would put a
 * parent on the child side and break the left/right contract.
 */
function isHierarchyEdge(edge: ModelEdge, nodes: Map<number, ModelNode>): boolean {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return false;
  if (source.side === 'center') return target.side === 'right';
  if (target.side === 'center') return source.side === 'left';
  if (source.side === 'left' && target.side === 'left') return source.depth > target.depth;
  if (source.side === 'right' && target.side === 'right') return source.depth < target.depth;
  return false;
}

export function layoutModelGraph(
  nodes: ModelNode[],
  edges: ModelEdge[],
  centerId: number,
): Map<number, ModelNodePosition> {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 44, ranksep: 120, marginx: 40, marginy: 40 });

  const known = new Set(nodes.map((node) => node.id));
  const byID = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const size = node.side === 'center' ? CENTER_SIZE : NODE_SIZE;
    graph.setNode(String(node.id), { width: size.width, height: size.height });
  }
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    if (!isHierarchyEdge(edge, byID)) continue;
    graph.setEdge(String(edge.source), String(edge.target));
  }
  dagre.layout(graph);

  const positions = new Map<number, ModelNodePosition>();
  for (const node of nodes) {
    const size = node.side === 'center' ? CENTER_SIZE : NODE_SIZE;
    const position = graph.node(String(node.id));
    positions.set(node.id, {
      x: position.x - size.width / 2,
      y: position.y - size.height / 2,
      width: size.width,
      height: size.height,
    });
  }

  const center = positions.get(centerId);
  if (center) {
    for (const [id, position] of positions) {
      positions.set(id, { ...position, x: position.x - center.x, y: position.y - center.y });
    }
  }
  return positions;
}
