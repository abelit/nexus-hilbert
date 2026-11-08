// Adapted from shadcn/ui Base UI (MIT); see shadcn.LICENSE.
import { forwardRef } from 'react';
import { Dialog as Primitive } from '@base-ui/react/dialog';
import { cn } from '@/lib/cn';
export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export const DialogClose = Primitive.Close;
export const DialogContent = forwardRef<HTMLDivElement, Omit<Primitive.Popup.Props, 'className'> & { className?: string; placement?: 'center' | 'right' | 'assistant'; layer?: 'elevated' }>(function DialogContent({ className, placement = 'center', layer, children, ...props }, ref) {
  const assistant = placement === 'assistant';
  const layerAttr = layer === 'elevated' ? 'elevated' : undefined;
  return <Primitive.Portal>
    <Primitive.Backdrop data-layer={layerAttr} className={cn('og-dialog-overlay', assistant && 'bg-black/25 min-[601px]:hidden')} />
    <Primitive.Popup ref={ref} data-placement={placement} data-layer={layerAttr} className={cn('og-dialog-content', className)} {...props}>
      {assistant ? <div className="og-assistant-content">{children}</div> : children}
    </Primitive.Popup>
  </Primitive.Portal>;
});
