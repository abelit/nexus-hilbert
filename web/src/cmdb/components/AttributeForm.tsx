import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Radio } from '@/components/ui/Radio';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import { describeError } from '../api/http';
import {
  createAttribute,
  listCITypes,
  updateAttribute,
  type Attribute,
  type AttributeInput,
  type ChoiceValue,
  type CIType,
} from '../api/citype';
import { AttributeControl } from './AttributeControl';
import { VALUE_TYPE_LABELS, isValueTypeCode, toWireValue } from '../lib/valuetype';

// The attribute dictionary editor.
//
// THIS IS THE FORM THE MODEL PAGE USED TO LACK. A bound attribute could only
// have its alias, default, index, sortable and unique flags changed; choice,
// reference, computed, list, password, link and file attributes were visible
// but not editable, and the dictionary's create path was a three-field inline
// form. The backend already accepts all of these fields, so the missing piece
// was entirely this surface.
//
// VALUE TYPE AND is_list ARE IMMUTABLE ON UPDATE. The backend refuses a change
// that would move existing values between storage tables; the form shows the
// stored values and explains why they cannot be changed here rather than
// offering a control that always fails.

type ChoiceMode = 'none' | 'static' | 'advanced';

type FlagKey =
  | 'is_unique'
  | 'is_index'
  | 'is_sortable'
  | 'is_list'
  | 'is_dynamic'
  | 'is_bool'
  | 'is_password'
  | 'is_link'
  | 'is_file'
  | 'is_reference'
  | 'is_computed';

type Flags = Record<FlagKey, boolean>;

type ChoiceRow = {
  value: string;
  label: string;
  color: string;
  option: Record<string, unknown>;
};

const flagLabels: Array<{ key: FlagKey; zh: string; en: string; hintZh: string; hintEn: string }> = [
  { key: 'is_unique', zh: '唯一', en: 'Unique', hintZh: '同一模型内不允许重复值', hintEn: 'No duplicate values within a model' },
  { key: 'is_index', zh: '可检索', en: 'Searchable', hintZh: '参与筛选和排序；密码/链接/文件会被强制放到非索引表', hintEn: 'Filterable and sortable; secrets, links and files are forced unindexed' },
  { key: 'is_sortable', zh: '可排序', en: 'Sortable', hintZh: '允许按此字段排序', hintEn: 'May be used as a sort key' },
  { key: 'is_list', zh: '多值', en: 'Multi-valued', hintZh: '一个实例可保存多个值；创建后不能修改', hintEn: 'An instance may hold several values; immutable after creation' },
  { key: 'is_dynamic', zh: '动态', en: 'Dynamic', hintZh: '值由外部流程动态维护', hintEn: 'Maintained dynamically by an external flow' },
  { key: 'is_bool', zh: '布尔', en: 'Boolean', hintZh: '用开关展示；通常配合布尔值类型', hintEn: 'Rendered as a switch; usually paired with the boolean value type' },
  { key: 'is_password', zh: '密码', en: 'Secret', hintZh: '读取接口永不回显；列表和详情都会隐藏', hintEn: 'Never echoed by the read API; hidden from lists and details' },
  { key: 'is_link', zh: '链接', en: 'Link', hintZh: '外部链接；读取接口不返回链接值', hintEn: 'External link; the read API does not return the link value' },
  { key: 'is_file', zh: '文件', en: 'File', hintZh: '文件属性的值由专用上传控件维护，保存文件元数据', hintEn: 'File values use the attachment control and store file metadata' },
  { key: 'is_reference', zh: '引用', en: 'Reference', hintZh: '值指向另一个模型的实例', hintEn: 'The value points at an instance of another model' },
];

function initialFlags(attribute: Attribute | null): Flags {
  return {
    is_unique: attribute?.is_unique ?? false,
    is_index: attribute?.is_index ?? false,
    is_sortable: attribute?.is_sortable ?? false,
    is_list: attribute?.is_list ?? false,
    is_dynamic: attribute?.is_dynamic ?? false,
    is_bool: attribute?.is_bool ?? false,
    is_password: attribute?.is_password ?? false,
    is_link: attribute?.is_link ?? false,
    is_file: attribute?.is_file ?? false,
    is_reference: attribute?.is_reference ?? false,
    is_computed: attribute?.is_computed ?? false,
  };
}

function initialChoiceMode(attribute: Attribute | null): ChoiceMode {
  if (attribute?.choice_value && attribute.choice_value.length > 0) return 'static';
  if (attribute?.has_choice_web_hook || attribute?.has_choice_other) return 'advanced';
  return 'none';
}

