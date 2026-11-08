import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronDown, ChevronRight, Loader2, Network, Plus } from 'lucide-react';

import { useI18n } from '@/i18n/locale';

import { listRelations, type ModelRelation } from '../api/citype';
import { describeError } from '../api/http';
import { searchHierarchy, type SearchRow } from '../api/instance';
import {
  type PlacedNode,
  type RelationGraph,
  type RelationNode,
  aggregateColumns,
  expansionFromRows,
  layoutRelationGraph,
  mergeExpansion,
} from '../lib/relation-graph';
import { InstanceDetailPeek } from './InstanceDetailPeek';

// The relation graph the assistant draws inline.
//
// The payload comes from the cmdb_relation_graph tool; this card only lays it
// out and lets the operator walk one more hop. Every expansion is a fresh
// hierarchy read with the caller's own credential, so the picture can never
// invent an edge the CMDB does not have.

const MAX_PER_COLUMN = 6;
const EXPANSION_COUNT = 200;

type CINodeData = {
  node: PlacedNode;
  isRoot: boolean;
  busy: boolean;
  onOpen(node: RelationNode): void;
  onExpand(node: RelationNode): void;
};

type MoreNodeData = { count: number };

type FlowNode = Node<CINodeData | MoreNodeData>;

function RelationNodeCard({ data }: NodeProps) {
  const { tr } = useI18n();
  const { node, isRoot, busy, onOpen, onExpand } = data as unknown as CINodeData;
  const name = node.name || tr(`CI ${node.id}`, `CI ${node.id}`);

  return (
    <div className="relative w-40 rounded-lg border border-border bg-card px-2.5 py-2 text-start shadow-sm">
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-text-faint/50" />
      {/* The whole card is the click target, like a resource row: the body
          button covers the padding too, and the expand control sits above it. */}
      <button
        type="button"
        aria-label={tr(`查看 ${name} 详情`, `View details for ${name}`)}
        onClick={() => onOpen(node)}
        className="nodrag nopan absolute inset-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
      />
      <div className="pointer-events-none relative">
        <span className="block truncate text-xs font-medium text-text">{name}</span>
        {node.type_name && (
          <span className="block truncate text-[10px] text-text-faint">{node.type_name}</span>
        )}
      </div>
      {!isRoot && (
        <button
          type="button"
          aria-label={tr(`展开 ${name} 一跳`, `Expand ${name} one hop`)}
          disabled={busy}
          aria-busy={busy}
          onClick={(event) => {
            event.stopPropagation();
            onExpand(node);
          }}
          className="nodrag nopan absolute -end-2 -top-2 z-10 grid size-5 place-items-center rounded-full border border-border bg-bg text-text-faint shadow-sm transition-colors hover:text-text motion-reduce:transition-none"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Plus className="size-3" aria-hidden="true" />
          )}
        </button>
      )}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-text-faint/50" />
    </div>
  );
}

function MoreNode({ data }: NodeProps) {
  const { tr } = useI18n();
  const { count } = data as unknown as MoreNodeData;
  return (
    <div className="rounded-full border border-dashed border-border bg-bg/80 px-2 py-1 text-[10px] whitespace-nowrap text-text-faint">
      {tr(`还有 ${count} 个`, `${count} more`)}
    </div>
  );
}

const nodeTypes = { ci: RelationNodeCard, more: MoreNode };

// The tool result is re-parsed into a new object on every chat re-render. A
// content signature lets the card tell "same graph, new object" apart from a
// genuinely new tool result, so an expansion is not wiped by a streaming token.
function graphSignature(graph: RelationGraph): string {
  const nodes = graph.nodes
    .map((node) => node.id)
    .sort((a, b) => a - b)
    .join(',');
  const edges = graph.edges
    .map((edge) => `${edge.source}>${edge.target}`)
    .sort()
    .join(',');
  return `${graph.root.id}|${nodes}|${edges}|${graph.counts.upstream}/${graph.counts.downstream}|${graph.truncated}`;
}

