import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronRight,
  ExternalLink,
  Eye,
  ListFilter,
  ListTree,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';

import { Button, EmptyStateCard } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { Select } from '@/components/ui/Select';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  listAttributeGroups,
  listCITypes,
  listTypeAttributes,
  type AttributeGroup,
  type CIType,
  type TypeAttribute,
} from '../api/citype';
import { describeError } from '../api/http';
import { searchInstances, type Instance } from '../api/instance';
import {
  clearShowFields,
  getShowFields,
  listTreeLevels,
  setModelOrder,
  setTreeLevels,
  type TreeLevel,
} from '../api/preferences';
import { AttributeValue } from '../components/AttributeControl';
import { CMDBIcon } from '../components/CMDBIcon';
import { DataTable, type Column, type SortState } from '../components/DataTable';
import { DragHandle } from '../components/DragHandle';
import { InstanceDetailDrawer } from '../components/instance-detail/InstanceDetailDrawer';
import { InstanceFieldsDialog } from '../components/InstanceFieldsDialog';
import { MetaPill } from '../components/MetaPill';
import { SubscriptionEditor, type EditorTab } from '../components/preferences/SubscriptionEditor';
import { useToast } from '../components/Toast';
import { FacetTree, treeQuery } from '../components/tree-views/FacetTree';
import { WorkspaceBar } from '../components/WorkspaceBar';
import { choiceText } from '../lib/choice-labels';
import { searchRowToInstance } from '../lib/instance-search';
import {
  referenceRawText,
  referenceText,
  useReferenceLabels,
} from '../lib/reference-labels';
import { displayValue, isValueTypeCode } from '../lib/valuetype';

// 资源层级 — the tree a person configured in 我的订阅, beside the resources it
// selects.
//
// THE TREE IS A SET OF QUERIES. Each level is one facet aggregation under the
// current path, so a model with ten thousand hosts never builds a ten-thousand
// node tree before the first click. Picking a node narrows the table by the
// same expression the facet used; there is no client-side filtering of a full
// result set.
//
// THE LEFT RAIL IS THE OPERATOR'S OWN LIST. It holds only the hierarchy
// subscriptions (c_ptv), in the order saved for the tree (c_pcto), and the
// active view expands its facet tree in place — cantor's layout. Reordering is
// a drag on the grip, with the keyboard sensor available; managing a view opens
// the same subscription editor used by 我的订阅.
//
// THE RIGHT SIDE IS A REAL RESOURCE LIST. It uses the columns from the data
// subscription (c_psa), resolves references in one batch per model, allows a
// server-side search on top of the tree path, and opens the same read-only
// detail drawer as 资源数据. Writes stay on the resource page, so this page
// never grows a second create/edit form.

const PAGE_SIZE = 25;

const REVEAL_ON_ROW =
  'opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(pointer:coarse)]:opacity-100';

function searchableQuery(base: string, needle: string): string {
  // A needle is data, not query syntax. Commas separate terms and a trailing
  // backslash escapes one, so both are escaped before the wildcards are added.
  const text = needle
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,');
  return text ? `${base},*${text}*` : base;
}

function viewID(view: TreeLevel): string {
  return `t:${view.type_id}`;
}

