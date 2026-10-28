import { useEffect, useId, useMemo, useState } from 'react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import { listTypeAttributes } from '../../api/citype';
import { describeError } from '../../api/http';
import {
  ADDRESS_ASSIGNED,
  ADDRESS_RESERVED,
  ADDRESS_UNASSIGNED,
  assignAddresses,
  type AddressAssignInput,
} from '../../api/ipam';
import {
  assignStatusLabel,
  derivedStatus,
  derivedStatusLabel,
  type AddressRecord,
} from '../../lib/ipam';

type Field = 'usage' | 'useObj' | 'description' | 'macAddress' | 'gateway' | 'subnetMask';

const FIELDS: Array<{ key: Field; zh: string; en: string }> = [
  { key: 'usage', zh: '用途', en: 'Usage' },
  { key: 'description', zh: '描述', en: 'Description' },
  { key: 'macAddress', zh: 'MAC', en: 'MAC' },
  { key: 'gateway', zh: '网关', en: 'Gateway' },
  { key: 'subnetMask', zh: '子网掩码', en: 'Subnet mask' },
];

const FIELD_WIRE: Record<Field, keyof AddressAssignInput> = {
  usage: 'usage',
  useObj: 'use_obj',
  description: 'description',
  macAddress: 'mac_address',
  gateway: 'gateway',
  subnetMask: 'subnet_mask',
};

