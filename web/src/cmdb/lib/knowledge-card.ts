import type { CIType, TypeAttribute } from '../api/citype';
import type { Instance } from '../api/instance';
import { displayValue } from './valuetype';

/**
 * One CI as a knowledge-base document.
 *
 * THIS IS A SUMMARY, NOT AN EXPORT. The manual-document ingestion path embeds
 * only the first 2500 characters, so the card is deliberately small and stable;
 * full values and relations stay in CMDB where access control and freshness
 * live.
 */
export type CMDBKnowledgeItem = {
  ciId: number;
  modelName: string;
  modelAlias: string;
  /** Default document title; the dialog lets the operator edit it. */
  title: string;
  /** Default folder. */
  path: string;
  tags: string[];
  markdown: string;
};

const MAX_ATTRIBUTES = 20;
const MAX_VALUE_CHARS = 200;
const MAX_BODY_CHARS = 2400;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function displayTitle(model: CIType, instance: Instance): string {
  const key = model.show_name || model.unique_key;
  const raw = key ? displayValue(instance.values?.[key]) : '';
  const text = oneLine(String(raw ?? ''));
  return text || `#${instance.ci_id}`;
}

/** Whether a value may leave CMDB for the knowledge base. */
function shareable(attribute: TypeAttribute): boolean {
  return !attribute.is_password && !attribute.is_file && !attribute.is_link;
}

function cardValues(attributes: TypeAttribute[], instance: Instance): string[] {
  const lines: string[] = [];
  for (const attribute of attributes) {
    if (!shareable(attribute) || lines.length >= MAX_ATTRIBUTES) continue;
    const raw = displayValue(instance.values?.[attribute.name]);
    const text = oneLine(String(raw ?? ''));
    if (!text) continue;
    const clipped = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
    const label = attribute.alias || attribute.name;
    lines.push(label === attribute.name ? `- \`${attribute.name}\`: ${clipped}` : `- **${label}** (\`${attribute.name}\`): ${clipped}`);
  }
  return lines;
}

export function cmdbKnowledgeItem({
  model,
  attributes,
  instance,
}: {
  model: CIType;
  attributes: TypeAttribute[];
  instance: Instance;
}): CMDBKnowledgeItem {
  const modelName = model.name;
  const modelAlias = model.alias || model.name;
  const display = displayTitle(model, instance);
  const title = `[CMDB] ${modelAlias} ${display} (#${instance.ci_id})`;
  const header = [
    `# ${title}`,
    '',
    `- CI ID: ${instance.ci_id}`,
    `- 模型: ${modelAlias} (\`${modelName}\`)`,
  ];
  const body = ['', '## 属性', ...cardValues(attributes, instance)].join('\n');
  const markdown = [...header, body].join('\n').slice(0, MAX_BODY_CHARS);
  return {
    ciId: instance.ci_id,
    modelName,
    modelAlias,
    title,
    path: `CMDB/${modelAlias}`,
    tags: ['cmdb', `ci_type:${modelName}`, `ci_id:${instance.ci_id}`],
    markdown,
  };
}
