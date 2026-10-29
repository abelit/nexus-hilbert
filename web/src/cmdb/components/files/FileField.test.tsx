import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../Toast';
import { FileField } from './FileField';

const uploadMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/components/Modal', () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title?: string; children: ReactNode; footer?: ReactNode }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {footer}
      </section>
    ) : null,
}));

vi.mock('@/components/ui/useDialogs', () => ({
  useDialogs: () => ({ confirmAction: async () => true, dialog: null }),
}));

vi.mock('../../api/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/files')>();
  return {
    ...actual,
    uploadCIFiles: (...args: unknown[]) => uploadMock(...args),
    deleteCIFiles: (...args: unknown[]) => deleteMock(...args),
    getFilePreviewLink: async (id: string, download = false) => ({
      url: `/api/v1/cmdb/ci/files/public/${id}-${download ? 'download' : 'inline'}`,
      expires_at: '2026-10-29T12:15:00Z',
    }),
  };
});

const files = [
  {
    file_id: 'f1',
    original_name: 'a.txt',
    stored_path: '2026/10/29/f1_a.txt',
    size: 5,
    mime_type: 'text/plain',
    storage_backend: 'local',
  },
  {
    file_id: 'f2',
    original_name: 'b.pdf',
    stored_path: '2026/10/29/f2_b.pdf',
    size: 1024,
    mime_type: 'application/pdf',
    storage_backend: 's3',
  },
];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  uploadMock.mockReset();
  deleteMock.mockReset();
});

describe('the CMDB file field', () => {
  it('shows the stored files and deletes one after confirmation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    deleteMock.mockResolvedValue({ deleted: 1 });
    render(
      <ToastProvider>
        <FileField attribute={{ id: 7, name: 'attachment', alias: '附件' }} value={JSON.stringify(files)} onChange={onChange} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: /2 个文件/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('a.txt')).toBeInTheDocument();
    expect(within(dialog).getByText('b.pdf')).toBeInTheDocument();
    expect(within(dialog).getByText('S3')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '删除 a.txt' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(['f1']));
    expect(onChange).toHaveBeenCalledWith([files[1]], JSON.stringify([files[1]]));
  });

  it('uploads one file and appends its metadata to the value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const uploaded = {
      file_id: 'f3',
      original_name: 'new.txt',
      stored_path: '2026/10/29/f3_new.txt',
      size: 3,
      mime_type: 'text/plain',
      storage_backend: 'local',
    };
    uploadMock.mockResolvedValue([uploaded]);
    render(
      <ToastProvider>
        <FileField attribute={{ id: 7, name: 'attachment', alias: '附件' }} value="[]" onChange={onChange} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: /未上传文件/ }));
    const dialog = await screen.findByRole('dialog');
    await user.upload(within(dialog).getByLabelText('上传文件'), new File(['abc'], 'new.txt', { type: 'text/plain' }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith([uploaded], JSON.stringify([uploaded]));
  });
});
