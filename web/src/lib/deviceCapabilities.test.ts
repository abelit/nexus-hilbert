import { describe, expect, it } from 'vitest';

import { supportsRDP, supportsVNC, supportsWebSSH } from './deviceCapabilities';

describe('supportsWebSSH', () => {
  it('disables WebSSH for Windows hosts', () => {
    expect(supportsWebSSH('windows')).toBe(false);
    expect(supportsWebSSH('Windows Server 2016')).toBe(false);
  });

  it('keeps WebSSH for Linux and unknown OS rows', () => {
    expect(supportsWebSSH('linux')).toBe(true);
    expect(supportsWebSSH(undefined)).toBe(true);
    expect(supportsWebSSH('')).toBe(true);
  });
});

describe('supportsVNC', () => {
  it('enables VNC for Windows hosts', () => {
    expect(supportsVNC('windows')).toBe(true);
    expect(supportsVNC('Windows Server 2016')).toBe(true);
  });

  it('keeps VNC hidden for Linux and unknown OS rows', () => {
    expect(supportsVNC('linux')).toBe(false);
    expect(supportsVNC(undefined)).toBe(false);
    expect(supportsVNC('')).toBe(false);
  });
});

describe('supportsRDP', () => {
  it('enables RDP for Windows hosts', () => {
    expect(supportsRDP('windows')).toBe(true);
    expect(supportsRDP('Windows Server 2016')).toBe(true);
  });

  it('keeps RDP hidden for Linux and unknown OS rows', () => {
    expect(supportsRDP('linux')).toBe(false);
    expect(supportsRDP(undefined)).toBe(false);
    expect(supportsRDP('')).toBe(false);
  });
});
