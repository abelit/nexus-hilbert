import type { AttributeGroup, TypeAttribute } from '../api/citype';

// The attribute order an instance form and its read-only detail share.
//
// THE FORM SECTIONS ARE THE MODEL'S. Attributes that belong to a real section
// stay in that section; anything the group endpoint did not claim falls into
// one trailing section. Both the editor and the overview call this so a
// read-only view cannot reorder fields differently from the form an operator
// saved them with.

export type AttributeSection = {
  key: string;
  name: string;
  items: TypeAttribute[];
};

export function attributeSections(
  attributes: TypeAttribute[],
  groups: AttributeGroup[],
  otherLabel: string,
): AttributeSection[] {
  const claimed = new Set<number>();
  const out = groups
    .filter((group) => !group.is_other)
    .map((group) => {
      const items = group.attributes
        .map((attribute) => attributes.find((candidate) => candidate.id === attribute.id))
        .filter((attribute): attribute is TypeAttribute => Boolean(attribute));
      items.forEach((attribute) => claimed.add(attribute.id));
      return { key: `g-${group.id}`, name: group.name, items };
    })
    .filter((section) => section.items.length > 0);

  const rest = attributes.filter((attribute) => !claimed.has(attribute.id));
  if (rest.length > 0) {
    out.push({ key: 'other', name: otherLabel, items: rest });
  }
  return out;
}
