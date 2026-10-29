import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsFileStorage from './FileStorage';

const fetchMock = vi.fn();
const saveMock = vi.fn();
const testMock = vi.fn();

vi.mock('@/cmdb/api/files', () => ({
  fetchFileStorageConfig: () => fetchMock(),
  saveFileStorageConfig: (patch: unknown) => saveMock(patch),
  testFileStorageConfig: (patch: unknown) => testMock(patch),
}));

const localConfig = {
  storage_backend: 'local' as const,
  local_path: '/var/lib/ongrid/cmdb-files',
  s3_endpoint_url: '',
  s3_access_key: '',
  s3_secret_key: '',
  s3_bucket_name: 'cmdb-files',
  s3_region: 'us-east-1',
  s3_use_ssl: true,
  allowed_extensions: ['pdf', 'txt'],
  max_file_size_mb: 50,
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  fetchMock.mockReset().mockResolvedValue(localConfig);
  saveMock.mockReset().mockImplementation((patch) => Promise.resolve({ ...localConfig, ...(patch as object) }));
  testMock.mockReset().mockResolvedValue({ ok: true, error: '' });
});

describe('file storage settings', () => {
  it('loads and saves the local directory', async () => {
    const user = userEvent.setup();
    render(<SettingsFileStorage />);
    const input = await screen.findByLabelText('本地目录');
    await user.clear(input);
    await user.type(input, '/srv/ongrid/files');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ local_path: '/srv/ongrid/files' })),
    );
    expect(await screen.findByText('文件存储设置已保存。')).toBeInTheDocument();
  });

  it('shows S3 fields only after choosing S3', async () => {
    const user = userEvent.setup();
    render(<SettingsFileStorage />);
    await screen.findByLabelText('本地目录');
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /S3 \/ MinIO/ }));
    expect(await screen.findByLabelText('Endpoint')).toBeInTheDocument();
    expect(screen.getByLabelText('Access Key')).toBeInTheDocument();
    expect(screen.getByLabelText('Bucket')).toBeInTheDocument();
  });
});
