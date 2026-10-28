// The Excel template a batch import starts from.
//
// THE TEMPLATE IS THE CONTRACT. Cantor let an operator pick which attributes
// and model relations the sheet carries; the header row is then exactly what
// the server matches. Both sides therefore have to agree on the spelling, and
// this module is the one place that writes it: attribute columns use the alias
// a person reads, and relation columns use `$model.attribute`.
//
// A HEADER COLLIDING ON AN ALIAS FALLS BACK TO THE ATTRIBUTE NAME. The server
// resolves an exact alias to the FIRST attribute that claims it; two attributes
// whose aliases differ only by being the same string would otherwise make one
// column write the other's value.

import type { Attribute, RelatedType, TypeAttribute } from '../api/citype';
import type { TemplateColumn } from './sheet';

/** A parent model the imported rows may be related to. */
export type TemplateParent = {
  related: RelatedType;
  /** The parent attributes a cell can name an instance by. */
  attributes: TypeAttribute[];
  /** The attribute the dialog starts on: the parent's identifier when usable. */
  defaultAttrID: number | null;
};

/** Attributes that can carry a value from a sheet. */
export function importableAttributes(attributes: TypeAttribute[]): TypeAttribute[] {
  return attributes.filter(
    (attribute) => !attribute.is_computed && !attribute.is_password && !attribute.is_file,
  );
}

/** Parent relations that can supply a `$parent.attribute` column. */
export function parentTemplates(parents: RelatedType[]): TemplateParent[] {
  const out: TemplateParent[] = [];
  for (const related of parents) {
    const attributes = importableAttributes(related.attributes ?? []).filter(
      (attribute) =>
        // A list stores several rows per instance, so a single cell does not
        // identify one parent unambiguously.
        !attribute.is_list,
    );
    if (attributes.length === 0) continue;
    const identifier = attributes.find(
      (attribute) => attribute.name === related.type.unique_key,
    );
    out.push({
      related,
      attributes,
      defaultAttrID: identifier?.id ?? attributes[0].id,
    });
  }
  return out;
}

/**
 * The header to write for an attribute.
 *
 * `all` is the model's whole effective attribute set, not only the selected
 * ones: the server resolves a header against every attribute, so a collision
 * with an unselected attribute is still a collision.
 */
export function attributeHeader(all: Attribute[], attribute: Attribute): string {
  const label = attribute.alias || attribute.name;
  const collisions = all.filter((candidate) => (candidate.alias || candidate.name) === label);
  return collisions.length > 1 ? attribute.name : label;
}

/** The header for `$parent.attribute`. The model is addressed by its name. */
export function relationHeader(
  parent: RelatedType,
  attribute: Attribute,
  allParentAttributes: Attribute[],
): string {
  return `$${parent.type.name}.${attributeHeader(allParentAttributes, attribute)}`;
}

/** The values an Excel dropdown should offer, in the order the model stores them. */
export function choiceValues(attribute: Attribute): string[] {
  return (attribute.choice_value ?? [])
    .map((choice) => String(choice.value ?? ''))
    .filter((value) => value !== '');
}

export type TemplateSelection = {
  /** Every effective attribute of the imported model. */
  attributes: TypeAttribute[];
  selectedAttrIDs: number[];
  parents: TemplateParent[];
  selectedParentIDs: number[];
  /** ctr_id -> the parent attribute whose value names the parent. */
  parentAttrIDs: Record<number, number>;
};

/** Builds the columns of the downloadable template. */
export function templateColumns(selection: TemplateSelection): TemplateColumn[] {
  const selected = new Set(selection.selectedAttrIDs);
  const out: TemplateColumn[] = [];
  for (const attribute of selection.attributes) {
    if (!selected.has(attribute.id)) continue;
    out.push({
      header: attributeHeader(selection.attributes, attribute),
      choices: attribute.is_choice ? choiceValues(attribute) : undefined,
    });
  }

  const parents = new Set(selection.selectedParentIDs);
  for (const parent of selection.parents) {
    if (!parents.has(parent.related.ctr_id)) continue;
    const attrID = selection.parentAttrIDs[parent.related.ctr_id] ?? parent.defaultAttrID;
    const attribute = parent.attributes.find((candidate) => candidate.id === attrID);
    if (!attribute) continue;
    out.push({
      header: relationHeader(parent.related, attribute, parent.related.attributes ?? []),
      choices: attribute.is_choice ? choiceValues(attribute) : undefined,
      // Cantor's template showed relation columns in red.
      headerColor: 'FFFF0000',
    });
  }
  return out;
}
