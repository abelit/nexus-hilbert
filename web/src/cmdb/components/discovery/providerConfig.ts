// Helpers for the target's provider-specific settings.
//
// EXTRA_OPTION IS AN OPEN BAG, and the read path strips its credential entries
// while leaving the rest. These helpers normalize the handful of shapes the
// console edits without turning unknown keys into a second schema.

export type SnmpNode = {
  ip: string;
  version: string;
  community?: string;
  has_community?: boolean;
};

export type ProviderSecrets = {
  key: string;
  secret: string;
  password: string;
  community: string;
};

export function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

export function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** SNMP `cidr` is an array; a components `cidr` is a single string. */
export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => scalarText(item).trim()).filter(Boolean);
  const text = scalarText(value).trim();
  return text ? [text] : [];
}

export function snmpNodes(extra: Record<string, unknown>): SnmpNode[] {
  if (!Array.isArray(extra.nodes)) return [{ ip: '', version: '2c' }];
  const nodes = extra.nodes
    .map(recordOf)
    .map((node) => ({
      ip: scalarText(node.ip),
      version: scalarText(node.version) || '2c',
      ...(typeof node.community === 'string' && node.community !== '' ? { community: node.community } : {}),
      ...(node.has_community === true ? { has_community: true } : {}),
    }));
  return nodes.length > 0 ? nodes : [{ ip: '', version: '2c' }];
}

export function withSnmpNodes(extra: Record<string, unknown>, nodes: SnmpNode[]): Record<string, unknown> {
  return { ...extra, nodes };
}

/** A reference is a scalar id; an empty value means "no reference". */
export function accountReference(extra: Record<string, unknown>): string {
  return scalarText(extra._reference);
}
