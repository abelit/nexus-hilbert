import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cable, CheckCircle2, Pencil, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';

import {
  Button,
  Card,
  Chip,
  EmptyStateCard,
  Input,
  Label,
  PageHeader,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { ApiError } from '@/api/client';
import { useI18n } from '@/i18n/locale';
import {
  connectionHealth,
  createConnection,
  deleteConnection,
  listConnections,
  testConnection,
  testSavedConnection,
  updateConnection,
  type Connection,
  type ConnectionInput,
  type FederationKind,
  type HealthRow,
} from '@/api/federation';

const KINDS: { value: FederationKind; zh: string; en: string }[] = [
  { value: 'external_alert', zh: '告警源', en: 'Alert source' },
  { value: 'itsm_ticket', zh: '工单源', en: 'Ticket source' },
];

const AUTH_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer' },
  { value: 'basic', label: 'Basic' },
];

const METHOD_OPTIONS = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
];

type FormState = {
  name: string;
  base_url: string;
  api_path: string;
  method: string;
  auth_type: 'none' | 'bearer' | 'basic';
  token: string;
  username: string;
  password: string;
  default_days: string;
  default_page_size: string;
  timeout_seconds: string;
  is_default: boolean;
  enabled: boolean;
  remark: string;
};

function emptyForm(kind: FederationKind): FormState {
  const alert = kind === 'external_alert';
  return {
    name: '',
    base_url: '',
    api_path: alert ? '/api/v1/alerts' : '/api/v1/webhook/dingtalk/database/incidents',
    method: 'GET',
    auth_type: 'none',
    token: '',
    username: '',
    password: '',
    default_days: alert ? '7' : '30',
    default_page_size: alert ? '50' : '20',
    timeout_seconds: '15',
    is_default: false,
    enabled: true,
    remark: '',
  };
}

function formFrom(connection: Connection): FormState {
  return {
    name: connection.name,
    base_url: connection.base_url,
    api_path: connection.api_path,
    method: connection.method,
    auth_type: connection.auth_type,
    token: '',
    username: connection.username ?? '',
    password: '',
    default_days: String(connection.default_days),
    default_page_size: String(connection.default_page_size),
    timeout_seconds: String(connection.timeout_seconds),
    is_default: connection.is_default,
    enabled: connection.enabled,
    remark: connection.remark ?? '',
  };
}

function toInput(kind: FederationKind, form: FormState, includeAuth = true): ConnectionInput {
  const credentialsTyped = includeAuth && Boolean(form.token || form.password || form.username);
  return {
    kind,
    name: form.name.trim(),
    base_url: form.base_url.trim(),
    api_path: form.api_path.trim(),
    method: form.method,
    auth_type: form.auth_type,
    auth_data:
      form.auth_type !== 'none' && credentialsTyped
        ? { token: form.token, username: form.username, password: form.password }
        : undefined,
    default_days: Number(form.default_days) || undefined,
    default_page_size: Number(form.default_page_size) || undefined,
    timeout_seconds: Number(form.timeout_seconds) || undefined,
    is_default: form.is_default,
    enabled: form.enabled,
    remark: form.remark.trim(),
  };
}

