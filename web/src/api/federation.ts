import { request } from './client';

export type FederationKind = 'external_alert' | 'itsm_ticket';

export type SourceProfile = {
  kind: FederationKind;
  default_days: number;
  default_page_size: number;
  max_page_size: number;
  default_table: string;
  status_field: string;
  severity_field: string;
  keyword_field: string;
  stats_mode: string;
};

export type Connection = {
  id: number;
  kind: FederationKind;
  name: string;
  base_url: string;
  api_path: string;
  method: string;
  fixed_params?: Record<string, string[]>;
  auth_type: 'none' | 'bearer' | 'basic';
  token_set: boolean;
  username?: string;
  password_set: boolean;
  default_days: number;
  default_page_size: number;
  timeout_seconds: number;
  is_default: boolean;
  enabled: boolean;
  remark?: string;
  created_at: string;
  updated_at: string;
};

export type ConnectionInput = {
  kind: FederationKind;
  name: string;
  base_url: string;
  api_path: string;
  method: string;
  auth_type: 'none' | 'bearer' | 'basic';
  /** Omit to keep the stored credential; `{}` clears it. */
  auth_data?: { token?: string; username?: string; password?: string };
  default_days?: number;
  default_page_size?: number;
  timeout_seconds?: number;
  is_default?: boolean;
  enabled?: boolean;
  remark?: string;
};

export type HealthRow = { id: number; name: string; ok: boolean; error?: string };

export type ExternalItem = Record<string, unknown>;

export type ExternalList = {
  kind: FederationKind;
  configured: boolean;
  reason?: string;
  table?: string;
  time_range?: string;
  total: number;
  page: number;
  page_size: number;
  pages: number;
  items: ExternalItem[];
};

export function listSourceProfiles() {
  return request<{ items: SourceProfile[]; total: number }>('GET', '/federation/sources');
}

export function listConnections(kind: FederationKind) {
  return request<{ items: Connection[]; total: number }>(
    'GET',
    `/federation/connections?kind=${encodeURIComponent(kind)}`,
  );
}

export function createConnection(input: ConnectionInput) {
  return request<Connection>('POST', '/federation/connections', input);
}

export function updateConnection(id: number, input: ConnectionInput) {
  return request<Connection>('PUT', `/federation/connections/${id}`, input);
}

export function deleteConnection(id: number, cascade = false) {
  return request<void>(
    'DELETE',
    `/federation/connections/${id}${cascade ? '?cascade=true' : ''}`,
  );
}

export function testConnection(input: ConnectionInput) {
  return request<{ ok: boolean }>('POST', '/federation/connections/test', input);
}

export function testSavedConnection(id: number) {
  return request<{ ok: boolean }>('POST', `/federation/connections/${id}/test`);
}

export function connectionHealth(kind: FederationKind) {
  return request<{ items: HealthRow[]; total: number }>(
    'GET',
    `/federation/connections/health?kind=${encodeURIComponent(kind)}`,
  );
}

export function revealConnection(id: number) {
  return request<{ token: string; username: string; password: string }>(
    'GET',
    `/federation/connections/${id}/reveal`,
  );
}

export type ExternalListParams = {
  days?: number;
  start_date?: string;
  end_date?: string;
  status?: string;
  severity?: string;
  keyword?: string;
  page?: number;
  page_size?: number;
  connection_id?: number;
};

function query(params: ExternalListParams): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export function listExternalAlerts(params: ExternalListParams, signal?: AbortSignal) {
  return request<ExternalList>(
    'GET',
    `/federation/alerts${query(params)}`,
    undefined,
    signal ? { signal } : undefined,
  );
}
