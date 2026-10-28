import { useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/i18n/locale';

import type { AttributeGroup, CIType, TypeAttribute } from '../../api/citype';
import { getInstance } from '../../api/instance';
import { attributeSections } from '../../lib/attribute-sections';
import {
  attributeDisplay,
  attributeLabel,
  type RackRow,
} from '../../lib/dcim';
import { referenceText, useReferenceLabels } from '../../lib/reference-labels';
import { AttributeValue } from '../AttributeControl';

// A rack's own attributes, grouped the way its model is configured. The rack
// row from the room listing already carries the readable values; the instance
// read fills in anything unindexed before the tab paints.
export function RackAttrsTab({
  rack,
  attributes,
  groups,
  models,
}: {
  rack: RackRow;
  attributes: TypeAttribute[];
  groups: AttributeGroup[];
  models: CIType[];
}) {
  const { tr } = useI18n();
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...rack.row }));

  useEffect(() => {
    let live = true;
    setValues({ ...rack.row });
    void getInstance(rack.id)
      .then((got) => {
        if (live) setValues({ ...rack.row, ...(got.values ?? {}) });
      })
      .catch(() => {
        // The listing row is already a usable read; a failed enrichment stays
        // with what the table showed rather than blanking the tab.
      });
    return () => {
      live = false;
    };
  }, [rack]);

  const sections = useMemo(
    () => attributeSections(attributes, groups, tr('其他', 'Other')),
    [attributes, groups, tr],
  );
  const referenceLabels = useReferenceLabels([{ values }], attributes, models);

  if (attributes.length === 0) {
    return <p className="py-8 text-center text-xs text-text-muted">{tr('这个模型还没有属性', 'This model has no attributes')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => (
        <section key={section.key} className="rounded-md border border-border">
          <h4 className="border-b border-border px-3 py-2 text-xs font-medium text-text">{section.name}</h4>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-3 py-2 sm:grid-cols-2 2xl:grid-cols-3">
            {section.items.map((attribute) => {
              const value = values[attribute.name];
              const label = attribute.is_reference
                ? referenceText(value, referenceLabels)
                : attribute.is_choice
                  ? attributeDisplay(attribute, value)
                  : undefined;
              const raw = attribute.is_password
                ? value == null || value === ''
                  ? '—'
                  : '••••••'
                : attributeDisplay(attribute, value);
              const text = label ?? raw;
              return (
                <div key={`${attribute.id}-${attribute.name}`} className="flex min-w-0 items-start gap-2 text-xs">
                  <dt className="w-24 shrink-0 truncate text-text-faint" title={attributeLabel(attribute)}>
                    {attributeLabel(attribute)}
                  </dt>
                  <dd className="min-w-0 flex-1 truncate text-text" title={text}>
                    {attribute.is_password ? (
                      text
                    ) : (
                      <AttributeValue
                        type={['0', '1', '2', '3', '4', '5', '6', '7'].includes(attribute.value_type) ? (attribute.value_type as '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7') : '2'}
                        value={value}
                        label={label}
                      />
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}
