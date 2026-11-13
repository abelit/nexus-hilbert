import { useEffect, useMemo, useState } from 'react';

import { listSettings } from '@/api/settings';

// Edge install entry points are admin-editable system settings
// (system_settings.category = "edge"). The Edges page and the cluster
// enrollment dialog turn them into the copy-paste install commands. When
// neither row is set the UI keeps its historical behaviour and uses the
// host the browser is currently visiting.
export const EDGE_SETTINGS_CATEGORY = 'edge';
export const EDGE_INSTALL_INTERNAL_KEY = 'install_internal_url';
export const EDGE_INSTALL_EXTERNAL_KEY = 'install_external_url';

export type InstallAddressKind = 'internal' | 'external' | 'current';
export type InstallOS = 'linux' | 'windows';

export type InstallAddress = {
  kind: InstallAddressKind;
  /** Normalized base URL, e.g. https://ongrid.example.com:8443 */
  baseUrl: string;
  /** host[:port] used for --server-http-addr / --manager-url */
  host: string;
  /** Frontier tunnel endpoint derived from the hostname: host:40012 */
  edgeAddr: string;
};

type LocationLike = { protocol: string; host: string; hostname: string };

// normalizeBaseUrl accepts an absolute http(s) URL without credentials,
// query, fragment, or path. The manager validates the same shape when the
// setting is saved, so the UI can reject typos before submitting.
export function normalizeBaseUrl(raw?: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function edgeAddrFor(hostname: string): string {
  // WHATWG URL keeps the brackets on IPv6 hostnames; strip them before
  // re-adding so the tunnel address never becomes [[fd00::1]]:40012.
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return `${bare.includes(':') ? `[${bare}]` : bare}:40012`;
}

export function addressFromBaseUrl(
  kind: InstallAddressKind,
  raw?: string | null,
): InstallAddress | null {
  const baseUrl = normalizeBaseUrl(raw);
  if (!baseUrl) return null;
  const parsed = new URL(baseUrl);
  return {
    kind,
    baseUrl,
    host: parsed.host,
    edgeAddr: edgeAddrFor(parsed.hostname),
  };
}

export function currentInstallAddress(location?: LocationLike): InstallAddress | null {
  const loc = location ?? (typeof window !== 'undefined' ? window.location : undefined);
  if (!loc) return null;
  return addressFromBaseUrl('current', `${loc.protocol}//${loc.host}`);
}

// buildInstallAddresses returns the configured options in a stable order
// (internal then external). With no configured rows it falls back to the
// current browser origin so the UI never renders an empty command.
export function buildInstallAddresses(
  internal?: string,
  external?: string,
  location?: LocationLike,
): InstallAddress[] {
  const options = [
    addressFromBaseUrl('internal', internal),
    addressFromBaseUrl('external', external),
  ].filter((value): value is InstallAddress => value !== null);
  if (options.length === 0) {
    const current = currentInstallAddress(location);
    if (current) options.push(current);
  }
  return options;
}

// defaultInstallAddressKind prefers the option matching the host the admin
// is currently using, so opening the UI through the internal mirror selects
// "内网" automatically. Falls back to the first configured option.
export function defaultInstallAddressKind(
  options: InstallAddress[],
  location?: LocationLike,
): InstallAddressKind | null {
  if (options.length === 0) return null;
  const loc = location ?? (typeof window !== 'undefined' ? window.location : undefined);
  const match = options.find((option) => option.host === loc?.host);
  return (match ?? options[0]).kind;
}

export type InstallCredential =
  | { accessKey: string; secretKey: string }
  | { enrollmentToken: string };

export type InstallCommandSet = {
  linux: { command: string; display: string };
  windows: { command: string; display: string };
};

function isEnrollment(credential: InstallCredential): credential is { enrollmentToken: string } {
  return 'enrollmentToken' in credential;
}

// buildInstallCommands renders both the one-line copy and the wrapped
// display form for Linux and Windows. The Windows script stays PowerShell
// 2.0 compatible: one statement per line, no fancy syntax.
export function buildInstallCommands(
  address: InstallAddress,
  credential: InstallCredential,
): InstallCommandSet {
  const { baseUrl, host, edgeAddr } = address;
  const enrollment = isEnrollment(credential);
  const linuxTail = enrollment
    ? `--enrollment-token=${credential.enrollmentToken} --server-edge-addr=${edgeAddr} --server-http-addr=${host} --tls-insecure`
    : `--access-key=${credential.accessKey} --secret-key=${credential.secretKey} --server-edge-addr=${edgeAddr} --server-http-addr=${host}`;
  const linuxCommand = `curl -k -sSL ${baseUrl}/install.sh | bash -s -- ${linuxTail}`;
  const linuxDisplay = enrollment
    ? `curl -k -sSL ${baseUrl}/install.sh | bash -s -- \\\n` +
      `  --enrollment-token=${credential.enrollmentToken} \\\n` +
      `  --server-edge-addr=${edgeAddr} \\\n` +
      `  --server-http-addr=${host} \\\n` +
      `  --tls-insecure`
    : `curl -k -sSL ${baseUrl}/install.sh | bash -s -- \\\n` +
      `  --access-key=${credential.accessKey} \\\n` +
      `  --secret-key=${credential.secretKey} \\\n` +
      `  --server-edge-addr=${edgeAddr} \\\n` +
      `  --server-http-addr=${host}`;
  const windowsArgs = enrollment
    ? `--enrollment-token ${credential.enrollmentToken} --server-edge-addr ${edgeAddr} --tls-insecure`
    : `--access-key ${credential.accessKey} --secret-key ${credential.secretKey} --server-edge-addr ${edgeAddr}`;
  const windowsDisplay =
    `$u='${baseUrl}/edge/windows/ongrid-edge-installer.exe'\n` +
    `$f="$env:TEMP\\ongrid-edge-installer.exe"\n` +
    `(New-Object Net.WebClient).DownloadFile($u,$f)\n` +
    `& $f --manager-url ${baseUrl} ${windowsArgs}`;
  return {
    linux: { command: linuxCommand, display: linuxDisplay },
    windows: { command: windowsDisplay, display: windowsDisplay },
  };
}

export function installCommandsForOS(
  set: InstallCommandSet,
  os: InstallOS,
): { command: string; display: string } {
  return os === 'windows' ? set.windows : set.linux;
}

// useInstallAddresses loads the Edge install settings once per mount. A
// failed request (or a deployment that never configured the rows) silently
// falls back to the current origin, matching the pre-setting behaviour.
export function useInstallAddresses(): {
  options: InstallAddress[];
  loading: boolean;
} {
  const [values, setValues] = useState<{ internal?: string; external?: string }>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listSettings(EDGE_SETTINGS_CATEGORY)
      .then((response) => {
        if (cancelled) return;
        const valueOf = (key: string) => response.items.find((item) => item.key === key)?.value;
        setValues({
          internal: valueOf(EDGE_INSTALL_INTERNAL_KEY),
          external: valueOf(EDGE_INSTALL_EXTERNAL_KEY),
        });
      })
      .catch(() => {
        if (!cancelled) setValues({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(
    () => buildInstallAddresses(values.internal, values.external),
    [values.internal, values.external],
  );

  return { options, loading };
}
