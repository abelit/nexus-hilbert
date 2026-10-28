import { useEffect, useMemo, useState } from 'react';

import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  listTypeAttributes,
  type CIType,
  type TypeAttribute,
} from '../../api/citype';
import { getShowFields } from '../../api/preferences';
import {
  attributeDisplay,
  attributeLabel,
  rackFieldColumns,
  type RackDevice,
} from '../../lib/dcim';
import type { ExportColumn } from '../../lib/export';
import { DataTable, type Column } from '../DataTable';
import { ExportMenu } from '../ipam/ExportMenu';

// The rack's devices, one table per device model. A rack can hold servers,
// switches and storage side by side; showing one wide table would make every
// row pay for the columns of every other kind, and the preference fields are
// chosen per model.
export function DeviceListTab({ devices, models }: { devices: RackDevice[]; models: CIType[] }) {
  const { tr } = useI18n();
  const types = useMemo(() => {
    const seen = new Map<number, { id: number; label: string; count: number }>();
    for (const device of devices) {
      const existing = seen.get(device.typeID);
      if (existing) existing.count += 1;
      else seen.set(device.typeID, { id: device.typeID, label: device.typeAlias || device.typeName, count: 1 });
    }
    return [...seen.values()];
  }, [devices]);

  const [activeID, setActiveID] = useState<number | null>(types[0]?.id ?? null);
  useEffect(() => {
    if (activeID != null && types.some((type) => type.id === activeID)) return;
    setActiveID(types[0]?.id ?? null);
  }, [types, activeID]);

  const model = models.find((candidate) => candidate.id === activeID);
  const [fields, setFields] = useState<TypeAttribute[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeID == null) {
      setFields([]);
      return;
    }
    let live = true;
    setLoading(true);
    setFields([]);
    void Promise.all([
      listTypeAttributes(activeID).catch(() => null),
      getShowFields(activeID).catch(() => null),
    ])
      .then(([attrs, show]) => {
        if (!live) return;
        const list = attrs?.attributes ?? [];
        setFields(
          rackFieldColumns(
            list,
            (show?.fields ?? []).map((field) => ({ attr_id: field.attr_id, name: field.name })),
            model?.unique_key,
          ).filter(
            (attribute) =>
              attribute.name !== 'u_start' &&
              attribute.name !== 'u_count' &&
              attribute.name !== 'name' &&
              attribute.name !== model?.unique_key,
          ),
        );
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [activeID, model?.unique_key]);

  const rows = useMemo(
    () => devices.filter((device) => device.typeID === activeID),
    [devices, activeID],
  );

  const columns: Column<RackDevice>[] = [
    {
      key: 'name',
      header: tr('设备', 'Device'),
      width: 'w-full max-sm:w-auto',
      sortable: true,
      sortValue: (device) => device.name,
      cell: (device) => (
        <span className="block min-w-0">
          <span className="block truncate text-xs font-medium text-text" title={device.name}>
            {device.name}
          </span>
          <span className="mt-0.5 block text-[10px] text-text-faint">#{device.id}</span>
        </span>
      ),
    },
    {
      key: 'u_start',
      header: tr('起始 U', 'Start U'),
      align: 'right',
      sortable: true,
      sortValue: (device) => device.uStart ?? Number.MAX_SAFE_INTEGER,
      cell: (device) => <span className="tabular-nums text-xs text-text-muted">{device.uStart ?? '—'}</span>,
    },
    {
      key: 'u_count',
      header: tr('高度', 'Height'),
      align: 'right',
      sortable: true,
      sortValue: (device) => device.uCount,
      cell: (device) => <span className="tabular-nums text-xs text-text-muted">{device.uCount}U</span>,
    },
    ...fields.map((attribute, index): Column<RackDevice> => ({
      key: `attr-${attribute.id}`,
      header: attributeLabel(attribute),
      hideBelow: index >= 2 ? 1400 : undefined,
      sortable: true,
      sortValue: (device) => attributeDisplay(attribute, device.row[attribute.name]),
      cell: (device) => {
        const value = device.row[attribute.name];
        return (
          <span className="block max-w-48 truncate text-xs text-text-muted" title={attributeDisplay(attribute, value)}>
            {attributeDisplay(attribute, value)}
          </span>
        );
      },
    })),
  ];

  const exportColumns: ExportColumn<RackDevice>[] = [
    { key: 'name', header: tr('设备', 'Device'), value: (device) => device.name },
    { key: 'u_start', header: tr('起始 U', 'Start U'), value: (device) => device.uStart ?? '' },
    { key: 'u_count', header: tr('高度', 'Height'), value: (device) => device.uCount },
    ...fields.map((attribute) => ({
      key: attribute.name,
      header: attributeLabel(attribute),
      value: (device: RackDevice) => attributeDisplay(attribute, device.row[attribute.name]),
    })),
  ];

  if (devices.length === 0) {
    return (
      <EmptyState
        title={tr('这个机柜还是空的', 'This rack is empty')}
        hint={tr('在“机柜视图”里点一个空 U 位就能上架设备。', 'Click an empty U in the rack view to mount a device.')}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={tr('设备类型', 'Device types')}>
          {types.map((type) => (
            <button
              key={type.id}
              type="button"
              aria-pressed={activeID === type.id}
              onClick={() => setActiveID(type.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors',
                activeID === type.id
                  ? 'border-indigo-500/40 bg-indigo-500/10 text-text'
                  : 'border-transparent bg-card text-text-muted hover:text-text',
              )}
            >
              <span className="max-w-40 truncate">{type.label}</span>
              <Chip dense>{type.count}</Chip>
            </button>
          ))}
        </div>
        <ExportMenu
          filename="dcim-devices"
          columns={exportColumns}
          rows={rows}
          disabled={rows.length === 0}
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(device) => device.id}
        loading={loading}
        storageKey={`dcim-devices-${activeID ?? 'none'}`}
        empty={tr('这个类型还没有设备', 'No devices of this type')}
      />
    </div>
  );
}
