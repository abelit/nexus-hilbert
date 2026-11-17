// vnc.ts — Windows VNC session helpers.
//
// Backend contract (manager/server/webshell):
//   POST /api/v1/devices/{device_id}/vnc/tickets   → one-time ticket (30s)
//   WS   /api/v1/devices/{device_id}/vnc?ticket=…  → raw RFB byte stream
//
// The Manager bridges the WebSocket to an edge tunnel stream and writes the
// `ONGRID-TARGET 127.0.0.1:5900` preface; the edge consumes it and forwards
// the loopback VNC traffic. No VNC password ever reaches OnGrid — the RFB
// server authenticates the browser directly.
import { request } from './client';

export function createVNCTicket(deviceId: number | string) {
  return request<{ ticket: string; expires_at: string }>(
    'POST',
    `/devices/${encodeURIComponent(String(deviceId))}/vnc/tickets`,
  );
}

export function openVNCSocket(
  deviceId: number | string,
  ticket: string,
  baseUrl?: string,
): WebSocket {
  const id = encodeURIComponent(String(deviceId));
  const qs = new URLSearchParams({ ticket }).toString();

  let url: string;
  if (baseUrl) {
    url = `${baseUrl.replace(/\/$/, '')}/api/v1/devices/${id}/vnc?${qs}`;
  } else {
    // Derive ws/wss from the current page so dev (vite proxy) and prod
    // (nginx) both work without extra config.
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    url = `${proto}//${window.location.host}/api/v1/devices/${id}/vnc?${qs}`;
  }

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return ws;
}
