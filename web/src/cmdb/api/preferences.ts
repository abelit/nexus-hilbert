// The preferences: how one operator sees the CMDB, and the shared service-tree
// definitions.
//
// THE TWO HALVES HAVE DIFFERENT OWNERSHIP. A subscription is per user — "which
// columns do I see on this model" — and is not admin-gated. A service-tree
// definition is shared configuration that every operator's tree page reads, and
// it is. Cantor drew the same line, and it is the only reason one of these pages
// has no permission gate.

import { cmdbDelete, cmdbGet, cmdbPost, cmdbPut, type ListResponse } from './http';
import type { CIType } from './citype';

// --- service-tree definitions (`c_prv`) ---

/**
 * One edge of a tree definition: the parent model and the child model.
 *
 * THE PAIRS ARE THE SHAPE. A definition says "this model may sit under that
 * one"; the resource tree is then built by walking real instance relations along
 * those edges. It is deliberately NOT a list of instances — the instances change
 * every hour and the shape does not.
 */
export type TypePair = { parent_id: number; child_id: number };

export type ServiceTree = {
  id: number;
  name: string;
  is_public: boolean;
  option?: Record<string, unknown>;
  /** The stored pairs, whether or not every one of them still resolves. */
  pairs: TypePair[];
  /** The rendered tree, omitted when the definition no longer resolves. */
  tree?: unknown;
};

export type ServiceTreeInput = {
  name: string;
  cr_ids: TypePair[];
  is_public: boolean;
  option?: Record<string, unknown>;
};

export function listServiceTrees(): Promise<ServiceTree[]> {
  return cmdbGet<ListResponse<ServiceTree>>('/preferences/service-trees').then((got) => got.items ?? []);
}

export function createServiceTree(input: ServiceTreeInput): Promise<ServiceTree> {
  return cmdbPost<ServiceTree>('/preferences/service-trees', input);
}

export function updateServiceTree(id: number, input: ServiceTreeInput): Promise<ServiceTree> {
  return cmdbPut<ServiceTree>(`/preferences/service-trees/${id}`, input);
}

export function deleteServiceTree(id: number): Promise<void> {
  return cmdbDelete(`/preferences/service-trees/${id}`);
}

// --- subscriptions (`c_psa` / `c_pcto` / `c_pasc`) ---

/** One column an operator has chosen to see. */
export type SubscribedField = {
  attr_id?: number;
  name?: string;
  alias?: string;
  value_type?: string;
  is_indexed?: boolean;
  /** A built-in column (`_id`, `_updated_at` …) rather than a model attribute. */
  builtin?: string;
  /** The identifying column, pinned first because a row without it is unlabelled. */
  is_fixed: boolean;
};

export type ShowAttributes = {
  type_id: number;
  is_subscribed: boolean;
  fields: SubscribedField[];
};

export type ModelGroup = {
  id?: number;
  name?: string;
  ci_types: CIType[];
  /** The trailing bucket for models in no group. */
  is_other?: boolean;
};

export type SubscribedModels = {
  groups: ModelGroup[];
  type_ids: number[];
};

export function listSubscribedModels(): Promise<SubscribedModels> {
  return cmdbGet<SubscribedModels>('/preferences/ci-types');
}

export function getShowFields(ref: string | number): Promise<ShowAttributes> {
  return cmdbGet<ShowAttributes>(`/preferences/ci-types/${encodeURIComponent(String(ref))}/fields`);
}

/**
 * Replaces a model's visible columns.
 *
 * A FULL REPLACE, because the console's column picker is one form whose save is
 * the whole set. `is_fixed` marks the column that must stay: the identifying one.
 */
export function setShowFields(
  ref: string | number,
  fields: Array<{ ref: string; is_fixed: boolean }>,
): Promise<ShowAttributes> {
  return cmdbPut<ShowAttributes>(`/preferences/ci-types/${encodeURIComponent(String(ref))}/fields`, { fields });
}

export function setModelOrder(typeIDs: number[], isTree = false): Promise<unknown> {
  return cmdbPut('/preferences/ci-types/order', { type_ids: typeIDs, is_tree: isTree });
}

export type AutoSubscription = {
  base_strategy: string;
  group_ids: number[];
  type_ids: number[];
  enabled: boolean;
  description?: string;
};

export function getAutoSubscription(): Promise<AutoSubscription> {
  return cmdbGet<AutoSubscription>('/preferences/auto-subscription');
}

export function setAutoSubscription(input: Partial<AutoSubscription>): Promise<AutoSubscription> {
  return cmdbPut<AutoSubscription>('/preferences/auto-subscription', input);
}

export function deleteAutoSubscription(): Promise<void> {
  return cmdbDelete('/preferences/auto-subscription');
}
