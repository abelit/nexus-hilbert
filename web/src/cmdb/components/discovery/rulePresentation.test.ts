import { describe, expect, it } from 'vitest';

import type { Rule } from '../../api/discovery';
import {
  ruleCategory,
  ruleCategoryLabel,
  ruleHasAccountConfig,
  ruleIconValue,
  ruleProviderKey,
  ruleResources,
} from './rulePresentation';

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 1,
    name: '阿里云',
    type: 'http',
    is_inner: true,
    is_plugin: false,
    attribute_count: 0,
    has_plugin_script: false,
    ...overrides,
  };
}

const tr = (zh: string, en: string) => `${zh}/${en}`;

describe('rule presentation', () => {
  it('derives the six categories from type, option and plugin flag', () => {
    expect(ruleCategory(makeRule({ option: { en: 'aliyun' } }))).toBe('http');
    expect(
      ruleCategory(makeRule({ type: 'http', option: { en: 'vcenter', category: 'private_cloud' } })),
    ).toBe('private_cloud');
    expect(ruleCategory(makeRule({ type: 'snmp' }))).toBe('snmp');
    expect(ruleCategory(makeRule({ type: 'components' }))).toBe('components');
    expect(ruleCategory(makeRule({ type: 'agent' }))).toBe('agent');
    expect(ruleCategory(makeRule({ type: 'agent', is_plugin: true }))).toBe('plugin');
    // An unknown type stays visible instead of falling out of every section.
    expect(ruleCategory(makeRule({ type: 'legacy' }))).toBe('agent');
  });

  it('labels every category in both languages', () => {
    expect(ruleCategoryLabel(tr, 'http')).toBe('HTTP 接口/HTTP API');
    expect(ruleCategoryLabel(tr, 'private_cloud')).toBe('私有云/Private cloud');
    expect(ruleCategoryLabel(tr, 'snmp')).toBe('SNMP');
    expect(ruleCategoryLabel(tr, 'components')).toBe('组件/Components');
    expect(ruleCategoryLabel(tr, 'plugin')).toBe('插件/Plugins');
  });

  it('translates the catalogue’s cloud glyph names to the vendored sprite', () => {
    expect(ruleIconValue(makeRule({ option: { en: 'aliyun', icon: { name: 'caise-aliyun' } } }))).toBe(
      'Alibaba_Cloud$$$$0$$',
    );
    expect(
      ruleIconValue(makeRule({ option: { en: 'huaweicloud', icon: { name: 'caise-huaweiyun' } } })),
    ).toBe('Huawei_Cloud$$$$0$$');
    // A provider whose glyph already exists is passed through unchanged.
    expect(ruleIconValue(makeRule({ option: { en: 'nginx', icon: { name: 'caise-nginx' } } }))).toBe(
      'caise-nginx$$$$0$$',
    );
    // A stored colour survives; anything that is not a literal colour is dropped.
    expect(
      ruleIconValue(makeRule({ option: { en: 'nginx', icon: { name: 'caise-nginx', color: '#123456' } } })),
    ).toBe('caise-nginx$$#123456$$0$$');
    expect(
      ruleIconValue(makeRule({ option: { en: 'nginx', icon: { name: 'caise-nginx', color: 'red' } } })),
    ).toBe('caise-nginx$$$$0$$');
    expect(ruleIconValue(makeRule())).toBe('');
  });

  it('flattens and de-duplicates a cloud rule’s resources', () => {
    const rule = makeRule({
      categories: [
        { category: '计算', items: ['ecs', 'rds'] },
        { category: '存储', items: ['rds', 'oss'] },
      ],
    });
    expect(ruleResources(rule)).toEqual(['ecs', 'rds', 'oss']);
    expect(ruleResources(makeRule())).toEqual([]);
  });

  it('uses option.en as the provider key and falls back to the name', () => {
    expect(ruleProviderKey(makeRule({ option: { en: 'aliyun' } }))).toBe('aliyun');
    expect(ruleProviderKey(makeRule())).toBe('阿里云');
  });

  it('offers the cloud account dialog only to the five known HTTP providers', () => {
    for (const en of ['aliyun', 'tencentcloud', 'huaweicloud', 'aws', 'vcenter']) {
      expect(ruleHasAccountConfig(makeRule({ type: 'http', option: { en } }))).toBe(true);
    }
    // Every other provider keeps the drawer's generic JSON editor.
    expect(ruleHasAccountConfig(makeRule({ type: 'http', option: { en: 'kvm' } }))).toBe(false);
    expect(ruleHasAccountConfig(makeRule({ type: 'components', option: { en: 'aliyun' } }))).toBe(false);
  });
});
