import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, MonitorPlay, RefreshCw } from 'lucide-react';

import { Button, Chip, EmptyState } from '@/components/ui';
import { useI18n } from '@/i18n/locale';
import { ApiError } from '@/api/client';
import { fetchGrafanaRootURL, openObservabilityUrl } from '@/lib/drilldown';
import {
  getCIGrafana,
  getCIPromAlerts,
  type GrafanaCI,
  type PromCI,
} from '@/api/ciMonitoring';

export function CIMonitoringTab({ ciID }: { ciID: number }) {
  const { tr } = useI18n();
  const [grafana, setGrafana] = useState<GrafanaCI | null>(null);
  const [prom, setProm] = useState<PromCI | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    // One provider failing must not hide the other: Prometheus can be down
    // while the Grafana deep link is still useful.
    const [gResult, pResult] = await Promise.allSettled([
      getCIGrafana(ciID),
      getCIPromAlerts(ciID),
    ]);
    const g = gResult.status === 'fulfilled' ? gResult.value : null;
    const p = pResult.status === 'fulfilled' ? pResult.value : null;
    setGrafana(g);
    setProm(p);
    if (!g && !p) {
      const reason = gResult.status === 'rejected' ? gResult.reason : pResult.status === 'rejected' ? pResult.reason : null;
      setErr(reason instanceof ApiError ? reason.message : (reason as Error)?.message || 'Could not load monitoring');
    } else {
      setErr(null);
    }
    setLoading(false);
  }, [ciID]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDashboard() {
    if (!grafana?.configured || !grafana.uid) return;
    setOpening(true);
    try {
      const base = await fetchGrafanaRootURL();
      const params = new URLSearchParams();
      params.set('from', 'now-6h');
      params.set('to', 'now');
      for (const [key, value] of Object.entries(grafana.vars ?? {})) {
        if (value) params.set(`var-${key}`, value);
      }
      const slug = grafana.slug?.trim() || 'detail';
      await openObservabilityUrl(`${base}/d/${grafana.uid}/${slug}?${params.toString()}`);
    } finally {
      setOpening(false);
    }
  }

  if (loading) {
    return <p className="py-6 text-center text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>;
  }
  if (err) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
        <div>{tr('加载监控信息失败：', 'Could not load monitoring: ')}{err}</div>
        <Button variant="subtle" size="sm" type="button" className="mt-2" onClick={() => void load()}>
          {tr('重试', 'Retry')}
        </Button>
      </div>
    );
  }

  const hasGrafana = Boolean(grafana?.configured);
  const hasProm = Boolean(prom?.configured);
  if (!hasGrafana && !hasProm) {
    return (
      <EmptyState
        icon={MonitorPlay}
        title={tr('该模型未配置监控链接', 'No monitoring link for this model')}
        hint={tr('管理员可在设置 → CI 监控中绑定全局 Grafana 仪表盘或 Prometheus 标签。', 'An admin can bind the global Grafana dashboard or Prometheus labels in Settings → CI monitoring.')}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-text-faint">
        <span>{tr('只读 · 复用全局 Grafana / Prometheus 集成', 'Read-only · reuses the global Grafana / Prometheus integrations')}</span>
        <Button variant="subtle" size="sm" type="button" onClick={() => void load()}>
          <RefreshCw size={12} /> {tr('刷新', 'Refresh')}
        </Button>
      </div>

      {hasGrafana && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-text">{tr('Grafana 仪表盘', 'Grafana dashboard')}</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
              {grafana?.uid}
              {grafana?.slug ? ` / ${grafana.slug}` : ''}
            </div>
          </div>
          <Button variant="primary" size="sm" type="button" onClick={() => void openDashboard()} disabled={opening}>
            <ExternalLink size={12} /> {opening ? tr('打开中…', 'Opening…') : tr('打开监控看板', 'Open dashboard')}
          </Button>
        </div>
      )}

      {hasProm && (
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between px-3 py-2 text-xs">
            <span className="font-medium text-text">{tr('Prometheus 活动告警', 'Prometheus active alerts')}</span>
            <span className="text-text-faint">{tr(`共 ${prom?.total ?? 0} 条`, `${prom?.total ?? 0} alert(s)`)}</span>
          </div>
          {prom?.alerts.length === 0 ? (
            <p className="px-3 pb-3 text-[11px] text-text-faint">
              {prom?.reason === 'no_ci_value'
                ? tr('该 CI 没有可匹配的标签值。', 'This CI has no value for the mapped labels.')
                : tr('当前没有匹配的活动告警。', 'No active alerts match right now.')}
            </p>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {prom?.alerts.map((alert, index) => {
                const name = alert.labels.alertname || tr('未命名告警', 'Unnamed alert');
                const severity = alert.labels.severity || '';
                return (
                  <li key={`${name}-${index}`} className="flex items-start justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-text">{name}</div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
                        {Object.entries(alert.labels)
                          .filter(([key]) => key !== '__name__' && key !== 'alertname')
                          .map(([key, value]) => `${key}=${value}`)
                          .join(' ')}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {severity && <Chip tone={severity === 'critical' ? 'danger' : severity === 'warning' ? 'warning' : 'info'}>{severity}</Chip>}
                      <Chip tone={alert.state === 'firing' ? 'danger' : 'success'}>{alert.state}</Chip>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {!hasGrafana && prom?.reason === 'prometheus_unavailable' && (
        <p className="text-[11px] text-text-faint">
          {tr('Prometheus 集成未启用；请检查 Settings → 集成。', 'The Prometheus integration is not enabled; check Settings → Integrations.')}
        </p>
      )}
    </div>
  );
}
