import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, RefreshCw, Trash2 } from 'lucide-react';

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
import { ApiError } from '@/api/client';
import { useI18n } from '@/i18n/locale';
import {
  getColumns,
  saveColumns,
  type DisplayColumn,
  type FederationKind,
} from '@/api/federation';

const RENDERS = [
  { value: 'text', label: 'text' },
  { value: 'time', label: 'time' },
  { value: 'badge', label: 'badge' },
  { value: 'link', label: 'link' },
];

export function ColumnsCard({ kind }: { kind: FederationKind }) {
  const { tr } = useI18n();
  const [columns, setColumns] = useState<DisplayColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getColumns(kind);
      setColumns((res.items ?? []).map((column, index) => ({ ...column, position: index })));
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

  function move(index: number, delta: number) {
    const next = [...columns];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setColumns(next.map((column, position) => ({ ...column, position })));
    setOk(null);
  }

  function update(index: number, patch: Partial<DisplayColumn>) {
    setColumns(columns.map((column, i) => (i === index ? { ...column, ...patch } : column)));
    setOk(null);
  }

  function remove(index: number) {
    setColumns(columns.filter((_, i) => i !== index).map((column, position) => ({ ...column, position })));
    setOk(null);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    setOk(null);
    try {
      const res = await saveColumns(kind, columns);
      setColumns((res.items ?? []).map((column, index) => ({ ...column, position: index })));
      setOk(tr('已保存', 'Saved'));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const visible = columns.some((column) => column.visible);

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">{tr('展示列', 'Display columns')}</h3>
          <p className="mt-1 text-xs text-text-muted">
            {tr('顺序即表格列顺序；至少保留一列可见。', 'Order is the table order; keep at least one column visible.')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
            {tr('刷新', 'Refresh')}
          </Button>
          <Button variant="outline" size="sm" type="button" onClick={() => setAdding(true)}>
            <Plus size={12} />
            {tr('新增列', 'Add column')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={saving || loading || !visible}>
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      </div>

      {err && <div role="alert" className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}
      {ok && <div className="mb-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">{ok}</div>}
      {!visible && <p className="mb-2 text-xs text-amber-300">{tr('至少一列必须可见才能保存。', 'At least one column must be visible before saving.')}</p>}

      {loading ? (
        <p className="py-6 text-center text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>
      ) : columns.length === 0 ? (
        <EmptyStateCard
          icon={Plus}
          title={tr('尚无展示列', 'No columns')}
          hint={tr('保存默认列或新增一列后即可展示。', 'Save the defaults or add a column.')}
          action={<Button variant="primary" size="sm" onClick={() => setAdding(true)}>{tr('新增列', 'Add column')}</Button>}
        />
      ) : (
        <div className="og-resource-table" data-variant="quiet">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th>{tr('列', 'Column')}</th>
                <th>{tr('路径 / 标签', 'Path / label')}</th>
                <th>{tr('渲染', 'Render')}</th>
                <th>{tr('可见', 'Visible')}</th>
                <th className="text-right">{tr('操作', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column, index) => (
                <tr key={`${column.key}-${index}`}>
                  <td>
                    <div className="font-mono text-[11px] text-text">{column.key}</div>
                    <Chip>{column.kind}</Chip>
                  </td>
                  <td>
                    {column.kind === 'custom' ? (
                      <div className="grid grid-cols-1 gap-1.5">
                        <Input
                          aria-label={tr('字段路径', 'Field path')}
                          value={column.path ?? ''}
                          onChange={(e) => update(index, { path: e.target.value })}
                          className="font-mono"
                          placeholder="form_data.owner.email"
                        />
                        <div className="grid grid-cols-2 gap-1.5">
                          <Input aria-label={tr('中文标签', 'Chinese label')} value={column.label_zh ?? ''} onChange={(e) => update(index, { label_zh: e.target.value })} placeholder="中文" />
                          <Input aria-label={tr('英文标签', 'English label')} value={column.label_en ?? ''} onChange={(e) => update(index, { label_en: e.target.value })} placeholder="English" />
                        </div>
                      </div>
                    ) : (
                      <span className="text-text-muted">{column.path || '—'}</span>
                    )}
                  </td>
                  <td>
                    {column.kind === 'custom' ? (
                      <Select
                        aria-label={tr('渲染方式', 'Render')}
                        value={column.render ?? 'text'}
                        onValueChange={(v) => update(index, { render: v as DisplayColumn['render'] })}
                        options={RENDERS}
                        className="w-28"
                      />
                    ) : (
                      <span className="text-text-muted">{column.render || 'text'}</span>
                    )}
                  </td>
                  <td>
                    <Switch
                      checked={column.visible}
                      onCheckedChange={(checked) => update(index, { visible: checked })}
                      aria-label={tr('可见', 'Visible')}
                    />
                  </td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" type="button" aria-label={tr('上移', 'Move up')} disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp size={12} />
                      </Button>
                      <Button variant="ghost" size="sm" type="button" aria-label={tr('下移', 'Move down')} disabled={index === columns.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDown size={12} />
                      </Button>
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        type="button"
                        aria-label={tr('删除列', 'Remove column')}
                        disabled={column.kind !== 'custom'}
                        onClick={() => remove(index)}
                      >
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

      {adding && (
        <AddColumnDialog
          existing={columns.map((column) => column.key)}
          onClose={() => setAdding(false)}
          onAdd={(column) => {
            setColumns([...columns, { ...column, position: columns.length }]);
            setAdding(false);
            setOk(null);
          }}
        />
      )}
    </Card>
  );
}

function AddColumnDialog({
  existing,
  onClose,
  onAdd,
}: {
  existing: string[];
  onClose(): void;
  onAdd(column: DisplayColumn): void;
}) {
  const { tr } = useI18n();
  const [key, setKey] = useState('');
  const [path, setPath] = useState('');
  const [render, setRender] = useState<DisplayColumn['render']>('text');
  const [labelZH, setLabelZH] = useState('');
  const [labelEN, setLabelEN] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function add() {
    const cleaned = key.trim();
    if (!/^[a-z][a-z0-9_-]*$/.test(cleaned)) {
      setErr(tr('Key 只能是小写字母、数字、下划线或短横线，且以字母开头。', 'Key must start with a lowercase letter and contain only lowercase letters, digits, _ or -.'));
      return;
    }
    if (existing.includes(cleaned)) {
      setErr(tr('Key 已存在。', 'Key already exists.'));
      return;
    }
    if (!path.trim()) {
      setErr(tr('字段路径不能为空。', 'Field path is required.'));
      return;
    }
    onAdd({
      key: cleaned,
      kind: 'custom',
      path: path.trim(),
      render,
      label_zh: labelZH.trim(),
      label_en: labelEN.trim(),
      visible: true,
      position: 0,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('新增展示列', 'Add display column')}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>{tr('取消', 'Cancel')}</Button>
          <Button variant="primary" size="sm" type="button" onClick={add}>{tr('添加', 'Add')}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        {err && <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}
        <div>
          <Label htmlFor="fed-col-key">{tr('Key', 'Key')}</Label>
          <Input id="fed-col-key" value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" placeholder="owner" />
        </div>
        <div>
          <Label htmlFor="fed-col-path">{tr('字段路径', 'Field path')}</Label>
          <Input id="fed-col-path" value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" placeholder="form_data.owner.email" />
        </div>
        <div>
          <Label>{tr('渲染方式', 'Render')}</Label>
          <Select label={tr('渲染方式', 'Render')} value={render ?? 'text'} onValueChange={(v) => setRender(v as DisplayColumn['render'])} options={RENDERS} className="w-full" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="fed-col-zh">{tr('中文标签', 'Chinese label')}</Label>
            <Input id="fed-col-zh" value={labelZH} onChange={(e) => setLabelZH(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="fed-col-en">{tr('英文标签', 'English label')}</Label>
            <Input id="fed-col-en" value={labelEN} onChange={(e) => setLabelEN(e.target.value)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
