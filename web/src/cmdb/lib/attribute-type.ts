import {
  Braces,
  Calendar,
  CalendarClock,
  CircleCheck,
  Clock,
  Hash,
  KeyRound,
  Link,
  Link2,
  Paperclip,
  Sigma,
  Text,
  Type,
  type LucideIcon,
} from 'lucide-react';

// The type an operator sees in model configuration.
//
// THE STORAGE HAS EIGHT CODES; the console shows thirteen. Password, link,
// file, reference and long text are not additional value_type values — the
// backend keeps them as flags on an attribute whose storage type is TEXT or
// INT. Resolving the flag here keeps every list, card and filter agreeing about
// which icon and label a row gets.
//
// CANTOR'S ORDER IS PRESERVED: password/link/file first, then INT + reference,
// then unindexed TEXT as long text, then BOOL. A filter must select the same
// type the row displays, not the storage code underneath it.

export type AttributeDisplayType =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | '11'
  | '12';

type AttributeTypeFlags = {
  value_type: string;
  is_index: boolean;
  is_password: boolean;
  is_link: boolean;
  is_file: boolean;
  is_reference: boolean;
};

export type AttributeTypeMeta = {
  /** [Chinese, English] — resolve with the caller's `tr`. */
  label: [string, string];
  icon: LucideIcon;
};

export const ATTRIBUTE_TYPE_META: Record<AttributeDisplayType, AttributeTypeMeta> = {
  '0': { label: ['整数', 'Integer'], icon: Hash },
  '1': { label: ['浮点数', 'Float'], icon: Sigma },
  '2': { label: ['短文本', 'Short text'], icon: Type },
  '3': { label: ['日期时间', 'Date & time'], icon: CalendarClock },
  '4': { label: ['日期', 'Date'], icon: Calendar },
  '5': { label: ['时间', 'Time'], icon: Clock },
  '6': { label: ['JSON', 'JSON'], icon: Braces },
  '7': { label: ['密码', 'Password'], icon: KeyRound },
  '8': { label: ['链接', 'Link'], icon: Link },
  '9': { label: ['长文本', 'Long text'], icon: Text },
  '10': { label: ['布尔', 'Boolean'], icon: CircleCheck },
  '11': { label: ['引用', 'Reference'], icon: Link2 },
  '12': { label: ['文件', 'File'], icon: Paperclip },
};

/** Filter order, matching the type picker rather than storage internals. */
export const ATTRIBUTE_DISPLAY_TYPE_ORDER: AttributeDisplayType[] = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
];

/**
 * Resolves the type a row is presented as.
 *
 * Returns null for a storage code this console does not know; callers show the
 * raw code rather than silently pretending it is text.
 */
export function attributeDisplayType(attribute: AttributeTypeFlags): AttributeDisplayType | null {
  if (attribute.is_password) return '7';
  if (attribute.is_link) return '8';
  if (attribute.is_file) return '12';

  switch (attribute.value_type) {
    case '0':
      return attribute.is_reference ? '11' : '0';
    case '1':
      return '1';
    case '2':
      return attribute.is_index ? '2' : '9';
    case '3':
      return '3';
    case '4':
      return '4';
    case '5':
      return '5';
    case '6':
      return '6';
    case '7':
      return '10';
    default:
      return null;
  }
}
