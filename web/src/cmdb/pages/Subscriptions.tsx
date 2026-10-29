import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Database,
  GripVertical,
  LayoutGrid,
  List,
  Network,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/store/me';

import { listCITypes, listTypeAttributes, type CIType } from '../api/citype';
import { describeError } from '../api/http';
import {
  clearShowFields,
  deleteModelGroup,
  getAutoSubscription,
  listModelGroups,
  listSubscribedModels,
  listTreeLevels,
  setModelGroupMembers,
  setModelOrder,
  setShowFields,
  setTreeLevels,
  type AutoSubscription,
  type ModelGroup,
  type TreeLevel,
} from '../api/preferences';
import { CMDBIcon } from '../components/CMDBIcon';
import { GroupedSortable, type DragSource, type SortableHandle } from '../components/GroupedSortable';
import { AutoSubscriptionModal } from '../components/preferences/AutoSubscriptionModal';
import { SubscriptionEditor, type EditorTab } from '../components/preferences/SubscriptionEditor';
import { useToast } from '../components/Toast';
import { flattenSlotIDs, groupIDFromSlotKey, groupSlotKey, mergeGroupMembership } from '../lib/group-drag';

// 我的订阅 — what one operator sees.
//
// THREE THINGS LIVE HERE, and they answer different questions:
//
//   - WHICH COLUMNS a model's list shows (the subscription, c_psa). Per user,
//     and never admin-gated: "which columns do I want" is not a deployment
//     decision.
//   - WHICH ATTRIBUTES the resource hierarchy expands (c_ptv), in order.
//   - THE ORDER of the models in the sidebar (c_pcto), one order for the list
//     and one for the tree.
//
// THE LEFT PANE IS THE OPERATOR'S OWN SET; the right pane is the catalogue it
// was chosen from. cantor used drag-and-drop for both lists; this console keeps
// the up/down buttons the rest of the CMDB uses, so a drag dependency buys one
// page at the cost of the whole module's bundle.
//
// SUBSCRIBING IS PER MODEL, NOT PER GROUP. A model covered by the automatic
// rule cannot be unsubscribed by hand — the rule would add it back — so the
// destructive controls are hidden while the rule is on, exactly as cantor did.

// IPAM models have their own address-space pages, where the columns are fixed
// by the range view. cantor kept them out of the subscription catalogue and so
// does this page: offering "choose columns" for a model whose columns are the
// address grid would be a control that does nothing.
const IPAM_MODELS = new Set(['ipam_scope', 'ipam_subnet', 'ipam_address']);

// Cantor kept the drag and edit affordances out of the reading path: they
// appear when the pointer is over the row (or the row has keyboard focus) and
// stay visible on touch, where hover does not exist.
const REVEAL_ON_ROW =
  'opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(pointer:coarse)]:opacity-100';
const REVEAL_ON_SECTION =
  'opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100 [@media(pointer:coarse)]:opacity-100';

/** One group of subscribed models in the left pane. */
type SubscriptionSection = {
  key: string;
  name: string;
  groupID: number | null;
  isOther: boolean;
  items: CIType[];
};

/**
 * Turns the server's grouped subscription into display sections in the
 * operator's own order.
 *
 * THE GROUP ORDER IS DERIVED FROM THE MODEL ORDER. `type_ids` is the per-user
 * arrangement; a group's position is the earliest position any of its models
 * holds. That is what makes dragging a whole group persistent through the same
 * order write as dragging a single model, and it matches cantor, whose group
 * list was rebuilt from the ordered types on every read.
 */
