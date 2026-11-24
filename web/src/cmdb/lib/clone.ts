// The values a clone starts from.
//
// IDENTITY AND ATTACHMENTS DO NOT COPY. A clone is a new row, so the model's
// identifying attribute and every attribute marked unique start empty —
// copying them would make the create fail as a duplicate and leave the
// operator hunting for the one field that must change. Files are shared
// records whose cleanup deletes by reference, so copying one would tie two
// instances to the same attachment; secrets are never read back at all, and
// computed values are derived by the model rather than typed in the form.

import type { TypeAttribute } from '../api/citype';

type CloneAttribute = Pick<TypeAttribute, 'name'> &
  Partial<Pick<TypeAttribute, 'is_unique' | 'is_file' | 'is_password' | 'is_computed'>>;

export function cloneDraft(
  values: Record<string, unknown>,
  uniqueKey: string | undefined,
  attributes: CloneAttribute[],
): Record<string, unknown> {
  const dropped = new Set<string>();
  if (uniqueKey) dropped.add(uniqueKey);
  for (const attribute of attributes) {
    if (attribute.is_unique || attribute.is_file || attribute.is_password || attribute.is_computed) {
      dropped.add(attribute.name);
    }
  }
  return Object.fromEntries(Object.entries(values).filter(([name]) => !dropped.has(name)));
}
