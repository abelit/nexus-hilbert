import { useSearchParams } from 'react-router-dom';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { useI18n } from '@/i18n/locale';

import { ExternalAlertsPanel } from './alerts/ExternalAlertsPanel';
import NativeAlertsPage from './alerts/NativeAlerts';

// The Alerts page is a shell over two independent data models:
//
//   - native: the manager's own alert incidents (ack/resolve/silence, RCA)
//   - external: a read-only federated alert source (nexus-morse)
//
// They have different columns, filters and totals, so they are tabs rather
// than one mixed list. Only the active panel mounts: opening the external tab
// must not keep the native 30s poll running.
export default function AlertsPage() {
  const { tr } = useI18n();
  const [params, setParams] = useSearchParams();
  const source = params.get('source') === 'external' ? 'external' : 'native';

  function setSource(next: string) {
    const updated = new URLSearchParams(params);
    if (next === 'native') updated.delete('source');
    else updated.set('source', next);
    setParams(updated, { replace: true });
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-zinc-800/70 px-4 py-2">
        <Tabs value={source} onValueChange={setSource}>
          <TabsList aria-label={tr('告警数据源', 'Alert source')}>
            <TabsTrigger value="native">{tr('系统告警', 'System alerts')}</TabsTrigger>
            <TabsTrigger value="external">{tr('外部告警', 'External alerts')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {source === 'native' ? <NativeAlertsPage /> : <ExternalAlertsPanel />}
    </div>
  );
}