export function AddressEditor({
  rows,
  subnetID,
  onClose,
  onSaved,
}: {
  rows: AddressRecord[];
  subnetID: number;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const formID = useId();
  const [status, setStatus] = useState<string>('mixed');
  const [values, setValues] = useState<Record<Field, string>>({
    usage: '',
    useObj: '',
    description: '',
    macAddress: '',
    gateway: '',
    subnetMask: '',
  });
  const [useObjOptions, setUseObjOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [useObjIsChoice, setUseObjIsChoice] = useState(false);
  // Which of the optional fields this address model actually declares. A
  // deployment whose model has only ip/assign_status/is_used gets a three-field
  // dialog rather than six inputs the server would drop.
  const [available, setAvailable] = useState<Set<string> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const single = rows.length === 1 ? rows[0] : null;

  // Seed once per selection. A batch starts blank because writing one row's
  // value to the others would be an edit the operator did not ask for.
  useEffect(() => {
    if (!single) {
      const common = new Set(rows.map((row) => row.assignStatus));
      setStatus(common.size === 1 ? String([...common][0]) : 'mixed');
      setValues({ usage: '', useObj: '', description: '', macAddress: '', gateway: '', subnetMask: '' });
      return;
    }
    setStatus(String(single.assignStatus));
    setValues({
      usage: single.usage ?? '',
      useObj: single.useObj ?? '',
      description: single.description ?? '',
      macAddress: single.macAddress ?? '',
      gateway: single.gateway ?? '',
      subnetMask: single.subnetMask ?? '',
    });
  }, [rows, single]);

  // use_obj is admin-defined data: a choice on the model is a select, free text
  // elsewhere. A stored value that is no longer an option is kept visible.
  useEffect(() => {
    let live = true;
    void listTypeAttributes('ipam_address')
      .then((got) => {
        if (!live) return;
        setAvailable(new Set(got.attributes.map((item) => item.name)));
        const attribute = got.attributes.find((item) => item.name === 'use_obj');
        setUseObjIsChoice(Boolean(attribute?.is_choice));
        const options = (attribute?.choice_value ?? []).map((choice) => ({
          value: String(choice.value),
          label:
            typeof choice.option?.label === 'string'
              ? choice.option.label
              : String(choice.value),
        }));
        const stored = single?.useObj;
        if (stored && !options.some((option) => option.value === stored)) {
          options.push({ value: stored, label: stored });
        }
        setUseObjOptions(options);
      })
      .catch(() => live && setUseObjOptions([]));
    return () => {
      live = false;
    };
  }, [single?.useObj]);

  const statusOptions = useMemo(() => {
    const options = [
      { value: String(ADDRESS_ASSIGNED), label: assignStatusLabel(ADDRESS_ASSIGNED, tr) },
      { value: String(ADDRESS_UNASSIGNED), label: assignStatusLabel(ADDRESS_UNASSIGNED, tr) },
      { value: String(ADDRESS_RESERVED), label: assignStatusLabel(ADDRESS_RESERVED, tr) },
    ];
    if (status === 'mixed') {
      options.unshift({ value: 'mixed', label: tr('请选择状态', 'Choose a state') });
    }
    return options;
  }, [status, tr]);

  const submit = async () => {
    if (status === 'mixed') {
      setError(tr('请选择分配状态', 'Choose an assign state'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const input: AddressAssignInput = {
        subnet_id: subnetID,
        ips: rows.map((row) => row.ip),
        assign_status: Number(status),
      };
      for (const field of [...FIELDS.map((item) => item.key), 'useObj' as const]) {
        const value = values[field].trim();
        if (!value) continue;
        if (field === 'useObj' && useObjIsChoice && !useObjOptions.some((option) => option.value === value)) {
          continue;
        }
        (input as Record<string, unknown>)[FIELD_WIRE[field]] = value;
      }
      await assignAddresses(input);
      await onSaved(tr(`已更新 ${rows.length} 个地址`, `Updated ${rows.length} address(es)`));
    } catch (failure) {
      setError(describeError(failure, tr('保存失败', 'Could not save them')));
    } finally {
      setSubmitting(false);
    }
  };

  const recycle = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await assignAddresses({
        subnet_id: subnetID,
        ips: rows.map((row) => row.ip),
        assign_status: ADDRESS_UNASSIGNED,
      });
      await onSaved(tr(`已回收 ${rows.length} 个地址`, `Recycled ${rows.length} address(es)`));
    } catch (failure) {
      setError(describeError(failure, tr('回收失败', 'Could not recycle them')));
    } finally {
      setSubmitting(false);
    }
  };

  const summary = rows.slice(0, 3).map((row) => row.ip).join(', ');
  const more = rows.length > 3 ? ` +${rows.length - 3}` : '';
  const has = (name: string) => !available || available.has(name);

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('编辑 IP 用途', 'Edit IP usage')}
      size="lg"
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="dangerGhost" type="button" onClick={() => void recycle()} disabled={submitting}>
            {tr('回收', 'Recycle')}
          </Button>
          <Button variant="primary" type="submit" form={formID} disabled={submitting}>
            {submitting ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </>
      }
    >
      <form
        id={formID}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        <p className="text-xs text-text-muted">
          {tr(`已选择 ${rows.length} 个 IP`, `${rows.length} IP(s) selected`)}
        </p>
        <div className="break-all rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-text-muted">
          {summary}
          {more}
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ipam-address-status">{tr('状态', 'State')}</Label>
            <Select
              id="ipam-address-status"
              label={tr('状态', 'State')}
              value={status}
              onValueChange={setStatus}
              options={statusOptions}
              className="mt-1 w-full"
            />
          </div>
          {has('use_obj') && (
          <div>
            <Label htmlFor="ipam-address-use-obj">{tr('使用对象', 'Used by')}</Label>
            {useObjIsChoice ? (
              <Select
                id="ipam-address-use-obj"
                label={tr('使用对象', 'Used by')}
                value={values.useObj}
                onValueChange={(next) => setValues((current) => ({ ...current, useObj: next }))}
                options={[{ value: '', label: tr('选择', 'Select') }, ...useObjOptions]}
                placeholder={tr('选择', 'Select')}
                searchable={useObjOptions.length > 10}
                className="mt-1 w-full"
              />
            ) : (
              <Input
                id="ipam-address-use-obj"
                value={values.useObj}
                onChange={(event) => setValues((current) => ({ ...current, useObj: event.target.value }))}
                className="mt-1 w-full"
              />
            )}
          </div>
          )}
          {FIELDS.filter((field) => has(String(FIELD_WIRE[field.key]))).map((field) => (
            <div key={field.key}>
              <Label htmlFor={`ipam-address-${field.key}`}>{tr(field.zh, field.en)}</Label>
              <Input
                id={`ipam-address-${field.key}`}
                value={values[field.key]}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
                placeholder={single ? undefined : tr('留空表示不修改', 'Blank leaves it unchanged')}
                className="mt-1 w-full"
              />
            </div>
          ))}
        </div>
        <p className="text-[11px] text-text-faint">
          {single
            ? tr(
                `当前派生状态：${derivedStatusLabel(derivedStatus(single), tr)}。清空字段表示保持原值。`,
                `Current derived state: ${derivedStatusLabel(derivedStatus(single), tr)}. Clearing a field leaves it unchanged.`,
              )
            : tr(
                '批量编辑时留空的字段不会被写入；状态必须明确选择。',
                'In a batch, blank fields are not written and the state must be chosen explicitly.',
              )}
        </p>
      </form>
    </Modal>
  );
}
