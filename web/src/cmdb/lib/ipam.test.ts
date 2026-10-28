import { describe, expect, it } from 'vitest';

import type { IPAMNode } from '../api/ipam';
import {
  addressFromRow,
  applySelection,
  cidrHostCount,
  containsIP,
  derivedStatus,
  findSubnetForIP,
  hostsOf,
  mergeAddresses,
  nodeLabel,
  parseCIDR,
  scanDuration,
  scopesOf,
} from './ipam';

describe('CIDR arithmetic', () => {
  it('normalises a range and counts its usable hosts without enumerating', () => {
    const range = parseCIDR('10.0.0.0/24');
    expect(range?.network).toBe(167772160);
    expect(range?.hostCount).toBe(254);
    expect(cidrHostCount('10.0.0.0/24')).toBe(254);
    expect(cidrHostCount('10.0.0.0/31')).toBe(2);
    expect(cidrHostCount('nonsense')).toBe(0);
  });

  it('lists only the requested window', () => {
    expect(hostsOf('10.0.0.0/29')).toEqual([
      '10.0.0.1',
      '10.0.0.2',
      '10.0.0.3',
      '10.0.0.4',
      '10.0.0.5',
      '10.0.0.6',
    ]);
    expect(hostsOf('10.0.0.0/24', 3)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('tests containment against the network, not a string prefix', () => {
    expect(containsIP('10.0.0.0/24', '10.0.0.255')).toBe(true);
    expect(containsIP('10.0.0.0/24', '10.0.1.1')).toBe(false);
  });

  it('derives the /24 groups of a wider range without materialising hosts', () => {
    expect(scopesOf('10.0.0.0/24')).toEqual(['10.0.0']);
    expect(scopesOf('10.0.0.0/23')).toEqual(['10.0.0', '10.0.1']);
    expect(scopesOf('10.0.0.0/22')).toEqual(['10.0.0', '10.0.1', '10.0.2', '10.0.3']);
  });
});

describe('the derived address state', () => {
  it('combines the stored assignment with the observed flag', () => {
    expect(derivedStatus({ assignStatus: 0, isUsed: true })).toBe('0');
    expect(derivedStatus({ assignStatus: 2, isUsed: true })).toBe('0');
    expect(derivedStatus({ assignStatus: 1, isUsed: true })).toBe('1');
    expect(derivedStatus({ assignStatus: 0, isUsed: false })).toBe('2');
    expect(derivedStatus({ assignStatus: 1, isUsed: false })).toBe('3');
  });

  it('treats a missing status as unassigned, as cantor did', () => {
    const row = addressFromRow({
      _id: 1,
      _type: 2,
      ci_id: 1,
      ci_type: 'ipam_address',
      ip: '10.0.0.1',
    });
    expect(row.assignStatus).toBe(1);
    expect(row.isUsed).toBe(false);
  });
});

describe('selection gestures', () => {
  const ordered = ['a', 'b', 'c', 'd'];

  it('replaces on a plain click, toggles on a modifier, and extends a range on shift', () => {
    const plain = applySelection(new Set(['a']), ordered, 'b', { shift: false, toggle: false, anchor: 'a' });
    expect([...plain.next]).toEqual(['b']);
    expect(plain.anchor).toBe('b');

    const toggle = applySelection(new Set(['a', 'b']), ordered, 'a', { shift: false, toggle: true, anchor: 'a' });
    expect([...toggle.next]).toEqual(['b']);

    const range = applySelection(new Set(), ordered, 'c', { shift: true, toggle: false, anchor: 'a' });
    expect([...range.next]).toEqual(['a', 'b', 'c']);
    expect(range.anchor).toBe('a');
  });

  it('falls back to a plain click when the anchor is not on screen', () => {
    const got = applySelection(new Set(['a']), ordered, 'c', { shift: true, toggle: false, anchor: 'z' });
    expect([...got.next]).toEqual(['c']);
  });
});

describe('the merged address workspace', () => {
  it('synthesises hosts nobody registered, overlays stored rows and keeps rows outside the window', () => {
    const stored = [
      addressFromRow({
        _id: 1,
        _type: 2,
        ci_id: 1,
        ci_type: 'ipam_address',
        ip: '10.0.0.1',
        assign_status: 0,
        is_used: 1,
      }),
      addressFromRow({
        _id: 2,
        _type: 2,
        ci_id: 2,
        ci_type: 'ipam_address',
        ip: '10.0.0.99',
        assign_status: 1,
      }),
    ];
    const got = mergeAddresses(['10.0.0.1', '10.0.0.2'], stored, '10.0.0.0/24', 10);
    expect(got.rows.map((row) => row.ip)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.99']);
    expect(got.rows[1].assignStatus).toBe(1);
    expect(got.rows[0].assignStatus).toBe(0);
    expect(got.totalHosts).toBe(254);
    expect(got.truncated).toBe(true);
  });
});

describe('tree helpers', () => {
  const narrow: IPAMNode = { _id: 1, _type: 12, ci_type: 'ipam_subnet', ci_type_alias: 'subnet', name: 'narrow', cidr: '10.0.1.0/24' };
  const wide: IPAMNode = { _id: 2, _type: 12, ci_type: 'ipam_subnet', ci_type_alias: 'subnet', name: 'wide', cidr: '10.0.0.0/16' };

  it('picks the most specific range for an address', () => {
    expect(findSubnetForIP([wide, narrow], '10.0.1.7')?.name).toBe('narrow');
    expect(findSubnetForIP([wide, narrow], '10.0.2.7')?.name).toBe('wide');
    expect(findSubnetForIP([wide, narrow], '192.168.1.1')).toBeUndefined();
  });

  it('labels a node by the model’s own attribute and falls back to its id', () => {
    expect(nodeLabel(narrow, { '12': 'name' })).toBe('narrow');
    expect(nodeLabel({ ...narrow, name: undefined }, {})).toBe('#1');
  });
});

describe('scan logs', () => {
  it('renders a duration and leaves it blank when either end is missing', () => {
    expect(scanDuration('2026-10-18 03:00:00', '2026-10-18 03:00:11')).toBe('11s');
    expect(scanDuration(undefined, '2026-10-18 03:00:11')).toBe('');
    expect(scanDuration('later', 'earlier')).toBe('');
  });
});
