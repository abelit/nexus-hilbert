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
  scope?: string;
  identity?: 'bound' | 'unbound' | string;
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
  scope?: string;
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

export type RuleValueType = 'identity' | 'fixed';
export type Rule = {
  field: string;
  op: string;
  value_type: RuleValueType;
  identity?: string;
  values?: string[];
};

export type FilterSummary = {
  key: string;
  name: string;
  usage: 'filter' | 'badge' | 'both';
  identity_required: boolean;
};

export type CenterFilter = {
  key: string;
  name: string;
  usage: FilterSummary['usage'];
  enabled: boolean;
  and: Rule[];
  or: Rule[];
  position: number;
};

export type FilterInput = Omit<CenterFilter, 'enabled'> & { enabled?: boolean };

export type DisplayColumn = {
  key: string;
  kind: 'builtin' | 'custom';
  path?: string;
  render?: 'text' | 'time' | 'badge' | 'link';
  label_zh?: string;
  label_en?: string;
  visible: boolean;
  position: number;
};

export type FederationStats = {
  kind: FederationKind;
  configured: boolean;
  reason?: string;
  total: number | null;
  by_status?: Record<string, number | null>;
  by_severity?: Record<string, number | null>;
  window_days: number;
};

export type FieldPath = { path: string; count: number };

export type FilterPreview = {
  and: string[];
  or: string[];
  matched: number;
  reason?: string;
};

export function listFilterSummaries(kind: FederationKind) {
  return request<{ items: FilterSummary[]; total: number }>(
    'GET',
    `/federation/center-filters/summaries?kind=${encodeURIComponent(kind)}`,
  );
}

export function listFilters(kind: FederationKind) {
  return request<{ items: CenterFilter[]; total: number }>(
    'GET',
    `/federation/center-filters?kind=${encodeURIComponent(kind)}`,
  );
}

export function saveFilter(kind: FederationKind, input: FilterInput, key?: string) {
  const body = { ...input, enabled: input.enabled ?? true };
  if (key) {
    return request<CenterFilter>(
      'PUT',
      `/federation/center-filters/${encodeURIComponent(key)}?kind=${encodeURIComponent(kind)}`,
      body,
    );
  }
  return request<CenterFilter>(
    'POST',
    `/federation/center-filters?kind=${encodeURIComponent(kind)}`,
    body,
  );
}

export function deleteFilter(kind: FederationKind, key: string) {
  return request<void>(
    'DELETE',
    `/federation/center-filters/${encodeURIComponent(key)}?kind=${encodeURIComponent(kind)}`,
  );
}

export function previewFilter(kind: FederationKind, input: FilterInput) {
  return request<FilterPreview>(
    'POST',
    `/federation/center-filters/preview?kind=${encodeURIComponent(kind)}`,
    { ...input, enabled: input.enabled ?? true },
  );
}

export function getColumns(kind: FederationKind) {
  return request<{ items: DisplayColumn[]; total: number }>(
    'GET',
    `/federation/columns?kind=${encodeURIComponent(kind)}`,
  );
}

export function saveColumns(kind: FederationKind, columns: DisplayColumn[]) {
  return request<{ items: DisplayColumn[]; total: number }>(
    'PUT',
    `/federation/columns?kind=${encodeURIComponent(kind)}`,
    columns,
  );
}

export function listFieldPaths(kind: FederationKind, connectionId?: number, prefix?: string) {
  const qs = new URLSearchParams();
  qs.set('kind', kind);
  if (connectionId) qs.set('connection_id', String(connectionId));
  if (prefix) qs.set('prefix', prefix);
  return request<{ items: FieldPath[]; total: number }>(
    'POST',
    `/federation/field-paths?${qs.toString()}`,
  );
}

export function listMyAlerts(params: ExternalListParams, scope: string, signal?: AbortSignal) {
  return request<ExternalList>(
    'GET',
    `/federation/alerts/my${query({ ...params, scope })}`,
    undefined,
    signal ? { signal } : undefined,
  );
}

export function getAlertStats(params: ExternalListParams, scope?: string) {
  return request<FederationStats>(
    'GET',
    `/federation/alerts/stats${query({ ...params, scope: scope || undefined })}`,
  );
}

export function listTickets(params: ExternalListParams, signal?: AbortSignal) {
  return request<ExternalList>(
    'GET',
    `/federation/tickets${query(params)}`,
    undefined,
    signal ? { signal } : undefined,
  );
}

export function listMyTickets(params: ExternalListParams, scope: string, signal?: AbortSignal) {
  return request<ExternalList>(
    'GET',
    `/federation/tickets/my${query({ ...params, scope })}`,
    undefined,
    signal ? { signal } : undefined,
  );
}

export function getTicketStats(params: ExternalListParams, scope?: string) {
  return request<FederationStats>(
    'GET',
    `/federation/tickets/stats${query({ ...params, scope: scope || undefined })}`,
  );
}

