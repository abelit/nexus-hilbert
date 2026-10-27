import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type ChipTone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
type ChipProps = HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone; dense?: boolean };

// forwardRef is load-bearing: `Hint` uses the child as the Base UI tooltip
// trigger, and a function component without a ref makes the trigger warning
// (and loses the anchor) whenever a chip carries a hint.
export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { tone = 'default', dense, className, ...props },
  ref,
) {
  return <span ref={ref} data-slot="badge" data-tone={tone} {...props} className={cn('og-chip', dense && 'px-1 py-0', className)} />;
});
