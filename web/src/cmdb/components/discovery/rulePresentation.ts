import { formatIconValue, isValidColor } from '../../lib/iconvalue';
import type { Rule } from '../../api/discovery';

// How a rule is presented in the catalogue.
//
// THE CATEGORY IS DERIVED, NOT STORED. cantor grouped its rules into six
// buckets from `type`, `option.category` and `is_plugin`; the backend has no
// category column, and a rule created through this console carries only the
// same three facts. Deriving it in one place keeps the card, the filter and
// the section order from drifting apart.

export const RULE_CATEGORY_ORDER = [
  'http',
  'private_cloud',
  'agent',
  'snmp',
  'components',
  'plugin',
] as const;

export type RuleCategory = (typeof RULE_CATEGORY_ORDER)[number];

/** The bucket a rule belongs to. */
export function ruleCategory(rule: Rule): RuleCategory {
  if (rule.is_plugin) return 'plugin';
  switch (rule.type) {
    case 'http':
      // A private cloud is an HTTP provider that the catalogue marks as its
      // own group; cantor drew it apart from the public clouds.
      return optionText(rule, 'category') === 'private_cloud' ? 'private_cloud' : 'http';
    case 'snmp':
    case 'components':
    case 'agent':
      return rule.type;
    default:
      // AN UNKNOWN TYPE IS AN AGENT RULE. It is the bucket cantor fell back
      // to, and it keeps a rule whose type predates this enum visible instead
      // of silently dropping it from every section.
      return 'agent';
  }
}

export function ruleCategoryLabel(
  tr: (zh: string, en: string) => string,
  category: RuleCategory,
): string {
  switch (category) {
    case 'http':
      return tr('HTTP 接口', 'HTTP API');
    case 'private_cloud':
      return tr('私有云', 'Private cloud');
    case 'agent':
      return tr('Agent 采集', 'Agent');
    case 'snmp':
      return 'SNMP';
    case 'components':
      return tr('组件', 'Components');
    case 'plugin':
      return tr('插件', 'Plugins');
  }
}

/**
 * The four public clouds' glyph names, as the vendored sprite spells them.
 *
 * THE CATALOGUE KEEPS CANTOR'S NAMES (`caise-aliyun`), which its own iconfont
 * served. This console vendors a different icon set, where the same providers
 * are `Alibaba_Cloud` and friends, so the four that differ are translated here.
 * Every other provider's name is already in the sprite.
 */
const PROVIDER_GLYPHS: Record<string, string> = {
  aliyun: 'Alibaba_Cloud',
  tencentcloud: 'Tencent_Cloud',
  huaweicloud: 'Huawei_Cloud',
  aws: 'AWS',
};

/**
 * The value `CMDBIcon` draws for a rule.
 *
 * `option.icon` is an object (`{name, color}`) rather than the CI type's
 * `$$`-separated string, so it is converted rather than passed through. A rule
 * with no icon returns '' and the caller gets the neutral fallback glyph.
 */
export function ruleIconValue(rule: Rule): string {
  const icon = recordOf(rule.option?.icon);
  const provider = optionText(rule, 'en');
  const glyph = PROVIDER_GLYPHS[provider] || (typeof icon?.name === 'string' ? icon.name : '');
  if (!glyph) return '';
  const rawColor = typeof icon?.color === 'string' ? icon.color : '';
  return formatIconValue({
    type: glyph,
    color: isValidColor(rawColor) ? rawColor : '',
    custom: false,
    url: '',
  });
}

/** Every resource a cloud provider can be asked for, in catalogue order. */
export function ruleResources(rule: Rule): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of rule.categories ?? []) {
    for (const item of group.items ?? []) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

/** The provider key a rule carries, falling back to its name. */
export function ruleProviderKey(rule: Rule): string {
  return optionText(rule, 'en') || rule.name;
}

/**
 * The collector key a rule carries.
 *
 * A components rule stores the key its adapter answers to, which is not always
 * the provider name; a cloud rule's `collect_key` is derived server-side from
 * the chosen resource, so the stored fallback is the provider key.
 */
export function ruleCollectKey(rule: Rule): string {
  return optionText(rule, 'collect_key') || ruleProviderKey(rule);
}

/**
 * The providers whose account takes a known shape.
 *
 * CANTOR SHOWED A KEY/SECRET FORM FOR THE FOUR PUBLIC CLOUDS and a
 * host/account/password form for vCenter; every other provider keeps the
 * generic JSON editor in the rule drawer. This is the same list, keyed by the
 * provider key rather than the display name.
 */
const CLOUD_ACCOUNT_PROVIDERS = new Set(['aliyun', 'tencentcloud', 'huaweicloud', 'aws', 'vcenter']);

/** Whether the rule's card offers the dedicated cloud account dialog. */
export function ruleHasAccountConfig(rule: Rule): boolean {
  return rule.type === 'http' && CLOUD_ACCOUNT_PROVIDERS.has(ruleProviderKey(rule));
}

function optionText(rule: Rule, key: string): string {
  const value = rule.option?.[key];
  return typeof value === 'string' ? value : '';
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
