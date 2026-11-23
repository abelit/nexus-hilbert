import { request } from './client';

export type Provider = 'grafana' | 'prometheus';

export type VarMapping = { ci_attribute: string; var_name: string };
export type LabelMapping = { ci_attribute: string; prom_label: string };
export type Matcher = { label: string; op: string; value: string };

export type CILink = {
  ci_type_id: number;
  provider: Provider;
  enabled: boolean;
  connection_id?: number;
  dashboard_uid?: string;
  dashboard_slug?: string;
  open_mode?: 'link' | 'embed';
  var_mapping?: VarMapping[];
  label_mapping?: LabelMapping[];
  extra_matchers?: Matcher[];
};

export type CILinkInput = {
  enabled?: boolean;
  connection_id?: number;
  dashboard_uid?: string;
  dashboard_slug?: string;
  open_mode?: 'link' | 'embed';
  var_mapping?: VarMapping[];
  label_mapping?: LabelMapping[];
  extra_matchers?: Matcher[];
};

export type MonitoringConnection = {
  id: number;
  provider: Provider;
  kind: 'internal' | 'external';
  name: string;
  base_url?: string;
  auth_type: string;
  token_set: boolean;
  username?: string;
  password_set: boolean;
  tls_insecure: boolean;
  enabled: boolean;
  remark?: string;
};

export type MonitoringConnectionInput = {
  name: string;
  base_url: string;
  auth_type: 'none' | 'bearer' | 'basic';
  auth_data?: { token?: string; username?: string; password?: string };
  tls_insecure?: boolean;
  enabled?: boolean;
  remark?: string;
};

export type ConnectionHealth = {
  id: number;
  name: string;
  kind: 'internal' | 'external';
  ok: boolean;
  error?: string;
};

export function listMonitoringConnections(provider: Provider) {
  return request<{ items: MonitoringConnection[]; total: number }>(
    'GET',
    `/observability/monitoring-connections?provider=${provider}`,
  );
}

export function createMonitoringConnection(provider: Provider, input: MonitoringConnectionInput) {
  return request<MonitoringConnection>(
    'POST',
    `/observability/monitoring-connections?provider=${provider}`,
    input,
  );
}

export function updateMonitoringConnection(
  provider: Provider,
  id: number,
  input: MonitoringConnectionInput,
) {
  return request<MonitoringConnection>(
    'PUT',
    `/observability/monitoring-connections/${id}?provider=${provider}`,
    input,
  );
}

export function deleteMonitoringConnection(id: number) {
  return request<void>('DELETE', `/observability/monitoring-connections/${id}`);
}

// The platform connection is not a row in ci_monitoring_connections; this
// endpoint only toggles whether CI monitoring uses the global integration.
export function setPlatformConnectionEnabled(provider: Provider, enabled: boolean) {
  return request<MonitoringConnection>(
    'PUT',
    `/observability/monitoring-connections/platform?provider=${provider}`,
    { enabled },
  );
}

export function testMonitoringConnection(provider: Provider, input: MonitoringConnectionInput) {
  return request<{ ok: boolean }>(
    'POST',
    `/observability/monitoring-connections/test?provider=${provider}`,
    input,
  );
}

export function testSavedMonitoringConnection(id: number) {
  return request<{ ok: boolean }>('POST', `/observability/monitoring-connections/${id}/test`);
}

export function monitoringConnectionsHealth(provider: Provider) {
  return request<{ items: ConnectionHealth[]; total: number }>(
    'GET',
    `/observability/monitoring-connections/health?provider=${provider}`,
  );
}

export type Linkage = { grafana: boolean; prometheus: boolean };

export type GrafanaCI = {
  configured: boolean;
  reason?: string;
  kind?: 'internal' | 'external';
  root_url?: string;
  uid?: string;
  slug?: string;
  open_mode?: 'link' | 'embed';
  vars?: Record<string, string>;
};

export type PromAlert = {
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  state: string;
  active_at: string;
  value?: string;
};

export type PromCI = {
  configured: boolean;
  reason?: string;
  labels?: Record<string, string>;
  alerts: PromAlert[];
  total: number;
};

export type CIPreview = {
  vars?: Record<string, string>;
  labels?: Record<string, string>;
  matched: number;
  reason?: string;
};

export function listCILinks(provider: Provider) {
  return request<{ items: CILink[]; total: number }>(
    'GET',
    `/observability/ci-links?provider=${provider}`,
  );
}

export function saveCILink(provider: Provider, ciTypeID: number, input: CILinkInput) {
  return request<CILink>(
    'PUT',
    `/observability/ci-links/${provider}/${ciTypeID}`,
    input,
  );
}

export function deleteCILink(provider: Provider, ciTypeID: number) {
  return request<void>('DELETE', `/observability/ci-links/${provider}/${ciTypeID}`);
}

export function previewCILink(provider: Provider, ciID: number, input: CILinkInput) {
  return request<CIPreview>(
    'POST',
    `/observability/ci-links/preview?provider=${provider}`,
    { ...input, ci_id: ciID },
  );
}

export function getCILinkage(typeID: number) {
  return request<Linkage>('GET', `/observability/ci-types/${typeID}/linkage`);
}

export function getCIGrafana(ciID: number) {
  return request<GrafanaCI>('GET', `/observability/ci/${ciID}/grafana`);
}

export function getCIPromAlerts(ciID: number) {
  return request<PromCI>('GET', `/observability/ci/${ciID}/alerts`);
}
