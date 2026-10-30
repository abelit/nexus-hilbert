import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Background,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Crosshair, Download, Loader2, Map as MapIcon, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';

import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import { describeError } from '../../api/http';

import { relationChildren, relationParents, type CIType, type RelatedType } from '../../api/citype';
import type { ModelGroup } from '../../api/preferences';
import { useToast } from '../Toast';
import { ModelTopologyEdge, type ModelEdgePaintData } from './ModelTopologyEdge';
import { downloadTopologyPng } from './model-topology-export';
import { ModelTopologyNodeView, type ModelTopologyNodePayload } from './ModelTopologyNode';
import {
  MAX_VISIBLE_NODES,
  NEUTRAL_COLOR,
  badgeForNode,
  createInitialGraph,
  edgeHandles,
  groupColorMap,
  layoutModelGraph,
  mergeExpansion,
  visibleGraph,
  type ModelEdge,
  type ModelGraph,
  type ModelNode,
  type ProbeEntry,
} from './model-topology';

// The relation canvas for one model. The center is fixed: its parents grow
// left, its children grow right, and every other node can only grow further
// away from the center. Hovering probes the next hop without expanding it, so
// the badge can show a real count instead of guessing.

export type ModelRelationsTopologyProps = {
  center: CIType;
  parents: RelatedType[];
  children: RelatedType[];
  groups: ModelGroup[];
};

const nodeTypes = { model: ModelTopologyNodeView } as NodeTypes;
const edgeTypes = { model: ModelTopologyEdge } as EdgeTypes;
const PROBE_DELAY = 200;

export function ModelRelationsTopology(props: ModelRelationsTopologyProps) {
  return (
    <ReactFlowProvider>
      <TopologyCanvas {...props} />
    </ReactFlowProvider>
  );
}

