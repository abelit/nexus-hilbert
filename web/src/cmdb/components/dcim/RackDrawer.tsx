import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useI18n } from '@/i18n/locale';

import { relationChildren, type RelatedType } from '../../api/citype';
import { deleteDCIMNode, moveDevice, unmountDevice } from '../../api/dcim';
import { describeError } from '../../api/http';
import { searchHierarchy } from '../../api/instance';
import {
  toRackDevice,
  type RackDevice,
  type RackDeviceUnit,
  type RackRow,
} from '../../lib/dcim';
import { Drawer } from '../Drawer';
import { useToast } from '../Toast';
import { useDialogs } from '@/components/ui/useDialogs';
import { DeviceListTab } from './DeviceListTab';
import {
  AbnormalDialog,
  MigrateDeviceDialog,
  MountDeviceDialog,
  MoveDeviceDialog,
} from './Dialogs';
import { useDCIM } from './context';
import { OperationLogTab } from './OperationLogTab';
import { RackAttrsTab } from './RackAttrsTab';
import { RackUnitView } from './RackUnitView';

type Tab = 'view' | 'attributes' | 'devices' | 'log';

type Dialog =
  | { kind: 'mount'; start?: number }
  | { kind: 'move'; device: RackDevice }
  | { kind: 'migrate'; device: RackDevice }
  | { kind: 'abnormal'; unit: RackDeviceUnit }
  | null;

