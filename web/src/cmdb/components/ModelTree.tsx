import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Folder, FolderOpen, GripVertical, Plus, Search } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/store/me';

import type { CIType } from '../api/citype';
import { describeError } from '../api/http';
import {
  deleteModelGroup,
  listModelGroups,
  reorderModelGroups,
  setModelGroupMembers,
  type ModelGroup,
} from '../api/preferences';
import { GroupedSortable, type DragSource, type SortableHandle } from './GroupedSortable';
import { CMDBIcon } from './CMDBIcon';
import { useModelGroupsSync, useModelTreeRefresh } from './model-tree-context';
import { groupIDFromSlotKey, groupSlotKey, mergeGroupMembership, sharedDragPlan } from '../lib/group-drag';

// The model tree is the navigation half of the model configuration workspace.
//
// A MODEL LIST IS NOT A TREE. The list page answers "which models exist"; this
// tree answers "where is the model I am looking for", using the same shared
// groups the rest of the CMDB uses. The right pane owns the detail and the
// write actions; the tree deliberately stays a navigation surface so a row
// cannot accidentally become a destructive menu.
//
// Models are grouped by the shared group definitions, with an "Other" bucket
// for ungrouped models. Searching flattens across groups: an operator who
// knows the name should not have to remember which folder it lives in.

type TreeGroup = {
  key: string;
  name?: string;
  isOther?: boolean;
  models: CIType[];
};

