import { describe, expect, it } from 'vitest';

import {
  addressFromBaseUrl,
  buildInstallAddresses,
  buildInstallCommands,
  currentInstallAddress,
  defaultInstallAddressKind,
  normalizeBaseUrl,
} from './installAddresses';

describe('normalizeBaseUrl', () => {
  it('accepts absolute http(s) URLs and strips a trailing slash', () => {
    expect(normalizeBaseUrl('https://ongrid.example.com')).toBe('https://ongrid.example.com');
    expect(normalizeBaseUrl('  https://ongrid.example.com/  ')).toBe('https://ongrid.example.com');
    expect(normalizeBaseUrl('http://10.0.0.10:8443')).toBe('http://10.0.0.10:8443');
  });

  it('rejects empty, relative, credential, query, fragment, and path values', () => {
    for (const value of [
      '',
      '   ',
      'ongrid.example.com',
      'ftp://ongrid.example.com',
      'https://user:pass@ongrid.example.com',
      'https://ongrid.example.com?x=1',
      'https://ongrid.example.com#x',
      'https://ongrid.example.com/ongrid',
    ]) {
      expect(normalizeBaseUrl(value)).toBeNull();
    }
  });
});

describe('addressFromBaseUrl', () => {
  it('derives host and tunnel address from the base URL', () => {
    expect(addressFromBaseUrl('internal', 'https://ongrid.internal:8443')).toEqual({
      kind: 'internal',
      baseUrl: 'https://ongrid.internal:8443',
      host: 'ongrid.internal:8443',
      edgeAddr: 'ongrid.internal:40012',
    });
  });

  it('brackets IPv6 literals before the tunnel port', () => {
    expect(addressFromBaseUrl('external', 'https://[fd00::1]:443')?.edgeAddr).toBe('[fd00::1]:40012');
  });

  it('returns null for an unusable value', () => {
    expect(addressFromBaseUrl('internal', 'not a url')).toBeNull();
  });
});

describe('buildInstallAddresses', () => {
  const location = { protocol: 'https:', host: 'ongrid.example.com', hostname: 'ongrid.example.com' };

  it('lists internal then external when both are configured', () => {
    const options = buildInstallAddresses('https://ongrid.intra', 'https://ongrid.example.com', location);
    expect(options.map((option) => option.kind)).toEqual(['internal', 'external']);
  });

  it('falls back to the current browser origin when nothing is configured', () => {
    const options = buildInstallAddresses(undefined, '', location);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      kind: 'current',
      baseUrl: 'https://ongrid.example.com',
      host: 'ongrid.example.com',
    });
  });

  it('skips an invalid configured value', () => {
    const options = buildInstallAddresses('nope', 'https://ongrid.example.com', location);
    expect(options.map((option) => option.kind)).toEqual(['external']);
  });
});

describe('defaultInstallAddressKind', () => {
  const location = { protocol: 'https:', host: 'ongrid.intra', hostname: 'ongrid.intra' };

  it('prefers the option matching the current host', () => {
    const options = buildInstallAddresses('https://ongrid.intra', 'https://ongrid.example.com', location);
    expect(defaultInstallAddressKind(options, location)).toBe('internal');
  });

  it('falls back to the first option otherwise', () => {
    const options = buildInstallAddresses('https://other.intra', 'https://ongrid.example.com', location);
    expect(defaultInstallAddressKind(options, location)).toBe('internal');
  });
});

describe('buildInstallCommands', () => {
  const address = addressFromBaseUrl('internal', 'https://ongrid.intra:8443')!;

  it('uses the internal base URL everywhere in the single-device command', () => {
    const commands = buildInstallCommands(address, { accessKey: 'AK', secretKey: 'SK' });
    expect(commands.linux.command).toContain('curl -k -sSL https://ongrid.intra:8443/install.sh');
    expect(commands.linux.command).toContain('--server-http-addr=ongrid.intra:8443');
    expect(commands.linux.command).toContain('--server-edge-addr=ongrid.intra:40012');
    expect(commands.linux.command).not.toContain('--tls-insecure');
    expect(commands.windows.display).toContain("$u='https://ongrid.intra:8443/edge/windows/ongrid-edge-installer.exe'");
    expect(commands.windows.display).toContain('--manager-url https://ongrid.intra:8443');
    expect(commands.windows.display).toContain('--access-key AK');
  });

  it('keeps --tls-insecure for enrollment commands', () => {
    const commands = buildInstallCommands(address, { enrollmentToken: 'TOKEN' });
    expect(commands.linux.command).toContain('--enrollment-token=TOKEN');
    expect(commands.linux.command).toContain('--tls-insecure');
    expect(commands.linux.display).toContain('--server-edge-addr=ongrid.intra:40012');
    expect(commands.windows.display).toContain('--manager-url https://ongrid.intra:8443');
  });
});

describe('currentInstallAddress', () => {
  it('normalizes the browser origin', () => {
    expect(
      currentInstallAddress({ protocol: 'http:', host: 'localhost:8080', hostname: 'localhost' }),
    ).toMatchObject({ kind: 'current', baseUrl: 'http://localhost:8080', host: 'localhost:8080' });
  });
});
