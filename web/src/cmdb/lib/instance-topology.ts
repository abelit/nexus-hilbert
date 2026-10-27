import type { RelatedType, TypeAttribute } from '../api/citype';
import type { SearchRow } from '../api/instance';
import { displayValue } from './valuetype';

// The data half of the instance topology.
//
// THE TREE IS THE LAYOUT, THE EDGES ARE THE GRAPH. A node can gain edges back
// to a node the tree already shows, but it is never duplicated: a CI reached
// twice is one card with two relationships. Keeping that split here makes the
// canvas component about drawing, not about relation bookkeeping.

export type TopoSide = 'left' | 'right';
export type TopoLayout = 'mindmap' | 'compactBox';

export type TopoTreeNode = {
  id: string;
  title: string;
  icon?: string;
  side?: TopoSide;
  unique: string;
  attrs: TypeAttribute[];
  values: Record<string, unknown>;
  ciID?: number;
  typeID?: number;
  isRoot: boolean;
  expanded: boolean;
  children: TopoTreeNode[];
};

export type TopoEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  color?: string;
};

export type TopoTree = {
  root: TopoTreeNode;
  edges: TopoEdge[];
};

export type InitialTopoInput = {
  rootID: string;
  rootTitle: string;
  rootIcon?: string;
  rootLabel: string;
  rootAttrs: TypeAttribute[];
  rootValues: Record<string, unknown>;
  rootCIID: number;
  rootTypeID: number;
  parentTypes: RelatedType[];
  childTypes: RelatedType[];
  parentRows: SearchRow[];
  childRows: SearchRow[];
};

const H_GAP = 280;
const V_GAP = 96;

export function rowLabel(row: SearchRow, related?: RelatedType): string {
  // THE MODEL'S DISPLAY KEY WINS over the backend's uniqueness key. An IP
  // address is unique by ipam_address_id, but its card belongs to the `ip`
  // value; showing an internal id under every address makes the graph useless.
  const candidates = [
    related?.show_key,
    related?.type.unique_key,
    typeof row.unique === 'string' ? row.unique : '',
    'name',
  ].filter((key): key is string => Boolean(key));
  for (const key of candidates) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') {
      return displayValue(value);
    }
  }
  return displayValue(row.ci_type_alias) || `#${row._id}`;
}

function rowNode(row: SearchRow, related: RelatedType, side: TopoSide): TopoTreeNode {
  const type = related.type;
  return {
    id: String(row._id),
    title: type.alias || type.name || row.ci_type_alias || `CI ${row._id}`,
    icon: type.icon,
    side,
    unique: rowLabel(row, related),
    attrs: related.attributes ?? [],
    values: row,
    ciID: Number(row._id),
    typeID: Number(row._type),
    isRoot: false,
    expanded: false,
    children: [],
  };
}

/** Build the initial one-hop tree around the current instance. */
export function buildInitialTree(input: InitialTopoInput): TopoTree {
  const root: TopoTreeNode = {
    id: input.rootID,
    title: input.rootTitle,
    icon: input.rootIcon,
    unique: input.rootLabel,
    attrs: input.rootAttrs,
    values: input.rootValues,
    ciID: input.rootCIID,
    typeID: input.rootTypeID,
    isRoot: true,
    expanded: false,
    children: [],
  };
  const edges: TopoEdge[] = [];
  const seen = new Map<number, string>();
  seen.set(input.rootCIID, root.id);
  const edgeIDs = new Set<string>();

  const addRows = (side: TopoSide, types: RelatedType[], rows: SearchRow[]) => {
    for (const related of types) {
      const typeRows = rows.filter((row) => Number(row._type) === Number(related.type.id));
      for (const row of typeRows) {
        const ciID = Number(row._id);
        if (ciID === input.rootCIID) continue;
        let nodeID = seen.get(ciID);
        if (!nodeID) {
          const node = rowNode(row, related, side);
          nodeID = node.id;
          seen.set(ciID, nodeID);
          root.children.push(node);
        }
        const sourceId = side === 'left' ? nodeID : root.id;
        const targetId = side === 'left' ? root.id : nodeID;
        const id = `${sourceId}_${targetId}`;
        if (edgeIDs.has(id)) continue;
        edgeIDs.add(id);
        edges.push({
          id,
          sourceId,
          targetId,
          label: related.relation_type?.name || '',
          color: related.relation_type?.color || undefined,
        });
      }
    }
  };

  addRows('left', input.parentTypes, input.parentRows);
  addRows('right', input.childTypes, input.childRows);
  return { root, edges };
}

