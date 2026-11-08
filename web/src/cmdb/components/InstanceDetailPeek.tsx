import { useEffect, useState } from 'react';

import { useI18n } from '@/i18n/locale';

import {
  listAttributeGroups,
  listCITypes,
  listTypeAttributes,
  type AttributeGroup,
  type CIType,
  type TypeAttribute,
} from '../api/citype';
import { describeError } from '../api/http';
import { Drawer } from './Drawer';
import { ToastProvider } from './Toast';
import { InstanceDetailDrawer } from './instance-detail/InstanceDetailDrawer';

// The assistant's read-only view of one CI.
//
// The console's drawer expects the model, the full model list, the attribute
// schema and the attribute groups. A graph node only knows the CI id and its
// model id, so this wrapper resolves the metadata first and then hands the
// real drawer a `readOnly` surface. It also supplies the ToastProvider the
// console's page shell normally provides: the drawer, relations and file
// fields call useToast().

type Loaded = {
  model: CIType;
  models: CIType[];
  attributes: TypeAttribute[];
  groups: AttributeGroup[];
};

export function InstanceDetailPeek({
  instanceID,
  typeID,
  onClose,
}: {
  instanceID: number;
  typeID?: number;
  onClose(): void;
}) {
  const { tr } = useI18n();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setError(null);

    void (async () => {
      try {
        const models = await listCITypes();
        if (models.length === 0) {
          throw new Error(tr('没有可用的模型', 'No model available'));
        }
        const wanted = typeID == null ? null : Number(typeID);
        const model =
          (wanted == null ? undefined : models.find((item) => Number(item.id) === wanted)) ??
          models[0];
        const [attributes, groups] = await Promise.all([
          listTypeAttributes(model.id),
          listAttributeGroups(model.id),
        ]);
        if (!live) return;
        setLoaded({
          model,
          models,
          attributes: attributes.attributes ?? [],
          groups,
        });
      } catch (err) {
        if (!live) return;
        setError(
          describeError(err, tr('无法加载资源详情', 'Could not load the resource detail')),
        );
      }
    })();

    return () => {
      live = false;
    };
  }, [instanceID, typeID, tr]);

  return (
    <ToastProvider>
      {loaded ? (
        <InstanceDetailDrawer
          model={loaded.model}
          models={loaded.models}
          attributes={loaded.attributes}
          groups={loaded.groups}
          instanceID={instanceID}
          onClose={onClose}
          readOnly
        />
      ) : (
        <Drawer open onClose={onClose} title={tr('资源详情', 'Resource detail')}>
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : (
            <p className="text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>
          )}
        </Drawer>
      )}
    </ToastProvider>
  );
}
