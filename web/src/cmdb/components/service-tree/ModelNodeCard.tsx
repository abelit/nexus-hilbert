import { useEffect, useState } from 'react';
import { Boxes, Database, Loader2, RefreshCw, Type, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/locale';

import { listTypeAttributes, type CIType, type TypeAttribute } from '../../api/citype';
import { describeError } from '../../api/http';
import { ATTRIBUTE_TYPE_META, attributeDisplayType } from '../../lib/attribute-type';
import { CMDBIcon } from '../CMDBIcon';

// The peek card a model node opens on the relation canvas.
//
// The graph stays visible, the node keeps its highlight, and the card lists the
// model's attributes in binding order. The two footer actions are the two
// places an operator goes next: the model's instances, or its configuration.
// This is a preview, not a second editor.

export function ModelNodeCard({
  model,
  onClose,
}: {
  model: CIType;
  onClose(): void;
}) {
  const { tr } = useI18n();
  const navigate = useNavigate();
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void listTypeAttributes(model.name)
      .then((got) => {
        if (!live) return;
        setAttributes([...(got.attributes ?? [])].sort((left, right) => left.order - right.order));
      })
      .catch((caught) => {
        if (live) setError(describeError(caught, tr('无法读取模型属性', 'Could not load model attributes')));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [model.name, retry, tr]);

  return (
    <aside
      aria-label={tr('模型详情', 'Model details')}
      className="absolute end-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex items-center gap-2 border-b border-border/60 bg-card/95 px-3 py-2.5">
        <CMDBIcon value={model.icon} size={18} label={model.alias || model.name} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xs font-semibold text-text" title={model.alias || model.name}>
            {model.alias || model.name}
          </h3>
          <p className="truncate text-[10px] text-text-faint" title={model.name}>
            {model.name}
            {model.unique_key ? ` · ${model.unique_key}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('关闭模型详情', 'Close model details')}
          title={tr('关闭', 'Close')}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-text-faint hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <span className="text-[10px] font-medium text-text-faint">{tr('属性', 'Attributes')}</span>
        <span className="rounded-full bg-bg px-1.5 py-0.5 text-[10px] leading-none text-text-muted">
          {loading ? '…' : attributes.length}
        </span>
      </div>

      <div className="min-h-0 overflow-y-auto px-3 py-1">
        {loading ? (
          <p className="flex items-center justify-center gap-1.5 py-6 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {tr('加载中…', 'Loading…')}
          </p>
        ) : error ? (
          <div role="alert" className="flex flex-col items-center gap-2 py-4 text-center text-xs text-red-600 dark:text-red-300">
            <span className="break-words">{error}</span>
            <Button variant="ghost" size="sm" type="button" onClick={() => setRetry((value) => value + 1)}>
              <RefreshCw size={12} aria-hidden="true" />
              {tr('重试', 'Retry')}
            </Button>
          </div>
        ) : attributes.length === 0 ? (
          <p className="py-4 text-center text-xs text-text-muted">
            {tr('该模型还没有属性', 'This model has no attributes yet')}
          </p>
        ) : (
          <ul>
            {attributes.map((attribute) => {
              const displayType = attributeDisplayType(attribute);
              const meta = displayType ? ATTRIBUTE_TYPE_META[displayType] : null;
              const Icon = meta?.icon ?? Type;
              return (
                <li
                  key={attribute.id}
                  className="flex items-center gap-2 border-b border-border/40 py-1.5 text-xs last:border-0"
                >
                  <Icon size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
                  <span
                    className="min-w-0 flex-1 truncate text-text"
                    title={`${attribute.alias || attribute.name} (${attribute.name})`}
                  >
                    {attribute.alias || attribute.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-text-faint">
                    {meta ? tr(meta.label[0], meta.label[1]) : attribute.value_type}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-border/60 p-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => navigate(`/cmdb/instances?type=${encodeURIComponent(model.name)}`)}
          className="inline-flex items-center justify-center gap-1.5"
        >
          <Database size={12} aria-hidden="true" />
          {tr('资源数据', 'Resources')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => navigate(`/cmdb/models/${model.id}?tab=attributes`)}
          className="inline-flex items-center justify-center gap-1.5"
        >
          <Boxes size={12} aria-hidden="true" />
          {tr('模型配置', 'Model config')}
        </Button>
      </div>
    </aside>
  );
}
