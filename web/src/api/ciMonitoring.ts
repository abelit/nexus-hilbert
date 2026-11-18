import { request } from './client';

export type Provider = 'grafana' | 'prometheus';

export type VarMapping = { ci_attribute: string; var_name: string };
export type LabelMapping = { ci_attribute: string; prom_label: string };
export type Matcher = { label: string; op: string; value: string };

export type CILink = {
  ci_type_id: number;
  provider: Provider;
  enabled: boolean;
  dashboard_uid?: string;
  dashboard_slug?: string;
  open_mode?: 'link' | 'embed';
  var_mapping?: VarMapping[];
  label_mapping?: LabelMapping[];
  extra_matchers?: Matcher[];
};

export type CILinkInput = {
  enabled?: boolean;
  dashboard_uid?: string;
  dashboard_slug?: string;
  open_mode?: 'link' | 'embed';
  var_mapping?: VarMapping[];
  label_mapping?: LabelMapping[];
  extra_matchers?: Matcher[];
};

export type Linkage = { grafana: boolean; prometheus: boolean };

export type GrafanaCI = {
  configured: boolean;
  reason?: string;
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
