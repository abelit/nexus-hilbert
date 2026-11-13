import { Label, Radio } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useI18n } from '@/i18n/locale';
import type { InstallAddress, InstallAddressKind } from '@/lib/installAddresses';

// Same bordered Radio row pattern as InstallOsToggle so the install dialogs
// keep one visual language. Renders nothing until an admin configures two
// addresses in Settings → Global → Edge install addresses.
export function InstallAddressToggle({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: InstallAddressKind;
  options: InstallAddress[];
  onChange(kind: InstallAddressKind): void;
}) {
  const { tr } = useI18n();
  if (options.length < 2) return null;
  const labelFor = (kind: InstallAddressKind) => {
    if (kind === 'internal') return tr('内网', 'Internal');
    if (kind === 'external') return tr('外网', 'External');
    return tr('当前地址', 'Current');
  };
  return (
    <div
      role="radiogroup"
      aria-label={tr('安装地址', 'Install address')}
      className="flex flex-wrap items-center gap-2"
    >
      {options.map((option) => (
        <Label
          key={option.kind}
          className={cn(
            'inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs',
            value === option.kind
              ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
              : 'border-zinc-800 bg-zinc-950 text-zinc-400',
          )}
        >
          <Radio
            name={name}
            value={option.kind}
            checked={value === option.kind}
            onChange={() => onChange(option.kind)}
          />
          {labelFor(option.kind)}
        </Label>
      ))}
    </div>
  );
}
