import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Checkbox } from '@/components/ui/Checkbox';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { useThemeMode } from '@/store/mode';

import {
  MODEL_NODE_HEIGHT,
  MODEL_NODE_WIDTH,
  type LayoutMode,
  type ModelGraph,
  type Position as ModelPosition,
} from '../../lib/model-relation-graph';
import { CMDBIcon } from '../CMDBIcon';

// The model-relation canvas.
//
// CANTOR DREW THE CI-TYPE GRAPH WITH REACT FLOW and laid it out by a selectable
// algorithm; this keeps that interaction and adds two things the console needs:
// a saved definition stays highlighted, and edit mode selects a set of models
// with checkboxes instead of a separate form. The graph is a controlled list of
// nodes with local drag overrides, so changing the selection never snaps a node
// the operator has positioned.

const LEVEL_COLORS = ['#4f46e5', '#0ea5e9', '#8b5cf6', '#14b8a6', '#f59e0b', '#64748b'];
const NODE_WIDTH = MODEL_NODE_WIDTH;
const NODE_HEIGHT = MODEL_NODE_HEIGHT;
const HIDDEN_HANDLE_STYLE = { visibility: 'hidden' as const };

/**
 * Edges meet the side of the card that faces their other end.
 *
 * A radial tree has children on every side of a parent; keeping the single
 * left-to-right handle pair there would loop every west-bound edge around the
 * card. The node owns four hidden handles and each edge picks one by geometry.
 */
function handlePair(from: ModelPosition, to: ModelPosition): {
  sourceHandle: string;
  targetHandle: string;
} {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'source-right', targetHandle: 'target-left' }
      : { sourceHandle: 'source-left', targetHandle: 'target-right' };
  }
  return dy >= 0
    ? { sourceHandle: 'source-bottom', targetHandle: 'target-top' }
    : { sourceHandle: 'source-top', targetHandle: 'target-bottom' };
}

function edgeTypeForLayout(mode: LayoutMode): string {
  switch (mode) {
    case 'radial':
    case 'concentric':
      return 'straight';
    case 'mindmap':
      return 'simplebezier';
    case 'tree':
    default:
      return 'smoothstep';
  }
}

type ModelNodeData = {
  label: string;
  icon?: string;
  level: number;
  editMode: boolean;
  selected: boolean;
  inDefinition: boolean;
  dimmed: boolean;
};

const ToggleContext = createContext<(id: number) => void>(() => {});

function ModelNode({ id, data }: NodeProps<Node<ModelNodeData>>) {
  const { tr } = useI18n();
  const toggle = useContext(ToggleContext);
  const color = LEVEL_COLORS[Math.min(Math.abs(data.level), LEVEL_COLORS.length - 1)];
  const accent = data.selected || data.inDefinition;
  return (
    <div
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        borderColor: accent ? '#6366f1' : color,
        boxShadow: accent ? '0 0 0 2px rgb(99 102 241 / 0.25)' : undefined,
        opacity: data.dimmed ? 0.32 : 1,
      }}
      className={cn(
        'flex items-center gap-1.5 rounded-lg border-2 bg-card px-2.5 text-text shadow-sm transition-[opacity,border-color] duration-150',
        data.editMode ? 'cursor-default' : 'cursor-pointer',
      )}
      title={data.editMode ? undefined : tr('查看模型详情', 'View model details')}
    >
      <Handle id="target-left" type="target" position={Position.Left} style={HIDDEN_HANDLE_STYLE} />
      <Handle id="target-top" type="target" position={Position.Top} style={HIDDEN_HANDLE_STYLE} />
      <Handle id="target-right" type="target" position={Position.Right} style={HIDDEN_HANDLE_STYLE} />
      <Handle id="target-bottom" type="target" position={Position.Bottom} style={HIDDEN_HANDLE_STYLE} />
      {data.editMode && (
        <span
          className="nodrag inline-flex shrink-0"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            checked={data.selected}
            onCheckedChange={() => toggle(Number(id))}
            aria-label={tr(`选择模型 ${data.label}`, `Select model ${data.label}`)}
            className="size-4"
          />
        </span>
      )}
      <CMDBIcon value={data.icon} size={16} label={data.label} />
      <span className="min-w-0 flex-1 truncate text-xs" title={data.label}>
        {data.label}
      </span>
      <Handle id="source-left" type="source" position={Position.Left} style={HIDDEN_HANDLE_STYLE} />
      <Handle id="source-top" type="source" position={Position.Top} style={HIDDEN_HANDLE_STYLE} />
      <Handle id="source-right" type="source" position={Position.Right} style={HIDDEN_HANDLE_STYLE} />
      <Handle id="source-bottom" type="source" position={Position.Bottom} style={HIDDEN_HANDLE_STYLE} />
    </div>
  );
}

const nodeTypes = { model: ModelNode };

