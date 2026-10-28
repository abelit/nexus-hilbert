// cantor stores a model relation's cardinality as 0/1/2; the console shows the
// familiar one-to-many labels. The form must send the code, not the label — the
// handler validates against model.Constraint and rejects "一对多".
export const RELATION_CONSTRAINTS = [
  { value: '0', zh: '一对多', en: 'One-to-many' },
  { value: '1', zh: '一对一', en: 'One-to-one' },
  { value: '2', zh: '多对多', en: 'Many-to-many' },
] as const;

export function relationConstraintLabel(
  code: string,
  tr: (zh: string, en: string) => string,
): string {
  const found = RELATION_CONSTRAINTS.find((item) => item.value === code);
  return found ? tr(found.zh, found.en) : code;
}
