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

export type CardinalityMark = '1' | 'N';
export type CardinalityEnds = { source: CardinalityMark; target: CardinalityMark };

/**
 * The cardinality at each end of a parent -> child edge, in the familiar 1/N
 * notation. `null` means unknown: the graph renders no badge rather than
 * guessing a shape or printing the raw storage code.
 */
export function cardinalityEnds(constraint: string): CardinalityEnds | null {
  switch (constraint) {
    case '0':
      return { source: '1', target: 'N' };
    case '1':
      return { source: '1', target: '1' };
    case '2':
      return { source: 'N', target: 'N' };
    default:
      return null;
  }
}

/**
 * The compact notation the relation badge shows: 1:N, 1:1, N:M (and N:1 for a
 * many-to-one pair). The child side of a many-to-many pair uses M so the two
 * ends remain distinguishable. Unknown codes return null, so the badge keeps
 * the relation name alone instead of printing a raw storage code.
 */
export function cardinalityLabel(constraint: string): string | null {
  const ends = cardinalityEnds(constraint);
  if (!ends) return null;
  if (ends.source === 'N' && ends.target === 'N') return 'N:M';
  return `${ends.source}:${ends.target}`;
}

/**
 * The full label a relation edge exposes as its tooltip: the relation type
 * followed by the compact cardinality. The model-config topology, the resource
 * topology and the relation-view canvas all use this, so the same relation
 * cannot read differently in different graphs. An unknown cardinality leaves
 * the name alone.
 */
export function relationEdgeLabel(name: string, cardinality?: string | null): string {
  return [name, cardinality].filter(Boolean).join(' · ');
}
