import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/locale';

import { listAttributeGroups, listTypeAttributes, type AttributeGroup, type CIType, type TypeAttribute } from '../api/citype';
import { describeError } from '../api/http';
import { Drawer } from './Drawer';
import { InstanceDetailDrawer } from './instance-detail/InstanceDetailDrawer';

/**
 * The instance drawer opened from a cross-model search result.
 *
 * The search result carries the model name but not that model's attribute
 * definitions. Load them first, then hand the same props the resource-data page
 * uses to the shared detail drawer. A loading shell keeps the click responsive.
 */
export function SearchInstanceDrawer({
  ciID,
  title,
  model,
  models,
  onClose,
  onSaved,
}: {
  ciID: number;
  title: string;
  model: CIType;
  models: CIType[];
  onClose(): void;
  onSaved?(): void;
}) {
  const { tr } = useI18n();
  const [attributes, setAttributes] = useState<TypeAttribute[] | null>(null);
  const [groups, setGroups] = useState<AttributeGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    setAttributes(null);
    setError(null);
    void Promise.all([
      listTypeAttributes(model.name),
      listAttributeGroups(model.name, false).catch(() => [] as AttributeGroup[]),
    ])
      .then(([got, gotGroups]) => {
        if (!live) return;
        setAttributes(got.attributes ?? []);
        setGroups(gotGroups);
      })
      .catch((caught) => {
        if (live) setError(describeError(caught, tr('无法读取模型属性', 'Could not load the model attributes')));
      });
    return () => {
      live = false;
    };
  }, [model.name, retry, tr]);

  if (attributes) {
    return (
      <InstanceDetailDrawer
        model={model}
        models={models}
        attributes={attributes}
        groups={groups}
        instanceID={ciID}
        onClose={onClose}
        onInstanceSaved={onSaved}
      />
    );
  }

  return (
    <Drawer open onClose={onClose} title={title} description={model.alias || model.name} size="lg">
      {error ? (
        <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-xs text-red-600 dark:text-red-300">
          <span className="break-words">{error}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => setRetry((value) => value + 1)}>
            <RefreshCw size={12} aria-hidden="true" />
            {tr('重试', 'Retry')}
          </Button>
        </div>
      ) : (
        <div className="flex h-40 items-center justify-center gap-2 text-xs text-text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {tr('加载中…', 'Loading…')}
        </div>
      )}
    </Drawer>
  );
}
