import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '@/test/msw-server';
import Tickets from './Tickets';

it('renders the ITSM event center with ticket columns and stats', async () => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  server.use(
    http.get('/api/v1/federation/center-filters/summaries', () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
    http.get('/api/v1/federation/columns', () =>
      HttpResponse.json({
        items: [
          { key: 'status', kind: 'builtin', path: 'form_data.instanceStatus', render: 'badge', visible: true, position: 0 },
          { key: 'title', kind: 'builtin', path: 'form_data.title', render: 'text', visible: true, position: 1 },
          { key: 'priority', kind: 'custom', path: 'form_data.priority', render: 'badge', label_zh: '优先级', label_en: 'Priority', visible: true, position: 2 },
          { key: 'assignee', kind: 'custom', path: 'form_data.assignee', render: 'text', label_zh: '处理人', label_en: 'Assignee', visible: true, position: 3 },
          { key: 'created', kind: 'custom', path: 'created_at', render: 'time', label_zh: '创建时间', label_en: 'Created', visible: true, position: 4 },
        ],
        total: 5,
      }),
    ),
    http.get('/api/v1/federation/tickets/stats', () =>
      HttpResponse.json({
        kind: 'itsm_ticket',
        configured: true,
        total: 1,
        by_status: { RUNNING: 1, ERROR: null, COMPLETED: 0, TERMINATED: 0 },
        window_days: 30,
      }),
    ),
    http.get('/api/v1/federation/tickets', () =>
      HttpResponse.json({
        kind: 'itsm_ticket',
        configured: true,
        total: 1,
        page: 1,
        page_size: 20,
        pages: 1,
        items: [
          {
            _id: 't1',
            form_data: { instanceStatus: 'RUNNING', title: 'Printer down', priority: 'high', assignee: 'bob' },
            created_at: new Date().toISOString(),
          },
        ],
      }),
    ),
  );

  render(
    <MemoryRouter>
      <Tickets />
    </MemoryRouter>,
  );

  expect(screen.getByRole('heading', { name: '事件中心' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('Printer down')).toBeInTheDocument());
  expect(screen.getAllByText('RUNNING').length).toBeGreaterThan(0);
  expect(screen.getByText('bob')).toBeInTheDocument();
  expect(screen.getByText('总数')).toBeInTheDocument();
});
