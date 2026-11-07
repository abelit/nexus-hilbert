import { describe, expect, it } from 'vitest';

import type { Rule, Target } from '../../api/discovery';
import {
  editableRelations,
  latestSync,
  mappingKeys,
  mappingPayload,
  relationPayload,
  sameMapping,
  syncTime,
  targetMapping,
  uniqueMapped,
  type EditableRelation,
} from './modelAutoDiscovery';

function makeTarget(attributes: Record<string, unknown> = {}): Target {
  return {
    id: 7,
    type_id: 1,
    adr_id: 2,
    attributes,
    auto_accept: false,
    agent_id: '',
    query_expr: '',
    cron: '',
    extra_option: {},
    has_secret: false,
    has_password: false,
    enabled: true,
  };
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 2,
    name: 'server',
    type: 'agent',
    is_inner: true,
    is_plugin: false,
    attribute_count: 2,
    has_plugin_script: false,
    ...overrides,
  };
}

function row(key: string, adKey: string, peerTypeID: string, peerAttrID: string): EditableRelation {
  return { key, adKey, peerTypeID, peerAttrID };
}

describe('model auto discovery', () => {
  it('turns a target mapping into the select editor’s string form', () => {
    expect(targetMapping(makeTarget({ ip: 'ip', ports: 0 }))).toEqual({ ip: 'ip', ports: '0' });
    expect(targetMapping(null)).toEqual({});
  });

  it('offers rule fields first and unions catalogue, existing and discovered keys once', () => {
    const rule = makeRule({ attributes: [{ name: 'ip', type: 'string' }, { name: 'host_name', type: 'string' }] });
    const keys = mappingKeys(
      rule,
      makeTarget({ uuid: 'uuid', ip: 'ip' }),
      ['uuid', 'host_name'],
      ['ip', 'os_type'],
    );
    expect(keys).toEqual(['ip', 'host_name', 'uuid', 'os_type']);
  });

  it('drops empty selections instead of storing an empty attribute name', () => {
    expect(mappingPayload({ ip: 'ip', uuid: '  ', os: '' })).toEqual({ ip: 'ip' });
  });

  it('compares mappings without treating key order or empty rows as changes', () => {
    expect(sameMapping({ uuid: 'uuid', ip: 'ip' }, { ip: 'ip', uuid: 'uuid' })).toBe(true);
    expect(sameMapping({ uuid: 'uuid', ip: '' }, { uuid: 'uuid' })).toBe(true);
    expect(sameMapping({ uuid: 'uuid' }, { uuid: 'hostname' })).toBe(false);
  });

  it('checks the identifying attribute against the mapped values', () => {
    expect(uniqueMapped({ uuid: 'uuid', ip: 'ip' }, 'uuid')).toBe(true);
    expect(uniqueMapped({ uuid: 'hostname' }, 'uuid')).toBe(false);
    expect(uniqueMapped({ uuid: '' }, '')).toBe(true);
  });

  it('keeps one blank relation row when the model has none yet', () => {
    let n = 0;
    const rows = editableRelations([], () => `k${++n}`);
    expect(rows).toEqual([{ key: 'k1', adKey: '', peerTypeID: '', peerAttrID: '' }]);
  });

  it('maps stored relations into editable rows', () => {
    let n = 0;
    const rows = editableRelations(
      [{ ad_key: 'rack', peer_type_id: 9, peer_attr_id: 12 }],
      () => `k${++n}`,
    );
    expect(rows).toEqual([{ key: 'k1', adKey: 'rack', peerTypeID: '9', peerAttrID: '12' }]);
  });

  it('ignores a fully blank relation row but refuses a half-filled one', () => {
    const blank = relationPayload([row('a', '', '', ''), row('b', 'rack', '9', '12')]);
    expect(blank).toEqual({
      relations: [{ ad_key: 'rack', peer_type_id: 9, peer_attr_id: 12 }],
      error: null,
    });
    expect(relationPayload([row('a', 'rack', '', '')]).error).toBe('incomplete');
  });

  it('refuses an exact duplicate relation triple', () => {
    const got = relationPayload([
      row('a', 'rack', '9', '12'),
      row('b', 'rack', '9', '12'),
    ]);
    expect(got.error).toBe('duplicate');
    expect(got.relations).toEqual([]);
  });

  it('accepts the same discovery field with different peer attributes', () => {
    const got = relationPayload([
      row('a', 'rack', '9', '12'),
      row('b', 'rack', '9', '13'),
    ]);
    expect(got.error).toBeNull();
    expect(got.relations).toHaveLength(2);
  });

  it('finds the newest handover record and parses the CMDB timestamp', () => {
    const older = { id: 1, sync_at: '2026-01-02 03:04:05' };
    const newer = { id: 2, sync_at: '2026-01-02 05:04:05' };
    expect(latestSync([older, newer])?.id).toBe(2);
    expect(syncTime({ id: 3, sync_at: '2026-01-02T03:04:05' })).not.toBeNull();
    expect(syncTime({ id: 4 })).toBeNull();
  });
});
