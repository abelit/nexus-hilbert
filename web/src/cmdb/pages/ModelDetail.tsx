import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Checkbox } from '@/components/ui/Checkbox';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';
import { cn } from '@/lib/cn';

import { describeError } from '../api/http';
import {
  bindAttributes,
  createAttribute,
  deleteAttributeGroup,
  getCIType,
  listAttributeGroups,
  listAllAttributes,
  listTypeAttributes,
  saveAttributeGroup,
  swapAttributeGroups,
  unbindAttributes,
  updateAttributeGroup,
  updateBindings,
  type Attribute,
  type AttributeGroup,
  type CIType,
  type TypeAttribute,
} from '../api/citype';
import { AttributeDictionary } from '../components/AttributeDictionary';
import { ModelConfigShell } from '../components/ModelConfigShell';
import { useModelTreeRefresh } from '../components/model-tree-context';
import { AttributeForm } from '../components/AttributeForm';
import { CMDBIcon } from '../components/CMDBIcon';
import { DataTable, type Column } from '../components/DataTable';
import { ModelForm } from './Models';
import { ConstraintsTab, RelationsTab, TriggersTab } from '../components/ModelRuleTabs';
import { useToast } from '../components/Toast';
import { VALUE_TYPE_LABELS, isValueTypeCode } from '../lib/valuetype';

// 模型配置 · 单个模型.
//
// FIVE THINGS LIVE ON ONE MODEL, and they are the five tabs: its attributes and
// their per-model bindings, the form sections those attributes are grouped into,
// its relations to other models, its uniqueness rules, and its triggers. They
// are all "the model" and none of them is useful without the others, which is
// why they are one page rather than five.
//
// THE ATTRIBUTE TAB SHOWS THE EFFECTIVE SET, NOT THE BOUND SET. A child model
// inherits its parents' attributes, so the list is the union — and an inherited
// row cannot be unbound from here, because it is not bound here. The backend
// marks them; the page disables the action and says where it comes from.

type Tab = 'attributes' | 'groups' | 'relations' | 'constraints' | 'triggers' | 'discovery';

const TABS: Tab[] = ['attributes', 'groups', 'relations', 'constraints', 'triggers', 'discovery'];

function validTab(value: string | null): Tab | null {
  return value && (TABS as string[]).includes(value) ? (value as Tab) : null;
}

