import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Copy, Languages, PanelsTopLeft, Pencil, RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/i18n/locale';
import { openAssistant } from '@/lib/assistantIntent';
import { cn } from '@/lib/cn';

import type { AttributeGroup, CIType, TypeAttribute } from '../../api/citype';
import type { Instance } from '../../api/instance';
import { AttributeValue } from '../AttributeControl';
import { FileField } from '../files/FileField';
import { useToast } from '../Toast';
import { attributeSections } from '../../lib/attribute-sections';
import { explainValuePrompt, translateValuePrompt } from '../../lib/aiPrompts';
import { choiceText } from '../../lib/choice-labels';
import { referenceRawText, referenceText, useReferenceLabels } from '../../lib/reference-labels';
import { displayValue, isValueTypeCode } from '../../lib/valuetype';
import { AttributeInlineEditor } from './AttributeInlineEditor';
import { InstanceRelations } from './InstanceRelations';

// The read-only side of an instance. It is deliberately not the edit form with
// disabled inputs: disabled controls still announce themselves as form fields,
// and a detail view is a definition list an operator scans, not a form they
// think they can change.

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// A row action is a plain icon, like the inline-edit pencil: no bordered
// button competing with the value. The whole group is revealed by the row's
// hover / focus rule in styles.css.
function RowActionButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="shrink-0 rounded p-0.5 text-text-faint transition-colors hover:text-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function InstanceOverview({
  model,
  models,
  instance,
  attributes,
  groups,
  loading,
  error,
  onRetry,
  onSaveValue,
  readOnly = false,
}: {
  model: CIType;
  models: CIType[];
  instance: Instance | null;
  attributes: TypeAttribute[];
  groups: AttributeGroup[];
  loading: boolean;
  error: string | null;
  onRetry(): void;
  /** Writes one attribute; omitted for a surface that must stay read-only. */
  onSaveValue?(name: string, value: unknown): Promise<void>;
  /** Hides the relation add affordance as well as the inline editors. */
  readOnly?: boolean;
}) {
  const { tr, locale } = useI18n();
  const toast = useToast();
  const referenceLabels = useReferenceLabels(instance ? [instance] : [], attributes, models);
  const [editing, setEditing] = useState<string | null>(null);
  const [savingName, setSavingName] = useState<string | null>(null);

  const copyValue = useCallback(
    async (text: string) => {
      if (!navigator.clipboard?.writeText) {
        toast.error(
          tr('当前浏览器不支持自动复制，请手动选择复制。', 'Copy is unavailable in this browser; select the value manually.'),
        );
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast.success(tr('已复制', 'Copied'));
      } catch {
        toast.error(tr('复制失败，请手动复制。', 'Could not copy; select the value manually.'));
      }
    },
    [toast, tr],
  );

  // A different resource (or a switch from the topology) starts with no row
  // left in edit mode; a stale draft must never be saved to the new instance.
  useEffect(() => {
    setEditing(null);
    setSavingName(null);
  }, [instance?.ci_id]);

  const editable = (attribute: TypeAttribute) =>
    Boolean(onSaveValue) && !attribute.is_computed && !attribute.is_password && !attribute.is_file;

  if (loading && !instance) {
    return <p className="py-8 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>;
  }
  if (error && !instance) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
        <span className="min-w-0 flex-1 break-words">{error}</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-card hover:text-text"
        >
          {tr('重试', 'Retry')}
        </button>
      </div>
    );
  }
  if (!instance) return null;

  const sections = attributeSections(attributes, groups, tr('其他', 'Other'));

  return (
    <div className="flex flex-col gap-4">
      {/* The same card header as 关联关系: an operator reads the two sections of
          this tab as one family, so the icon, title, count and refresh action
          keep the identical shape. */}
      <section className="overflow-hidden rounded-xl border border-border bg-card/40">
        <header className="flex flex-wrap items-center gap-2 border-b border-border bg-bg/30 px-4 py-2.5">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-sky-500/10 text-sky-500">
            <PanelsTopLeft size={13} aria-hidden="true" />
          </span>
          <h3 className="text-xs font-semibold text-text">{tr('属性', 'Attributes')}</h3>
          <span className="font-mono text-[11px] text-text-faint">{attributes.length}</span>
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={onRetry}
            disabled={loading}
            className="cmdb-liquid-plain-action ml-auto inline-flex items-center gap-1 text-[11px]"
          >
            <RefreshCw size={11} aria-hidden="true" />
            {tr('刷新', 'Refresh')}
          </Button>
        </header>
        <div className="p-3">
          {sections.length === 0 ? (
            <EmptyState
              className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
              title={tr('这个模型没有属性', 'This model has no attributes')}
              hint={tr('在模型配置中绑定属性后，实例详情会在这里显示。', 'Bind attributes in model configuration and they will appear here.')}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {sections.map((section) => (
          <section key={section.key}>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-text">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden="true" />
              {section.name || tr('未命名分组', 'Untitled section')}
            </h3>
            <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border/60 sm:grid-cols-2">
              {section.items.map((attribute, index) => {
                const type = isValueTypeCode(attribute.value_type) ? attribute.value_type : '2';
                const value = instance.values?.[attribute.name];
                const label = attribute.is_reference
                  ? referenceText(value, referenceLabels)
                  : choiceText(attribute, value);
                const raw = attribute.is_reference ? referenceRawText(value) : displayValue(value);
                const oddLast = section.items.length % 2 === 1 && index === section.items.length - 1;
                const editingRow = editing === attribute.name;
                const attributeLabel = attribute.alias || attribute.name;
                const hasValue =
                  !attribute.is_password && !attribute.is_file && Boolean(valueText(value).trim());
                return (
                  <div
                    key={attribute.id}
                    className={cn(
                      'cmdb-attribute-row grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-2 bg-card/40 px-3 py-2.5',
                      oddLast && 'sm:col-span-2',
                    )}
                  >
                    <dt className="min-w-0 text-[11px] text-text-muted">
                      <span className="break-words">
                        {attribute.alias || attribute.name}
                        {attribute.is_required && <span className="ml-1 text-rose-500" aria-hidden="true">*</span>}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-text-faint/80">{attribute.name}</span>
                    </dt>
                    <dd className="min-w-0 break-words text-xs text-text">
                      {attribute.is_file ? (
                        <FileField
                          attribute={attribute}
                          value={value}
                          // The field has its own view-only mode: it hides
                          // upload/delete but keeps preview and download.
                          // `disabled` would block the trigger entirely, which
                          // is the opposite of a read-only peek.
                          readOnly={readOnly || !onSaveValue}
                          disabled={attribute.is_computed}
                          onChange={
                            readOnly || !onSaveValue
                              ? undefined
                              : (_files, serialized) => {
                                  void onSaveValue?.(attribute.name, serialized);
                                }
                          }
                        />
                      ) : editingRow ? (
                        <AttributeInlineEditor
                          attribute={attribute}
                          value={value}
                          models={models}
                          labels={referenceLabels}
                          onSave={(next) =>
                            onSaveValue ? onSaveValue(attribute.name, next) : Promise.resolve()
                          }
                          onDone={() => setEditing((current) => (current === attribute.name ? null : current))}
                          onCancel={() => setEditing((current) => (current === attribute.name ? null : current))}
                          onBusyChange={(busy) => setSavingName(busy ? attribute.name : null)}
                        />
                      ) : (
                        <div className="flex min-w-0 items-start gap-1">
                          <span className="min-w-0 flex-1 break-words">
                            {attribute.is_password ? (
                              <span className="text-text-faint" title={tr('密码值不会通过读接口返回', 'Password values are not returned by read endpoints')}>
                                ••••••
                              </span>
                            ) : (
                              <AttributeValue
                                type={type}
                                value={value}
                                label={label}
                                title={label && label !== raw ? `${label} (${raw})` : undefined}
                              />
                            )}
                            {attribute.is_computed && (
                              <Chip dense className="ml-2">
                                {tr('计算属性', 'Computed')}
                              </Chip>
                            )}
                          </span>
                          {(hasValue || editable(attribute)) && (
                            <span className="cmdb-attribute-actions flex shrink-0 items-center gap-0.5">
                              {hasValue && (
                                <>
                                  <RowActionButton
                                    label={tr(`AI 解读 ${attributeLabel}`, `AI explain ${attributeLabel}`)}
                                    onClick={() =>
                                      openAssistant({
                                        prompt: explainValuePrompt(
                                          valueText(value),
                                          `${attributeLabel} (${attribute.name})`,
                                        ),
                                      })
                                    }
                                  >
                                    <Sparkles size={11} aria-hidden="true" />
                                  </RowActionButton>
                                  <RowActionButton
                                    label={tr(`AI 翻译 ${attributeLabel}`, `AI translate ${attributeLabel}`)}
                                    onClick={() =>
                                      openAssistant({
                                        prompt: translateValuePrompt(
                                          valueText(value),
                                          locale.toLowerCase().startsWith('zh') ? 'en' : 'zh',
                                          `${attributeLabel} (${attribute.name})`,
                                        ),
                                      })
                                    }
                                  >
                                    <Languages size={11} aria-hidden="true" />
                                  </RowActionButton>
                                  <RowActionButton
                                    label={tr(`复制 ${attributeLabel}`, `Copy ${attributeLabel}`)}
                                    onClick={() => void copyValue(label || raw)}
                                  >
                                    <Copy size={11} aria-hidden="true" />
                                  </RowActionButton>
                                </>
                              )}
                              {editable(attribute) && (
                                <RowActionButton
                                  label={tr(`编辑 ${attributeLabel}`, `Edit ${attributeLabel}`)}
                                  onClick={() => setEditing(attribute.name)}
                                  // While a row writes itself, another pencil
                                  // would start a second draft before the first settles.
                                  disabled={savingName !== null}
                                >
                                  <Pencil size={11} aria-hidden="true" />
                                </RowActionButton>
                              )}
                            </span>
                          )}
                        </div>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
                </section>
              ))}
            </div>
          )}
        </div>
      </section>

      <InstanceRelations ciID={instance.ci_id} modelRef={model.name} models={models} readOnly={readOnly} />
    </div>
  );
}
