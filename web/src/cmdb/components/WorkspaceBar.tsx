import type { ReactNode } from 'react';
import { Boxes } from 'lucide-react';

import { useI18n } from '@/i18n/locale';

// The CMDB workspace bar.
//
// IT BELONGS TO THE WORKSPACE, NOT TO ONE PAGE. Model configuration and resource
// data both render it above their model rail: the mark, the product name, the
// page's breadcrumb and its counters/actions share one full-width strip, and the
// rail starts underneath it. Without the shared component each page would
// restate the brand block and drift apart.
//
// THE ACTIONS WRAP. `lg:shrink-0` keeps the action group on one line when it
// fits and moves the whole group to the next line when it does not, instead of
// squeezing the breadcrumb into a vertical stack of characters.

export function WorkspaceBar({ leading, actions }: { leading: ReactNode; actions?: ReactNode }) {
  const { tr } = useI18n();
  return (
    <header className="app-header cmdb-workspace-header flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2.5 lg:flex-none">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-600 text-white shadow-sm shadow-indigo-600/20"
          aria-hidden="true"
        >
          <Boxes size={16} />
        </span>
        <span className="hidden shrink-0 text-[15px] font-semibold leading-none text-text sm:inline">
          {tr('CMDB 资源管理平台', 'CMDB Resource Platform')}
        </span>
        <span className="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden="true" />
        <nav
          aria-label={tr('面包屑', 'Breadcrumb')}
          className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-text-muted"
        >
          {leading}
        </nav>
      </div>
      {actions && (
        <div className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto lg:shrink-0 lg:justify-end">
          {actions}
        </div>
      )}
    </header>
  );
}
