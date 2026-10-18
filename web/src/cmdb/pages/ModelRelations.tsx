import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';
import { cn } from '@/lib/cn';

import { describeError } from '../api/http';
import { deleteRelationById, listRelations, type ModelRelation } from '../api/citype';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

// 模型关系 — every parent → child pair in the estate, in one table.
//
// IT IS A READ-ONLY VIEW PLUS DELETE, and the reason is deliberate: a relation's
// DIRECTION is what a create needs, and on this page the operator would have to
// say "which of these two is the parent" twice. Creating belongs on a model's
// own page, where one side is fixed. This page is for the question the flat view
// answers — "what is wired to what" — and for removing an edge you can see.
//
// THE PAIR IS THE ROW. A relation is one edge, so the parent and the child are
// both columns rather than a nested tree: a tree would hide the fact that some
// models have many parents and others have none.

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
      const parent = `${row.parent.type.alias} ${row.parent.type.name}`.toLowerCase();
      const child = `${row.child.type.alias} ${row.child.type.name}`.toLowerCase();
      return parent.includes(needle) || child.includes(needle);
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

  const modelLink = (model: ModelRelation['parent']['type']) => (
    <Link
      to={`/cmdb/models/${model.id}`}
      className="truncate font-medium text-text hover:text-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
    >
      {model.alias || model.name}
    </Link>
  );

  const columns: Column<ModelRelation>[] = [
    { key: 'parent', header: tr('父模型', 'Parent'), width: 'w-full', cell: (row) => modelLink(row.parent.type) },
    { key: 'child', header: tr('子模型', 'Child'), width: 'w-full', cell: (row) => modelLink(row.child.type) },
    {
      key: 'type',
      header: tr('关系类型', 'Relation type'),
      cell: (row) => (
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: row.child.relation_type.color || 'transparent' }}
          />
          <span className="text-xs text-text-muted">{row.child.relation_type.name || row.child.relation_type.id}</span>
        </span>
      ),
    },
    {
      key: 'constraint',
      header: tr('基数', 'Cardinality'),
      cell: (row) => <Chip>{row.child.constraint || '—'}</Chip>,
    },
  ];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        title={tr('模型关系', 'Model relations')}
        subtitle={tr(
          '哪些模型可以挂在哪些模型下面。资源层级的树按这张表展开。',
          'Which models may nest under which. The hierarchy tree is built from this table.',
        )}
        actions={
          <div className="flex items-center gap-2">
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
              placeholder={tr('按父模型或子模型搜索', 'Search by either model')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-64"
            />
            <p className="text-[11px] text-text-faint">
              {tr('新增关系在模型详情页里做——那里的方向是明确的。', 'Add a relation from a model’s page, where the direction is unambiguous.')}
            </p>
          </div>
        }
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        <Card>
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
                ? tr('还没有模型关系。先在某个模型上挂一个子模型。', 'No model relations yet. Add a child from a model’s page.')
                : tr('没有匹配的关系', 'No relation matches that')
            }
            actions={(row) => (
              <Hint content={adminTip}>
                <Button
                  variant="dangerGhost"
                  size="sm"
                  type="button"
                  onClick={() => void remove(row)}
                  disabled={!isAdmin}
                  aria-label={tr(`删除 ${row.parent.type.name} → ${row.child.type.name}`, `Delete ${row.parent.type.name} → ${row.child.type.name}`)}
                  className="inline-flex items-center gap-1"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  {tr('删除', 'Delete')}
                </Button>
              </Hint>
            )}
          />
        </Card>
      </div>

      {dialog}
    </div>
  );
}
