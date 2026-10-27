import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Loader2, Plus, RefreshCw, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { useThemeMode } from '@/store/mode';

import type { CIType, TypeAttribute } from '../../api/citype';
import { relationChildren, relationParents } from '../../api/citype';
import { describeError } from '../../api/http';
import { searchHierarchy, type Instance } from '../../api/instance';
import {
  buildInitialTree,
  computeTopoLayout,
  findTreeNode,
  flattenTree,
  planExpansion,
  type TopoLayout,
  type TopoTree,
} from '../../lib/instance-topology';
import { displayValue } from '../../lib/valuetype';
import { CMDBIcon } from '../CMDBIcon';
import { useToast } from '../Toast';

// 资源拓扑 — the instance-centred graph ported from cantor's CIDetailRelationTopo.
//
// The graph is a TREE FOR LAYOUT and a GRAPH FOR RELATIONS. Parents sit left of
// the root, children right, and a leaf can be expanded outward one hop at a
// time. An expanded object that is already on the canvas gains another edge
// instead of a duplicate card.
//
// The floating detail card is intentionally a panel inside the tab rather than
// a viewport-positioned overlay: the drawer already owns the overlay/focus
// stack, and positioning a second fixed layer inside a portalled modal is a
// source of clipping bugs at phone width.

type TopoNodeData = {
  title: string;
  icon?: string;
  unique: string;
  side?: 'left' | 'right';
  isRoot: boolean;
  attrs: TypeAttribute[];
  values: Record<string, unknown>;
  ciID?: number;
  typeID?: number;
  expandable: boolean;
};

const TopoActionsContext = createContext<{
  onExpand(id: string): void;
  expanding: string | null;
}>({ onExpand: () => undefined, expanding: null });

