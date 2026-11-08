import { Languages, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/locale';

/**
 * The one visual entry for CMDB AI actions. It either opens the floating
 * assistant with a prepared question or a form-assist dialog; the caller owns
 * the click handler.
 */
export function AIActionButton({
  zh,
  en,
  onClick,
  icon = 'sparkles',
  iconOnly = false,
  disabled = false,
}: {
  zh: string;
  en: string;
  onClick(): void;
  icon?: 'sparkles' | 'languages';
  iconOnly?: boolean;
  disabled?: boolean;
}) {
  const { tr } = useI18n();
  const label = tr(zh, en);
  const Icon = icon === 'languages' ? Languages : Sparkles;

  return (
    <Button
      variant="ghost"
      size={iconOnly ? 'icon' : 'sm'}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      className={iconOnly ? 'text-text-faint hover:text-text' : 'inline-flex items-center gap-1.5'}
    >
      <Icon size={iconOnly ? 13 : 12} aria-hidden="true" />
      {!iconOnly && label}
    </Button>
  );
}
