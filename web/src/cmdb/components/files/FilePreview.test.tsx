import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreview } from './FilePreview';

const state = vi.hoisted(() => ({ previewService: 'builtin' as 'builtin' | 'off' }));

vi.mock('../../api/files', () => ({
  fetchFilePreviewConfig: async () => ({
    preview_service: state.previewService,
    preview_server_url: state.previewService === 'off' ? '' : '/file-preview/onlinePreview',
    file_fetch_base_url: 'http://ongrid-cmdb:8082',
    force_updated_cache_types: ['txt'],
  }),
  getFilePreviewLink: async (_id: string, download = false) => ({
    url: `/api/v1/cmdb/ci/files/public/${download ? 'download-token' : 'inline-token'}`,
    expires_at: '2026-10-30T12:15:00Z',
  }),
}));

const file = {
  file_id: 'f1',
  original_name: 'a.txt',
  stored_path: '2026/10/30/f1_a.txt',
  size: 5,
  mime_type: 'text/plain',
  storage_backend: 's3',
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  state.previewService = 'builtin';
});

describe('file preview iframe', () => {
  it('uses the configured file access address for kkFileView but a browser path for the new tab', async () => {
    render(<FilePreview file={file} />);

    const iframe = await screen.findByTitle('a.txt');
    const src = iframe.getAttribute('src') ?? '';
    const encoded = new URL(src, window.location.origin).searchParams.get('url') ?? '';
    expect(window.atob(encoded)).toContain(
      'http://ongrid-cmdb:8082/api/v1/cmdb/ci/files/public/inline-token',
    );
    expect(iframe.getAttribute('src')).toContain('/file-preview/onlinePreview');

    await waitFor(() => expect(screen.getByRole('link', { name: '新窗口打开' })).toHaveAttribute('href', '/api/v1/cmdb/ci/files/public/inline-token'));
  });

  it('explains the download fallback when preview is turned off', async () => {
    state.previewService = 'off';
    render(<FilePreview file={file} />);

    expect(await screen.findByText('在线预览已关闭，可下载原文件查看。')).toBeInTheDocument();
    expect(screen.queryByTitle('a.txt')).not.toBeInTheDocument();
  });
});
