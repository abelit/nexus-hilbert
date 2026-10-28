// IPAM's arithmetic and state vocabulary, kept out of the page.
//
// THE PAGE MUST NOT ENUMERATE A RANGE. cantor built one string per host to
// draw a count badge, which a /8 turns into sixteen million strings. Counts and
// ranges here are numbers; only a page of hosts is ever materialised.

import type { SearchRow } from '../api/instance';
import type { IPAMNode } from '../api/ipam';

export type DerivedStatus = '0' | '1' | '2' | '3';

export type AddressRecord = {
  id: number;
  ciID: number;
  ip: string;
  assignStatus: number;
  isUsed: boolean;
  name?: string;
  description?: string;
  usage?: string;
  useObj?: string;
  macAddress?: string;
  gateway?: string;
  subnetMask?: string;
  updatedAt?: string;
};

export type SubnetRow = {
  id: number;
  name: string;
  cidr: string;
  hostsCount: number;
  assignCount: number;
  usedCount: number;
  freeCount: number;
  scanEnabled: boolean;
  lastScanTime: string | null;
};

type CIDR = {
  cidr: string;
  prefix: number;
  network: number;
  broadcast: number;
  hostCount: number;
};

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export function parseCIDR(raw: unknown): CIDR | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const match = CIDR_RE.exec(text);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix < 8 || prefix > 31) return null;
  const base =
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (base & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const bits = 32 - prefix;
  return {
    cidr: `${ipFromNumber(network)}/${prefix}`,
    prefix,
    network,
    broadcast,
    // A /31 and /32 have no reserved network/broadcast pair.
    hostCount: bits <= 1 ? 1 << bits : 2 ** bits - 2,
  };
}

export function cidrHostCount(raw: unknown): number {
  return parseCIDR(raw)?.hostCount ?? 0;
}

