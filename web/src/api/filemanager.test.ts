import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadFile } from './filemanager';

class FakeXHR {
  static last: FakeXHR | null = null;
  status = 0;
  responseText = '';
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();

  constructor() {
    FakeXHR.last = this;
  }
}

describe('uploadFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeXHR.last = null;
  });

  it('surfaces a plain-text upload error instead of a generic status message', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const pending = uploadFile(1, '/tmp/a.bin', new File(['x'], 'a.bin'), false);
    const xhr = FakeXHR.last;
    if (!xhr) throw new Error('XMLHttpRequest was not constructed');
    xhr.status = 400;
    xhr.responseText = 'invalid argument: file exceeds the configured 1 MiB upload limit\n';
    xhr.onload?.();

    await expect(pending).rejects.toThrow(/configured 1 MiB upload limit/);
  });
});
