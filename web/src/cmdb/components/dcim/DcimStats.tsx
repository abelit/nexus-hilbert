import { Gauge, HardDrive, Server } from 'lucide-react';

import { useI18n } from '@/i18n/locale';

import type { RackCounters } from '../../lib/dcim';

// The room's three totals. The capacity card is a ring, not a fourth number:
// "how full is this room" is a proportion, and a raw pair of numbers makes the
// operator do the division the page already did.
export function DcimStats({ stats }: { stats: RackCounters }) {
  const { tr } = useI18n();
  const used = stats.usedUCount;
  const unused = Math.max(0, stats.uCount - used);
  const ratio = stats.uCount > 0 ? Math.max(0, Math.round((used / stats.uCount) * 100)) : 0;

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-[1400px]:grid-cols-3">
      <StatCard
        icon={<Server size={18} aria-hidden="true" />}
        title={tr('机柜', 'Racks')}
        value={stats.rackCount}
        hint={tr('当前机房的机柜总数', 'Racks in this room')}
      />
      <StatCard
        icon={<HardDrive size={18} aria-hidden="true" />}
        title={tr('设备', 'Devices')}
        value={stats.deviceCount}
        hint={tr('已上架的设备总数', 'Devices mounted in them')}
      />
      <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
          <Gauge size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-text-faint">{tr('容量使用率', 'Capacity used')}</div>
          <div className="mt-1 flex items-center gap-3">
            <svg viewBox="0 0 36 36" className="size-12 shrink-0" role="img" aria-label={tr(`容量使用率 ${ratio}%`, `Capacity used ${ratio}%`)}>
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="4" className="text-border" />
              {ratio > 0 && (
                <circle
                  cx="18"
                  cy="18"
                  r="15.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={`${(Math.min(100, ratio) / 100) * 97.4} 97.4`}
                  transform="rotate(-90 18 18)"
                  className="text-indigo-500"
                />
              )}
            </svg>
            <div className="min-w-0">
              <div className="text-lg font-semibold tabular-nums text-text">{ratio}%</div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] tabular-nums text-text-faint">
                <span>
                  {tr('已用', 'Used')} {used}U
                </span>
                <span>
                  {tr('空闲', 'Free')} {unused}U
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  title,
  value,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  value: number;
  hint: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-text-faint">{title}</div>
        <div className="mt-0.5 text-2xl font-semibold tabular-nums text-text">{value}</div>
        <div className="truncate text-[10px] text-text-faint">{hint}</div>
      </div>
    </div>
  );
}
