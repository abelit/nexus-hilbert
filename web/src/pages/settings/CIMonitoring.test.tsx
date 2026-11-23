import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  await waitFor(() => expect(screen.getAllByText('监控链接').length).toBe(2));
  expect(screen.getByRole('heading', { name: 'Grafana 监控' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Prometheus 监控' })).toBeTruthy();
  expect(screen.getAllByText('external-grafana').length).toBeGreaterThan(0);
  expect(screen.getAllByText('平台内部').length).toBeGreaterThan(0);
  expect(screen.getAllByText('平台 Grafana').length).toBeGreaterThan(0);
  expect(screen.getAllByText('平台 Prometheus').length).toBeGreaterThan(0);
});

it('toggles the internal platform connection', async () => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  const toggles: { enabled: boolean }[] = [];
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
        ],
        total: 1,
      });
    }),
    http.get('/api/v1/observability/monitoring-connections/health', () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
    http.get('/api/v1/observability/ci-links', () => HttpResponse.json({ items: [], total: 0 })),
    http.put('/api/v1/observability/monitoring-connections/platform', async ({ request }) => {
      const body = (await request.json()) as { enabled: boolean };
      toggles.push(body);
      return HttpResponse.json({
        id: 0,
        provider: 'grafana',
        kind: 'internal',
        name: '平台 Grafana',
        auth_type: 'none',
        token_set: false,
        password_set: false,
        tls_insecure: false,
        enabled: body.enabled,
      });
    }),
  );

  render(
    <MemoryRouter>
      <CIMonitoring />
    </MemoryRouter>,
  );

  const user = userEvent.setup();
  const card = (await screen.findByRole('heading', { name: 'Grafana 监控' })).closest('section') as HTMLElement;
  const toggle = within(card).getByRole('switch', { name: '启用 平台 Grafana' });
  await act(async () => {
    await user.click(toggle);
  });

  await waitFor(() => expect(toggles).toEqual([{ enabled: false }]));
});

it('configures the internal platform connection through system settings', async () => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  const writes: { key: string; body: { value: string; sensitive?: boolean } }[] = [];
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
        ],
        total: 1,
      });
    }),
    http.get('/api/v1/observability/monitoring-connections/health', () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
    http.get('/api/v1/observability/ci-links', () => HttpResponse.json({ items: [], total: 0 })),
    http.get('/api/v1/system-settings', ({ request }) => {
      const category = new URL(request.url).searchParams.get('category');
      if (category !== 'grafana') return HttpResponse.json({ items: [], total: 0 });
      return HttpResponse.json({
        items: [
          { category, key: 'root_url', value: 'http://grafana:3000/grafana', sensitive: false, updated_at: '' },
          { category, key: 'sa_token', value: '••••••', sensitive: true, updated_at: '' },
          { category, key: 'org_id', value: '1', sensitive: false, updated_at: '' },
        ],
        total: 3,
      });
    }),
    http.get('/api/v1/system-settings/grafana/sa_token/reveal', () =>
      HttpResponse.json({ value: 'service-account-token' }),
    ),
    http.put('/api/v1/system-settings/:category/:key', async ({ params, request }) => {
      writes.push({ key: String(params.key), body: (await request.json()) as { value: string } });
      return HttpResponse.json({
        category: String(params.category),
        key: String(params.key),
        value: '',
        sensitive: false,
        updated_at: '',
      });
    }),
  );

  render(
    <MemoryRouter>
      <CIMonitoring />
    </MemoryRouter>,
  );

  const user = userEvent.setup();
  const grafanaCard = (await screen.findByRole('heading', { name: 'Grafana 监控' })).closest('section');
  expect(grafanaCard).toBeTruthy();
  const configure = within(grafanaCard as HTMLElement).getByRole('button', { name: '配置' });
  await act(async () => {
    await user.click(configure);
  });
  await screen.findByLabelText('Root URL');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(screen.getByText('配置平台 Grafana')).toBeTruthy();
  expect(screen.getByText(/与 设置 → 集成 共用同一份配置/)).toBeTruthy();

  const rootURL = screen.getByLabelText('Root URL');
  await user.clear(rootURL);
  await user.type(rootURL, 'https://grafana.example.com');
  await act(async () => {
    await user.click(screen.getByRole('button', { name: '保存' }));
  });

  await waitFor(() =>
    expect(writes.some((write) => write.key === 'root_url' && write.body.value === 'https://grafana.example.com')).toBe(true),
  );
  await waitFor(() => expect(screen.queryByText('配置平台 Grafana')).toBeNull());
  expect(writes.some((write) => write.key === 'sa_token')).toBe(false);
});
