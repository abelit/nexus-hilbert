import type { CIType } from '../api/citype';
import type { ModelGroup } from '../api/preferences';

// Shared model groups → sections for the model list.
//
// THE GROUPS ARE A SEPARATE SNAPSHOT FROM THE MODELS. A group names model ids;
// the page owns the fresh model rows. Joining here (rather than rendering the
// `ci_types` objects embedded in the group response) keeps `enabled`, `order`
// and `alias` current after an inline edit or toggle.
//
// ONE MODEL BELONGS TO ONE GROUP, BUT THE WIRE DOES NOT ENFORCE IT. The normal
// write path removes a model from any other group, yet a direct database insert
// can leave two membership rows and the backend then returns the model in both
// groups. The first group in the API order wins here, so every visible model
// appears exactly once and the section counts add up.
//
// THE SERVER'S "OTHER" BUCKET IS NOT USED. `/preferences/model-groups` defaults
// `include_ungrouped` to false; if it were true, its bucket would be computed
// from the full model set rather than the page's filtered set. The page appends
// its own trailing bucket after applying search and the enabled filter.

export type ModelGroupLabels = {
  other: string;
  all: string;
  unnamed: string;
};

export type ModelGroupSection = {
  key: string;
  name: string;
  isOther?: boolean;
  rows: CIType[];
};

/** The same order the flat list uses, so switching modes does not reorder rows. */
function compareModels(left: CIType, right: CIType): number {
  return left.order - right.order || left.name.localeCompare(right.name);
}

export function groupModels(
  models: CIType[],
  groups: ModelGroup[],
  labels: ModelGroupLabels,
): ModelGroupSection[] {
  if (models.length === 0) return [];

  const realGroups = groups.filter((group) => !group.is_other);
  if (realGroups.length === 0) {
    return [{ key: 'all', name: labels.all, rows: [...models].sort(compareModels) }];
  }

  const byID = new Map(models.map((model) => [model.id, model]));
  const claimed = new Set<number>();
  const sections: ModelGroupSection[] = [];

  realGroups.forEach((group, index) => {
    const rows: CIType[] = [];
    for (const member of group.ci_types ?? []) {
      const model = byID.get(member.id);
      if (!model || claimed.has(model.id)) continue;
      claimed.add(model.id);
      rows.push(model);
    }
    if (rows.length === 0) return;
    rows.sort(compareModels);
    sections.push({
      key: group.id != null ? `g-${group.id}` : `g-anon-${index}`,
      name: group.name?.trim() || labels.unnamed,
      rows,
    });
  });

  const rest = models.filter((model) => !claimed.has(model.id)).sort(compareModels);
  if (rest.length > 0) {
    sections.push({ key: 'other', name: labels.other, isOther: true, rows: rest });
  }

  return sections;
}
