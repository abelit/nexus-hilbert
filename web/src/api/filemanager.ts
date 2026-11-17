// filemanager.ts — managed device file manager (browse any path, write roots).
//
// Backend contract (manager/server/webshell/filemanager.go):
//   GET  /api/v1/devices/{id}/fm/roots
//   GET  /api/v1/devices/{id}/fm/list?path=
//   GET  /api/v1/devices/{id}/fm/download?path=
//   POST /api/v1/devices/{id}/fm/upload?path=&overwrite=1
//   POST /api/v1/devices/{id}/fm/mkdir?path=
//   POST /api/v1/devices/{id}/fm/rename?from=&to=
import { ApiError, request } from './client';
import { getToken } from '@/store/auth';

export type FileManagerRoot = {
  path: string;
  label: string;
  kind: 'volume' | 'root' | string;
  writable: boolean;
};

export type FileManagerEntry = {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mode?: string;
  modified?: string;
  symlink?: boolean;
};

export function listFileRoots(deviceId: number | string) {
  return request<{ items: FileManagerRoot[]; total: number }>(
    'GET',
    `/devices/${encodeURIComponent(String(deviceId))}/fm/roots`,
  );
}

export function listFiles(deviceId: number | string, path: string) {
  return request<{ path: string; items: FileManagerEntry[]; total: number }>(
    'GET',
    `/devices/${encodeURIComponent(String(deviceId))}/fm/list?path=${encodeURIComponent(path)}`,
  );
}

export function makeDirectory(deviceId: number | string, path: string) {
  return request<{ ok: boolean; path: string }>(
    'POST',
    `/devices/${encodeURIComponent(String(deviceId))}/fm/mkdir?path=${encodeURIComponent(path)}`,
  );
}

export function renamePath(deviceId: number | string, from: string, to: string) {
  return request<{ ok: boolean; path: string }>(
    'POST',
    `/devices/${encodeURIComponent(String(deviceId))}/fm/rename?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

export function uploadFile(
  deviceId: number | string,
  path: string,
  file: File,
  overwrite: boolean,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ ok: boolean; path: string; size: number }> {
  return new Promise((resolve, reject) => {
    const url = `/api/v1/devices/${encodeURIComponent(String(deviceId))}/fm/upload?path=${encodeURIComponent(path)}${overwrite ? '&overwrite=1' : ''}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      let payload: { ok?: boolean; path?: string; size?: number; message?: string } | null = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, path: payload?.path ?? path, size: payload?.size ?? file.size });
        return;
      }
      const text = xhr.responseText?.trim() || '';
      reject(new ApiError(payload?.message || text || `upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('network error', 0));
    xhr.send(file);
  });
}

export async function downloadPath(
  deviceId: number | string,
  path: string,
): Promise<{ blob: Blob; filename: string }> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `/api/v1/devices/${encodeURIComponent(String(deviceId))}/fm/download?path=${encodeURIComponent(path)}`,
    { headers },
  );
  if (!res.ok) {
    let message = `download failed (${res.status})`;
    try {
      const text = await res.text();
      if (text) message = text;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ?? path.split(/[\\/]/).filter(Boolean).pop() ?? 'download';
  return { blob: await res.blob(), filename };
}
