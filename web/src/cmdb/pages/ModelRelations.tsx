import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
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
import { RELATION_CONSTRAINTS, relationConstraintLabel } from '../lib/relation';

import { describeError } from '../api/http';
import {
  deleteRelationById,
  listCITypes,
  listRelations,
  listTypeAttributes,
  saveRelation,
  type CIType,
  type ModelRelation,
  type TypeAttribute,
} from '../api/citype';
import { listRelationTypes, type RelationType } from '../api/relationtype';
import { CMDBIcon } from '../components/CMDBIcon';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';
import { RelationAttributePairs, type AttributePair } from '../components/RelationAttributePairs';

// 模型关系 — every parent → child pair in the estate, in one table.
//
// THE PAIR IS THE ROW. A relation is one edge, so the parent and the child are
// both columns rather than a nested tree: a tree would hide the fact that some
// models have many parents and others have none.
//
// CREATION IS ALSO HERE, with both sides explicit. The model detail page keeps
// its one-sided "add child/parent" flow; this page is for an operator who is
// thinking about the graph rather than one model.


export default function ModelRelationsPage() {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();

  const [rows, setRows] = useState<ModelRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [models, setModels] = useState<CIType[]>([]);
  const [relationTypes, setRelationTypes] = useState<RelationType[]>([]);
  const [formLoading, setFormLoading] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      try {
        setRows(await listRelations());
      } catch (error) {
        setErr(describeError(error, tr('无法读取模型关系', 'Could not load the model relations')));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [tr],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => {
      const source = `${row.parent.type.alias} ${row.parent.type.name}`.toLowerCase();
      const target = `${row.child.type.alias} ${row.child.type.name}`.toLowerCase();
      const relation = `${row.child.relation_type.name ?? ''} ${row.child.relation_type.id ?? ''}`.toLowerCase();
      return source.includes(needle) || target.includes(needle) || relation.includes(needle);
    });
  }, [rows, query]);

  const adminTip = isAdmin ? undefined : tr('需要管理员权限', 'Administrator role required');

  const remove = async (row: ModelRelation) => {
    const parent = row.parent.type.alias || row.parent.type.name;
    const child = row.child.type.alias || row.child.type.name;
    const ok = await confirmAction(
      tr(
        `删除「${parent} → ${child}」这条模型关系？已经存在的实例关系不会被删除。`,
        `Delete the model relation “${parent} → ${child}”? Instance relations that already exist are not removed.`,
      ),
    );
    if (!ok) return;
    try {
      await deleteRelationById(row.id);
      toast.success(tr('已删除', 'Deleted'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const openCreate = async () => {
    setFormLoading(true);
    try {
      const [gotModels, gotTypes] = await Promise.all([listCITypes(), listRelationTypes()]);
      setModels(gotModels);
      setRelationTypes(gotTypes);
      setCreating(true);
    } catch (error) {
      toast.error(describeError(error, tr('无法打开新建关系', 'Could not open the relation form')));
    } finally {
      setFormLoading(false);
    }
  };

  // The icon is the model's own stored glyph. The accessible name stays the
  // alias, so the extra identifier line does not turn the link into "主机 host".
  const modelLink = (model: ModelRelation['parent']['type']) => (
    <Link
      to={`/cmdb/models/${model.id}`}
      aria-label={model.alias || model.name}
      className="flex min-w-0 items-center gap-2 rounded-md text-text hover:text-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
    >
      <CMDBIcon value={model.icon} size={16} label={model.alias || model.name} />
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{model.alias || model.name}</span>
        <span className="block truncate font-mono text-[10px] text-text-faint">{model.name}</span>
      </span>
    </Link>
  );

  // The mapping is positional; both ends of the list response carry the pair.
  // Show the attribute names (two at most) instead of a bare count, and fall
  // back to the count when an attribute has since been deleted.
  const mappingText = (row: ModelRelation): { text: string; count: number } => {
    const parentIDs = row.child.parent_attr_ids?.length ? row.child.parent_attr_ids : row.parent.parent_attr_ids;
    const childIDs = row.child.child_attr_ids?.length ? row.child.child_attr_ids : row.parent.child_attr_ids;
    const count = Math.max(parentIDs?.length ?? 0, childIDs?.length ?? 0);
    const pairs = (parentIDs ?? []).slice(0, 2).map((id, index) => {
      const source = row.parent.attributes.find((attribute) => attribute.id === id);
      const target = row.child.attributes.find((attribute) => attribute.id === childIDs?.[index]);
      const name = (attribute?: TypeAttribute) => (attribute ? attribute.alias || attribute.name : '');
      const left = name(source);
      const right = name(target);
      return left && right ? `${left} → ${right}` : '';
    }).filter(Boolean);
    return {
      count,
      text: pairs.length ? pairs.join('，') : count ? tr(`${count} 组`, `${count} pairs`) : '',
    };
  };

  const columns: Column<ModelRelation>[] = [
    {
      key: 'parent',
      header: tr('源 CI 类型', 'Source CI type'),
      width: 'min-w-40',
      cell: (row) => modelLink(row.parent.type),
    },
    {
      key: 'child',
      header: tr('目标 CI 类型', 'Target CI type'),
      width: 'min-w-40',
      cell: (row) => modelLink(row.child.type),
    },
    {
      key: 'type',
      header: tr('关系类型', 'Relation type'),
      width: 'min-w-28',
      cell: (row) => (
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: row.child.relation_type.color || 'transparent' }}
          />
          <span className="truncate text-xs text-text-muted">{row.child.relation_type.name || row.child.relation_type.id}</span>
        </span>
      ),
    },
    {
      key: 'constraint',
      header: tr('关系约束', 'Constraint'),
      width: 'min-w-24',
      cell: (row) => <Chip>{relationConstraintLabel(row.child.constraint, tr) || '—'}</Chip>,
    },
    {
      key: 'mapping',
      header: tr('属性关联', 'Attribute association'),
      width: 'w-full',
      cell: (row) => {
        const mapping = mappingText(row);
        if (!mapping.count) return <span className="text-text-faint">—</span>;
        return (
          <span className="block max-w-[28rem] truncate text-[11px] text-text-muted" title={mapping.text}>
            {mapping.text}
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        title={tr('模型关系', 'Model relations')}
        subtitle={tr(
          '源 CI 类型 → 目标 CI 类型（父 → 子）。资源层级的树按这张表展开。',
          'Source CI type → target CI type (parent → child). The hierarchy tree is built from this table.',
        )}
        actions={
          <div className="flex items-center gap-2">
            <Hint content={adminTip}>
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={() => void openCreate()}
                disabled={!isAdmin || formLoading}
                className="inline-flex items-center gap-1.5"
              >
                <Plus size={12} aria-hidden="true" />
                {tr('新增关系', 'New relation')}
              </Button>
            </Hint>
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
          </div>
        }
        extra={
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="search"
              aria-label={tr('搜索模型关系', 'Search relations')}
              placeholder={tr('按源类型、目标类型或关联类型筛选', 'Filter by source, target or relation type')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-64"
            />
            <p className="text-[11px] text-text-faint">
              {tr('源、目标与关联类型在这里直接选择。', 'Choose the source, target and relation type directly here.')}
            </p>
          </div>
        }
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        <Card>
          <div className="cmdb-relation-table">
          <DataTable
            columns={columns}
            rows={visible}
            rowKey={(row) => row.id}
            loading={loading}
            error={err}
            onRetry={() => void load()}
            storageKey="model-relations-all"
            empty={
              rows.length === 0
                ? tr('还没有模型关系。新建一条开始。', 'No model relations yet. Create one to start.')
                : tr('没有匹配的关系', 'No relation matches that')
            }
            actions={(row) => (
              <Hint content={adminTip}>
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  onClick={() => void remove(row)}
                  disabled={!isAdmin}
                  aria-label={tr(`删除 ${row.parent.type.name} → ${row.child.type.name}`, `Delete ${row.parent.type.name} → ${row.child.type.name}`)}
                  title={tr(`删除 ${row.parent.type.name} → ${row.child.type.name}`, `Delete ${row.parent.type.name} → ${row.child.type.name}`)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-red-500 hover:bg-card hover:text-red-600 dark:text-red-300"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </Button>
              </Hint>
            )}
          />
          </div>
        </Card>
      </div>

      {creating && (
        <RelationFormModal
          models={models}
          relationTypes={relationTypes}
          onClose={() => setCreating(false)}
          onSaved={async (message) => {
            setCreating(false);
            toast.success(message);
            await load(true);
          }}
        />
      )}

      {dialog}
    </div>
  );
}

function RelationFormModal({
  models,
  relationTypes,
  onClose,
  onSaved,
}: {
  models: CIType[];
  relationTypes: RelationType[];
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const [sourceID, setSourceID] = useState('');
  const [targetID, setTargetID] = useState('');
  const [typeID, setTypeID] = useState('');
  const [constraint, setConstraint] = useState('0');
  const [sourceAttributes, setSourceAttributes] = useState<TypeAttribute[]>([]);
  const [targetAttributes, setTargetAttributes] = useState<TypeAttribute[]>([]);
  const [pairs, setPairs] = useState<AttributePair[]>([{ source: '', target: '' }]);
  const [attributesLoading, setAttributesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!sourceID || !targetID) {
      setSourceAttributes([]);
      setTargetAttributes([]);
      setAttributesLoading(false);
      return;
    }
    // THE ROWS STAY; ONLY THEIR SELECTIONS BELONG TO THE OLD TYPES. The change
    // handlers clear the affected side before the fetch settles, so a stale
    // mapping cannot be submitted while the new attributes are loading.
    setSourceAttributes([]);
    setTargetAttributes([]);
    setAttributesLoading(true);
    void Promise.all([listTypeAttributes(sourceID), listTypeAttributes(targetID)])
      .then(([source, target]) => {
        if (cancelled) return;
        setSourceAttributes(source.attributes ?? []);
        setTargetAttributes(target.attributes ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setSourceAttributes([]);
        setTargetAttributes([]);
      })
      .finally(() => {
        if (!cancelled) setAttributesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceID, targetID]);

  const chooseSource = (next: string) => {
    setSourceID(next);
    setPairs((current) => current.map((pair) => ({ ...pair, source: '' })));
  };
  const chooseTarget = (next: string) => {
    setTargetID(next);
    setPairs((current) => current.map((pair) => ({ ...pair, target: '' })));
  };
  const chooseConstraint = (next: string) => {
    setConstraint(next);
    // The list rules depend on the constraint, so every mapping is re-checked.
    setPairs((current) => current.map((pair) => ({ ...pair, source: '', target: '' })));
  };

  const submit = async () => {
    if (!sourceID || !targetID || !typeID) {
      setErr(tr('请选择源 CI 类型、目标 CI 类型和关联类型', 'Choose the source type, the target type and the relation type'));
      return;
    }
    if (sourceID === targetID) {
      setErr(tr('源 CI 类型和目标 CI 类型不能相同', 'The source and target types must be different'));
      return;
    }
    const partial = pairs.some((pair) => Boolean(pair.source) !== Boolean(pair.target));
    if (partial) {
      setErr(tr('属性关联需要同时选择源属性和目标属性', 'An attribute association needs both a source and a target attribute'));
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const filled = pairs.filter((pair) => pair.source && pair.target);
      await saveRelation(sourceID, targetID, {
        relation_type_id: Number(typeID),
        constraint,
        ...(filled.length > 0
          ? {
              parent_attr_ids: filled.map((pair) => Number(pair.source)),
              child_attr_ids: filled.map((pair) => Number(pair.target)),
            }
          : {}),
      });
      await onSaved(tr('已创建模型关系', 'Relation created'));
    } catch (error) {
      setErr(describeError(error, tr('创建失败', 'Could not create it')));
    } finally {
      setSubmitting(false);
    }
  };

  const options = models.map((model) => ({ value: String(model.id), label: model.alias || model.name }));

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={tr('新增关系', 'New relation')}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
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
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {err}
        </div>
      )}
      <p className="mb-4 text-[11px] leading-5 text-text-faint">
        {tr(
          '配置源 CI 类型到目标 CI 类型的关系；完成时点击保存。',
          'Configure the relation from the source CI type to the target; save when done.',
        )}
      </p>
      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor="cmdb-relation-source">{tr('源 CI 类型', 'Source CI type')}</Label>
          <Select
            id="cmdb-relation-source"
            label={tr('源 CI 类型', 'Source CI type')}
            placeholder={tr('选择源 CI 类型', 'Select source CI type')}
            value={sourceID}
            onValueChange={chooseSource}
            options={options}
            searchable
            className="mt-1 w-full"
          />
        </div>
        <div>
          <Label htmlFor="cmdb-relation-target">{tr('目标 CI 类型', 'Target CI type')}</Label>
          <Select
            id="cmdb-relation-target"
            label={tr('目标 CI 类型', 'Target CI type')}
            placeholder={tr('选择目标 CI 类型', 'Select target CI type')}
            value={targetID}
            onValueChange={chooseTarget}
            options={options}
            searchable
            className="mt-1 w-full"
          />
        </div>
        <div>
          <Label htmlFor="cmdb-relation-type">{tr('关联类型', 'Relation type')}</Label>
          <Select
            id="cmdb-relation-type"
            label={tr('关联类型', 'Relation type')}
            placeholder={tr('选择关联类型', 'Select relation type')}
            value={typeID}
            onValueChange={setTypeID}
            options={relationTypes.map((type) => ({ value: String(type.id), label: type.name }))}
            className="mt-1 w-full"
          />
        </div>
        <div>
          <Label htmlFor="cmdb-relation-constraint">{tr('关系约束', 'Constraint')}</Label>
          <Select
            id="cmdb-relation-constraint"
            label={tr('关系约束', 'Constraint')}
            value={constraint}
            onValueChange={chooseConstraint}
            options={RELATION_CONSTRAINTS.map((item) => ({ value: item.value, label: tr(item.zh, item.en) }))}
            className="mt-1 w-full sm:w-56"
          />
        </div>
        <RelationAttributePairs
          sourceAttributes={sourceAttributes}
          targetAttributes={targetAttributes}
          pairs={pairs}
          onChange={setPairs}
          constraint={constraint}
          disabled={submitting}
          loading={attributesLoading}
        />
      </div>
    </Modal>
  );
}
