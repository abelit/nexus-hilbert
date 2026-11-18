import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '@/test/msw-server';
import Federation from './Federation';

it('lists configured federation connections with health', async () => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  server.use(
    http.get('/api/v1/federation/connections', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind') ?? 'external_alert';
      return HttpResponse.json({
        items: [
          {
            id: 1,
            kind,
            name: 'primary',
            base_url: 'https://morse.example.com',
            api_path: '/api/v1/alerts',
            method: 'GET',
            auth_type: 'bearer',
            token_set: true,
            password_set: false,
            default_days: 7,
            default_page_size: 50,
            timeout_seconds: 15,
            is_default: true,
            enabled: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        total: 1,
      });
    }),
    http.get('/api/v1/federation/connections/health', () =>
      HttpResponse.json({ items: [{ id: 1, name: 'primary', ok: true }], total: 1 }),
    ),
  );

  render(
    <MemoryRouter>
      <Federation />
    </MemoryRouter>,
  );

  expect(screen.getByRole('heading', { name: '外部数据源' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('primary')).toBeInTheDocument());
  expect(screen.getByText('https://morse.example.com/api/v1/alerts')).toBeInTheDocument();
  expect(screen.getByText('正常')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '工单源' })).toBeInTheDocument();
});