export function buildSubscriptionSections(groups: ModelGroup[], orderedIDs: number[]): SubscriptionSection[] {
  const rank = new Map<number, number>();
  orderedIDs.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const seen = new Set<number>();
  const sections: SubscriptionSection[] = [];
  for (const group of groups) {
    const items: CIType[] = [];
    for (const model of group.ci_types ?? []) {
      if (IPAM_MODELS.has(model.name) || seen.has(model.id)) continue;
      seen.add(model.id);
      items.push(model);
    }
    if (items.length === 0) continue;
    items.sort(
      (left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
    sections.push({
      key: groupSlotKey(group),
      name: group.name ?? '',
      groupID: group.id ?? null,
      isOther: group.is_other === true || group.id == null,
      items,
    });
  }
  const rankOf = (section: SubscriptionSection) =>
    section.items.reduce((lowest, model) => Math.min(lowest, rank.get(model.id) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  // 其他 is the trailing bucket everywhere else (the resource-data rail and
  // cantor), so an ungrouped model cannot pull it into the middle of the named
  // groups by happening to sort first.
  return sections.sort((left, right) => {
    if (left.isOther !== right.isOther) return left.isOther ? 1 : -1;
    return rankOf(left) - rankOf(right);
  });
}

/**
 * What one completed subscription drag has to persist.
 *
 * A group drag and an in-group drag are one per-user order write. A model that
 * lands in another group needs a second, SHARED write: its new group's ordered
 * membership, or — for the ungrouped bucket — detachment from the group it
 * left. Keeping the decision here lets it be tested without a browser.
 */
export type SubscriptionDragPlan = {
  order: number[];
  detachFrom?: number;
  setMembers?: { groupID: number; typeIDs: number[] };
};

export function subscriptionDragPlan(source: DragSource, next: SubscriptionSection[]): SubscriptionDragPlan {
  const order = flattenSlotIDs(next, (model) => model.id);
  if (source.type !== 'item') return { order };
  const target = next.find((section) => section.items.some((model) => model.id === source.itemID));
  if (!target || target.key === source.groupKey) return { order };
  if (target.isOther) {
    const sourceGroupID = groupIDFromSlotKey(source.groupKey);
    return sourceGroupID != null ? { order, detachFrom: sourceGroupID } : { order };
  }
  if (target.groupID == null) return { order };
  return { order, setMembers: { groupID: target.groupID, typeIDs: target.items.map((model) => model.id) } };
}

export default function SubscriptionsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const { isAdmin } = usePermissions();

  const [sections, setSections] = useState<SubscriptionSection[]>([]);
  const [subscribedAt, setSubscribedAt] = useState<Record<string, string>>({});
  const [models, setModels] = useState<CIType[]>([]);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [treeViews, setTreeViews] = useState<TreeLevel[]>([]);
  const [autoSub, setAutoSub] = useState<AutoSubscription | null>(null);
  const [query, setQuery] = useState('');
  const [catalogView, setCatalogView] = useState<'list' | 'grid'>('list');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ model: CIType; tab: EditorTab } | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      try {
        const [subscribed, allModels, allGroups, trees, auto] = await Promise.all([
          listSubscribedModels(),
          listCITypes(),
          listModelGroups().catch(() => [] as ModelGroup[]),
          listTreeLevels(),
          getAutoSubscription().catch(() => null),
        ]);
        setSections(buildSubscriptionSections(subscribed.groups ?? [], subscribed.type_ids ?? []));
        setSubscribedAt(subscribed.subscribed_at ?? {});
        setModels(allModels);
        setModelGroups(allGroups);
        setTreeViews(trees);
        setAutoSub(normalizeAuto(auto));
      } catch (error) {
        setErr(describeError(error, tr('无法读取订阅', 'Could not load the subscriptions')));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [tr],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const autoEnabled = autoSub?.enabled === true;

  const visibleModels = useMemo(() => models.filter((model) => !IPAM_MODELS.has(model.name)), [models]);
  const hiddenTypeIDs = useMemo(
    () => new Set(models.filter((model) => IPAM_MODELS.has(model.name)).map((model) => model.id)),
    [models],
  );
  const visibleTreeViews = useMemo(
    () => treeViews.filter((view) => !hiddenTypeIDs.has(view.type_id)),
    [treeViews, hiddenTypeIDs],
  );

  // The subscriptions in their grouped display order. This is both the left
  // pane's data and the source of the summary count and unsubscribe lookup.
  const tableModels = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const tableIDs = useMemo(() => new Set(tableModels.map((model) => model.id)), [tableModels]);
  const treeByType = useMemo(
    () => new Map(visibleTreeViews.map((view) => [view.type_id, view])),
    [visibleTreeViews],
  );

  // The catalogue joins the shared groupings to the latest model snapshot: a
  // group carries ids, and a model created after the group was read still
  // appears under 其他 rather than vanishing from the page.
  const catalog = useMemo(() => {
    const byID = new Map(visibleModels.map((model) => [model.id, model]));
    const assigned = new Set<number>();
    const out: ModelGroup[] = [];
    for (const group of modelGroups) {
      const types: CIType[] = [];
      for (const model of group.ci_types ?? []) {
        const live = byID.get(model.id);
        if (!live || IPAM_MODELS.has(live.name)) continue;
        assigned.add(live.id);
        types.push(live);
      }
      out.push({ ...group, ci_types: types });
    }
    const other = visibleModels.filter((model) => !assigned.has(model.id));
    if (other.length > 0) {
      out.push({ id: undefined, name: '', ci_types: other, is_other: true });
    }
    return out;
  }, [modelGroups, visibleModels]);

  const filteredCatalog = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return catalog;
    return catalog
      .map((group) => ({
        ...group,
        ci_types: group.ci_types.filter(
          (model) => model.name.toLowerCase().includes(term) || (model.alias ?? '').toLowerCase().includes(term),
        ),
      }))
      .filter((group) => group.ci_types.length > 0);
  }, [catalog, query]);

  const ageLabel = useCallback(
    (value: string | undefined) => {
      if (!value) return null;
      const then = new Date(value);
      if (Number.isNaN(then.getTime())) return null;
      const diff = Date.now() - then.getTime();
      if (diff < 60 * 60 * 1000) return tr('刚刚', 'Just now');
      const hours = Math.floor(diff / (60 * 60 * 1000));
      if (hours < 24) return tr(`${hours} 小时前`, `${hours}h ago`);
      const days = Math.floor(hours / 24);
      if (days <= 31) return tr(`${days} 天前`, `${days}d ago`);
      const months = Math.floor(days / 30);
      if (days < 365) return tr(`${months} 个月前`, `${months}mo ago`);
      return tr(`${Math.floor(days / 365)} 年前`, `${Math.floor(days / 365)}y ago`);
    },
    [tr],
  );

  // A drop writes up to two things: the operator's own order, and — only when
  // a model crossed a group boundary — the shared membership. Group drags and
  // in-group drags are therefore a per-user write and need no administrator;
  // the cross-group half is gated by `allowCrossGroup` on the sortable list.
  const commitTableDrag = async (source: DragSource, next: SubscriptionSection[]) => {
    setSections(next);
    const plan = subscriptionDragPlan(source, next);
    try {
      const writes: Promise<unknown>[] = [];
      if (plan.setMembers) {
        // The pane only knows subscribed models, and its group snapshot may be
        // older than another surface's write. Read the group now and merge, so
        // a member the pane does not show (or joined elsewhere a moment ago)
        // is not dropped by this per-user view. Start it before the order
        // write so a failed read does not leave the order half-applied.
        const fresh = await listModelGroups();
        const full = fresh.find((group) => group.id === plan.setMembers?.groupID)?.ci_types.map((model) => model.id) ?? [];
        writes.push(
          setModelGroupMembers(
            plan.setMembers.groupID,
            mergeGroupMembership(plan.setMembers.typeIDs, full),
          ),
        );
      }
      if (plan.detachFrom != null && source.type === 'item') {
        writes.push(deleteModelGroup(plan.detachFrom, [source.itemID]));
      }
      writes.push(setModelOrder(plan.order, false));
      await Promise.all(writes);
    } catch (error) {
      toast.error(describeError(error, tr('保存排序失败', 'Could not save the arrangement')));
    }
    await load(true);
  };

  // The hierarchy is a flat list, so it is one drag slot rather than a group.
  // The same grip and keyboard controls as the column list replace the old
  // up/down buttons.
  const treeSlots = useMemo(
    () => [{ key: 'tree', items: visibleTreeViews }],
    [visibleTreeViews],
  );

  const commitTreeDrag = async (items: TreeLevel[]) => {
    setTreeViews(items);
    try {
      await setModelOrder(
        items.map((view) => view.type_id),
        true,
      );
    } catch (error) {
      toast.error(describeError(error, tr('保存顺序失败', 'Could not save the order')));
      await load(true);
    }
  };

  // The catalogue's trash removes every subscription the model has, the way
  // cantor's did. The left pane keeps one trash per section so a single half
  // can still be dropped without touching the other.
  const unsubscribeAll = async (model: CIType) => {
    const name = model.alias || model.name;
    const hasTable = tableIDs.has(model.id);
    const hasTree = treeByType.has(model.id);
    if (!hasTable && !hasTree) return;
    const what =
      hasTable && hasTree
        ? tr('数据订阅和层级订阅', 'column and hierarchy subscriptions')
        : hasTable
          ? tr('数据订阅', 'column subscription')
          : tr('层级订阅', 'hierarchy subscription');
    const ok = await confirmAction(tr(`取消「${name}」的${what}？`, `Cancel the ${what} for “${name}”?`));
    if (!ok) return;
    try {
      const work: Promise<unknown>[] = [];
      if (hasTable) work.push(clearShowFields(model.id));
      if (hasTree) work.push(setTreeLevels(model.id, []));
      await Promise.all(work);
      toast.success(tr('已取消订阅', 'Subscription canceled'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('取消订阅失败', 'Could not cancel the subscription')));
    }
  };

  const unsubscribe = async (model: CIType, kind: EditorTab) => {
    const name = model.alias || model.name;
    const what = kind === 'fields' ? tr('数据订阅', 'column subscription') : tr('层级订阅', 'hierarchy subscription');
    const ok = await confirmAction(
      tr(`取消「${name}」的${what}？`, `Cancel the ${what} for “${name}”?`),
    );
    if (!ok) return;
    try {
      if (kind === 'fields') await clearShowFields(model.id);
      else await setTreeLevels(model.id, []);
      toast.success(tr('已取消订阅', 'Subscription canceled'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('取消订阅失败', 'Could not cancel the subscription')));
    }
  };

  // cantor's one-click subscription: the model's default-show attributes, or
  // the identifying one when nothing is marked. The identifying column is
  // pinned so a list never loses the field that names its rows.
  const quickSubscribe = async (model: CIType) => {
    try {
      const got = await listTypeAttributes(model.id);
      const attributes = got.attributes ?? [];
      const defaults = attributes.filter((attribute) => attribute.default_show);
      const identifier =
        attributes.find((attribute) => attribute.id === got.unique_id || attribute.name === got.unique) ?? null;
      const picked = defaults.length > 0 ? defaults : identifier ? [identifier] : [];
      if (picked.length === 0) {
        toast.error(tr('这个模型还没有可订阅的属性', 'This model has no attributes to subscribe to'));
        return;
      }
      await setShowFields(
        model.id,
        picked.map((attribute) => ({ ref: String(attribute.id), is_fixed: attribute.id === identifier?.id })),
      );
      toast.success(tr('已订阅', 'Subscribed'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('订阅失败', 'Could not subscribe')));
    }
  };

  // One source of truth for the catalogue's subscription state and actions, so
  // the list and grid modes cannot drift into different affordances.
  const catalogStatus = (model: CIType) => {
    const tableSubscribed = tableIDs.has(model.id);
    const tree = treeByType.get(model.id);
    const tableAge = autoEnabled ? null : ageLabel(subscribedAt[String(model.id)]);
    const treeAge = ageLabel(tree?.created_at);
    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted">
        {tableSubscribed && (
          <span>
            {tr('数据订阅', 'Columns')}
            {tableAge ? ` · ${tableAge}` : ''}
          </span>
        )}
        {tree && (
          <span>
            {tr('层级订阅', 'Hierarchy')}
            {treeAge ? ` · ${treeAge}` : ''}
          </span>
        )}
        {!tableSubscribed && !tree && <span>{tr('未订阅', 'Not subscribed')}</span>}
        {autoEnabled && tableSubscribed && (
          <span className="text-text-faint">{tr('由自动订阅管理', 'Managed by auto subscription')}</span>
        )}
      </div>
    );
  };

  const catalogActionButtons = (model: CIType) => {
    const tableSubscribed = tableIDs.has(model.id);
    const tree = treeByType.get(model.id);
    return (
      <>
        {!tableSubscribed && !autoEnabled && (
          <Button
            variant="subtle"
            size="sm"
            type="button"
            onClick={() => void quickSubscribe(model)}
            aria-label={tr(`数据订阅 ${model.name}`, `Subscribe columns for ${model.name}`)}
            title={tr('数据订阅', 'Subscribe columns')}
          >
            <Database size={12} aria-hidden="true" />
          </Button>
        )}
        {!tree && (
          <Button
            variant="subtle"
            size="sm"
            type="button"
            onClick={() => setEditing({ model, tab: 'tree' })}
            aria-label={tr(`层级订阅 ${model.name}`, `Subscribe hierarchy for ${model.name}`)}
            title={tr('层级订阅', 'Subscribe hierarchy')}
          >
            <Network size={12} aria-hidden="true" />
          </Button>
        )}
        {(tableSubscribed || tree) && (
          <Button
            variant="subtle"
            size="sm"
            type="button"
            onClick={() => setEditing({ model, tab: tableSubscribed ? 'fields' : 'tree' })}
            aria-label={tr(`编辑 ${model.name} 的订阅`, `Edit the subscription for ${model.name}`)}
            title={tr('编辑订阅', 'Edit subscription')}
          >
            <Pencil size={12} aria-hidden="true" />
          </Button>
        )}
        {!autoEnabled && (tableSubscribed || tree) && (
          <Button
            variant="dangerGhost"
            size="sm"
            type="button"
            onClick={() => void unsubscribeAll(model)}
            aria-label={tr(`取消 ${model.name} 的全部订阅`, `Cancel every subscription for ${model.name}`)}
            title={tr('取消订阅', 'Cancel subscription')}
          >
            <Trash2 size={12} aria-hidden="true" />
          </Button>
        )}
        {autoEnabled && tree && (
          <Button
            variant="dangerGhost"
            size="sm"
            type="button"
            onClick={() => void unsubscribe(model, 'tree')}
            aria-label={tr(`取消 ${model.name} 的层级订阅`, `Cancel the hierarchy subscription for ${model.name}`)}
            title={tr('取消层级订阅', 'Cancel hierarchy subscription')}
          >
            <Trash2 size={12} aria-hidden="true" />
          </Button>
        )}
      </>
    );
  };

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => void load(true)}
        disabled={loading || refreshing}
        className="inline-flex items-center gap-1.5"
      >
        <RefreshCw size={12} className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
        {tr('刷新', 'Refresh')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => setAutoOpen(true)}
        className="inline-flex items-center gap-1.5"
      >
        {tr('自动订阅', 'Auto subscribe')}
        {autoEnabled ? <Chip tone="success">{tr('开', 'On')}</Chip> : <Chip>{tr('关', 'Off')}</Chip>}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      {!embedded && (
        <PageHeader
          title={tr('我的订阅', 'My subscriptions')}
          subtitle={tr(
            '选择每个模型的列表列和资源层级，并安排它们在侧栏中的顺序。',
            'Choose the columns and hierarchy each model shows, and arrange the order they appear in the sidebar.',
          )}
          actions={actions}
        />
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        {embedded && <div className="mb-4 flex flex-wrap items-center justify-end gap-2">{actions}</div>}
        {err && (
          <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {err}
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start">
          <aside className="flex min-w-0 flex-col gap-4">
            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-medium text-text">{tr('订阅概览', 'Subscription overview')}</h2>
                {autoEnabled && <Chip tone="info">{tr('自动订阅已启用', 'Auto subscription on')}</Chip>}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2">
                <SummaryStat
                  icon={<Database size={14} aria-hidden="true" />}
                  label={tr('资源数据', 'Resource data')}
                  value={tableModels.length}
                />
                <SummaryStat
                  icon={<Network size={14} aria-hidden="true" />}
                  label={tr('资源层级', 'Resource tree')}
                  value={visibleTreeViews.length}
                />
              </dl>
            </Card>

            <Card>
              <SectionHeader
                icon={<Database size={14} aria-hidden="true" />}
                title={tr('资源数据订阅', 'Column subscriptions')}
                count={tableModels.length}
              />
              {!isAdmin && tableModels.length > 0 && (
                <p className="mt-1 text-[11px] text-text-faint">
                  {tr(
                    '跨分组拖动需要管理员权限；分组顺序和组内顺序仍可调整。',
                    'Moving a model between groups needs an administrator; group and in-group order are still yours.',
                  )}
                </p>
              )}
              {loading ? (
                <p className="py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
              ) : tableModels.length === 0 ? (
                <EmptyState
                  icon={Database}
                  title={tr('还没有订阅任何模型', 'No model is subscribed yet')}
                  hint={tr('在右侧选择数据订阅，列表就会按你选择的列显示。', 'Subscribe on the right and the list will show the columns you choose.')}
                  className="flex flex-col items-center justify-center gap-2 py-6 text-center"
                />
              ) : (
                <GroupedSortable<CIType, SubscriptionSection>
                  groups={sections}
                  getID={(model) => model.id}
                  getItems={(section) => section.items}
                  withItems={(section, items) => ({ ...section, items })}
                  onGroupsChange={setSections}
                  allowCrossGroup={isAdmin}
                  onCommit={(source, next) => void commitTableDrag(source, next)}
                  renderGroup={(section, handle, children) => {
                    const name = section.isOther ? tr('其他', 'Other') : section.name || tr('未命名分组', 'Untitled group');
                    return (
                      <section className="mt-2">
                        <div className="group/section flex items-center gap-1 px-1 py-1 text-[11px] font-medium text-text-muted">
                          <DragHandle
                            handle={handle}
                            label={tr(`拖动分组 ${name}`, `Drag the ${name} group`)}
                            className={REVEAL_ON_SECTION}
                          />
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          <span className="shrink-0 text-text-faint">({section.items.length})</span>
                        </div>
                        {/* The guide line and inset make the group/row hierarchy
                            readable at a glance; the row's grip starts inside
                            the group, not at the group header's edge. */}
                        <div className="ms-5 border-s border-border/50 ps-1">{children}</div>
                      </section>
                    );
                  }}
                  renderItem={(model, _groupKey, handle) => (
                    <div className="group/row flex items-center gap-1 border-b border-border/60 py-1.5 text-xs last:border-0">
                      <DragHandle
                        handle={handle}
                        label={tr(`拖动模型 ${model.name}`, `Drag ${model.name}`)}
                        className={REVEAL_ON_ROW}
                      />
                      <CMDBIcon value={model.icon} size={16} label={model.alias || model.name} />
                      <span className="min-w-0 flex-1 truncate">{model.alias || model.name}</span>
                      <div className={cn('flex items-center gap-1', REVEAL_ON_ROW)}>
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() => setEditing({ model, tab: 'fields' })}
                          aria-label={tr(`编辑 ${model.name} 的列`, `Edit columns for ${model.name}`)}
                          title={tr('编辑列', 'Edit columns')}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </Button>
                        {!autoEnabled && (
                          <Button
                            variant="dangerGhost"
                            size="sm"
                            type="button"
                            onClick={() => void unsubscribe(model, 'fields')}
                            aria-label={tr(`取消 ${model.name} 的数据订阅`, `Cancel the column subscription for ${model.name}`)}
                            title={tr('取消数据订阅', 'Cancel column subscription')}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  renderOverlay={(source, item) => {
                    if (source.type === 'group') {
                      const section = sections.find((candidate) => candidate.key === source.groupKey);
                      return (
                        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-text shadow-xl">
                          <GripVertical size={12} className="text-text-faint" aria-hidden="true" />
                          <span className="truncate">
                            {section?.isOther ? tr('其他', 'Other') : section?.name || tr('未命名分组', 'Untitled group')}
                          </span>
                          <span className="text-text-faint">({section?.items.length ?? 0})</span>
                        </div>
                      );
                    }
                    if (!item) return null;
                    return (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-text shadow-xl">
                        <CMDBIcon value={item.icon} size={16} label={item.alias || item.name} />
                        <span className="truncate">{item.alias || item.name}</span>
                      </div>
                    );
                  }}
                />
              )}
            </Card>

            <Card>
              <SectionHeader
                icon={<Network size={14} aria-hidden="true" />}
                title={tr('资源层级订阅', 'Hierarchy subscriptions')}
                count={visibleTreeViews.length}
              />
              {loading ? (
                <p className="py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
              ) : visibleTreeViews.length === 0 ? (
                <EmptyState
                  icon={Network}
                  title={tr('还没有配置资源层级', 'No hierarchy is configured yet')}
                  hint={tr('在右侧选择层级订阅，资源层级页就会按你选的属性展开。', 'Subscribe on the right and the hierarchy page will expand by those attributes.')}
                  className="flex flex-col items-center justify-center gap-2 py-6 text-center"
                />
              ) : (
                <GroupedSortable<TreeLevel, { key: string; items: TreeLevel[] }>
                  groups={treeSlots}
                  getID={(view) => view.type_id}
                  getItems={(slot) => slot.items}
                  withItems={(slot, items) => ({ ...slot, items })}
                  onGroupsChange={(next) => setTreeViews(next[0]?.items ?? [])}
                  onCommit={(_source, next) => void commitTreeDrag(next[0]?.items ?? [])}
                  allowCrossGroup={false}
                  canDragGroup={() => false}
                  itemsClassName="divide-y divide-border"
                  renderGroup={(_slot, _handle, children) => <div className="mt-2">{children}</div>}
                  renderItem={(view, _groupKey, handle) => (
                    <div className="group/row flex items-center gap-1 py-1.5 text-xs">
                      <DragHandle
                        handle={handle}
                        label={tr(`拖动层级 ${view.name}`, `Drag ${view.name}`)}
                        className={REVEAL_ON_ROW}
                      />
                      <CMDBIcon value={view.icon} size={16} label={view.alias || view.name} />
                      <span className="min-w-0 flex-1 truncate">{view.alias || view.name}</span>
                      <span className="shrink-0 text-[11px] text-text-faint">
                        {tr(`${view.levels.length} 层`, `${view.levels.length} levels`)}
                      </span>
                      <div className={cn('flex items-center gap-1', REVEAL_ON_ROW)}>
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() => {
                            const model = models.find((item) => item.id === view.type_id);
                            if (model) setEditing({ model, tab: 'tree' });
                          }}
                          aria-label={tr(`编辑 ${view.name} 的层级`, `Edit levels for ${view.name}`)}
                          title={tr('编辑层级', 'Edit hierarchy')}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="dangerGhost"
                          size="sm"
                          type="button"
                          onClick={() => {
                            const model = models.find((item) => item.id === view.type_id);
                            if (model) void unsubscribe(model, 'tree');
                          }}
                          aria-label={tr(`取消 ${view.name} 的层级订阅`, `Cancel the hierarchy subscription for ${view.name}`)}
                          title={tr('取消层级订阅', 'Cancel hierarchy subscription')}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  )}
                  renderOverlay={(_source, item) =>
                    item ? (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-text shadow-xl">
                        <CMDBIcon value={item.icon} size={16} label={item.alias || item.name} />
                        <span className="truncate">{item.alias || item.name}</span>
                      </div>
                    ) : null
                  }
                />
              )}
            </Card>
          </aside>

          <Card className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-medium text-text">{tr('全部模型', 'All models')}</h2>
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search
                  size={14}
                  className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tr('搜索模型名称或标识', 'Search models by name or identifier')}
                  aria-label={tr('搜索模型', 'Search models')}
                  className="ps-8"
                />
              </div>
              <span className="text-[11px] text-text-faint">
                {tr(`${visibleModels.length} 个模型`, `${visibleModels.length} models`)}
              </span>
              <div
                className="ms-auto flex items-center gap-0.5 rounded-md border border-border p-0.5"
                role="group"
                aria-label={tr('视图模式', 'View mode')}
              >
                <Button
                  variant={catalogView === 'list' ? 'subtle' : 'plain'}
                  size="sm"
                  type="button"
                  onClick={() => setCatalogView('list')}
                  aria-pressed={catalogView === 'list'}
                  aria-label={tr('列表视图', 'List view')}
                  title={tr('列表视图', 'List view')}
                  className="px-1.5"
                >
                  <List size={12} aria-hidden="true" />
                </Button>
                <Button
                  variant={catalogView === 'grid' ? 'subtle' : 'plain'}
                  size="sm"
                  type="button"
                  onClick={() => setCatalogView('grid')}
                  aria-pressed={catalogView === 'grid'}
                  aria-label={tr('网格视图', 'Grid view')}
                  title={tr('网格视图', 'Grid view')}
                  className="px-1.5"
                >
                  <LayoutGrid size={12} aria-hidden="true" />
                </Button>
              </div>
            </div>

            {loading ? (
              <p className="py-8 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
            ) : filteredCatalog.length === 0 ? (
              <EmptyState
                icon={Search}
                title={query ? tr('没有匹配的模型', 'No model matches') : tr('还没有模型', 'No model yet')}
                hint={query ? tr('清除搜索后可以看到全部模型。', 'Clear the search to see every model.') : undefined}
                action={
                  query ? (
                    <Button variant="outline" size="sm" type="button" onClick={() => setQuery('')}>
                      {tr('清除搜索', 'Clear search')}
                    </Button>
                  ) : undefined
                }
                className="flex flex-col items-center justify-center gap-2 py-8 text-center"
              />
            ) : (
              <div className="mt-3 divide-y divide-border">
                {filteredCatalog.map((group, index) => {
                  const key = group.id != null ? `g:${group.id}` : 'other';
                  const expanded = query.trim() ? true : !collapsed.has(key);
                  return (
                    <section key={group.id ?? `other-${index}`} className="py-2">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsed((current) => {
                            const next = new Set(current);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                        aria-expanded={expanded}
                        className="flex w-full items-center gap-1.5 rounded-md py-1 text-start text-xs font-medium text-text-muted transition-colors hover:text-text"
                      >
                        <ChevronDown
                          size={14}
                          aria-hidden="true"
                          className={cn('shrink-0 transition-transform', !expanded && '-rotate-90')}
                        />
                        <span>{group.is_other ? tr('其他', 'Other') : group.name || tr('未命名分组', 'Untitled group')}</span>
                        <span className="text-text-faint">({group.ci_types.length})</span>
                      </button>

                      {expanded &&
                        (catalogView === 'grid' ? (
                          <ul className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {group.ci_types.map((model) => (
                              <li
                                key={model.id}
                                className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-3"
                              >
                                <div className="flex items-start gap-2">
                                  <CMDBIcon value={model.icon} size={18} label={model.alias || model.name} />
                                  <div className="min-w-0 flex-1">
                                    <h3
                                      className="truncate text-sm font-medium text-text"
                                      title={model.alias || model.name}
                                    >
                                      {model.alias || model.name}
                                    </h3>
                                    <div className="truncate font-mono text-[11px] text-text-faint">{model.name}</div>
                                  </div>
                                  <Chip tone={model.enabled ? 'success' : 'default'}>
                                    {model.enabled ? tr('启用', 'Enabled') : tr('停用', 'Disabled')}
                                  </Chip>
                                </div>
                                <div className="mt-2 flex-1">{catalogStatus(model)}</div>
                                <div className="mt-2 flex flex-wrap items-center justify-end gap-1 border-t border-border/60 pt-2">
                                  {catalogActionButtons(model)}
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <ul className="mt-1 divide-y divide-border">
                            {group.ci_types.map((model) => (
                              <li key={model.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                                <CMDBIcon value={model.icon} size={18} label={model.alias || model.name} />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate font-medium text-text">{model.alias || model.name}</span>
                                    <span className="truncate font-mono text-[11px] text-text-faint">{model.name}</span>
                                    <Chip tone={model.enabled ? 'success' : 'default'}>
                                      {model.enabled ? tr('启用', 'Enabled') : tr('停用', 'Disabled')}
                                    </Chip>
                                  </div>
                                  {catalogStatus(model)}
                                </div>
                                {/* A narrow window gives the row's actions their
                                    own line instead of squeezing the model name
                                    into an unreadable column. */}
                                <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto">
                                  {catalogActionButtons(model)}
                                </div>
                              </li>
                            ))}
                          </ul>
                        ))}
                    </section>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>

      {editing && (
        <SubscriptionEditor
          model={editing.model}
          initialTab={editing.tab}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            toast.success(message);
            await load(true);
          }}
          onUnsubscribe={(kind) => {
            const model = editing.model;
            setEditing(null);
            void unsubscribe(model, kind);
          }}
        />
      )}

      {autoOpen && (
        <AutoSubscriptionModal
          current={autoSub}
          groups={modelGroups
            .filter((group) => group.id != null)
            .map((group) => ({
              ...group,
              ci_types: (group.ci_types ?? []).filter((model) => !IPAM_MODELS.has(model.name)),
            }))}
          models={visibleModels}
          onClose={() => setAutoOpen(false)}
          onSaved={async (message) => {
            setAutoOpen(false);
            toast.success(message);
            await load(true);
          }}
        />
      )}

      {dialog}
    </div>
  );
}

function normalizeAuto(raw: AutoSubscription | null): AutoSubscription | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  return {
    base_strategy: raw.base_strategy === 'none' ? 'none' : 'all',
    group_ids: raw.group_ids ?? [],
    type_ids: raw.type_ids ?? [],
    enabled: raw.enabled === true,
    description: raw.description ?? '',
  };
}

function SummaryStat({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-bg px-2.5 py-2">
      <dt className="flex items-center gap-1.5 text-[11px] text-text-muted">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 text-lg font-semibold text-text">{value}</dd>
    </div>
  );
}

function SectionHeader({ icon, title, count }: { icon: ReactNode; title: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-text-muted">{icon}</span>
      <h3 className="text-sm font-medium text-text">{title}</h3>
      <Chip>{count}</Chip>
    </div>
  );
}

/** The grip is the only activator; the row's buttons keep their own actions. */
function DragHandle({
  handle,
  label,
  className,
}: {
  handle: SortableHandle;
  label: string;
  className?: string;
}) {
  if (!handle.draggable) return <span className="inline-block size-6 shrink-0" aria-hidden="true" />;
  return (
    <button
      type="button"
      {...handle.attributes}
      {...handle.listeners}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-text-faint hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 active:cursor-grabbing',
        className,
      )}
    >
      <GripVertical size={12} aria-hidden="true" />
    </button>
  );
}
