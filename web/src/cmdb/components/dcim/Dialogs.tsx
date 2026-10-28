import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Search } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { Radio } from '@/components/ui/Radio';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  getCIType,
  listAttributeGroups,
  listTypeAttributes,
  relationChildren,
  type AttributeGroup,
  type CIType,
  type TypeAttribute,
} from '../../api/citype';
import {
  createDCIMNode,
  mountDevice,
  moveDevice,
  updateDCIMNode,
  type DCIMNode,
} from '../../api/dcim';
import { describeError } from '../../api/http';
import { getInstance, searchInstances, type SearchRow } from '../../api/instance';
import { attributeSections } from '../../lib/attribute-sections';
import {
  DCIM_TYPE_NAME,
  DCIM_TYPE_LABEL,
  type DCIMType,
  type RackDevice,
  type RackDeviceUnit,
  type RackRow,
} from '../../lib/dcim';
import { instanceSearchQuery } from '../../lib/instance-search';
import { referenceLabel, useReferenceLabels } from '../../lib/reference-labels';
import { isEmptyValue, isValueTypeCode, type ValueTypeCode } from '../../lib/valuetype';
import { AttributeControl } from '../AttributeControl';
import { ReferencePicker } from '../ReferencePicker';
import { useDCIM } from './context';

export type NodeDialogState = {
  type: DCIMType;
  /** Present when editing an existing node. */
  node?: DCIMNode | null;
  /** The container a new node is created under. */
  parent?: DCIMNode | null;
};

// --- create / edit a tree node or rack ---

