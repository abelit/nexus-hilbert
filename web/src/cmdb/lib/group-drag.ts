// Pure helpers for the two-level drag: a list of groups, each holding models.
//
// THE MODEL CONFIG TREE, THE GROUPED MODEL LIST AND 我的订阅 all drag the same
// shape — groups in an order, models inside them — and all persist a different
// pair of writes. Keeping the rearrangement itself pure means the three
// surfaces cannot disagree about what a cross-group drop does, and the risky
// part (which group moved which model) is testable without a browser.

/** The key of the trailing bucket for models in no group. */
export const OTHER_GROUP_KEY = 'other';

/** A group slot: a stable drag id and the models it holds, in display order. */
export type DragSlot<T> = { key: string; items: T[] };

/** The stable key shared by every surface: `g:<id>` or `other`. */
export function groupSlotKey(group: { id?: number | null }): string {
  return group.id != null ? `g:${group.id}` : OTHER_GROUP_KEY;
}

/** The database id behind a slot key, or null for the ungrouped bucket. */
export function groupIDFromSlotKey(key: string): number | null {
  if (!key.startsWith('g:')) return null;
  const id = Number(key.slice(2));
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Reorder the group slots themselves. */
export function reorderSlots<T extends { key: string }>(
  slots: T[],
  activeKey: string,
  overKey: string,
): T[] {
  const oldIndex = slots.findIndex((slot) => slot.key === activeKey);
  const newIndex = slots.findIndex((slot) => slot.key === overKey);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return slots;
  const next = [...slots];
  const [moved] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, moved);
  return next;
}

/**
 * Move one model within its group or into another group.
 *
 * `targetIndex` is the destination index in the CURRENT target list. A
 * same-group move is a simple splice; a cross-group move removes from the
 * source and inserts into the target at the clamped index. The input is not
 * mutated, so a caller can reject the result by not committing it.
 */
export function moveItemBetweenGroups<T>(
  slots: DragSlot<T>[],
  fromKey: string,
  toKey: string,
  itemID: number,
  targetIndex: number,
  getID: (item: T) => number,
): DragSlot<T>[] {
  const from = slots.find((slot) => slot.key === fromKey);
  const to = slots.find((slot) => slot.key === toKey);
  if (!from || !to) return slots;

  const oldIndex = from.items.findIndex((item) => getID(item) === itemID);
  if (oldIndex === -1) return slots;

  if (fromKey === toKey) {
    const clamped = Math.max(0, Math.min(targetIndex, from.items.length - 1));
    if (clamped === oldIndex) return slots;
    const items = [...from.items];
    const [moved] = items.splice(oldIndex, 1);
    items.splice(clamped, 0, moved);
    return slots.map((slot) => (slot.key === fromKey ? { ...slot, items } : slot));
  }

  const [moved] = from.items.filter((item) => getID(item) === itemID);
  if (!moved) return slots;
  const fromItems = from.items.filter((item) => getID(item) !== itemID);
  const toItems = [...to.items];
  const insertAt = Math.max(0, Math.min(targetIndex, toItems.length));
  toItems.splice(insertAt, 0, moved);

  return slots.map((slot) => {
    if (slot.key === fromKey) return { ...slot, items: fromItems };
    if (slot.key === toKey) return { ...slot, items: toItems };
    return slot;
  });
}

/** The model ids of every slot, group by group, top to bottom. */
export function flattenSlotIDs<T>(slots: DragSlot<T>[], getID: (item: T) => number): number[] {
  return slots.flatMap((slot) => slot.items.map(getID));
}

/** The slot a model currently sits in. */
export function slotOfItem<T>(slots: DragSlot<T>[], itemID: number, getID: (item: T) => number): DragSlot<T> | undefined {
  return slots.find((slot) => slot.items.some((item) => getID(item) === itemID));
}

/**
 * The shared-config writes one completed model-configuration drag needs.
 *
 * `null` means "nothing to persist": dropping a model already in 其他 within 其他
 * has no membership to write, and a group drag that did not move anything has
 * no order to save. The caller decides whether to send it, so an idempotent
 * read cannot turn into a redundant write.
 */
/**
 * Merges the dropped order with the group's full membership.
 *
 * THE SUBSCRIPTION PANE KNOWS ONLY SUBSCRIBED MODELS. Writing its list back as
 * the whole group would silently remove every member the operator has not
 * subscribed to — a shared loss caused by a per-user view. The subscribed
 * models keep the dropped order; members the pane does not show follow.
 */
export function mergeGroupMembership(orderedSubscribed: number[], full: number[]): number[] {
  const seen = new Set(orderedSubscribed);
  return [...orderedSubscribed, ...full.filter((id) => !seen.has(id))];
}

export type SharedDragPlan = {
  groupOrder?: number[];
  setMembers?: { groupID: number; typeIDs: number[] };
  detachFrom?: number;
};

export function sharedDragPlan<T>(
  source: { type: 'group'; groupKey: string } | { type: 'item'; groupKey: string; itemID: number },
  next: DragSlot<T>[],
  getID: (item: T) => number,
): SharedDragPlan {
  if (source.type === 'group') {
    return {
      groupOrder: next.map((slot) => groupIDFromSlotKey(slot.key)).filter((id): id is number => id != null),
    };
  }

  const target = slotOfItem(next, source.itemID, getID);
  if (!target) return {};
  const targetGroupID = groupIDFromSlotKey(target.key);
  if (targetGroupID != null) {
    return { setMembers: { groupID: targetGroupID, typeIDs: target.items.map(getID) } };
  }
  return { detachFrom: groupIDFromSlotKey(source.groupKey) ?? undefined };
}
