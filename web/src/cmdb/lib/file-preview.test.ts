import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64UTF8, buildKkFilePreviewURL, filePreviewBaseUrl, resolveFileFetchBase } from './file-preview';

describe('the kkFileView URL builder', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the browser origin unless a file API base is configured', () => {
    vi.stubEnv('VITE_FILE_API_BASE_URL', '');
    expect(filePreviewBaseUrl()).toBe(window.location.origin);
    vi.stubEnv('VITE_FILE_API_BASE_URL', 'http://host.docker.internal:5000');
    expect(filePreviewBaseUrl()).toBe('http://host.docker.internal:5000');
  });

  it('prefers the configured file access address over the build-time base', () => {
    vi.stubEnv('VITE_FILE_API_BASE_URL', 'http://build-base:5000');
    expect(resolveFileFetchBase('http://ongrid-cmdb:8082/')).toBe('http://ongrid-cmdb:8082');
    expect(resolveFileFetchBase('  ')).toBe('http://build-base:5000');
    expect(resolveFileFetchBase(null)).toBe('http://build-base:5000');
  });

  it('encodes UTF-8 and appends the original filename', () => {
    expect(base64UTF8('报告')).toBe(window.btoa(String.fromCharCode(0xe6, 0x8a, 0xa5, 0xe5, 0x91, 0x8a)));
    const url = buildKkFilePreviewURL(
      'http://kk:8012/onlinePreview',
      'http://ongrid/api/v1/cmdb/ci/files/public/token',
      '季度报告.pdf',
      ['pdf'],
    );
    expect(url).toContain('http://kk:8012/onlinePreview?url=');
    expect(url).toContain('forceUpdatedCache=true');
    const encoded = new URL(url).searchParams.get('url') ?? '';
    const decoded = window.atob(encoded);
    expect(decoded).toContain('fullfilename=');
  });

  it('returns an empty URL when no preview server is configured', () => {
    expect(buildKkFilePreviewURL('', 'http://x/file', 'a.txt', [])).toBe('');
  });
});
