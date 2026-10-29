import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/locale';

import { describeError } from '../../api/http';
import { listTypeAttributes, type CIType, type TypeAttribute } from '../../api/citype';
import { getInstance, type Instance } from '../../api/instance';
import { getShowFields } from '../../api/preferences';
import { AttributeValue } from '../AttributeControl';
import { CMDBIcon } from '../CMDBIcon';
import { choiceText } from '../../lib/choice-labels';
import { isEmptyValue, isValueTypeCode } from '../../lib/valuetype';

// The card a topology node opens.
//
// CANTOR'S TIP CARD IS THE REFERENCE: the graph stays visible, the node keeps
// its selected ring, and the card shows the columns the operator subscribed to
// for that model. A missing subscription falls back to the model's default
// columns so a node is never a dead end. The full resource drawer is one click
// away — this card is a peek, not a second detail editor.

export type TopologySelectedNode = {
  id: number;
  typeID: number;
  name: string;
};

export function TopologyNodeCard({
  node,
  model,
  onClose,
}: {
  node: TopologySelectedNode;
  model: CIType;
  onClose(): void;
}) {
  const { tr } = useI18n();
  const navigate = useNavigate();
  const [instance, setInstance] = useState<Instance | null>(null);
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setInstance(null);
    void Promise.all([
      getInstance(node.id),
      listTypeAttributes(model.name),
      getShowFields(model.name).catch(() => null),
    ])
      .then(([got, attrs, show]) => {
        if (!live) return;
        const list = attrs.attributes ?? [];
        const byID = new Map(list.map((attribute) => [attribute.id, attribute]));
        const subscribed = (show?.fields ?? [])
          .map((field) => (field.attr_id ? byID.get(field.attr_id) : undefined))
          .filter((attribute): attribute is TypeAttribute => Boolean(attribute));
        const fallback = list.filter((attribute) => attribute.default_show);
        setInstance(got);
        setAttributes(subscribed.length > 0 ? subscribed : fallback.length > 0 ? fallback : list.slice(0, 8));
      })
      .catch((caught) => {
        if (live) setError(describeError(caught, tr('无法读取实例', 'Could not load the instance')));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [node.id, model.name, tr]);

  const rows = useMemo(
    () =>
      attributes
        .map((attribute) => ({ attribute, value: instance?.values?.[attribute.name] }))
        .filter(({ value }) => !isEmptyValue(value))
        .slice(0, 12),
    [attributes, instance],
  );

  return (
    <aside
      aria-label={tr('节点详情', 'Node details')}
      className="absolute end-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
    >
      <div className="flex items-center gap-2 border-b border-border/60 bg-card/95 px-3 py-2.5">
        <CMDBIcon value={model.icon} size={18} label={model.alias || model.name} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xs font-semibold text-text" title={node.name}>
            {node.name}
          </h3>
          <p className="truncate text-[10px] text-text-faint">
            {model.alias || model.name} · #{node.id}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('关闭节点详情', 'Close node details')}
          title={tr('关闭', 'Close')}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-text-faint hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto px-3 py-1.5">
        {loading ? (
          <p className="flex items-center justify-center gap-1.5 py-6 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {tr('加载中…', 'Loading…')}
          </p>
        ) : error ? (
          <p role="alert" className="py-4 text-center text-xs text-red-600 dark:text-red-300">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-text-muted">
            {tr('没有可显示的属性', 'No attribute to show')}
          </p>
        ) : (
          rows.map(({ attribute, value }) => (
            <div
              key={attribute.id}
              className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 border-b border-border/40 py-1.5 text-xs last:border-0"
            >
              <span className="truncate text-[11px] text-text-faint" title={attribute.alias || attribute.name}>
                {attribute.alias || attribute.name}
              </span>
              <span className="min-w-0 break-words text-text">
                {attribute.is_password ? (
                  '••••••'
                ) : (
                  <AttributeValue
                    type={isValueTypeCode(attribute.value_type) ? attribute.value_type : '2'}
                    value={value}
                    label={choiceText(attribute, value)}
                  />
                )}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border/60 p-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() =>
            navigate(`/cmdb/instances?type=${encodeURIComponent(model.name)}&ci=${node.id}`)
          }
          className="inline-flex w-full items-center justify-center gap-1.5"
        >
          <ExternalLink size={12} aria-hidden="true" />
          {tr('在资源数据中查看', 'Open in resources')}
        </Button>
      </div>
    </aside>
  );
}
