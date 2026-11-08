import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { KnowledgeImportDialog } from './KnowledgeImportDialog';
import { ToastProvider } from './Toast';

const item = {
  ciId: 42,
  modelName: 'host',
  modelAlias: '主机',
  title: '[CMDB] 主机 web-01 (#42)',
  path: 'CMDB/主机',
  tags: ['cmdb', 'ci_type:host', 'ci_id:42'],
  markdown: '# [CMDB] 主机 web-01 (#42)\n\n- CI ID: 42',
};

function renderDialog(onImported = vi.fn()) {
  render(
    <ToastProvider>
      <KnowledgeImportDialog open items={[item]} onClose={() => {}} onImported={onImported} />
    </ToastProvider>,
  );
  return { onImported };
}

describe('KnowledgeImportDialog', () => {
  it('requires the global-read acknowledgement before importing', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByText(/知识库当前对所有已登录用户可读/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '导入 1 篇' });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText('我了解知识库全局可读'));
    expect(button).toBeEnabled();
  });

  it('creates a document when none carries the ci_id tag', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/v1/knowledge/docs', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/v1/knowledge/docs', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: '1', ...posted });
      }),
    );
    const { onImported } = renderDialog();

    await user.click(screen.getByLabelText('我了解知识库全局可读'));
    await user.click(screen.getByRole('button', { name: '导入 1 篇' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({
      title: '[CMDB] 主机 web-01 (#42)',
      path: 'CMDB/主机',
      tags: ['cmdb', 'ci_type:host', 'ci_id:42'],
    });
    expect(onImported).toHaveBeenCalledWith(1);
  });

  it('updates the existing document instead of duplicating it', async () => {
    const user = userEvent.setup();
    let patched = false;
    let created = false;
    server.use(
      http.get('/api/v1/knowledge/docs', () =>
        HttpResponse.json({
          items: [{ id: 'doc-1', source_type: 'manual', title: 'old', tags: ['ci_id:42'], created_at: '', updated_at: '' }],
          total: 1,
        }),
      ),
      http.patch('/api/v1/knowledge/docs/doc-1', () => {
        patched = true;
        return HttpResponse.json({ id: 'doc-1' });
      }),
      http.post('/api/v1/knowledge/docs', () => {
        created = true;
        return HttpResponse.json({ id: 'new' });
      }),
    );
    renderDialog();

    await user.click(screen.getByLabelText('我了解知识库全局可读'));
    await user.click(screen.getByRole('button', { name: '导入 1 篇' }));

    await waitFor(() => expect(patched).toBe(true));
    expect(created).toBe(false);
  });

  it('surfaces a missing knowledge write permission', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/knowledge/docs', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/v1/knowledge/docs', () => new HttpResponse(null, { status: 403 })),
    );
    renderDialog();

    await user.click(screen.getByLabelText('我了解知识库全局可读'));
    await user.click(screen.getByRole('button', { name: '导入 1 篇' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/knowledge:doc/));
  });
});