export default function FederationSettings() {
  const { tr } = useI18n();
  const [kind, setKind] = useState<FederationKind>('external_alert');

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('外部数据源', 'Federated sources')}
        subtitle={tr(
          '只读接入 nexus-morse 告警与钉钉 ITSM 工单；不写入上游，也不落库告警/工单',
          'Read-only access to nexus-morse alerts and DingTalk ITSM tickets; nothing is ingested or written upstream',
        )}
      />
      <Tabs value={kind} onValueChange={(next) => setKind(next as FederationKind)}>
        <TabsList aria-label={tr('数据源类型', 'Source kind')}>
          {KINDS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {tr(item.zh, item.en)}
            </TabsTrigger>
          ))}
        </TabsList>
        {KINDS.map((item) => (
          <TabsContent key={item.value} value={item.value}>
            <ConnectionsCard kind={item.value} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function ConnectionsCard({ kind }: { kind: FederationKind }) {
  const { tr } = useI18n();
  const { confirmAction, alertAction, dialog } = useDialogs();
  const [rows, setRows] = useState<Connection[]>([]);
  const [health, setHealth] = useState<Record<number, HealthRow>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, healthRows] = await Promise.all([
        listConnections(kind),
        connectionHealth(kind).catch(() => ({ items: [] as HealthRow[], total: 0 })),
      ]);
      setRows(list.items ?? []);
      setHealth(Object.fromEntries((healthRows.items ?? []).map((row) => [row.id, row])));
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

  async function remove(row: Connection) {
    if (!(await confirmAction(tr(`删除连接「${row.name}」？`, `Delete connection “${row.name}”?`)))) return;
    setBusyId(row.id);
    try {
      await deleteConnection(row.id, false);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (await confirmAction(tr('该连接仍被 CI 映射引用。级联删除连接及其映射？', 'This connection is still referenced by CI mappings. Delete it and its mappings?'))) {
          await deleteConnection(row.id, true);
          await load();
        }
      } else {
        await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function probe(row: Connection) {
    setBusyId(row.id);
    try {
      await testSavedConnection(row.id);
      await load();
    } catch (e) {
      await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const current = useMemo(
    () => (editing ? formFrom(editing) : emptyForm(kind)),
    [editing, kind],
  );

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">
            {tr('连接', 'Connections')}
          </h3>
          <p className="mt-1 text-xs text-text-muted">
            {tr('连接凭据加密存储，读取时只显示是否已设置。', 'Credentials are encrypted at rest; reads only report whether they are set.')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
            {tr('刷新', 'Refresh')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
            <Plus size={12} />
            {tr('新建连接', 'New connection')}
          </Button>
        </div>
      </div>

      {err && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {tr('加载失败：', 'Load failed: ')}{err}
        </div>
      )}

      {loading ? (
        <p className="py-6 text-center text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>
      ) : rows.length === 0 ? (
        <EmptyStateCard
          icon={Cable}
          title={tr('尚未配置连接', 'No connections yet')}
          hint={tr('添加一个只读的上游连接后，中心页即可查询', 'Add a read-only upstream connection so the center can query it')}
          action={
            <Button variant="primary" size="sm" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
              {tr('新建连接', 'New connection')}
            </Button>
          }
        />
      ) : (
        <div className="og-resource-table" data-variant="quiet">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th>{tr('名称', 'Name')}</th>
                <th>{tr('地址', 'Endpoint')}</th>
                <th>{tr('认证', 'Auth')}</th>
                <th>{tr('默认', 'Default')}</th>
                <th>{tr('启用', 'Enabled')}</th>
                <th>{tr('健康', 'Health')}</th>
                <th className="text-right">{tr('操作', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const healthRow = health[row.id];
                return (
                  <tr key={row.id}>
                    <td className="font-medium text-text">{row.name}</td>
                    <td className="max-w-[24rem] truncate font-mono text-[11px] text-text-muted">
                      {row.base_url}{row.api_path}
                    </td>
                    <td className="text-text-muted">{row.auth_type}</td>
                    <td>{row.is_default ? <Chip tone="info">{tr('默认', 'Default')}</Chip> : '—'}</td>
                    <td>{row.enabled ? <Chip tone="success">{tr('启用', 'On')}</Chip> : <Chip>{tr('停用', 'Off')}</Chip>}</td>
                    <td>
                      {healthRow ? (
                        healthRow.ok ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 size={12} /> {tr('正常', 'OK')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-300" title={healthRow.error}>
                            <XCircle size={12} /> {tr('异常', 'Failed')}
                          </span>
                        )
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="subtle" size="sm" type="button" disabled={busyId === row.id} onClick={() => void probe(row)}>
                          {tr('测试', 'Test')}
                        </Button>
                        <Button variant="ghost" size="sm" type="button" aria-label={tr('编辑', 'Edit')} onClick={() => { setCreating(false); setEditing(row); }}>
                          <Pencil size={12} />
                        </Button>
                        <Button variant="dangerGhost" size="sm" type="button" aria-label={tr('删除', 'Delete')} disabled={busyId === row.id} onClick={() => void remove(row)}>
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <ConnectionDialog
          kind={kind}
          connection={editing}
          initial={current}
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

function ConnectionDialog({
  kind,
  connection,
  initial,
  onClose,
  onSaved,
}: {
  kind: FederationKind;
  connection: Connection | null;
  initial: FormState;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { tr } = useI18n();
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Editing prefills the non-secret username; only a field the operator
  // actually touches may replace the stored credential set.
  const [credentialsTouched, setCredentialsTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErr(null);
    setOk(null);
  }

  function setCredential(key: 'token' | 'username' | 'password', value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setCredentialsTouched(true);
    setErr(null);
    setOk(null);
  }

  const credentialed = Boolean(connection && (connection.token_set || connection.password_set));
  const authHint = credentialed
    ? tr('已设置，留空保持不变', 'Set; leave blank to keep')
    : undefined;

  async function runTest() {
    setTesting(true);
    setErr(null);
    setOk(null);
    try {
      if (connection && !credentialsTouched) {
        await testSavedConnection(connection.id);
      } else {
        await testConnection(toInput(kind, form, true));
      }
      setOk(tr('连接测试通过', 'Connection test passed'));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const input = toInput(kind, form, !connection || credentialsTouched);
      if (connection) await updateConnection(connection.id, input);
      else await createConnection(input);
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
      title={connection ? tr('编辑连接', 'Edit connection') : tr('新建连接', 'New connection')}
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void runTest()} disabled={testing || saving}>
            {testing ? tr('测试中…', 'Testing…') : tr('测试连接', 'Test connection')}
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={saving}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={saving || testing}>
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {err && <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}
        {ok && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">{ok}</div>}

        <div>
          <Label htmlFor="fed-name">{tr('名称', 'Name')}</Label>
          <Input id="fed-name" required value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="fed-base">{tr('Base URL', 'Base URL')}</Label>
          <Input id="fed-base" required placeholder="https://morse.example.com" value={form.base_url} onChange={(e) => set('base_url', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="fed-api">{tr('API 路径', 'API path')}</Label>
          <Input id="fed-api" required value={form.api_path} onChange={(e) => set('api_path', e.target.value)} className="font-mono" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="fed-method">{tr('方法', 'Method')}</Label>
            <Select label={tr('方法', 'Method')} value={form.method} onValueChange={(v) => set('method', v)} options={METHOD_OPTIONS} className="w-full" />
          </div>
          <div>
            <Label htmlFor="fed-auth">{tr('认证', 'Auth')}</Label>
            <Select label={tr('认证', 'Auth')} value={form.auth_type} onValueChange={(v) => set('auth_type', v as FormState['auth_type'])} options={AUTH_OPTIONS} className="w-full" />
          </div>
        </div>

        {form.auth_type === 'bearer' && (
          <div>
            <Label htmlFor="fed-token">{tr('Token', 'Token')}</Label>
            <Input id="fed-token" type="password" placeholder={authHint} value={form.token} onChange={(e) => setCredential('token', e.target.value)} autoComplete="new-password" />
          </div>
        )}
        {form.auth_type === 'basic' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="fed-user">{tr('用户名', 'Username')}</Label>
              <Input id="fed-user" value={form.username} onChange={(e) => setCredential('username', e.target.value)} autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="fed-pass">{tr('密码', 'Password')}</Label>
              <Input id="fed-pass" type="password" placeholder={authHint} value={form.password} onChange={(e) => setCredential('password', e.target.value)} autoComplete="new-password" />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="fed-days">{tr('默认天数', 'Default days')}</Label>
            <Input id="fed-days" type="number" min={1} max={366} value={form.default_days} onChange={(e) => set('default_days', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="fed-page-size">{tr('默认页大小', 'Default page size')}</Label>
            <Input id="fed-page-size" type="number" min={1} value={form.default_page_size} onChange={(e) => set('default_page_size', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="fed-timeout">{tr('超时（秒）', 'Timeout (s)')}</Label>
            <Input id="fed-timeout" type="number" min={1} max={60} value={form.timeout_seconds} onChange={(e) => set('timeout_seconds', e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="fed-remark">{tr('备注', 'Remark')}</Label>
          <Input id="fed-remark" value={form.remark} onChange={(e) => set('remark', e.target.value)} />
        </div>

        <div className="flex flex-wrap items-center gap-5 text-xs text-text-muted">
          <label className="flex items-center gap-2">
            <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} aria-label={tr('启用', 'Enabled')} />
            {tr('启用', 'Enabled')}
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={form.is_default} onCheckedChange={(v) => set('is_default', v)} aria-label={tr('设为默认', 'Set as default')} />
            {tr('设为默认', 'Set as default')}
          </label>
        </div>
      </div>
    </Modal>
  );
}
