import { describe, expect, it } from 'vitest';

import { hostMetricQueries, hostOSFromEdge, isWindowsHost } from './hostMetrics';

describe('isWindowsHost', () => {
  it('matches Windows OS strings case-insensitively', () => {
    expect(isWindowsHost('windows')).toBe(true);
    expect(isWindowsHost('Windows Server 2016')).toBe(true);
    expect(isWindowsHost('linux')).toBe(false);
    expect(isWindowsHost(undefined)).toBe(false);
  });
});

describe('hostOSFromEdge', () => {
  it('prefers the device row', () => {
    expect(hostOSFromEdge('windows', { os: 'linux' })).toBe('windows');
  });

  it('falls back to host_info', () => {
    expect(hostOSFromEdge(undefined, { os: 'windows' })).toBe('windows');
    expect(hostOSFromEdge(undefined, null)).toBeUndefined();
    expect(hostOSFromEdge(undefined, 'raw-string')).toBeUndefined();
  });
});

describe('hostMetricQueries', () => {
  it('uses windows_exporter names and labels on Windows', () => {
    const queries = hostMetricQueries(true, 23);
    expect(queries.cpu.expr).toContain('windows_cpu_time_total');
    expect(queries.cpu.expr).toContain('by (device_id, core)');
    expect(queries.cpu.nameLabel).toBe('core');
    expect(queries.disk.expr).toContain('windows_logical_disk_size_bytes');
    expect(queries.disk.expr).toContain('windows_logical_disk_free_bytes');
    expect(queries.disk.nameLabel).toBe('volume');
    expect(queries.netRx.expr).toContain('windows_net_bytes_received_total');
    expect(queries.netTx.expr).toContain('windows_net_bytes_sent_total');
    expect(queries.netRx.nameLabel).toBe('nic');
    for (const query of Object.values(queries)) {
      expect(query.expr).toContain('device_id="23"');
      expect(query.expr).not.toContain('node_');
    }
  });

  it('keeps node_exporter names on Linux', () => {
    const queries = hostMetricQueries(false, '586');
    expect(queries.cpu.expr).toContain('node_cpu_seconds_total');
    expect(queries.disk.expr).toContain('node_filesystem_size_bytes');
    expect(queries.netRx.expr).toContain('node_network_receive_bytes_total');
    expect(queries.netTx.expr).toContain('node_network_transmit_bytes_total');
    expect(queries.cpu.nameLabel).toBe('cpu');
    expect(queries.disk.nameLabel).toBe('device');
  });
});
