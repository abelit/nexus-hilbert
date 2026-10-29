import type { CIType, ModelRelation } from '../api/citype';
import type { TypePair } from '../api/preferences';

// The model-relation canvas behind 关系视图.
//
// CANTOR'S SERVICE-TREE PAGE IS THE REFERENCE: model types are the nodes, the
// relations between them are the edges, and a saved definition highlights the
// chain it walks. The layouts and the chain helper are kept pure so the page can
// switch between them without rebuilding the React Flow data by hand.
//
// THE GRAPH IS NOT ALWAYS A TREE. Relations may form cycles, a model may have
// several parents, and the estate usually has more than one connected island.
// Every layout therefore starts from a breadth-first spanning forest and packs
// the islands into rows, instead of assuming one root can reach everything.

export type ModelGraphNode = {
  id: number;
  label: string;
  icon?: string;
  /** BFS depth from the graph root; used for the node's border colour. */
  level: number;
};

export type ModelGraphLink = {
  from: number;
  to: number;
  label: string;
};

export type ModelGraph = {
  nodes: ModelGraphNode[];
  links: ModelGraphLink[];
  parentsOf: Map<number, Set<number>>;
  childrenOf: Map<number, Set<number>>;
  rootID: number | null;
};

export type Position = { x: number; y: number };
export type LayoutMode = 'tree' | 'radial' | 'concentric' | 'mindmap';

/** Kept here so the layout and the React Flow node cannot drift apart. */
export const MODEL_NODE_WIDTH = 160;
export const MODEL_NODE_HEIGHT = 44;

const H_GAP = 250;
const V_GAP = 80;
const RING_STEP = 230;
const MIN_ARC = 200;
const COMPONENT_GAP = 160;

function addToMap(map: Map<number, Set<number>>, id: number, other: number): void {
  let set = map.get(id);
  if (!set) {
    set = new Set();
    map.set(id, set);
  }
  set.add(other);
}

/** Builds the type-level canvas from the model relations. */
export function buildModelGraph(models: CIType[], relations: ModelRelation[]): ModelGraph {
  const byID = new Map(models.map((model) => [model.id, model]));
  const nodes = new Map<number, ModelGraphNode>();
  const parentsOf = new Map<number, Set<number>>();
  const childrenOf = new Map<number, Set<number>>();
  const links = new Map<string, ModelGraphLink>();

  const ensureNode = (id: number, fallback?: CIType): void => {
    if (nodes.has(id)) return;
    const model = byID.get(id) ?? fallback;
    nodes.set(id, {
      id,
      label: model?.alias || model?.name || `#${id}`,
      icon: model?.icon,
      level: 0,
    });
  };

  for (const relation of relations) {
    const parent = relation.parent.type;
    const child = relation.child.type;
    ensureNode(parent.id, parent);
    ensureNode(child.id, child);
    if (parent.id === child.id) continue;
    addToMap(parentsOf, child.id, parent.id);
    addToMap(childrenOf, parent.id, child.id);
    const key = `${parent.id}:${child.id}`;
    if (!links.has(key)) {
      links.set(key, {
        from: parent.id,
        to: child.id,
        label: relation.parent.relation_type?.name ?? '',
      });
    }
  }

  const unordered = [...nodes.values()].sort((left, right) => left.label.localeCompare(right.label));
  const rootID = pickRoot(unordered, parentsOf, childrenOf);
  const graph: ModelGraph = {
    nodes: unordered,
    links: [...links.values()],
    parentsOf,
    childrenOf,
    rootID,
  };

  // A node's colour should describe its depth in its own island, not how far
  // it happens to be from the largest island's root. Isolated models therefore
  // read as roots instead of all sharing the deepest colour.
  const levels = new Map<number, number>();
  for (const component of prepareComponents(graph)) {
    for (const [id, depth] of component.depth) levels.set(id, depth);
  }
  for (const node of unordered) node.level = levels.get(node.id) ?? 0;

  return graph;
}

