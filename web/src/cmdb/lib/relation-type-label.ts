import type { Locale } from '@/i18n/locale';

// The label an operator reads for a relation type.
//
// THE CANONICAL NAME IS THE IDENTITY, not the label: `name` is what the
// connector maps on and what the API stores. The zh/en fields are the
// ontology's display names, mirrored read-only. This helper only picks which
// of them to show, and falls back to the name so a type that has no display
// name is never rendered blank.

type RelationTypeNames = {
  name: string;
  display_name_zh?: string | null;
  display_name_en?: string | null;
};

export function relationTypeLabel(type: RelationTypeNames, locale: Locale | string): string {
  const zh = (type.display_name_zh ?? '').trim();
  const en = (type.display_name_en ?? '').trim();
  if (locale.toLowerCase().startsWith('zh')) {
    return zh || en || type.name;
  }
  return en || zh || type.name;
}
