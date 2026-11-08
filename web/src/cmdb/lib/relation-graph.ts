/**
 * The payload of the `cmdb_relation_graph` tool, and the layout rules the chat
 * card draws it with.
 *
 * Kept away from React Flow and the API so both can be tested directly: the
 * parser is the only place that decides whether a tool result is a graph, and
 * the layout is a pure function of that graph.
 */

export type RelationNode = {
  id: number
  name: string
  type_id: number | null
  type_name: string
}

export type RelationEdge = {
  source: number
  target: number
  label: string
}

export type RelationGraph = {
  root: RelationNode
  nodes: RelationNode[]
  edges: RelationEdge[]
  counts: { upstream: number; downstream: number }
  truncated: boolean
}

export type GraphSide = 'root' | 'up' | 'down'

export type PlacedNode = RelationNode & {
  side: GraphSide
  /** Hops from the root, along the path the node was first reached by. */
  depth: number
  x: number
  y: number
}

/** One column per hop; wide enough for a two-line CI card. */
export const COLUMN_WIDTH = 260
/** Vertical pitch between two nodes in the same column. */
export const ROW_HEIGHT = 86

type Obj = Record<string, unknown>

/** A row from the hierarchy search the expansion reads. */
export type RawRelationCI = {
  _id?: number
  _type?: number
  name?: unknown
  hostname?: unknown
  ci_type?: string
  ci_type_alias?: string | null
}

function asObject(value: unknown): Obj | null {
  let raw = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Obj
}

function toNode(value: unknown): RelationNode | null {
  const node = asObject(value)
  if (!node || typeof node.id !== 'number') return null
  return {
    id: node.id,
    name: typeof node.name === 'string' ? node.name : '',
    type_id: typeof node.type_id === 'number' ? node.type_id : null,
    type_name: typeof node.type_name === 'string' ? node.type_name : '',
  }
}

/**
 * Parse a tool result into a graph, or `null` when it is not one.
 *
 * Accepts an object or a JSON string (history replay stores `result_raw` for
 * rows the server could not parse). Anything the card cannot draw falls back
 * to the generic tool row instead of rendering an empty canvas. Edges to nodes
 * outside the payload and duplicate nodes/edges are dropped, so a malformed
 * result can only lose an edge, never crash the renderer.
 */
