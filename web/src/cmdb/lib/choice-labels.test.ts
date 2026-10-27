import { describe, expect, it } from 'vitest';

import type { TypeAttribute } from '../api/citype';
import { choiceLabel, choiceText } from './choice-labels';

const attribute = (choice_value: TypeAttribute['choice_value']): TypeAttribute => ({
  id: 1,
  name: 'environment',
  alias: '环境类型',
  value_type: '2',
  is_choice: true,
  is_list: false,
  is_unique: false,
  is_index: true,
  is_link: false,
  is_password: false,
  is_sortable: false,
  is_dynamic: false,
  is_bool: false,
  is_file: false,
  is_reference: false,
  is_computed: false,
  has_compute_script: false,
  has_choice_web_hook: false,
  has_choice_other: false,
  is_indexed: true,
  storage_table: 'c_value_index_texts',
  is_required: false,
  order: 1,
  default_show: true,
  inherited: false,
  choice_value,
});

describe('choice labels', () => {
  it('maps a stored value to its configured label', () => {
    const env = attribute([
      { value: 'prod', option: { label: '生产' } },
      { value: 'test', option: { label: '测试' } },
    ]);
    expect(choiceLabel(env, 'prod')).toBe('生产');
    expect(choiceLabel(env, 'test')).toBe('测试');
    expect(choiceLabel(env, 'unknown')).toBeUndefined();
  });

  it('matches numeric values without depending on their storage type', () => {
    const priority = attribute([
      { value: 1, option: { label: '高' } },
      { value: 2, option: { label: '低' } },
    ]);
    expect(choiceLabel(priority, 1)).toBe('高');
    expect(choiceLabel(priority, '2')).toBe('低');
  });

  it('labels each item of a multi-valued choice and keeps unknown values visible', () => {
    const env = attribute([
      { value: 'prod', option: { label: '生产' } },
      { value: 'dev', option: { label: '研发' } },
    ]);
    expect(choiceText(env, ['prod', 'dev'])).toBe('生产, 研发');
    expect(choiceText(env, ['prod', 'staging'])).toBe('生产, staging');
    expect(choiceText(env, 'unknown')).toBeUndefined();
    expect(choiceText(env, null)).toBeUndefined();
  });

  it('ignores choices on a non-choice attribute and an empty label', () => {
    const env = attribute([{ value: 'prod', option: { label: '' } }]);
    expect(choiceLabel(env, 'prod')).toBeUndefined();
    expect(choiceLabel({ ...env, is_choice: false }, 'prod')).toBeUndefined();
  });
});
