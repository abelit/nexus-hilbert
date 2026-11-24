// UUID fields are recognised by NAME, not by value type: the backend has no
// UUID type, and models name the field `uuid` or `machine_uuid`. Both the name
// and the operator-facing alias are checked, so a Chinese alias such as
// “机器UUID” still gets the generate affordance.

export function isUuidAttribute(attribute: { name: string; alias?: string | null }): boolean {
  return endsWithUuid(attribute.name) || endsWithUuid(attribute.alias ?? '');
}

function endsWithUuid(text: string): boolean {
  return text.trim().toLowerCase().endsWith('uuid');
}

/**
 * A random v4 UUID.
 *
 * BUILT FROM `getRandomValues`, NOT `randomUUID`: the latter is only exposed
 * in a secure context, and a console served over plain HTTP on a LAN address
 * would silently lose the feature. `getRandomValues` is available everywhere.
 */
export function generateUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
