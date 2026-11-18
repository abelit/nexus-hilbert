import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '@/test/msw-server';
import { FederatedCITab } from './FederatedCITab';

it('renders the CI alert tab from the federated source', async () => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  server.use(
    http.get('/api/v1/federation/ci/7/alerts', () =>
      HttpResponse.json({
        kind: 'external_alert',
        configured: true,
        has_mapping: true,
        total: 1,
        items: [
          {
            _id: 'a1',
            alertname: 'DiskFull',
            status: 'firing',
            alert: { labels: { severity: 'critical' } },
            annotations: { summary: 'disk above 90%' },
            created_at: new Date().toISOString(),
          },
        ],
      }),
    ),
  );

  render(
    <MemoryRouter>
      <FederatedCITab kind="alerts" ciID={7} />
    </MemoryRouter>,
  );

  await waitFor(() => expect(screen.getByText('DiskFull')).toBeInTheDocument());
  expect(screen.getByText('firing')).toBeInTheDocument();
  expect(screen.getByText('disk above 90%')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /打开外部告警/ })).toHaveAttribute('href', '/alerts?source=external');
});
