import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileManager } from './DeviceFiles';
import { server } from '@/test/msw-server';

const listFileRoots = vi.hoisted(() => vi.fn());
const listFiles = vi.hoisted(() => vi.fn());
const makeDirectory = vi.hoisted(() => vi.fn());
const renamePath = vi.hoisted(() => vi.fn());
const uploadFile = vi.hoisted(() => vi.fn());
const downloadPath = vi.hoisted(() => vi.fn());
vi.mock('@/api/filemanager', () => ({
  listFileRoots,
  listFiles,
  makeDirectory,
  renamePath,
  uploadFile,
  downloadPath,
}));

const edge = {
  id: 70,
  name: 'win-edge',
  status: 'online',
  roles: [],
  access_key_id: 'test',
  last_seen_at: '2026-09-04T00:00:00Z',
  device_id: 42,
  os: 'windows',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/devices/42/files']}>
      <Routes>
        <Route path="/devices/:deviceId/files" element={<FileManager />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockRoots(writable: boolean) {
  listFileRoots.mockResolvedValue({
    items: [
      {
        path: 'C:\\data',
        label: 'C:\\data',
        kind: writable ? 'volume' : 'root',
        writable,
      },
    ],
    total: 1,
  });
}

describe('DeviceFiles', () => {
  beforeEach(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    listFileRoots.mockReset();
    listFiles.mockReset().mockResolvedValue({
      path: 'C:\\data',
      items: [
        { name: 'docs', path: 'C:\\data\\docs', dir: true, size: 0 },
        { name: 'a.txt', path: 'C:\\data\\a.txt', dir: false, size: 12, modified: '2026-11-16T00:00:00Z' },
      ],
      total: 2,
    });
    makeDirectory.mockReset().mockResolvedValue({ ok: true, path: 'C:\\data\\newdir' });
    renamePath.mockReset().mockResolvedValue({ ok: true, path: 'C:\\data\\b.txt' });
    uploadFile.mockReset().mockResolvedValue({ ok: true, path: 'C:\\data\\a.txt', size: 1 });
    downloadPath.mockReset().mockResolvedValue({ blob: new Blob(['x']), filename: 'a.txt' });
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    server.use(
      http.get('/api/v1/edges', () => HttpResponse.json({ items: [edge], total: 1 })),
      http.get('/api/v1/edges/70', () => HttpResponse.json(edge)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists entries and downloads a file', async () => {
    mockRoots(true);
    renderPage();
    expect(await screen.findByText('docs')).toBeInTheDocument();
    expect(screen.getByText('a.txt')).toBeInTheDocument();

    const row = screen.getByText('a.txt').closest('tr') as HTMLTableRowElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: '下载' }));
    });
    await waitFor(() => expect(downloadPath).toHaveBeenCalledWith('42', 'C:\\data\\a.txt'));
  });

  it('creates a folder at the current path', async () => {
    mockRoots(true);
    renderPage();
    await screen.findByText('a.txt');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /新建文件夹/ }));
    });
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: 'newdir' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
    });
    await waitFor(() => expect(makeDirectory).toHaveBeenCalledWith('42', 'C:\\data\\newdir'));
  });

  it('renames an entry within a writable root', async () => {
    mockRoots(true);
    renderPage();
    await screen.findByText('a.txt');
    const row = screen.getByText('a.txt').closest('tr') as HTMLTableRowElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: '重命名' }));
    });
    const input = await screen.findByLabelText('名称');
    fireEvent.change(input, { target: { value: 'b.txt' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    await waitFor(() => expect(renamePath).toHaveBeenCalledWith('42', 'C:\\data\\a.txt', 'C:\\data\\b.txt'));
  });

  it('uploads picked files to the current directory using their names', async () => {
    mockRoots(true);
    const { container } = renderPage();
    await screen.findByText('a.txt');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'picked.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      fireEvent.change(input);
    });
    await waitFor(() =>
      expect(uploadFile).toHaveBeenCalledWith('42', 'C:\\data\\picked.txt', file, false, expect.any(Function)),
    );
  });

  it('disables write actions outside writable roots', async () => {
    mockRoots(false);
    renderPage();
    await screen.findByText('a.txt');
    expect(screen.getByRole('button', { name: '上传文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新建文件夹' })).toBeDisabled();
    const row = screen.getByText('a.txt').closest('tr') as HTMLTableRowElement;
    expect(within(row).getByRole('button', { name: '重命名' })).toBeDisabled();
    expect(screen.getByText('只读目录')).toBeInTheDocument();
  });
});
