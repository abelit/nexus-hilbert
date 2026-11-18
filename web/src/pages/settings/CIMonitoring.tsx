import { useCallback, useEffect, useState } from 'react';
import { MonitorPlay, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import {
  Button,
  Card,
  Chip,
  EmptyStateCard,
  Input,
  Label,
  Select,
  Switch,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { ApiError } from '@/api/client';
import { useI18n } from '@/i18n/locale';
import { listCITypes, type CIType } from '@/api/federation';
import {
  deleteCILink,
  listCILinks,
  previewCILink,
  saveCILink,
  type CILink,
  type CILinkInput,
  type CIPreview,
  type LabelMapping,
  type Matcher,
  type Provider,
  type VarMapping,
} from '@/api/ciMonitoring';

const PROVIDERS: { value: Provider; zh: string; en: string }[] = [
  { value: 'grafana', zh: 'Grafana', en: 'Grafana' },
  { value: 'prometheus', zh: 'Prometheus', en: 'Prometheus' },
];

const OPEN_MODES = [
  { value: 'link', label: 'link' },
  { value: 'embed', label: 'embed' },
];

const MATCHER_OPS = ['eq', 'ne', 'regex'].map((op) => ({ value: op, label: op }));

export default function CIMonitoringSettings() {
  const { tr } = useI18n();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-base font-semibold text-text">{tr('CI 监控', 'CI monitoring')}</h1>
        <p className="mt-1 text-xs text-text-muted">
          {tr(
            '把 CI 类型绑定到全局 Grafana 仪表盘或 Prometheus 标签；不在此保存任何凭据。',
            'Bind CI types to the global Grafana dashboard or Prometheus labels; no credentials are stored here.',
          )}
        </p>
      </div>
      {PROVIDERS.map((provider) => (
        <LinksCard key={provider.value} provider={provider.value} label={tr(provider.zh, provider.en)} />
      ))}
    </div>
  );
}

function LinksCard({ provider, label }: { provider: Provider; label: string }) {
  const { tr } = useI18n();
  const { confirmAction, alertAction, dialog } = useDialogs();
  const [rows, setRows] = useState<CILink[]>([]);
  const [ciTypes, setCITypes] = useState<CIType[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<CILink | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [links, types] = await Promise.all([
        listCILinks(provider),
        listCITypes().catch(() => ({ items: [] as CIType[], total: 0 })),
      ]);
      setRows(links.items ?? []);
      setCITypes(types.items ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeName = (id: number) => {
    const found = ciTypes.find((ciType) => ciType.id === id);
    return found ? found.alias || found.name : `#${id}`;
  };

  async function remove(link: CILink) {
    if (!(await confirmAction(tr(`删除 ${label} 链接？`, `Delete the ${label} link?`)))) return;
    try {
      await deleteCILink(provider, link.ci_type_id);
      await load();
    } catch (e) {
      await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-text">{label}</h2>
          <p className="mt-1 text-xs text-text-muted">
            {provider === 'grafana'
              ? tr('按 CI 属性填充仪表盘变量，打开全局 Grafana 深链。', 'Fill dashboard variables from CI attributes and open a deep link to the global Grafana.')
              : tr('按 CI 属性匹配 Prometheus 标签，只展示全局 Prometheus 的活动告警。', 'Match Prometheus labels from CI attributes and show the global Prometheus active alerts.')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
            {tr('刷新', 'Refresh')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
            <Plus size={12} />
            {tr('新建链接', 'New link')}
          </Button>
        </div>
      </div>

      {err && <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}

      {loading ? (
        <p className="py-6 text-center text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>
      ) : rows.length === 0 ? (
        <EmptyStateCard
          icon={MonitorPlay}
          title={tr('尚未配置链接', 'No links yet')}
          hint={tr('配置后，CMDB 实例详情会出现「监控」页签。', 'Once configured, CMDB instance details gain a Monitoring tab.')}
          action={
            <Button variant="primary" size="sm" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
              {tr('新建链接', 'New link')}
            </Button>
          }
        />
      ) : (
        <div className="og-resource-table" data-variant="quiet">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th>{tr('CI 类型', 'CI type')}</th>
                <th>{tr('配置', 'Mapping')}</th>
                <th>{tr('启用', 'Enabled')}</th>
                <th className="text-right">{tr('操作', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((link) => (
                <tr key={link.ci_type_id}>
                  <td className="text-text">{typeName(link.ci_type_id)}</td>
                  <td className="max-w-[28rem] truncate text-text-muted">
                    {provider === 'grafana'
                      ? `${link.dashboard_uid ?? ''}${link.dashboard_slug ? ` / ${link.dashboard_slug}` : ''}`
                      : `${link.label_mapping?.length ?? 0} labels · ${link.extra_matchers?.length ?? 0} matchers`}
                  </td>
                  <td>{link.enabled ? <Chip tone="success">{tr('启用', 'On')}</Chip> : <Chip>{tr('停用', 'Off')}</Chip>}</td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" type="button" aria-label={tr('编辑', 'Edit')} onClick={() => { setCreating(false); setEditing(link); }}>
                        <Pencil size={12} />
                      </Button>
                      <Button variant="dangerGhost" size="sm" type="button" aria-label={tr('删除', 'Delete')} onClick={() => void remove(link)}>
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <LinkDialog
          provider={provider}
          link={editing}
          ciTypes={ciTypes}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await load();
          }}
        />
      )}
      {dialog}
    </Card>
  );
}

function LinkDialog({
  provider,
  link,
  ciTypes,
  onClose,
  onSaved,
}: {
  provider: Provider;
  link: CILink | null;
  ciTypes: CIType[];
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { tr } = useI18n();
  const [ciTypeID, setCITypeID] = useState(String(link?.ci_type_id ?? ciTypes[0]?.id ?? ''));
  const [enabled, setEnabled] = useState(link?.enabled ?? true);
  const [dashboardUID, setDashboardUID] = useState(link?.dashboard_uid ?? '');
  const [dashboardSlug, setDashboardSlug] = useState(link?.dashboard_slug ?? '');
  const [openMode, setOpenMode] = useState<'link' | 'embed'>(link?.open_mode ?? 'link');
  const [vars, setVars] = useState<VarMapping[]>(link?.var_mapping ?? [{ ci_attribute: '', var_name: '' }]);
  const [labels, setLabels] = useState<LabelMapping[]>(link?.label_mapping ?? [{ ci_attribute: '', prom_label: '' }]);
  const [matchers, setMatchers] = useState<Matcher[]>(link?.extra_matchers ?? []);
  const [ciID, setCIID] = useState('');
  const [preview, setPreview] = useState<CIPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const input: CILinkInput = {
    enabled,
    dashboard_uid: provider === 'grafana' ? dashboardUID : undefined,
    dashboard_slug: provider === 'grafana' ? dashboardSlug : undefined,
    open_mode: provider === 'grafana' ? openMode : undefined,
    var_mapping: provider === 'grafana' ? vars.filter((v) => v.ci_attribute && v.var_name) : undefined,
    label_mapping: provider === 'prometheus' ? labels.filter((l) => l.ci_attribute && l.prom_label) : undefined,
    extra_matchers: provider === 'prometheus' ? matchers.filter((m) => m.label && m.value) : undefined,
  };

  async function runPreview() {
    setErr(null);
    setPreview(null);
    try {
      setPreview(await previewCILink(provider, Number(ciID), input));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await saveCILink(provider, Number(ciTypeID), input);
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={link ? tr('编辑监控链接', 'Edit monitoring link') : tr('新建监控链接', 'New monitoring link')}
      size="xl"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void runPreview()} disabled={!ciID}>
            {tr('预览命中', 'Preview')}
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={saving}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={saving}>
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {err && <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}
        {preview && (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-text-muted">
            <div>{tr('命中：', 'Matched: ')}{preview.matched}{preview.reason ? ` · ${preview.reason}` : ''}</div>
            {preview.vars && Object.keys(preview.vars).length > 0 && (
              <div className="mt-1 font-mono text-[11px]">{Object.entries(preview.vars).map(([k, v]) => `var-${k}=${v}`).join(' ')}</div>
            )}
            {preview.labels && Object.keys(preview.labels).length > 0 && (
              <div className="mt-1 font-mono text-[11px]">{Object.entries(preview.labels).map(([k, v]) => `${k}="${v}"`).join(', ')}</div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label>{tr('CI 类型', 'CI type')}</Label>
            {ciTypes.length > 0 ? (
              <Select
                label={tr('CI 类型', 'CI type')}
                value={ciTypeID}
                onValueChange={setCITypeID}
                options={ciTypes.map((ciType) => ({ value: String(ciType.id), label: ciType.alias || ciType.name }))}
                className="w-full"
                searchable
              />
            ) : (
              <Input aria-label={tr('CI 类型 ID', 'CI type ID')} type="number" value={ciTypeID} onChange={(e) => setCITypeID(e.target.value)} />
            )}
          </div>
          <div>
            <Label htmlFor="ciobs-preview-ci">{tr('预览用 CI ID', 'CI ID for preview')}</Label>
            <Input id="ciobs-preview-ci" type="number" value={ciID} onChange={(e) => setCIID(e.target.value)} />
          </div>
          <label className="flex items-end gap-2 pb-2 text-xs text-text-muted">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={tr('启用', 'Enabled')} />
            {tr('启用', 'Enabled')}
          </label>
        </div>

        {provider === 'grafana' ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="ciobs-uid">{tr('Dashboard UID', 'Dashboard UID')}</Label>
                <Input id="ciobs-uid" value={dashboardUID} onChange={(e) => setDashboardUID(e.target.value)} className="font-mono" />
              </div>
              <div>
                <Label htmlFor="ciobs-slug">{tr('Dashboard slug', 'Dashboard slug')}</Label>
                <Input id="ciobs-slug" value={dashboardSlug} onChange={(e) => setDashboardSlug(e.target.value)} className="font-mono" />
              </div>
              <div>
                <Label>{tr('打开方式', 'Open mode')}</Label>
                <Select label={tr('打开方式', 'Open mode')} value={openMode} onValueChange={(v) => setOpenMode(v as 'link' | 'embed')} options={OPEN_MODES} className="w-full" />
              </div>
            </div>
            <RowEditor
              title={tr('变量映射', 'Variable mappings')}
              rows={vars}
              onChange={setVars}
              fields={[
                { key: 'ci_attribute', placeholder: 'hostname' },
                { key: 'var_name', placeholder: 'device_id' },
              ]}
              empty={{ ci_attribute: '', var_name: '' }}
            />
          </>
        ) : (
          <>
            <RowEditor
              title={tr('标签映射', 'Label mappings')}
              rows={labels}
              onChange={setLabels}
              fields={[
                { key: 'ci_attribute', placeholder: 'hostname' },
                { key: 'prom_label', placeholder: 'host' },
              ]}
              empty={{ ci_attribute: '', prom_label: '' }}
            />
            <MatcherEditor rows={matchers} onChange={setMatchers} />
          </>
        )}
      </div>
    </Modal>
  );
}

function RowEditor<T extends Record<string, string>>({
  title,
  rows,
  onChange,
  fields,
  empty,
}: {
  title: string;
  rows: T[];
  onChange(rows: T[]): void;
  fields: { key: keyof T & string; placeholder: string }[];
  empty: T;
}) {
  const { tr } = useI18n();
  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-text">{title}</span>
        <Button variant="subtle" size="sm" type="button" onClick={() => onChange([...rows, empty])}>
          <Plus size={12} /> {tr('添加行', 'Add row')}
        </Button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            {fields.map((field) => (
              <Input
                key={field.key}
                aria-label={field.placeholder}
                placeholder={field.placeholder}
                value={row[field.key] ?? ''}
                onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, [field.key]: e.target.value } : item)))}
                className="font-mono"
              />
            ))}
            <Button variant="dangerGhost" size="sm" type="button" aria-label={tr('删除行', 'Remove row')} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              <Trash2 size={12} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MatcherEditor({ rows, onChange }: { rows: Matcher[]; onChange(rows: Matcher[]): void }) {
  const { tr } = useI18n();
  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-text">{tr('额外匹配条件', 'Extra matchers')}</span>
        <Button variant="subtle" size="sm" type="button" onClick={() => onChange([...rows, { label: '', op: 'eq', value: '' }])}>
          <Plus size={12} /> {tr('添加条件', 'Add matcher')}
        </Button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-12 gap-2">
            <div className="col-span-4">
              <Input aria-label={tr('标签', 'Label')} placeholder="severity" value={row.label} onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, label: e.target.value } : item)))} className="font-mono" />
            </div>
            <div className="col-span-3">
              <Select aria-label={tr('操作符', 'Operator')} value={row.op} onValueChange={(v) => onChange(rows.map((item, i) => (i === index ? { ...item, op: v } : item)))} options={MATCHER_OPS} className="w-full" />
            </div>
            <div className="col-span-4">
              <Input aria-label={tr('值', 'Value')} placeholder="critical" value={row.value} onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, value: e.target.value } : item)))} />
            </div>
            <div className="col-span-1 flex items-center">
              <Button variant="dangerGhost" size="sm" type="button" aria-label={tr('删除条件', 'Remove matcher')} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                <Trash2 size={12} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
