import type { Attribute, TypeAttribute } from '../api/citype';
import type { DCIMNode, DCIMTree } from '../api/dcim';
import type { SearchRow } from '../api/instance';
import { choiceText } from './choice-labels';
import { displayValue, isEmptyValue } from './valuetype';

// The data centre's arithmetic, kept out of its components.
//
// THE SERVER OWNS CAPACITY. `free_u_count` is recomputed in the transaction
// that changes a rack's contents; this file only turns the number the server
// returned into the view an operator reads. The one thing it derives itself is
// the OCCUPANCY PICTURE — which U is covered by which device, and which devices
// overlap — because that is a property of the rows already on the screen and
// asking the server for it would add a second source of truth.

/** The four levels, outermost first. Racks hang under rooms but are not a tree level. */
export type DCIMType = 'region' | 'idc' | 'server_room' | 'rack';

export const DCIM_TYPE_NAME: Record<DCIMType, string> = {
  region: 'dcim_region',
  idc: 'dcim_idc',
  server_room: 'dcim_server_room',
  rack: 'dcim_rack',
};

export const DCIM_TYPE_LABEL: Record<DCIMType, [string, string]> = {
  region: ['区域', 'Region'],
  idc: ['数据中心', 'Data centre'],
  server_room: ['机房', 'Room'],
  rack: ['机柜', 'Rack'],
};

/** The one level a node can contain. A room's racks are created from the room page. */
export const DCIM_CHILD_TYPE: Partial<Record<DCIMType, DCIMType>> = {
  region: 'idc',
  idc: 'server_room',
};

/** The short type a node's own model name stands for. */
export function dcimTypeOf(node: Pick<DCIMNode, 'ci_type'>): DCIMType | null {
  const name = node.ci_type?.replace(/^dcim_/, '');
  return name === 'region' || name === 'idc' || name === 'server_room' || name === 'rack'
    ? (name as DCIMType)
    : null;
}

// --- the tree ---

export type DCIMTreeState = {
  roots: DCIMNode[];
  raw: Map<string, DCIMNode>;
  parentOf: Map<string, string>;
  type2name: Record<string, string>;
  label(node: DCIMNode | null | undefined): string;
  /** Every node in the tree, in render order. */
  flat: DCIMNode[];
  /** room id → rack count, including the counts of nested rooms. */
  rackCounts: Map<string, number>;
};

export const EMPTY_DCIM_TREE: DCIMTreeState = {
  roots: [],
  raw: new Map(),
  parentOf: new Map(),
  type2name: {},
  label: () => '',
  flat: [],
  rackCounts: new Map(),
};

export function dcimNodeLabel(node: DCIMNode, type2name: Record<string, string>): string {
  const key = type2name[String(node._type)];
  const value = key ? node[key] : undefined;
  const fallback = node.name ?? node.alias ?? node.unique ?? node.code;
  return displayValue(value ?? fallback ?? `#${node._id}`);
}

export function buildDCIMTree(got: DCIMTree): DCIMTreeState {
  const raw = new Map<string, DCIMNode>();
  const parentOf = new Map<string, string>();
  const flat: DCIMNode[] = [];
  const walk = (node: DCIMNode, parent: string | null) => {
    raw.set(String(node._id), node);
    flat.push(node);
    if (parent !== null) parentOf.set(String(node._id), parent);
    for (const child of node.children ?? []) walk(child, String(node._id));
  };
  for (const root of got.result ?? []) walk(root, null);

  const type2name = got.type2name ?? {};
  const rackCounts = new Map<string, number>();
  for (const node of flat) {
    if (node.ci_type === 'dcim_server_room') rackCounts.set(String(node._id), Number(node.rack_count ?? 0));
  }
  // A region and an IDC show how many racks hang below them; the room's own
  // count is the leaf value, so summing upwards is one pass over the parents.
  for (const node of [...flat].reverse()) {
    if (node.ci_type === 'dcim_server_room') continue;
    let total = 0;
    for (const child of node.children ?? []) total += rackCounts.get(String(child._id)) ?? 0;
    rackCounts.set(String(node._id), total);
  }

  return {
    roots: got.result ?? [],
    raw,
    parentOf,
    type2name,
    label: (node) => (node ? dcimNodeLabel(node, type2name) : ''),
    flat,
    rackCounts,
  };
}