export function RelationGraphCard({ graph }: { graph: RelationGraph }) {
  const { tr } = useI18n();
  const [current, setCurrent] = useState(graph);
  const [collapsed, setCollapsed] = useState(false);
  const [busyID, setBusyID] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [peek, setPeek] = useState<{ id: number; typeID: number | null } | null>(null);

  const labelMap = useRef(new Map<string, string>());
  const labelsLoaded = useRef<Promise<void> | null>(null);
  const lastSignature = useRef('');
  const flowRef = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);

  useEffect(() => {
    const next = graphSignature(graph);
    if (next === lastSignature.current) return;
    lastSignature.current = next;
    setCurrent(graph);
    setExpanded(new Set());
    setError(null);
  }, [graph]);

  // `fitView` on ReactFlow only runs on mount. An expansion adds a column
  // outside the current viewport, which looks like a no-op on narrow screens
  // unless we re-fit after the new node set renders.
  useEffect(() => {
    const instance = flowRef.current;
    if (!instance) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const frame = window.requestAnimationFrame(() => {
      void instance.fitView({ padding: 0.2, duration: reduceMotion ? 0 : 220 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [current]);

  const ensureLabels = useCallback(async () => {
    if (!labelsLoaded.current) {
      labelsLoaded.current = listRelations()
        .then((rows: ModelRelation[]) => {
          for (const relation of rows) {
            labelMap.current.set(
              `${relation.parent.type.id}:${relation.child.type.id}`,
              relation.parent.relation_type.name,
            );
          }
        })
        .catch(() => undefined);
    }
    await labelsLoaded.current;
  }, []);

  const expand = useCallback(
    async (node: RelationNode) => {
      if (busyID !== null || expanded.has(node.id)) return;
      setBusyID(node.id);
      setError(null);
      try {
        await ensureLabels();
        const [children, parents] = await Promise.all([
          searchHierarchy({ rootIDs: [node.id], levels: [1], count: EXPANSION_COUNT, ret_key: 'name' }),
          searchHierarchy({
            rootIDs: [node.id],
            levels: [1],
            reverse: true,
            count: EXPANSION_COUNT,
            ret_key: 'name',
          }),
        ]);
        const addition = expansionFromRows(
          node,
          {
            children: (children.result ?? []) as SearchRow[],
            parents: (parents.result ?? []) as SearchRow[],
          },
          (parentTypeID, childTypeID) =>
            labelMap.current.get(`${parentTypeID}:${childTypeID}`) ?? '',
        );
        setCurrent((previous) => mergeExpansion(previous, addition));
        setExpanded((previous) => new Set(previous).add(node.id));
      } catch (err) {
        setError(describeError(err, tr('无法展开关系', 'Could not expand the relation')));
      } finally {
        setBusyID(null);
      }
    },
    [busyID, ensureLabels, expanded, tr],
  );

  const openNode = useCallback((node: RelationNode) => {
    setPeek({ id: node.id, typeID: node.type_id });
  }, []);

  const byID = useMemo(() => new Map(current.nodes.map((node) => [node.id, node])), [current.nodes]);

  const { flowNodes, flowEdges } = useMemo(() => {
    const placed = layoutRelationGraph(current);
    const { nodes, overflow } = aggregateColumns(placed.nodes, MAX_PER_COLUMN);

    const flowNodes: FlowNode[] = nodes.map((node) => ({
      id: String(node.id),
      type: 'ci',
      position: { x: node.x, y: node.y },
      data: {
        node,
        isRoot: node.id === current.root.id,
        busy: busyID === node.id,
        onOpen: openNode,
        onExpand: (next: RelationNode) => void expand(next),
      } satisfies CINodeData,
      draggable: false,
      // React Flow sets pointer-events: none on a node unless it is
      // selectable, draggable, or has a node-level handler. Our buttons are
      // the interaction surface, so opt the node back in explicitly.
      style: { pointerEvents: 'all' },
    }));
    for (const [index, group] of overflow.entries()) {
      flowNodes.push({
        id: `more-${group.side}-${group.depth}-${index}`,
        type: 'more',
        position: { x: group.x, y: group.y },
        data: { count: group.count } satisfies MoreNodeData,
        draggable: false,
      });
    }

    const flowEdges: Edge[] = placed.edges.map((edge) => ({
      id: `e-${edge.source}-${edge.target}`,
      source: String(edge.source),
      target: String(edge.target),
      label: edge.label,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));

    return { flowNodes, flowEdges };
  }, [busyID, current, expand, openNode]);

  return (
    <section className="w-full overflow-hidden rounded-lg border border-border bg-bg/40 text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Network size={13} className="text-text-faint" aria-hidden="true" />
        <span className="font-medium text-text">{tr('关系图', 'Relation graph')}</span>
        <span className="text-[11px] text-text-faint">
          {tr(`${current.counts.upstream} 上游`, `${current.counts.upstream} upstream`)}
          {' · '}
          {tr(`${current.counts.downstream} 下游`, `${current.counts.downstream} downstream`)}
        </span>
        {current.truncated && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            {tr('结果已截断', 'Truncated')}
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={
            collapsed
              ? tr('展开关系图', 'Expand relation graph')
              : tr('收起关系图', 'Collapse relation graph')
          }
          className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-bg/60 hover:text-text"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="h-72 w-full" data-testid="relation-graph-canvas">
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.2}
              onInit={(instance) => {
                flowRef.current = instance;
              }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>

          <details className="border-t border-border px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-medium text-text-muted">
              {tr('关联', 'Relations')}
            </summary>
            <ul className="mt-2 space-y-1">
              {current.edges.map((edge) => {
                const source = byID.get(edge.source);
                const target = byID.get(edge.target);
                const sourceName = source?.name || `CI ${edge.source}`;
                const targetName = target?.name || `CI ${edge.target}`;
                return (
                  <li key={`${edge.source}-${edge.target}`}>
                    <button
                      type="button"
                      onClick={() => target && openNode(target)}
                      className="w-full rounded px-1.5 py-1 text-start text-[11px] text-text-muted hover:bg-bg/60"
                    >
                      {sourceName} → {targetName}
                      {edge.label && <span className="ml-1 text-text-faint">({edge.label})</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>

          {error && (
            <p role="alert" className="border-t border-border px-3 py-2 text-[11px] text-destructive">
              {error}
            </p>
          )}
        </>
      )}

      {peek && (
        <InstanceDetailPeek
          instanceID={peek.id}
          typeID={peek.typeID ?? undefined}
          onClose={() => setPeek(null)}
        />
      )}
    </section>
  );
}
