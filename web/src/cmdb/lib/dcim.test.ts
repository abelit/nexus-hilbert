import { describe, expect, it } from 'vitest';

import type { DCIMTree } from '../api/dcim';
import type { SearchRow } from '../api/instance';
import {
  buildDCIMTree,
  buildRackOccupancy,
  displayRackUnits,
  filterDCIMTree,
  operationKind,
  operationTone,
  rackFieldColumns,
  toRackDevice,
  toRackRow,
  uStartAtDisplayRow,
} from './dcim';

const tree: DCIMTree = {
  result: [
    {
      _id: 1,
      _type: 101,
      ci_type: 'dcim_region',
      ci_type_alias: '区域',
      name: '华北',
      children: [
        {
          _id: 2,
          _type: 102,
          ci_type: 'dcim_idc',
          ci_type_alias: '数据中心',
          name: '亦庄',
          children: [
            {
              _id: 3,
              _type: 103,
              ci_type: 'dcim_server_room',
              ci_type_alias: '机房',
              name: 'A 机房',
              rack_count: 2,
              children: [],
            },
            {
              _id: 4,
              _type: 103,
              ci_type: 'dcim_server_room',
              ci_type_alias: '机房',
              name: 'B 机房',
              rack_count: 3,
              children: [],
            },
          ],
        },
      ],
    },
  ],
  type2name: { '101': 'name', '102': 'name', '103': 'name' },
};

describe('the containment tree', () => {
  it('accumulates rack counts up to the region', () => {
    const got = buildDCIMTree(tree);
    expect(got.rackCounts.get('3')).toBe(2);
    expect(got.rackCounts.get('2')).toBe(5);
    expect(got.rackCounts.get('1')).toBe(5);
    expect(got.label(got.raw.get('3'))).toBe('A 机房');
  });

  it('keeps the ancestors of a search match', () => {
    const got = buildDCIMTree(tree);
    const filtered = filterDCIMTree(got.roots, 'B 机房', got.label);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].children?.[0].children?.[0].name).toBe('B 机房');
  });

  it('labels a node by the attribute its model declares', () => {
    const got = buildDCIMTree({ ...tree, type2name: { ...tree.type2name, '103': 'room_code' } });
    const room = got.raw.get('3') as Record<string, unknown>;
    room.room_code = 'ROOM-A';
    expect(got.label(room as never)).toBe('ROOM-A');
  });
});

describe('a rack row', () => {
  const base: SearchRow = {
    _id: 31,
    _type: 48,
    ci_id: 31,
    ci_type: 'dcim_rack',
    name: 'R-A01',
    u_count: 42,
  };

  it('reads a missing free count as empty, not as full', () => {
    const rack = toRackRow(base);
    expect(rack.freeUCount).toBe(42);
    expect(rack.usedUCount).toBe(0);
    expect(rack.usedRatio).toBe(0);
  });

  it('keeps an oversubscribed rack negative rather than clamping it', () => {
    const rack = toRackRow({ ...base, free_u_count: -8, u_slot_abnormal: true });
    expect(rack.usedUCount).toBe(50);
    expect(rack.freeUCount).toBe(-8);
    expect(rack.abnormal).toBe(true);
  });

  it('uses the rack’s numbering direction when it declares one', () => {
    expect(toRackRow({ ...base, u_numbering_direction: 'top_to_bottom' }).numbering).toBe('top_to_bottom');
    expect(toRackRow(base).numbering).toBe('bottom_to_top');
  });
});

describe('the rack U picture', () => {
  const devices = [
    toRackDevice({ _id: 1, _type: 4, ci_id: 1, ci_type: 'server', name: 'srv-a', u_start: 1, u_count: 2 }),
    toRackDevice({ _id: 2, _type: 4, ci_id: 2, ci_type: 'server', name: 'srv-b', u_start: 4, u_count: 1 }),
  ];

  it('fills the units between devices with gaps', () => {
    const got = buildRackOccupancy(devices, 6);
    expect(got.units.map((unit) => (unit.kind === 'device' ? `d:${unit.device.name}:${unit.unitCount}` : `g:${unit.uStart}`))).toEqual([
      'd:srv-a:2',
      'g:3',
      'd:srv-b:1',
      'g:5',
      'g:6',
    ]);
  });

  it('merges an overlap into the earliest block and records the conflict', () => {
    const overlapping = [
      ...devices,
      toRackDevice({ _id: 3, _type: 4, ci_id: 3, ci_type: 'server', name: 'srv-c', u_start: 4, u_count: 2 }),
    ];
    const got = buildRackOccupancy(overlapping, 6);
    const block = got.units.find((unit) => unit.kind === 'device' && unit.device.name === 'srv-b');
    expect(block?.kind).toBe('device');
    if (block?.kind === 'device') {
      expect(block.abnormal).toBe(true);
      expect(block.conflicts.map((device) => device.name)).toEqual(['srv-c']);
    }
    expect(got.unplaced).toHaveLength(0);
  });

  it('clips a device that runs past the top and reports it as out of bounds', () => {
    const got = buildRackOccupancy(
      [toRackDevice({ _id: 7, _type: 4, ci_id: 7, ci_type: 'server', name: 'tall', u_start: 5, u_count: 4 })],
      6,
    );
    const block = got.units.find((unit) => unit.kind === 'device');
    expect(block?.kind).toBe('device');
    if (block?.kind === 'device') {
      expect(block.unitCount).toBe(2);
      expect(block.outOfBounds).toBe(true);
      expect(block.abnormal).toBe(true);
    }
  });

  it('keeps devices with no position out of the drawing', () => {
    const got = buildRackOccupancy(
      [toRackDevice({ _id: 8, _type: 4, ci_id: 8, ci_type: 'server', name: 'unplaced' })],
      6,
    );
    expect(got.units.every((unit) => unit.kind === 'gap')).toBe(true);
    expect(got.unplaced.map((device) => device.name)).toEqual(['unplaced']);
  });

  it('draws bottom-to-top racks from the top down', () => {
    const got = buildRackOccupancy(devices, 6);
    expect(displayRackUnits(got.units, 'bottom_to_top')[0].uStart).toBe(6);
    expect(displayRackUnits(got.units, 'top_to_bottom')[0].uStart).toBe(1);
    expect(uStartAtDisplayRow(0, 6, 'bottom_to_top')).toBe(6);
    expect(uStartAtDisplayRow(0, 6, 'top_to_bottom')).toBe(1);
  });
});

describe('operation labels', () => {
  it('maps the stored codes, defaulting anything unknown to move', () => {
    expect(operationKind('0')).toBe('0');
    expect(operationKind('1')).toBe('1');
    expect(operationKind('2')).toBe('2');
    expect(operationKind('add')).toBe('2');
    expect(operationTone('0')).toBe('success');
    expect(operationTone('1')).toBe('danger');
    expect(operationTone('2')).toBe('warning');
  });
});

describe('rack columns', () => {
  const attributes = [
    { id: 1, name: 'name', alias: '名称', default_show: true },
    { id: 2, name: 'u_count', alias: 'U 数', default_show: true },
    { id: 3, name: 'rack_type', alias: '类型', default_show: true },
  ] as never[];

  it('honours the subscription before falling back', () => {
    expect(rackFieldColumns(attributes, [{ attr_id: 3 }], 'name').map((attribute) => attribute.name)).toEqual(['rack_type']);
    expect(rackFieldColumns(attributes, [], 'name').map((attribute) => attribute.name)).toEqual(['name', 'u_count', 'rack_type']);
  });
});