function pickRoot(
  nodes: ModelGraphNode[],
  parentsOf: Map<number, Set<number>>,
  childrenOf: Map<number, Set<number>>,
): number | null {
  if (nodes.length === 0) return null;
  const roots = nodes.filter((node) => (parentsOf.get(node.id)?.size ?? 0) === 0);
  const candidates = roots.length > 0 ? roots : nodes;
  return [...candidates].sort((left, right) => {
    const byChildren = (childrenOf.get(right.id)?.size ?? 0) - (childrenOf.get(left.id)?.size ?? 0);
    if (byChildren !== 0) return byChildren;
    return left.label.localeCompare(right.label);
  })[0]?.id ?? null;
}

type PreparedComponent = {
  ids: number[];
  root: number;
  depth: Map<number, number>;
  layers: number[][];
  children: Map<number, number[]>;
  order: number[];
  leafCount: Map<number, number>;
};

/**
 * Splits the graph into connected components and gives each one a BFS tree.
 *
 * The BFS tree is only a layout scaffold: every original relation is still
 * drawn. Using a tree here is what lets the radial and mind-map layouts place a
 * node in its parent's angular wedge instead of scattering siblings by id.
 */
function prepareComponents(graph: ModelGraph, preferredRoot?: number | null): PreparedComponent[] {
  const nodeIDs = graph.nodes.map((node) => node.id);
  if (nodeIDs.length === 0) return [];
  const byID = new Map(graph.nodes.map((node) => [node.id, node]));
  const neighbours = new Map<number, number[]>();
  for (const id of nodeIDs) neighbours.set(id, []);
  for (const link of graph.links) {
    neighbours.get(link.from)?.push(link.to);
    neighbours.get(link.to)?.push(link.from);
  }
  for (const list of neighbours.values()) {
    list.sort((left, right) => {
      const byLabel = (byID.get(left)?.label ?? '').localeCompare(byID.get(right)?.label ?? '');
      return byLabel !== 0 ? byLabel : left - right;
    });
  }

  const seen = new Set<number>();
  const components: number[][] = [];
  for (const id of nodeIDs) {
    if (seen.has(id)) continue;
    const queue = [id];
    seen.add(id);
    const ids: number[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      ids.push(current);
      for (const next of neighbours.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    components.push(ids);
  }

  const prepared: PreparedComponent[] = [];
  for (const ids of components) {
    const usePreferred = preferredRoot != null && ids.includes(preferredRoot);
    const candidates = ids.filter((id) => (graph.parentsOf.get(id)?.size ?? 0) === 0);
    const pool = candidates.length > 0 ? candidates : ids;
    const root = usePreferred
      ? preferredRoot
      : [...pool].sort((left, right) => {
          const byChildren = (graph.childrenOf.get(right)?.size ?? 0) - (graph.childrenOf.get(left)?.size ?? 0);
          if (byChildren !== 0) return byChildren;
          return (byID.get(left)?.label ?? '').localeCompare(byID.get(right)?.label ?? '');
        })[0];
    if (root == null) continue;

    const depth = new Map<number, number>([[root, 0]]);
    const children = new Map<number, number[]>();
    const order: number[] = [root];
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const level = (depth.get(current) ?? 0) + 1;
      for (const next of neighbours.get(current) ?? []) {
        if (depth.has(next)) continue;
        depth.set(next, level);
        order.push(next);
        const list = children.get(current);
        if (list) list.push(next);
        else children.set(current, [next]);
        queue.push(next);
      }
    }

    const layers: number[][] = [];
    for (const id of order) {
      const level = depth.get(id) ?? 0;
      if (!layers[level]) layers[level] = [];
      layers[level].push(id);
    }

    const leafCount = new Map<number, number>();
    const countLeaves = (id: number): number => {
      const known = leafCount.get(id);
      if (known != null) return known;
      const kids = children.get(id) ?? [];
      const count = kids.length === 0 ? 1 : kids.reduce((sum, child) => sum + countLeaves(child), 0);
      leafCount.set(id, count);
      return count;
    };
    countLeaves(root);
    for (const id of order) countLeaves(id);

    prepared.push({ ids, root, depth, layers, children, order, leafCount });
  }

  prepared.sort((left, right) => {
    if (left.ids.length !== right.ids.length) return right.ids.length - left.ids.length;
    return (byID.get(left.root)?.label ?? '').localeCompare(byID.get(right.root)?.label ?? '');
  });
  return prepared;
}

type PositionedComponent = {
  positions: Map<number, Position>;
  minX: number;
  minY: number;
  width: number;
  height: number;
};

function measure(positions: Map<number, Position>): PositionedComponent {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const position of positions.values()) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + MODEL_NODE_WIDTH);
    maxY = Math.max(maxY, position.y + MODEL_NODE_HEIGHT);
  }
  if (!Number.isFinite(minX)) {
    return { positions, minX: 0, minY: 0, width: 0, height: 0 };
  }
  return {
    positions,
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Packs islands into readable rows instead of one very tall column.
 *
 * The target width is close to a square of the total area: a wide estate uses
 * the canvas, a few small islands do not leave a long empty strip beside them.
 */
function packComponents(components: Map<number, Position>[]): Map<number, Position> {
  const items = components.map(measure).filter((item) => item.width > 0 || item.height > 0);
  if (items.length === 0) return new Map();
  if (items.length === 1) {
    const only = items[0];
    const out = new Map<number, Position>();
    for (const [id, position] of only.positions) {
      out.set(id, { x: position.x - only.minX, y: position.y - only.minY });
    }
    return out;
  }

  const totalArea = items.reduce((sum, item) => sum + (item.width + COMPONENT_GAP) * (item.height + COMPONENT_GAP), 0);
  const widest = items.reduce((max, item) => Math.max(max, item.width), 0);
  const targetWidth = Math.max(widest, Math.sqrt(totalArea) * 1.45);
  const ordered = [...items].sort((left, right) => {
    const byArea = right.width * right.height - left.width * left.height;
    if (byArea !== 0) return byArea;
    return right.width - left.width || right.height - left.height;
  });

  const out = new Map<number, Position>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const item of ordered) {
    if (x > 0 && x + item.width > targetWidth) {
      x = 0;
      y += rowHeight + COMPONENT_GAP;
      rowHeight = 0;
    }
    const dx = x - item.minX;
    const dy = y - item.minY;
    for (const [id, position] of item.positions) {
      out.set(id, { x: position.x + dx, y: position.y + dy });
    }
    x += item.width + COMPONENT_GAP;
    rowHeight = Math.max(rowHeight, item.height);
  }
  return out;
}

