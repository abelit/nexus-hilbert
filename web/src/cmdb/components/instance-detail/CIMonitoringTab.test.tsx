import { render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '@/test/msw-server';
import { CIMonitoringTab } from './CIMonitoringTab';

it('renders the Grafana link and filtered Prometheus alerts', async () => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  server.use(
    http.get('/api/v1/observability/ci/7/grafana', () =>
      HttpResponse.json({
        configured: true,
        uid: 'dash',
        slug: 'detail',
        open_mode: 'link',
        vars: { device_id: 'web-1' },
      }),
    ),
    http.get('/api/v1/observability/ci/7/alerts', () =>
      HttpResponse.json({
        configured: true,
        total: 1,
        labels: { host: 'web-1' },
        alerts: [
          {
            labels: { alertname: 'DiskFull', severity: 'critical', host: 'web-1' },
            state: 'firing',
            active_at: new Date().toISOString(),
          },
        ],
      }),
    ),
  );

  render(<CIMonitoringTab ciID={7} />);

  await waitFor(() => expect(screen.getByText('Grafana 仪表盘')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /打开监控看板/ })).toBeInTheDocument();
  expect(screen.getByText('Prometheus 活动告警')).toBeInTheDocument();
  expect(screen.getByText('DiskFull')).toBeInTheDocument();
  expect(screen.getByText('critical')).toBeInTheDocument();
});
