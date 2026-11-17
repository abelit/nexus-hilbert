import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { RDPWorkspace } from './DeviceRDP';
import { server } from '@/test/msw-server';

vi.mock('@devolutions/iron-remote-desktop', () => ({}));

vi.mock('@devolutions/iron-remote-desktop-rdp', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  Backend: {},
  displayControl: vi.fn(() => ({})),
}));

const createRDPTicket = vi.hoisted(() => vi.fn());
const rdpProxyURL = vi.hoisted(() => vi.fn());
vi.mock('@/api/rdp', () => ({ createRDPTicket, rdpProxyURL }));

const listDeviceFiles = vi.hoisted(() => vi.fn());
const uploadDeviceFile = vi.hoisted(() => vi.fn());
const downloadDeviceFile = vi.hoisted(() => vi.fn());
vi.mock('@/api/files', () => ({ listDeviceFiles, uploadDeviceFile, downloadDeviceFile }));

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

// createUI returns the fake UserInteraction installed on the web component.
type FakeBuilder = {
  withUsername: Mock;
  withPassword: Mock;
  withDestination: Mock;
  withProxyAddress: Mock;
  withAuthToken: Mock;
  withServerDomain: Mock;
  withDesktopSize: Mock;
  withExtension: Mock;
  build: Mock;
};

function createUI() {
  const builder = {} as FakeBuilder;
  builder.withUsername = vi.fn(() => builder);
  builder.withPassword = vi.fn(() => builder);
  builder.withDestination = vi.fn(() => builder);
  builder.withProxyAddress = vi.fn(() => builder);
  builder.withAuthToken = vi.fn(() => builder);
  builder.withServerDomain = vi.fn(() => builder);
  builder.withDesktopSize = vi.fn(() => builder);
  builder.withExtension = vi.fn(() => builder);
  builder.build = vi.fn(() => ({}));
  const session = {
    run: vi.fn(() => new Promise(() => undefined)),
  };
  const ui = {
    configBuilder: vi.fn(() => builder),
    connect: vi.fn().mockResolvedValue(session),
    setEnableClipboard: vi.fn(),
    setEnableAutoClipboard: vi.fn(),
    onWarningCallback: vi.fn(),
    onClipboardRemoteUpdateCallback: vi.fn(),
    enableFileTransfer: vi.fn(),
    shutdown: vi.fn(),
    setVisibility: vi.fn(),
    resize: vi.fn(),
    ctrlAltDel: vi.fn(),
    saveRemoteClipboardData: vi.fn().mockResolvedValue(undefined),
    sendClipboardData: vi.fn().mockResolvedValue(undefined),
  };
  return { ui, builder, session };
}

function renderRDP() {
  return render(
    <MemoryRouter initialEntries={['/devices/42/rdp']}>
      <Routes>
        <Route path="/devices/:deviceId/rdp" element={<RDPWorkspace />} />
        <Route path="/devices" element={<div>设备列表页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function installReadyUI() {
  const host = await screen.findByTestId('rdp-canvas');
  await waitFor(() => expect(host.querySelector('iron-remote-desktop')).not.toBeNull());
  const element = host.querySelector('iron-remote-desktop')!;
  const fake = createUI();
  act(() => {
    element.dispatchEvent(
      new CustomEvent('ready', { detail: { irgUserInteraction: fake.ui } }),
    );
  });
  return fake;
}

async function signIn() {
  fireEvent.change(await screen.findByLabelText('用户名'), { target: { value: 'Administrator' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 's3cret' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
  });
}

describe('DeviceRDP', () => {
  beforeEach(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    createRDPTicket.mockReset().mockResolvedValue({
      ticket: 'rdp-ticket',
      expires_at: '2026-09-04T00:00:30Z',
    });
    rdpProxyURL.mockReset().mockReturnValue('ws://proxy/rdp?ticket=rdp-ticket');
    listDeviceFiles.mockReset().mockResolvedValue({ items: [], total: 0 });
    uploadDeviceFile.mockReset().mockImplementation(async (_id, file) => ({ ok: true, name: file.name, size: file.size }));
    downloadDeviceFile.mockReset().mockResolvedValue(new Blob(['downloaded'], { type: 'text/plain' }));
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

  it('mints a ticket and connects with the entered credentials', async () => {
    renderRDP();
    const { ui, builder } = await installReadyUI();
    expect(screen.getByRole('button', { name: '连接' })).toBeEnabled();

    await signIn();

    await waitFor(() => expect(createRDPTicket).toHaveBeenCalledWith('42'));
    expect(rdpProxyURL).toHaveBeenCalledWith('42', 'rdp-ticket');
    expect(ui.connect).toHaveBeenCalledOnce();
    expect(builder.withUsername).toHaveBeenCalledWith('Administrator');
    expect(builder.withPassword).toHaveBeenCalledWith('s3cret');
    expect(builder.withProxyAddress).toHaveBeenCalledWith('ws://proxy/rdp?ticket=rdp-ticket');
    expect(builder.withAuthToken).toHaveBeenCalledWith('rdp-ticket');
    expect(await screen.findByText('已连接')).toBeInTheDocument();
  });

  it('surfaces ticket failures and stays disconnected', async () => {
    createRDPTicket.mockRejectedValueOnce(new Error('edge offline'));
    renderRDP();
    await installReadyUI();
    await signIn();
    expect(await screen.findByText('edge offline')).toBeInTheDocument();
    expect(screen.getByText('已断开')).toBeInTheDocument();
  });

  it('lists device files and downloads them through the file channel', async () => {
    listDeviceFiles.mockResolvedValueOnce({
      items: [{ name: 'report.pdf', size: 2048, modified: '2026-11-16T00:00:00Z' }],
      total: 1,
    });
    renderRDP();
    await installReadyUI();
    await signIn();
    await screen.findByText('已连接');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '文件传输' }));
    });
    expect(await screen.findByText('report.pdf')).toBeInTheDocument();
    expect(listDeviceFiles).toHaveBeenCalledWith('42');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '下载' }));
    });
    await waitFor(() => expect(downloadDeviceFile).toHaveBeenCalledWith('42', 'report.pdf'));
  });

  it('uploads files dropped onto the desktop through the file channel', async () => {
    renderRDP();
    await installReadyUI();
    await signIn();
    await screen.findByText('已连接');

    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const canvas = screen.getByTestId('rdp-canvas').parentElement!;
    await act(async () => {
      fireEvent.drop(canvas, { dataTransfer: { files: [file] } });
    });

    await waitFor(() => expect(uploadDeviceFile).toHaveBeenCalledTimes(1));
    expect(uploadDeviceFile).toHaveBeenCalledWith('42', file, expect.any(Function));
    await waitFor(() => expect(listDeviceFiles).toHaveBeenCalled());
  });
});