export function findTreeNode(root: TopoTreeNode, id: string): TopoTreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return null;
}

export function collectNodeIDs(root: TopoTreeNode): Map<number, string> {
  const ids = new Map<number, string>();
  const walk = (node: TopoTreeNode) => {
    if (node.ciID !== undefined) ids.set(Number(node.ciID), node.id);
    node.children.forEach(walk);
  };
  walk(root);
  return ids;
}

export function flattenTree(root: TopoTreeNode): TopoTreeNode[] {
  const out: TopoTreeNode[] = [];
  const walk = (node: TopoTreeNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

function appendChildren(
  root: TopoTreeNode,
  id: string,
  children: TopoTreeNode[],
): TopoTreeNode {
  if (root.id === id) {
    const seen = new Set(root.children.map((child) => child.id));
    return {
      ...root,
      expanded: true,
      children: [...root.children, ...children.filter((child) => !seen.has(child.id))],
    };
  }
  return {
    ...root,
    children: root.children.map((child) => appendChildren(child, id, children)),
  };
}

export type ExpansionDirection = {
  rows: SearchRow[];
  types: RelatedType[];
  /** True when the rows are the node's parents rather than its children. */
  parents: boolean;
  /** Only the outward direction may add new nodes. */
  allowNewNodes: boolean;
};

export type ExpansionResult = {
  tree: TopoTree;
  added: boolean;
};

/**
 * Work out what expanding one node adds.
 *
 * Existing CIs only gain edges; only the outward direction can introduce cards.
 * That is what keeps a bushy graph from duplicating a CI each time a second
 * path reaches it.
 */
export function planExpansion(
  tree: TopoTree,
  nodeID: string,
  outward: ExpansionDirection,
  inward: ExpansionDirection,
): ExpansionResult {
  const node = findTreeNode(tree.root, nodeID);
  if (!node?.side) return { tree, added: false };

  const nodeIDs = collectNodeIDs(tree.root);
  const edgeIDs = new Set(tree.edges.map((edge) => edge.id));
  const newNodes: TopoTreeNode[] = [];
  const newEdges: TopoEdge[] = [];

  const addDirection = (direction: ExpansionDirection) => {
    for (const row of direction.rows) {
      const ciID = Number(row._id);
      if (!Number.isFinite(ciID) || ciID === node.ciID) continue;
      const related = direction.types.find((type) => Number(type.type.id) === Number(row._type));
      if (!related) continue;
      const existingID = nodeIDs.get(ciID);
      if (!existingID && !direction.allowNewNodes) continue;
      const counterpartID = existingID ?? String(row._id);
      const sourceId = direction.parents ? counterpartID : node.id;
      const targetId = direction.parents ? node.id : counterpartID;
      const edgeID = `${sourceId}_${targetId}`;
      if (edgeIDs.has(edgeID)) continue;
      edgeIDs.add(edgeID);
      newEdges.push({
        id: edgeID,
        sourceId,
        targetId,
        label: related.relation_type?.name || '',
        color: related.relation_type?.color || undefined,
      });
      if (existingID) continue;
      nodeIDs.set(ciID, counterpartID);
      newNodes.push(rowNode(row, related, node.side!));
    }
  };

  addDirection(outward);
  addDirection(inward);

  if (newNodes.length === 0 && newEdges.length === 0) {
    return { tree, added: false };
  }
  return {
    added: true,
    tree: {
      root: appendChildren(tree.root, nodeID, newNodes),
      edges: [...tree.edges, ...newEdges],
    },
  };
}

/** Mindmap puts parents left and children right; compactBox puts every level right. */
export function computeTopoLayout(
  root: TopoTreeNode,
  mode: TopoLayout,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  let leaf = 0;

  const walk = (node: TopoTreeNode, depth: number): number => {
    let y: number;
    if (node.children.length === 0) {
      y = leaf * V_GAP;
      leaf += 1;
    } else {
      const childY = node.children.map((child) => walk(child, depth + 1));
      y = childY.reduce((sum, value) => sum + value, 0) / childY.length;
    }
    const side = node.side === 'left' ? -1 : node.side === 'right' ? 1 : 0;
    const x = (mode === 'compactBox' ? 1 : side) * depth * H_GAP;
    positions.set(node.id, { x, y });
    return y;
  };

  const rootY = walk(root, 0);
  for (const position of positions.values()) position.y -= rootY;
  return positions;
}