function TopoNodeView({ id, data, selected }: NodeProps<Node<TopoNodeData>>) {
  const { tr } = useI18n();
  const { onExpand, expanding } = useContext(TopoActionsContext);
  return (
    <div className={cn('relative', data.isRoot ? 'w-52' : 'w-44')}>
      <div
        className={cn(
          'flex w-full cursor-grab items-center gap-2 rounded-lg border bg-card px-2.5 py-2 shadow-sm transition-colors active:cursor-grabbing',
          data.isRoot
            ? 'border-sky-500/50 font-semibold ring-1 ring-sky-500/20'
            : 'border-border hover:border-sky-500/40',
          selected && 'ring-2 ring-sky-500/30',
        )}
      >
        <Handle type="target" position={Position.Left} className="!pointer-events-none !opacity-0" />
        <CMDBIcon value={data.icon} size={18} label={data.title} />
        <span className="min-w-0 truncate text-xs">{data.title}</span>
        <Handle type="source" position={Position.Right} className="!pointer-events-none !opacity-0" />
      </div>
      {data.unique && (
        <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-0.5 w-44 -translate-x-1/2 truncate text-center text-[10px] leading-4 text-text-muted/80">
          {data.unique}
        </div>
      )}
      {data.expandable && (
        <button
          type="button"
          title={tr(`展开 ${data.unique}`, `Expand ${data.unique}`)}
          aria-label={tr(`展开 ${data.unique}`, `Expand ${data.unique}`)}
          disabled={expanding !== null}
          onClick={(event) => {
            event.stopPropagation();
            onExpand(id);
          }}
          className={cn(
            'absolute top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg text-text-muted shadow-sm transition hover:border-sky-500/50 hover:text-sky-500 disabled:opacity-50',
            data.side === 'left' ? '-left-2.5' : '-right-2.5',
          )}
        >
          {expanding === id ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        </button>
      )}
    </div>
  );
}

const nodeTypes = { ci: TopoNodeView };

function DetailCard({ data, onClose }: { data: TopoNodeData; onClose(): void }) {
  const { tr } = useI18n();
  const rows = data.attrs
    .map((attribute) => {
      const raw = data.values?.[attribute.name];
      if (raw === undefined || raw === null || raw === '') return null;
      const value = attribute.is_password ? '••••••' : displayValue(raw);
      return {
        key: `${attribute.id}-${attribute.name}`,
        label: attribute.alias || attribute.name,
        value: value || '—',
      };
    })
    .filter((row): row is { key: string; label: string; value: string } => Boolean(row));

  return (
    <aside className="absolute bottom-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
      <header className="flex items-center justify-between gap-2 border-b border-border bg-bg/40 px-3 py-2">
        <div className="min-w-0">
          <h4 className="truncate text-xs font-semibold text-text">{data.title}</h4>
          {data.unique && <p className="truncate text-[10px] text-text-muted">{data.unique}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('关闭节点详情', 'Close node details')}
          className="shrink-0 rounded p-1 text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto px-3 py-2">
        {rows.length ? (
          rows.map((row) => (
            <div key={row.key} className="flex items-start gap-2 border-b border-border/50 py-1.5 last:border-0">
              <span className="w-24 shrink-0 truncate text-[11px] text-text-faint">{row.label}</span>
              <span className="min-w-0 flex-1 break-words text-[11px] text-text">{row.value}</span>
            </div>
          ))
        ) : (
          <p className="py-6 text-center text-[11px] text-text-faint">{tr('没有可显示的值', 'No values to show')}</p>
        )}
      </div>
    </aside>
  );
}

export function InstanceTopology({
  model,
  attributes,
  instance,
  instanceID,
  instanceLabel,
}: {
  model: CIType;
  attributes: TypeAttribute[];
  instance: Instance | null;
  instanceID: number;
  instanceLabel: string;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { resolved } = useThemeMode();
  const [tree, setTree] = useState<TopoTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [layout, setLayout] = useState<TopoLayout>('mindmap');
  const [showRelationStyle, setShowRelationStyle] = useState(true);
  const [expanding, setExpanding] = useState<string | null>(null);
  const [active, setActive] = useState<TopoNodeData | null>(null);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<TopoNodeData>>([]);
  const treeRef = useRef<TopoTree | null>(null);
  const flowRef = useRef<ReactFlowInstance<Node<TopoNodeData>, Edge> | null>(null);
  const lastLayoutRef = useRef<TopoLayout | null>(null);
  const renderedCountRef = useRef(0);
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setTree(null);
    setActive(null);
    void Promise.all([
      relationParents(model.name),
      relationChildren(model.name),
      searchHierarchy({ rootIDs: [instanceID], levels: [1], reverse: true, count: 200, ret_key: 'name' }),
      searchHierarchy({ rootIDs: [instanceID], levels: [1], count: 200, ret_key: 'name' }),
    ])
      .then(([parentTypes, childTypes, parentsPage, childrenPage]) => {
        if (!live) return;
        setTree(
          buildInitialTree({
            rootID: `Root_${model.id}`,
            rootTitle: model.alias || model.name,
            rootIcon: model.icon,
            rootLabel: instanceLabel,
            rootAttrs: attributes,
            rootValues: instance?.values ?? {},
            rootCIID: instanceID,
            rootTypeID: model.id,
            parentTypes,
            childTypes,
            parentRows: parentsPage.result ?? [],
            childRows: childrenPage.result ?? [],
          }),
        );
      })
      .catch((err) => {
        if (live) setError(describeError(err, tr('无法读取资源拓扑', 'Could not load the resource topology')));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [attributes, instance, instanceID, instanceLabel, model, retryKey, tr]);

  const expandNode = useCallback(
    async (nodeID: string) => {
      const current = treeRef.current;
      const node = current ? findTreeNode(current.root, nodeID) : null;
      if (!current || !node?.side || node.expanded || node.ciID === undefined || node.typeID === undefined) return;
      setExpanding(nodeID);
      try {
        const outwardParents = node.side === 'left';
        const [outwardPage, inwardPage, parentTypes, childTypes] = await Promise.all([
          searchHierarchy({ rootIDs: [node.ciID], levels: [1], reverse: outwardParents, count: 200, ret_key: 'name' }),
          searchHierarchy({ rootIDs: [node.ciID], levels: [1], reverse: !outwardParents, count: 200, ret_key: 'name' }),
          relationParents(node.typeID),
          relationChildren(node.typeID),
        ]);
        const outwardTypes = outwardParents ? parentTypes : childTypes;
        const inwardTypes = outwardParents ? childTypes : parentTypes;
        setTree((currentTree) => {
          if (!currentTree) return currentTree;
          const result = planExpansion(
            currentTree,
            nodeID,
            {
              rows: outwardPage.result ?? [],
              types: outwardTypes,
              parents: outwardParents,
              allowNewNodes: true,
            },
            {
              rows: inwardPage.result ?? [],
              types: inwardTypes,
              parents: !outwardParents,
              allowNewNodes: false,
            },
          );
          if (!result.added) {
            toast.info(tr('没有更多层级', 'No further levels'));
            return currentTree;
          }
          return result.tree;
        });
      } catch (err) {
        toast.error(describeError(err, tr('无法展开拓扑', 'Could not expand the topology')));
      } finally {
        setExpanding(null);
      }
    },
    [toast, tr],
  );

  const nodes = useMemo(() => (tree ? flattenTree(tree.root) : []), [tree]);

  useEffect(() => {
    if (!tree) {
      setRfNodes([]);
      return;
    }
    const positions = computeTopoLayout(tree.root, layout);
    setRfNodes(
      nodes.map((node) => ({
        id: node.id,
        type: 'ci',
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: {
          title: node.title,
          icon: node.icon,
          unique: node.unique,
          side: node.side,
          isRoot: node.isRoot,
          attrs: node.attrs,
          values: node.values,
          ciID: node.ciID,
          typeID: node.typeID,
          expandable: Boolean(node.side) && !node.expanded && node.children.length === 0,
        },
      })),
    );
    // FIT ONLY AFTER EVERY NODE HAS A MEASURED SIZE. A fitView in the next
    // animation frame can run while only the first node is measured, which
    // clips a parent sitting to the left of the root out of the viewport.
    const layoutChanged = lastLayoutRef.current !== layout;
    lastLayoutRef.current = layout;
    const previousCount = renderedCountRef.current;
    renderedCountRef.current = nodes.length;
    // A 50-address subnet has too many leaves to fit legibly. The first view
    // centres the root, and later expansions leave the viewport where the
    // operator put it instead of zooming the whole estate to a postage stamp.
    const centreLargeGraph = nodes.length > 24;
    const shouldMoveViewport = !centreLargeGraph || layoutChanged || previousCount === 0;

    let cancelled = false;
    let raf = 0;
    const fitWhenMeasured = (attempt: number) => {
      if (cancelled) return;
      const current = flowRef.current?.getNodes() ?? [];
      const measured = current.length === nodes.length
        && current.every((node) => Boolean(node.measured?.width && node.measured?.height));
      if (!measured && attempt < 20) {
        raf = requestAnimationFrame(() => fitWhenMeasured(attempt + 1));
        return;
      }
      if (!flowRef.current || !shouldMoveViewport) return;
      if (!centreLargeGraph) {
        void flowRef.current.fitView({ padding: 0.2, duration: reduceMotion ? 0 : 300 });
        return;
      }
      const root = current.find((node) => node.id === `Root_${model.id}`);
      if (!root) return;
      flowRef.current.setCenter(
        root.position.x + (root.measured?.width ?? 176) / 2,
        root.position.y + (root.measured?.height ?? 44) / 2,
        { zoom: 0.75, duration: reduceMotion ? 0 : 300 },
      );
    };
    raf = requestAnimationFrame(() => fitWhenMeasured(0));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [layout, model.id, nodes, reduceMotion, setRfNodes, tree]);

  const edges = useMemo<Edge[]>(() => {
    if (!tree) return [];
    return tree.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      label: showRelationStyle && edge.label ? edge.label : undefined,
      labelStyle: { fontSize: 11, fill: '#64748b' },
      labelBgStyle: {
        fill: resolved === 'dark' ? 'rgba(20,20,20,0.92)' : 'rgba(255,255,255,0.92)',
        fillOpacity: 1,
      },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 3,
      style: showRelationStyle && edge.color ? { stroke: edge.color } : undefined,
      markerEnd: showRelationStyle
        ? { type: MarkerType.ArrowClosed, color: edge.color ?? '#94a3b8' }
        : undefined,
    }));
  }, [resolved, showRelationStyle, tree]);

  if (loading) {
    return <p className="py-8 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>;
  }
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
        <span className="min-w-0 flex-1 break-words">{error}</span>
        <Button variant="outline" size="sm" type="button" onClick={() => setRetryKey((key) => key + 1)}>
          {tr('重试', 'Retry')}
        </Button>
      </div>
    );
  }

  const hasEdges = Boolean(tree && tree.edges.length > 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {tr(
            `${nodes.length} 个节点 · ${tree?.edges.length ?? 0} 条关系`,
            `${nodes.length} nodes · ${tree?.edges.length ?? 0} relations`,
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => setRetryKey((key) => key + 1)}
          className="inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} aria-hidden="true" />
          {tr('刷新拓扑', 'Refresh topology')}
        </Button>
      </div>

      {!hasEdges || !tree ? (
        <div className="rounded-xl border border-border bg-card/40">
          <EmptyState
            className="flex min-h-48 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
            title={tr('这个资源还没有关系', 'This resource has no relations yet')}
            hint={tr(
              '在模型关系中配置层级后，父级和子级会在这里组成拓扑。',
              'Once the model relations define a hierarchy, parents and children appear here as a graph.',
            )}
          />
        </div>
      ) : (
        <div className="relative h-[min(60vh,34rem)] min-h-[20rem] w-full overflow-hidden rounded-xl border border-border bg-card">
          <TopoActionsContext.Provider value={{ onExpand: (id) => void expandNode(id), expanding }}>
            <ReactFlow
              nodes={rfNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.2, duration: reduceMotion ? 0 : 300 }}
              onInit={(instance) => {
                flowRef.current = instance;
              }}
              onNodesChange={onNodesChange}
              onNodeClick={(_, node) => setActive(node.data)}
              onPaneClick={() => setActive(null)}
              nodesConnectable={false}
              elementsSelectable
              zoomOnDoubleClick={false}
              minZoom={0.2}
              maxZoom={2.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </TopoActionsContext.Provider>

          <div className="absolute right-3 top-3 z-10 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-sm backdrop-blur">
            <div className="flex items-center gap-0.5 rounded-md bg-bg/60 p-0.5">
              {(['mindmap', 'compactBox'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={layout === mode}
                  onClick={() => setLayout(mode)}
                  className={cn(
                    'rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500',
                    layout === mode ? 'bg-card font-medium text-text shadow-sm' : 'text-text-muted hover:text-text',
                  )}
                >
                  {mode === 'mindmap' ? tr('思维导图', 'Mindmap') : tr('紧凑布局', 'Compact')}
                </button>
              ))}
            </div>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <label className="flex cursor-pointer items-center gap-1.5 px-1 text-[11px] text-text-muted">
              <Checkbox
                checked={showRelationStyle}
                onCheckedChange={(next) => setShowRelationStyle(next === true)}
                aria-label={tr('显示关系样式', 'Show relation styling')}
              />
              {tr('关系样式', 'Relation style')}
            </label>
          </div>

          {active && <DetailCard data={active} onClose={() => setActive(null)} />}
        </div>
      )}
    </div>
  );
}
