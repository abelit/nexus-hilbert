import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw, ScanSearch, Trash2 } from 'lucide-react';

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
import {
  deleteFilter,
  listFieldPaths,
  listFilters,
  previewFilter,
  saveFilter,
  type CenterFilter,
  type FederationKind,
  type FilterInput,
  type FilterPreview,
  type Rule,
} from '@/api/federation';

const OPS = ['eq', 'ne', 'in', 'not_in', 'regex', 'gt', 'gte', 'lt', 'lte', 'exists'].map((op) => ({
  value: op,
  label: op,
}));

const IDENTITIES = [
  { value: 'email', label: 'email' },
  { value: 'phone', label: 'phone' },
  { value: 'username', label: 'username' },
  { value: 'dingtalk_userid', label: 'dingtalk_userid' },
];

function needsIdentity(filter: CenterFilter): boolean {
  return [...filter.and, ...filter.or].some((rule) => rule.value_type === 'identity');
}

export function FiltersCard({ kind }: { kind: FederationKind }) {
  const { tr } = useI18n();
  const { confirmAction, alertAction, dialog } = useDialogs();
  const [rows, setRows] = useState<CenterFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<CenterFilter | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listFilters(kind);
      setRows(res.items ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(filter: CenterFilter) {
    if (!(await confirmAction(tr(`删除过滤器「${filter.name}」？`, `Delete filter “${filter.name}”?`)))) return;
    try {
      await deleteFilter(kind, filter.key);
      await load();
    } catch (e) {
      await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">{tr('中心过滤器', 'Center filters')}</h3>
          <p className="mt-1 text-xs text-text-muted">
            {tr('配置范围下拉与徽标；同一类型只能有一个启用徽标的过滤器。', 'Configure scope presets and the badge; only one enabled filter per kind may drive the badge.')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
            {tr('刷新', 'Refresh')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
            <Plus size={12} />
            {tr('新建过滤器', 'New filter')}
          </Button>
        </div>
      </div>

      {err && <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}

      {loading ? (
        <p className="py-6 text-center text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>
      ) : rows.length === 0 ? (
        <EmptyStateCard
          icon={ScanSearch}
          title={tr('尚未配置过滤器', 'No filters yet')}
          hint={tr('过滤器决定「我的告警」看什么，以及侧栏徽标统计哪一组。', 'Filters decide what “my alerts” shows and which group the badge counts.')}
          action={
            <Button variant="primary" size="sm" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
              {tr('新建过滤器', 'New filter')}
            </Button>
          }
        />
      ) : (
        <div className="og-resource-table" data-variant="quiet">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th>{tr('Key', 'Key')}</th>
                <th>{tr('名称', 'Name')}</th>
                <th>{tr('用途', 'Usage')}</th>
                <th>{tr('身份', 'Identity')}</th>
                <th>{tr('启用', 'Enabled')}</th>
                <th className="text-right">{tr('操作', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((filter) => (
                <tr key={filter.key}>
                  <td className="font-mono text-[11px] text-text-muted">{filter.key}</td>
                  <td className="font-medium text-text">{filter.name}</td>
                  <td className="text-text-muted">{filter.usage}</td>
                  <td>{needsIdentity(filter) ? <Chip tone="info">{tr('按用户', 'Per viewer')}</Chip> : '—'}</td>
                  <td>{filter.enabled ? <Chip tone="success">{tr('启用', 'On')}</Chip> : <Chip>{tr('停用', 'Off')}</Chip>}</td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" type="button" aria-label={tr('编辑', 'Edit')} onClick={() => { setCreating(false); setEditing(filter); }}>
                        <Pencil size={12} />
                      </Button>
                      <Button variant="dangerGhost" size="sm" type="button" aria-label={tr('删除', 'Delete')} onClick={() => void remove(filter)}>
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
        <FilterDialog
          kind={kind}
          filter={editing}
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

function FilterDialog({  kind,
  filter,
  onClose,
  onSaved,
}: {
  kind: FederationKind;
  filter: CenterFilter | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { tr } = useI18n();
  const [key, setKey] = useState(filter?.key ?? '');
  const [name, setName] = useState(filter?.name ?? '');
  const [usage, setUsage] = useState<CenterFilter['usage']>(filter?.usage ?? 'filter');
  const [enabled, setEnabled] = useState(filter?.enabled ?? true);
  const [andRules, setAndRules] = useState<Rule[]>(filter?.and ?? []);
  const [orRules, setOrRules] = useState<Rule[]>(filter?.or ?? []);
  const [paths, setPaths] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [preview, setPreview] = useState<FilterPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const usageOptions = [
    { value: 'filter', label: tr('筛选', 'Filter') },
    { value: 'badge', label: tr('徽标', 'Badge') },
    { value: 'both', label: tr('筛选 + 徽标', 'Filter + badge') },
  ];

  const input: FilterInput = {
    key, name, usage, enabled,
    and: andRules, or: orRules, position: filter?.position ?? 0,
  };

  async function scan() {
    setScanning(true);
    setErr(null);
    try {
      const res = await listFieldPaths(kind);
      setPaths((res.items ?? []).map((item) => item.path));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function runPreview() {
    setErr(null);
    setPreview(null);
    try {
      setPreview(await previewFilter(kind, input));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await saveFilter(kind, input, filter?.key);
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
      title={filter ? tr('编辑过滤器', 'Edit filter') : tr('新建过滤器', 'New filter')}
      size="xl"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void scan()} disabled={scanning}>
            <ScanSearch size={12} /> {scanning ? tr('扫描中…', 'Scanning…') : tr('扫描字段', 'Scan fields')}
          </Button>
          <Button variant="outline" size="sm" type="button" onClick={() => void runPreview()}>
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
            <div className="mt-1 font-mono text-[11px]">AND: {preview.and.join(' | ') || '—'}</div>
            <div className="font-mono text-[11px]">OR: {preview.or.join(' | ') || '—'}</div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="fed-filter-key">{tr('Key', 'Key')}</Label>
            <Input id="fed-filter-key" value={key} disabled={Boolean(filter)} onChange={(e) => setKey(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label htmlFor="fed-filter-name">{tr('名称', 'Name')}</Label>
            <Input id="fed-filter-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>{tr('用途', 'Usage')}</Label>
            <Select label={tr('用途', 'Usage')} value={usage} onValueChange={(v) => setUsage(v as CenterFilter['usage'])} options={usageOptions} className="w-full" />
          </div>
          <label className="flex items-end gap-2 pb-2 text-xs text-text-muted">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={tr('启用', 'Enabled')} />
            {tr('启用', 'Enabled')}
          </label>
        </div>

        {paths.length > 0 && (
          <datalist id="fed-field-paths">
            {paths.map((path) => <option key={path} value={path} />)}
          </datalist>
        )}

        <RuleGroup
          title={tr('AND 组（全部满足）', 'AND group (all must match)')}
          rules={andRules}
          onChange={setAndRules}
          paths={paths}
        />
        <RuleGroup
          title={tr('OR 组（任一满足；身份规则未命中会被跳过）', 'OR group (any match; an unresolved identity rule is skipped)')}
          rules={orRules}
          onChange={setOrRules}
          paths={paths}
        />
      </div>
    </Modal>
  );
}

function RuleGroup({
  title,
  rules,
  onChange,
  paths,
}: {
  title: string;
  rules: Rule[];
  onChange(rules: Rule[]): void;
  paths: string[];
}) {
  const { tr } = useI18n();
  const valueTypeOptions = [
    { value: 'fixed', label: tr('固定值', 'Fixed value') },
    { value: 'identity', label: tr('当前用户', 'Current user') },
  ];

  function update(index: number, next: Rule) {
    onChange(rules.map((rule, i) => (i === index ? next : rule)));
  }

  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-text">{title}</span>
        <Button
          variant="subtle"
          size="sm"
          type="button"
          onClick={() => onChange([...rules, { field: '', op: 'eq', value_type: 'fixed', values: [''] }])}
        >
          <Plus size={12} /> {tr('添加规则', 'Add rule')}
        </Button>
      </div>
      {rules.length === 0 ? (
        <p className="text-[11px] text-text-faint">{tr('暂无规则', 'No rules')}</p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, index) => (
            <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
              <div className="sm:col-span-3">
                <Input
                  aria-label={tr('字段路径', 'Field path')}
                  placeholder="alert.labels.host"
                  list={paths.length > 0 ? 'fed-field-paths' : undefined}
                  value={rule.field}
                  onChange={(e) => update(index, { ...rule, field: e.target.value })}
                  className="font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <Select aria-label={tr('操作符', 'Operator')} value={rule.op} onValueChange={(v) => update(index, { ...rule, op: v })} options={OPS} className="w-full" />
              </div>
              <div className="sm:col-span-2">
                <Select aria-label={tr('值类型', 'Value type')} value={rule.value_type} onValueChange={(v) => update(index, { ...rule, value_type: v as Rule['value_type'] })} options={valueTypeOptions} className="w-full" />
              </div>
              <div className="sm:col-span-3">
                {rule.value_type === 'identity' ? (
                  <Select aria-label={tr('身份来源', 'Identity source')} value={rule.identity ?? 'email'} onValueChange={(v) => update(index, { ...rule, identity: v })} options={IDENTITIES} className="w-full" />
                ) : (
                  <Input
                    aria-label={tr('值（in 用逗号分隔）', 'Values (comma-separated for in)')}
                    placeholder={tr('值', 'Value')}
                    value={(rule.values ?? []).join(', ')}
                    onChange={(e) => update(index, { ...rule, values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
                  />
                )}
              </div>
              <div className="flex items-center sm:col-span-2">
                <Button
                  variant="dangerGhost"
                  size="sm"
                  type="button"
                  aria-label={tr('删除规则', 'Remove rule')}
                  onClick={() => onChange(rules.filter((_, i) => i !== index))}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