export function findDCIMNode(tree: DCIMTreeState, id: string | number | null | undefined): DCIMNode | null {
  if (id == null || id === '') return null;
  return tree.raw.get(String(id)) ?? null;
}

/** The node's ancestor ids, root first. */
export function collectDCIMAncestors(tree: DCIMTreeState, id: string | number): string[] {
  const out: string[] = [];
  let current = tree.parentOf.get(String(id));
  while (current && out.length < 32) {
    out.unshift(current);
    current = tree.parentOf.get(current);
  }
  return out;
}

/** Filters by label, keeping the ancestors of a match so the chain stays visible. */
export function filterDCIMTree(roots: DCIMNode[], needle: string, label: (node: DCIMNode) => string): DCIMNode[] {
  const query = needle.trim().toLowerCase();
  if (!query) return roots;
  return roots.flatMap((node) => {
    const children = filterDCIMTree(node.children ?? [], query, label);
    return label(node).toLowerCase().includes(query) || children.length > 0
      ? [{ ...node, children }]
      : [];
  });
}

/** The room a rack hangs under, walking the containment edges. */
export function roomOfRack(tree: DCIMTreeState, rackID: number): number | null {
  let current = tree.parentOf.get(String(rackID));
  for (let guard = 0; guard < 16 && current; guard += 1) {
    const node = tree.raw.get(current);
    if (!node) break;
    if (node.ci_type === 'dcim_server_room') return node._id;
    current = tree.parentOf.get(current);
  }
  return null;
}

// --- racks ---

export type RackNumbering = 'bottom_to_top' | 'top_to_bottom';

export type RackRow = {
  id: number;
  row: SearchRow;
  name: string;
  uCount: number;
  freeUCount: number;
  usedUCount: number;
  usedRatio: number;
  abnormal: boolean;
  numbering: RackNumbering;
  rackType?: string;
  rackStatus?: string;
};