function choiceRows(values: ChoiceValue[] | undefined): ChoiceRow[] {
  return (values ?? []).map((item) => {
    const option = item.option ?? {};
    const label = typeof option.label === 'string' ? option.label : '';
    const style = option.style && typeof option.style === 'object' ? (option.style as Record<string, unknown>) : {};
    const color = typeof style.backgroundColor === 'string' ? style.backgroundColor : '';
    return { value: String(item.value ?? ''), label, color, option };
  });
}

function parseJSONObject(raw: string, label: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `${label} is not valid JSON`);
  }
}

export function AttributeForm({
  attribute,
  onClose,
  onSaved,
  onDelete,
}: {
  attribute: Attribute | null;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
  onDelete?(): void;
}) {
  const { tr } = useI18n();
  const editing = attribute !== null;
  const [name, setName] = useState(attribute?.name ?? '');
  const [alias, setAlias] = useState(attribute?.alias ?? '');
  const [valueType, setValueType] = useState<'0' | '1' | '2' | '3' | '4' | '5' | '6' | '7'>(
    isValueTypeCode(attribute?.value_type ?? '') ? (attribute?.value_type as '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7') : '2',
  );
  const [flags, setFlags] = useState<Flags>(() => initialFlags(attribute));
  const [referenceTypeID, setReferenceTypeID] = useState(attribute?.reference_type_id ? String(attribute.reference_type_id) : '');
  const [models, setModels] = useState<CIType[]>([]);
  const [defaultValue, setDefaultValue] = useState<unknown>(() => {
    const stored = attribute?.default && typeof attribute.default === 'object' ? (attribute.default.default ?? null) : null;
    return stored;
  });
  const [choiceMode, setChoiceMode] = useState<ChoiceMode>(() => initialChoiceMode(attribute));
  const [choices, setChoices] = useState<ChoiceRow[]>(() => choiceRows(attribute?.choice_value));
  const [choiceWebhook, setChoiceWebhook] = useState('');
  const [choiceOther, setChoiceOther] = useState('');
  const [clearWebhook, setClearWebhook] = useState(false);
  const [clearOther, setClearOther] = useState(false);
  const [computeExpr, setComputeExpr] = useState(attribute?.compute_expr ?? '');
  const [reCheck, setReCheck] = useState(attribute?.re_check ?? '');
  const [optionText, setOptionText] = useState(() => (attribute?.option ? JSON.stringify(attribute.option, null, 2) : ''));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void listCITypes()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  const typeOptions = useMemo(
    () => (['0', '1', '2', '3', '4', '5', '6', '7'] as const).map((code) => ({
      value: code,
      label: tr(VALUE_TYPE_LABELS[code][0], VALUE_TYPE_LABELS[code][1]),
    })),
    [tr],
  );

  const modelOptions = useMemo(
    () => models.map((model) => ({ value: String(model.id), label: model.alias || model.name })),
    [models],
  );

  const choiceSupported = valueType !== '6' && valueType !== '7';
  useEffect(() => {
    if (!choiceSupported && choiceMode !== 'none') setChoiceMode('none');
  }, [choiceMode, choiceSupported]);

  const setFlag = (key: FlagKey, next: boolean) => setFlags((current) => ({ ...current, [key]: next }));

  const updateChoice = (index: number, patch: Partial<ChoiceRow>) => {
    setChoices((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const submit = async () => {
    setErr(null);
    const trimmedName = name.trim();
    const trimmedAlias = alias.trim() || trimmedName;
    if (!trimmedName) {
      setErr(tr('属性名不能为空', 'An attribute name is required'));
      return;
    }
    if (flags.is_reference && !referenceTypeID) {
      setErr(tr('引用属性需要选择一个引用模型', 'A reference attribute needs a reference model'));
      return;
    }

    let option: Record<string, unknown> | undefined;
    if (optionText.trim()) {
      try {
        option = parseJSONObject(optionText, tr('展示选项', 'Presentation options')) ?? undefined;
      } catch (error) {
        setErr(error instanceof Error ? error.message : String(error));
        return;
      }
    }

    let webhook: Record<string, unknown> | undefined;
    let other: Record<string, unknown> | undefined;
    if (choiceMode === 'advanced') {
      try {
        webhook = parseJSONObject(choiceWebhook, tr('Choice Webhook', 'Choice webhook')) ?? undefined;
        other = parseJSONObject(choiceOther, tr('Choice 其他配置', 'Choice other configuration')) ?? undefined;
      } catch (error) {
        setErr(error instanceof Error ? error.message : String(error));
        return;
      }
    }

    const input: Partial<AttributeInput> & { name: string; alias: string; value_type: string } = {
      name: trimmedName,
      alias: trimmedAlias,
      value_type: valueType,
      is_unique: flags.is_unique,
      is_index: flags.is_index,
      is_sortable: flags.is_sortable,
      is_dynamic: flags.is_dynamic,
      is_bool: flags.is_bool,
      is_password: flags.is_password,
      is_link: flags.is_link,
      is_file: flags.is_file,
      is_reference: flags.is_reference,
      reference_type_id: flags.is_reference && referenceTypeID ? Number(referenceTypeID) : undefined,
      is_computed: flags.is_computed,
      compute_expr: editing ? computeExpr.trim() : computeExpr.trim() || undefined,
      re_check: editing ? reCheck.trim() : reCheck.trim() || undefined,
      option: optionText.trim() ? option : editing ? {} : undefined,
    };
    if (!editing) {
      input.is_list = flags.is_list;
    }
    if (defaultValue === null || defaultValue === undefined || defaultValue === '') {
      input.default = {};
    } else {
      input.default = { default: defaultValue };
    }

    if (choiceMode === 'static') {
      input.choice_value = choices
        .filter((row) => row.value.trim() !== '')
        .map((row) => {
          const option: Record<string, unknown> = { ...row.option };
          if (row.label.trim()) option.label = row.label.trim();
          else delete option.label;
          if (row.color.trim()) {
            const style = option.style && typeof option.style === 'object' ? (option.style as Record<string, unknown>) : {};
            option.style = { ...style, backgroundColor: row.color.trim() };
          }
          return {
            value: toWireValue(valueType, row.value),
            option,
          };
        });
      // The three fields are one configuration. Switching to static choices
      // clears a stored webhook/other source rather than leaving two sources
      // active at once.
      input.choice_web_hook = {};
      input.choice_other = {};
    } else if (choiceMode === 'advanced') {
      input.choice_value = [];
      if (clearWebhook) input.choice_web_hook = {};
      else if (webhook) input.choice_web_hook = webhook;
      if (clearOther) input.choice_other = {};
      else if (other) input.choice_other = other;
    } else if (editing) {
      input.choice_value = [];
      input.choice_web_hook = {};
      input.choice_other = {};
    }

    setSubmitting(true);
    try {
      if (editing && attribute) await updateAttribute(attribute.id, input);
      else await createAttribute(input);
      await onSaved(editing ? tr('已保存', 'Saved') : tr('已创建', 'Created'));
    } catch (error) {
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = () => {
    if (!editing || !onDelete) return;
    onDelete();
  };

  const fieldsetClass = 'flex flex-col gap-3 rounded-lg border border-border p-4';
  const legendClass = 'px-1 text-xs font-medium text-text-muted';

  return (
    <form
      id="cmdb-attribute-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-4"
    >
      {err && (
        <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {err}
        </div>
      )}

      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>{tr('基本信息', 'Basics')}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="cmdb-attr-name">{tr('属性名', 'Name')}</Label>
            <Input
              id="cmdb-attr-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full font-mono"
              autoComplete="off"
            />
            <p className="mt-1 text-[11px] text-text-faint">
              {tr('查询表达式和 API 使用的稳定名称。', 'The stable name used by query expressions and the API.')}
            </p>
          </div>
          <div>
            <Label htmlFor="cmdb-attr-alias">{tr('别名', 'Alias')}</Label>
            <Input
              id="cmdb-attr-alias"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              className="mt-1 w-full"
            />
          </div>
          <div>
            <Label htmlFor="cmdb-attr-type">{tr('值类型', 'Value type')}</Label>
            <Select
              id="cmdb-attr-type"
              label={tr('值类型', 'Value type')}
              value={valueType}
              onValueChange={(next) => {
                if (isValueTypeCode(next)) setValueType(next);
              }}
              options={typeOptions}
              disabled={editing}
              className="mt-1 w-full"
            />
            <p className="mt-1 text-[11px] text-text-faint">
              {editing
                ? tr('值类型创建后不能修改，避免已有值落入错误的存储表。', 'The value type is immutable after creation, so existing values cannot move to the wrong storage table.')
                : tr('值类型决定存储表和控制控件。', 'The value type selects the storage table and the input control.')}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cmdb-attr-default">{tr('默认值', 'Default')}</Label>
            <AttributeControl
              id="cmdb-attr-default"
              type={valueType}
              value={defaultValue}
              onChange={setDefaultValue}
              isList={flags.is_list}
              aria-label={tr('默认值', 'Default')}
            />
            <p className="text-[11px] text-text-faint">
              {tr('留空表示没有默认值。', 'Leave it empty for no default.')}
            </p>
          </div>
        </div>
      </fieldset>

      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>{tr('类型与存储', 'Type and storage')}</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {flagLabels.map((flag) => (
            <label key={flag.key} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs">
              <Checkbox
                checked={flags[flag.key]}
                disabled={editing && (flag.key === 'is_list')}
                onCheckedChange={(next) => setFlag(flag.key, next === true)}
                aria-label={tr(flag.zh, flag.en)}
              />
              <span className="min-w-0">
                <span className="block font-medium text-text">{tr(flag.zh, flag.en)}</span>
                <span className="block text-[11px] text-text-faint">{tr(flag.hintZh, flag.hintEn)}</span>
              </span>
            </label>
          ))}
        </div>
        {flags.is_reference && (
          <div>
            <Label htmlFor="cmdb-attr-reference">{tr('引用模型', 'Reference model')}</Label>
            <Select
              id="cmdb-attr-reference"
              label={tr('引用模型', 'Reference model')}
              value={referenceTypeID}
              onValueChange={setReferenceTypeID}
              options={modelOptions}
              searchable
              className="mt-1 w-full"
            />
          </div>
        )}
      </fieldset>

      {choiceSupported ? (
      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>{tr('可选值来源', 'Choice source')}</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(
            [
              { value: 'none', zh: '不使用选项', en: 'No choices' },
              { value: 'static', zh: '静态选项', en: 'Static values' },
              { value: 'advanced', zh: 'Webhook / 脚本配置', en: 'Webhook / script configuration' },
            ] as const
          ).map((item) => (
            <label
              key={item.value}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs',
                choiceMode === item.value ? 'border-indigo-500/60 bg-indigo-500/5 text-text' : 'border-border text-text-muted',
              )}
            >
              <Radio
                name="cmdb-attribute-choice-mode"
                value={item.value}
                checked={choiceMode === item.value}
                onChange={() => setChoiceMode(item.value)}
              />
              {tr(item.zh, item.en)}
            </label>
          ))}
        </div>

        {choiceMode === 'static' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-text-faint">
                {tr('每个选项保存一个值和可选的显示标签、颜色。', 'Each choice stores a value plus an optional label and colour.')}
              </p>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => setChoices((current) => [...current, { value: '', label: '', color: '', option: {} }])}
              >
                {tr('添加选项', 'Add choice')}
              </Button>
            </div>
            {choices.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-faint">
                {tr('还没有静态选项', 'No static choices yet')}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {choices.map((row, index) => (
                  <div key={index} className="grid grid-cols-1 gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                    <div>
                      <Label htmlFor={`cmdb-choice-value-${index}`}>{tr('值', 'Value')}</Label>
                      <Input
                        id={`cmdb-choice-value-${index}`}
                        value={row.value}
                        onChange={(event) => updateChoice(index, { value: event.target.value })}
                        className="mt-1 w-full font-mono"
                      />
                    </div>
                    <div>
                      <Label htmlFor={`cmdb-choice-label-${index}`}>{tr('标签', 'Label')}</Label>
                      <Input
                        id={`cmdb-choice-label-${index}`}
                        value={row.label}
                        onChange={(event) => updateChoice(index, { label: event.target.value })}
                        className="mt-1 w-full"
                      />
                    </div>
                    <div>
                      <Label htmlFor={`cmdb-choice-color-${index}`}>{tr('颜色', 'Colour')}</Label>
                      <Input
                        id={`cmdb-choice-color-${index}`}
                        type="color"
                        value={row.color || '#1890ff'}
                        onChange={(event) => updateChoice(index, { color: event.target.value })}
                        className="mt-1 h-9 w-16 p-1"
                      />
                    </div>
                    <Button
                      variant="dangerGhost"
                      size="sm"
                      type="button"
                      className="mt-5"
                      onClick={() => setChoices((current) => current.filter((_, i) => i !== index))}
                      aria-label={tr(`删除选项 ${row.value || index + 1}`, `Delete choice ${row.value || index + 1}`)}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {choiceMode === 'advanced' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="cmdb-choice-webhook">{tr('Choice Webhook JSON', 'Choice webhook JSON')}</Label>
                {attribute?.has_choice_web_hook && (
                  <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
                    <Checkbox checked={clearWebhook} onCheckedChange={(next) => setClearWebhook(next === true)} />
                    {tr('清除已存配置', 'Clear stored config')}
                  </label>
                )}
              </div>
              <Textarea
                id="cmdb-choice-webhook"
                rows={5}
                className="mt-1 w-full font-mono text-xs"
                value={choiceWebhook}
                onChange={(event) => setChoiceWebhook(event.target.value)}
                placeholder={attribute?.has_choice_web_hook ? tr('留空保持已存配置', 'Leave empty to keep the stored config') : '{}'}
              />
              <p className="mt-1 text-[11px] text-text-faint">
                {tr('凭据不会回显；需要修改时整体替换。', 'Credentials are never echoed; replace the whole document to change them.')}
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="cmdb-choice-other">{tr('Choice 其他配置 JSON', 'Choice other JSON')}</Label>
                {attribute?.has_choice_other && (
                  <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
                    <Checkbox checked={clearOther} onCheckedChange={(next) => setClearOther(next === true)} />
                    {tr('清除已存配置', 'Clear stored config')}
                  </label>
                )}
              </div>
              <Textarea
                id="cmdb-choice-other"
                rows={5}
                className="mt-1 w-full font-mono text-xs"
                value={choiceOther}
                onChange={(event) => setChoiceOther(event.target.value)}
                placeholder={attribute?.has_choice_other ? tr('留空保持已存配置', 'Leave empty to keep the stored config') : '{}'}
              />
            </div>
          </div>
        )}
      </fieldset>
      ) : (
        <p className="rounded-lg border border-border px-4 py-3 text-[11px] text-text-faint">
          {tr('JSON 与布尔类型不支持可选值。', 'JSON and boolean types cannot carry a choice list.')}
        </p>
      )}

      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>{tr('校验与展示', 'Validation and presentation')}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="cmdb-attr-recheck">{tr('正则校验', 'Regular expression')}</Label>
            <Input
              id="cmdb-attr-recheck"
              value={reCheck}
              onChange={(event) => setReCheck(event.target.value)}
              className="mt-1 w-full font-mono"
              placeholder={tr('可选，例如 ^[a-z0-9-]+$', 'Optional, e.g. ^[a-z0-9-]+$')}
            />
          </div>
          <div>
            <Label htmlFor="cmdb-attr-option">{tr('展示选项 JSON', 'Presentation options JSON')}</Label>
            <Textarea
              id="cmdb-attr-option"
              rows={3}
              value={optionText}
              onChange={(event) => setOptionText(event.target.value)}
              className="mt-1 w-full font-mono text-xs"
              placeholder={tr('可选，例如 {"fontOptions":{"color":"#1890ff"}}', 'Optional, e.g. {"fontOptions":{"color":"#1890ff"}}')}
            />
          </div>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs">
          <Checkbox
            checked={flags.is_computed}
            onCheckedChange={(next) => setFlag('is_computed', next === true)}
            aria-label={tr('计算属性', 'Computed attribute')}
          />
          <span className="min-w-0">
            <span className="block font-medium text-text">{tr('计算属性', 'Computed attribute')}</span>
            <span className="block text-[11px] text-text-faint">
              {tr('值由表达式推导；写入时忽略外部值。', 'The value is derived from an expression; external values are ignored.')}
            </span>
          </span>
        </label>
        {flags.is_computed && (
          <div>
            <Label htmlFor="cmdb-attr-compute-expr">{tr('计算表达式', 'Compute expression')}</Label>
            <Textarea
              id="cmdb-attr-compute-expr"
              rows={3}
              value={computeExpr}
              onChange={(event) => setComputeExpr(event.target.value)}
              className="mt-1 w-full font-mono text-xs"
            />
            {attribute?.has_compute_script && (
              <p className="mt-1 flex items-center gap-2 text-[11px] text-amber-400">
                <Chip tone="warning">{tr('已有 Python 脚本', 'Python script stored')}</Chip>
                {tr('本服务只保存脚本，不执行；此表单不修改脚本内容。', 'This service stores but never runs the script; this form does not edit it.')}
              </p>
            )}
          </div>
        )}
      </fieldset>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg px-1 py-3">
        {editing && onDelete && (
          <Button variant="dangerGhost" type="button" onClick={remove} disabled={submitting} className="me-auto inline-flex items-center gap-1.5">
            <Trash2 size={12} aria-hidden="true" />
            {tr('删除属性', 'Delete attribute')}
          </Button>
        )}
        <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
          {tr('取消', 'Cancel')}
        </Button>
        <Button variant="primary" type="submit" disabled={submitting}>
          {submitting ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
        </Button>
      </div>
    </form>
  );
}