function gridLayout(nodeIDs: number[]): Map<number, Position> {
  const out = new Map<number, Position>();
  const columns = Math.ceil(Math.sqrt(Math.max(nodeIDs.length, 1)));
  nodeIDs.forEach((id, index) => {
    out.set(id, {
      x: (index % columns) * H_GAP,
      y: Math.floor(index / columns) * V_GAP,
    });
  });
  return out;
}

/**
 * Left-to-right layered tree.
 *
 * Children are laid out as contiguous leaves and a parent is centred over its
 * first and last child. That is the difference between a tree that reads as a
 * hierarchy and one where every parent floats above an arbitrary midpoint.
 */
function treeLayout(graph: ModelGraph, preferredRoot?: number | null): Map<number, Position> {
  const prepared = prepareComponents(graph, preferredRoot);
  if (prepared.length === 0) return gridLayout(graph.nodes.map((node) => node.id));

  const components: Map<number, Position>[] = [];
  for (const component of prepared) {
    const positions = new Map<number, Position>();
    let cursor = 0;
    const place = (id: number): number => {
      const kids = component.children.get(id) ?? [];
      let y: number;
      if (kids.length === 0) {
        y = cursor;
        cursor += V_GAP;
      } else {
        const childYs = kids.map((child) => place(child));
        y = (childYs[0] + childYs[childYs.length - 1]) / 2;
      }
      positions.set(id, {
        x: (component.depth.get(id) ?? 0) * H_GAP,
        y,
      });
      return y;
    };
    place(component.root);
    components.push(positions);
  }
  return packComponents(components);
}

function ringRadii(layers: number[][], span: number): Map<number, number> {
  const radii = new Map<number, number>([[0, 0]]);
  let previous = 0;
  for (let depth = 1; depth < layers.length; depth += 1) {
    const count = layers[depth]?.length ?? 0;
    const arcRadius = span > 0 ? (count * MIN_ARC) / span : 0;
    const radius = Math.max(previous + RING_STEP, depth * RING_STEP, arcRadius);
    radii.set(depth, radius);
    previous = radius;
  }
  return radii;
}

