import { getAlertStats, listExternalAlerts, listMyAlerts } from '@/api/federation';
import {
  FederatedListPanel,
  type FederatedField,
} from '@/pages/federation/FederatedListPanel';

const ALERT_BUILTIN = {
  severity: { path: 'alert.labels.severity', zh: '级别', en: 'Severity' },
  status: { path: 'status', zh: '状态', en: 'Status' },
  alertname: { path: 'alertname', zh: '告警', en: 'Alert' },
  summary: { path: 'annotations.summary', zh: '摘要', en: 'Summary' },
  host: { path: 'alert.labels.host', zh: '主机', en: 'Host' },
  created: { path: 'created_at', zh: '触发', en: 'Fired' },
};

const ALERT_FIELDS: FederatedField[] = [
  { key: 'severity', ...ALERT_BUILTIN.severity, render: 'badge' },
  { key: 'status', ...ALERT_BUILTIN.status, render: 'badge' },
  { key: 'alertname', ...ALERT_BUILTIN.alertname, render: 'text' },
  { key: 'summary', ...ALERT_BUILTIN.summary, render: 'text' },
  { key: 'host', ...ALERT_BUILTIN.host, render: 'text' },
  { key: 'created', ...ALERT_BUILTIN.created, render: 'time' },
];

const ALERT_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'firing', label: 'Firing' },
  { value: 'resolved', label: 'Resolved' },
];

const ALERT_SEVERITY_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

export function ExternalAlertsPanel() {
  return (
    <FederatedListPanel
      kind="external_alert"
      titleZh="外部告警"
      titleEn="External alerts"
      subtitleZh="只读 · 数据来自已接入的外部告警源"
      subtitleEn="Read-only · sourced from a configured external alert source"
      nounZh="外部告警"
      nounEn="external alerts"
      defaultFields={ALERT_FIELDS}
      builtinPaths={ALERT_BUILTIN}
      statusOptions={ALERT_STATUS_OPTIONS}
      severityOptions={ALERT_SEVERITY_OPTIONS}
      settingsPath="/settings/federation"
      api={{
        list: listExternalAlerts,
        mine: listMyAlerts,
        stats: getAlertStats,
      }}
    />
  );
}
