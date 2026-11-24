import { describe, expect, it } from 'vitest';

import { generateUuid, isUuidAttribute } from './uuid';

describe('uuid attributes', () => {
  it('recognizes a field named or aliased like a UUID', () => {
    expect(isUuidAttribute({ name: 'uuid', alias: 'UUID' })).toBe(true);
    expect(isUuidAttribute({ name: 'machine_uuid', alias: '' })).toBe(true);
    expect(isUuidAttribute({ name: 'asset_id', alias: '机器UUID' })).toBe(true);
    expect(isUuidAttribute({ name: 'hostname', alias: '主机名' })).toBe(false);
    // Only a suffix: a description about UUIDs is not a UUID field.
    expect(isUuidAttribute({ name: 'uuid_note', alias: '' })).toBe(false);
  });

  it('generates a random v4 UUID', () => {
    const first = generateUuid();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(generateUuid()).not.toBe(first);
  });
});
