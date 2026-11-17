import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsGeneral from './General';

const listMock = vi.fn();
const setMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/api/settings', () => ({
  listSettings: (category?: string) => listMock(category),
  setSetting: (category: string, key: string, value: string, sensitive?: boolean) =>
    setMock(category, key, value, sensitive),
  deleteSetting: (category: string, key: string) => deleteMock(category, key),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  listMock.mockReset().mockResolvedValue({ items: [], total: 0 });
  setMock.mockReset().mockResolvedValue({});
  deleteMock.mockReset().mockResolvedValue(undefined);
});

describe('general settings — Edge install addresses', () => {
  it('saves the internal and external base URLs', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const internal = await screen.findByLabelText('内网地址');
    const external = screen.getByLabelText('外网地址');
    await user.type(internal, 'https://ongrid.intra');
    await user.type(external, 'https://ongrid.example.com');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        'edge',
        'install_internal_url',
        'https://ongrid.intra',
        false,
      ),
    );
    expect(setMock).toHaveBeenCalledWith(
      'edge',
      'install_external_url',
      'https://ongrid.example.com',
      false,
    );
    expect(await screen.findByText('已保存')).toBeInTheDocument();
  });

  it('rejects a value that is not an absolute http(s) URL', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const internal = await screen.findByLabelText('内网地址');
    await user.type(internal, 'ongrid.intra');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/必须是完整的 http\(s\) URL/)).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('general settings — device file write roots', () => {
  const platformRoots = (value: string) => ({
    items: [
      {
        category: 'platform',
        key: 'device_file_write_roots',
        value,
        sensitive: false,
        updated_at: '',
      },
    ],
    total: 1,
  });

  it('loads the saved roots and saves normalized lines', async () => {
    listMock.mockImplementation((category?: string) =>
      Promise.resolve(category === 'platform' ? platformRoots('D:\\data\n/srv/app') : { items: [], total: 0 }),
    );
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const box = await screen.findByLabelText('允许上传的目录');
    expect(box).toHaveValue('D:\\data\n/srv/app');
    await user.clear(box);
    await user.type(box, 'D:\\data{Enter}/srv/app{Enter}/opt/app');
    await user.click(screen.getByRole('button', { name: '保存可写目录' }));

    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        'platform',
        'device_file_write_roots',
        'D:\\data\n/srv/app\n/opt/app',
        false,
      ),
    );
  });

  it('rejects a relative path', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const box = await screen.findByLabelText('允许上传的目录');
    await user.type(box, 'relative/path');
    await user.click(screen.getByRole('button', { name: '保存可写目录' }));

    expect(await screen.findByText(/必须是绝对路径/)).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalledWith(
      'platform',
      'device_file_write_roots',
      expect.anything(),
      false,
    );
  });

  it('rejects a list that would exceed the edge preface budget', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const box = await screen.findByLabelText('允许上传的目录');
    const huge = Array.from(
      { length: 32 },
      (_, i) => `/${String(i).padStart(2, '0')}${'x'.repeat(500)}`,
    ).join('\n');
    fireEvent.change(box, { target: { value: huge } });
    await user.click(screen.getByRole('button', { name: '保存可写目录' }));

    expect(await screen.findByText(/请求限制/)).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalledWith(
      'platform',
      'device_file_write_roots',
      expect.anything(),
      false,
    );
  });

  it('restores the env fallback by deleting the row', async () => {
    listMock.mockImplementation((category?: string) =>
      Promise.resolve(category === 'platform' ? platformRoots('/srv/app') : { items: [], total: 0 }),
    );
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    await user.click(await screen.findByRole('button', { name: '恢复环境变量默认' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('platform', 'device_file_write_roots'));
  });
});

describe('general settings — device file upload limit', () => {
  const platformUpload = (value: string) => ({
    items: [
      {
        category: 'platform',
        key: 'device_file_max_upload_mb',
        value,
        sensitive: false,
        updated_at: '',
      },
    ],
    total: 1,
  });

  it('loads and saves the limit in MiB', async () => {
    listMock.mockImplementation((category?: string) =>
      Promise.resolve(category === 'platform' ? platformUpload('1024') : { items: [], total: 0 }),
    );
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const input = await screen.findByLabelText('单文件上传上限（MiB）');
    expect(input).toHaveValue(1024);
    await user.clear(input);
    await user.type(input, '2048');
    await user.click(screen.getByRole('button', { name: '保存上限' }));

    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith('platform', 'device_file_max_upload_mb', '2048', false),
    );
  });

  it('rejects a value outside 1–8192 MiB', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const input = await screen.findByLabelText('单文件上传上限（MiB）');
    await user.clear(input);
    await user.type(input, '8193');
    await user.click(screen.getByRole('button', { name: '保存上限' }));

    expect(await screen.findByText(/请输入 1–8192/)).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalledWith(
      'platform',
      'device_file_max_upload_mb',
      expect.anything(),
      false,
    );
  });

  it('restores the 8192 MiB default', async () => {
    listMock.mockImplementation((category?: string) =>
      Promise.resolve(category === 'platform' ? platformUpload('1024') : { items: [], total: 0 }),
    );
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    await user.click(await screen.findByRole('button', { name: '恢复默认' }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('platform', 'device_file_max_upload_mb'),
    );
    expect(screen.getByLabelText('单文件上传上限（MiB）')).toHaveValue(8192);
  });
});
