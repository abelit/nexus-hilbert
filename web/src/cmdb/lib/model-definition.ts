import type {
  Attribute,
  AttributeGroup,
  CIType,
  RelatedType,
  Trigger,
  TypeAttribute,
  UniqueConstraint,
} from '../api/citype';

// A model definition is a read-only snapshot, not the page's form state.
//
// THE SNAPSHOT IS ASSEMBLED FROM READS. It deliberately does not embed the
// nested attribute objects carried by groups, relations or constraints: those
// have three different shapes and some of their `inherited` flags mean the
// group, not the attribute. They are used only to resolve an id to a name.
//
// THE DOCUMENT IS VERSIONED so a downloaded file stays interpretable after the
// API changes. List values are always arrays, missing scalars are null, and the
// two admin-only sections are null with an explicit omission reason for other
// roles.

export const MODEL_DEFINITION_FORMAT = 'ongrid.cmdb.model' as const;
export const MODEL_DEFINITION_VERSION = 1 as const;

export type DefinitionAttributeRef = {
  id: number;
  name: string | null;
};

export type DefinitionAttribute = {
  id: number;
  name: string;
  alias: string;
  value_type: string;
  is_choice: boolean;
  is_list: boolean;
  is_unique: boolean;
  is_index: boolean;
  is_link: boolean;
  is_password: boolean;
  is_sortable: boolean;
  is_dynamic: boolean;
  is_bool: boolean;
  is_file: boolean;
  is_reference: boolean;
  reference_type_id: number | null;
  default: Record<string, unknown> | null;
  is_computed: boolean;
  compute_expr: string | null;
  has_compute_script: boolean;
  has_choice_web_hook: boolean;
  has_choice_other: boolean;
  choice_value: NonNullable<Attribute['choice_value']>;
  re_check: string | null;
  option: Record<string, unknown> | null;
  binding: {
    is_required: boolean;
    order: number;
    default_show: boolean;
    inherited: boolean;
    inherited_from: string | null;
  };
};

export type DefinitionFormSection = {
  name: string;
  order: number;
  inherited: boolean;
  attribute_ids: number[];
};

export type DefinitionRelation = {
  other_model_role: 'child' | 'parent';
  other_model: { id: number; name: string; alias: string };
  relation_type: { id: number; name: string; color: string };
  constraint: string;
  cardinality: 'one_to_many' | 'one_to_one' | 'many_to_many' | 'unknown';
  show_key: string | null;
  attribute_mapping: Array<{
    parent_attribute: DefinitionAttributeRef;
    child_attribute: DefinitionAttributeRef;
  }>;
  unpaired_parent_attribute_ids: number[];
  unpaired_child_attribute_ids: number[];
};

export type DefinitionUniqueConstraint = {
  attribute_ids: number[];
  attributes: DefinitionAttributeRef[];
  missing_attribute_ids: number[];
};

export type DefinitionTrigger = {
  attribute: DefinitionAttributeRef | null;
  option: Record<string, unknown>;
  has_webhook_authorization: boolean;
};

export type DefinitionOmission = {
  section: 'unique_constraints' | 'triggers';
  reason: 'admin_required';
};

export type ModelDefinition = {
  format: typeof MODEL_DEFINITION_FORMAT;
  format_version: typeof MODEL_DEFINITION_VERSION;
  exported_at: string;
  model: {
    id: number;
    name: string;
    alias: string;
    enabled: boolean;
    icon: string | null;
    order: number;
    default_order_attr: string | null;
    unique_key: string | null;
    show_name: string | null;
    parent_ids: number[];
  };
  attributes: DefinitionAttribute[];
  form_sections: DefinitionFormSection[];
  relations: DefinitionRelation[];
  unique_constraints: DefinitionUniqueConstraint[] | null;
  triggers: DefinitionTrigger[] | null;
  sections_omitted: DefinitionOmission[];
};

export type BuildModelDefinitionInput = {
  model: CIType;
  attributes: TypeAttribute[];
  groups: AttributeGroup[];
  childRelations: RelatedType[];
  parentRelations: RelatedType[];
  constraints?: UniqueConstraint[] | null;
  triggers?: Trigger[] | null;
  isAdmin: boolean;
  exportedAt: string;
};

const CARDINALITY: Record<string, DefinitionRelation['cardinality']> = {
  '0': 'one_to_many',
  '1': 'one_to_one',
  '2': 'many_to_many',
};

// These names are credentials or user programs, not model configuration. The
// read DTOs normally redact them; the serializer strips them again because a
// downloaded file travels further than a screen.
const SECRET_KEYS = new Set(['authorization', 'password', 'compute_script', 'choice_web_hook']);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase())) continue;
      out[key] = sanitize(child);
    }
    return out;
  }
  return value;
}

