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
  deleteMapping,
  listCITypes,
  listConnections,
  listFieldPaths,
  listMappings,
  previewMapping,
  saveMapping,
  type CIType,
  type Connection,
  type FederationKind,
  type FieldMapping,
  type Mapping,
  type MappingInput,
  type MappingPreview,
} from '@/api/federation';

const OPS = ['eq', 'ne', 'in', 'not_in', 'regex', 'gt', 'gte', 'lt', 'lte', 'exists'].map((op) => ({
  value: op,
  label: op,
}));

const MAP_TYPES = [
  { value: 'field', label: 'CI 属性' },
  { value: 'fixed', label: '固定值' },
];

export function MappingsCard({ kind }: { kind: FederationKind }) {
  const { tr } = useI18n();
  const { confirmAction, alertAction, dialog } = useDialogs();
  const [rows, setRows] = useState<Mapping[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [ciTypes, setCITypes] = useState<CIType[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Mapping | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mappingRows, connectionRows, typeRows] = await Promise.all([
        listMappings(kind),
        listConnections(kind),
        listCITypes().catch(() => ({ items: [] as CIType[], total: 0 })),
      ]);
      setRows(mappingRows.items ?? []);
      setConnections(connectionRows.items ?? []);
      setCITypes(typeRows.items ?? []);
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

  const typeName = (id: number) => {
    const found = ciTypes.find((ciType) => ciType.id === id);
    return found ? found.alias || found.name : `#${id}`;
  };
  const connectionName = (id: number) =>
    connections.find((connection) => connection.id === id)?.name ?? `#${id}`;

  async function remove(mapping: Mapping) {
    if (!(await confirmAction(tr('删除该 CI 映射？', 'Delete this CI mapping?')))) return;
    try {
      await deleteMapping(kind, mapping.id);
      await load();
    } catch (e) {
      await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">{tr('CI 映射', 'CI mappings')}</h3>
          <p className="mt-1 text-xs text-text-muted">
            {tr('把 CI 属性映射为上游过滤条件；field 行用于识别该 CI，fixed 行用于限定查询范围。', 'Map CI attributes to upstream filters: field rows identify the CI, fixed rows scope the query.')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
            {tr('刷新', 'Refresh')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
            <Plus size={12} />
            {tr('新建映射', 'New mapping')}
          </Button>
        </div>
      </div>

      {err && <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}

      {loading ? (
        <p className="py-6 text-center text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>
      ) : rows.length === 0 ? (
        <EmptyStateCard
          icon={ScanSearch}
          title={tr('尚未配置 CI 映射', 'No CI mappings yet')}
          hint={tr('配置后，CMDB 实例详情会出现告警/工单页签。', 'Once configured, CMDB instance details gain alert/ticket tabs.')}
          action={
            <Button variant="primary" size="sm" type="button" onClick={() => { setEditing(null); setCreating(true); }}>
              {tr('新建映射', 'New mapping')}
            </Button>
          }
        />
      ) : (
        <div className="og-resource-table" data-variant="quiet">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th>{tr('CI 类型', 'CI type')}</th>
                <th>{tr('连接', 'Connection')}</th>
                <th>{tr('规则', 'Rules')}</th>
                <th>{tr('启用', 'Enabled')}</th>
                <th className="text-right">{tr('操作', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((mapping) => (
                <tr key={mapping.id}>
                  <td className="text-text">{typeName(mapping.ci_type_id)}</td>
                  <td className="text-text-muted">{connectionName(mapping.connection_id)}</td>
                  <td className="text-text-muted">{mapping.field_mapping.length} {tr('条', 'rows')}</td>
                  <td>{mapping.enabled ? <Chip tone="success">{tr('启用', 'On')}</Chip> : <Chip>{tr('停用', 'Off')}</Chip>}</td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" type="button" aria-label={tr('编辑', 'Edit')} onClick={() => { setCreating(false); setEditing(mapping); }}>
                        <Pencil size={12} />
                      </Button>
                      <Button variant="dangerGhost" size="sm" type="button" aria-label={tr('删除', 'Delete')} onClick={() => void remove(mapping)}>
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
        <MappingDialog
          kind={kind}
          mapping={editing}
          connections={connections}
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

function MappingDialog({
  kind,
  mapping,
  connections,
  ciTypes,
  onClose,
  onSaved,
}: {
  kind: FederationKind;
  mapping: Mapping | null;
  connections: Connection[];
  ciTypes: CIType[];
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { tr } = useI18n();
  const [ciTypeID, setCITypeID] = useState(String(mapping?.ci_type_id ?? ciTypes[0]?.id ?? ''));
  const [connectionID, setConnectionID] = useState(String(mapping?.connection_id ?? connections[0]?.id ?? ''));
  const [rows, setRows] = useState<FieldMapping[]>(
    mapping?.field_mapping ?? [{ source_field: '', op: 'eq', map_type: 'field', value: '' }],
  );
  const [enabled, setEnabled] = useState(mapping?.enabled ?? true);
  const [ciID, setCIID] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const input: MappingInput = {
    ci_type_id: Number(ciTypeID) || 0,
    connection_id: Number(connectionID) || 0,
    field_mapping: rows,
    enabled,
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
      setPreview(await previewMapping(kind, Number(ciID), input));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await saveMapping(kind, input, mapping?.id);
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function update(index: number, next: FieldMapping) {
    setRows(rows.map((row, i) => (i === index ? next : row)));
    setPreview(null);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={mapping ? tr('编辑 CI 映射', 'Edit CI mapping') : tr('新建 CI 映射', 'New CI mapping')}
      size="xl"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void scan()} disabled={scanning}>
            <ScanSearch size={12} /> {scanning ? tr('扫描中…', 'Scanning…') : tr('扫描字段', 'Scan fields')}
          </Button>
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
            <div className="mt-1 font-mono text-[11px]">AND: {preview.and.join(' | ') || '—'}</div>
            <div className="font-mono text-[11px]">OR: {preview.or.join(' | ') || '—'}</div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <Label>{tr('连接', 'Connection')}</Label>
            <Select
              label={tr('连接', 'Connection')}
              value={connectionID}
              onValueChange={setConnectionID}
              options={connections.map((connection) => ({ value: String(connection.id), label: connection.name }))}
              className="w-full"
            />
          </div>
          <div>
            <Label htmlFor="fed-map-ci">{tr('预览用 CI ID', 'CI ID for preview')}</Label>
            <Input id="fed-map-ci" type="number" value={ciID} onChange={(e) => setCIID(e.target.value)} placeholder="7" />
          </div>
          <label className="flex items-end gap-2 pb-2 text-xs text-text-muted">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={tr('启用', 'Enabled')} />
            {tr('启用', 'Enabled')}
          </label>
        </div>

        {paths.length > 0 && (
          <datalist id="fed-map-paths">
            {paths.map((path) => <option key={path} value={path} />)}
          </datalist>
        )}

        <div className="rounded-lg border border-zinc-800 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-text">{tr('映射行', 'Mapping rows')}</span>
            <Button
              variant="subtle"
              size="sm"
              type="button"
              onClick={() => setRows([...rows, { source_field: '', op: 'eq', map_type: 'field', value: '' }])}
            >
              <Plus size={12} /> {tr('添加行', 'Add row')}
            </Button>
          </div>
          <div className="space-y-2">
            {rows.map((row, index) => (
              <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <Input
                    aria-label={tr('上游字段', 'Upstream field')}
                    placeholder="alert.labels.host"
                    list={paths.length > 0 ? 'fed-map-paths' : undefined}
                    value={row.source_field}
                    onChange={(e) => update(index, { ...row, source_field: e.target.value })}
                    className="font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Select aria-label={tr('操作符', 'Operator')} value={row.op} onValueChange={(v) => update(index, { ...row, op: v })} options={OPS} className="w-full" />
                </div>
                <div className="sm:col-span-2">
                  <Select aria-label={tr('映射类型', 'Map type')} value={row.map_type} onValueChange={(v) => update(index, { ...row, map_type: v as FieldMapping['map_type'] })} options={MAP_TYPES} className="w-full" />
                </div>
                <div className="sm:col-span-3">
                  <Input
                    aria-label={row.map_type === 'field' ? tr('CI 属性名', 'CI attribute') : tr('固定值', 'Fixed value')}
                    placeholder={row.map_type === 'field' ? 'hostname' : 'prod'}
                    value={row.value}
                    onChange={(e) => update(index, { ...row, value: e.target.value })}
                  />
                </div>
                <div className="flex items-center sm:col-span-1">
                  <Button
                    variant="dangerGhost"
                    size="sm"
                    type="button"
                    aria-label={tr('删除行', 'Remove row')}
                    onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