export function NodeDialog({
  state,
  onClose,
  onSaved,
}: {
  state: NodeDialogState;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const { models } = useDCIM();
  const editing = Boolean(state.node);
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [groups, setGroups] = useState<AttributeGroup[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [model, setModel] = useState<CIType | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void (async () => {
      const type = await getCIType(DCIM_TYPE_NAME[state.type]);
      const [attrs, gotGroups, prefill] = await Promise.all([
        listTypeAttributes(type.id),
        listAttributeGroups(type.id, false).catch(() => [] as AttributeGroup[]),
        state.node ? getInstance(state.node._id).catch(() => null) : Promise.resolve(null),
      ]);
      if (!live) return;
      const list = (attrs.attributes ?? []).filter((attribute) => !attribute.is_computed);
      setModel(type);
      setAttributes(list);
      setGroups(gotGroups);
      const initial: Record<string, unknown> = {};
      for (const attribute of list) {
        const stored = prefill?.values?.[attribute.name];
        initial[attribute.name] =
          stored !== undefined && stored !== null
            ? stored
            : (attribute.default?.default ?? null);
      }
      setValues(initial);
    })()
      .catch((failure) => live && setError(describeError(failure, tr('无法读取模型属性', 'Could not load the model’s attributes'))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [state.type, state.node, tr]);

  const sections = useMemo(
    () => attributeSections(attributes, groups, tr('其他', 'Other')),
    [attributes, groups, tr],
  );
  const referenceLabels = useReferenceLabels([{ values }], attributes, models);

  const submit = async () => {
    const missing = attributes.find(
      (attribute) => attribute.is_required && !attribute.is_computed && isEmptyValue(values[attribute.name]),
    );
    if (missing) {
      setError(tr(`「${missing.alias || missing.name}」是必填项`, `“${missing.alias || missing.name}” is required`));
      return;
    }
    const payload: Record<string, unknown> = {};
    for (const attribute of attributes) {
      if (attribute.is_computed) continue;
      const value = values[attribute.name];
      // A secret is never read back. Leaving an edit's secret box empty means
      // "keep the stored one", not "clear it".
      if (attribute.is_password && editing && isEmptyValue(value)) continue;
      payload[attribute.name] = value ?? null;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (editing && state.node) {
        await updateDCIMNode(state.type, state.node._id, payload);
        await onSaved(tr('已保存', 'Saved'));
      } else {
        await createDCIMNode(state.type, {
          ...(state.parent ? { parent_id: state.parent._id } : {}),
          values: payload,
        });
        await onSaved(tr('已创建', 'Created'));
      }
    } catch (failure) {
      setError(describeError(failure, tr('保存失败', 'Could not save')));
    } finally {
      setSubmitting(false);
    }
  };

  const title = `${editing ? tr('编辑', 'Edit') : tr('新建', 'New')}${tr(DCIM_TYPE_LABEL[state.type][0], DCIM_TYPE_LABEL[state.type][1])}`;

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={submitting || loading}>
            {submitting ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {state.parent && !editing && (
        <p className="mb-3 text-[11px] text-text-faint">
          {tr(
            `将建在「${state.parent.name ?? state.parent.alias ?? `#${state.parent._id}`}」下面`,
            `Created under “${state.parent.name ?? state.parent.alias ?? `#${state.parent._id}`}”`,
          )}
        </p>
      )}

      {loading ? (
        <p className="py-8 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
      ) : attributes.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-muted">
          {tr(
            `模型 ${model?.name ?? DCIM_TYPE_NAME[state.type]} 还没有属性，无法创建实例。`,
            `The model ${model?.name ?? DCIM_TYPE_NAME[state.type]} has no attributes, so it cannot hold an instance.`,
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {sections.map((section) => (
            <fieldset key={section.key}>
              <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-faint">{section.name}</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {section.items.map((attribute) => (
                  <NodeField
                    key={attribute.id}
                    attribute={attribute}
                    models={models}
                    referenceLabels={referenceLabels}
                    value={values[attribute.name]}
                    onChange={(next) => setValues((current) => ({ ...current, [attribute.name]: next }))}
                    className={attribute.value_type === '6' ? 'sm:col-span-2' : undefined}
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </Modal>
  );
}

function NodeField({
  attribute,
  models,
  referenceLabels,
  value,
  onChange,
  className,
}: {
  attribute: TypeAttribute;
  models: CIType[];
  referenceLabels: Map<number, string>;
  value: unknown;
  onChange(next: unknown): void;
  className?: string;
}) {
  const { tr } = useI18n();
  const id = `dcim-attr-${attribute.id}`;
  const referenceModel =
    attribute.is_reference && attribute.reference_type_id
      ? models.find((candidate) => Number(candidate.id) === Number(attribute.reference_type_id))
      : undefined;
  const type: ValueTypeCode = attribute.is_bool
    ? '7'
    : isValueTypeCode(attribute.value_type)
      ? attribute.value_type
      : '2';
  const choiceOptions = attribute.is_choice
    ? [
        { value: '', label: tr('未设置', 'Not set') },
        ...(attribute.choice_value ?? []).map((choice) => ({
          value: String(choice.value ?? ''),
          label: typeof choice.option?.label === 'string' && choice.option.label
            ? choice.option.label
            : String(choice.value ?? ''),
        })),
      ]
    : [];

  return (
    <div className={cn('min-w-0', className)}>
      <Label htmlFor={id}>
        {attribute.alias || attribute.name}
        {attribute.is_required && <span className="ml-1 text-red-400">*</span>}
        {attribute.is_dynamic && (
          <Chip dense tone="info" className="ml-2">
            {tr('动态', 'Dynamic')}
          </Chip>
        )}
      </Label>
      <div className="mt-1">
        {referenceModel ? (
          <ReferencePicker
            id={id}
            attribute={attribute}
            target={referenceModel}
            labels={referenceLabels}
            value={value}
            onChange={onChange}
            required={attribute.is_required}
            placeholder={attribute.alias || attribute.name}
          />
        ) : attribute.is_choice ? (
          <Select
            id={id}
            label={attribute.alias || attribute.name}
            value={value == null ? '' : String(value)}
            onValueChange={(next) => onChange(next === '' ? null : next)}
            options={choiceOptions}
            className="w-full"
          />
        ) : (
          <AttributeControl
            id={id}
            type={type}
            isList={attribute.is_list}
            required={attribute.is_required}
            value={value}
            onChange={onChange}
            placeholder={attribute.alias || attribute.name}
          />
        )}
      </div>
      {attribute.is_password && (
        <p className="mt-1 text-[11px] text-text-faint">
          {tr('密码保存后不会再显示；编辑时留空表示保持不变。', 'A saved secret is never shown again; leave it empty to keep it.')}
        </p>
      )}
    </div>
  );
}

// --- mount a device ---

type DeviceTypeOption = { id: number; label: string; model: CIType; showKey?: string };

export function MountDeviceDialog({
  rack,
  roomID,
  start,
  onClose,
  onSaved,
}: {
  rack: RackRow;
  roomID: number;
  start?: number;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const { rackType, models } = useDCIM();
  const [types, setTypes] = useState<DeviceTypeOption[]>([]);
  const [typeID, setTypeID] = useState('');
  const [device, setDevice] = useState<{ id: number; name: string; uCount: number } | null>(null);
  const [uStart, setUStart] = useState(String(start && start > 0 ? start : 1));
  const [units, setUnits] = useState('');
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rackType) {
      setLoadingTypes(false);
      return;
    }
    let live = true;
    // A deployment that has not declared the rack's child models can still
    // mount anything that is not itself a DCIM/IPAM model; the server refuses a
    // pair with no relation and names what is missing.
    const fallback = () =>
      models
        .filter((candidate) => !candidate.name.startsWith('dcim_') && !candidate.name.startsWith('ipam'))
        .map((candidate) => ({ id: candidate.id, label: candidate.alias || candidate.name, model: candidate, showKey: candidate.show_name }));
    void relationChildren(rackType.id)
      .then((got) => {
        if (!live) return;
        const declared = got.map((related) => ({
          id: related.type.id,
          label: related.type.alias || related.type.name,
          model: related.type,
          showKey: related.show_key,
        }));
        const options = declared.length > 0 ? declared : fallback();
        setTypes(options);
        setTypeID(String(options[0]?.id ?? ''));
      })
      .catch(() => {
        if (!live) return;
        const options = fallback();
        setTypes(options);
        setTypeID(String(options[0]?.id ?? ''));
      })
      .finally(() => live && setLoadingTypes(false));
    return () => {
      live = false;
    };
  }, [rackType, models]);

  const active = types.find((option) => String(option.id) === typeID);

  const submit = async () => {
    const position = Number(uStart);
    if (!device) return setError(tr('先选一台设备', 'Pick a device first'));
    if (!Number.isInteger(position) || position < 1) {
      return setError(tr('起始 U 位必须是正整数', 'The start unit must be a positive whole number'));
    }
    const height = units.trim() === '' ? undefined : Number(units);
    if (height != null && (!Number.isInteger(height) || height < 1)) {
      return setError(tr('高度必须是正整数', 'The height must be a positive whole number'));
    }
    setSubmitting(true);
    setError(null);
    try {
      const got = await mountDevice(roomID, rack.id, device.id, {
        u_start: position,
        ...(height != null ? { u_count: height } : {}),
      });
      await onSaved(tr(`已上架，机柜剩余 ${got.free_u_count}U`, `Mounted; ${got.free_u_count}U free`));
    } catch (failure) {
      setError(describeError(failure, tr('上架失败', 'Could not mount it')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('上架设备', 'Mount a device')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={submitting || !device}>
            {submitting ? tr('上架中…', 'Mounting…') : tr('上架', 'Mount')}
          </Button>
        </div>
      }
    >
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="dcim-mount-type">{tr('设备模型', 'Device model')}</Label>
          <Select
            id="dcim-mount-type"
            label={tr('设备模型', 'Device model')}
            value={typeID}
            onValueChange={(next) => {
              setTypeID(next);
              setDevice(null);
              setUnits('');
            }}
            options={types.map((option) => ({ value: String(option.id), label: option.label }))}
            searchable
            className="mt-1 w-full"
          />
          {!loadingTypes && types.length === 0 && (
            <p className="mt-1 text-[11px] text-amber-400">
              {tr('没有可上架的设备模型。先在模型配置里给机柜声明子模型。', 'No mountable device models. Declare rack child models in the model configuration first.')}
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="dcim-mount-device">{tr('设备', 'Device')}</Label>
          <div className="mt-1">
            <DevicePicker
              id="dcim-mount-device"
              type={active}
              value={device}
              onChange={(picked) => {
                setDevice(picked);
                if (picked.uCount > 0) setUnits(String(picked.uCount));
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="dcim-mount-start">{tr('起始 U 位', 'Start unit')}</Label>
            <Input
              id="dcim-mount-start"
              type="number"
              min={1}
              value={uStart}
              onChange={(event) => setUStart(event.target.value)}
              className="mt-1 w-full"
            />
          </div>
          <div>
            <Label htmlFor="dcim-mount-units">{tr('高度（留空用设备自身）', 'Height (blank = the device’s)')}</Label>
            <Input
              id="dcim-mount-units"
              type="number"
              min={1}
              value={units}
              onChange={(event) => setUnits(event.target.value)}
              className="mt-1 w-full"
            />
          </div>
        </div>
        <p className="text-[11px] text-text-faint">
          {tr(
            '容量由服务端在事务里重算：装不下、位置被占、或设备已在别的机柜里，都会被拒绝并说明原因。',
            'The server recomputes capacity in the transaction: too tall, position taken, or already in another rack are all refused with a reason.',
          )}
        </p>
      </div>
    </Modal>
  );
}

function DevicePicker({
  id,
  type,
  value,
  onChange,
}: {
  id: string;
  type: DeviceTypeOption | undefined;
  value: { id: number; name: string; uCount: number } | null;
  onChange(next: { id: number; name: string; uCount: number }): void;
}) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !type) return;
    let live = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void searchInstances(
        { q: instanceSearchQuery(type.id, search), count: 20, page },
        controller.signal,
      )
        .then((got) => {
          if (!live) return;
          setRows(got.result ?? []);
          setTotal(got.numfound ?? 0);
        })
        .catch((failure) => {
          if (!live || controller.signal.aborted) return;
          setRows([]);
          setTotal(0);
          setError(describeError(failure, tr('无法搜索设备', 'Could not search devices')));
        })
        .finally(() => live && setLoading(false));
    }, search.trim() ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, type, search, page, tr]);

  useEffect(() => {
    setPage(1);
  }, [search, type?.id]);

  const pages = Math.max(1, Math.ceil(total / 20));
  const labelOf = (row: SearchRow) =>
    (type?.showKey && row[type.showKey] != null ? String(row[type.showKey]) : '') ||
    referenceLabel(row, type?.model) ||
    `#${row._id}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            type="button"
            aria-label={tr('选择设备', 'Choose a device')}
            className="w-full justify-start font-normal"
            disabled={!type}
          >
            <span className={cn('min-w-0 flex-1 truncate text-left', !value && 'text-text-faint')}>
              {value?.name ?? tr('选择设备', 'Choose a device')}
            </span>
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[min(24rem,90vw)] p-2">
        <div className="relative mb-2">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden="true" />
          <Input
            type="search"
            aria-label={tr('搜索设备', 'Search devices')}
            placeholder={tr('按名称搜索', 'Search by name')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="max-h-56 overflow-y-auto">
          {loading ? (
            <p className="py-6 text-center text-xs text-text-muted">{tr('搜索中…', 'Searching…')}</p>
          ) : error ? (
            <p className="py-4 text-center text-xs text-red-300">{error}</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-muted">{tr('没有匹配的设备', 'No matching device')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {rows.map((row) => (
                <label
                  key={row._id}
                  className={cn(
                    'flex min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-card',
                    value?.id === row._id && 'bg-indigo-500/10',
                  )}
                >
                  <Radio
                    name="dcim-device"
                    checked={value?.id === row._id}
                    onChange={() => {
                      onChange({ id: row._id, name: labelOf(row), uCount: Number(row.u_count) || 0 });
                      setOpen(false);
                    }}
                    aria-label={labelOf(row)}
                  />
                  <span className="min-w-0 truncate">{labelOf(row)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-text-faint">
          <span>
            {total === 0 ? '0 / 0' : `${(page - 1) * 20 + 1}-${Math.min(page * 20, total)} / ${total}`}
          </span>
          <span className="flex items-center gap-1">
            <Button
              variant="plain"
              size="sm"
              type="button"
              aria-label={tr('上一页', 'Previous page')}
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
              className="inline-flex size-6 items-center justify-center p-0"
            >
              <ChevronLeft size={12} aria-hidden="true" />
            </Button>
            <Button
              variant="plain"
              size="sm"
              type="button"
              aria-label={tr('下一页', 'Next page')}
              disabled={page >= pages}
              onClick={() => setPage((current) => current + 1)}
              className="inline-flex size-6 items-center justify-center p-0"
            >
              <ChevronRight size={12} aria-hidden="true" />
            </Button>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// --- move within a rack ---

export function MoveDeviceDialog({
  rack,
  roomID,
  device,
  onClose,
  onSaved,
}: {
  rack: RackRow;
  roomID: number;
  device: RackDevice;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const [start, setStart] = useState(String(device.uStart ?? 1));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const position = Number(start);
    if (!Number.isInteger(position) || position < 1) {
      return setError(tr('目标起始 U 位必须是正整数', 'The target start unit must be a positive whole number'));
    }
    setSubmitting(true);
    setError(null);
    try {
      await moveDevice(roomID, rack.id, device.id, { to_u_start: position });
      await onSaved(tr('已移动', 'Moved'));
    } catch (failure) {
      setError(describeError(failure, tr('移动失败', 'Could not move it')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('移动设备', 'Move a device')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={submitting}>
            {submitting ? tr('移动中…', 'Moving…') : tr('移动', 'Move')}
          </Button>
        </div>
      }
    >
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      <p className="mb-3 text-xs text-text-muted">
        {tr(`在「${rack.name}」内移动「${device.name}」。`, `Move “${device.name}” within “${rack.name}”.`)}
      </p>
      <Label htmlFor="dcim-move-start">{tr('目标起始 U 位', 'Target start unit')}</Label>
      <Input
        id="dcim-move-start"
        type="number"
        min={1}
        value={start}
        onChange={(event) => setStart(event.target.value)}
        className="mt-1 w-32"
      />
      <p className="mt-2 text-[11px] text-text-faint">
        {tr('位置被占或超出机柜高度时，服务端会拒绝并说明原因。', 'The server refuses a taken position or one past the rack’s height, and says why.')}
      </p>
    </Modal>
  );
}

// --- migrate to another rack ---

export function MigrateDeviceDialog({
  rack,
  roomID,
  racks,
  device,
  onClose,
  onSaved,
}: {
  rack: RackRow;
  roomID: number;
  racks: RackRow[];
  device: RackDevice;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const [target, setTarget] = useState('');
  const [start, setStart] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const rackID = Number(target);
    const position = Number(start);
    if (!rackID) return setError(tr('先选目标机柜', 'Choose a target rack first'));
    if (!Number.isInteger(position) || position < 1) {
      return setError(tr('目标起始 U 位必须是正整数', 'The target start unit must be a positive whole number'));
    }
    setSubmitting(true);
    setError(null);
    try {
      await moveDevice(roomID, rack.id, device.id, { to_rack_id: rackID, to_u_start: position });
      await onSaved(tr('已迁移', 'Migrated'));
    } catch (failure) {
      setError(describeError(failure, tr('迁移失败', 'Could not migrate it')));
    } finally {
      setSubmitting(false);
    }
  };

  const options = racks
    .filter((candidate) => candidate.id !== rack.id)
    .map((candidate) => ({ value: String(candidate.id), label: candidate.name }));

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('迁移设备', 'Migrate a device')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={submitting}>
            {submitting ? tr('迁移中…', 'Migrating…') : tr('迁移', 'Migrate')}
          </Button>
        </div>
      }
    >
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="dcim-migrate-rack">{tr('目标机柜', 'Target rack')}</Label>
          <Select
            id="dcim-migrate-rack"
            label={tr('目标机柜', 'Target rack')}
            value={target}
            onValueChange={setTarget}
            options={options}
            placeholder={tr('选择机柜', 'Choose a rack')}
            className="mt-1 w-full"
          />
          {options.length === 0 && (
            <p className="mt-1 text-[11px] text-text-faint">
              {tr('这个机房里没有别的机柜。', 'There is no other rack in this room.')}
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="dcim-migrate-start">{tr('目标起始 U 位', 'Target start unit')}</Label>
          <Input
            id="dcim-migrate-start"
            type="number"
            min={1}
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className="mt-1 w-32"
          />
        </div>
      </div>
    </Modal>
  );
}

// --- overlap details ---

export function AbnormalDialog({
  unit,
  canMutate,
  onClose,
  onMove,
}: {
  unit: RackDeviceUnit;
  canMutate: boolean;
  onClose(): void;
  onMove(device: RackDevice): void;
}) {
  const { tr } = useI18n();
  const devices = [unit.device, ...unit.conflicts];
  const [selected, setSelected] = useState(unit.device.id);
  const chosen = devices.find((device) => device.id === selected) ?? unit.device;

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('U 位异常', 'U slot conflict')}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose}>
            {canMutate ? tr('取消', 'Cancel') : tr('关闭', 'Close')}
          </Button>
          {canMutate && (
            <Button
              variant="primary"
              type="button"
              onClick={() => {
                onMove(chosen);
                onClose();
              }}
            >
              {tr('调整位置', 'Change position')}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex items-start gap-2">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-xs text-text">
            {unit.conflicts.length > 0
              ? tr(
                  '这些设备占用了同一个 U 位。选择一台调整位置，服务端会重新校验。',
                  'These devices occupy the same U. Pick one to move; the server revalidates the placement.',
                )
              : tr(
                  '这台设备的高度超出了机柜。选择它调整位置。',
                  'This device runs past the rack’s height. Pick it to change its position.',
                )}
          </p>
          <p className="mt-1 text-[11px] text-text-faint">
            {tr('涉及设备：', 'Devices: ')}
            {devices.map((device) => device.name).join('、')}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {devices.map((device) => (
          <label key={device.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-card">
            <Radio
              name="dcim-abnormal-device"
              checked={selected === device.id}
              onChange={() => setSelected(device.id)}
              aria-label={device.name}
            />
            <span className="min-w-0 flex-1 truncate">{device.name}</span>
            <span className="text-[10px] text-text-faint">
              U{device.uStart ?? '—'} · {device.uCount}U
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
