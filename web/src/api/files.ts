// files.ts — device file channel (edge sandbox).
//
// Backend contract (manager/server/webshell/files.go):
//   GET  /api/v1/devices/{device_id}/files          → { items, total }
//   POST /api/v1/devices/{device_id}/files?name=…   → upload raw body
//   GET  /api/v1/devices/{device_id}/files/{name}   → download
//
// Files are written to the edge sandbox (C:\ProgramData\ongrid-edge\transfer
// on Windows, /var/lib/ongrid-edge/transfer on Linux), independent of the RDP
// clipboard.
import { ApiError, request } from './client';
import { getToken } from '@/store/auth';

export type DeviceFile = {
  name: string;
  size: number;
  modified: string;
};

export function listDeviceFiles(deviceId: number | string) {
  return request<{ items: DeviceFile[]; total: number }>(
    'GET',
    `/devices/${encodeURIComponent(String(deviceId))}/files`,
  );
}

export function uploadDeviceFile(
  deviceId: number | string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ ok: boolean; name: string; size: number }> {
  return new Promise((resolve, reject) => {
    const url = `/api/v1/devices/${encodeURIComponent(String(deviceId))}/files?name=${encodeURIComponent(file.name)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      let payload: { ok?: boolean; name?: string; size?: number; message?: string } | null = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, name: payload?.name ?? file.name, size: payload?.size ?? file.size });
        return;
      }
      reject(new ApiError(payload?.message || `upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('network error', 0));
    xhr.send(file);
  });
}

export async function downloadDeviceFile(deviceId: number | string, name: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `/api/v1/devices/${encodeURIComponent(String(deviceId))}/files/${encodeURIComponent(name)}`,
    { headers },
  );
  if (!res.ok) throw new ApiError(`download failed (${res.status})`, res.status);
  return res.blob();
}