function ringPosition(angle: number, radius: number): Position {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * A wedge-based radial tree.
 *
 * Each subtree owns a slice of its parent's wedge proportional to its leaf
 * count, so branches read outward from the root instead of being evenly mixed
 * around each ring. `span` is the full circle for radial and a right-facing fan
 * for the mind map.
 */
function radialTreeLayout(
  graph: ModelGraph,
  span: number,
  startAngle: number,
  preferredRoot?: number | null,
): Map<number, Position> {
  const prepared = prepareComponents(graph, preferredRoot);
  if (prepared.length === 0) return gridLayout(graph.nodes.map((node) => node.id));

  const components: Map<number, Position>[] = [];
  for (const component of prepared) {
    const positions = new Map<number, Position>();
    const radii = ringRadii(component.layers, span);
    positions.set(component.root, { x: 0, y: 0 });

    const placeSubtree = (id: number, angle: number, wedge: number, depth: number): void => {
      const radius = radii.get(depth) ?? depth * RING_STEP;
      positions.set(id, ringPosition(angle, radius));

      const kids = component.children.get(id) ?? [];
      if (kids.length === 0) return;
      const totalLeaves = kids.reduce((sum, child) => sum + (component.leafCount.get(child) ?? 1), 0);
      let cursor = angle - wedge / 2;
      for (const child of kids) {
        const childWedge = wedge * ((component.leafCount.get(child) ?? 1) / totalLeaves);
        const childAngle = kids.length === 1 ? angle : cursor + childWedge / 2;
        placeSubtree(child, childAngle, childWedge, depth + 1);
        cursor += childWedge;
      }
    };

    const rootKids = component.children.get(component.root) ?? [];
    if (rootKids.length > 0) {
      const totalLeaves = rootKids.reduce((sum, child) => sum + (component.leafCount.get(child) ?? 1), 0);
      let cursor = startAngle - span / 2;
      for (const child of rootKids) {
        const childWedge = span * ((component.leafCount.get(child) ?? 1) / totalLeaves);
        const childAngle = rootKids.length === 1 ? startAngle : cursor + childWedge / 2;
        placeSubtree(child, childAngle, childWedge, 1);
        cursor += childWedge;
      }
    }
    components.push(positions);
  }
  return packComponents(components);
}

/** Concentric rings: one ring per BFS depth, evenly spaced and rotated per ring. */
function concentricLayout(graph: ModelGraph, preferredRoot?: number | null): Map<number, Position> {
  const prepared = prepareComponents(graph, preferredRoot);
  if (prepared.length === 0) return gridLayout(graph.nodes.map((node) => node.id));

  const components: Map<number, Position>[] = [];
  for (const component of prepared) {
    const positions = new Map<number, Position>();
    const radii = ringRadii(component.layers, Math.PI * 2);
    positions.set(component.root, { x: 0, y: 0 });
    for (let depth = 1; depth < component.layers.length; depth += 1) {
      const layer = component.layers[depth] ?? [];
      const radius = radii.get(depth) ?? depth * RING_STEP;
      const step = (Math.PI * 2) / Math.max(layer.length, 1);
      const offset = -Math.PI / 2 + (depth % 2 === 0 ? step / 2 : 0);
      layer.forEach((id, index) => {
        positions.set(id, ringPosition(offset + index * step, radius));
      });
    }
    components.push(positions);
  }
  return packComponents(components);
}

/**
 * A two-sided mind map.
 *
 * Splitting the root's subtrees into a left and a right half keeps the height
 * of a bushy estate manageable, which the right-facing fan could not: a fan
 * with 36 leaves had to put all of them on one huge arc. Each side is still a
 * tidy tree, so branches stay readable and every edge leaves the side of a card
 * that faces its child.
 */
function mindmapLayout(graph: ModelGraph, preferredRoot?: number | null): Map<number, Position> {
  const prepared = prepareComponents(graph, preferredRoot);
  if (prepared.length === 0) return gridLayout(graph.nodes.map((node) => node.id));

  const components: Map<number, Position>[] = [];
  for (const component of prepared) {
    const positions = new Map<number, Position>();
    positions.set(component.root, { x: 0, y: 0 });
    const rootKids = component.children.get(component.root) ?? [];

    const sides: Array<{ kids: number[]; direction: 1 | -1 }> = [
      { kids: [], direction: 1 },
      { kids: [], direction: -1 },
    ];
    let rightLeaves = 0;
    let leftLeaves = 0;
    for (const child of rootKids) {
      const leaves = component.leafCount.get(child) ?? 1;
      // Greedy balance by leaf count keeps one rich branch from making the
      // whole map twice as tall as it needs to be.
      if (rightLeaves <= leftLeaves) {
        sides[0].kids.push(child);
        rightLeaves += leaves;
      } else {
        sides[1].kids.push(child);
        leftLeaves += leaves;
      }
    }

    for (const side of sides) {
      const totalLeaves = side.kids.reduce(
        (sum, child) => sum + (component.leafCount.get(child) ?? 1),
        0,
      );
      if (totalLeaves === 0) continue;
      let cursor = -(totalLeaves * V_GAP) / 2;
      const place = (id: number, depth: number): number => {
        const kids = component.children.get(id) ?? [];
        let y: number;
        if (kids.length === 0) {
          y = cursor;
          cursor += V_GAP;
        } else {
          const childYs = kids.map((child) => place(child, depth + 1));
          y = (childYs[0] + childYs[childYs.length - 1]) / 2;
        }
        positions.set(id, { x: side.direction * depth * H_GAP, y });
        return y;
      };
      for (const child of side.kids) place(child, 1);
    }

    components.push(positions);
  }
  return packComponents(components);
}

export function layoutModelGraph(
  graph: ModelGraph,
  mode: LayoutMode,
  preferredRoot?: number | null,
): Map<number, Position> {
  switch (mode) {
    case 'radial':
      return radialTreeLayout(graph, Math.PI * 2, -Math.PI / 2, preferredRoot);
    case 'concentric':
      return concentricLayout(graph, preferredRoot);
    case 'mindmap':
      return mindmapLayout(graph, preferredRoot);
    case 'tree':
    default:
      return treeLayout(graph, preferredRoot);
  }
}

export function pairKey(pair: TypePair): string {
  return `${pair.parent_id}:${pair.child_id}`;
}

export function pairKeys(pairs: TypePair[]): Set<string> {
  return new Set(pairs.map(pairKey));
}

export function definitionModelIDs(pairs: TypePair[]): number[] {
  return [...new Set(pairs.flatMap((pair) => [pair.parent_id, pair.child_id]))];
}

/**
 * The model a definition starts from: the parent that is never a child.
 * A cyclic definition has no such model, so the first pair's parent is used.
 */
export function definitionRoot(pairs: TypePair[]): number | null {
  if (pairs.length === 0) return null;
  const children = new Set(pairs.map((pair) => pair.child_id));
  return pairs.find((pair) => !children.has(pair.parent_id))?.parent_id ?? pairs[0].parent_id;
}

/** Pairs whose two ends are both in the selection; derived from live relations. */
export function pairsFromSelection(relations: ModelRelation[], selected: ReadonlySet<number>): TypePair[] {
  const seen = new Set<string>();
  const pairs: TypePair[] = [];
  for (const relation of relations) {
    const parentID = relation.parent.type.id;
    const childID = relation.child.type.id;
    if (parentID === childID) continue;
    if (!selected.has(parentID) || !selected.has(childID)) continue;
    const key = `${parentID}:${childID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ parent_id: parentID, child_id: childID });
  }
  return pairs;
}

/** One readable line for a definition; branching is called out, not flattened. */
export function serviceTreeChainTokens(
  pairs: TypePair[],
  label: (id: number) => string,
): string[] {
  if (pairs.length === 0) return [];
  const children = new Set(pairs.map((pair) => pair.child_id));
  const roots = pairs.map((pair) => pair.parent_id).filter((id) => !children.has(id));
  const start = roots[0] ?? pairs[0].parent_id;
  const tokens = [label(start)];
  let current = start;
  for (let guard = 0; guard <= pairs.length; guard += 1) {
    const childrenOfCurrent = pairs.filter((pair) => pair.parent_id === current);
    if (childrenOfCurrent.length === 0) break;
    if (childrenOfCurrent.length > 1) {
      tokens.push(`+${childrenOfCurrent.length}`);
      break;
    }
    current = childrenOfCurrent[0].child_id;
    tokens.push(label(current));
  }
  return tokens;
}
