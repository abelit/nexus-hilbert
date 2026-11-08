import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { cmdbFormAssist, type CMDBFormAssistResponse, type CMDBFormAttributeSuggestion } from '@/api/aiops';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Label } from '@/components/ui/Label';
import { Textarea } from '@/components/ui/Textarea';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import { VALUE_TYPE_LABELS, isValueTypeCode } from '../lib/valuetype';
import { relationConstraintLabel } from '../lib/relation';

// AI form assist for the three CMDB forms.
//
// IT PROPOSES, THE OPERATOR DECIDES. Nothing here writes to CMDB: accepting a
// suggestion only fills the form, and the existing submit path still performs
// the write with the operator's own permissions. A field that already has a
// value is unchecked by default, so "帮助填写" cannot silently overwrite a
// value someone typed on purpose.
//
// The backend owns the schema and the validation; this dialog only renders what
// came back and marks the fields the operator ticked.

export type FormAssistField = {
  name: string;
  label: string;
  current?: unknown;
  valueType: string;
  isList?: boolean;
};

export type FormAssistModelOption = { id: number; name: string; alias: string };

export type FormAssistModelSuggestion = {
  name?: string;
  alias?: string;
  unique_key?: string;
  default_order_attr?: string;
  parent_ids?: number[];
};

type BaseProps = { open: boolean; onClose(): void; locale?: string };

type InstanceProps = BaseProps & {
  mode: 'instance';
  ciType: string;
  ciId?: number;
  fields: FormAssistField[];
  onAccept(values: Record<string, unknown>): void;
};

type ModelProps = BaseProps & {
  mode: 'model';
  modelId?: number;
  models: FormAssistModelOption[];
  onAccept(suggestion: FormAssistModelSuggestion): void;
};

type AttributeProps = BaseProps & {
  mode: 'attribute';
  modelRef?: string;
  onAccept(attribute: CMDBFormAttributeSuggestion): void;
};

type RelationTypeProps = BaseProps & {
  mode: 'relation_type';
  onAccept(suggestion: { name: string; color: string }): void;
};

export type FormAssistModelRelationSuggestion = {
  source_model_id: number;
  target_model_id: number;
  relation_type_id: number;
  constraint: string;
  parent_attr_ids: number[];
  child_attr_ids: number[];
};

type ModelRelationProps = BaseProps & {
  mode: 'model_relation';
  models: FormAssistModelOption[];
  relationTypes: Array<{ id: number; name: string }>;
  /** Optional locked ends; the backend keeps them fixed and only proposes the rest. */
  sourceModelRef?: string;
  targetModelRef?: string;
  onAccept(suggestion: FormAssistModelRelationSuggestion): void;
};

export type FormAssistDialogProps =
  | InstanceProps
  | ModelProps
  | AttributeProps
  | RelationTypeProps
  | ModelRelationProps;

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function typeLabel(code: string, tr: (zh: string, en: string) => string): string {
  if (!isValueTypeCode(code)) return code;
  const label = VALUE_TYPE_LABELS[code];
  return tr(label[0], label[1]);
}

