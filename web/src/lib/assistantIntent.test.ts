import { describe, expect, it } from 'vitest';

import { type AssistantIntent, openAssistant, subscribeAssistantIntent } from './assistantIntent';

describe('assistantIntent', () => {
  it('notifies subscribers with an incrementing id', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeAssistantIntent((intent) => seen.push(intent.id));

    openAssistant({ prompt: '解释 web-01' });
    openAssistant({ prompt: '查关系' });
    unsubscribe();
    openAssistant({ prompt: 'ignored' });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0] + 1);
  });

  it('keeps the prompt and optional snapshot', () => {
    const seen: AssistantIntent[] = [];
    const unsubscribe = subscribeAssistantIntent((intent) => {
      seen.push(intent);
    });

    openAssistant({
      prompt: '翻译',
      snapshot: { page: '模型配置', fields: { model_id: '3' } },
    });

    expect(seen[0]?.prompt).toBe('翻译');
    expect(seen[0]?.snapshot?.fields.model_id).toBe('3');
    unsubscribe();
  });
});
