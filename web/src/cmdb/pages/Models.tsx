import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Boxes,
  Folder,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Table2,
  Trash2,
} from 'lucide-react';

import { Button, EmptyState } from '@/components/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Chip } from '@/components/ui/Chip';
import { Checkbox } from '@/components/ui/Checkbox';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';
import { cn } from '@/lib/cn';

import { describeError } from '../api/http';
import {
  createAttribute,
  createCIType,
  deleteCIType,
  ensureBuiltinModels,
  listAllAttributes,
  listCITypes,
  listTypeAttributes,
  setCITypeEnabled,
  updateCIType,
  type Attribute,
  type CIType,
  type CITypeInput,
  type TypeAttribute,
} from '../api/citype';
import { listModelGroups, type ModelGroup } from '../api/preferences';
import { CMDBIcon } from '../components/CMDBIcon';
import { DataTable, type Column } from '../components/DataTable';
import { IconPicker } from '../components/IconPicker';
import { ModelConfigShell } from '../components/ModelConfigShell';
import { useModelTreeRefresh } from '../components/model-tree-context';
import { useToast } from '../components/Toast';
import { groupModels } from '../lib/model-groups';
import { VALUE_TYPE_LABELS, isValueTypeCode } from '../lib/valuetype';

// 模型配置 — the model list.
//
// THE MODELS ARE THE SCHEMA. Every other CMDB page is "some model's instances",
// so this is where an operator creates the vocabulary the rest of the product
// speaks. It is also the page that makes two constraints visible that are easy
// to hit and hard to guess:
//
//   - A MODEL'S IDENTIFYING ATTRIBUTE MUST ALREADY EXIST. The backend refuses a
//     create whose `unique_key` names no attribute, so the form can create that
//     attribute inline — otherwise a fresh deployment has a deadlock: no model
//     means no place to add an attribute, and no attribute means no model.
//   - DELETING A MODEL CASCADES. Its attributes' bindings, relations, groups,
//     subscriptions and stored values go with it, which is why the confirmation
//     names the model and says so.
//
// THE LIST IS A SCHEMA INDEX, NOT A RESOURCE LIST. The table is the exact view
// for comparing keys and inheritance; the cards are the readable view for
// scanning what each model is. Both edit the same rows and keep the same
// administrator gates.

type View = 'table' | 'grid';