export function ipToNumber(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

export function ipFromNumber(value: number): string {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

export function containsIP(rawCIDR: unknown, rawIP: unknown): boolean {
  const range = parseCIDR(rawCIDR);
  const ip = ipToNumber(rawIP);
  return Boolean(range && ip != null && ip >= range.network && ip <= range.broadcast);
}

/** The addresses a range holds, in ascending order, bounded by `limit`. */
export function hostsOf(cidr: unknown, limit = 256): string[] {
  const range = parseCIDR(cidr);
  if (!range) return [];
  const bits = 32 - range.prefix;
  const first = bits <= 1 ? range.network : range.network + 1;
  const last = bits <= 1 ? range.broadcast : range.broadcast - 1;
  const out: string[] = [];
  for (let value = first; value <= last && out.length < limit; value += 1) {
    out.push(ipFromNumber(value));
  }
  return out;
}

/**
 * The /24 groups a range spans, as first-three-octet prefixes. A range of /24
 * or narrower has one group and the filter is not worth showing; the page only
 * offers it when this returns more than one.
 */
export function scopesOf(cidr: unknown): string[] {
  const range = parseCIDR(cidr);
  if (!range) return [];
  if (range.prefix >= 24) return [ipFromNumber(range.network).split('.').slice(0, 3).join('.')];
  const first = range.network >>> 8;
  const last = range.broadcast >>> 8;
  const out: string[] = [];
  // A /8 would be 65536 groups; the select is bounded for the same reason the
  // host list is.
  for (let value = first; value <= last && out.length < 256; value += 1) {
    out.push(`${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
  }
  return out;
}

export function isSubnet(node: IPAMNode | null | undefined): boolean {
  return Boolean(node && (node.cidr !== undefined || node.ci_type === 'ipam_subnet'));
}

export function derivedStatus(row: Pick<AddressRecord, 'assignStatus' | 'isUsed'>): DerivedStatus {
  const assigned = row.assignStatus === 0 || row.assignStatus === 2;
  if (row.isUsed) return assigned ? '0' : '1';
  return assigned ? '2' : '3';
}

export function derivedStatusLabel(
  status: DerivedStatus,
  tr: (zh: string, en: string) => string,
): string {
  switch (status) {
    case '0':
      return tr('已分配&在线', 'Assigned & online');
    case '1':
      return tr('未分配&在线', 'Unassigned & online');
    case '2':
      return tr('已分配&离线', 'Assigned & offline');
    default:
      return tr('未使用', 'Unused');
  }
}

export function derivedStatusTone(
  status: DerivedStatus,
): 'success' | 'warning' | 'info' | 'default' {
  switch (status) {
    case '0':
      return 'success';
    case '1':
      return 'warning';
    case '2':
      return 'info';
    default:
      return 'default';
  }
}

export function assignStatusLabel(
  status: number,
  tr: (zh: string, en: string) => string,
): string {
  if (status === 0) return tr('已分配', 'Assigned');
  if (status === 1) return tr('未分配', 'Unassigned');
  if (status === 2) return tr('保留', 'Reserved');
  return String(status);
}

export function isTruthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes';
  }
  return false;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** One search row, in the shape the workspace edits. */
export function addressFromRow(row: SearchRow): AddressRecord {
  const rawStatus = Number(row.assign_status);
  return {
    id: Number(row._id),
    ciID: Number(row.ci_id ?? row._id),
    ip: String(row.ip ?? ''),
    // A missing status is cantor's unassigned, which is also what an address a
    // scanner has seen but nobody has claimed reports.
    assignStatus: Number.isFinite(rawStatus) && rawStatus >= 0 ? rawStatus : 1,
    isUsed: isTruthy(row.is_used),
    name: text(row.name),
    description: text(row.description),
    usage: text(row.usage),
    useObj: text(row.use_obj),
    macAddress: text(row.mac_address),
    gateway: text(row.gateway),
    subnetMask: text(row.subnet_mask),
    updatedAt: text(row._updated_at),
  };
}

export type AddressBundle = {
  rows: AddressRecord[];
  /** Whether the range holds more hosts than the window below. */
  truncated: boolean;
  totalHosts: number;
};

/**
 * Overlays stored address rows on the range's host list.
 *
 * A HOST WITH NO ROW IS UNUSED, which is what makes the workspace show the
 * whole range rather than only the addresses somebody has touched. Rows whose
 * address sits outside the returned host window are appended rather than
 * dropped — the window is a page size, not a boundary.
 */
export function mergeAddresses(
  hosts: string[],
  rows: AddressRecord[],
  cidr: string,
  limit: number,
): AddressBundle {
  const totalHosts = cidrHostCount(cidr);
  const byIP = new Map<string, AddressRecord>();
  for (const row of rows) {
    if (row.ip) byIP.set(row.ip, row);
  }
  const out: AddressRecord[] = [];
  const seen = new Set<string>();
  for (const ip of hosts) {
    seen.add(ip);
    out.push(byIP.get(ip) ?? { id: 0, ciID: 0, ip, assignStatus: 1, isUsed: false });
  }
  for (const row of rows) {
    if (row.ip && !seen.has(row.ip)) {
      seen.add(row.ip);
      out.push(row);
    }
  }
  out.sort((left, right) => (ipToNumber(left.ip) ?? 0) - (ipToNumber(right.ip) ?? 0));
  return {
    rows: out.slice(0, Math.max(limit, hosts.length + rows.length)),
    truncated: totalHosts > hosts.length || rows.length > limit,
    totalHosts,
  };
}

export type SelectionResult = { next: Set<string>; anchor: string };

/**
 * One click on an address, resolved against the rows the operator can see.
 * A shift range is an inclusive slice of `ordered`; a toggle adds or removes;
 * a plain click replaces. The anchor survives a shift so a second shift-click
 * resizes the range instead of starting a new one.
 */
export function applySelection(
  current: ReadonlySet<string>,
  ordered: string[],
  target: string,
  gesture: { shift: boolean; toggle: boolean; anchor: string | null },
): SelectionResult {
  if (gesture.shift && gesture.anchor) {
    const from = ordered.indexOf(gesture.anchor);
    const to = ordered.indexOf(target);
    if (from !== -1 && to !== -1) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      const next = new Set(current);
      for (let index = start; index <= end; index += 1) next.add(ordered[index]);
      return { next, anchor: gesture.anchor };
    }
  }
  if (gesture.toggle) {
    const next = new Set(current);
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return { next, anchor: target };
  }
  return { next: new Set([target]), anchor: target };
}

export function operationLabel(
  kind: string,
  tr: (zh: string, en: string) => string,
): string {
  switch (kind) {
    case '0':
      return tr('新建分组', 'Group created');
    case '1':
      return tr('修改分组', 'Group updated');
    case '2':
      return tr('删除分组', 'Group deleted');
    case '3':
      return tr('新建网段', 'Range created');
    case '4':
      return tr('修改网段', 'Range updated');
    case '5':
      return tr('删除网段', 'Range deleted');
    case '6':
      return tr('分配地址', 'Address assigned');
    case '7':
      return tr('回收地址', 'Address recycled');
    case '8':
      return tr('移动网段', 'Range moved');
    default:
      return kind;
  }
}

export function operationTone(
  kind: string,
): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  switch (kind) {
    case '0':
    case '3':
    case '6':
      return 'success';
    case '1':
    case '4':
    case '8':
      return 'info';
    case '2':
    case '5':
      return 'danger';
    case '7':
      return 'warning';
    default:
      return 'default';
  }
}

export function scanStatusLabel(
  status: number,
  tr: (zh: string, en: string) => string,
): string {
  return status === 0 ? tr('成功', 'Succeeded') : tr('失败', 'Failed');
}

/** `12s` for a completed scan, blank when either end is missing. */
export function scanDuration(start?: string | null, end?: string | null): string {
  if (!start || !end) return '';
  const from = new Date(start.replace(' ', 'T')).getTime();
  const to = new Date(end.replace(' ', 'T')).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '';
  return `${Math.max(1, Math.round((to - from) / 1000))}s`;
}

/**
 * The most specific subnet that holds an address. Used by the global IP search,
 * whose rows do not carry the containment edge.
 */
export function findSubnetForIP<T extends { cidr?: string }>(subnets: T[], ip: string): T | undefined {
  const value = ipToNumber(ip);
  if (value == null) return undefined;
  let best: T | undefined;
  let bestPrefix = 0;
  for (const subnet of subnets) {
    const range = parseCIDR(subnet.cidr);
    if (!range || value < range.network || value > range.broadcast) continue;
    if (range.prefix > bestPrefix) {
      best = subnet;
      bestPrefix = range.prefix;
    }
  }
  return best;
}

/** The host count under a tree node, without materialising a range. */
export function subtreeHostCount(node: IPAMNode | null | undefined): number {
  if (!node) return 0;
  if (isSubnet(node)) return cidrHostCount(node.cidr);
  return (node.children ?? []).reduce((total, child) => total + subtreeHostCount(child), 0);
}

/** A node's children, flat, in tree order. */
export function flattenTree(nodes: IPAMNode[]): IPAMNode[] {
  const out: IPAMNode[] = [];
  const walk = (items: IPAMNode[]) => {
    for (const node of items) {
      out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function nodeLabel(node: IPAMNode | null | undefined, type2name: Record<string, string>): string {
  if (!node) return '';
  const attribute = type2name[String(node._type)] ?? 'name';
  const value = node[attribute];
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof node.name === 'string' && node.name.trim()) return node.name;
  return `#${node._id}`;
}

export function toSubnetRow(row: Record<string, unknown>, nameKey = 'name'): SubnetRow {
  const number = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    id: Number(row._id),
    // A model may name its identifying attribute `subnet_name`; the search row
    // then carries that key rather than `name`.
    name: text(row[nameKey]) ?? text(row.name) ?? text(row.unique) ?? `#${row._id}`,
    cidr: text(row.cidr) ?? '',
    hostsCount: number(row.hosts_count),
    assignCount: number(row.assign_count),
    usedCount: number(row.used_count),
    freeCount: number(row.free_count),
    scanEnabled: isTruthy(row.scan_enabled),
    lastScanTime: text(row.last_scan_time) ?? null,
  };
}
