import { describe, expect, it } from 'vitest'

import {
  COLUMN_WIDTH,
  type RelationGraph,
  aggregateColumns,
  expansionFromRows,
  layoutRelationGraph,
  mergeExpansion,
  parseRelationGraph,
} from './relation-graph'

function graphFixture(): RelationGraph {
  return {
    root: { id: 1, name: 'web-01', type_id: 3, type_name: 'server' },
    nodes: [
      { id: 1, name: 'web-01', type_id: 3, type_name: 'server' },
      { id: 9, name: 'app-01', type_id: 5, type_name: 'app' },
      { id: 2, name: 'db-01', type_id: 4, type_name: 'mysql' },
      { id: 3, name: 'db-02', type_id: 4, type_name: 'mysql' },
    ],
    edges: [
      { source: 9, target: 1, label: 'runs on' },
      { source: 1, target: 2, label: 'depends on' },
      { source: 1, target: 3, label: 'depends on' },
    ],
    counts: { upstream: 1, downstream: 2 },
    truncated: false,
  }
}

describe('parseRelationGraph', () => {
  it('accepts the tool payload', () => {
    const parsed = parseRelationGraph(graphFixture())
    expect(parsed?.root.name).toBe('web-01')
    expect(parsed?.nodes).toHaveLength(4)
    expect(parsed?.edges).toHaveLength(3)
  })

  it('accepts a JSON string result', () => {
    const parsed = parseRelationGraph(JSON.stringify(graphFixture()))
    expect(parsed?.root.id).toBe(1)
    expect(parsed?.counts.downstream).toBe(2)
  })

  it('rejects a non-graph result', () => {
    expect(parseRelationGraph(null)).toBeNull()
    expect(parseRelationGraph({ items: [] })).toBeNull()
    expect(parseRelationGraph({ root: null, nodes: [], edges: [] })).toBeNull()
    expect(parseRelationGraph({ root: { id: 1 }, nodes: 'nope', edges: [] })).toBeNull()
    expect(parseRelationGraph('not json')).toBeNull()
  })

  it('drops duplicate nodes, duplicate edges and dangling edges', () => {
    const payload = graphFixture()
    const parsed = parseRelationGraph({
      ...payload,
      nodes: [...payload.nodes, payload.nodes[0]],
      edges: [
        ...payload.edges,
        payload.edges[0],
        { source: 1, target: 999, label: 'ghost' },
      ],
    })
    expect(parsed?.nodes).toHaveLength(4)
    expect(parsed?.edges).toHaveLength(3)
  })
})

describe('layoutRelationGraph', () => {
  it('puts parents left of the root and children right', () => {
    const placed = layoutRelationGraph(graphFixture())
    const byId = new Map(placed.nodes.map((node) => [node.id, node]))

    expect(byId.get(1)).toMatchObject({ side: 'root', x: 0 })
    expect(byId.get(9)).toMatchObject({ side: 'up', depth: 1, x: -COLUMN_WIDTH })
    expect(byId.get(2)).toMatchObject({ side: 'down', depth: 1, x: COLUMN_WIDTH })
  })

  it('stacks nodes in one column without overlapping', () => {
    const placed = layoutRelationGraph(graphFixture())
    const children = placed.nodes.filter((node) => node.side === 'down')
    const ys = children.map((node) => node.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1])
    }
  })

  it('inherits the branch side after the first hop', () => {
    const graph = graphFixture()
    graph.nodes.push(
      { id: 8, name: 'sibling-app', type_id: 5, type_name: 'app' },
      { id: 4, name: 'db-03', type_id: 4, type_name: 'mysql' },
    )
    graph.edges.push(
      { source: 9, target: 8, label: 'runs on' }, // sibling of root under the parent
      { source: 2, target: 4, label: 'replica' }, // deeper downstream
    )
    const placed = layoutRelationGraph(graph)
    const byId = new Map(placed.nodes.map((node) => [node.id, node]))
    expect(byId.get(8)).toMatchObject({ side: 'up', depth: 2, x: -2 * COLUMN_WIDTH })
    expect(byId.get(4)).toMatchObject({ side: 'down', depth: 2, x: 2 * COLUMN_WIDTH })
  })
})

describe('aggregateColumns', () => {
  it('keeps at most max nodes per column and reports the rest', () => {
    const graph = graphFixture()
    for (let i = 0; i < 12; i++) {
      graph.nodes.push({ id: 100 + i, name: `host-${i}`, type_id: 4, type_name: 'mysql' })
      graph.edges.push({ source: 1, target: 100 + i, label: 'contain' })
    }
    const placed = layoutRelationGraph(graph)
    const { nodes, overflow } = aggregateColumns(placed.nodes, 6)

    expect(nodes.filter((node) => node.side === 'down')).toHaveLength(6)
    expect(overflow).toHaveLength(1)
    expect(overflow[0]).toMatchObject({ side: 'down', depth: 1, count: 8 })
  })
})

describe('expansionFromRows', () => {
  it('links children downstream and parents upstream with labels', () => {
    const node = graphFixture().root
    const addition = expansionFromRows(
      node,
      {
        children: [{ _id: 2, _type: 4, name: 'db-01', ci_type_alias: 'mysql' }],
        parents: [{ _id: 9, _type: 5, name: 'app-01', ci_type_alias: 'app' }],
      },
      (parentTypeID, childTypeID) =>
        parentTypeID === 3 && childTypeID === 4
          ? 'depends on'
          : parentTypeID === 5 && childTypeID === 3
            ? 'runs on'
            : '',
    )

    expect(addition.nodes.map((n) => n.id).sort()).toEqual([2, 9])
    expect(addition.edges).toEqual([
      { source: 1, target: 2, label: 'depends on' },
      { source: 9, target: 1, label: 'runs on' },
    ])
  })
})

describe('mergeExpansion', () => {
  it('merges without duplicates or dangling edges', () => {
    const graph = graphFixture()
    const merged = mergeExpansion(graph, {
      nodes: [
        { id: 2, name: 'db-01', type_id: 4, type_name: 'mysql' }, // existing
        { id: 7, name: 'switch-01', type_id: 6, type_name: 'switch' },
      ],
      edges: [
        { source: 1, target: 2, label: 'depends on' }, // existing
        { source: 1, target: 7, label: 'connects' },
        { source: 1, target: 404, label: 'ghost' }, // dangling
      ],
    })

    expect(merged.nodes.map((n) => n.id).sort()).toEqual([1, 2, 3, 7, 9])
    expect(merged.edges.filter((e) => e.target === 7)).toHaveLength(1)
    expect(merged.edges.some((e) => e.target === 404)).toBe(false)
    expect(merged.edges.filter((e) => e.source === 1 && e.target === 2)).toHaveLength(1)
  })
})