export function ModelTree({
  models,
  groups,
  selectedID,
  loading,
  error,
  onRetry,
  onSelect,
  compact,
}: {
  models: CIType[];
  groups: ModelGroup[];
  selectedID?: number;
  loading: boolean;
  error?: string | null;
  onRetry?(): void;
  onSelect?(): void;
  /** The list page adds its own header and create action; the rail is then
   *  only search + tree + the group-management link. */
  compact?: boolean;
}) {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const treeRefresh = useModelTreeRefresh();
  const groupsSync = useModelGroupsSync();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragErr, setDragErr] = useState<string | null>(null);
  const selectedRef = useRef<HTMLAnchorElement | null>(null);

  const treeGroups = useMemo<TreeGroup[]>(() => {
    const byModel = new Map<number, CIType>();
    models.forEach((model) => byModel.set(model.id, model));
    const assigned = new Set<number>();
    const fromAPI: TreeGroup[] = groups.map((group) => {
      const groupModels = (group.ci_types ?? [])
        .map((item) => byModel.get(item.id) ?? item)
        .filter((item) => byModel.has(item.id));
      groupModels.forEach((item) => assigned.add(item.id));
      return {
        key: groupSlotKey(group),
        name: group.name,
        isOther: group.is_other || group.id == null,
        models: groupModels,
      };
    });
    const ungrouped = models.filter((model) => !assigned.has(model.id));
    if (ungrouped.length > 0) {
      const existingOther = fromAPI.find((group) => group.isOther);
      if (existingOther) {
        existingOther.models = [...existingOther.models, ...ungrouped];
      } else {
        fromAPI.push({ key: 'other', name: tr('其他', 'Other'), isOther: true, models: ungrouped });
      }
    }
    if (fromAPI.length === 0 && models.length > 0) {
      return [{ key: 'other', name: tr('全部模型', 'All models'), isOther: true, models }];
    }
    return fromAPI;
  }, [groups, models, tr]);

  // Seeded from the server arrangement, then edited by drag. Initialising from
  // the computed groups avoids an empty first frame for an administrator.
  const [dragGroups, setDragGroups] = useState<TreeGroup[]>(treeGroups);

  const needle = query.trim().toLowerCase();
  const visibleGroups = useMemo(
    () =>
      treeGroups
        .map((group) => ({
          ...group,
          models: group.models.filter(
            (model) => !needle || model.name.toLowerCase().includes(needle) || model.alias.toLowerCase().includes(needle),
          ),
        }))
        .filter((group) => group.models.length > 0),
    [needle, treeGroups],
  );

  // The synthetic "All models" bucket has no group to store an order in, so it
  // is not a drag surface. Requiring at least one real group also keeps a
  // group-less deployment on the cheap static path.
  const canDrag = isAdmin && !needle && treeGroups.some((group) => !group.isOther);

  // The drag edits a copy; a prop change (after a refresh) re-seeds it. Only
  // when there is a drag surface: a group-less tree stays on the static path
  // and must not pay for a second render of every row.
  useEffect(() => {
    if (canDrag) setDragGroups(treeGroups);
  }, [canDrag, treeGroups]);

  const commitDrag = async (source: DragSource, next: TreeGroup[]) => {
    setDragGroups(next);
    const plan = sharedDragPlan(
      source,
      next.map((group) => ({ key: group.key, items: group.models })),
      (model) => model.id,
    );
    const beforeOrder = treeGroups.map((group) => groupIDFromSlotKey(group.key)).filter((id): id is number => id != null);
    const orderChanged =
      plan.groupOrder != null &&
      (plan.groupOrder.length !== beforeOrder.length || plan.groupOrder.some((id, index) => id !== beforeOrder[index]));
    const hasWrite = orderChanged || plan.setMembers != null || plan.detachFrom != null;
    if (!hasWrite) {
      // Dropping inside 其他 has no shared membership to store; put the row back
      // rather than leaving an arrangement that would vanish on the next read.
      setDragGroups(treeGroups);
      return;
    }
    try {
      // Read the groups at write time: the tree's snapshot can be older than a
      // card-view or subscription write, and a stale membership list would
      // drop the members this surface cannot see.
      const fresh = await listModelGroups();
      if (orderChanged && plan.groupOrder) {
        const freshIDs = fresh.map((group) => group.id).filter((id): id is number => id != null);
        const missing = freshIDs.filter((id) => !plan.groupOrder?.includes(id));
        await reorderModelGroups([...plan.groupOrder, ...missing]);
      }
      if (plan.setMembers) {
        const full = fresh.find((group) => group.id === plan.setMembers?.groupID)?.ci_types.map((model) => model.id) ?? [];
        await setModelGroupMembers(plan.setMembers.groupID, mergeGroupMembership(plan.setMembers.typeIDs, full));
      }
      if (plan.detachFrom != null && source.type === 'item') {
        await deleteModelGroup(plan.detachFrom, [source.itemID]);
      }
      setDragErr(null);
      treeRefresh?.refresh();
      groupsSync?.notify();
    } catch (error) {
      setDragErr(describeError(error, tr('保存分组拖动失败', 'Could not save the group arrangement')));
      setDragGroups(treeGroups);
      treeRefresh?.refresh();
    }
  };

  useEffect(() => {
    if (!selectedID) return;
    const group = treeGroups.find((item) => item.models.some((model) => model.id === selectedID));
    if (!group) return;
    setCollapsed((current) => {
      if (!current.has(group.key)) return current;
      const next = new Set(current);
      next.delete(group.key);
      return next;
    });
    requestAnimationFrame(() => selectedRef.current?.scrollIntoView?.({ block: 'nearest' }));
  }, [selectedID, treeGroups]);

  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isOpen = (group: TreeGroup) => !!needle || !collapsed.has(group.key);
  const groupTitle = (group: TreeGroup) =>
    group.isOther ? tr('其他', 'Other') : group.name || tr('未命名分组', 'Untitled group');

  const groupRow = (group: TreeGroup, grip?: ReactNode) => {
    const open = isOpen(group);
    return (
      <div className="flex items-center gap-0.5">
        {grip}
        <button
          type="button"
          onClick={() => toggle(group.key)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-text-muted hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
          {open ? <FolderOpen size={13} className="shrink-0 text-indigo-400" aria-hidden="true" /> : <Folder size={13} className="shrink-0 text-indigo-400" aria-hidden="true" />}
          <span className="min-w-0 truncate">{groupTitle(group)}</span>
          <span className="ms-auto text-[10px] text-text-faint">{group.models.length}</span>
        </button>
      </div>
    );
  };

  const modelRow = (model: CIType, grip?: ReactNode) => {
    const selected = selectedID === model.id;
    return (
      <div className="flex items-center gap-0.5">
        {grip}
        <Link
          ref={selected ? selectedRef : undefined}
          to={`/cmdb/models/${model.id}`}
          onClick={onSelect}
          aria-current={selected ? 'page' : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500',
            selected ? 'bg-indigo-500/15 text-text' : 'text-text-muted hover:bg-card hover:text-text',
          )}
        >
          <CMDBIcon value={model.icon} size={14} label={model.alias || model.name} />
          <span className="min-w-0 flex-1 truncate">{model.alias || model.name}</span>
          {!model.enabled && <Chip className="shrink-0 px-1 py-0 text-[10px]">{tr('停用', 'Off')}</Chip>}
        </Link>
      </div>
    );
  };

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-bg lg:w-64 lg:shrink-0 xl:w-72" aria-label={tr('模型导航', 'Model navigation')}>
      <div className="flex flex-col gap-2 border-b border-border p-3">
        {!compact && (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text">{tr('模型', 'Models')}</h2>
              <p className="text-[11px] text-text-faint">{tr(`${models.length} 个模型`, `${models.length} models`)}</p>
            </div>
            <Link
              to="/cmdb/models?new=1"
              className="inline-flex h-7 items-center gap-1 rounded-md bg-indigo-600 px-2 text-[11px] font-medium text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
              onClick={onSelect}
            >
              <Plus size={12} aria-hidden="true" />
              {tr('新建', 'New')}
            </Link>
          </div>
        )}
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden="true" />
          <Input
            type="search"
            aria-label={tr('搜索模型', 'Search models')}
            placeholder={tr('搜索模型分组或模型…', 'Search groups or models…')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full pl-7 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {dragErr && (
          <div role="alert" className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-300">
            {dragErr}
          </div>
        )}
        {loading ? (
          <p className="px-2 py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
            <p className="text-xs text-red-300">{error}</p>
            {onRetry && (
              <Button variant="outline" size="sm" type="button" onClick={onRetry}>
                {tr('重试', 'Retry')}
              </Button>
            )}
          </div>
        ) : needle && visibleGroups.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-text-muted">{tr('没有匹配的模型', 'No model matches that')}</p>
        ) : models.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-text-muted">{tr('还没有模型', 'No models yet')}</p>
        ) : canDrag ? (
          <GroupedSortable<CIType, TreeGroup>
            groups={dragGroups}
            getID={(model) => model.id}
            getItems={(group) => group.models}
            withItems={(group, models) => ({ ...group, models })}
            onGroupsChange={setDragGroups}
            onCommit={(source, next) => void commitDrag(source, next)}
            canDragGroup={(group) => !group.isOther}
            renderGroup={(group, sortable, children) => (
              <div>
                {groupRow(
                  group,
                  <TreeGrip handle={sortable} label={tr(`拖动分组 ${groupTitle(group)}`, `Drag the ${groupTitle(group)} group`)} />,
                )}
                {isOpen(group) && (
                  <div className="ms-3 flex flex-col gap-0.5 border-s border-border ps-1">{children}</div>
                )}
              </div>
            )}
            renderItem={(model, _groupKey, sortable) =>
              modelRow(model, <TreeGrip handle={sortable} label={tr(`拖动模型 ${model.name}`, `Drag ${model.name}`)} />)
            }
            renderOverlay={(source, item) => {
              if (source.type === 'group') {
                const group = dragGroups.find((candidate) => candidate.key === source.groupKey);
                return (
                  <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-text shadow-xl">
                    <Folder size={13} className="text-indigo-400" aria-hidden="true" />
                    <span className="truncate">{group ? groupTitle(group) : tr('分组', 'Group')}</span>
                    <span className="text-text-faint">{group?.models.length ?? 0}</span>
                  </div>
                );
              }
              if (!item) return null;
              return (
                <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-text shadow-xl">
                  <CMDBIcon value={item.icon} size={14} label={item.alias || item.name} />
                  <span className="truncate">{item.alias || item.name}</span>
                </div>
              );
            }}
          />
        ) : (
          <div className="flex flex-col gap-1">
            {visibleGroups.map((group) => (
              <div key={group.key}>
                {groupRow(group)}
                {isOpen(group) && (
                  <div className="ms-3 flex flex-col gap-0.5 border-s border-border ps-1">
                    {group.models.map((model) => (
                      <div key={model.id}>{modelRow(model)}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <Link
          to="/cmdb/preferences?tab=groups"
          className="text-[11px] text-text-faint underline-offset-2 hover:text-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          {tr('管理模型分组', 'Manage model groups')}
        </Link>
      </div>
    </aside>
  );
}

/** The grip is the only activator; the folder button keeps its collapse action. */
function TreeGrip({ handle, label }: { handle: SortableHandle; label: string }) {
  if (!handle.draggable) return null;
  return (
    <button
      type="button"
      {...handle.attributes}
      {...handle.listeners}
      aria-label={label}
      title={label}
      className="inline-flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-text-faint hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 active:cursor-grabbing"
    >
      <GripVertical size={11} aria-hidden="true" />
    </button>
  );
}
