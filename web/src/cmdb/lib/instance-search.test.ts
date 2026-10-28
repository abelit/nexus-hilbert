import { describe, expect, it } from 'vitest';

import { instanceSearchQuery, searchRowToInstance } from './instance-search';

describe('instance search queries', () => {
  it('wraps the term in the type-scoped contains wildcard', () => {
    expect(instanceSearchQuery(3, 'web-01')).toBe('_type:3,*web-01*');
  });

  it('escapes commas and backslashes so a value cannot change the expression', () => {
    expect(instanceSearchQuery(3, 'a,b\\c')).toBe('_type:3,*a\\,b\\\\c*');
  });

  it('falls back to the type alone for an empty term', () => {
    expect(instanceSearchQuery(3, '   ')).toBe('_type:3');
  });
});

describe('search hits', () => {
  it('returns flat values and strips the metadata keys the list endpoint does not use', () => {
    const got = searchRowToInstance({
      _id: 41,
      _type: 3,
      ci_id: 41,
      ci_type: 'rack',
      ci_type_alias: '机柜',
      unique: 'name',
      unique_alias: '名称',
      _updated_at: '2026-10-27 09:00:00',
      _updated_by: 'admin',
      name: 'rack-01',
      environment: 'prod',
    });

    expect(got).toEqual({
      ci_id: 41,
      type_id: 3,
      updated_at: '2026-10-27 09:00:00',
      updated_by: 'admin',
      values: { name: 'rack-01', environment: 'prod' },
    });
  });
});
