import type { Attribute } from '../api/citype';
import { displayValue, isEmptyValue } from './valuetype';

// A CHOICE VALUE IS A CODE, THE LABEL IS THE WORD. cantor stored `prod` and
// put 生产 in the attribute's `choice_value[].option.label`; printing the code
// in a resource table makes every operator translate it in their head. Resolve
// the label at render time and keep the code in the title for exact matching.

type ChoiceAttribute = Pick<Attribute, 'is_choice' | 'choice_value'>;

export function choiceLabel(attribute: ChoiceAttribute, value: unknown): string | undefined {
  if (!attribute.is_choice) return undefined;
  const code = displayValue(value);
  if (!code) return undefined;
  for (const choice of attribute.choice_value ?? []) {
    if (String(choice.value) !== code) continue;
    const label = choice.option?.label;
    if (typeof label === 'string' && label.trim()) return label.trim();
  }
  return undefined;
}

/** Render one or more stored choice codes as their configured labels. */
export function choiceText(attribute: ChoiceAttribute, value: unknown): string | undefined {
  if (!attribute.is_choice) return undefined;
  const values = Array.isArray(value) ? value : [value];
  const parts: string[] = [];
  let translated = false;
  for (const item of values) {
    if (isEmptyValue(item)) continue;
    const label = choiceLabel(attribute, item);
    if (label) {
      parts.push(label);
      translated = true;
    } else {
      parts.push(displayValue(item));
    }
  }
  return translated && parts.length > 0 ? parts.join(', ') : undefined;
}
