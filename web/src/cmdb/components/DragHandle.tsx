import { GripVertical } from 'lucide-react';

import { cn } from '@/lib/cn';

import type { SortableHandle } from './GroupedSortable';

/** The grip is the only drag activator; the row's own buttons keep their actions. */
export function DragHandle({
  handle,
  label,
  className,
}: {
  handle: SortableHandle;
  label: string;
  className?: string;
}) {
  if (!handle.draggable) return <span className="inline-block size-6 shrink-0" aria-hidden="true" />;
  return (
    <button
      type="button"
      {...handle.attributes}
      {...handle.listeners}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-text-faint hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 active:cursor-grabbing',
        className,
      )}
    >
      <GripVertical size={12} aria-hidden="true" />
    </button>
  );
}