export default function ModelsPage() {
  const { tr } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const treeRefresh = useModelTreeRefresh();
  const { isAdmin } = usePermissions();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();

  const [models, setModels] = useState<CIType[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [groupsErr, setGroupsErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const [view, setView] = useState<View>(() =>
    window.matchMedia?.('(max-width: 1279px)')?.matches ? 'grid' : 'table',
  );
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; row: CIType } | null>(null);

  // GROUPS ARE A SEPARATE SNAPSHOT. A group failure must not blank the model
  // list, so it has its own error and keeps the last successful groups. On the
  // first failure `groups` stays empty and the page simply remains flat.
  const loadGroups = useCallback(async () => {
    try {
      setGroups(await listModelGroups());
      setGroupsErr(null);
    } catch (error) {
      setGroupsErr(describeError(error, tr('无法读取模型分组', 'Could not load the model groups')));
    }
  }, [tr]);

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      void loadGroups();
      try {
        setModels(await listCITypes());
      } catch (error) {
        setErr(describeError(error, tr('无法读取模型', 'Could not load models')));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [tr, loadGroups],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setEditing({ mode: 'create' });
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const byId = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);

  // THE FILTER IS CLIENT-SIDE because the list is the schema: a deployment has
  // tens of models, the endpoint returns all of them, and a request per keystroke
  // would be slower than the filter it replaces.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models
      .filter((model) => (onlyEnabled ? model.enabled : true))
      .filter((model) => {
        if (!needle) return true;
        return model.name.toLowerCase().includes(needle) || model.alias.toLowerCase().includes(needle);
      })
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }, [models, query, onlyEnabled]);

  const sections = useMemo(
    () =>
      groupModels(visible, groups, {
        other: tr('其他', 'Other'),
        all: tr('全部模型', 'All models'),
        unnamed: tr('未命名分组', 'Untitled group'),
      }),
    [visible, groups, tr],
  );
  const groupedView = grouped && groups.length > 0 && sections.length > 0;
  const modelCountLabel = (count: number) =>
    count === 1 ? tr('1 个模型', '1 model') : tr(`${count} 个模型`, `${count} models`);

  const adminTip = isAdmin ? undefined : tr('需要管理员权限', 'Administrator role required');

  const toggleEnabled = async (row: CIType) => {
    try {
      await setCITypeEnabled(row.id, !row.enabled);
      toast.success(row.enabled ? tr('已停用', 'Disabled') : tr('已启用', 'Enabled'));
      await load(true);
      treeRefresh?.refresh();
    } catch (error) {
      toast.error(describeError(error, tr('操作失败', 'Could not change it')));
    }
  };

  const handleDelete = async (row: CIType) => {
    const ok = await confirmAction(
      tr(
        `删除模型「${row.alias || row.name}」？它的属性绑定、关系、表单分组、订阅以及已存的值都会一起删除，且不能撤销。`,
        `Delete “${row.alias || row.name}”? Its attribute bindings, relations, form sections, subscriptions and stored values go with it. This cannot be undone.`,
      ),
    );
    if (!ok) return;
    try {
      await deleteCIType(row.id);
      toast.success(tr('已删除', 'Deleted'));
      await load(true);
      treeRefresh?.refresh();
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const bootstrap = async () => {
    try {
      const got = await ensureBuiltinModels();
      const created = got.created?.length ?? 0;
      toast.success(
        created > 0
          ? tr(`已创建 ${created} 个内建模型`, `Created ${created} built-in models`)
          : tr('内建模型都已存在', 'Every built-in model already exists'),
      );
      await load(true);
      treeRefresh?.refresh();
    } catch (error) {
      toast.error(describeError(error, tr('创建失败', 'Could not create them')));
    }
  };

  const enabledCount = models.filter((model) => model.enabled).length;
  const disabledCount = models.length - enabledCount;
  const inheritingCount = models.filter((model) => model.parent_ids.length > 0).length;
  const filtering = query.trim().length > 0 || onlyEnabled;
  const clearFilters = () => {
    setQuery('');
    setOnlyEnabled(false);
  };

  const parentNames = (row: CIType): string[] =>
    row.parent_ids.map((id) => byId.get(id)?.alias || byId.get(id)?.name || `#${id}`);

  const columns: Column<CIType>[] = [
    {
      key: 'name',
      header: tr('模型', 'Model'),
      width: 'min-w-44',
      sortable: true,
      sortValue: (row) => row.alias || row.name,
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-2">
          <CMDBIcon value={row.icon} size={16} label={row.alias || row.name} />
          <div className="min-w-0">
            <Link
              to={`/cmdb/models/${row.id}`}
              className="block truncate font-medium text-text hover:text-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
            >
              {row.alias || row.name}
            </Link>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-[11px] text-text-faint" title={row.name}>
                {row.name}
              </span>
              <Chip tone={row.enabled ? 'success' : 'default'} dense>
                {row.enabled ? tr('启用', 'Enabled') : tr('停用', 'Disabled')}
              </Chip>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'unique',
      header: tr('标识属性', 'Identifying attribute'),
      hideable: true,
      cell: (row) =>
        row.unique_key ? (
          <code className="font-mono text-[11px] text-text-muted">{row.unique_key}</code>
        ) : (
          <span className="text-text-faint">—</span>
        ),
    },
    {
      key: 'parents',
      header: tr('继承自', 'Inherits from'),
      hideable: true,
      cell: (row) => {
        if (row.parent_ids.length === 0) return <span className="text-text-faint">—</span>;
        return (
          <span className="flex flex-wrap gap-1">
            {row.parent_ids.map((id) => (
              <Chip key={id}>{byId.get(id)?.alias || byId.get(id)?.name || `#${id}`}</Chip>
            ))}
          </span>
        );
      },
    },
    {
      key: 'show',
      header: tr('展示属性', 'Display attribute'),
      hideable: true,
      defaultHidden: true,
      cell: (row) =>
        row.show_name ? (
          <code className="font-mono text-[11px] text-text-muted">{row.show_name}</code>
        ) : (
          <span className="text-text-faint">—</span>
        ),
    },
  ];

  const renderCard = (row: CIType) => (
    <ModelCard
      key={row.id}
      row={row}
      parentNames={parentNames(row)}
      isAdmin={isAdmin}
      adminTip={adminTip}
      onEdit={() => setEditing({ mode: 'edit', row })}
      onToggle={() => void toggleEnabled(row)}
      onDelete={() => void handleDelete(row)}
    />
  );

  return (
    <ModelConfigShell>
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <PageHeader
          title={
            <span className="flex min-w-0 items-center gap-2">
              <Boxes size={18} className="shrink-0 text-sky-500" aria-hidden="true" />
              <span className="truncate">{tr('模型配置', 'Model configuration')}</span>
            </span>
          }
          subtitle={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1">
                <span>{tr('模型', 'Models')}</span>
                <span className="font-mono font-medium text-text">{models.length}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span>{tr('启用', 'Enabled')}</span>
                <span className="font-mono font-medium text-text">{enabledCount}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span>{tr('停用', 'Disabled')}</span>
                <span className="font-mono font-medium text-text">{disabledCount}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span>{tr('含继承', 'Inheritance')}</span>
                <span className="font-mono font-medium text-text">{inheritingCount}</span>
              </span>
            </span>
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
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => void bootstrap()}
                  disabled={!isAdmin}
                  className="inline-flex items-center gap-1.5"
                >
                  <Boxes size={12} aria-hidden="true" />
                  {tr('内建模型', 'Built-in models')}
                </Button>
              </Hint>
              <Hint content={adminTip}>
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  onClick={() => setEditing({ mode: 'create' })}
                  disabled={!isAdmin}
                  className="inline-flex items-center gap-1.5 font-medium"
                >
                  <Plus size={12} aria-hidden="true" />
                  {tr('新建模型', 'New model')}
                </Button>
              </Hint>
            </div>
          }
        />

        <div className="cmdb-liquid relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
          <div className="cmdb-liquid-blobs" aria-hidden="true">
            <span className="cmdb-liquid-blob cmdb-liquid-blob-a" />
            <span className="cmdb-liquid-blob cmdb-liquid-blob-b" />
            <span className="cmdb-liquid-blob cmdb-liquid-blob-c" />
          </div>

          <div className="cmdb-liquid-content relative min-h-0 flex-1 overflow-y-auto p-6">
            <div className="flex flex-col gap-4">
              <div className="cmdb-liquid-panel rounded-2xl p-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    aria-pressed={!onlyEnabled}
                    onClick={() => setOnlyEnabled(false)}
                    className={cn('cmdb-liquid-pill', !onlyEnabled && 'is-active')}
                  >
                    {tr('全部模型', 'All models')}
                  </Button>
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    aria-pressed={onlyEnabled}
                    onClick={() => setOnlyEnabled(true)}
                    className={cn('cmdb-liquid-pill', onlyEnabled && 'is-active')}
                  >
                    {tr('只看启用', 'Enabled only')}
                  </Button>
                  {groupedView && (
                    <span className="text-[11px] text-text-faint">
                      {tr(`${sections.length} 组`, `${sections.length} groups`)}
                    </span>
                  )}
                  {filtering && (
                    <>
                      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                      <span className="text-[11px] text-text-faint">
                        {tr(`显示 ${visible.length} / ${models.length}`, `Showing ${visible.length} of ${models.length}`)}
                      </span>
                      <Button
                        variant="plain"
                        size="sm"
                        type="button"
                        onClick={clearFilters}
                        className="cmdb-liquid-plain-action text-[11px]"
                      >
                        {tr('清除筛选', 'Clear filters')}
                      </Button>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-full sm:w-64">
                    <Search
                      size={13}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                      aria-hidden="true"
                    />
                    <Input
                      type="search"
                      aria-label={tr('搜索模型列表', 'Search model list')}
                      placeholder={tr('按名称或别名搜索', 'Search by name or alias')}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="w-full pl-7 text-xs"
                    />
                  </div>
                  {groups.length > 0 && (
                    <label className="cmdb-liquid-filter inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-text-muted">
                      <Checkbox
                        checked={grouped}
                        onCheckedChange={(next) => setGrouped(next === true)}
                        aria-label={tr('按分组显示', 'Group by model group')}
                      />
                      {tr('按分组显示', 'Group by model group')}
                    </label>
                  )}
                  <div className="cmdb-liquid-segment flex shrink-0 items-center gap-1 p-1">
                    <Button
                      variant="plain"
                      size="sm"
                      type="button"
                      aria-pressed={view === 'table'}
                      onClick={() => setView('table')}
                      className={cn('cmdb-liquid-segment-button inline-flex items-center gap-1.5', view === 'table' && 'is-active')}
                    >
                      <Table2 size={12} aria-hidden="true" />
                      {tr('列表', 'List')}
                    </Button>
                    <Button
                      variant="plain"
                      size="sm"
                      type="button"
                      aria-pressed={view === 'grid'}
                      onClick={() => setView('grid')}
                      className={cn('cmdb-liquid-segment-button inline-flex items-center gap-1.5', view === 'grid' && 'is-active')}
                    >
                      <LayoutGrid size={12} aria-hidden="true" />
                      {tr('网格', 'Grid')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {groupsErr && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
              >
                <span className="min-w-0 flex-1 break-words">
                  <span className="font-medium">{tr('无法读取模型分组', 'Could not load the model groups')}</span>
                  <span className="ms-2">{groupsErr}</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => void loadGroups()}
                  className="cmdb-liquid-secondary inline-flex items-center gap-1.5"
                >
                  <RefreshCw size={12} aria-hidden="true" />
                  {tr('重试分组', 'Retry groups')}
                </Button>
              </div>
            )}

            <div className="cmdb-liquid-panel overflow-hidden rounded-2xl">
              {view === 'table' ? (
                <div className="p-3">
                  <DataTable
                    columns={columns}
                    rows={visible}
                    groups={
                      groupedView
                        ? sections.map((section) => ({
                            key: section.key,
                            header: (
                              <span className="flex min-w-0 items-center gap-2">
                                <Folder size={14} className="shrink-0 text-indigo-400" aria-hidden="true" />
                                <span className="min-w-0 truncate text-xs font-semibold text-text" title={section.name}>
                                  {section.name}
                                </span>
                                <Chip tone="accent" dense>
                                  {modelCountLabel(section.rows.length)}
                                </Chip>
                              </span>
                            ),
                            rows: section.rows,
                          }))
                        : undefined
                    }
                    rowKey={(row) => row.id}
                    loading={loading}
                    error={err}
                    onRetry={() => void load()}
                    storageKey="models"
                    empty={
                      models.length === 0
                        ? tr('还没有模型。可以先创建内建模型，或新建一个。', 'No models yet. Create the built-in ones, or make your own.')
                        : tr('没有匹配的模型', 'No model matches that')
                    }
                    actions={(row) => (
                      <>
                        {/* THREE LABELLED BUTTONS DO NOT FIT A PHONE. Because the
                            action column is pinned, a wide action cell covers the
                            model name instead of pushing the table wider. Below
                            `sm`, the same actions move into one menu trigger. */}
                        <div className="hidden items-center gap-2 sm:flex">
                          <ActionLinks
                            row={row}
                            isAdmin={isAdmin}
                            adminTip={adminTip}
                            onEdit={() => setEditing({ mode: 'edit', row })}
                            onToggle={() => void toggleEnabled(row)}
                            onDelete={() => void handleDelete(row)}
                          />
                        </div>
                        <MobileActions
                          row={row}
                          isAdmin={isAdmin}
                          onEdit={() => setEditing({ mode: 'edit', row })}
                          onToggle={() => void toggleEnabled(row)}
                          onDelete={() => void handleDelete(row)}
                        />
                      </>
                    )}
                  />
                </div>
              ) : (
                <div className="flex flex-col">
                  {err && (
                    <div
                      role="alert"
                      className="m-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300"
                    >
                      <span className="min-w-0 flex-1 break-words">{err}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => void load()}
                        className="cmdb-liquid-secondary"
                      >
                        {tr('重试', 'Retry')}
                      </Button>
                    </div>
                  )}
                  {loading && models.length === 0 ? (
                    <div className="flex h-40 items-center justify-center text-xs text-text-muted">
                      {tr('加载中…', 'Loading…')}
                    </div>
                  ) : err && models.length === 0 ? null : visible.length === 0 ? (
                    <EmptyState
                      className="flex min-h-52 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
                      title={models.length === 0 ? tr('还没有模型', 'No models yet') : tr('没有匹配的模型', 'No model matches that')}
                      hint={
                        models.length === 0
                          ? tr('先创建内建模型，或新建一个属于自己的模型。', 'Create the built-in models, or add your own.')
                          : tr('换一个关键词，或清除筛选条件。', 'Try another term, or clear the filters.')
                      }
                      action={
                        models.length === 0 ? (
                          isAdmin ? (
                            <Button
                              variant="primary"
                              size="sm"
                              type="button"
                              onClick={() => setEditing({ mode: 'create' })}
                              className="inline-flex items-center gap-1.5"
                            >
                              <Plus size={12} aria-hidden="true" />
                              {tr('新建模型', 'New model')}
                            </Button>
                          ) : undefined
                        ) : (
                          <Button variant="ghost" size="sm" type="button" onClick={clearFilters} className="cmdb-liquid-secondary">
                            {tr('清除筛选', 'Clear filters')}
                          </Button>
                        )
                      }
                    />
                  ) : groupedView ? (
                    <div className="flex flex-col">
                      {sections.map((section) => {
                        const headingID = `cmdb-model-group-${section.key}`;
                        return (
                          <section
                            key={section.key}
                            aria-labelledby={headingID}
                            className="border-b border-border/40 last:border-b-0"
                          >
                            <div className="cmdb-liquid-group-header flex min-w-0 items-center gap-2 px-4 py-3">
                              <Folder size={14} className="shrink-0 text-indigo-400" aria-hidden="true" />
                              <h2
                                id={headingID}
                                className="min-w-0 truncate text-sm font-bold text-text"
                                title={section.name}
                              >
                                {section.name}
                              </h2>
                              <Chip tone="accent" dense>
                                {modelCountLabel(section.rows.length)}
                              </Chip>
                            </div>
                            <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                              {section.rows.map(renderCard)}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                      {visible.map(renderCard)}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

        {editing && (
          <ModelForm
            row={editing.mode === 'edit' ? editing.row : null}
            models={models}
            onClose={() => setEditing(null)}
            onSaved={async (message, id) => {
              setEditing(null);
              toast.success(message);
              await load(true);
              treeRefresh?.refresh();
              if (editing?.mode === 'create' && typeof id === 'number') {
                navigate(`/cmdb/models/${id}`);
              }
              return id;
            }}
          />
        )}

        {dialog}
      </div>
    </ModelConfigShell>
  );
}

function ActionLinks({
  row,
  isAdmin,
  adminTip,
  onEdit,
  onToggle,
  onDelete,
}: {
  row: CIType;
  isAdmin: boolean;
  adminTip?: string;
  onEdit(): void;
  onToggle(): void;
  onDelete(): void;
}) {
  const { tr } = useI18n();
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <Hint content={adminTip}>
        <Button
          variant="link"
          size="sm"
          type="button"
          onClick={onEdit}
          disabled={!isAdmin}
          aria-label={tr(`编辑 ${row.name}`, `Edit ${row.name}`)}
          className="cmdb-liquid-action-edit inline-flex items-center gap-1"
        >
          <Pencil size={12} aria-hidden="true" />
          {tr('编辑', 'Edit')}
        </Button>
      </Hint>
      <Hint content={adminTip}>
        <Button
          variant="link"
          size="sm"
          type="button"
          onClick={onToggle}
          disabled={!isAdmin}
          aria-label={row.enabled ? tr(`停用 ${row.name}`, `Disable ${row.name}`) : tr(`启用 ${row.name}`, `Enable ${row.name}`)}
          className="cmdb-liquid-plain-action inline-flex items-center gap-1"
        >
          <Power size={12} aria-hidden="true" />
          {row.enabled ? tr('停用', 'Disable') : tr('启用', 'Enable')}
        </Button>
      </Hint>
      <Hint content={adminTip}>
        <Button
          variant="link"
          size="sm"
          type="button"
          onClick={onDelete}
          disabled={!isAdmin}
          aria-label={tr(`删除 ${row.name}`, `Delete ${row.name}`)}
          className="cmdb-liquid-action-danger inline-flex items-center gap-1"
        >
          <Trash2 size={12} aria-hidden="true" />
          {tr('删除', 'Delete')}
        </Button>
      </Hint>
    </span>
  );
}

function MobileActions({
  row,
  isAdmin,
  onEdit,
  onToggle,
  onDelete,
}: {
  row: CIType;
  isAdmin: boolean;
  onEdit(): void;
  onToggle(): void;
  onDelete(): void;
}) {
  const { tr } = useI18n();
  return (
    <div className="sm:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="subtle"
              size="sm"
              type="button"
              disabled={!isAdmin}
              aria-label={tr('更多操作', 'More actions')}
            />
          }
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40 p-1">
          <DropdownMenuItem disabled={!isAdmin} onClick={onEdit} className="gap-2">
            <Pencil size={12} aria-hidden="true" />
            {tr('编辑', 'Edit')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!isAdmin} onClick={onToggle} className="gap-2">
            {row.enabled ? tr('停用', 'Disable') : tr('启用', 'Enable')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!isAdmin} onClick={onDelete} className="gap-2 text-red-300">
            <Trash2 size={12} aria-hidden="true" />
            {tr('删除', 'Delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ModelCard({
  row,
  parentNames,
  isAdmin,
  adminTip,
  onEdit,
  onToggle,
  onDelete,
}: {
  row: CIType;
  parentNames: string[];
  isAdmin: boolean;
  adminTip?: string;
  onEdit(): void;
  onToggle(): void;
  onDelete(): void;
}) {
  const { tr } = useI18n();
  const label = row.alias || row.name;

  return (
    <article className="cmdb-liquid-card flex min-w-0 flex-col rounded-2xl p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-500 text-white shadow-md shadow-sky-500/20">
          <CMDBIcon value={row.icon} size={18} label={label} />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={`/cmdb/models/${row.id}`}
            aria-label={label}
            className="block min-w-0 truncate rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          >
            <h3 className="truncate text-sm font-bold text-text" title={label}>
              {label}
            </h3>
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <code className="cmdb-liquid-key">{row.name}</code>
            <Chip tone={row.enabled ? 'success' : 'default'} dense>
              {row.enabled ? tr('启用', 'Enabled') : tr('停用', 'Disabled')}
            </Chip>
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2">
        <div className="min-w-0">
          <dt className="text-[10px] text-text-faint">{tr('标识属性', 'Identifying attribute')}</dt>
          <dd className="mt-0.5 truncate font-mono text-[11px] text-text-muted" title={row.unique_key || '—'}>
            {row.unique_key || '—'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] text-text-faint">{tr('展示属性', 'Display attribute')}</dt>
          <dd className="mt-0.5 truncate font-mono text-[11px] text-text-muted" title={row.show_name || '—'}>
            {row.show_name || '—'}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-text-faint">{tr('继承自', 'Inherits from')}</span>
        {parentNames.length > 0 ? (
          parentNames.map((name, index) => (
            <Chip key={`${name}-${index}`} dense>
              {name}
            </Chip>
          ))
        ) : (
          <span className="text-[11px] text-text-faint">—</span>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
        <span className="font-mono text-[10px] text-text-faint">#{row.id}</span>
        <ActionLinks
          row={row}
          isAdmin={isAdmin}
          adminTip={adminTip}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      </div>
    </article>
  );
}

// --- the form ---

export function ModelForm({
  row,
  models,
  onClose,
  onSaved,
}: {
  row: CIType | null;
  models: CIType[];
  onClose(): void;
  onSaved(message: string, id: number): Promise<number | void>;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const creating = row === null;

  const [name, setName] = useState(row?.name ?? '');
  const [alias, setAlias] = useState(row?.alias ?? '');
  const [icon, setIcon] = useState(row?.icon ?? '');
  const [order, setOrder] = useState(String(row?.order ?? 0));
  const [parentIDs, setParentIDs] = useState<number[]>(row?.parent_ids ?? []);
  const [parentQuery, setParentQuery] = useState('');
  const [defaultOrderAttr, setDefaultOrderAttr] = useState((row?.default_order_attr ?? '').replace(/^-/, ''));
  const [defaultOrderAsc, setDefaultOrderAsc] = useState<'asc' | 'desc'>(
    (row?.default_order_attr ?? '').startsWith('-') ? 'desc' : 'asc',
  );
  const [showKey, setShowKey] = useState(row?.show_name ?? '');
  const [uniqueKey, setUniqueKey] = useState(row?.unique_key ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The dictionary, for the unique-key picker.
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [attributesErr, setAttributesErr] = useState<string | null>(null);
  const [allModels, setAllModels] = useState<CIType[]>([]);
  // The model's own attributes, for the default-sort picker (edit only).
  const [ownAttributes, setOwnAttributes] = useState<TypeAttribute[]>([]);

  useEffect(() => {
    void listAllAttributes()
      .then(setAttributes)
      .catch((error) => setAttributesErr(describeError(error, tr('无法读取属性字典', 'Could not load the attribute dictionary'))));
  }, [tr]);

  useEffect(() => {
    if (!row) return;
    void listTypeAttributes(row.id)
      .then((got) => setOwnAttributes(got.attributes ?? []))
      .catch(() => setOwnAttributes([]));
  }, [row]);

  useEffect(() => {
    if (models.length > 0) return;
    void listCITypes()
      .then(setAllModels)
      .catch(() => setAllModels([]));
  }, [models]);

  // Inline creation of the identifying attribute: a fresh deployment has no
  // attributes at all, and the backend refuses a model whose unique_key names
  // none — so without this the page is unusable the first time it is opened.
  const [newAttr, setNewAttr] = useState<{ open: boolean; name: string; alias: string; type: string }>({
    open: false,
    name: '',
    alias: '',
    type: '2',
  });

  const attributeOptions = attributes.map((attribute) => ({
    value: attribute.name,
    label: `${attribute.name}（${attribute.alias}）`,
  }));
  const availableModels = models.length > 0 ? models : allModels;
  const parentOptions = availableModels.filter((model) => model.id !== row?.id);
  const parentNeedle = parentQuery.trim().toLowerCase();
  const visibleParentOptions = parentOptions.filter(
    (model) =>
      parentIDs.includes(model.id) ||
      !parentNeedle ||
      model.name.toLowerCase().includes(parentNeedle) ||
      model.alias.toLowerCase().includes(parentNeedle),
  );
  const showOptions = [
    { value: '', label: tr('（默认使用标识属性）', '(use the identifying attribute)') },
    ...(row
      ? ownAttributes.map((attribute) => ({
          value: attribute.name,
          label: `${attribute.alias || attribute.name}（${attribute.name}）`,
        }))
      : attributes
          .filter((attribute) => attribute.name === uniqueKey)
          .map((attribute) => ({
            value: attribute.name,
            label: `${attribute.alias || attribute.name}（${attribute.name}）`,
          }))),
  ];
  const sortOptions = [
    { value: '', label: tr('（不指定）', '(none)') },
    ...(row
      ? ownAttributes.map((attribute) => ({
          value: attribute.name,
          label: `${attribute.alias || attribute.name}（${attribute.name}）`,
        }))
      : attributes
          .filter((attribute) => attribute.name === uniqueKey)
          .map((attribute) => ({
            value: attribute.name,
            label: `${attribute.alias || attribute.name}（${attribute.name}）`,
          }))),
  ];

  const createAttributeInline = async () => {
    const attrName = newAttr.name.trim();
    if (!attrName) return;
    try {
      const created = await createAttribute({
        name: attrName,
        alias: newAttr.alias.trim() || attrName,
        value_type: newAttr.type,
        is_index: true,
      });
      setAttributes((current) => [...current, created]);
      setUniqueKey(created.name);
      setNewAttr({ open: false, name: '', alias: '', type: '2' });
      toast.success(tr('属性已创建', 'Attribute created'));
    } catch (error) {
      setErr(describeError(error, tr('创建属性失败', 'Could not create the attribute')));
    }
  };

  const submit = async () => {
    const trimmedName = name.trim();
    const trimmedAlias = alias.trim();
    if (!trimmedName) return setErr(tr('名称不能为空', 'A name is required'));
    if (!trimmedAlias) return setErr(tr('别名不能为空', 'An alias is required'));
    if (creating && !uniqueKey.trim()) {
      return setErr(tr('必须选一个标识属性：没有它，实例无法被判重', 'Pick an identifying attribute: without one, instances cannot be deduplicated'));
    }

    setSubmitting(true);
    setErr(null);
    try {
      if (creating) {
        const input: CITypeInput = {
          name: trimmedName,
          alias: trimmedAlias,
          unique_key: uniqueKey.trim(),
          show_key: showKey.trim() || undefined,
          icon: icon || undefined,
          order: Number(order) || 0,
          default_order_attr: defaultOrderAttr
            ? (defaultOrderAsc === 'desc' ? `-${defaultOrderAttr}` : defaultOrderAttr)
            : undefined,
          parent_ids: parentIDs,
        };
        const created = await createCIType(input);
        await onSaved(tr('已创建', 'Created'), created.id);
      } else {
        const updated = await updateCIType(row.id, {
          name: trimmedName,
          alias: trimmedAlias,
          show_key: showKey.trim(),
          icon,
          order: Number(order) || 0,
          default_order_attr: defaultOrderAttr
            ? (defaultOrderAsc === 'desc' ? `-${defaultOrderAttr}` : defaultOrderAttr)
            : '',
          parent_ids: parentIDs,
        });
        await onSaved(tr('已保存', 'Saved'), updated.id);
      }
    } catch (error) {
      // THE INPUT SURVIVES A FAILURE so a retry does not retype the form.
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSubmitting(false);
    }
  };

  const nameId = 'cmdb-model-name';
  const aliasId = 'cmdb-model-alias';
  const orderId = 'cmdb-model-order';
  const uniqueId = 'cmdb-model-unique';

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={creating ? tr('新建模型', 'New model') : tr('编辑模型', 'Edit model')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="submit" form="cmdb-model-form" disabled={submitting}>
            {submitting ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      <form
        id="cmdb-model-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        {err && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {err}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={nameId}>{tr('名称（唯一标识）', 'Name (unique key)')}</Label>
            <Input
              id={nameId}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full font-mono"
            />
            <p className="mt-1 text-[11px] text-text-faint">
              {tr('查询表达式里写的就是这个名字。', 'This is the name a query expression uses.')}
            </p>
          </div>
          <div>
            <Label htmlFor={aliasId}>{tr('别名（显示名）', 'Alias (display name)')}</Label>
            <Input id={aliasId} required value={alias} onChange={(event) => setAlias(event.target.value)} className="mt-1 w-full" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <span className="text-xs font-medium text-text-muted">{tr('图标', 'Icon')}</span>
            <div className="mt-1">
              <IconPicker value={icon} onChange={setIcon} label={alias || name || tr('模型图标', 'Model icon')} />
            </div>
          </div>
          <div>
            <Label htmlFor={orderId}>{tr('排序', 'Order')}</Label>
            <Input
              id={orderId}
              type="number"
              value={order}
              onChange={(event) => setOrder(event.target.value)}
              className="mt-1 w-28"
            />
          </div>
        </div>

        {creating ? (
          <div>
            <Label htmlFor={uniqueId}>{tr('标识属性', 'Identifying attribute')}</Label>
            {attributesErr && <p className="mt-1 text-[11px] text-red-400">{attributesErr}</p>}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Select
                id={uniqueId}
                label={tr('标识属性', 'Identifying attribute')}
                value={uniqueKey}
                onValueChange={setUniqueKey}
                options={attributeOptions}
                searchable
                className="w-72"
              />
              <Button variant="outline" size="sm" type="button" onClick={() => setNewAttr((current) => ({ ...current, open: !current.open }))}>
                {tr('新建属性', 'New attribute')}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-text-faint">
              {tr(
                '它决定“两台机器是不是同一台”。属性必须先存在于字典里。',
                'It decides whether two reported rows are the same machine. The attribute must exist in the dictionary first.',
              )}
            </p>

            {newAttr.open && (
              <div className="mt-2 rounded-md border border-border bg-card p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="cmdb-new-attr-name">{tr('属性名', 'Attribute name')}</Label>
                    <Input
                      id="cmdb-new-attr-name"
                      value={newAttr.name}
                      onChange={(event) => setNewAttr((current) => ({ ...current, name: event.target.value }))}
                      className="mt-1 w-full font-mono"
                    />
                  </div>
                  <div>
                    <Label htmlFor="cmdb-new-attr-alias">{tr('别名', 'Alias')}</Label>
                    <Input
                      id="cmdb-new-attr-alias"
                      value={newAttr.alias}
                      onChange={(event) => setNewAttr((current) => ({ ...current, alias: event.target.value }))}
                      className="mt-1 w-full"
                    />
                  </div>
                  <div>
                    <Label htmlFor="cmdb-new-attr-type">{tr('类型', 'Type')}</Label>
                    <Select
                      id="cmdb-new-attr-type"
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
                <Button variant="primary" size="sm" type="button" onClick={() => void createAttributeInline()} className="mt-2">
                  {tr('创建并选用', 'Create and use it')}
                </Button>
              </div>
            )}
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="cmdb-model-show-create">{tr('展示属性', 'Display attribute')}</Label>
                <Select
                  id="cmdb-model-show-create"
                  label={tr('展示属性', 'Display attribute')}
                  value={showKey}
                  onValueChange={setShowKey}
                  options={showOptions}
                  searchable
                  className="mt-1 w-full"
                />
                <p className="mt-1 text-[11px] text-text-faint">
                  {tr('实例列表和详情用它作为标题；创建后仍可修改。', 'Used as the title of an instance; editable after creation.')}
                </p>
              </div>
              <div>
                <Label htmlFor="cmdb-model-sort-create">{tr('默认排序列', 'Default sort column')}</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Select
                    id="cmdb-model-sort-create"
                    label={tr('默认排序列', 'Default sort column')}
                    value={defaultOrderAttr}
                    onValueChange={setDefaultOrderAttr}
                    options={sortOptions}
                    searchable
                    className="min-w-0 flex-1"
                  />
                  <Select
                    label={tr('排序方向', 'Sort direction')}
                    value={defaultOrderAsc}
                    onValueChange={(next) => setDefaultOrderAsc(next === 'desc' ? 'desc' : 'asc')}
                    options={[
                      { value: 'asc', label: tr('升序', 'Ascending') },
                      { value: 'desc', label: tr('降序', 'Descending') },
                    ]}
                    className="w-28"
                  />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={uniqueId}>{tr('标识属性', 'Identifying attribute')}</Label>
              <Input id={uniqueId} value={row?.unique_key ?? ''} readOnly disabled className="mt-1 w-full font-mono" />
              <p className="mt-1 text-[11px] text-text-faint">
                {tr('创建后不能改标识属性。', 'The identifying attribute cannot change after creation.')}
              </p>
            </div>
            <div>
              <Label htmlFor="cmdb-model-show">{tr('展示属性', 'Display attribute')}</Label>
              <Select
                id="cmdb-model-show"
                label={tr('展示属性', 'Display attribute')}
                value={showKey}
                onValueChange={setShowKey}
                options={showOptions}
                searchable
                className="mt-1 w-full"
              />
              <p className="mt-1 text-[11px] text-text-faint">
                {tr('实例列表和详情用它作为标题。', 'Used as the title of an instance in lists and details.')}
              </p>
            </div>
            <div>
              <Label htmlFor="cmdb-model-sort">{tr('默认排序列', 'Default sort column')}</Label>
              <div className="mt-1 flex items-center gap-2">
                <Select
                  id="cmdb-model-sort"
                  label={tr('默认排序列', 'Default sort column')}
                  value={defaultOrderAttr}
                  onValueChange={setDefaultOrderAttr}
                  options={sortOptions}
                  searchable
                  className="min-w-0 flex-1"
                />
                <Select
                  label={tr('排序方向', 'Sort direction')}
                  value={defaultOrderAsc}
                  onValueChange={(next) => setDefaultOrderAsc(next === 'desc' ? 'desc' : 'asc')}
                  options={[
                    { value: 'asc', label: tr('升序', 'Ascending') },
                    { value: 'desc', label: tr('降序', 'Descending') },
                  ]}
                  className="w-28"
                />
              </div>
            </div>
          </div>
        )}

        {availableModels.length > 0 && (
          <fieldset>
            <legend className="text-xs font-medium text-text-muted">{tr('继承自（可多选）', 'Inherits from (any number)')}</legend>
            <Input
              type="search"
              aria-label={tr('筛选父模型', 'Filter parent models')}
              placeholder={tr('筛选父模型', 'Filter parent models')}
              value={parentQuery}
              onChange={(event) => setParentQuery(event.target.value)}
              className="mt-1 w-full"
            />
            <div className="mt-2 flex max-h-32 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto rounded-md border border-border p-2">
              {visibleParentOptions.map((model) => (
                <label key={model.id} className="flex items-center gap-2 text-xs text-text-muted">
                  <Checkbox
                    checked={parentIDs.includes(model.id)}
                    onCheckedChange={(next) =>
                      setParentIDs((current) =>
                        next === true ? [...current, model.id] : current.filter((id) => id !== model.id),
                      )
                    }
                  />
                  {model.alias || model.name}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-text-faint">
              {tr(
                '子模型继承父模型的属性，并可以覆盖绑定设置。',
                'A child inherits its parents’ attributes and may override their binding settings.',
              )}
            </p>
          </fieldset>
        )}
      </form>
    </Modal>
  );
}

/** Re-exported for the detail page, which renders the same type chips. */
export function valueTypeLabel(code: string): [string, string] {
  return isValueTypeCode(code) ? VALUE_TYPE_LABELS[code] : ['未知类型', 'Unknown type'];
}
