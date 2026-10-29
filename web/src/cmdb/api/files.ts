import { getToken } from '@/store/auth';

import { cmdbDelete, cmdbGet, cmdbPost, cmdbPut } from './http';

// --- CMDB file attachments ---

export type CIFile = {
  file_id: string;
  original_name: string;
  stored_path: string;
  size: number;
  mime_type: string;
  storage_backend: 'local' | 's3' | string;
};

export type FileUploadProgress = (percent: number) => void;

export function parseCIFiles(value: unknown): CIFile[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is CIFile => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return typeof row.original_name === 'string' && typeof row.stored_path === 'string';
  });
}

export function serializeCIFiles(files: CIFile[]): string {
  return JSON.stringify(files);
}

/**
 * Uploads files through XMLHttpRequest because the shared fetch client cannot
 * report upload progress. Auth and error shape stay the same as the rest of
 * CMDB; a 401 is surfaced to the caller rather than silently retried.
 */
export function uploadCIFiles(
  files: File[],
  attrId?: number | string,
  onProgress?: FileUploadProgress,
): Promise<CIFile[]> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    const query = attrId != null ? `?attr_id=${encodeURIComponent(String(attrId))}` : '';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/cmdb/ci/files${query}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const body = parsed as { error?: string; message?: string } | null;
        reject(new Error(body?.error || body?.message || `HTTP ${xhr.status}`));
        return;
      }
      const body = parsed as { files?: CIFile[] } | null;
      resolve(body?.files ?? []);
    };
    xhr.send(form);
  });
}

export function deleteCIFiles(fileIDs: string[]): Promise<{ deleted: number }> {
  return cmdbDelete<{ deleted: number }>('/ci/files', {
    files: fileIDs.map((file_id) => ({ file_id })),
  });
}

export function getInstanceFileValues(instanceID: number | string): Promise<Record<string, string>> {
  return cmdbGet<{ values?: Record<string, string> }>(`/instances/${encodeURIComponent(String(instanceID))}/files`).then(
    (got) => got.values ?? {},
  );
}

export type FileLink = { url: string; expires_at: string };

export function getFilePreviewLink(fileID: string, download = false): Promise<FileLink> {
  return cmdbPost<FileLink>('/ci/files/preview-url', { file_id: fileID, download });
}


// --- file storage and preview settings ---

export type FileStorageConfig = {
  storage_backend: 'local' | 's3';
  local_path: string;
  s3_endpoint_url: string;
  s3_access_key: string;
  s3_secret_key: string;
  s3_bucket_name: string;
  s3_region: string;
  s3_use_ssl: boolean;
  allowed_extensions: string[];
  max_file_size_mb: number;
};

export type FilePreviewConfig = {
  preview_server_url: string;
  /** Base kkFileView uses to fetch signed files; empty uses the browser base. */
  file_fetch_base_url: string;
  force_updated_cache_types: string[];
};

export type FileTestResult = { ok: boolean; error: string };

export function fetchFileStorageConfig(): Promise<FileStorageConfig> {
  return cmdbGet<FileStorageConfig>('/file-storage');
}

export function saveFileStorageConfig(patch: Partial<FileStorageConfig>): Promise<FileStorageConfig> {
  return cmdbPut<FileStorageConfig>('/file-storage', patch);
}

export function testFileStorageConfig(patch: Partial<FileStorageConfig>): Promise<FileTestResult> {
  return cmdbPost<FileTestResult>('/file-storage/test', patch);
}

export function fetchFilePreviewConfig(): Promise<FilePreviewConfig> {
  return cmdbGet<FilePreviewConfig>('/file-preview');
}

export function saveFilePreviewConfig(patch: Partial<FilePreviewConfig>): Promise<FilePreviewConfig> {
  return cmdbPut<FilePreviewConfig>('/file-preview', patch);
}

export function testFilePreviewConfig(previewServerURL: string): Promise<FileTestResult> {
  return cmdbPost<FileTestResult>('/file-preview/test', { preview_server_url: previewServerURL });
}