function optionalText(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function attributeRef(id: number, byID: Map<number, { name: string }>): DefinitionAttributeRef {
  return { id, name: byID.get(id)?.name ?? null };
}

function attributeByID(attributes: TypeAttribute[]): Map<number, TypeAttribute> {
  return new Map(attributes.map((attribute) => [attribute.id, attribute]));
}

function toDefinitionAttribute(attribute: TypeAttribute): DefinitionAttribute {
  return {
    id: attribute.id,
    name: attribute.name,
    alias: attribute.alias,
    value_type: attribute.value_type,
    is_choice: Boolean(attribute.is_choice),
    is_list: Boolean(attribute.is_list),
    is_unique: Boolean(attribute.is_unique),
    is_index: Boolean(attribute.is_index),
    is_link: Boolean(attribute.is_link),
    is_password: Boolean(attribute.is_password),
    is_sortable: Boolean(attribute.is_sortable),
    is_dynamic: Boolean(attribute.is_dynamic),
    is_bool: Boolean(attribute.is_bool),
    is_file: Boolean(attribute.is_file),
    is_reference: Boolean(attribute.is_reference),
    reference_type_id: attribute.reference_type_id ?? null,
    default: attribute.default ?? null,
    is_computed: Boolean(attribute.is_computed),
    compute_expr: optionalText(attribute.compute_expr),
    has_compute_script: Boolean(attribute.has_compute_script),
    has_choice_web_hook: Boolean(attribute.has_choice_web_hook),
    has_choice_other: Boolean(attribute.has_choice_other),
    choice_value: attribute.choice_value ?? [],
    re_check: optionalText(attribute.re_check),
    option: attribute.option ?? null,
    binding: {
      is_required: Boolean(attribute.is_required),
      order: attribute.order,
      default_show: Boolean(attribute.default_show),
      inherited: Boolean(attribute.inherited),
      inherited_from: optionalText(attribute.inherited_from),
    },
  };
}

function toDefinitionRelation(
  relation: RelatedType,
  role: DefinitionRelation['other_model_role'],
  currentByID: Map<number, TypeAttribute>,
): DefinitionRelation {
  const remoteByID = new Map(relation.attributes.map((attribute) => [attribute.id, attribute]));
  const parentByID = role === 'child' ? currentByID : remoteByID;
  const childByID = role === 'child' ? remoteByID : currentByID;
  const parentIDs = relation.parent_attr_ids ?? [];
  const childIDs = relation.child_attr_ids ?? [];
  const paired = Math.min(parentIDs.length, childIDs.length);
  const mapping = Array.from({ length: paired }, (_, index) => ({
    parent_attribute: attributeRef(parentIDs[index], parentByID),
    child_attribute: attributeRef(childIDs[index], childByID),
  }));

  return {
    other_model_role: role,
    other_model: {
      id: relation.type.id,
      name: relation.type.name,
      alias: relation.type.alias,
    },
    relation_type: {
      id: relation.relation_type.id,
      name: relation.relation_type.name,
      color: relation.relation_type.color,
    },
    constraint: relation.constraint,
    cardinality: CARDINALITY[relation.constraint] ?? 'unknown',
    show_key: optionalText(relation.show_key),
    attribute_mapping: mapping,
    unpaired_parent_attribute_ids: parentIDs.slice(paired),
    unpaired_child_attribute_ids: childIDs.slice(paired),
  };
}

export function buildModelDefinition(input: BuildModelDefinitionInput): ModelDefinition {
  const {
    model,
    attributes,
    groups,
    childRelations,
    parentRelations,
    constraints,
    triggers,
    isAdmin,
    exportedAt,
  } = input;
  const currentByID = attributeByID(attributes);

  const formSections = groups
    .filter((group) => !group.is_other)
    .map<DefinitionFormSection>((group) => ({
      name: group.name,
      order: group.order,
      inherited: Boolean(group.inherited),
      attribute_ids: (group.attributes ?? []).map((attribute) => attribute.id),
    }));

  const relations = [
    ...childRelations.map((relation) => toDefinitionRelation(relation, 'child', currentByID)),
    ...parentRelations.map((relation) => toDefinitionRelation(relation, 'parent', currentByID)),
  ];

  const uniqueConstraints = (constraints ?? []).map<DefinitionUniqueConstraint>((constraint) => {
    const resolved = constraint.attributes ?? [];
    const knownIDs = new Set(resolved.map((attribute) => attribute.id));
    return {
      attribute_ids: constraint.attr_ids ?? [],
      attributes: resolved.map((attribute) => ({ id: attribute.id, name: attribute.name })),
      missing_attribute_ids: (constraint.attr_ids ?? []).filter((id) => !knownIDs.has(id)),
    };
  });

  const definitionTriggers = (triggers ?? []).map<DefinitionTrigger>((trigger) => ({
    attribute:
      trigger.attr_id == null
        ? null
        : {
            id: trigger.attr_id,
            name: currentByID.get(trigger.attr_id)?.name ?? null,
          },
    option: sanitize(trigger.option ?? {}) as Record<string, unknown>,
    has_webhook_authorization: Boolean(trigger.has_webhook_authorization),
  }));

  const sectionsOmitted: DefinitionOmission[] = isAdmin
    ? []
    : [
        { section: 'unique_constraints', reason: 'admin_required' },
        { section: 'triggers', reason: 'admin_required' },
      ];

  return {
    format: MODEL_DEFINITION_FORMAT,
    format_version: MODEL_DEFINITION_VERSION,
    exported_at: exportedAt,
    model: {
      id: model.id,
      name: model.name,
      alias: model.alias,
      enabled: Boolean(model.enabled),
      icon: model.icon ?? null,
      order: model.order,
      default_order_attr: model.default_order_attr ?? null,
      unique_key: model.unique_key ?? null,
      show_name: model.show_name ?? null,
      parent_ids: model.parent_ids ?? [],
    },
    attributes: attributes.map(toDefinitionAttribute),
    form_sections: formSections,
    relations,
    unique_constraints: isAdmin ? uniqueConstraints : null,
    triggers: isAdmin ? definitionTriggers : null,
    sections_omitted: sectionsOmitted,
  };
}