export function parseRelationGraph(value: unknown): RelationGraph | null {
  const payload = asObject(value)
  if (!payload) return null
  const root = toNode(payload.root)
  if (!root || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    return null
  }

  const nodes: RelationNode[] = []
  const byId = new Set<number>()
  for (const raw of payload.nodes) {
    const node = toNode(raw)
    if (!node || byId.has(node.id)) continue
    byId.add(node.id)
    nodes.push(node)
  }
  if (!byId.has(root.id)) nodes.unshift(root)

  const edges: RelationEdge[] = []
  const seen = new Set<string>()
  for (const raw of payload.edges) {
    const edge = asObject(raw)
    if (!edge || typeof edge.source !== 'number' || typeof edge.target !== 'number') {
      continue
    }
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    const key = `${edge.source}_${edge.target}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      source: edge.source,
      target: edge.target,
      label: typeof edge.label === 'string' ? edge.label : '',
    })
  }

  const counts = asObject(payload.counts) ?? {}
  return {
    root,
    nodes,
    edges,
    counts: {
      upstream: typeof counts.upstream === 'number' ? counts.upstream : 0,
      downstream: typeof counts.downstream === 'number' ? counts.downstream : 0,
    },
    truncated: payload.truncated === true,
  }
}

/**
 * Place every node on a left/right grid around the root.
 *
 * Direction is the CMDB's: walking an edge away from its `source` is
 * downstream (right), walking it back towards its `target` is upstream (left).
 * The root sits in the middle column, and each hop adds one column.
 */
export function layoutRelationGraph(graph: RelationGraph): {
  nodes: PlacedNode[]
  edges: RelationEdge[]
} {
  const adjacency = new Map<number, Array<{ id: number; side: 'up' | 'down' }>>()
  for (const edge of graph.edges) {
    const out = adjacency.get(edge.source) ?? []
    out.push({ id: edge.target, side: 'down' })
    adjacency.set(edge.source, out)
    const back = adjacency.get(edge.target) ?? []
    back.push({ id: edge.source, side: 'up' })
    adjacency.set(edge.target, back)
  }

  // A branch's side is decided by the FIRST step out of the root and then
  // inherited: everything hanging off a parent belongs to the upstream family
  // (its other children are siblings, not downstream nodes), and everything
  // under a child belongs to the downstream one.
  const placed = new Map<number, { side: GraphSide; depth: number }>()
  placed.set(graph.root.id, { side: 'root', depth: 0 })
  const queue: Array<{ id: number; depth: number; side: GraphSide }> = [
    { id: graph.root.id, depth: 0, side: 'root' },
  ]
  while (queue.length) {
    const current = queue.shift() as { id: number; depth: number; side: GraphSide }
    for (const neighbour of adjacency.get(current.id) ?? []) {
      if (placed.has(neighbour.id)) continue
      const side = current.side === 'root' ? neighbour.side : (current.side as 'up' | 'down')
      placed.set(neighbour.id, { side, depth: current.depth + 1 })
      queue.push({ id: neighbour.id, depth: current.depth + 1, side })
    }
  }

  const columns = new Map<string, RelationNode[]>()
  for (const node of graph.nodes) {
    const spot = placed.get(node.id) ?? { side: 'root' as GraphSide, depth: 0 }
    const key = `${spot.side}:${spot.depth}`
    const column = columns.get(key) ?? []
    column.push(node)
    columns.set(key, column)
  }

  const nodes: PlacedNode[] = []
  for (const node of graph.nodes) {
    const spot = placed.get(node.id) ?? { side: 'root' as GraphSide, depth: 0 }
    const column = columns.get(`${spot.side}:${spot.depth}`) ?? [node]
    const index = column.findIndex((item) => item.id === node.id)
    const offset = index - (column.length - 1) / 2
    const direction = spot.side === 'up' ? -1 : spot.side === 'down' ? 1 : 0
    nodes.push({
      ...node,
      side: spot.side,
      depth: spot.depth,
      x: direction * spot.depth * COLUMN_WIDTH,
      y: offset * ROW_HEIGHT,
    })
  }

  return { nodes, edges: graph.edges }
}

/** How many nodes of one column are hidden behind its aggregate chip. */
export type ColumnOverflow = {
  side: GraphSide
  depth: number
  count: number
  x: number
  y: number
}

/**
 * Keep at most `max` nodes per column, reporting the rest as one aggregate.
 *
 * A subnet with fifty children is a legitimate graph and an illegible picture:
 * the chip keeps the shape readable, and the relation list below still carries
 * every edge. The fullscreen view passes no cap, so "see the big picture"
 * remains possible.
 */
export function aggregateColumns(
  nodes: PlacedNode[],
  max: number,
): { nodes: PlacedNode[]; overflow: ColumnOverflow[] } {
  if (max <= 0) return { nodes, overflow: [] }

  const groups = new Map<string, PlacedNode[]>()
  for (const node of nodes) {
    const key = `${node.side}:${node.depth}`
    const group = groups.get(key) ?? []
    group.push(node)
    groups.set(key, group)
  }

  const kept: PlacedNode[] = []
  const overflow: ColumnOverflow[] = []
  for (const group of groups.values()) {
    if (group[0].side === 'root' || group.length <= max) {
      kept.push(...group)
      continue
    }
    // The cap keeps the column's first nodes; re-centre them (the chip counts
    // as one more row) so the shortened column still sits around the root.
    const shown = group.slice(0, max)
    const rows = shown.length + 1
    const offset = (rows - 1) / 2
    shown.forEach((node, index) => {
      kept.push({ ...node, y: (index - offset) * ROW_HEIGHT })
    })
    const last = shown[shown.length - 1]
    overflow.push({
      side: last.side,
      depth: last.depth,
      count: group.length - max,
      x: last.x,
      y: (shown.length - offset) * ROW_HEIGHT,
    })
  }

  return { nodes: kept, overflow }
}

function rowToNode(ci: RawRelationCI): RelationNode | null {
  if (typeof ci._id !== 'number') return null
  const alias = typeof ci.ci_type_alias === 'string' ? ci.ci_type_alias : ''
  let name = ''
  if (typeof ci.name === 'string' && ci.name) name = ci.name
  else if (typeof ci.hostname === 'string' && ci.hostname) name = ci.hostname
  if (!name) name = alias
  return {
    id: ci._id,
    name,
    type_id: typeof ci._type === 'number' ? ci._type : null,
    type_name: alias || (typeof ci.ci_type === 'string' ? ci.ci_type : ''),
  }
}

/**
 * Turn one expansion's search rows into graph pieces. Direction stays the
 * CMDB's: a parent points at the expanded node, the expanded node points at a
 * child. `labelFor` resolves the relation name from the two model ids because
 * the hierarchy search rows do not carry a relation type id.
 */
export function expansionFromRows(
  node: RelationNode,
  rows: { children: RawRelationCI[]; parents: RawRelationCI[] },
  labelFor: (parentTypeID: number | null, childTypeID: number | null) => string,
): { nodes: RelationNode[]; edges: RelationEdge[] } {
  const nodes: RelationNode[] = []
  const ids = new Set<number>([node.id])
  const add = (ci: RawRelationCI) => {
    const mapped = rowToNode(ci)
    if (!mapped || ids.has(mapped.id)) return null
    ids.add(mapped.id)
    nodes.push(mapped)
    return mapped
  }

  const edges: RelationEdge[] = []
  for (const ci of rows.children) {
    const child = add(ci)
    const childId = child?.id ?? ci._id
    if (childId == null || childId === node.id) continue
    const childTypeID = child?.type_id ?? (typeof ci._type === 'number' ? ci._type : null)
    edges.push({
      source: node.id,
      target: childId,
      label: labelFor(node.type_id, childTypeID),
    })
  }
  for (const ci of rows.parents) {
    const parent = add(ci)
    const parentId = parent?.id ?? ci._id
    if (parentId == null || parentId === node.id) continue
    const parentTypeID = parent?.type_id ?? (typeof ci._type === 'number' ? ci._type : null)
    edges.push({
      source: parentId,
      target: node.id,
      label: labelFor(parentTypeID, node.type_id),
    })
  }

  return { nodes, edges }
}

/** Merge one expansion, dropping duplicate nodes/edges and dangling edges. */
export function mergeExpansion(
  graph: RelationGraph,
  addition: { nodes: RelationNode[]; edges: RelationEdge[] },
): RelationGraph {
  const ids = new Set(graph.nodes.map((node) => node.id))
  const nodes = [...graph.nodes]
  for (const node of addition.nodes) {
    if (ids.has(node.id)) continue
    ids.add(node.id)
    nodes.push(node)
  }

  const keys = new Set(graph.edges.map((edge) => `${edge.source}_${edge.target}`))
  const edges = [...graph.edges]
  for (const edge of addition.edges) {
    const key = `${edge.source}_${edge.target}`
    if (keys.has(key)) continue
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    keys.add(key)
    edges.push(edge)
  }

  return { ...graph, nodes, edges }
}