function whole(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export function rackDisplayName(row: SearchRow, nameKey?: string): string {
  const keys = [nameKey, 'name', 'rack_name', 'alias'];
  for (const key of keys) {
    if (!key) continue;
    const value = row[key];
    if (!isEmptyValue(value)) return displayValue(value);
  }
  return `#${row._id}`;
}

/**
 * One rack row.
 *
 * A MISSING FREE COUNT IS READ AS EMPTY, not as full. The number is maintained
 * by placement operations, so a rack nothing has ever touched has none; the
 * backend's room summary makes the same choice, and the recompute button is the
 * repair for a rack that has devices but no number.
 */
export function toRackRow(row: SearchRow, nameKey?: string): RackRow {
  const uCount = Math.max(0, whole(row.u_count) ?? 0);
  const recordedFree = whole(row.free_u_count);
  const freeUCount = recordedFree ?? uCount;
  const usedUCount = uCount - freeUCount;
  const usedRatio = uCount > 0 ? Math.round((usedUCount / uCount) * 100) : 0;
  const direction = row.u_numbering_direction === 'top_to_bottom' ? 'top_to_bottom' : 'bottom_to_top';
  return {
    id: Number(row._id),
    row,
    name: rackDisplayName(row, nameKey),
    uCount,
    freeUCount,
    usedUCount,
    usedRatio,
    abnormal: row.u_slot_abnormal === true || row.u_slot_abnormal === 1 || row.u_slot_abnormal === '1',
    numbering: direction,
    rackType: isEmptyValue(row.rack_type) ? undefined : displayValue(row.rack_type),
    rackStatus: isEmptyValue(row.rack_status) ? undefined : displayValue(row.rack_status),
  };
}

export type RackCounters = {
  rackCount: number;
  uCount: number;
  usedUCount: number;
  deviceCount: number;
};

export function rackCounters(counter: Record<string, unknown> | undefined, racks: RackRow[]): RackCounters {
  const number = (value: unknown) => {
    const n = whole(value);
    return n != null && n >= 0 ? n : 0;
  };
  if (counter && Object.keys(counter).length > 0) {
    return {
      rackCount: number(counter.rack_count),
      uCount: number(counter.u_count),
      usedUCount: number(counter.u_used_count),
      deviceCount: number(counter.device_count),
    };
  }
  return {
    rackCount: racks.length,
    uCount: racks.reduce((sum, rack) => sum + rack.uCount, 0),
    usedUCount: racks.reduce((sum, rack) => sum + rack.usedUCount, 0),
    // The server's counter is the only source for this; a fallback would be a
    // made-up number, so it stays zero.
    deviceCount: 0,
  };
}

// --- a rack's contents ---

export type RackDevice = {
  id: number;
  row: SearchRow;
  name: string;
  typeID: number;
  typeName: string;
  typeAlias: string;
  uStart: number | null;
  uCount: number;
};

export function deviceDisplayName(row: SearchRow, showKey?: string): string {
  const keys = [showKey, 'name', 'hostname', 'alias', 'unique'];
  for (const key of keys) {
    if (!key) continue;
    const value = row[key];
    if (!isEmptyValue(value)) return displayValue(value);
  }
  return `#${row._id}`;
}

export function toRackDevice(row: SearchRow, showKey?: string): RackDevice {
  const start = whole(row.u_start);
  return {
    id: Number(row._id),
    row,
    name: deviceDisplayName(row, showKey),
    typeID: Number(row._type ?? 0),
    typeName: String(row.ci_type ?? ''),
    typeAlias: String(row.ci_type_alias ?? row.ci_type ?? ''),
    uStart: start != null && start >= 1 ? start : null,
    uCount: Math.max(1, whole(row.u_count) ?? 2),
  };
}

export type RackDeviceUnit = {
  kind: 'device';
  key: string;
  uStart: number;
  /** Units the block covers inside the rack; clipped when it runs past the top. */
  unitCount: number;
  /** The device's declared height, which may be larger than `unitCount`. */
  declaredUnitCount: number;
  device: RackDevice;
  abnormal: boolean;
  outOfBounds: boolean;
  conflicts: RackDevice[];
};

export type RackGapUnit = {
  kind: 'gap';
  key: string;
  uStart: number;
};

export type RackUnit = RackDeviceUnit | RackGapUnit;

export type RackOccupancy = {
  units: RackUnit[];
  /** Devices whose position is absent or outside the rack; they cannot be drawn. */
  unplaced: RackDevice[];
};

/**
 * The physical U picture, ascending (U1 first).
 *
 * OVERLAPS ARE MERGED INTO THE EARLIEST BLOCK, which is what cantor's view did:
 * two devices claiming U10 cannot both be drawn at U10, so the block at U10
 * grows to cover both and records the other device as a conflict. The abnormal
 * dialog then lets the operator pick which one to move. Clipping a block that
 * runs past the top keeps the rack frame honest; the device stays in the
 * conflict/unplaced list rather than silently disappearing.
 */
export function buildRackOccupancy(devices: RackDevice[], uCount: number): RackOccupancy {
  const height = Math.max(0, Math.trunc(uCount));
  if (height === 0) return { units: [], unplaced: [...devices] };

  const placed = devices
    .filter((device) => device.uStart != null && device.uStart >= 1)
    .slice()
    .sort((a, b) => (a.uStart as number) - (b.uStart as number) || a.id - b.id);

  type Block = {
    device: RackDevice;
    start: number;
    span: number;
    conflicts: RackDevice[];
    abnormal: boolean;
    outOfBounds: boolean;
    rendered: boolean;
  };
  const blocks: Block[] = [];
  const byStart = new Map<number, Block>();

  for (const device of placed) {
    const start = device.uStart as number;
    const host = blocks.find((block) => start >= block.start && start <= block.start + block.span - 1);
    if (host) {
      host.abnormal = true;
      host.conflicts.push(device);
      host.span = Math.max(host.span, start + device.uCount - host.start);
      if (host.start + host.span - 1 > height) host.outOfBounds = true;
      continue;
    }
    const outOfBounds = start + device.uCount - 1 > height;
    const block: Block = {
      device,
      start,
      span: device.uCount,
      conflicts: [],
      abnormal: outOfBounds,
      outOfBounds,
      rendered: start <= height,
    };
    blocks.push(block);
    if (block.rendered) byStart.set(start, block);
  }

  const units: RackUnit[] = [];
  let u = 1;
  while (u <= height) {
    const block = byStart.get(u);
    if (block) {
      const visible = Math.min(block.span, height - u + 1);
      units.push({
        kind: 'device',
        key: `device-${block.device.id}-${u}`,
        uStart: u,
        unitCount: visible,
        declaredUnitCount: block.span,
        device: block.device,
        abnormal: block.abnormal,
        outOfBounds: block.outOfBounds,
        conflicts: block.conflicts,
      });
      // Advance by the DECLARED span, not the clipped one: the units past the
      // top do not exist, so the walk ends either way, and using the span keeps
      // a later gap from appearing inside an overlapped block.
      u += Math.max(1, block.span);
    } else {
      units.push({ kind: 'gap', key: `gap-${u}`, uStart: u });
      u += 1;
    }
  }

  const attached = new Set<number>();
  for (const block of blocks) {
    attached.add(block.device.id);
    for (const conflict of block.conflicts) attached.add(conflict.id);
  }
  const unplaced = devices.filter((device) => !attached.has(device.id));

  return { units, unplaced };
}

/** Display order: top to bottom for a normal rack, or its reverse. */
export function displayRackUnits(units: RackUnit[], numbering: RackNumbering): RackUnit[] {
  return numbering === 'bottom_to_top' ? [...units].reverse() : units;
}

/** The absolute U number at a row counted from the top of the view. */
export function uStartAtDisplayRow(row: number, uCount: number, numbering: RackNumbering): number {
  return numbering === 'top_to_bottom' ? row + 1 : uCount - row;
}

// --- operation log ---

export type OperationKind = '0' | '1' | '2';

export const DCIM_OPERATIONS: Array<{ value: OperationKind; zh: string; en: string }> = [
  { value: '0', zh: '上架', en: 'Added' },
  { value: '1', zh: '下架', en: 'Removed' },
  { value: '2', zh: '移动', en: 'Moved' },
];

export function operationKind(raw: unknown): OperationKind {
  return raw === '0' || raw === '1' ? raw : '2';
}

export function operationTone(raw: unknown): 'success' | 'danger' | 'warning' {
  const kind = operationKind(raw);
  return kind === '0' ? 'success' : kind === '1' ? 'danger' : 'warning';
}

// --- attributes on a rack/device ---

export function attributeLabel(attribute: Pick<Attribute, 'alias' | 'name'>): string {
  return attribute.alias?.trim() || attribute.name;
}

export function attributeDisplay(attribute: Pick<TypeAttribute, 'is_choice' | 'choice_value'>, value: unknown): string {
  if (isEmptyValue(value)) return '—';
  const choice = choiceText(attribute, value);
  if (choice) return choice;
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).join(', ');
  return displayValue(value);
}

/** A model's preference columns, falling back to its displayed attributes. */
export function rackFieldColumns(
  attributes: TypeAttribute[],
  fields: Array<{ attr_id?: number; name?: string }>,
  uniqueKey?: string,
): TypeAttribute[] {
  const byID = new Map(attributes.map((attribute) => [attribute.id, attribute]));
  const chosen = fields
    .map((field) => (field.attr_id ? byID.get(field.attr_id) : undefined))
    .filter((attribute): attribute is TypeAttribute => Boolean(attribute));
  if (chosen.length > 0) return chosen;
  const fallback = attributes.filter((attribute) => attribute.default_show && !attribute.is_password);
  if (fallback.length > 0) return fallback.slice(0, 5);
  return attributes
    .filter((attribute) => attribute.name === uniqueKey || attribute.name === 'name')
    .concat(attributes.filter((attribute) => attribute.name !== uniqueKey && attribute.name !== 'name').slice(0, 4));
}
