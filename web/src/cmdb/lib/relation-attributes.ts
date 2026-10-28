import type { TypeAttribute } from '../api/citype';

// Which attributes may sit on one side of a model relation's attribute mapping.
//
// PORTED FROM CANTOR'S `filterAttributes` (model_relation/index.vue): the
// backend compares the two stored values, so offering an incompatible pair
// would create a mapping that can never match. The rules are deliberately the
// same as cantor's so an existing model's form behaves identically here.

export type RelationSide = 'source' | 'target';

export function relationAttributeCandidates(
  attributes: TypeAttribute[],
  oppositeSelectedID: string,
  oppositeAttributes: TypeAttribute[],
  side: RelationSide,
  constraint: string,
): TypeAttribute[] {
  const opposite = oppositeAttributes.find(
    (attribute) => String(attribute.id) === String(oppositeSelectedID),
  );
  const constraintValue = Number(constraint);

  let result = attributes.filter(
    (attribute) =>
      // A text attribute only participates when it is indexed, and secrets,
      // JSON, booleans and references are not comparable values.
      !(attribute.value_type === '2' && !attribute.is_index) &&
      !attribute.is_password &&
      attribute.value_type !== '6' &&
      !attribute.is_bool &&
      !attribute.is_reference,
  );

  if (opposite) {
    // Both sides must store the same kind of value.
    result = result.filter((attribute) => attribute.value_type === opposite.value_type);
  }

  const forbidsLists =
    (constraintValue === 0 && side === 'target') ||
    constraintValue === 1 ||
    (constraintValue === 2 && Boolean(opposite?.is_list));

  return forbidsLists ? result.filter((attribute) => !attribute.is_list) : result;
}

export function relationAttributeOptions(
  attributes: TypeAttribute[],
): Array<{ value: string; label: string }> {
  return attributes.map((attribute) => ({
    value: String(attribute.id),
    label: `${attribute.alias || attribute.name}（${attribute.name}）`,
  }));
}
