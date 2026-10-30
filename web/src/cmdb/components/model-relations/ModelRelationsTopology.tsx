import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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

import { useI18n } from '@/i18n/locale';

import { relationChildren, relationParents, type CIType, type RelatedType } from '../../api/citype';
import type { ModelGroup } from '../../api/preferences';
import { useToast } from '../Toast';
import { ModelTopologyEdge, type ModelEdgePaintData } from './ModelTopologyEdge';
import { ModelTopologyNodeView, type ModelTopologyNodePayload } from './ModelTopologyNode';
import {
  MAX_VISIBLE_NODES,
  NEUTRAL_COLOR,
  badgeForNode,
  createInitialGraph,
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
  const { fitView } = useReactFlow();
  const [graph, setGraph] = useState<ModelGraph>(() =>
    createInitialGraph(center, parents, children, groupColorMap(groups)),
  );
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([center.id]));
  const [probeVersion, bumpProbes] = useReducer((version: number) => version + 1, 0);
  const probes = useRef<Map<string, ProbeEntry>>(new Map());
  const inFlight = useRef<Map<string, Promise<RelatedType[]>>>(new Map());
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const generation = useRef(0);
  const colors = useMemo(() => groupColorMap(groups), [groups]);

  useEffect(() => {
    generation.current += 1;
    probes.current = new Map();
    inFlight.current = new Map();
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setGraph(createInitialGraph(center, parents, children, groupColorMap(groups)));
    setExpanded(new Set([center.id]));
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

  const fitSoon = useCallback(() => {
    requestAnimationFrame(() => {
      void fitView({ padding: 0.18, duration: 300 });
    });
  }, [fitView]);

  const expand = useCallback(
    async (nodeId: number) => {
      const node = graph.nodes.get(nodeId);
      if (!node || node.side === 'center') return;

      let items: RelatedType[];
      try {
        items = await probeNode(node);
      } catch {
        toast.error(tr('无法读取下级关系', 'Could not load sub-relations'));
        return;
      }
      if (items.length === 0) return;

      const candidate = mergeExpansion(graph, nodeId, items, colors);
      const nextExpanded = new Set(expanded).add(nodeId);
      const nextVisible = visibleGraph(candidate, nextExpanded, center.id);
      if (nextVisible.nodes.size > MAX_VISIBLE_NODES) {
        toast.error(tr('节点过多，请先折叠部分分支', 'Too many nodes; collapse a branch first'));
        return;
      }

      setGraph(candidate);
      setExpanded(nextExpanded);
      fitSoon();
    },
    [graph, expanded, colors, center.id, probeNode, toast, tr, fitSoon],
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

  const openNode = useCallback((_nodeId: number) => {}, []);

  const visible = useMemo(() => visibleGraph(graph, expanded, center.id), [graph, expanded, center.id]);
  const visibleIds = useMemo(() => new Set(visible.nodes.keys()), [visible]);
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
            dimmed: false,
            focused: false,
            onOpen: openNode,
            onToggle: toggle,
          },
        };
      });
    },
    [visible, positions, expanded, graph, visibleIds, probeVersion, openNode, toggle],
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
      const pair = byPair.get(`${edge.source}-${edge.target}`) ?? [];
      const index = pair.findIndex((item) => item.key === edge.key);
      const offset = index - (pair.length - 1) / 2;
      const data: ModelEdgePaintData = {
        label: edge.relationName,
        color: edge.relationColor,
        dimmed: false,
        showLabel: true,
        offset,
      };
      return {
        id: edge.key,
        source: String(edge.source),
        target: String(edge.target),
        type: 'model',
        data,
        markerEnd: { type: MarkerType.ArrowClosed, color: edge.relationColor },
      };
    });
  }, [visible.edges]);

  return (
    <div className="cmdb-model-topology relative h-[480px] w-full overflow-hidden sm:h-[560px]">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.25}
        maxZoom={2}
        nodesDraggable={false}
        elementsSelectable={false}
        onNodeMouseEnter={(_event, node) => scheduleProbe(Number(node.id))}
        onNodeMouseLeave={(_event, node) => cancelProbe(Number(node.id))}
        onPaneClick={() => {
          for (const timer of timers.current.values()) clearTimeout(timer);
          timers.current.clear();
        }}
      >
        <Background />
        <MiniMap
          nodeColor={(node) => (node.data as ModelTopologyNodePayload)?.node?.groupColor ?? NEUTRAL_COLOR}
        />
      </ReactFlow>
    </div>
  );
}