export function FormAssistDialog(props: FormAssistDialogProps) {
  const { tr } = useI18n();
  const { open, onClose } = props;
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CMDBFormAssistResponse | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [checkedParents, setCheckedParents] = useState<number[]>([]);
  const [attributeIndex, setAttributeIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setIntent('');
    setBusy(false);
    setError(null);
    setResult(null);
    setChecked({});
    setCheckedParents([]);
    setAttributeIndex(0);
  }, [open]);

  const title = tr(
    props.mode === 'instance'
      ? 'AI 填写字段'
      : props.mode === 'model'
        ? 'AI 生成模型信息'
        : props.mode === 'attribute'
          ? 'AI 生成属性'
          : props.mode === 'relation_type'
            ? 'AI 生成关系类型'
            : 'AI 建议模型关系',
    props.mode === 'instance'
      ? 'AI fill fields'
      : props.mode === 'model'
        ? 'AI suggest model'
        : props.mode === 'attribute'
          ? 'AI suggest attribute'
          : props.mode === 'relation_type'
            ? 'AI suggest relation type'
            : 'AI suggest model relation',
  );

  const run = async () => {
    const prompt = intent.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body =
        props.mode === 'instance'
          ? {
              kind: 'instance' as const,
              ci_type: props.ciType,
              ci_id: props.ciId,
              intent: prompt,
              locale: props.locale,
              fields: props.fields.map((field) => field.name),
              values: Object.fromEntries(
                props.fields
                  .filter((field) => !isEmpty(field.current))
                  .map((field) => [field.name, field.current]),
              ),
            }
          : props.mode === 'model'
            ? {
                kind: 'model' as const,
                ci_id: props.modelId,
                intent: prompt,
                locale: props.locale,
                parent_model_ids: props.models.map((model) => model.id),
              }
            : props.mode === 'attribute'
              ? {
                  kind: 'attribute' as const,
                  model_ref: props.modelRef,
                  intent: prompt,
                  locale: props.locale,
                }
              : props.mode === 'relation_type'
                ? {
                    kind: 'relation_type' as const,
                    intent: prompt,
                    locale: props.locale,
                  }
                : {
                    kind: 'model_relation' as const,
                    intent: prompt,
                    locale: props.locale,
                    source_model_ref: props.sourceModelRef,
                    target_model_ref: props.targetModelRef,
                  };
      const got = await cmdbFormAssist(body);
      setResult(got);
      if (props.mode === 'instance' && got.kind === 'instance') {
        setChecked(
          Object.fromEntries(
            props.fields.map((field) => [field.name, field.name in (got.values ?? {}) && isEmpty(field.current)]),
          ),
        );
      } else if (props.mode === 'model' && got.kind === 'model') {
        setChecked({
          name: Boolean(got.name),
          alias: Boolean(got.alias),
          unique_key: Boolean(got.unique_key),
          default_order_attr: Boolean(got.default_order_attr),
        });
        setCheckedParents(got.parent_ids ?? []);
      } else if (props.mode === 'attribute') {
        setAttributeIndex(0);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 503) {
          setError(tr('AI 不可用：服务端还没有配置模型或 CMDB 连接。', 'AI is unavailable: the server has no LLM or CMDB connection configured.'));
        } else if (err.status === 403) {
          setError(tr('需要管理员权限才能生成模型、属性或关系。', 'Administrator role is required to suggest models, attributes or relations.'));
        } else {
          setError(err.message || tr('AI 生成失败', 'AI suggestion failed'));
        }
      } else {
        setError((err as Error)?.message || tr('AI 生成失败', 'AI suggestion failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    if (!result) return;
    if (props.mode === 'instance') {
      const values: Record<string, unknown> = {};
      for (const field of props.fields) {
        if (checked[field.name] && field.name in (result.values ?? {})) {
          values[field.name] = result.values?.[field.name];
        }
      }
      props.onAccept(values);
    } else if (props.mode === 'model') {
      props.onAccept({
        name: checked.name ? result.name : undefined,
        alias: checked.alias ? result.alias : undefined,
        unique_key: checked.unique_key ? result.unique_key : undefined,
        default_order_attr: checked.default_order_attr ? result.default_order_attr : undefined,
        parent_ids: checkedParents,
      });
    } else if (props.mode === 'relation_type') {
      props.onAccept({ name: result.name ?? '', color: result.color ?? '' });
    } else if (props.mode === 'model_relation') {
      props.onAccept({
        source_model_id: result.source_model_id ?? 0,
        target_model_id: result.target_model_id ?? 0,
        relation_type_id: result.relation_type_id ?? 0,
        constraint: result.constraint ?? '0',
        parent_attr_ids: result.parent_attr_ids ?? [],
        child_attr_ids: result.child_attr_ids ?? [],
      });
    } else {
      const attribute = result.attributes?.[attributeIndex];
      if (attribute) props.onAccept(attribute);
    }
    onClose();
  };

  const canAccept = useMemo(() => {
    if (!result) return false;
    if (props.mode === 'instance') {
      return props.fields.some((field) => checked[field.name] && field.name in (result.values ?? {}));
    }
    if (props.mode === 'model') {
      return Boolean(checked.name || checked.alias || checked.unique_key || checked.default_order_attr) || checkedParents.length > 0;
    }
    if (props.mode === 'relation_type') {
      return Boolean(result.name);
    }
    if (props.mode === 'model_relation') {
      return Boolean(result.source_model_id && result.target_model_id && result.relation_type_id);
    }
    return (result.attributes?.length ?? 0) > 0;
  }, [checked, checkedParents.length, props, result]);

  const notes = result?.warnings ?? [];
  const skipped = result?.skipped ?? [];

  return (
    <>
      {open && (
        // The nested Base UI dialog has no backdrop of its own; this one dims
        // the form underneath so the two cards cannot be read as one form.
        <div aria-hidden="true" className="fixed inset-0 z-[65] bg-black/50" onClick={onClose} />
      )}
      <Modal
        open={open}
        onClose={onClose}
        size="lg"
        layer="elevated"
        title={title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={busy}>
            {tr('取消', 'Cancel')}
          </Button>
          {result ? (
            <Button variant="primary" type="button" onClick={accept} disabled={!canAccept || busy}>
              {tr('接受选中', 'Accept selected')}
            </Button>
          ) : (
            <Button variant="primary" type="button" onClick={() => void run()} disabled={busy || !intent.trim()}>
              {busy ? (
                <>
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  {tr('生成中…', 'Generating…')}
                </>
              ) : (
                <>
                  <Sparkles size={12} aria-hidden="true" />
                  {tr('生成建议', 'Suggest')}
                </>
              )}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="cmdb-form-assist-intent">
            {tr('描述你要填写的内容', 'Describe what you want to fill')}
          </Label>
          <Textarea
            id="cmdb-form-assist-intent"
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            rows={3}
            className="mt-1 w-full"
            placeholder={
              props.mode === 'instance'
                ? tr('例：一台位于北京、8 核 32G、用于生产的 Web 服务器', 'e.g. a production web server in Beijing, 8 cores, 32 GB')
                : props.mode === 'model'
                  ? tr('例：Kubernetes 节点，继承主机模型，用主机名识别', 'e.g. a Kubernetes node that inherits from host and is keyed by hostname')
                  : props.mode === 'attribute'
                    ? tr('例：增加一个“机房”文本属性，必填，选项为 A/B', 'e.g. add a required “room” text attribute with options A/B')
                    : props.mode === 'relation_type'
                      ? tr('例：主机运行虚拟机的关系，用蓝色', 'e.g. a relation for hosts running virtual machines, in blue')
                      : tr('例：主机运行虚拟机，一对多，源主机名关联目标主机名', 'e.g. a host runs virtual machines, one-to-many, source hostname maps to target hostname')
            }
          />
          <p className="mt-1 text-[11px] text-text-faint">
            {tr(
              'AI 只填充表单，不会保存；接受后请检查并点击保存。',
              'AI only fills the form; nothing is saved until you review and submit it.',
            )}
          </p>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        {props.mode === 'instance' && result?.kind === 'instance' && (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-bg/40 text-[11px] text-text-muted">
                <tr>
                  <th className="w-8 px-2 py-2" aria-label={tr('选择', 'Select')} />
                  <th className="px-2 py-2 text-left">{tr('字段', 'Field')}</th>
                  <th className="px-2 py-2 text-left">{tr('当前值', 'Current')}</th>
                  <th className="px-2 py-2 text-left">{tr('建议值', 'Suggested')}</th>
                </tr>
              </thead>
              <tbody>
                {props.fields
                  .filter((field) => field.name in (result.values ?? {}))
                  .map((field) => (
                    <tr key={field.name} className="border-t border-border/60 align-top">
                      <td className="px-2 py-2">
                        <Checkbox
                          checked={checked[field.name] ?? false}
                          onCheckedChange={(next) => setChecked((current) => ({ ...current, [field.name]: next === true }))}
                          aria-label={tr(`采用 ${field.label}`, `Use ${field.label}`)}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <div className="font-medium text-text">{field.label}</div>
                        <div className="font-mono text-[10px] text-text-faint">{field.name}</div>
                        {result.explanations?.[field.name] && (
                          <div className="mt-1 text-[11px] text-text-muted">{result.explanations[field.name]}</div>
                        )}
                      </td>
                      <td className="max-w-40 break-words px-2 py-2 text-text-muted">{valueText(field.current) || '—'}</td>
                      <td className={cn('max-w-48 break-words px-2 py-2 font-medium', !isEmpty(field.current) && 'text-amber-600 dark:text-amber-300')}>
                        {valueText(result.values?.[field.name])}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {props.mode === 'model' && result?.kind === 'model' && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-xs">
            {([
              ['name', tr('名称', 'Name'), result.name],
              ['alias', tr('别名', 'Alias'), result.alias],
              ['unique_key', tr('标识属性', 'Identifying attribute'), result.unique_key],
              ['default_order_attr', tr('默认排序', 'Default order'), result.default_order_attr],
            ] as const).map(([key, label, value]) => (
              <label key={key} className="flex items-start gap-2">
                <Checkbox
                  checked={checked[key] ?? false}
                  disabled={!value}
                  onCheckedChange={(next) => setChecked((current) => ({ ...current, [key]: next === true }))}
                  aria-label={tr(`采用 ${label}`, `Use ${label}`)}
                />
                <span className="min-w-0">
                  <span className="block text-[11px] text-text-muted">{label}</span>
                  <span className="block break-words font-medium text-text">{value || '—'}</span>
                  {key === 'name' && result.explanations?.name && (
                    <span className="block text-[11px] text-text-faint">{result.explanations.name}</span>
                  )}
                </span>
              </label>
            ))}
            {(result.parent_ids?.length ?? 0) > 0 && (
              <fieldset className="border-t border-border/60 pt-2">
                <legend className="text-[11px] text-text-muted">{tr('继承自', 'Inherits from')}</legend>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {(props.mode === 'model' ? props.models : [])
                    .filter((model) => (result.parent_ids ?? []).includes(model.id))
                    .map((model) => (
                      <label key={model.id} className="flex items-center gap-2">
                        <Checkbox
                          checked={checkedParents.includes(model.id)}
                          onCheckedChange={(next) =>
                            setCheckedParents((current) =>
                              next === true ? [...current, model.id] : current.filter((id) => id !== model.id),
                            )
                          }
                        />
                        {model.alias || model.name}
                      </label>
                    ))}
                </div>
              </fieldset>
            )}
          </div>
        )}

        {props.mode === 'relation_type' && result?.kind === 'relation_type' && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-xs">
            <div>
              <span className="block text-[11px] text-text-muted">{tr('名称', 'Name')}</span>
              <span className="block font-medium text-text">{result.name}</span>
            </div>
            <div>
              <span className="block text-[11px] text-text-muted">{tr('颜色', 'Colour')}</span>
              <span className="mt-0.5 flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-4 w-4 rounded border border-border"
                  style={{ backgroundColor: result.color || 'transparent' }}
                />
                <code className="font-mono text-[11px] text-text-muted">{result.color || tr('（不指定）', '(none)')}</code>
              </span>
            </div>
          </div>
        )}

        {props.mode === 'model_relation' && result?.kind === 'model_relation' && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-xs">
            {([
              [
                tr('源 CI 类型', 'Source CI type'),
                (() => {
                  const found = props.models.find((model) => model.id === result.source_model_id);
                  return found ? found.alias || found.name : `#${result.source_model_id}`;
                })(),
              ],
              [
                tr('目标 CI 类型', 'Target CI type'),
                (() => {
                  const found = props.models.find((model) => model.id === result.target_model_id);
                  return found ? found.alias || found.name : `#${result.target_model_id}`;
                })(),
              ],
              [
                tr('关系类型', 'Relation type'),
                props.relationTypes.find((type) => type.id === result.relation_type_id)?.name ?? `#${result.relation_type_id}`,
              ],
              [tr('关系约束', 'Constraint'), relationConstraintLabel(result.constraint ?? '0', tr)],
              [
                tr('属性关联', 'Attribute association'),
                (result.parent_attr_ids?.length ?? 0) > 0
                  ? tr(`${result.parent_attr_ids?.length} 组`, `${result.parent_attr_ids?.length} pairs`)
                  : tr('无', 'None'),
              ],
            ] as const).map(([label, value]) => (
              <div key={label} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[11px] text-text-muted">{label}</span>
                <span className="font-medium text-text">{value}</span>
              </div>
            ))}
            {result.explanations?.reason && (
              <p className="border-t border-border/60 pt-2 text-[11px] text-text-faint">{result.explanations.reason}</p>
            )}
          </div>
        )}

        {props.mode === 'attribute' && result?.kind === 'attribute' && (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-bg/40 text-[11px] text-text-muted">
                <tr>
                  <th className="w-8 px-2 py-2" aria-label={tr('选择', 'Select')} />
                  <th className="px-2 py-2 text-left">{tr('属性', 'Attribute')}</th>
                  <th className="px-2 py-2 text-left">{tr('类型', 'Type')}</th>
                </tr>
              </thead>
              <tbody>
                {(result.attributes ?? []).map((attribute, index) => (
                  <tr key={`${attribute.name}-${index}`} className="border-t border-border/60">
                    <td className="px-2 py-2">
                      <input
                        type="radio"
                        name="cmdb-form-assist-attribute"
                        checked={attributeIndex === index}
                        onChange={() => setAttributeIndex(index)}
                        aria-label={tr(`采用 ${attribute.alias || attribute.name}`, `Use ${attribute.alias || attribute.name}`)}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <div className="font-medium text-text">{attribute.alias || attribute.name}</div>
                      <div className="font-mono text-[10px] text-text-faint">{attribute.name}</div>
                      {(attribute.choice_values?.length ?? 0) > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {attribute.choice_values?.slice(0, 6).map((choice) => <Chip key={choice} dense>{choice}</Chip>)}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-text-muted">{typeLabel(attribute.value_type, tr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(result.attributes?.length ?? 0) > 1 && (
              <p className="border-t border-border/60 px-2 py-2 text-[11px] text-text-faint">
                {tr('这里一次填入一个属性；保存后可再次生成其余属性。', 'One attribute is filled at a time; generate again after saving for the rest.')}
              </p>
            )}
          </div>
        )}

        {result && (notes.length > 0 || skipped.length > 0 || result.truncated) && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            {notes.map((note) => <div key={note}>{note}</div>)}
            {skipped.length > 0 && (
              <div>{tr(`已跳过：${skipped.join('、')}`, `Skipped: ${skipped.join(', ')}`)}</div>
            )}
            {result.truncated && <div>{tr('建议过多，已截断。', 'Too many suggestions; the list was truncated.')}</div>}
          </div>
        )}
      </div>
      </Modal>
    </>
  );
}
