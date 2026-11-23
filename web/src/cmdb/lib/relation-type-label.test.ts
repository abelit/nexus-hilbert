import { describe, expect, it } from 'vitest';

import { relationTypeLabel } from './relation-type-label';

const runsOn = { name: 'RUNS_ON', display_name_zh: '运行于', display_name_en: 'Runs on' };

describe('relationTypeLabel', () => {
  it('shows the Chinese display name in a Chinese console', () => {
    expect(relationTypeLabel(runsOn, 'zh-CN')).toBe('运行于');
  });

  it('shows the English display name in an English console', () => {
    expect(relationTypeLabel(runsOn, 'en-US')).toBe('Runs on');
  });

  it('falls back to the other language before the canonical name', () => {
    expect(relationTypeLabel({ name: 'RUNS_ON', display_name_en: 'Runs on' }, 'zh-CN')).toBe('Runs on');
    expect(relationTypeLabel({ name: 'RUNS_ON', display_name_zh: '运行于' }, 'en-US')).toBe('运行于');
  });

  it('falls back to the canonical name when no display name is set', () => {
    expect(relationTypeLabel({ name: 'RUNS_ON' }, 'zh-CN')).toBe('RUNS_ON');
    expect(relationTypeLabel({ name: 'RUNS_ON', display_name_zh: '  ', display_name_en: '' }, 'en-US')).toBe('RUNS_ON');
  });

  it('trims a padded display name', () => {
    expect(relationTypeLabel({ name: 'RUNS_ON', display_name_zh: ' 运行于 ' }, 'zh-CN')).toBe('运行于');
  });
});
