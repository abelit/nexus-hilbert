import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VNCWorkspace } from './DeviceVNC';
import { server } from '@/test/msw-server';

const rfbInstances = vi.hoisted(() => [] as Array<{
  channel: unknown;
  options: unknown;
  sendCredentials: ReturnType<typeof vi.fn>;
  sendCtrlAltDel: ReturnType<typeof vi.fn>;
  clipboardPasteFrom: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  dispatchEvent(ev: Event): boolean;
}>);

vi.mock('@novnc/novnc/core/rfb.js', () => {
  class FakeRFB extends EventTarget {
    scaleViewport = false;
    resizeSession = false;
    background = '';
    sendCredentials = vi.fn();
    sendCtrlAltDel = vi.fn();
    clipboardPasteFrom = vi.fn();
    disconnect = vi.fn();
    constructor(_target: HTMLElement, channel: unknown, options: unknown) {
      super();
      rfbInstances.push(this as unknown as (typeof rfbInstances)[number]);
      this.channel = channel;
      this.options = options;
    }
    channel: unknown;
    options: unknown;
  }
  return { default: FakeRFB };
});

const createVNCTicket = vi.hoisted(() => vi.fn());
const openVNCSocket = vi.hoisted(() => vi.fn());
vi.mock('@/api/vnc', () => ({ createVNCTicket, openVNCSocket }));

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

function renderVNC() {
  return render(
    <MemoryRouter initialEntries={['/devices/42/vnc']}>
      <Routes>
        <Route path="/devices/:deviceId/vnc" element={<VNCWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DeviceVNC', () => {
  beforeEach(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    rfbInstances.length = 0;
    createVNCTicket.mockReset().mockResolvedValue({
      ticket: 'vnc-ticket',
      expires_at: '2026-09-04T00:00:30Z',
    });
    openVNCSocket.mockReset().mockReturnValue({
      readyState: 1,
      close: vi.fn(),
      addEventListener: vi.fn(),
    });
    server.use(
      http.get('/api/v1/edges', () => HttpResponse.json({ items: [edge], total: 1 })),
      http.get('/api/v1/edges/70', () => HttpResponse.json(edge)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints a ticket, bridges the socket, and reports the connected state', async () => {
    renderVNC();
    await waitFor(() => expect(createVNCTicket).toHaveBeenCalledWith('42'));
    await waitFor(() => expect(openVNCSocket).toHaveBeenCalledWith('42', 'vnc-ticket'));
    await waitFor(() => expect(rfbInstances).toHaveLength(1));

    expect(screen.getByText('连接中…')).toBeInTheDocument();
    act(() => {
      rfbInstances[0].dispatchEvent(new Event('connect'));
    });
    expect(screen.getByText('已连接')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送 Ctrl+Alt+Del' })).toBeEnabled();
  });

  it('prompts for the VNC password and forwards it only to the RFB session', async () => {
    renderVNC();
    await waitFor(() => expect(rfbInstances).toHaveLength(1));
    act(() => {
      rfbInstances[0].dispatchEvent(new CustomEvent('credentialsrequired'));
    });
    fireEvent.change(await screen.findByLabelText('VNC 密码'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    expect(rfbInstances[0].sendCredentials).toHaveBeenCalledWith({ password: 's3cret' });
  });

  it('shows the disconnected overlay when the RFB session closes', async () => {
    renderVNC();
    await waitFor(() => expect(rfbInstances).toHaveLength(1));
    act(() => {
      rfbInstances[0].dispatchEvent(new Event('connect'));
    });
    act(() => {
      rfbInstances[0].dispatchEvent(
        new CustomEvent('disconnect', { detail: { clean: false } }),
      );
    });
    expect(await screen.findByText('远程桌面未连接')).toBeInTheDocument();
  });

  it('surfaces ticket failures without opening a socket', async () => {
    createVNCTicket.mockRejectedValueOnce(new Error('edge offline'));
    renderVNC();
    expect(await screen.findByText('edge offline')).toBeInTheDocument();
    expect(openVNCSocket).not.toHaveBeenCalled();
  });
});
