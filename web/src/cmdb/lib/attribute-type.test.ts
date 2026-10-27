import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTE_DISPLAY_TYPE_ORDER,
  ATTRIBUTE_TYPE_META,
  attributeDisplayType,
} from './attribute-type';

function attribute(patch: Record<string, unknown> = {}) {
  return {
    value_type: '2',
    is_index: true,
    is_password: false,
    is_link: false,
    is_file: false,
    is_reference: false,
    ...patch,
  };
}

describe('the effective attribute type', () => {
  it('keeps the eight storage types and resolves their presentation variants', () => {
    expect(attributeDisplayType(attribute({ value_type: '0' }))).toBe('0');
    expect(attributeDisplayType(attribute({ value_type: '1' }))).toBe('1');
    expect(attributeDisplayType(attribute({ value_type: '2' }))).toBe('2');
    expect(attributeDisplayType(attribute({ value_type: '3' }))).toBe('3');
    expect(attributeDisplayType(attribute({ value_type: '4' }))).toBe('4');
    expect(attributeDisplayType(attribute({ value_type: '5' }))).toBe('5');
    expect(attributeDisplayType(attribute({ value_type: '6' }))).toBe('6');
    expect(attributeDisplayType(attribute({ value_type: '7' }))).toBe('10');
  });

  it('reads the storage flags as the type the operator configured', () => {
    expect(attributeDisplayType(attribute({ value_type: '2', is_index: false }))).toBe('9');
    expect(attributeDisplayType(attribute({ value_type: '2', is_password: true, is_index: true }))).toBe('7');
    expect(attributeDisplayType(attribute({ value_type: '2', is_link: true }))).toBe('8');
    expect(attributeDisplayType(attribute({ value_type: '2', is_file: true }))).toBe('12');
    expect(attributeDisplayType(attribute({ value_type: '0', is_reference: true }))).toBe('11');
  });

  it('lets the password flag win over a long-text storage choice', () => {
    expect(attributeDisplayType(attribute({ value_type: '2', is_index: false, is_password: true }))).toBe('7');
  });

  it('does not invent a type for an unknown storage code', () => {
    expect(attributeDisplayType(attribute({ value_type: '99' }))).toBeNull();
  });

  it('has a label and an icon for every display type in the filter', () => {
    expect(ATTRIBUTE_DISPLAY_TYPE_ORDER).toHaveLength(13);
    for (const key of ATTRIBUTE_DISPLAY_TYPE_ORDER) {
      expect(ATTRIBUTE_TYPE_META[key].label[0]).not.toBe('');
      expect(ATTRIBUTE_TYPE_META[key].label[1]).not.toBe('');
      expect(ATTRIBUTE_TYPE_META[key].icon).toBeTruthy();
    }
  });
});
