import { useMemo, useState } from 'react';
import { Folder, Pencil, Plus, Search, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { TopologyGroup, TopologyView } from '../../api/topology';
import { DragHandle } from '../DragHandle';
import {
  GroupedSortable,
  type DragSource,
  type SortableHandle,
} from '../GroupedSortable';

// The saved-view rail.
//
// THE GROUPS ARE DRAGGABLE, THE VIEWS ARE DRAGGABLE INSIDE AND BETWEEN THEM.
// cantor's sidebar behaved this way; reordering only starts from the grip, so
// selecting a view never turns into an accidental move. The ungrouped bucket is
// read-only: a view gets a folder by editing it, not by being dropped on a
// bucket that has no id to persist.
//
// SEARCH DISABLES DRAG. Reordering the filtered subset would persist an order
// for only the rows the operator can see, which is not the order they meant.

const REVEAL =
  'opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(pointer:coarse)]:opacity-100';

type Slot = { key: string; group: TopologyGroup };

function viewLabel(view: TopologyView): string {
  return view.name.trim();
}

function SidebarViewRow({
  view,
  handle,
  selected,
  isAdmin,
  onSelect,
  onEdit,
  onDelete,
}: {
  view: TopologyView;
  handle?: SortableHandle;
  selected: boolean;
  isAdmin: boolean;
  onSelect(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const { tr } = useI18n();
  const label = viewLabel(view);
  return (
    <div
      className={cn(
        'group/row flex min-h-8 items-center gap-1 rounded-md px-1.5 transition-colors',
        selected ? 'bg-indigo-500/10' : 'hover:bg-card',
      )}
    >
      {handle ? (
        <DragHandle
          handle={handle}
          label={tr(`拖动视图 ${label}`, `Drag view ${label}`)}
          className={REVEAL}
        />
      ) : (
        <span className="inline-block size-6 shrink-0" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={tr(`查看拓扑视图 ${label}`, `View topology ${label}`)}
        title={label}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-start focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded bg-card text-[10px] font-semibold text-text-muted',
            selected && 'bg-indigo-600 text-white',
          )}
        >
          {label.charAt(0).toUpperCase() || '?'}
        </span>
        <span className="min-w-0 truncate text-xs text-text">{label}</span>
      </button>
      {isAdmin && (
        <div className={cn('flex shrink-0 items-center gap-0.5', REVEAL)}>
          <Button
            variant="subtle"
            size="sm"
            type="button"
            onClick={onEdit}
            aria-label={tr(`编辑视图 ${label}`, `Edit view ${label}`)}
            title={tr('编辑视图', 'Edit view')}
          >
            <Pencil size={12} aria-hidden="true" />
          </Button>
          <Button
            variant="dangerGhost"
            size="sm"
            type="button"
            onClick={onDelete}
            aria-label={tr(`删除视图 ${label}`, `Delete view ${label}`)}
            title={tr('删除视图', 'Delete view')}
          >
            <Trash2 size={12} aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function TopologySidebar({
  groups,
  ungrouped,
  selected,
  loading,
  isAdmin,
  onSelect,
  onNewView,
  onEditGroup,
  onDeleteGroup,
  onEditView,
  onDeleteView,
  onArrange,
  onCommit,
  onCancelArrange,
}: {
  groups: TopologyGroup[];
  ungrouped: TopologyView[];
  selected: number | null;
  loading: boolean;
  isAdmin: boolean;
  onSelect(id: number): void;
  onNewView(groupID?: number): void;
  onEditGroup(group: TopologyGroup): void;
  onDeleteGroup(group: TopologyGroup): void;
  onEditView(view: TopologyView): void;
  onDeleteView(view: TopologyView): void;
  onArrange(next: TopologyGroup[]): void;
  onCommit(source: DragSource, next: TopologyGroup[]): void;
  onCancelArrange(): void;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const searching = term.length > 0;
  const canDrag = isAdmin && !searching;

  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => {
          const groupMatch = group.name.toLowerCase().includes(term);
          const views = groupMatch
            ? group.views
            : group.views.filter((view) => view.name.toLowerCase().includes(term));
          return { ...group, views };
        })
        .filter((group) => !searching || group.views.length > 0),
    [groups, searching, term],
  );
  const visibleUngrouped = useMemo(
    () => (searching ? ungrouped.filter((view) => view.name.toLowerCase().includes(term)) : ungrouped),
    [searching, term, ungrouped],
  );

  const slots = useMemo<Slot[]>(
    () => visibleGroups.map((group) => ({ key: `g:${group.id}`, group })),
    [visibleGroups],
  );

  const empty = groups.length === 0 && ungrouped.length === 0;
  const noMatch = searching && visibleGroups.length === 0 && visibleUngrouped.length === 0;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0 border-b border-border/50 p-3">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-text-faint"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr('搜索视图', 'Search views')}
            aria-label={tr('搜索拓扑视图', 'Search topology views')}
            className="ps-8"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <p className="px-2 py-6 text-center text-xs text-text-muted">
            {tr('加载中…', 'Loading…')}
          </p>
        ) : empty ? (
          <p className="px-2 py-6 text-center text-xs text-text-faint">
            {tr('还没有拓扑视图。新建一个开始。', 'No topology view yet. Create one to start.')}
          </p>
        ) : noMatch ? (
          <div className="px-2 py-6 text-center text-xs text-text-faint">
            <p>{tr('没有匹配的视图', 'No matching view')}</p>
            <Button variant="ghost" size="sm" type="button" onClick={() => setQuery('')} className="mt-2">
              {tr('清除搜索', 'Clear search')}
            </Button>
          </div>
        ) : (
          <>
            <GroupedSortable<TopologyView, Slot>
              groups={slots}
              getID={(view) => view.id}
              getItems={(slot) => slot.group.views}
              withItems={(slot, views) => ({ ...slot, group: { ...slot.group, views } })}
              onGroupsChange={(next) => onArrange(next.map((slot) => slot.group))}
              onCommit={(source, next) => onCommit(source, next.map((slot) => slot.group))}
              onCancel={onCancelArrange}
              canDragGroup={() => canDrag}
              canDragItem={() => canDrag}
              itemsClassName="space-y-0.5"
              renderGroup={(slot, handle, children) => {
                const group = slot.group;
                return (
                  <section className="mb-1">
                    <div className="group/row flex min-h-8 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-card">
                      <DragHandle
                        handle={handle}
                        label={tr(`拖动分组 ${group.name}`, `Drag group ${group.name}`)}
                        className={REVEAL}
                      />
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <Folder size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
                        <span
                          className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-text-faint"
                          title={group.name}
                        >
                          {group.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-card px-1.5 text-[10px] leading-4 text-text-faint">
                          {group.views.length}
                        </span>
                      </div>
                      {isAdmin && (
                        <div className={cn('flex shrink-0 items-center gap-0.5', REVEAL)}>
                          <Button
                            variant="subtle"
                            size="sm"
                            type="button"
                            onClick={() => onNewView(group.id)}
                            aria-label={tr(`在分组 ${group.name} 中新建视图`, `New view in ${group.name}`)}
                            title={tr('在分组中新建视图', 'New view in this group')}
                          >
                            <Plus size={12} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="subtle"
                            size="sm"
                            type="button"
                            onClick={() => onEditGroup(group)}
                            aria-label={tr(`编辑分组 ${group.name}`, `Edit group ${group.name}`)}
                            title={tr('编辑分组', 'Edit group')}
                          >
                            <Pencil size={12} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="dangerGhost"
                            size="sm"
                            type="button"
                            onClick={() => onDeleteGroup(group)}
                            aria-label={tr(`删除分组 ${group.name}`, `Delete group ${group.name}`)}
                            title={tr('删除分组', 'Delete group')}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="ms-4 border-s border-border/50 ps-1">{children}</div>
                  </section>
                );
              }}
              renderItem={(view, _groupKey, handle) => (
                <SidebarViewRow
                  view={view}
                  handle={handle}
                  selected={selected === view.id}
                  isAdmin={isAdmin}
                  onSelect={() => onSelect(view.id)}
                  onEdit={() => onEditView(view)}
                  onDelete={() => onDeleteView(view)}
                />
              )}
              renderOverlay={(source, item) => {
                if (source.type === 'group') {
                  const group = slots.find((slot) => slot.key === source.groupKey)?.group;
                  return group ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-text shadow-xl">
                      <Folder size={13} className="text-text-faint" aria-hidden="true" />
                      <span className="truncate">{group.name}</span>
                    </div>
                  ) : null;
                }
                return item ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-text shadow-xl">
                    <span className="flex size-5 items-center justify-center rounded bg-indigo-600 text-[10px] font-semibold text-white">
                      {viewLabel(item).charAt(0).toUpperCase() || '?'}
                    </span>
                    <span className="truncate">{viewLabel(item)}</span>
                  </div>
                ) : null;
              }}
            />

            {visibleUngrouped.length > 0 && (
              <section className="mt-3">
                <div className="flex min-h-8 items-center gap-1.5 px-1.5">
                  <span className="inline-block size-6 shrink-0" aria-hidden="true" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                    {tr('未分组', 'Ungrouped')}
                  </span>
                  <span className="rounded-full bg-card px-1.5 text-[10px] leading-4 text-text-faint">
                    {visibleUngrouped.length}
                  </span>
                </div>
                <div className="ms-4 border-s border-border/50 ps-1">
                  {visibleUngrouped.map((view) => (
                    <SidebarViewRow
                      key={view.id}
                      view={view}
                      selected={selected === view.id}
                      isAdmin={isAdmin}
                      onSelect={() => onSelect(view.id)}
                      onEdit={() => onEditView(view)}
                      onDelete={() => onDeleteView(view)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