export function RackDrawer({
  rack,
  roomID,
  onClose,
  onEdit,
  onDeleted,
}: {
  rack: RackRow;
  roomID: number;
  onClose(): void;
  onEdit(): void;
  onDeleted(): void;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const { rackType, rackAttributes, rackGroups, models, racks, tick, bump, canMutate } = useDCIM();
  const [tab, setTab] = useState<Tab>('view');
  const [devices, setDevices] = useState<RackDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Dialog>(null);

  useEffect(() => {
    setTab('view');
    setOpen(null);
  }, [rack.id]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [page, children] = await Promise.all([
        searchHierarchy({ rootIDs: [rack.id], levels: [1], count: 500 }),
        rackType ? relationChildren(rackType.id).catch(() => [] as RelatedType[]) : Promise.resolve([] as RelatedType[]),
      ]);
      const showKeys = new Map<number, string>();
      for (const child of children) {
        if (child.show_key) showKeys.set(child.type.id, child.show_key);
      }
      const mapped = (page.result ?? [])
        .map((row) => toRackDevice(row, showKeys.get(Number(row._type))))
        .sort((left, right) => (left.uStart ?? Infinity) - (right.uStart ?? Infinity) || left.id - right.id);
      setDevices(mapped);
    } catch (failure) {
      setDevices([]);
      setError(describeError(failure, tr('无法读取机柜内容', 'Could not load the rack’s contents')));
    } finally {
      setLoading(false);
    }
  }, [rack.id, rackType, tr]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  // One bump refetches the devices (drawer effect), the room's racks and the
  // operation log; calling each loader here would do the same work twice.
  const finished = (message: string) => {
    setOpen(null);
    toast.success(message);
    bump();
  };

  const unmount = async (device: RackDevice) => {
    if (!(await confirmAction(tr(`把「${device.name}」从机柜上取下来？`, `Unmount “${device.name}” from the rack?`)))) return;
    try {
      await unmountDevice(roomID, rack.id, device.id);
      toast.success(tr('已下架', 'Unmounted'));
      bump();
    } catch (failure) {
      toast.error(describeError(failure, tr('下架失败', 'Could not unmount it')));
    }
  };

  const moveTo = async (device: RackDevice, uStart: number) => {
    try {
      await moveDevice(roomID, rack.id, device.id, { to_u_start: uStart });
      toast.success(tr(`已移动到 U${uStart}`, `Moved to U${uStart}`));
      bump();
    } catch (failure) {
      toast.error(describeError(failure, tr('移动失败', 'Could not move it')));
    }
  };

  const removeRack = async () => {
    const ok = await confirmAction(
      tr(
        `删除「${rack.name}」？机柜里的设备会被下架。`,
        `Delete “${rack.name}”? The devices inside will be unmounted.`,
      ),
    );
    if (!ok) return;
    try {
      await deleteDCIMNode('rack', rack.id);
      toast.success(tr('已删除', 'Deleted'));
      onDeleted();
    } catch (failure) {
      toast.error(describeError(failure, tr('删除失败', 'Could not delete it')));
    }
  };

  const facts = [
    { label: tr('设备', 'Devices'), value: devices.length },
    { label: tr('高度', 'Height'), value: `${rack.uCount}U` },
    { label: tr('空闲', 'Free'), value: `${rack.freeUCount}U` },
    { label: tr('使用率', 'Used'), value: `${rack.usedRatio}%` },
  ];

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        size="xl"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-text-muted">{tr('机柜', 'Rack')}</span>
            <span className="truncate" title={rack.name}>{rack.name}</span>
            {rack.abnormal && <Chip tone="danger">{tr('U 位异常', 'U conflict')}</Chip>}
          </span>
        }
        description={
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {facts.map((fact) => (
              <span key={fact.label}>
                {fact.label} <span className="font-medium text-text">{fact.value}</span>
              </span>
            ))}
          </span>
        }
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {canMutate && (
              <>
                <Button variant="outline" type="button" onClick={onEdit} className="inline-flex items-center gap-1.5">
                  <Pencil size={12} aria-hidden="true" />
                  {tr('编辑机柜', 'Edit rack')}
                </Button>
                <Button variant="dangerGhost" type="button" onClick={() => void removeRack()} className="inline-flex items-center gap-1.5">
                  <Trash2 size={12} aria-hidden="true" />
                  {tr('删除', 'Delete')}
                </Button>
                <span className="flex-1" />
                <Button variant="primary" type="button" onClick={() => setOpen({ kind: 'mount' })} className="inline-flex items-center gap-1.5">
                  <Plus size={12} aria-hidden="true" />
                  {tr('上架设备', 'Mount a device')}
                </Button>
              </>
            )}
            {!canMutate && (
              <Button variant="outline" type="button" onClick={onClose}>
                {tr('关闭', 'Close')}
              </Button>
            )}
          </div>
        }
      >
        <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
          <TabsList className="mb-3 flex-wrap">
            <TabsTrigger value="view">{tr('机柜视图', 'Rack view')}</TabsTrigger>
            <TabsTrigger value="attributes">{tr('属性', 'Attributes')}</TabsTrigger>
            <TabsTrigger value="devices">{tr('设备列表', 'Devices')}</TabsTrigger>
            <TabsTrigger value="log">{tr('操作日志', 'Operation log')}</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === 'view' && (
          <RackUnitView
            rack={rack}
            devices={devices}
            loading={loading}
            error={error}
            onMountAt={(start) => setOpen({ kind: 'mount', start })}
            onMove={(device) => setOpen({ kind: 'move', device })}
            onMigrate={(device) => setOpen({ kind: 'migrate', device })}
            onUnmount={(device) => void unmount(device)}
            onAbnormal={(unit) => setOpen({ kind: 'abnormal', unit })}
            onMoveTo={(device, start) => void moveTo(device, start)}
            canMutate={canMutate}
          />
        )}
        {tab === 'attributes' && (
          <RackAttrsTab rack={rack} attributes={rackAttributes} groups={rackGroups} models={models} />
        )}
        {tab === 'devices' && <DeviceListTab devices={devices} models={models} />}
        {tab === 'log' && <OperationLogTab rackID={rack.id} tick={tick} />}
      </Drawer>

      {open?.kind === 'mount' && (
        <MountDeviceDialog
          rack={rack}
          roomID={roomID}
          start={open.start}
          onClose={() => setOpen(null)}
          onSaved={(message) => finished(message)}
        />
      )}
      {open?.kind === 'move' && (
        <MoveDeviceDialog
          rack={rack}
          roomID={roomID}
          device={open.device}
          onClose={() => setOpen(null)}
          onSaved={(message) => finished(message)}
        />
      )}
      {open?.kind === 'migrate' && (
        <MigrateDeviceDialog
          rack={rack}
          roomID={roomID}
          racks={racks}
          device={open.device}
          onClose={() => setOpen(null)}
          onSaved={(message) => finished(message)}
        />
      )}
      {open?.kind === 'abnormal' && (
        <AbnormalDialog
          unit={open.unit}
          canMutate={canMutate}
          onClose={() => setOpen(null)}
          onMove={(device) => {
            setOpen({ kind: 'move', device });
          }}
        />
      )}

      {dialog}
    </>
  );
}
