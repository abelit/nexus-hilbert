import { describe, expect, it } from 'vitest';

import { relationEdgeLabel } from './relation';

describe('relationEdgeLabel', () => {
  it('joins the relation name and the compact cardinality', () => {
    expect(relationEdgeLabel('包含', '1:N')).toBe('包含 · 1:N');
    expect(relationEdgeLabel('运行于', '1:1')).toBe('运行于 · 1:1');
    expect(relationEdgeLabel('连接', 'N:M')).toBe('连接 · N:M');
  });

  it('keeps the name alone when the constraint is unknown', () => {
    expect(relationEdgeLabel('包含', null)).toBe('包含');
    expect(relationEdgeLabel('包含', undefined)).toBe('包含');
    expect(relationEdgeLabel('包含', '')).toBe('包含');
  });

  it('shows the cardinality alone when the relation has no name', () => {
    expect(relationEdgeLabel('', '1:N')).toBe('1:N');
  });
});
