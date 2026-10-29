import { describe, expect, it } from 'vitest';

import {
  flattenSlotIDs,
  groupIDFromSlotKey,
  groupSlotKey,
  mergeGroupMembership,
  moveItemBetweenGroups,
  reorderSlots,
  sharedDragPlan,
  slotOfItem,
  type DragSlot,
} from './group-drag';

type Item = { id: number };
const getID = (item: Item) => item.id;

const a: Item = { id: 1 };
const b: Item = { id: 2 };
const c: Item = { id: 3 };

const slots: DragSlot<Item>[] = [
  { key: 'g:10', items: [a, b] },
  { key: 'g:11', items: [c] },
  { key: 'other', items: [] },
];

describe('group drag helpers', () => {
  it('maps group ids to stable slot keys', () => {
    expect(groupSlotKey({ id: 10 })).toBe('g:10');
    expect(groupSlotKey({ id: null })).toBe('other');
    expect(groupIDFromSlotKey('g:10')).toBe(10);
    expect(groupIDFromSlotKey('other')).toBeNull();
  });

  it('reorders groups without touching their models', () => {
    const next = reorderSlots(slots, 'g:11', 'g:10');
    expect(next.map((slot) => slot.key)).toEqual(['g:11', 'g:10', 'other']);
    expect(next[0].items).toEqual([c]);
  });

  it('moves a model within a group', () => {
    const next = moveItemBetweenGroups(slots, 'g:10', 'g:10', a.id, 1, getID);
    expect(next[0].items.map(getID)).toEqual([2, 1]);
    expect(next[1].items.map(getID)).toEqual([3]);
  });

  it('moves a model across groups and clamps the drop index', () => {
    const next = moveItemBetweenGroups(slots, 'g:10', 'g:11', b.id, 99, getID);
    expect(next[0].items.map(getID)).toEqual([1]);
    expect(next[1].items.map(getID)).toEqual([3, 2]);
    expect(slotOfItem(next, b.id, getID)?.key).toBe('g:11');
    expect(flattenSlotIDs(next, getID)).toEqual([1, 3, 2]);
  });

  it('keeps unsubscribed members when merging the subscription order', () => {
    // 5 is a group member the operator has not subscribed to; the write must
    // not remove it just because the subscription pane cannot see it.
    expect(mergeGroupMembership([2, 1, 4], [1, 2, 3, 4, 5])).toEqual([2, 1, 4, 3, 5]);
    expect(mergeGroupMembership([1], [])).toEqual([1]);
  });

  it('is a no-op for an unknown item or slot', () => {
    expect(moveItemBetweenGroups(slots, 'g:10', 'g:11', 99, 0, getID)).toBe(slots);
    expect(moveItemBetweenGroups(slots, 'nope', 'g:11', 1, 0, getID)).toBe(slots);
  });
});

describe('the shared model-config plan', () => {
  it('writes the full real-group order for a group drag', () => {
    expect(sharedDragPlan({ type: 'group', groupKey: 'g:10' }, slots, getID)).toEqual({
      groupOrder: [10, 11],
    });
  });

  it('rewrites a group membership for an in-group move', () => {
    const next = moveItemBetweenGroups(slots, 'g:10', 'g:10', a.id, 1, getID);
    expect(sharedDragPlan({ type: 'item', groupKey: 'g:10', itemID: a.id }, next, getID)).toEqual({
      setMembers: { groupID: 10, typeIDs: [2, 1] },
    });
  });

  it('writes the target group for a cross-group move', () => {
    const next = moveItemBetweenGroups(slots, 'g:10', 'g:11', b.id, 0, getID);
    expect(sharedDragPlan({ type: 'item', groupKey: 'g:10', itemID: b.id }, next, getID)).toEqual({
      setMembers: { groupID: 11, typeIDs: [2, 3] },
    });
  });

  it('detaches from the source group when the target is 其他', () => {
    const next = moveItemBetweenGroups(slots, 'g:10', 'other', a.id, 0, getID);
    expect(sharedDragPlan({ type: 'item', groupKey: 'g:10', itemID: a.id }, next, getID)).toEqual({
      detachFrom: 10,
    });
  });

  it('has nothing to persist for a model moved inside 其他', () => {
    const otherOnly: DragSlot<Item>[] = [{ key: 'other', items: [a, b] }];
    const next = moveItemBetweenGroups(otherOnly, 'other', 'other', a.id, 1, getID);
    expect(sharedDragPlan({ type: 'item', groupKey: 'other', itemID: a.id }, next, getID)).toEqual({});
  });
});