export function RelationGraph({
  graph,
  positions,
  layoutMode,
  editMode,
  selectedNodes,
  highlightedNodes,
  highlightedPairs,
  focusIDs,
  focusKey,
  resetKey,
  onToggleNode,
  onOpenNode,
  onCloseNode,
}: {
  graph: ModelGraph;
  positions: Map<number, ModelPosition>;
  layoutMode: LayoutMode;
  editMode: boolean;
  selectedNodes: ReadonlySet<number>;
  highlightedNodes: ReadonlySet<number>;
  highlightedPairs: ReadonlySet<string>;
  /** The nodes to frame when the definition or layout changes. */
  focusIDs: number[];
  /** Changes only on a definition/layout change, not on every tick. */
  focusKey: string;
  /** Incremented by the page's "reset layout" action. */
  resetKey: number;
  onToggleNode(id: number): void;
  /** View mode: open the model preview card for this node. */
  onOpenNode(id: number): void;
  /** Dismiss the preview when the canvas background is clicked. */
  onCloseNode(): void;
}) {
  const { resolved } = useThemeMode();
  const isLight = resolved === 'light';
  const flowRef = useRef<ReactFlowInstance<Node<ModelNodeData>, Edge> | null>(null);
  const [ready, setReady] = useState(false);
  const [dragged, setDragged] = useState<Record<number, ModelPosition>>({});
  const lastReset = useRef(resetKey);
  const focusRef = useRef(focusIDs);
  focusRef.current = focusIDs;

  // A new layout is authoritative; manual drags belong to the old one.
  useEffect(() => {
    setDragged({});
  }, [positions]);

  // Reset keeps the same positions map, so it clears the drags explicitly.
  useEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    setDragged({});
  }, [resetKey]);

  const nodes = useMemo<Node<ModelNodeData>[]>(
    () =>
      graph.nodes.map((node) => {
        const inDefinition = highlightedNodes.has(node.id);
        return {
          id: String(node.id),
          type: 'model',
          position: dragged[node.id] ?? positions.get(node.id) ?? { x: 0, y: 0 },
          data: {
            label: node.label,
            icon: node.icon,
            level: node.level,
            editMode,
            selected: selectedNodes.has(node.id),
            inDefinition,
            dimmed: !editMode && highlightedNodes.size > 0 && !inDefinition,
          },
        };
      }),
    [dragged, editMode, graph.nodes, highlightedNodes, positions, selectedNodes],
  );

  const edges = useMemo<Edge[]>(() => {
    const hasHighlight = highlightedPairs.size > 0;
    // A dense estate is unreadable when every relation carries a label. Keep
    // labels for small graphs and for the chain that is currently highlighted.
    const showLabels = graph.links.length <= 28;
    const type = edgeTypeForLayout(layoutMode);
    const positionOf = (id: number) => dragged[id] ?? positions.get(id) ?? { x: 0, y: 0 };
    return graph.links.map((link) => {
      const key = `${link.from}:${link.to}`;
      const active = highlightedPairs.has(key);
      // In edit mode every edge stays readable; in view mode a selected
      // definition recedes the rest of the estate.
      const dimmed = !editMode && hasHighlight && !active;
      const handles = handlePair(positionOf(link.from), positionOf(link.to));
      return {
        id: key,
        source: String(link.from),
        target: String(link.to),
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        type,
        label: dimmed || (!active && !showLabels) ? '' : link.label,
        markerEnd: { type: MarkerType.ArrowClosed, color: active ? '#6366f1' : '#94a3b8' },
        style: {
          stroke: active ? '#6366f1' : '#94a3b8',
          strokeWidth: active ? 2.4 : 1.2,
          opacity: dimmed ? 0.16 : 1,
        },
        labelStyle: {
          fill: isLight ? '#475569' : '#cbd5e1',
          fontSize: 10,
          opacity: dimmed ? 0 : 1,
        },
        labelBgStyle: {
          fill: isLight ? '#ffffff' : '#18181b',
          fillOpacity: 0.9,
        },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
      };
    });
  }, [dragged, editMode, graph.links, highlightedPairs, isLight, layoutMode, positions]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setDragged((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue;
        if (next === current) next = { ...current };
        next[Number(change.id)] = change.position;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // Fit the positions this layout produced, not React Flow's measured
        // store: a selection can change positions and focus in the same tick,
        // and the store may still hold the previous layout's measurements.
        const ids = focusRef.current.length > 0 ? focusRef.current : graph.nodes.map((node) => node.id);
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const id of ids) {
          const position = positions.get(id);
          if (!position) continue;
          minX = Math.min(minX, position.x);
          minY = Math.min(minY, position.y);
          maxX = Math.max(maxX, position.x + NODE_WIDTH);
          maxY = Math.max(maxY, position.y + NODE_HEIGHT);
        }
        if (Number.isFinite(minX) && Number.isFinite(minY)) {
          flowRef.current?.fitBounds(
            { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
            { padding: focusRef.current.length > 0 ? 0.25 : 0.12, duration: 220 },
          );
        } else {
          flowRef.current?.fitView({ padding: 0.2, duration: 220 });
        }
      }),
    );
    return () => cancelAnimationFrame(frame);
    // `focusKey` changes when the definition or layout changes; a per-click
    // selection must not move the viewport.
  }, [focusKey, graph.nodes, positions, ready]);

  return (
    <ToggleContext.Provider value={onToggleNode}>
      <div className="cmdb-relation-graph h-full min-h-0 w-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => {
            if (editMode) onToggleNode(Number(node.id));
            else onOpenNode(Number(node.id));
          }}
          onPaneClick={onCloseNode}
          onInit={(instance) => {
            flowRef.current = instance;
            setReady(true);
          }}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.15}
          maxZoom={2}
          style={{ background: isLight ? '#fafafa' : '#09090b' }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            color={isLight ? '#d4d4d8' : '#27272a'}
            gap={20}
          />
          {/* A focused chain is a small viewport inside a much larger graph;
              the minimap then renders as one grey mask over the chain. */}
          {focusIDs.length === 0 && (
            <MiniMap
              style={{ width: 132, height: 88 }}
              maskColor={isLight ? 'rgba(15, 23, 42, 0.10)' : 'rgba(0, 0, 0, 0.45)'}
              nodeColor={(node) =>
                LEVEL_COLORS[(node.data as ModelNodeData).level % LEVEL_COLORS.length] ?? '#a1a1aa'
              }
              nodeStrokeColor="rgba(0,0,0,0.35)"
              nodeStrokeWidth={1}
              nodeBorderRadius={3}
              pannable
              zoomable
            />
          )}
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </ToggleContext.Provider>
  );
}
