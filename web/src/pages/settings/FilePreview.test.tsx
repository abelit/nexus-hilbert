import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsFilePreview from './FilePreview';

const fetchMock = vi.fn();
const saveMock = vi.fn();
const testMock = vi.fn();

vi.mock('@/cmdb/api/files', () => ({
  fetchFilePreviewConfig: () => fetchMock(),
  saveFilePreviewConfig: (patch: unknown) => saveMock(patch),
  testFilePreviewConfig: (url: string) => testMock(url),
}));

const config = {
  preview_service: 'custom',
  preview_server_url: 'http://kk:8012/onlinePreview',
  file_fetch_base_url: 'http://ongrid-cmdb:8082',
  force_updated_cache_types: ['txt', 'md'],
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  fetchMock.mockReset().mockResolvedValue(config);
  saveMock.mockReset().mockImplementation((patch) => Promise.resolve({ ...config, ...(patch as object) }));
  testMock.mockReset().mockResolvedValue({ ok: true, error: '' });
});

describe('file preview settings', () => {
  it('tests and saves the preview endpoint and file access address', async () => {
    const user = userEvent.setup();
    render(<SettingsFilePreview />);
    const input = await screen.findByLabelText('预览服务地址');
    await user.clear(input);
    await user.type(input, 'http://kk.local/onlinePreview');
    const fetchBase = screen.getByLabelText('文件访问地址');
    await user.clear(fetchBase);
    await user.type(fetchBase, 'http://ongrid-cmdb:8082/');
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(testMock).toHaveBeenCalledWith('http://kk.local/onlinePreview'));
    expect(await screen.findByText('预览服务可访问。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          preview_server_url: 'http://kk.local/onlinePreview',
          file_fetch_base_url: 'http://ongrid-cmdb:8082/',
        }),
      ),
    );
  });

  it('uses the bundled service without an editable address', async () => {
    const user = userEvent.setup();
    render(<SettingsFilePreview />);
    await screen.findByLabelText('预览服务地址');

    await user.click(screen.getByRole('button', { name: /内置服务/ }));

    expect(screen.queryByLabelText('预览服务地址')).not.toBeInTheDocument();
    expect(screen.getByText('/file-preview/onlinePreview')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          preview_service: 'builtin',
          preview_server_url: '/file-preview/onlinePreview',
        }),
      ),
    );
  });

  it('turns preview off and hides the preview-only fields', async () => {
    const user = userEvent.setup();
    render(<SettingsFilePreview />);
    await screen.findByLabelText('预览服务地址');

    await user.click(screen.getByRole('button', { name: /关闭预览/ }));

    expect(screen.queryByLabelText('预览服务地址')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('文件访问地址')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '测试连接' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ preview_service: 'off', preview_server_url: '' }),
      ),
    );
  });
});
