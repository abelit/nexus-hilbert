import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '@/test/msw-server';
import CIMonitoring from './CIMonitoring';

it('shows the internal and external connection managers', async () => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  server.use(
    http.get('/api/v1/federation/ci-types', () =>
      HttpResponse.json({ items: [{ id: 4, name: 'server', alias: '物理机' }], total: 1 }),
    ),
    http.get('/api/v1/observability/monitoring-connections', ({ request }) => {
      const provider = new URL(request.url).searchParams.get('provider');
      return HttpResponse.json({
        items: [
          {
            id: 0,
            provider,
            kind: 'internal',
            name: provider === 'grafana' ? '平台 Grafana' : '平台 Prometheus',
            auth_type: 'none',
            token_set: false,
            password_set: false,
            tls_insecure: false,
            enabled: true,
          },
          ...(provider === 'grafana'
            ? [
                {
                  id: 5,
                  provider,
                  kind: 'external',
                  name: 'external-grafana',
                  base_url: 'https://grafana.example.com/grafana',
                  auth_type: 'bearer',
                  token_set: true,
                  password_set: false,
                  tls_insecure: false,
                  enabled: true,
                },
              ]
            : []),
        ],
        total: provider === 'grafana' ? 2 : 1,
      });
    }),
    http.get('/api/v1/observability/monitoring-connections/health', () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
    http.get('/api/v1/observability/ci-links', ({ request }) => {
      const provider = new URL(request.url).searchParams.get('provider');
      return HttpResponse.json({
        items:
          provider === 'grafana'
            ? [
                {
                  ci_type_id: 4,
                  provider,
                  enabled: true,
                  connection_id: 5,
                  dashboard_uid: 'dash',
                },
              ]
            : [],
        total: provider === 'grafana' ? 1 : 0,
      });
    }),
  );

  render(
    <MemoryRouter>
      <CIMonitoring />
    </MemoryRouter>,
  );

  await waitFor(() => expect(screen.getAllByText(/连接管理/).length).toBeGreaterThan(0));
  expect(screen.getAllByText('external-grafana').length).toBeGreaterThan(0);
  expect(screen.getAllByText('平台内部').length).toBeGreaterThan(0);
  expect(screen.getAllByText('平台 Grafana').length).toBeGreaterThan(0);
});
