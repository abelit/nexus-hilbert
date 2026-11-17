// Host metric queries for the Edge detail page. Linux/Darwin edges report
// node_exporter series; Windows edges report windows_exporter series with
// different names and labels (core / volume / nic). Keeping the mapping here
// avoids two copies of the same PromQL in the page.

export type HostMetricPanel = 'cpu' | 'disk' | 'netRx' | 'netTx';

export type HostMetricQuery = {
  expr: string;
  /** Label rendered as the series name in MultiLinePanel. */
  nameLabel: string;
};

export type HostMetricQueries = Record<HostMetricPanel, HostMetricQuery>;

export function isWindowsHost(os?: string | null): boolean {
  return /windows/i.test(os ?? '');
}

// hostOSFromEdge prefers the linked device row (populated from host_info at
// registration) and falls back to the edge's own host_info payload.
export function hostOSFromEdge(
  deviceOS: string | undefined,
  hostInfo: Record<string, unknown> | string | null | undefined,
): string | undefined {
  if (deviceOS) return deviceOS;
  if (!hostInfo || typeof hostInfo === 'string') return undefined;
  const os = hostInfo.os;
  return typeof os === 'string' ? os : undefined;
}

export function hostMetricQueries(
  isWindows: boolean,
  deviceID: number | string,
): HostMetricQueries {
  const sel = `device_id="${deviceID}"`;
  if (isWindows) {
    return {
      cpu: {
        // windows_exporter labels cores as "group,index" and exposes a
        // per-mode counter, so the Linux `cpu` label becomes `core`.
        expr: `100 * (1 - avg by (device_id, core) (rate(windows_cpu_time_total{${sel},mode="idle"}[5m])))`,
        nameLabel: 'core',
      },
      disk: {
        // Logical volumes (C:, D:) are the Windows equivalent of physical
        // devices. There is no fstype filter: windows_exporter only reports
        // mounted volumes.
        expr: `100 * max by (device_id, volume) ((windows_logical_disk_size_bytes{${sel}} - windows_logical_disk_free_bytes{${sel}}) / windows_logical_disk_size_bytes{${sel}})`,
        nameLabel: 'volume',
      },
      netRx: {
        expr: `max by (device_id, nic) (rate(windows_net_bytes_received_total{${sel}}[5m]))`,
        nameLabel: 'nic',
      },
      netTx: {
        expr: `max by (device_id, nic) (rate(windows_net_bytes_sent_total{${sel}}[5m]))`,
        nameLabel: 'nic',
      },
    };
  }
  return {
    cpu: {
      // Keep one line per CPU core while collapsing scrape/source labels.
      // During collector upgrades both transports can exist in the query
      // range even though only one is still producing fresh samples.
      expr: `100 * (1 - avg by (device_id, cpu) (rate(node_cpu_seconds_total{${sel},mode="idle"}[5m])))`,
      nameLabel: 'cpu',
    },
    disk: {
      // A physical filesystem can be bind-mounted at many paths (notably
      // on container hosts). Collapse mountpoint and source dimensions so
      // each physical device contributes one worst-case utilization line.
      expr: `100 * max by (device_id, device) ((node_filesystem_size_bytes{${sel},fstype=~"ext4|xfs|btrfs|zfs|ext3|ext2|f2fs",device=~"(/dev/)?(vd|sd|xvd)[a-z]+[0-9]*|(/dev/)?nvme[0-9]+n[0-9]+(p[0-9]+)?"} - node_filesystem_avail_bytes{${sel},fstype=~"ext4|xfs|btrfs|zfs|ext3|ext2|f2fs",device=~"(/dev/)?(vd|sd|xvd)[a-z]+[0-9]*|(/dev/)?nvme[0-9]+n[0-9]+(p[0-9]+)?"}) / node_filesystem_size_bytes{${sel},fstype=~"ext4|xfs|btrfs|zfs|ext3|ext2|f2fs",device=~"(/dev/)?(vd|sd|xvd)[a-z]+[0-9]*|(/dev/)?nvme[0-9]+n[0-9]+(p[0-9]+)?"})`,
      nameLabel: 'device',
    },
    netRx: {
      expr: `max by (device_id, device) (rate(node_network_receive_bytes_total{${sel}}[5m]))`,
      nameLabel: 'device',
    },
    netTx: {
      expr: `max by (device_id, device) (rate(node_network_transmit_bytes_total{${sel}}[5m]))`,
      nameLabel: 'device',
    },
  };
}