export default function TreeViewsPage() {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const navigate = useNavigate();
  const { typeId } = useParams<{ typeId?: string }>();

  const [views, setViews] = useState<TreeLevel[]>([]);
  const [models, setModels] = useState<CIType[]>([]);
  const [activeID, setActiveID] = useState<number | null>(() => {
    const value = Number(typeId);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [path, setPath] = useState<string[]>([]);
  // The labels that belong to the raw path values. Reference levels store ids,
  // so the breadcrumb must use the same resolved words as the facet tree.
  const [pathLabels, setPathLabels] = useState<string[]>([]);
  const [rows, setRows] = useState<Instance[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewsErr, setViewsErr] = useState<string | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [tableErr, setTableErr] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [groups, setGroups] = useState<AttributeGroup[]>([]);
  const [columns, setColumns] = useState<TypeAttribute[]>([]);
  const [metaLoading, setMetaLoading] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [editing, setEditing] = useState<CIType | null>(null);
  const [dragID, setDragID] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setViewsErr(null);
      try {
        const [gotViews, gotModels] = await Promise.all([listTreeLevels(), listCITypes()]);
        setViews(gotViews);
        setModels(gotModels);
        setActiveID((current) => {
          if (current != null && gotViews.some((view) => view.type_id === current)) return current;
          return gotViews[0]?.type_id ?? null;
        });
      } catch (error) {
        setViewsErr(describeError(error, tr('无法读取层级视图', 'Could not load the tree views')));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [tr],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The route names the active view. A stale id falls back to the first saved
  // view, and the address bar is corrected without adding a history entry.
  useEffect(() => {
    if (loading || views.length === 0) return;
    const preferred = typeId ? Number(typeId) : null;
    if (preferred != null && views.some((view) => view.type_id === preferred)) {
      if (activeID !== preferred) setActiveID(preferred);
      return;
    }
    const next =
      activeID != null && views.some((view) => view.type_id === activeID)
        ? activeID
        : views[0].type_id;
    if (activeID !== next) setActiveID(next);
    // The address bar also has to be corrected when a subscription disappears
    // while its id is still in the URL.
    if (typeId !== String(next)) navigate(`/cmdb/tree-views/${next}`, { replace: true });
  }, [typeId, views, loading, activeID, navigate]);

  const active = useMemo(
    () => views.find((view) => view.type_id === activeID) ?? null,
    [views, activeID],
  );
  const model = useMemo(
    () => models.find((item) => item.id === active?.type_id) ?? null,
    [models, active],
  );

  useEffect(() => {
    setPath([]);
    setPathLabels([]);
    setPage(0);
    setSearch('');
    setSearchDraft('');
    setSort(null);
    setRows([]);
    setTotal(0);
    setTableErr(null);
    setViewing(null);
    setFiltersOpen(false);
  }, [activeID]);

  // The active view's metadata: its attributes, the form groups the drawer
  // needs, and the columns the operator subscribed to. A subscription names
  // attributes; a view with no column subscription falls back to its levels.
  useEffect(() => {
    if (!active) {
      setAttributes([]);
      setGroups([]);
      setColumns([]);
      return;
    }
    let live = true;
    setMetaLoading(true);
    setAttributes([]);
    setGroups([]);
    setColumns([]);
    void Promise.all([
      listTypeAttributes(active.name),
      listAttributeGroups(active.name, false).catch(() => [] as AttributeGroup[]),
      getShowFields(active.name).catch(() => null),
    ])
      .then(([attrs, gotGroups, show]) => {
        if (!live) return;
        const list = attrs.attributes ?? [];
        setAttributes(list);
        setGroups(gotGroups);
        const byID = new Map(list.map((attribute) => [attribute.id, attribute]));
        const subscribed = (show?.fields ?? [])
          .map((field) => (field.attr_id ? byID.get(field.attr_id) : undefined))
          .filter((attribute): attribute is TypeAttribute => Boolean(attribute));
        setColumns(
          subscribed.length > 0
            ? subscribed
            : active.levels.map((level) => byID.get(level.id) ?? level),
        );
      })
      .catch((error) => {
        if (!live) return;
        setAttributes([]);
        setGroups([]);
        setColumns(active.levels);
        toast.error(describeError(error, tr('无法读取模型属性', 'Could not load the model attributes')));
      })
      .finally(() => live && setMetaLoading(false));
    return () => {
      live = false;
    };
  }, [active, toast, tr]);

  const query = useMemo(() => {
    if (!active) return '';
    return searchableQuery(treeQuery(active.type_id, active.levels, path), search);
  }, [active, path, search]);

  useEffect(() => {
    if (!active) {
      setRows([]);
      setTotal(0);
      return;
    }
    let live = true;
    setTableLoading(true);
    setTableErr(null);
    void searchInstances({
      q: query,
      count: PAGE_SIZE,
      page: page + 1,
      sort: sort ? `${sort.desc ? '-' : ''}${sort.key}` : '',
    })
      .then((got) => {
        if (!live) return;
        setRows((got.result ?? []).map(searchRowToInstance));
        setTotal(got.numfound ?? 0);
      })
      .catch((error) => {
        if (live) setTableErr(describeError(error, tr('无法读取实例', 'Could not load the instances')));
      })
      .finally(() => live && setTableLoading(false));
    return () => {
      live = false;
    };
  }, [active, query, page, sort, retryKey, tr]);

  const chooseView = (id: number) => {
    if (id === activeID) return;
    setActiveID(id);
    navigate(`/cmdb/tree-views/${id}`, { replace: true });
  };

  const selectPath = (next: string[], labels: string[]) => {
    // Clicking the current breadcrumb must not clear the rows without a query
    // change to fetch them again.
    if (next.length === path.length && next.every((value, index) => value === path[index])) return;
    setPath(next);
    setPathLabels(labels.slice(0, next.length));
    setPage(0);
    setRows([]);
  };

  const applySearch = () => {
    const next = searchDraft.trim();
    if (next === search) return;
    setSearch(next);
    setPage(0);
  };

  const clearSearch = () => {
    setSearchDraft('');
    if (!search) return;
    setSearch('');
    setPage(0);
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      // A fresh view array is a new `active` object, which reloads the
      // metadata and the table; a second retry key would fetch it twice.
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  const unsubscribeView = async (view: TreeLevel) => {
    const name = view.alias || view.name;
    const ok = await confirmAction(
      tr(`取消「${name}」的层级订阅？`, `Cancel the hierarchy subscription for “${name}”?`),
    );
    if (!ok) return;
    try {
      await setTreeLevels(view.type_id, []);
      toast.success(tr('已取消层级订阅', 'Hierarchy subscription canceled'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('取消订阅失败', 'Could not cancel the subscription')));
    }
  };

  const unsubscribeFromEditor = async (target: CIType, kind: EditorTab) => {
    const what = kind === 'tree' ? tr('层级订阅', 'hierarchy subscription') : tr('数据订阅', 'column subscription');
    const ok = await confirmAction(
      tr(`取消「${target.alias || target.name}」的${what}？`, `Cancel the ${what} for “${target.alias || target.name}”?`),
    );
    if (!ok) return;
    try {
      if (kind === 'tree') await setTreeLevels(target.id, []);
      else await clearShowFields(target.id);
      toast.success(tr('已取消订阅', 'Subscription canceled'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('取消订阅失败', 'Could not cancel the subscription')));
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    setDragID(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragID(null);
    const { active: dragged, over } = event;
    if (!over || dragged.id === over.id) return;
    const oldIndex = views.findIndex((view) => viewID(view) === dragged.id);
    const newIndex = views.findIndex((view) => viewID(view) === over.id);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const next = arrayMove(views, oldIndex, newIndex);
    setViews(next);
    void setModelOrder(
      next.map((view) => view.type_id),
      true,
    ).catch(async (error) => {
      toast.error(describeError(error, tr('保存顺序失败', 'Could not save the order')));
      await load(true);
    });
  };

  const pageIDs = useMemo(() => views.map(viewID), [views]);
  const draggedView = useMemo(
    () => views.find((view) => viewID(view) === dragID) ?? null,
    [views, dragID],
  );
  const referenceLabels = useReferenceLabels(rows, columns, models);

  const tableColumns = useMemo<Column<Instance>[]>(() => {
    // Below the rail's breakpoint a forty-column table would show only its
    // first field — often an opaque id. Keep the identifying column and let the
    // detail drawer carry the rest; the full table returns on wide screens.
    const identity =
      columns.find((attribute) => attribute.name === model?.show_name) ??
      columns.find((attribute) => attribute.name === model?.unique_key) ??
      columns.find((attribute) => attribute.name === 'name') ??
      columns[0];
    return columns.map((attribute) => ({
      key: attribute.name,
      header: attribute.alias || attribute.name,
      sortable: true,
      hideBelow: identity && attribute.name !== identity.name ? 1024 : undefined,
      cell: (row) => {
        const value = row.values?.[attribute.name];
        const label = attribute.is_reference
          ? referenceText(value, referenceLabels)
          : choiceText(attribute, value);
        const raw = attribute.is_reference ? referenceRawText(value) : displayValue(value);
        return (
          <span
            className="block min-w-0 truncate"
            title={label && label !== raw ? `${label} (${raw})` : raw}
          >
            <AttributeValue
              type={isValueTypeCode(attribute.value_type) ? attribute.value_type : '2'}
              value={value}
              label={label}
            />
          </span>
        );
      },
    }));
  }, [columns, model, referenceLabels]);

  const levelLabel = (index: number) => active?.levels[index]?.alias || active?.levels[index]?.name || String(index + 1);
  const emptyTable = search
    ? tr(`没有匹配「${search}」的实例`, `No instances match “${search}”`)
    : path.length > 0
      ? tr('这个层级下没有实例', 'No instances at this level')
      : tr('这个模型还没有实例', 'This model has no instances yet');

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <WorkspaceBar
        leading={
          <>
            <span className="hidden lg:inline">{tr('资源模型', 'Resource models')}</span>
            <ChevronRight size={10} className="hidden lg:block" aria-hidden="true" />
            <h1 className="min-w-0 truncate text-xs font-medium text-text">{tr('资源层级', 'Resource hierarchy')}</h1>
            {active && (
              <>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                <span className="flex min-w-0 items-center gap-1.5">
                  <CMDBIcon value={active.icon} size={14} label={active.alias || active.name} />
                  <span className="truncate text-text">{active.alias || active.name}</span>
                  <code className="font-mono text-[10px] text-text-faint">{active.name}</code>
                </span>
              </>
            )}
          </>
        }
        actions={
          <>
            {active && (
              <>
                <MetaPill label={tr('层级', 'Levels')} value={active.levels.length} />
                <MetaPill
                  label={search || path.length > 0 ? tr('匹配实例', 'Matches') : tr('实例总数', 'Total')}
                  value={total}
                />
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void refreshAll()}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
              {tr('刷新', 'Refresh')}
            </Button>
            {model && (
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => navigate(`/cmdb/instances?type=${encodeURIComponent(model.name)}`)}
                className="inline-flex items-center gap-1.5"
              >
                <ExternalLink size={12} aria-hidden="true" />
                {tr('资源数据', 'Resources')}
              </Button>
            )}
          </>
        }
      />

      {viewsErr && (
        <div
          role="alert"
          className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300"
        >
          <span className="min-w-0 flex-1 break-words">{viewsErr}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => void load()}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}

      {loading && views.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-text-muted">
          {tr('加载中…', 'Loading…')}
        </div>
      ) : views.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6">
          <EmptyStateCard
            className="w-full max-w-xl"
            icon={ListTree}
            title={tr('还没有可用的层级视图', 'No tree view is available yet')}
            hint={tr(
              '先在我的订阅里为模型选择层级属性。',
              'Choose hierarchy attributes for a model in My subscriptions first.',
            )}
            action={
              <Link
                to="/cmdb/preferences"
                className="text-xs font-medium text-indigo-400 underline"
              >
                {tr('去我的订阅', 'Go to My subscriptions')}
              </Link>
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="hidden w-72 shrink-0 flex-col border-e border-border/50 bg-card/30 lg:flex">
            <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2.5">
              <h2 className="text-[11px] font-medium text-text-muted">{tr('层级视图', 'Tree views')}</h2>
              <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] leading-none text-text-faint">
                {views.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragCancel={() => setDragID(null)}
              >
                <SortableContext items={pageIDs} strategy={verticalListSortingStrategy}>
                  {views.map((view) => (
                    <SortableView
                      key={view.type_id}
                      view={view}
                      model={models.find((item) => item.id === view.type_id) ?? null}
                      models={models}
                      active={view.type_id === activeID}
                      path={path}
                      onSelect={() => chooseView(view.type_id)}
                      onPathSelect={selectPath}
                      onEdit={() => {
                        const target = models.find((item) => item.id === view.type_id);
                        if (target) setEditing(target);
                      }}
                      onCancel={() => void unsubscribeView(view)}
                    />
                  ))}
                </SortableContext>
                <DragOverlay>
                  {draggedView ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-text shadow-xl">
                      <CMDBIcon value={draggedView.icon} size={16} label={draggedView.alias || draggedView.name} />
                      <span className="truncate">{draggedView.alias || draggedView.name}</span>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </div>
            <div className="border-t border-border/50 p-3">
              <Link
                to="/cmdb/preferences"
                className="inline-flex items-center gap-1.5 text-[11px] text-text-muted underline-offset-2 hover:text-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                <Settings2 size={12} aria-hidden="true" />
                {tr('管理订阅', 'Manage subscriptions')}
              </Link>
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="cmdb-workspace-band shrink-0 border-b border-border/50 px-4 py-2.5">
              <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="w-full sm:w-52 lg:hidden">
                    <Select
                      label={tr('层级视图', 'Tree view')}
                      value={activeID != null ? String(activeID) : ''}
                      onValueChange={(value) => chooseView(Number(value))}
                      options={views.map((view) => ({
                        value: String(view.type_id),
                        label: view.alias || view.name,
                      }))}
                      searchable
                      className="w-full"
                    />
                  </div>
                  {active && (
                    <div
                      className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-text-muted"
                      aria-label={tr('层级路径', 'Hierarchy path')}
                    >
                      <button
                        type="button"
                        onClick={() => selectPath([], [])}
                        aria-pressed={path.length === 0}
                        className={cn(
                          'rounded px-1.5 py-0.5 transition-colors',
                          path.length === 0
                            ? 'bg-indigo-500/15 font-medium text-text'
                            : 'hover:bg-card hover:text-text',
                        )}
                      >
                        {tr('全部', 'All')}
                      </button>
                      {path.map((value, index) => {
                        const segmentLabel = pathLabels[index] ?? value;
                        return (
                          <Fragment key={`${active.type_id}-${index}-${value}`}>
                            <ChevronRight size={10} className="shrink-0 text-text-faint" aria-hidden="true" />
                            <button
                              type="button"
                              onClick={() =>
                                selectPath(path.slice(0, index + 1), pathLabels.slice(0, index + 1))
                              }
                              aria-pressed={index === path.length - 1}
                              title={
                                segmentLabel !== value
                                  ? `${levelLabel(index)}: ${segmentLabel} (${value})`
                                  : `${levelLabel(index)}: ${value}`
                              }
                              className={cn(
                                'max-w-48 truncate rounded px-1.5 py-0.5 transition-colors',
                                index === path.length - 1
                                  ? 'bg-indigo-500/15 font-medium text-text'
                                  : 'hover:bg-card hover:text-text',
                              )}
                            >
                              <span className="text-text-faint">{levelLabel(index)}:</span> {segmentLabel}
                            </button>
                          </Fragment>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-full sm:w-64">
                    <Search
                      size={13}
                      className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                      aria-hidden="true"
                    />
                    <Input
                      type="search"
                      aria-label={tr('在当前层级下搜索', 'Search within this level')}
                      placeholder={tr('在当前层级下搜索…', 'Search within this level…')}
                      value={searchDraft}
                      onChange={(event) => setSearchDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          applySearch();
                        }
                      }}
                      className="w-full pe-7 ps-8"
                    />
                    {(searchDraft || search) && (
                      <button
                        type="button"
                        onClick={clearSearch}
                        aria-label={tr('清除搜索', 'Clear search')}
                        title={tr('清除搜索', 'Clear search')}
                        className="absolute end-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {active && (
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      aria-expanded={filtersOpen}
                      onClick={() => setFiltersOpen((open) => !open)}
                      className="inline-flex items-center gap-1.5 lg:hidden"
                    >
                      <ListFilter size={12} aria-hidden="true" />
                      {tr('层级筛选', 'Levels')}
                    </Button>
                  )}
                  {model && attributes.length > 0 && (
                    <InstanceFieldsDialog
                      model={model}
                      attributes={attributes}
                      columns={columns}
                      onSaved={(next) => {
                        setColumns(next);
                        setSort(null);
                        setPage(0);
                      }}
                    />
                  )}
                </div>
              </div>

              {filtersOpen && active && (
                <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-card/60 p-2 lg:hidden">
                  <FacetTree
                    typeID={active.type_id}
                    levels={active.levels}
                    selected={path}
                    onSelect={selectPath}
                    models={models}
                  />
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-1 flex-col p-3">
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/60">
                <div className="flex min-h-0 flex-1 flex-col p-3">
                  <DataTable
                    fill
                    columns={tableColumns}
                    rows={rows}
                    rowKey={(row) => row.ci_id}
                    loading={tableLoading || (metaLoading && columns.length === 0)}
                    error={tableErr}
                    onRetry={() => setRetryKey((key) => key + 1)}
                    empty={emptyTable}
                    sort={sort}
                    onSortChange={(next) => {
                      setSort(next);
                      setPage(0);
                    }}
                    storageKey={`tree-view-${active?.type_id ?? 'none'}`}
                    onRowClick={model ? (row) => setViewing(row.ci_id) : undefined}
                    actionsHideBelow={1536}
                    actions={
                      model
                        ? (row) => (
                            <Button
                              variant="plain"
                              size="sm"
                              type="button"
                              onClick={() => setViewing(row.ci_id)}
                              aria-label={tr(`查看实例 ${row.ci_id}`, `View instance ${row.ci_id}`)}
                              title={tr(`查看实例 ${row.ci_id}`, `View instance ${row.ci_id}`)}
                              className="cmdb-liquid-action-view inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
                            >
                              <Eye size={13} aria-hidden="true" />
                            </Button>
                          )
                        : undefined
                    }
                  />
                </div>
                <PaginationFooter
                  embedded
                  page={page}
                  pageSize={PAGE_SIZE}
                  shown={rows.length}
                  total={total}
                  loading={tableLoading}
                  showPageNumbers
                  summary={tr(
                    `显示 ${rows.length === 0 ? 0 : page * PAGE_SIZE + 1} 至 ${
                      rows.length === 0 ? 0 : page * PAGE_SIZE + rows.length
                    } 条，共 ${total} 条实例`,
                    `Showing ${rows.length === 0 ? 0 : page * PAGE_SIZE + 1}–${
                      rows.length === 0 ? 0 : page * PAGE_SIZE + rows.length
                    } of ${total} instances`,
                  )}
                  onPageChange={setPage}
                />
              </section>
            </div>
          </div>
        </div>
      )}

      {viewing != null && model && (
        <InstanceDetailDrawer
          model={model}
          models={models}
          attributes={attributes}
          groups={groups}
          instanceID={viewing}
          onClose={() => setViewing(null)}
          onInstanceSaved={() => setRetryKey((key) => key + 1)}
        />
      )}

      {editing && (
        <SubscriptionEditor
          model={editing}
          initialTab="tree"
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            toast.success(message);
            // The levels may have changed; a path from the old shape is no
            // longer a valid query.
            setPath([]);
            setPathLabels([]);
            setPage(0);
            setSearch('');
            setSearchDraft('');
            setSort(null);
            setRows([]);
            await load(true);
          }}
          onUnsubscribe={(kind) => {
            const target = editing;
            setEditing(null);
            void unsubscribeFromEditor(target, kind);
          }}
        />
      )}

      {dialog}
    </div>
  );
}

function SortableView({
  view,
  model,
  models,
  active,
  path,
  onSelect,
  onPathSelect,
  onEdit,
  onCancel,
}: {
  view: TreeLevel;
  model: CIType | null;
  models: CIType[];
  active: boolean;
  path: string[];
  onSelect(): void;
  onPathSelect(next: string[], labels: string[]): void;
  onEdit(): void;
  onCancel(): void;
}) {
  const { tr } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: viewID(view),
  });
  const label = view.alias || view.name;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      className="rounded-lg"
    >
      <div
        className={cn(
          'group/row flex h-9 items-center gap-1 rounded-md px-1.5 transition-colors',
          active ? 'bg-indigo-500/10' : 'hover:bg-card',
        )}
      >
        <DragHandle
          handle={{ attributes, listeners, isDragging, draggable: true }}
          label={tr(`拖动层级 ${label}`, `Drag hierarchy ${label}`)}
          className={REVEAL_ON_ROW}
        />
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={active}
          aria-expanded={active}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 text-start focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
        >
          <CMDBIcon value={view.icon} size={16} label={label} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{label}</span>
          <span className="shrink-0 text-[10px] text-text-faint">
            {tr(`${view.levels.length} 层`, `${view.levels.length} levels`)}
          </span>
        </button>
        <div className={cn('flex shrink-0 items-center gap-0.5', REVEAL_ON_ROW)}>
          <Button
            variant="subtle"
            size="sm"
            type="button"
            onClick={onEdit}
            disabled={!model}
            aria-label={tr(`编辑 ${label} 的层级`, `Edit levels for ${label}`)}
            title={tr('编辑层级', 'Edit hierarchy')}
          >
            <Settings2 size={12} aria-hidden="true" />
          </Button>
          <Button
            variant="dangerGhost"
            size="sm"
            type="button"
            onClick={onCancel}
            aria-label={tr(`取消 ${label} 的层级订阅`, `Cancel the hierarchy subscription for ${label}`)}
            title={tr('取消层级订阅', 'Cancel hierarchy subscription')}
          >
            <Trash2 size={12} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {active && (
        <div className="ms-3 border-s border-border/50 pb-1 ps-1">
          <FacetTree
            typeID={view.type_id}
            levels={view.levels}
            selected={path}
            onSelect={onPathSelect}
            models={models}
          />
        </div>
      )}
    </div>
  );
}
