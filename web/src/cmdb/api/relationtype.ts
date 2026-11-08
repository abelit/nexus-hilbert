// The relation-type dictionary (`c_relation_types`).
//
// IT IS THE SMALLEST MODULE IN THE CONSOLE and the first one ported, which makes
// it the place the shared layer is proven against a real endpoint rather than
// against a fixture.

import { cmdbDelete, cmdbGet, cmdbPost, cmdbPut, type ListResponse } from './http';

/** One relation type, as the API presents it. */
export type RelationType = {
  id: number;
  name: string;
  /** A `#rrggbb` colour the topology draws the edge in, or ''. */
  color: string;

  // Read-only mirror of nexus-topocortex's RelationTypeInfo. The console shows
  // these so an operator can see what an edge means; the write form below
  // deliberately does not accept them.
  category: string;
  direction: string;
  propagates_default: boolean;
  weight_default: number;
  inverse_of: string;
  transitive: boolean;
  sub_property_of: string[] | null;
  display_name_zh: string;
  display_name_en: string;
  description: string;
  deprecated: boolean;
  replacement: string;
  revision: number;
  display_name_override: string;

  created_at?: string;
  updated_at?: string;
};

export type RelationTypeInput = {
  name: string;
  color: string;
};

export async function listRelationTypes(): Promise<RelationType[]> {
  const got = await cmdbGet<ListResponse<RelationType>>('/relation-types');
  return got.items ?? [];
}

export function createRelationType(input: RelationTypeInput): Promise<RelationType> {
  return cmdbPost<RelationType>('/relation-types', input);
}

export function updateRelationType(id: number, input: RelationTypeInput): Promise<RelationType> {
  return cmdbPut<RelationType>(`/relation-types/${id}`, input);
}

export function deleteRelationType(id: number): Promise<void> {
  return cmdbDelete(`/relation-types/${id}`);
}
