import { describe, expect, it } from 'vitest';

import {
  MAX_EXPLAIN_CIS,
  MAX_PROMPT_TEXT,
  explainCIsPrompt,
  explainValuePrompt,
  relationsPrompt,
  translateValuePrompt,
} from './aiPrompts';

describe('explainCIsPrompt', () => {
  it('lists the selected ids and caps the batch', () => {
    const ids = Array.from({ length: MAX_EXPLAIN_CIS + 2 }, (_, i) => i + 1);
    const prompt = explainCIsPrompt(ids, 'host', 'zh-CN');

    expect(prompt).toContain('#1');
    expect(prompt).toContain(`#${MAX_EXPLAIN_CIS}`);
    expect(prompt).not.toContain(`#${MAX_EXPLAIN_CIS + 1}`);
    expect(prompt).toContain('超过');
    expect(prompt).toContain('cmdb_get_ci');
    expect(prompt).toContain('中文');
  });

  it('uses English instructions for an English locale', () => {
    expect(explainCIsPrompt([7], 'host', 'en-US')).toContain('English');
  });
});

describe('relationsPrompt', () => {
  it('clamps the depth and names the direction', () => {
    const prompt = relationsPrompt(9, 'up', 99, 'zh-CN');

    expect(prompt).toContain('#9');
    expect(prompt).toContain('上游');
    expect(prompt).toContain('3 跳');
    expect(prompt).toContain('cmdb_relation_graph');
    expect(prompt).not.toContain('99 跳');
  });
});

describe('value prompts', () => {
  it('translate tells the assistant not to use tools and preserves the original', () => {
    const prompt = translateValuePrompt('生产环境 MySQL 8.0', 'en', '字段 environment');

    expect(prompt).toContain('English');
    expect(prompt).toContain('不要调用工具');
    expect(prompt).toContain('生产环境 MySQL 8.0');
    expect(prompt).toContain('字段 environment');
  });

  it('explain truncates oversized text and keeps the context', () => {
    const text = 'x'.repeat(MAX_PROMPT_TEXT + 20);
    const prompt = explainValuePrompt(text, '属性 owner');

    expect(prompt).toContain('已截断');
    expect(prompt).toContain('属性 owner');
    expect(prompt).toContain('不要调用工具');
    expect(prompt.length).toBeLessThan(text.length + 400);
  });
});
