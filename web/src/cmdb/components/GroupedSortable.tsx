import { useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { cn } from '@/lib/cn';

import { reorderSlots } from '../lib/group-drag';

// Two-level drag for "groups holding models", shared by 我的订阅, the model
// configuration tree and the grouped model list.
//
// THE PARENT OWNS THE DATA. This component only rearranges the slots it is
// given and reports what happened, because the three surfaces persist different
// writes: the subscription list stores one per-user model order, while the
// model configuration stores shared group positions and membership. Keeping the
// persistence in the caller is what stops a drop in one surface from writing
// the other's rule.
//
// THE DRAG HANDLE IS THE ACTIVATOR. A row or card remains a link/button with
// its own action; only the grip starts a drag, so a click to open a model never
// turns into an accidental reorder. `attributes` and `listeners` must go on that
// grip rather than on the wrapper, which is why the render props receive them.
//
// KEYBOARD IS A FIRST-CLASS SENSOR. dnd-kit's KeyboardSensor lets an operator
// focus a grip, press Space, move with the arrow keys and drop with Space, and
// it announces the move through its live region. This is why the old up/down
// buttons can be replaced rather than kept beside the drag.

export type SortableHandle = {
  attributes: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  isDragging: boolean;
  /** False when this row or group cannot be dragged (for example, no admin). */
  draggable: boolean;
};

export type DragSource =
  | { type: 'group'; groupKey: string }
  | { type: 'item'; groupKey: string; itemID: number };

/** The only thing the drag needs from a group; the caller owns the rest. */
export type SortableGroup = { key: string };

type Props<T, G extends SortableGroup> = {
  groups: G[];
  getID(item: T): number;
  /** The group's models, in display order. */
  getItems(group: G): T[];
  /** Returns the group with a replaced item list, preserving its metadata. */
  withItems(group: G, items: T[]): G;
  onGroupsChange(next: G[]): void;
  /** Called once on drop, with the source taken at drag start and the final slots. */
  onCommit(source: DragSource, groups: G[]): void;
  renderGroup(group: G, handle: SortableHandle, children: ReactNode): ReactNode;
  renderItem(item: T, groupKey: string, handle: SortableHandle): ReactNode;
  renderOverlay(source: DragSource, item: T | undefined): ReactNode;
  /** Defaults to every group. The ungrouped bucket usually opts out. */
  canDragGroup?(group: G): boolean;
  /** Defaults to every item. */
  canDragItem?(item: T): boolean;
  /** Blocks a drop into a different group when false. */
  allowCrossGroup?: boolean;
  /** Layout for one group's children; defaults to a vertical list. */
  itemsClassName?: string;
};

export function GroupedSortable<T, G extends SortableGroup = SortableGroup>({
  groups,
  getID,
  getItems,
  withItems,
  onGroupsChange,
  onCommit,
  renderGroup,
  renderItem,
  renderOverlay,
  canDragGroup,
  canDragItem,
  allowCrossGroup = true,
  itemsClassName = 'space-y-0.5',
}: Props<T, G>) {
  const [active, setActive] = useState<DragSource | null>(null);
  const sourceRef = useRef<DragSource | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragSource | undefined;
    if (!data) return;
    // Snapshot: dnd-kit mutates active.data.current in place during a live
    // cross-group move, so a reference would point at the wrong group by drop.
    const source: DragSource =
      data.type === 'group'
        ? { type: 'group', groupKey: data.groupKey }
        : { type: 'item', groupKey: data.groupKey, itemID: data.itemID };
    sourceRef.current = source;
    setActive(source);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active: dragged, over } = event;
    if (!over) return;
    const activeData = dragged.data.current as DragSource | undefined;
    const overData = over.data.current as DragSource | undefined;
    if (!activeData || !overData) return;

    if (activeData.type === 'group') {
      if (overData.type !== 'group') return;
      const sourceGroup = groups.find((group) => group.key === activeData.groupKey);
      if (sourceGroup && canDragGroup && !canDragGroup(sourceGroup)) return;
      // A group that cannot be dragged is not a reorder target either: the
      // trailing 其他 bucket is where ungrouped models live, not a position in
      // the shared group order.
      const overGroup = groups.find((group) => group.key === overData.groupKey);
      if (overGroup && canDragGroup && !canDragGroup(overGroup)) return;
      if (activeData.groupKey === overData.groupKey) return;
      const next = reorderSlots(groups, activeData.groupKey, overData.groupKey) as G[];
      if (next !== groups) onGroupsChange(next);
      return;
    }

    if (overData.type !== 'group' && overData.type !== 'item') return;
    const targetKey = overData.groupKey;
    if (targetKey !== activeData.groupKey && !allowCrossGroup) return;
    const target = groups.find((group) => group.key === targetKey);
    const targetItems = target ? getItems(target) : [];
    const targetIndex =
      overData.type === 'item'
        ? targetItems.findIndex((item) => getID(item) === overData.itemID)
        : targetItems.length;
    const next = moveBetween(groups, getItems, withItems, getID, activeData.groupKey, targetKey, activeData.itemID, targetIndex);
    if (next !== groups) onGroupsChange(next);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    void event;
    const source = sourceRef.current;
    sourceRef.current = null;
    setActive(null);
    if (source) onCommit(source, groups);
  };

  const cancel = () => {
    sourceRef.current = null;
    setActive(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={cancel}
    >
      <div className="space-y-1">
        {groups.map((group) => (
          <SortableGroupBox
            key={group.key}
            group={group}
            canDragGroup={canDragGroup}
            canDragItem={canDragItem}
            getID={getID}
            getItems={getItems}
            itemsClassName={itemsClassName}
            renderGroup={renderGroup}
            renderItem={renderItem}
          />
        ))}
      </div>
      <DragOverlay>{active ? overlay(active, groups, getID, getItems, renderOverlay) : null}</DragOverlay>
    </DndContext>
  );
}

