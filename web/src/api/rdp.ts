// rdp.ts — Windows RDP session helpers (IronRDP / RDCleanPath).
//
// Backend contract (manager/server/webshell):
//   POST /api/v1/devices/{device_id}/rdp/tickets   → one-time ticket (30s)
//   WS   /api/v1/devices/{device_id}/rdp?ticket=…  → RDCleanPath + raw RDP bytes
//
// The ticket is also sent as the RDCleanPath `proxy_auth` value, so the
// WebSocket URL and the protocol body must always be minted together.
import { request } from './client';

export function createRDPTicket(deviceId: number | string) {
  return request<{ ticket: string; expires_at: string }>(
    'POST',
    `/devices/${encodeURIComponent(String(deviceId))}/rdp/tickets`,
  );
}

export function rdpProxyURL(
  deviceId: number | string,
  ticket: string,
  baseUrl?: string,
): string {
  const id = encodeURIComponent(String(deviceId));
  const qs = new URLSearchParams({ ticket }).toString();

  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, '')}/api/v1/devices/${id}/rdp?${qs}`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/v1/devices/${id}/rdp?${qs}`;
}
