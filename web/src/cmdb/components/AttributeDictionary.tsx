import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/Modal';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';
import { cn } from '@/lib/cn';

import { deleteAttribute, listAttributesPage, type Attribute } from '../api/citype';
import { describeError } from '../api/http';
import { AttributeForm } from './AttributeForm';
import { DataTable, type Column } from './DataTable';
import { useToast } from './Toast';
import { VALUE_TYPE_LABELS, isValueTypeCode } from '../lib/valuetype';

// 属性字典 — the full dictionary, not just the attributes one model happens to
// bind.
//
// It is a modal rather than a route because the model page is where an operator
// notices a missing attribute, and leaving the model to create one loses the
// model context. The list is server-paged: the dictionary can hold hundreds of
// attributes and the API clamps a page to 200, so the page size is explicit and
// the footer reports the total.
//
// THE FORM IS THE SAME one the model page uses. A second editor with a subset
// of the fields would drift from the first the first time either gained a
// field.

const PAGE_SIZE = 50;

export function AttributeDictionary({ open, onClose, onChanged }: {
  open: boolean;
  onClose(): void;
  onChanged?(): void;
}) {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Attribute[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Attribute | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      try {
        const got = await listAttributesPage({
          page,
          page_size: PAGE_SIZE,
          name: query.trim() || undefined,
        });
        setRows(got.items);
        setTotal(got.total);
      } catch (error) {
        setErr(describeError(error, tr('无法读取属性字典', 'Could not load the attribute dictionary')));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [page, query, tr],
  );

  useEffect(() => {
    if (open && !creating && !editing) void load();
  }, [open, creating, editing, load]);

  // Reset the query page when the search changes, otherwise a search can land
  // on page 6 of a one-page result.
  const changeQuery = (next: string) => {
    setQuery(next);
    setPage(1);
  };

  const refresh = async (quiet = false) => {
    await load(quiet);
    onChanged?.();
  };

  const remove = async (row: Attribute) => {
    const ok = await confirmAction(
      tr(
        `删除属性「${row.alias || row.name}」？仍被模型绑定时后端会拒绝；解绑会删除该模型上的值。`,
        `Delete “${row.alias || row.name}”? The backend refuses while a model still binds it; unbinding deletes that model’s values.`,
      ),
    );
    if (!ok) return;
    try {
      await deleteAttribute(row.id);
      toast.success(tr('已删除', 'Deleted'));
      await refresh(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const adminTip = isAdmin ? undefined : tr('需要管理员权限', 'Administrator role required');

  const columns: Column<Attribute>[] = [
    {
      key: 'name',
      header: tr('属性', 'Attribute'),
      width: 'w-full',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-text">{row.alias || row.name}</div>
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
            {row.is_file && <Chip>{tr('文件', 'File')}</Chip>}
          </span>
        );
      },
    },
    {
      key: 'storage',
      header: tr('存储', 'Storage'),
      hideable: true,
      cell: (row) => (
        <Hint content={`${row.storage_table}`}>
          <span className="text-[11px] text-text-muted">{row.is_indexed ? tr('索引', 'Indexed') : tr('非索引', 'Unindexed')}</span>
        </Hint>
      ),
    },
  ];

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="xl"
        resizable
        title={
          creating
            ? tr('新建属性', 'New attribute')
            : editing
              ? tr(`编辑属性 ${editing.name}`, `Edit attribute ${editing.name}`)
              : tr('属性字典', 'Attribute dictionary')
        }
      >
        {creating || editing ? (
          <AttributeForm
            attribute={editing}
            onClose={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSaved={async (message) => {
              toast.success(message);
              setCreating(false);
              setEditing(null);
              await refresh();
            }}
            onDelete={
              editing
                ? async () => {
                    await remove(editing);
                    setEditing(null);
                  }
                : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                aria-label={tr('搜索属性', 'Search attributes')}
                placeholder={tr('按属性名搜索', 'Search by attribute name')}
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                className="w-64"
              />
              <span className="text-xs text-text-muted">
                {tr(`${total} 个属性`, `${total} attributes`)}
              </span>
              <div className="ms-auto flex items-center gap-2">
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
                    onClick={() => setCreating(true)}
                    disabled={!isAdmin}
                    className="inline-flex items-center gap-1.5"
                  >
                    <Plus size={12} aria-hidden="true" />
                    {tr('新建属性', 'New attribute')}
                  </Button>
                </Hint>
              </div>
            </div>

            {err && (
              <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                {err}
              </div>
            )}

            <Card>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                loading={loading}
                error={err}
                onRetry={() => void load()}
                storageKey="attribute-dictionary"
                empty={query.trim() ? tr('没有匹配的属性', 'No attribute matches that') : tr('字典还没有属性', 'The dictionary has no attributes yet')}
                actions={(row) => (
                  <>
                    <Hint content={adminTip}>
                      <Button
                        variant="subtle"
                        size="sm"
                        type="button"
                        onClick={() => setEditing(row)}
                        disabled={!isAdmin}
                        aria-label={tr(`编辑 ${row.name}`, `Edit ${row.name}`)}
                        className="inline-flex items-center gap-1"
                      >
                        <Pencil size={12} aria-hidden="true" />
                        {tr('编辑', 'Edit')}
                      </Button>
                    </Hint>
                    <Hint content={adminTip}>
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        type="button"
                        onClick={() => void remove(row)}
                        disabled={!isAdmin}
                        aria-label={tr(`删除 ${row.name}`, `Delete ${row.name}`)}
                        className="inline-flex items-center gap-1"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                        {tr('删除', 'Delete')}
                      </Button>
                    </Hint>
                  </>
                )}
              />
            </Card>

            <PaginationFooter
              page={page - 1}
              pageSize={PAGE_SIZE}
              shown={rows.length}
              total={total}
              loading={loading}
              onPageChange={(next) => setPage(next + 1)}
            />
          </div>
        )}
      </Modal>
      {dialog}
    </>
  );
}
