import { useMemo, useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, ArrowUpDown, MoveRight, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  buildRackOccupancy,
  displayRackUnits,
  type RackDevice,
  type RackDeviceUnit,
  type RackRow,
} from '../../lib/dcim';
import { deviceImage, rackFrontPart, rackRearPart, type RackFace } from '../../lib/dcim-images';

// The rack's U picture, drawn as the physical object cantor showed: a metal
// frame, a perforated top strip, alternating U-number rails and the device
// art for each face. The arithmetic lives in lib/dcim; this file only paints
// it. Both faces share one occupancy list, so moving a device in the front
// view is the same mutation as moving it in the rear one.

const UNIT_HEIGHT = 24;
const RACK_WIDTH = 236;

const RACK_COLORS = {
  countEven: '#3D4151',
  countOdd: '#5E6772',
  device: '#2C2D31',
  deviceHeader: '#5D6271',
  gapFront: '#EBEFF8',
  gapRear: '#CACDD9',
} as const;

export function RackUnitView({
  rack,
  devices,
  loading,
  error,
  onMountAt,
  onMove,
  onMigrate,
  onUnmount,
  onAbnormal,
  onMoveTo,
  canMutate,
}: {
  rack: RackRow;
  devices: RackDevice[];
  loading: boolean;
  error: string | null;
  onMountAt(uStart: number): void;
  onMove(device: RackDevice): void;
  onMigrate(device: RackDevice): void;
  onUnmount(device: RackDevice): void;
  onAbnormal(unit: RackDeviceUnit): void;
  onMoveTo(device: RackDevice, uStart: number): void;
  canMutate: boolean;
}) {
  const { tr } = useI18n();
  const [dragging, setDragging] = useState<RackDevice | null>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);
  // A drag can emit dragover before React commits the state from dragstart;
  // the ref is what the drop handlers consult.
  const draggingRef = useRef<RackDevice | null>(null);

  const occupancy = useMemo(
    () => buildRackOccupancy(devices, rack.uCount),
    [devices, rack.uCount],
  );
  const display = useMemo(
    () => displayRackUnits(occupancy.units, rack.numbering),
    [occupancy.units, rack.numbering],
  );

  if (loading && devices.length === 0) {
    return <p className="py-10 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>;
  }
  if (error) {
    return (
      <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
        {error}
      </div>
    );
  }
  if (rack.uCount <= 0) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        {tr('这个机柜没有填写高度（u_count），无法绘制 U 位。', 'This rack has no height (`u_count`), so there is no U grid to draw.')}
      </div>
    );
  }

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const device = draggingRef.current;
    draggingRef.current = null;
    setDragging(null);
    setDropRow(null);
    if (!device || !canMutate) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const row = Math.max(0, Math.min(rack.uCount - 1, Math.floor((event.clientY - rect.top) / UNIT_HEIGHT)));
    const rawStart = rack.numbering === 'top_to_bottom' ? row + 1 : rack.uCount - row;
    const target = Math.max(1, Math.min(rawStart, rack.uCount - device.uCount + 1));
    if (target === device.uStart) return;
    onMoveTo(device, target);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {occupancy.unplaced.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          <p>
            {tr(
              `${occupancy.unplaced.length} 台设备的 U 位在机柜之外，未画进视图。`,
              `${occupancy.unplaced.length} device(s) sit outside the rack's range and are not drawn.`,
            )}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {occupancy.unplaced.map((device) => (
              <button
                key={device.id}
                type="button"
                disabled={!canMutate}
                onClick={() => onMove(device)}
                className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] hover:bg-amber-500/10 disabled:cursor-default disabled:opacity-70"
                title={canMutate ? tr(`移动 ${device.name}`, `Move ${device.name}`) : device.name}
              >
                {device.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-wrap justify-center gap-12 overflow-x-auto pb-2">
        {(['front', 'rear'] as const).map((face) => (
          <RackFaceView
            key={face}
            face={face}
            rack={rack}
            display={display}
            dragging={dragging}
            dropRow={dropRow}
            canMutate={canMutate}
            onDrop={drop}
            onDragOver={(event) => {
              if (!draggingRef.current) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              setDropRow(Math.max(0, Math.min(rack.uCount - 1, Math.floor((event.clientY - rect.top) / UNIT_HEIGHT))));
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDropRow(null);
            }}
            onDragStart={(device) => {
              draggingRef.current = device;
              setDragging(device);
            }}
            onDragEnd={() => {
              draggingRef.current = null;
              setDragging(null);
              setDropRow(null);
            }}
            onMountAt={onMountAt}
            onMove={onMove}
            onMigrate={onMigrate}
            onUnmount={onUnmount}
            onAbnormal={onAbnormal}
          />
        ))}
      </div>

      <p className="text-[11px] text-text-faint">
        {tr(
          '点击空 U 位可上架；拖动设备可调整位置。设备上的按钮提供移动、迁移和下架。',
          'Click an empty U to mount; drag a device to reposition it. Its buttons offer move, migrate and unmount.',
        )}
      </p>
    </div>
  );
}

function RackFaceView({
  face,
  rack,
  display,
  dragging,
  dropRow,
  canMutate,
  onDrop,
  onDragOver,
  onDragLeave,
  onDragStart,
  onDragEnd,
  onMountAt,
  onMove,
  onMigrate,
  onUnmount,
  onAbnormal,
}: {
  face: RackFace;
  rack: RackRow;
  display: ReturnType<typeof displayRackUnits>;
  dragging: RackDevice | null;
  dropRow: number | null;
  canMutate: boolean;
  onDrop(event: DragEvent<HTMLDivElement>): void;
  onDragOver(event: DragEvent<HTMLDivElement>): void;
  onDragLeave(event: DragEvent<HTMLDivElement>): void;
  onDragStart(device: RackDevice): void;
  onDragEnd(): void;
  onMountAt(uStart: number): void;
  onMove(device: RackDevice): void;
  onMigrate(device: RackDevice): void;
  onUnmount(device: RackDevice): void;
  onAbnormal(unit: RackDeviceUnit): void;
}) {
  const { tr } = useI18n();
  const rear = face === 'rear';

  return (
    <div className="flex shrink-0 flex-col" style={{ width: RACK_WIDTH }}>
      <div className="mb-3.5 text-center text-base font-bold text-text-muted">
        {rear ? tr('后视图', 'Rear view') : tr('前视图', 'Front view')}
      </div>

      <div className="overflow-hidden rounded-t-md">
        <div className="h-[5px] bg-zinc-700 pt-[3px]">
          <div className={cn('h-px w-full', rear ? 'bg-white' : 'bg-cyan-200/80')} />
        </div>
        <div className={cn('flex h-[21px] w-full items-center border-b border-white bg-slate-400', rear ? 'px-[22px]' : 'px-2')}>
          {!rear && (
            <div className="me-[7px] flex shrink-0 items-center gap-[5px]">
              <span className="size-1.5 rounded-full border border-white bg-emerald-200" aria-hidden="true" />
              <span className="size-1.5 rounded-full border border-white bg-emerald-200" aria-hidden="true" />
              <span className="size-1.5 rounded-full border border-white bg-emerald-200" aria-hidden="true" />
            </div>
          )}
          <div
            className="h-2.5 w-full"
            aria-hidden="true"
            style={{
              backgroundImage: 'radial-gradient(circle, rgba(226,232,240,0.9) 0.4px, transparent 0.6px)',
              backgroundSize: '2px 2px',
            }}
          />
        </div>
      </div>

      <div className={cn('flex w-full', rear && 'flex-row-reverse')}>
        <div className="z-[2] min-w-[18px] shrink-0" aria-hidden="true">
          {Array.from({ length: rack.uCount }, (_, index) => {
            const u = rack.numbering === 'top_to_bottom' ? index + 1 : rack.uCount - index;
            return (
              <div
                key={u}
                className="border-b border-slate-400/25 text-center text-xs font-medium leading-6 text-white"
                style={{
                  height: UNIT_HEIGHT,
                  backgroundColor: (index + 1) % 2 === 0 ? RACK_COLORS.countEven : RACK_COLORS.countOdd,
                }}
              >
                {u}
              </div>
            );
          })}
        </div>

        <div
          className="min-w-0 flex-1"
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {display.map((unit) =>
            unit.kind === 'device' ? (
              <DeviceBlock
                key={unit.key}
                unit={unit}
                face={face}
                canMutate={canMutate}
                dragging={dragging?.id === unit.device.id}
                onDragStart={() => onDragStart(unit.device)}
                onDragEnd={onDragEnd}
                onMove={() => onMove(unit.device)}
                onMigrate={() => onMigrate(unit.device)}
                onUnmount={() => onUnmount(unit.device)}
                onAbnormal={() => onAbnormal(unit)}
              />
            ) : canMutate ? (
              <button
                key={unit.key}
                type="button"
                onClick={() => onMountAt(unit.uStart)}
                aria-label={tr(`在 U${unit.uStart} 上架设备`, `Mount a device at U${unit.uStart}`)}
                className={cn(
                  'group flex w-full items-center justify-center border-b border-slate-400/25 text-[9px] text-transparent transition-[filter]',
                  dragging && 'hover:brightness-95',
                )}
                style={{
                  height: UNIT_HEIGHT,
                  backgroundColor:
                    dropRow === (rack.numbering === 'top_to_bottom' ? unit.uStart - 1 : rack.uCount - unit.uStart)
                      ? 'rgba(129,140,248,0.45)'
                      : rear
                        ? RACK_COLORS.gapRear
                        : RACK_COLORS.gapFront,
                }}
              >
                <Plus size={10} aria-hidden="true" className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                <span className="hidden group-hover:inline group-focus-visible:inline">
                  {tr('上架', 'Mount')}
                </span>
              </button>
            ) : (
              <div
                key={unit.key}
                aria-hidden="true"
                className="w-full border-b border-slate-400/25"
                style={{ height: UNIT_HEIGHT, backgroundColor: rear ? RACK_COLORS.gapRear : RACK_COLORS.gapFront }}
              />
            ),
          )}
        </div>

        <RackEdge face={face} />
      </div>

      <div className={cn('flex h-3 w-full items-center rounded-b-md bg-slate-400 px-3.5', rear ? 'justify-start' : 'justify-between')}>
        {!rear && (
          <>
            <span className="size-1 rounded-full border border-white bg-slate-200" aria-hidden="true" />
            <span className="size-1 rounded-full border border-white bg-slate-200" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
}

function DeviceBlock({
  unit,
  face,
  canMutate,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  onMigrate,
  onUnmount,
  onAbnormal,
}: {
  unit: RackDeviceUnit;
  face: RackFace;
  canMutate: boolean;
  dragging: boolean;
  onDragStart(): void;
  onDragEnd(): void;
  onMove(): void;
  onMigrate(): void;
  onUnmount(): void;
  onAbnormal(): void;
}) {
  const { tr } = useI18n();
  const height = unit.unitCount * UNIT_HEIGHT;

  if (unit.abnormal) {
    return (
      <div
        className="relative flex w-full flex-col items-center justify-center border-b border-red-500/40 bg-red-900/60"
        style={{ height }}
        title={unit.device.name}
      >
        <button
          type="button"
          onClick={onAbnormal}
          className="flex h-full w-full items-center justify-center gap-1 px-2 text-[10px] font-medium text-white"
        >
          <AlertTriangle size={11} aria-hidden="true" />
          <span className="truncate">{tr('U 位异常', 'U conflict')}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      draggable={canMutate}
      tabIndex={canMutate ? 0 : undefined}
      role={canMutate ? 'group' : 'img'}
      aria-label={tr(`设备 ${unit.device.name}`, `Device ${unit.device.name}`)}
      title={`${unit.device.name} · ${unit.device.typeAlias} · U${unit.uStart}${unit.declaredUnitCount > 1 ? `–U${unit.uStart + unit.declaredUnitCount - 1}` : ''}`}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(unit.device.id));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative flex w-full flex-col items-center justify-center overflow-hidden border-b border-[rgba(116,138,171,0.25)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
        canMutate && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
      )}
      style={{ height, backgroundColor: RACK_COLORS.device }}
    >
      <div
        className="h-1.5 w-full shrink-0"
        aria-hidden="true"
        style={{
          backgroundColor: RACK_COLORS.deviceHeader,
          clipPath: 'polygon(20px 0, calc(100% - 20px) 0, 100% 100%, 0 100%)',
        }}
      />
      <div className="flex min-h-0 w-full flex-1 flex-col">
        {Array.from({ length: unit.unitCount }).map((_, index) => (
          <img
            key={index}
            src={deviceImage(unit.device.typeName, face)}
            alt=""
            draggable={false}
            className="min-h-0 w-full flex-1 object-fill"
          />
        ))}
      </div>

      {canMutate && (
        <span className="absolute inset-0 z-10 hidden items-center justify-center gap-0.5 bg-black/65 group-hover:flex group-focus-within:flex">
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={onMove}
            aria-label={tr(`移动 ${unit.device.name}`, `Move ${unit.device.name}`)}
            title={tr('移动', 'Move')}
            className="inline-flex size-6 items-center justify-center p-0 text-white hover:text-cyan-300"
          >
            <ArrowUpDown size={11} aria-hidden="true" />
          </Button>
          <span className="h-4 w-px bg-white/30" aria-hidden="true" />
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={onMigrate}
            aria-label={tr(`迁移 ${unit.device.name}`, `Migrate ${unit.device.name}`)}
            title={tr('迁移', 'Migrate')}
            className="inline-flex size-6 items-center justify-center p-0 text-white hover:text-cyan-300"
          >
            <MoveRight size={11} aria-hidden="true" />
          </Button>
          <span className="h-4 w-px bg-white/30" aria-hidden="true" />
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={onUnmount}
            aria-label={tr(`下架 ${unit.device.name}`, `Unmount ${unit.device.name}`)}
            title={tr('下架', 'Unmount')}
            className="inline-flex size-6 items-center justify-center p-0 text-white hover:text-red-300"
          >
            <Trash2 size={11} aria-hidden="true" />
          </Button>
        </span>
      )}
    </div>
  );
}

function RackEdge({ face }: { face: RackFace }) {
  return (
    <div className="relative flex shrink-0 bg-slate-400" style={{ width: 14 }} aria-hidden="true">
      <div className="h-full w-[7px] border-e border-white/30" />
      <div className="h-full w-[7px] bg-gradient-to-l from-slate-500/0 to-slate-600/80" />
      <img
        src={face === 'front' ? rackFrontPart : rackRearPart}
        alt=""
        draggable={false}
        className="absolute left-1/2 top-1/2 w-[21px] max-w-none -translate-x-1/2 -translate-y-1/2"
        style={{ height: 'auto' }}
      />
    </div>
  );
}