function overlay<T, G extends SortableGroup>(
  source: DragSource,
  groups: G[],
  getID: (item: T) => number,
  getItems: (group: G) => T[],
  render: (source: DragSource, item: T | undefined) => ReactNode,
): ReactNode {
  if (source.type === 'group') return render(source, undefined);
  const slot = groups.find((group) => group.key === source.groupKey);
  const item = slot ? getItems(slot).find((candidate) => getID(candidate) === source.itemID) : undefined;
  return render(source, item);
}

function SortableGroupBox<T, G extends SortableGroup>({
  group,
  canDragGroup,
  canDragItem,
  getID,
  getItems,
  itemsClassName,
  renderGroup,
  renderItem,
}: {
  group: G;
  canDragGroup?(group: G): boolean;
  canDragItem?(item: T): boolean;
  getID(item: T): number;
  getItems(group: G): T[];
  itemsClassName: string;
  renderGroup(group: G, handle: SortableHandle, children: ReactNode): ReactNode;
  renderItem(item: T, groupKey: string, handle: SortableHandle): ReactNode;
}) {
  const disabled = canDragGroup ? !canDragGroup(group) : false;
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: groupDragID(group.key),
    data: { type: 'group', groupKey: group.key },
    disabled,
  });

  const handle: SortableHandle = {
    attributes,
    listeners,
    isDragging,
    draggable: !disabled,
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'opacity-50')}
    >
      {(() => {
        const items = getItems(group);
        return renderGroup(
          group,
          handle,
          <SortableContext
            items={items.map((item) => itemDragID(group.key, getID(item)))}
            strategy={verticalListSortingStrategy}
          >
            <div className={itemsClassName}>
              {items.map((item) => (
                <SortableItemRow
                  key={getID(item)}
                  item={item}
                  groupKey={group.key}
                  getID={getID}
                  canDrag={canDragItem ? canDragItem(item) : true}
                  renderItem={renderItem}
                />
              ))}
            </div>
          </SortableContext>,
        );
      })()}
    </div>
  );
}

function SortableItemRow<T>({
  item,
  groupKey,
  getID,
  canDrag,
  renderItem,
}: {
  item: T;
  groupKey: string;
  getID(item: T): number;
  canDrag: boolean;
  renderItem(item: T, groupKey: string, handle: SortableHandle): ReactNode;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: itemDragID(groupKey, getID(item)),
    data: { type: 'item', groupKey, itemID: getID(item) },
    disabled: !canDrag,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'opacity-50')}
    >
      {renderItem(item, groupKey, { attributes, listeners, isDragging, draggable: canDrag })}
    </div>
  );
}

/** Move one model within or across groups, preserving each group's metadata. */
function moveBetween<T, G extends SortableGroup>(
  groups: G[],
  getItems: (group: G) => T[],
  withItems: (group: G, items: T[]) => G,
  getID: (item: T) => number,
  fromKey: string,
  toKey: string,
  itemID: number,
  targetIndex: number,
): G[] {
  const from = groups.find((group) => group.key === fromKey);
  const to = groups.find((group) => group.key === toKey);
  if (!from || !to) return groups;

  const fromItems = getItems(from);
  const oldIndex = fromItems.findIndex((item) => getID(item) === itemID);
  if (oldIndex === -1) return groups;

  if (fromKey === toKey) {
    const clamped = Math.max(0, Math.min(targetIndex, fromItems.length - 1));
    if (clamped === oldIndex) return groups;
    const items = [...fromItems];
    const [moved] = items.splice(oldIndex, 1);
    items.splice(clamped, 0, moved);
    return groups.map((group) => (group.key === fromKey ? withItems(group, items) : group));
  }

  const [moved] = fromItems.filter((item) => getID(item) === itemID);
  if (!moved) return groups;
  const toItems = [...getItems(to)];
  const insertAt = Math.max(0, Math.min(targetIndex, toItems.length));
  toItems.splice(insertAt, 0, moved);
  const fromNext = fromItems.filter((item) => getID(item) !== itemID);

  return groups.map((group) => {
    if (group.key === fromKey) return withItems(group, fromNext);
    if (group.key === toKey) return withItems(group, toItems);
    return group;
  });
}

function groupDragID(key: string): string {
  return `group:${key}`;
}

function itemDragID(groupKey: string, itemID: number): string {
  return `item:${groupKey}:${itemID}`;
}