function TopologyCanvas({ center, parents, children, groups }: ModelRelationsTopologyProps) {
  const { tr } = useI18n();
  const toast = useToast();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const navigate = useNavigate();
  const [graph, setGraph] = useState<ModelGraph>(() =>
    createInitialGraph(center, parents, children, groupColorMap(groups)),
  );
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([center.id]));
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showMinimap, setShowMinimap] = useState(
    () => window.matchMedia?.('(min-width: 1024px)')?.matches !== false,
  );
  const [exporting, setExporting] = useState(false);
  const [probeVersion, bumpProbes] = useReducer((version: number) => version + 1, 0);
  const probes = useRef<Map<string, ProbeEntry>>(new Map());
  const inFlight = useRef<Map<string, Promise<RelatedType[]>>>(new Map());
  // Latest committed graph, so an expansion that started before another
  // expansion or collapse lands on the current state instead of a stale
  // closure.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const centerRef = useRef(center);
  centerRef.current = center;
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const generation = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const colors = useMemo(() => groupColorMap(groups), [groups]);
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches === true;
  const fitOptions = useMemo(
    () => ({
      // Leave the minimap's corner free; a fit that tucks nodes under it hides
      // the very part of the graph the operator is looking for.
      padding: showMinimap ? { top: 0.1, right: 0.04, bottom: 1, left: 0.04 } : 0.18,
      duration: 300,
    }),
    [showMinimap],
  );

  useEffect(() => {
    generation.current += 1;
    probes.current = new Map();
    inFlight.current = new Map();
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setGraph(createInitialGraph(center, parents, children, groupColorMap(groups)));
    setExpanded(new Set([center.id]));
    setFocusedId(null);
    bumpProbes();
  }, [center, parents, children, groups]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const probeNode = useCallback(async (node: ModelNode): Promise<RelatedType[]> => {
    if (node.side === 'center') return [];
    const key = `${node.id}:${node.side}`;
    const cached = probes.current.get(key);
    if (cached?.status === 'ready') return cached.items;
    const pending = inFlight.current.get(key);
    if (pending) return pending;

    const flight = inFlight.current;
    const requestGeneration = generation.current;
    probes.current.set(key, { status: 'loading', items: [] });
    bumpProbes();

    const request = (node.side === 'left' ? relationParents(String(node.id)) : relationChildren(String(node.id)))
      .then((items) => {
        if (generation.current === requestGeneration) {
          probes.current.set(key, { status: 'ready', items });
          bumpProbes();
        }
        return items;
      })
      .catch((error: unknown) => {
        if (generation.current === requestGeneration) {
          probes.current.set(key, { status: 'error', items: [] });
          bumpProbes();
        }
        throw error;
      })
      .finally(() => {
        flight.delete(key);
      });

    flight.set(key, request);
    return request;
  }, []);

  const scheduleProbe = useCallback(
    (nodeId: number) => {
      const node = graph.nodes.get(nodeId);
      if (!node || node.side === 'center') return;
      const key = `${node.id}:${node.side}`;
      if (probes.current.has(key)) return;
      const previous = timers.current.get(nodeId);
      if (previous) clearTimeout(previous);
      timers.current.set(
        nodeId,
        setTimeout(() => {
          timers.current.delete(nodeId);
          void probeNode(node).catch(() => {});
        }, PROBE_DELAY),
      );
    },
    [graph, probeNode],
  );

  const cancelProbe = useCallback((nodeId: number) => {
    const timer = timers.current.get(nodeId);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(nodeId);
    }
  }, []);

  const handleEnter = useCallback(
    (nodeId: number) => {
      setFocusedId(nodeId);
      scheduleProbe(nodeId);
    },
    [scheduleProbe],
  );

  const handleLeave = useCallback(
    (nodeId: number) => {
      cancelProbe(nodeId);
      setFocusedId((current) => (current === nodeId ? null : current));
    },
    [cancelProbe],
  );

  const fitSoon = useCallback(() => {
    requestAnimationFrame(() => {
      void fitView(fitOptions);
    });
  }, [fitView, fitOptions]);

  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    requestAnimationFrame(() => fullscreenButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, closeFullscreen]);

  // The viewport changed size; refit after layout so fullscreen is not the
  // inline viewport stretched over a larger canvas.
  useEffect(() => {
    if (!fullscreen) return;
    const frame = requestAnimationFrame(() => {
      void fitView(fitOptions);
    });
    return () => cancelAnimationFrame(frame);
  }, [fullscreen, fitView, fitOptions]);

  const handleExport = useCallback(async () => {
    const element = containerRef.current;
    if (!element) return;
    setExporting(true);
    try {
      await fitView({ padding: 0.18, duration: 300 });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      await downloadTopologyPng(element, `cmdb-${center.name}-relations.png`);
    } catch (error) {
      toast.error(describeError(error, tr('导出失败', 'Export failed')));
    } finally {
      setExporting(false);
    }
  }, [center.name, fitView, toast, tr]);

  const expand = useCallback(
    async (nodeId: number) => {
      const node = graph.nodes.get(nodeId);
      if (!node || node.side === 'center') return;
      // A center change resets the graph while this request is in flight; its
      // result belongs to the old picture and must not be committed.
      const startGeneration = generation.current;

      let items: RelatedType[];
      try {
        items = await probeNode(node);
      } catch {
        toast.error(tr('无法读取下级关系', 'Could not load sub-relations'));
        return;
      }
      if (items.length === 0) return;
      if (generation.current !== startGeneration) return;

      const latestGraph = graphRef.current;
      const latestExpanded = expandedRef.current;
      const candidate = mergeExpansion(latestGraph, nodeId, items, colors);
      const nextExpanded = new Set(latestExpanded).add(nodeId);
      const nextVisible = visibleGraph(candidate, nextExpanded, centerRef.current.id);
      if (nextVisible.nodes.size > MAX_VISIBLE_NODES) {
        toast.error(tr('节点过多，请先折叠部分分支', 'Too many nodes; collapse a branch first'));
        return;
      }

      setGraph(candidate);
      setExpanded(nextExpanded);
      fitSoon();
    },
    [graph, colors, probeNode, toast, tr, fitSoon],
  );

  const collapse = useCallback(
    (nodeId: number) => {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(nodeId);
        return next;
      });
      fitSoon();
    },
    [fitSoon],
  );

  const toggle = useCallback(
    (nodeId: number) => {
      if (expanded.has(nodeId)) collapse(nodeId);
      else void expand(nodeId);
    },
    [expanded, collapse, expand],
  );

  // A mouse opens the model in one click. On a coarse pointer the first tap
  // only focuses, so the labels on that path are reachable on a phone; the
  // second tap opens. The center never navigates to itself.
  const openNode = useCallback(
    (nodeId: number) => {
      if (nodeId === center.id) return;
      if (!coarsePointer || focusedId === nodeId) {
        navigate(`/cmdb/models/${nodeId}?tab=relations`);
        return;
      }
      setFocusedId(nodeId);
      scheduleProbe(nodeId);
    },
    [center.id, coarsePointer, focusedId, navigate, scheduleProbe],
  );

  const visible = useMemo(() => visibleGraph(graph, expanded, center.id), [graph, expanded, center.id]);
  const visibleIds = useMemo(() => new Set(visible.nodes.keys()), [visible]);

  // The ReactFlow `fitView` prop uses its own default padding, which lets nodes
  // sit under the toolbar and minimap. Refit with the reserved corner padding
  // whenever the visible graph changes size.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void fitView(fitOptions);
    });
    return () => cancelAnimationFrame(frame);
  }, [center.id, visible.nodes.size, fitView, fitOptions]);
  const effectiveFocus = focusedId !== null && visible.nodes.has(focusedId) ? focusedId : null;
  const connected = useMemo(() => {
    if (effectiveFocus === null) return null;
    const nodeIDs = new Set<number>([effectiveFocus]);
    const edgeKeys = new Set<string>();
    for (const edge of visible.edges) {
      if (edge.source === effectiveFocus || edge.target === effectiveFocus) {
        edgeKeys.add(edge.key);
        nodeIDs.add(edge.source);
        nodeIDs.add(edge.target);
      }
    }
    return { nodeIDs, edgeKeys };
  }, [effectiveFocus, visible.edges]);
  const positions = useMemo(
    () => layoutModelGraph([...visible.nodes.values()], visible.edges, center.id),
    [visible, center.id],
  );

  const rfNodes = useMemo<Node<ModelTopologyNodePayload>[]>(
    () => {
      // The probe cache lives in a ref; the version is what makes settled
      // probes recompute the badges on the next render.
      void probeVersion;
      return [...visible.nodes.values()].map((node) => {
        const position = positions.get(node.id) ?? { x: 0, y: 0, width: 170, height: 56 };
        return {
          id: String(node.id),
          type: 'model',
          position: { x: position.x, y: position.y },
          width: position.width,
          height: position.height,
          draggable: false,
          data: {
            node,
            isCenter: node.side === 'center',
            badge: badgeForNode(
              node,
              expanded,
              probes.current.get(`${node.id}:${node.side}`),
              graph,
              visibleIds,
            ),
            dimmed: connected ? !connected.nodeIDs.has(node.id) : false,
            focused: effectiveFocus === node.id,
            onOpen: openNode,
            onToggle: toggle,
            onFocusNode: handleEnter,
            onBlurNode: handleLeave,
          },
        };
      });
    },
    [
      visible,
      positions,
      expanded,
      graph,
      visibleIds,
      probeVersion,
      connected,
      effectiveFocus,
      openNode,
      toggle,
      handleEnter,
      handleLeave,
    ],
  );

  const rfEdges = useMemo<Edge[]>(() => {
    const byPair = new Map<string, ModelEdge[]>();
    for (const edge of visible.edges) {
      const pair = `${edge.source}-${edge.target}`;
      const list = byPair.get(pair) ?? [];
      list.push(edge);
      byPair.set(pair, list);
    }
    return visible.edges.map((edge) => {
      const pair = [...(byPair.get(`${edge.source}-${edge.target}`) ?? [])].sort(
        (left, right) => left.relationId - right.relationId,
      );
      const index = pair.findIndex((item) => item.key === edge.key);
      const offset = index - (pair.length - 1) / 2;
      // Three parallel labels is the readable ceiling; the rest still draw
      // their own line so the relation count is visible.
      const labelAllowed = pair.length <= 3 || index < 3;
      const sourcePosition = positions.get(edge.source);
      const targetPosition = positions.get(edge.target);
      const handles = edgeHandles(
        sourcePosition ? sourcePosition.x + sourcePosition.width / 2 : 0,
        targetPosition ? targetPosition.x + targetPosition.width / 2 : 0,
      );
      const isConnected = Boolean(connected?.edgeKeys.has(edge.key));
      const data: ModelEdgePaintData = {
        label: edge.relationName,
        color: edge.relationColor,
        dimmed: Boolean(connected && !isConnected),
        showLabel: labelAllowed && (!connected || isConnected),
        connected: isConnected,
        offset,
      };
      return {
        id: edge.key,
        source: String(edge.source),
        target: String(edge.target),
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        type: 'model',
        data,
        markerEnd: { type: MarkerType.ArrowClosed, color: edge.relationColor },
      };
    });
  }, [visible.edges, connected, positions]);

  return (
    <div
      ref={containerRef}
      data-testid="topology-container"
      data-fullscreen={fullscreen ? 'true' : 'false'}
      className={cn(
        'cmdb-model-topology relative h-full min-h-[360px] w-full overflow-hidden',
        fullscreen && 'is-fullscreen',
        exporting && 'is-exporting',
      )}
    >
      <div className="cmdb-model-topology-toolbar absolute right-3 top-3 z-20">
        <div className="flex items-center gap-0.5 rounded-full border border-border bg-card p-1 shadow-sm">
          <Button
            variant="plain"
            size="sm"
            type="button"
            aria-label={tr('居中', 'Fit view')}
            title={tr('居中', 'Fit view')}
            onClick={() => void fitView(fitOptions)}
            className="inline-flex size-7 items-center justify-center p-0"
          >
            <Crosshair size={13} aria-hidden="true" />
          </Button>
          <Button
            variant="plain"
            size="sm"
            type="button"
            aria-label={tr('放大', 'Zoom in')}
            title={tr('放大', 'Zoom in')}
            onClick={() => void zoomIn()}
            className="inline-flex size-7 items-center justify-center p-0"
          >
            <ZoomIn size={13} aria-hidden="true" />
          </Button>
          <Button
            variant="plain"
            size="sm"
            type="button"
            aria-label={tr('缩小', 'Zoom out')}
            title={tr('缩小', 'Zoom out')}
            onClick={() => void zoomOut()}
            className="inline-flex size-7 items-center justify-center p-0"
          >
            <ZoomOut size={13} aria-hidden="true" />
          </Button>
          <Button
            ref={fullscreenButtonRef}
            variant="plain"
            size="sm"
            type="button"
            aria-label={fullscreen ? tr('关闭全屏', 'Close fullscreen') : tr('全屏', 'Fullscreen')}
            title={fullscreen ? tr('关闭全屏', 'Close fullscreen') : tr('全屏', 'Fullscreen')}
            onClick={() => setFullscreen((current) => !current)}
            className="inline-flex size-7 items-center justify-center p-0"
          >
            {fullscreen ? <X size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
          </Button>
          <Button
            variant="plain"
            size="sm"
            type="button"
            aria-label={tr('导出图片', 'Export image')}
            title={tr('导出图片', 'Export image')}
            disabled={exporting}
            onClick={() => void handleExport()}
            className="inline-flex size-7 items-center justify-center p-0"
          >
            {exporting ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <Download size={13} aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="plain"
            size="sm"
            type="button"
            aria-label={tr('迷你地图', 'Minimap')}
            title={tr('迷你地图', 'Minimap')}
            aria-pressed={showMinimap}
            onClick={() => setShowMinimap((current) => !current)}
            className="inline-flex size-7 items-center justify-center p-0"
          >
            <MapIcon size={13} aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="h-full pt-12">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.25}
        maxZoom={2}
        nodesDraggable={false}
        elementsSelectable={false}
        onNodeMouseEnter={(_event, node) => handleEnter(Number(node.id))}
        onNodeMouseLeave={(_event, node) => handleLeave(Number(node.id))}
        onPaneClick={() => {
          setFocusedId(null);
          for (const timer of timers.current.values()) clearTimeout(timer);
          timers.current.clear();
        }}
      >
        <Background />
        {showMinimap && (
          <MiniMap
            style={{ width: 130, height: 80 }}
            nodeColor={(node) =>
              (node.data as ModelTopologyNodePayload)?.node?.groupColor ?? NEUTRAL_COLOR
            }
          />
        )}
      </ReactFlow>
      </div>
    </div>
  );
}