export default function ModelDetailPage() {
  const { tr } = useI18n();
  const params = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const ref = params.id ?? '';
  const { isAdmin } = usePermissions();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const treeRefresh = useModelTreeRefresh();

  const [model, setModel] = useState<CIType | null>(null);
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [groups, setGroups] = useState<AttributeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => validTab(searchParams.get('tab')) ?? 'attributes');
  const [editing, setEditing] = useState(false);
  const [binding, setBinding] = useState(false);
  const [editingAttribute, setEditingAttribute] = useState<TypeAttribute | null>(null);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (!ref) return;
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      try {
        const [gotModel, gotAttributes, gotGroups] = await Promise.all([
          getCIType(ref),
          listTypeAttributes(ref),
          listAttributeGroups(ref, true).catch(() => [] as AttributeGroup[]),
        ]);
        setModel(gotModel);
        setAttributes(gotAttributes.attributes ?? []);
        setGroups(gotGroups);
      } catch (error) {
        setErr(describeError(error, tr('无法读取模型', 'Could not load the model')));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [ref, tr],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const requested = validTab(searchParams.get('tab'));
    if (requested) setTab(requested);
  }, [searchParams]);

  const changeTab = (next: string) => {
    const value = validTab(next);
    if (!value) return;
    setTab(value);
    const params = new URLSearchParams(searchParams);
    params.set('tab', value);
    setSearchParams(params, { replace: true });
  };

  const adminTip = isAdmin ? undefined : tr('需要管理员权限', 'Administrator role required');

  const unbind = async (row: TypeAttribute) => {
    const ok = await confirmAction(
      tr(
        `从「${model?.alias || model?.name}」解绑属性「${row.alias || row.name}」？这个属性在该模型上的全部实例值会一起删除，且不能撤销。`,
        `Unbind “${row.alias || row.name}” from “${model?.alias || model?.name}”? Every instance value for it on this model is deleted, and that cannot be undone.`,
      ),
    );
    if (!ok) return;
    try {
      const got = await unbindAttributes(ref, [row.id]);
      toast.success(
        got.deleted_values
          ? tr(`已解绑，并删除了 ${got.deleted_values} 个值`, `Unbound, and deleted ${got.deleted_values} values`)
          : tr('已解绑', 'Unbound'),
      );
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('解绑失败', 'Could not unbind')));
    }
  };

  const setBindingFlag = async (row: TypeAttribute, patch: { is_required?: boolean; default_show?: boolean }) => {
    try {
      await updateBindings(ref, [{ attr_id: row.id, ...patch }]);
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('保存绑定设置失败', 'Could not change the binding')));
    }
  };

  const modelLabel = model ? model.alias || model.name : ref;

  return (
    <ModelConfigShell>
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        leading={
          <Link
            to="/cmdb/models"
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
          >
            <ChevronLeft size={12} aria-hidden="true" />
            {tr('所有模型', 'All models')}
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            <CMDBIcon value={model?.icon} size={18} label={modelLabel} />
            <span className="truncate">{modelLabel}</span>
            {model && !model.enabled && <Chip>{tr('停用', 'Disabled')}</Chip>}
            {model && !loading && attributes.length === 0 && <Chip tone="warning">{tr('无绑定属性', 'No bound attributes')}</Chip>}
          </span>
        }
        subtitle={
          model ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <code className="font-mono">{model.name}</code>
              {model.unique_key && (
                <span>
                  {tr('标识', 'Identifies by')} <code className="font-mono">{model.unique_key}</code>
                </span>
              )}
              {model.show_name && (
                <span>
                  {tr('展示', 'Shows')} <code className="font-mono">{model.show_name}</code>
                </span>
              )}
            </span>
          ) : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
              {tr('刷新', 'Refresh')}
            </Button>
            <Hint content={adminTip}>
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={() => setEditing(true)}
                disabled={!isAdmin || !model}
                className="inline-flex items-center gap-1.5 font-medium text-accent-fg"
              >
                <Pencil size={12} aria-hidden="true" />
                {tr('编辑模型', 'Edit model')}
              </Button>
            </Hint>
          </div>
        }
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        {err && (
          <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {err}
          </div>
        )}

        <Tabs value={tab} onValueChange={changeTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="attributes">
              {tr('属性', 'Attributes')}
              <span className="ml-1.5 text-[11px] text-text-faint">{attributes.length}</span>
            </TabsTrigger>
            <TabsTrigger value="groups">
              {tr('表单分组', 'Form sections')}
              <span className="ml-1.5 text-[11px] text-text-faint">{groups.filter((group) => !group.is_other).length}</span>
            </TabsTrigger>
            <TabsTrigger value="relations">{tr('模型关系', 'Relations')}</TabsTrigger>
            <TabsTrigger value="constraints">{tr('唯一约束', 'Uniqueness')}</TabsTrigger>
            <TabsTrigger value="triggers">{tr('触发器', 'Triggers')}</TabsTrigger>
            <TabsTrigger value="discovery">{tr('自动发现', 'Auto discovery')}</TabsTrigger>
          </TabsList>

          <TabsContent value="attributes">
            <AttributesTab
              rows={attributes}
              loading={loading}
              isAdmin={isAdmin}
              adminTip={adminTip}
              onBind={() => setBinding(true)}
              onEdit={setEditingAttribute}
              onUnbind={(row) => void unbind(row)}
              onFlag={setBindingFlag}
              onOpenDictionary={() => setDictionaryOpen(true)}
            />
          </TabsContent>

          <TabsContent value="groups">
            <GroupsTab ref_={ref} groups={groups} loading={loading} isAdmin={isAdmin} adminTip={adminTip} onChanged={() => void load(true)} />
          </TabsContent>

          <TabsContent value="relations">
            <RelationsTab modelRef={ref} attributes={attributes} isAdmin={isAdmin} adminTip={adminTip} />
          </TabsContent>

          <TabsContent value="constraints">
            <ConstraintsTab modelRef={ref} attributes={attributes} isAdmin={isAdmin} adminTip={adminTip} />
          </TabsContent>

          <TabsContent value="discovery" className="min-h-0 flex-1 overflow-y-auto p-6">
            <Card>
              <div className="flex flex-col gap-2 p-4">
                <h2 className="text-sm font-medium text-text">{tr('自动发现', 'Auto discovery')}</h2>
                <p className="text-xs text-text-muted">
                  {tr(
                    '规则、目标、账号和发现池都在「自动发现」与「自动发现池」页面维护。这里是模型的只读入口。',
                    'Rules, targets, accounts and the pool are maintained on the Auto discovery and Discovery pool pages. This tab is the model’s read-only entry.',
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    to="/cmdb/discovery"
                    className="inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                  >
                    {tr('打开自动发现配置', 'Open discovery configuration')}
                  </Link>
                  <Link
                    to="/cmdb/adc"
                    className="inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                  >
                    {tr('打开发现池', 'Open the discovery pool')}
                  </Link>
                </div>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="triggers">
            <TriggersTab modelRef={ref} attributes={attributes} isAdmin={isAdmin} adminTip={adminTip} />
          </TabsContent>
        </Tabs>
      </div>

      {editing && model && (
        <ModelForm
          row={model}
          models={[]}
          onClose={() => setEditing(false)}
          onSaved={async (message) => {
            setEditing(false);
            toast.success(message);
            await load(true);
            treeRefresh?.refresh();
          }}
        />
      )}

      {binding && (
        <BindModal
          modelRef={ref}
          bound={attributes}
          onClose={() => setBinding(false)}
          onBound={async (message) => {
            setBinding(false);
            toast.success(message);
            await load(true);
          }}
        />
      )}

      {editingAttribute && (
        <Modal
          open
          onClose={() => setEditingAttribute(null)}
          size="xl"
          resizable
          title={tr(`编辑属性 ${editingAttribute.name}`, `Edit attribute ${editingAttribute.name}`)}
        >
          <AttributeForm
            attribute={editingAttribute}
            onClose={() => setEditingAttribute(null)}
            onSaved={async (message) => {
              setEditingAttribute(null);
              toast.success(message);
              await load(true);
            }}
          />
        </Modal>
      )}

      <AttributeDictionary
        open={dictionaryOpen}
        onClose={() => setDictionaryOpen(false)}
        onChanged={() => void load(true)}
      />

      {dialog}
    </div>
    </ModelConfigShell>
  );
}

// --- the attribute tab ---

function AttributesTab({
  rows,
  loading,
  isAdmin,
  adminTip,
  onBind,
  onEdit,
  onUnbind,
  onFlag,
  onOpenDictionary,
}: {
  rows: TypeAttribute[];
  loading: boolean;
  isAdmin: boolean;
  adminTip?: string;
  onBind(): void;
  onEdit(row: TypeAttribute): void;
  onUnbind(row: TypeAttribute): void;
  onFlag(row: TypeAttribute, patch: { is_required?: boolean; default_show?: boolean }): void;
  onOpenDictionary(): void;
}) {
  const { tr } = useI18n();

  const columns: Column<TypeAttribute>[] = [
    {
      key: 'name',
      header: tr('属性', 'Attribute'),
      width: 'w-full',
      cell: (row) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-text">{row.alias || row.name}</span>
            {row.inherited && (
              // AN INHERITED ROW IS NOT BOUND HERE, so it cannot be unbound here.
              // Saying where it comes from is the whole reason the flag exists.
              <Chip tone="info">{tr(`继承自 ${row.inherited_from}`, `from ${row.inherited_from}`)}</Chip>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-text-faint">{row.name}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: tr('类型', 'Type'),
      cell: (row) => {
        const label = isValueTypeCode(row.value_type) ? VALUE_TYPE_LABELS[row.value_type] : null;
        return (
          <span className="flex flex-wrap items-center gap-1">
            <Chip>{label ? tr(label[0], label[1]) : row.value_type}</Chip>
            {row.is_list && <Chip>{tr('多值', 'Multi')}</Chip>}
            {row.is_password && <Chip tone="warning">{tr('密码', 'Secret')}</Chip>}
            {row.is_reference && <Chip tone="info">{tr('引用', 'Reference')}</Chip>}
          </span>
        );
      },
    },
    {
      key: 'searchable',
      header: tr('可检索', 'Searchable'),
      hideable: true,
      cell: (row) => (
        <Hint content={`${row.storage_table}`}>
          <Chip tone={row.is_indexed ? 'success' : 'default'}>{row.is_indexed ? tr('是', 'Yes') : tr('否', 'No')}</Chip>
        </Hint>
      ),
    },
    {
      key: 'required',
      header: tr('必填', 'Required'),
      cell: (row) => (
        <Checkbox
          checked={row.is_required}
          disabled={!isAdmin}
          aria-label={tr(`${row.name} 必填`, `${row.name} required`)}
          onCheckedChange={(next) => onFlag(row, { is_required: next === true })}
        />
      ),
    },
    {
      key: 'show',
      header: tr('默认显示', 'Shown by default'),
      hideable: true,
      cell: (row) => (
        <Checkbox
          checked={row.default_show}
          disabled={!isAdmin}
          aria-label={tr(`${row.name} 默认显示`, `${row.name} shown by default`)}
          onCheckedChange={(next) => onFlag(row, { default_show: next === true })}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {tr(
            '属性先存在于字典里，再绑定到模型上；同名属性可以在多个模型上使用，每个模型的绑定设置各自独立。',
            'An attribute exists in the dictionary first and is then bound to a model. One attribute can be on several models, and each binding has its own settings.',
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" type="button" onClick={onOpenDictionary} className="inline-flex items-center gap-1.5">
            {tr('属性字典', 'Attribute dictionary')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={onBind} disabled={!isAdmin} className="inline-flex items-center gap-1.5">
            <Plus size={12} aria-hidden="true" />
            {tr('绑定属性', 'Bind attributes')}
          </Button>
        </div>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={loading}
          storageKey="model-attributes"
          empty={
            tr('还没有属性', 'No attributes yet')
          }
          actions={(row) => (
            <>
              <Hint content={row.inherited ? tr('这个属性来自父模型，请到父模型上编辑', 'It comes from a parent model; edit it there') : adminTip}>
                <Button
                  variant="subtle"
                  size="sm"
                  type="button"
                  onClick={() => onEdit(row)}
                  disabled={!isAdmin || row.inherited}
                  aria-label={tr(`编辑 ${row.name}`, `Edit ${row.name}`)}
                  className="inline-flex items-center gap-1"
                >
                  <Pencil size={12} aria-hidden="true" />
                  {tr('编辑', 'Edit')}
                </Button>
              </Hint>
              <Hint content={row.inherited ? tr('这个属性来自父模型，请到父模型上解绑', 'It comes from a parent model; unbind it there') : adminTip}>
                <Button
                  variant="dangerGhost"
                  size="sm"
                  type="button"
                  onClick={() => onUnbind(row)}
                  disabled={!isAdmin || row.inherited}
                  aria-label={tr(`解绑 ${row.name}`, `Unbind ${row.name}`)}
                  className="inline-flex items-center gap-1"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  {tr('解绑', 'Unbind')}
                </Button>
              </Hint>
            </>
          )}
        />
      </Card>
    </div>
  );
}

// --- bind attributes ---

function BindModal({
  modelRef,
  bound,
  onClose,
  onBound,
}: {
  modelRef: string;
  bound: TypeAttribute[];
  onClose(): void;
  onBound(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const [dictionary, setDictionary] = useState<Attribute[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [newAttr, setNewAttr] = useState({ open: false, name: '', alias: '', type: '2' });
  const [search, setSearch] = useState('');

  useEffect(() => {
    void listAllAttributes()
      .then(setDictionary)
      .catch((error) => setErr(describeError(error, tr('无法读取属性字典', 'Could not load the attribute dictionary'))))
      .finally(() => setLoading(false));
  }, [tr]);

  const boundIDs = useMemo(() => new Set(bound.map((row) => row.id)), [bound]);
  // AN ATTRIBUTE ALREADY ON THE MODEL IS NOT OFFERED AGAIN — the backend would
  // take it as a re-bind and the operator would think they added something.
  const needle = search.trim().toLowerCase();
  const available = dictionary
    .filter((attribute) => !boundIDs.has(attribute.id))
    .filter((attribute) => !needle || attribute.name.toLowerCase().includes(needle) || attribute.alias.toLowerCase().includes(needle));

  const submit = async () => {
    if (selected.length === 0) return;
    setSubmitting(true);
    setErr(null);
    try {
      const got = await bindAttributes(modelRef, { attr_ids: selected });
      await onBound(tr(`已绑定 ${got.bound ?? selected.length} 个属性`, `Bound ${got.bound ?? selected.length} attributes`));
    } catch (error) {
      setErr(describeError(error, tr('绑定失败', 'Could not bind')));
    } finally {
      setSubmitting(false);
    }
  };

  const createInline = async () => {
    const name = newAttr.name.trim();
    if (!name) return;
    try {
      const created = await createAttribute({
        name,
        alias: newAttr.alias.trim() || name,
        value_type: newAttr.type,
        is_index: true,
      });
      setDictionary((current) => [...current, created]);
      setSelected((current) => [...current, created.id]);
      setNewAttr({ open: false, name: '', alias: '', type: '2' });
      toast.success(tr('属性已创建', 'Attribute created'));
    } catch (error) {
      setErr(describeError(error, tr('创建属性失败', 'Could not create the attribute')));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={tr('绑定属性', 'Bind attributes')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={submitting || selected.length === 0}>
            {submitting ? tr('绑定中…', 'Binding…') : tr(`绑定 ${selected.length} 个`, `Bind ${selected.length}`)}
          </Button>
        </div>
      }
    >
      {err && (
        <div role="alert" className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {err}
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label={tr('搜索属性', 'Search attributes')}
          placeholder={tr('搜索可绑定属性', 'Search available attributes')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-56"
        />
        <span className="text-xs text-text-muted">
          {tr(`${available.length} 个属性可绑定`, `${available.length} attributes available`)}
        </span>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => setNewAttr((current) => ({ ...current, open: !current.open }))}
          className="ms-auto"
        >
          {tr('新建属性', 'New attribute')}
        </Button>
      </div>

      {newAttr.open && (
        <div className="mb-2 rounded-md border border-border bg-card p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <Label htmlFor="cmdb-bind-new-name">{tr('属性名', 'Name')}</Label>
              <Input
                id="cmdb-bind-new-name"
                value={newAttr.name}
                onChange={(event) => setNewAttr((current) => ({ ...current, name: event.target.value }))}
                className="mt-1 w-full font-mono"
              />
            </div>
            <div>
              <Label htmlFor="cmdb-bind-new-alias">{tr('别名', 'Alias')}</Label>
              <Input
                id="cmdb-bind-new-alias"
                value={newAttr.alias}
                onChange={(event) => setNewAttr((current) => ({ ...current, alias: event.target.value }))}
                className="mt-1 w-full"
              />
            </div>
            <div>
              <Label htmlFor="cmdb-bind-new-type">{tr('类型', 'Type')}</Label>
              <Select
                id="cmdb-bind-new-type"
                label={tr('类型', 'Type')}
                value={newAttr.type}
                onValueChange={(next) => setNewAttr((current) => ({ ...current, type: next }))}
                options={(['2', '0', '1', '7', '4', '3', '5', '6'] as const).map((code) => ({
                  value: code,
                  label: tr(VALUE_TYPE_LABELS[code][0], VALUE_TYPE_LABELS[code][1]),
                }))}
                className="mt-1 w-full"
              />
            </div>
          </div>
          <Button variant="primary" size="sm" type="button" onClick={() => void createInline()} className="mt-2">
            {tr('创建并选中', 'Create and select')}
          </Button>
        </div>
      )}

      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {loading ? (
          <div className="py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</div>
        ) : available.length === 0 ? (
          <div className="py-6 text-center text-xs text-text-muted">
            {tr('字典里没有可绑定的属性了', 'Every dictionary attribute is already bound')}
          </div>
        ) : (
          available.map((attribute) => {
            const checked = selected.includes(attribute.id);
            const label = isValueTypeCode(attribute.value_type) ? VALUE_TYPE_LABELS[attribute.value_type] : null;
            return (
              <label
                key={attribute.id}
                className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-0 hover:bg-card"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) =>
                    setSelected((current) => (next === true ? [...current, attribute.id] : current.filter((id) => id !== attribute.id)))
                  }
                />
                <span className="min-w-0 flex-1 truncate">
                  {attribute.alias || attribute.name}
                  <code className="ml-2 font-mono text-[11px] text-text-faint">{attribute.name}</code>
                </span>
                <Chip>{label ? tr(label[0], label[1]) : attribute.value_type}</Chip>
              </label>
            );
          })
        )}
      </div>
    </Modal>
  );
}

// --- form sections ---

function GroupsTab({
  ref_,
  groups,
  loading,
  isAdmin,
  adminTip,
  onChanged,
}: {
  ref_: string;
  groups: AttributeGroup[];
  loading: boolean;
  isAdmin: boolean;
  adminTip?: string;
  onChanged(): void;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction } = useDialogs();
  const [editing, setEditing] = useState<AttributeGroup | null>(null);
  const [creating, setCreating] = useState(false);

  const own = groups.filter((group) => !group.is_other);
  const other = groups.find((group) => group.is_other);

  const remove = async (group: AttributeGroup) => {
    const ok = await confirmAction(
      tr(`删除分组「${group.name}」？组内属性仍然绑定在模型上，只是不再分组。`, `Delete the section “${group.name}”? Its attributes stay bound; they just stop being grouped.`),
    );
    if (!ok) return;
    try {
      await deleteAttributeGroup(ref_, group.id);
      toast.success(tr('已删除', 'Deleted'));
      onChanged();
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const move = async (group: AttributeGroup, direction: -1 | 1) => {
    const index = own.findIndex((item) => item.id === group.id);
    const target = own[index + direction];
    if (!target) return;
    try {
      await swapAttributeGroups(ref_, { from_group_id: group.id, to_group_id: target.id });
      onChanged();
    } catch (error) {
      toast.error(describeError(error, tr('调整顺序失败', 'Could not reorder')));
    }
  };

  if (loading) {
    return <div className="flex h-32 items-center justify-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {tr(
            '分组决定实例表单里字段的分段；不属于任何分组的属性落在最后的“其他”里。',
            'Sections decide how an instance form is divided. Attributes in no section land in the trailing “Other”.',
          )}
        </p>
        <Button variant="primary" size="sm" type="button" onClick={() => setCreating(true)} disabled={!isAdmin} className="inline-flex items-center gap-1.5">
          <Plus size={12} aria-hidden="true" />
          {tr('新建分组', 'New section')}
        </Button>
      </div>

      {own.length === 0 && (
        <Card>
          <p className="py-6 text-center text-xs text-text-muted">
            {tr('还没有分组，实例表单会按绑定顺序平铺显示字段。', 'No sections yet; the instance form lists fields in binding order.')}
          </p>
        </Card>
      )}

      {own.map((group, index) => (
        <Card key={group.id}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-text">{group.name}</span>
              {group.inherited && <Chip tone="info">{tr('继承', 'Inherited')}</Chip>}
              <Chip>{tr(`${group.attributes.length} 个字段`, `${group.attributes.length} fields`)}</Chip>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="subtle" size="sm" type="button" onClick={() => void move(group, -1)} disabled={!isAdmin || index === 0} aria-label={tr('上移', 'Move up')}>
                ↑
              </Button>
              <Button
                variant="subtle"
                size="sm"
                type="button"
                onClick={() => void move(group, 1)}
                disabled={!isAdmin || index === own.length - 1}
                aria-label={tr('下移', 'Move down')}
              >
                ↓
              </Button>
              <Hint content={adminTip}>
                <Button variant="subtle" size="sm" type="button" onClick={() => setEditing(group)} disabled={!isAdmin} aria-label={tr(`编辑 ${group.name}`, `Edit ${group.name}`)}>
                  {tr('编辑', 'Edit')}
                </Button>
              </Hint>
              <Hint content={adminTip}>
                <Button
                  variant="dangerGhost"
                  size="sm"
                  type="button"
                  onClick={() => void remove(group)}
                  disabled={!isAdmin}
                  aria-label={tr(`删除 ${group.name}`, `Delete ${group.name}`)}
                >
                  {tr('删除', 'Delete')}
                </Button>
              </Hint>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.attributes.length === 0 ? (
              <span className="text-[11px] text-text-faint">{tr('这个分组是空的', 'This section is empty')}</span>
            ) : (
              group.attributes.map((attribute) => (
                <Chip key={attribute.id}>{attribute.alias || attribute.name}</Chip>
              ))
            )}
          </div>
        </Card>
      ))}

      {other && other.attributes.length > 0 && (
        <Card>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-text">{tr('其他', 'Other')}</span>
            <Chip>{tr(`${other.attributes.length} 个字段`, `${other.attributes.length} fields`)}</Chip>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {other.attributes.map((attribute) => (
              <Chip key={attribute.id}>{attribute.alias || attribute.name}</Chip>
            ))}
          </div>
        </Card>
      )}

      {(creating || editing) && (
        <GroupModal
          modelRef={ref_}
          group={editing}
          attributes={groups.flatMap((group) => group.attributes)}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(message) => {
            toast.success(message);
            setCreating(false);
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function GroupModal({
  modelRef,
  group,
  attributes,
  onClose,
  onSaved,
}: {
  modelRef: string;
  group: AttributeGroup | null;
  attributes: TypeAttribute[];
  onClose(): void;
  onSaved(message: string): void;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState(group?.name ?? '');
  const [selected, setSelected] = useState<number[]>(group?.attributes.map((attribute) => attribute.id) ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // De-duplicated: an attribute appears once in `attributes` even when a parent
  // model groups it too.
  const selectable = useMemo(() => {
    const seen = new Map<number, TypeAttribute>();
    attributes.forEach((attribute) => seen.set(attribute.id, attribute));
    return [...seen.values()];
  }, [attributes]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr(tr('分组名不能为空', 'A section needs a name'));
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      if (group) await updateAttributeGroup(modelRef, group.id, { name: trimmed, attr_ids: selected });
      else await saveAttributeGroup(modelRef, { name: trimmed, attr_ids: selected });
      onSaved(group ? tr('已保存', 'Saved') : tr('已创建', 'Created'));
    } catch (error) {
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={group ? tr('编辑分组', 'Edit section') : tr('新建分组', 'New section')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={submitting}>
            {submitting ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      {err && (
        <div role="alert" className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {err}
        </div>
      )}
      <Label htmlFor="cmdb-group-name">{tr('分组名', 'Section name')}</Label>
      <Input id="cmdb-group-name" value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full" />

      <p className="mb-1 mt-3 text-xs text-text-muted">{tr('包含哪些字段', 'Which fields it contains')}</p>
      <div className="max-h-64 overflow-y-auto rounded-md border border-border">
        {selectable.map((attribute) => (
          <label key={attribute.id} className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-0 hover:bg-card">
            <Checkbox
              checked={selected.includes(attribute.id)}
              onCheckedChange={(next) =>
                setSelected((current) => (next === true ? [...current, attribute.id] : current.filter((id) => id !== attribute.id)))
              }
            />
            <span className="min-w-0 flex-1 truncate">{attribute.alias || attribute.name}</span>
            <code className="font-mono text-[11px] text-text-faint">{attribute.name}</code>
          </label>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-text-faint">
        {tr(
          '一个属性可以同时属于多个分组；顺序按勾选顺序保存。',
          'An attribute may belong to several sections; the order is the order you select.',
        )}
      </p>
    </Modal>
  );
}
