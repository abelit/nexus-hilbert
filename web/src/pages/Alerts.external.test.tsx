import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '@/test/msw-server';
import Alerts from './Alerts';

it('renders the external alert tab from ?source=external', async () => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  server.use(
    http.get('/api/v1/federation/alerts', () =>
      HttpResponse.json({
        kind: 'external_alert',
        configured: true,
        total: 1,
        page: 1,
        page_size: 50,
        pages: 1,
        items: [
          {
            _id: 'a1',
            status: 'firing',
            alertname: 'DiskFull',
            alert: { labels: { severity: 'critical', host: 'web-1' } },
            annotations: { summary: 'disk above 90%' },
            created_at: new Date().toISOString(),
          },
        ],
      }),
    ),
  );

  render(
    <MemoryRouter initialEntries={['/alerts?source=external']}>
      <Alerts />
    </MemoryRouter>,
  );

  expect(screen.getByRole('tab', { name: '外部告警' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('DiskFull')).toBeInTheDocument());
  expect(screen.getByText('web-1')).toBeInTheDocument();
  expect(screen.getByText('disk above 90%')).toBeInTheDocument();

  await userEvent.click(screen.getByText('DiskFull'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('外部告警详情')).toBeInTheDocument();
});
