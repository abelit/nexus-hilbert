import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, LayoutGrid, Network, Pencil, Plus, Send, Table2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyStateCard } from '@/components/ui/EmptyState';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Textarea } from '@/components/ui/Textarea';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { RELATION_CONSTRAINTS, relationConstraintLabel } from '../lib/relation';

import { describeError } from '../api/http';
import {
  createTrigger,
  createUniqueConstraint,
  deleteRelationById,
  deleteTrigger,
  deleteUniqueConstraint,
  listCITypes,
  listTriggers,
  listTypeAttributes,
  listUniqueConstraints,
  relationChildren,
  relationParents,
  saveRelation,
  testTrigger,
  updateTrigger,
  type CIType,
  type RelatedType,
  type Trigger,
  type TypeAttribute,
  type UniqueConstraint,
} from '../api/citype';
import { listUsers, type User } from '@/api/users';

import { listModelGroups, type ModelGroup } from '../api/preferences';
import { listRelationTypes, type RelationType } from '../api/relationtype';
import { CMDBIcon } from './CMDBIcon';
import { ConditionFilter } from './ConditionFilter';
import { ModelRelationsTopology } from './model-relations/ModelRelationsTopology';
import { DataTable, type Column } from './DataTable';
import { Drawer } from './Drawer';
import { TriggerNotifyEditor } from './trigger/TriggerNotifyEditor';
import { TriggerWebhookEditor } from './trigger/TriggerWebhookEditor';
import {
  authorizationValues,
  recordOf,
  webhookConfigOf,
  type WebhookConfig,
} from './trigger/types';
import { RelationAttributePairs, type AttributePair } from './RelationAttributePairs';
import { useToast } from './Toast';

// The three rule-shaped tabs of a model: relations, uniqueness and triggers.
//
// THEY ARE IN ONE FILE BECAUSE THEY SHARE A SHAPE rather than a subject: each is
// a small list plus a form, each is gated on the admin role, and each one's
// interesting decision is a validation rule rather than a layout. Keeping them
// together means the validation notes sit next to the forms that have to obey
// them.

// --- relations ---

type Direction = 'children' | 'parents';
type RelationView = 'list' | 'grid' | 'topology';
type RelationRow = { direction: Direction; relation: RelatedType; other: CIType; show: string };

export function RelationsTab({
  modelRef,
  attributes,
  isAdmin,
  adminTip,
}: {
  modelRef: string;
  attributes: TypeAttribute[];
  isAdmin: boolean;
  adminTip?: string;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const [children, setChildren] = useState<RelatedType[]>([]);
  const [parents, setParents] = useState<RelatedType[]>([]);
  const [models, setModels] = useState<CIType[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<Direction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The console's list pages pick grid on narrow windows and remember nothing
  // across visits; the relations tab follows the same rule so one model's
  // relations open the same way as its siblings.
  const [view, setView] = useState<RelationView>(() =>
    window.matchMedia?.('(max-width: 1279px)')?.matches ? 'grid' : 'list',
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [gotChildren, gotParents, gotModels, gotGroups] = await Promise.all([
        relationChildren(modelRef),
        relationParents(modelRef),
        listCITypes(),
        listModelGroups().catch(() => [] as ModelGroup[]),
      ]);
      setChildren(gotChildren);
      setParents(gotParents);
      setModels(gotModels);
      setGroups(gotGroups);
    } catch (error) {
      setErr(describeError(error, tr('无法读取模型关系', 'Could not load the relations')));
    } finally {
      setLoading(false);
    }
  }, [modelRef, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (relation: RelatedType) => {
    const other = relation.type;
    const ok = await confirmAction(
      tr(
        `删除与「${other.alias || other.name}」的模型关系？已经存在的实例关系不会被删除。`,
        `Delete the relation to “${other.alias || other.name}”? Instance relations that already exist are not removed.`,
      ),
    );
    if (!ok) return;
    try {
      await deleteRelationById(relation.ctr_id);
      toast.success(tr('已删除', 'Deleted'));
      await load();
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  // Both reads return the model on the far side of the edge, so the direction
  // is the only difference between the two row sets.
  const rows: RelationRow[] = [
    ...children.map((relation) => ({
      direction: 'children' as const,
      relation,
      other: relation.type,
      show: relation.show_key ?? '',
    })),
    ...parents.map((relation) => ({
      direction: 'parents' as const,
      relation,
      other: relation.type,
      show: relation.show_key ?? '',
    })),
  ];

  // THE GRAPH IS ONE HOP. This tab configures one model, so the picture is the
  // model in the middle and the models it can nest under or own; drawing the
  // whole estate here would answer a question this page does not ask.
  const center = useMemo(
    () => models.find((item) => String(item.id) === modelRef || item.name === modelRef || item.alias === modelRef) ?? null,
    [models, modelRef],
  );


  const emptyHint = tr('这个模型还没有关系', 'This model has no relations yet');

  // List mode keeps the table's own busy/error/empty handling; the two visual
  // modes share this panel so a failed read never turns into a blank canvas.
  const visualStatus = loading ? (
    <div className="flex h-32 items-center justify-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</div>
  ) : err ? (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
      <span className="min-w-0 flex-1 break-words">{err}</span>
      <Button variant="outline" size="sm" type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5">
        {tr('重试', 'Retry')}
      </Button>
    </div>
  ) : rows.length === 0 ? (
    <EmptyStateCard title={tr('没有数据', 'Nothing here yet')} hint={emptyHint} />
  ) : null;

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'other',
      header: tr('对端模型', 'Other model'),
      width: 'w-full',
      cell: (row) => {
        const label = row.other.alias || row.other.name;
        return (
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-tr from-sky-500 to-indigo-500 text-white shadow-sm shadow-sky-500/20">
              <CMDBIcon value={row.other.icon} size={13} label={label} />
            </span>
            <Link
              to={`/cmdb/models/${row.other.id}`}
              title={label}
              className="min-w-0 truncate font-semibold text-text hover:text-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
            >
              {label}
            </Link>
            <Chip tone={row.direction === 'children' ? 'info' : 'default'} dense className="shrink-0">
              {row.direction === 'children' ? tr('子模型', 'Child') : tr('父模型', 'Parent')}
            </Chip>
          </span>
        );
      },
    },
    {
      key: 'type',
      header: tr('关系类型', 'Relation type'),
      width: 'w-[11rem]',
      cell: (row) => {
        const type = row.relation.relation_type;
        const label = type.name || String(type.id);
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: type.color || 'transparent' }}
            />
            <span className="min-w-0 truncate text-xs text-text-muted" title={label}>
              {label}
            </span>
          </span>
        );
      },
    },
    {
      key: 'constraint',
      header: tr('基数', 'Cardinality'),
      width: 'w-[7rem]',
      cell: (row) => (
        <code className="whitespace-nowrap font-mono text-[11px] text-text-muted">
          {relationConstraintLabel(row.relation.constraint, tr)}
        </code>
      ),
    },
    {
      key: 'show',
      header: tr('树上显示', 'Shown on the tree'),
      width: 'w-[9rem]',
      hideable: true,
      cell: (row) =>
        row.show ? (
          <code className="whitespace-nowrap font-mono text-[11px] text-text-muted" title={row.show}>
            {row.show}
          </code>
        ) : (
          <span className="text-text-faint">—</span>
        ),
    },
  ];

  const gridSections = [
    { key: 'children' as const, label: tr('子模型', 'Child models'), rows: rows.filter((row) => row.direction === 'children') },
    { key: 'parents' as const, label: tr('父模型', 'Parent models'), rows: rows.filter((row) => row.direction === 'parents') },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {tr(
            '模型关系定义“一种资源能不能挂在另一种下面”，资源层级的树由它展开。',
            'A model relation says one kind of resource may nest under another; the hierarchy tree is built from it.',
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="cmdb-liquid-segment flex shrink-0 items-center gap-1 p-1" role="group" aria-label={tr('视图', 'View')}>
            <Button
              variant="plain"
              size="sm"
              type="button"
              aria-pressed={view === 'list'}
              aria-label={tr('列表', 'List')}
              title={tr('列表视图', 'List view')}
              onClick={() => setView('list')}
              className={cn('cmdb-liquid-segment-button inline-flex items-center justify-center px-2.5', view === 'list' && 'is-active')}
            >
              <Table2 size={13} aria-hidden="true" />
            </Button>
            <Button
              variant="plain"
              size="sm"
              type="button"
              aria-pressed={view === 'grid'}
              aria-label={tr('网格', 'Grid')}
              title={tr('网格视图', 'Grid view')}
              onClick={() => setView('grid')}
              className={cn('cmdb-liquid-segment-button inline-flex items-center justify-center px-2.5', view === 'grid' && 'is-active')}
            >
              <LayoutGrid size={13} aria-hidden="true" />
            </Button>
            <Button
              variant="plain"
              size="sm"
              type="button"
              aria-pressed={view === 'topology'}
              aria-label={tr('拓扑', 'Topology')}
              title={tr('拓扑视图', 'Topology view')}
              onClick={() => setView('topology')}
              className={cn('cmdb-liquid-segment-button inline-flex items-center justify-center px-2.5', view === 'topology' && 'is-active')}
            >
              <Network size={13} aria-hidden="true" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" type="button" onClick={() => setAdding('children')} disabled={!isAdmin} className="inline-flex items-center gap-1.5">
              <Plus size={12} aria-hidden="true" />
              {tr('加子模型', 'Add child')}
            </Button>
            <Button variant="outline" size="sm" type="button" onClick={() => setAdding('parents')} disabled={!isAdmin} className="inline-flex items-center gap-1.5">
              <Plus size={12} aria-hidden="true" />
              {tr('加父模型', 'Add parent')}
            </Button>
          </div>
        </div>
      </div>

      {view === 'list' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The same card, density and quiet row actions as the resource list. */}
          <DataTable
            fill
            columns={columns}
            rows={rows}
            rowKey={(row) => row.relation.ctr_id}
            loading={loading}
            error={err}
            onRetry={() => void load()}
            storageKey="model-relations"
            empty={emptyHint}
            tableClassName="cmdb-instance-table"
            scrollerClassName="cmdb-instance-table-scroll"
            actions={(row) => (
              <Hint content={adminTip}>
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  onClick={() => void remove(row.relation)}
                  disabled={!isAdmin}
                  aria-label={tr(`删除与 ${row.other.name} 的关系`, `Delete the relation to ${row.other.name}`)}
                  title={tr(`删除与 ${row.other.name} 的关系`, `Delete the relation to ${row.other.name}`)}
                  className="cmdb-liquid-action-danger inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </Button>
              </Hint>
            )}
          />
        </div>
      ) : view === 'grid' ? (
        <div className="flex flex-col gap-5">
          {visualStatus ??
            gridSections.map((section) =>
              section.rows.length === 0 ? null : (
                <section key={section.key} aria-labelledby={`cmdb-relation-${section.key}`}>
                  <h2
                    id={`cmdb-relation-${section.key}`}
                    className="mb-2 flex items-center gap-2 text-xs font-semibold text-text"
                  >
                    {section.label}
                    <Chip dense>{section.rows.length}</Chip>
                  </h2>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {section.rows.map((row) => (
                      <RelationCard
                        key={`${row.direction}-${row.relation.ctr_id}`}
                        row={row}
                        isAdmin={isAdmin}
                        adminTip={adminTip}
                        onDelete={() => void remove(row.relation)}
                      />
                    ))}
                  </div>
                </section>
              ),
            )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <p className="text-[11px] text-text-faint">
            {tr('点击模型节点打开它的模型关系。', 'Select a model node to open its relations.')}
          </p>
          {visualStatus ??
            (center ? (
              <ModelRelationsTopology
                center={center}
                parents={parents}
                children={children}
                groups={groups}
              />
            ) : null)}
        </div>
      )}

      {adding && (
        <RelationModal
          direction={adding}
          modelRef={modelRef}
          models={models}
          attributes={attributes}
          onClose={() => setAdding(null)}
          onSaved={async (message) => {
            setAdding(null);
            toast.success(message);
            await load();
          }}
        />
      )}
      {dialog}
    </div>
  );
}

// THE CARD CARRIES THE SAME FACTS AS THE ROW, in the order an operator reads
// them: which model, which side of the edge, then the relation's shape. It
// borrows the model list's card so one model looks the same wherever its card
// appears.
function RelationCard({
  row,
  isAdmin,
  adminTip,
  onDelete,
}: {
  row: RelationRow;
  isAdmin: boolean;
  adminTip?: string;
  onDelete(): void;
}) {
  const { tr } = useI18n();
  const label = row.other.alias || row.other.name;
  const directionLabel = row.direction === 'children' ? tr('子模型', 'Child model') : tr('父模型', 'Parent model');
  return (
    <article className="cmdb-liquid-card flex min-w-0 flex-col rounded-2xl p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-500 text-white shadow-md shadow-sky-500/20">
          <CMDBIcon value={row.other.icon} size={18} label={label} />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={`/cmdb/models/${row.other.id}`}
            aria-label={label}
            className="block min-w-0 truncate rounded-sm text-text hover:text-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          >
            <h3 className="truncate text-sm font-bold text-text" title={label}>
              {label}
            </h3>
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <code className="cmdb-liquid-key">{row.other.name}</code>
            <Chip tone={row.direction === 'children' ? 'info' : 'default'} dense>
              {directionLabel}
            </Chip>
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2">
        <div className="min-w-0">
          <dt className="text-[10px] text-text-faint">{tr('关系类型', 'Relation type')}</dt>
          <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: row.relation.relation_type.color || 'transparent' }}
            />
            <span className="truncate">{row.relation.relation_type.name || row.relation.relation_type.id}</span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] text-text-faint">{tr('基数', 'Cardinality')}</dt>
          <dd className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
            {relationConstraintLabel(row.relation.constraint, tr)}
          </dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-[10px] text-text-faint">{tr('树上显示', 'Shown on the tree')}</dt>
          <dd className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{row.show || '—'}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
        <span className="font-mono text-[10px] text-text-faint">#{row.other.id}</span>
        <Hint content={adminTip}>
          <Button
            variant="dangerGhost"
            size="sm"
            type="button"
            onClick={onDelete}
            disabled={!isAdmin}
            aria-label={tr(`删除与 ${row.other.name} 的关系`, `Delete the relation to ${row.other.name}`)}
            className="inline-flex items-center gap-1"
          >
            <Trash2 size={12} aria-hidden="true" />
            {tr('删除', 'Delete')}
          </Button>
        </Hint>
      </div>
    </article>
  );
}

function RelationModal({
  direction,
  modelRef,
  models,
  attributes,
  onClose,
  onSaved,
}: {
  direction: Direction;
  modelRef: string;
  models: CIType[];
  attributes: TypeAttribute[];
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const [types, setTypes] = useState<RelationType[]>([]);
  const [peer, setPeer] = useState('');
  const [relationTypeID, setRelationTypeID] = useState('');
  const [constraint, setConstraint] = useState('0');
  const [peerAttributes, setPeerAttributes] = useState<TypeAttribute[]>([]);
  const [pairs, setPairs] = useState<AttributePair[]>([{ source: '', target: '' }]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void listRelationTypes()
      .then((rows) => {
        setTypes(rows);
        if (rows.length > 0) setRelationTypeID(String(rows[0].id));
      })
      .catch((error) => setErr(describeError(error, tr('无法读取关系类型', 'Could not load relation types'))));
  }, [tr]);

  useEffect(() => {
    if (!peer) {
      setPeerAttributes([]);
      setPairs([{ source: '', target: '' }]);
      return;
    }
    let cancelled = false;
    // Clear the positional mapping before the request settles so a pair from
    // the previous peer cannot be submitted against the new one.
    setPeerAttributes([]);
    setPairs([{ source: '', target: '' }]);
    void listTypeAttributes(peer)
      .then((got) => {
        if (!cancelled) setPeerAttributes(got.attributes ?? []);
      })
      .catch(() => {
        if (!cancelled) setPeerAttributes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [peer]);

  const submit = async () => {
    if (!peer) {
      setErr(tr('先选一个对端模型', 'Pick the other model first'));
      return;
    }
    if (!relationTypeID) {
      setErr(tr('先选一个关系类型', 'Pick a relation type first'));
      return;
    }
    if (pairs.some((pair) => Boolean(pair.source) !== Boolean(pair.target))) {
      setErr(tr('属性关联需要同时选择源属性和目标属性', 'An attribute association needs both a source and a target attribute'));
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      // THE CURRENT MODEL IS ONE HALF OF THE PAIR and the picked model the
      // other, which is the only thing "direction" means here.
      const parentRef = direction === 'children' ? modelRef : peer;
      const childRef = direction === 'children' ? peer : modelRef;
      const filled = pairs.filter((pair) => pair.source && pair.target);
      await saveRelation(parentRef, childRef, {
        relation_type_id: Number(relationTypeID),
        constraint,
        ...(filled.length > 0
          ? {
              parent_attr_ids: filled.map((pair) => Number(pair.source)),
              child_attr_ids: filled.map((pair) => Number(pair.target)),
            }
          : {}),
      });
      await onSaved(tr('已保存', 'Saved'));
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
      title={direction === 'children' ? tr('加一个子模型', 'Add a child model') : tr('加一个父模型', 'Add a parent model')}
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

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="cmdb-rel-peer">{tr('对端模型', 'Other model')}</Label>
          <Select
            id="cmdb-rel-peer"
            label={tr('对端模型', 'Other model')}
            value={peer}
            onValueChange={setPeer}
            options={models.map((model) => ({ value: String(model.id), label: model.alias || model.name }))}
            searchable
            className="mt-1 w-full"
          />
        </div>

        <div>
          <Label htmlFor="cmdb-rel-type">{tr('关系类型', 'Relation type')}</Label>
          <Select
            id="cmdb-rel-type"
            label={tr('关系类型', 'Relation type')}
            value={relationTypeID}
            onValueChange={setRelationTypeID}
            options={types.map((type) => ({ value: String(type.id), label: type.name }))}
            searchable
            className="mt-1 w-full"
          />
          {types.length === 0 && (
            <p className="mt-1 text-[11px] text-amber-400">
              {tr(
                '还没有关系类型。先在「关系类型」里建一个。',
                'No relation types yet. Create one under “Relation types” first.',
              )}
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="cmdb-rel-constraint">{tr('关系约束', 'Constraint')}</Label>
          <Select
            id="cmdb-rel-constraint"
            label={tr('关系约束', 'Constraint')}
            value={constraint}
            onValueChange={(next) => {
              setConstraint(next);
              // The list rules depend on the constraint, so clear the mappings.
              setPairs((current) => current.map((pair) => ({ ...pair, source: '', target: '' })));
            }}
            options={RELATION_CONSTRAINTS.map((item) => ({ value: item.value, label: tr(item.zh, item.en) }))}
            className="mt-1 w-40"
          />
          <p className="mt-1 text-[11px] text-text-faint">
            {tr(
              '基数决定同一种资源能不能挂多个父节点，也决定上架、迁移这类操作的拒绝条件。',
              'It decides whether one resource may sit under several parents, and it is what refuses an impossible placement.',
            )}
          </p>
        </div>

        {peer && (
          <RelationAttributePairs
            sourceAttributes={direction === 'children' ? attributes : peerAttributes}
            targetAttributes={direction === 'children' ? peerAttributes : attributes}
            pairs={pairs}
            onChange={setPairs}
            constraint={constraint}
            disabled={submitting}
            hint={tr(
              '可选；源属性来自父模型，目标属性来自子模型。',
              'Optional; source attributes come from the parent model and target attributes from the child.',
            )}
          />
        )}
      </div>
    </Modal>
  );
}

// --- uniqueness ---

export function ConstraintsTab({
  modelRef,
  attributes,
  isAdmin,
  adminTip,
}: {
  modelRef: string;
  attributes: TypeAttribute[];
  isAdmin: boolean;
  adminTip?: string;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const [rows, setRows] = useState<UniqueConstraint[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setRows(await listUniqueConstraints(modelRef));
    } catch (error) {
      setErr(describeError(error, tr('无法读取唯一约束', 'Could not load the uniqueness rules')));
    } finally {
      setLoading(false);
    }
  }, [modelRef, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (row: UniqueConstraint) => {
    const ok = await confirmAction(tr('删除这条唯一约束？', 'Delete this uniqueness rule?'));
    if (!ok) return;
    try {
      await deleteUniqueConstraint(modelRef, row.id);
      toast.success(tr('已删除', 'Deleted'));
      await load();
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const columns: Column<UniqueConstraint>[] = [
    {
      key: 'attrs',
      header: tr('这组属性不能重复', 'This combination must be unique'),
      width: 'w-full',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          {row.attributes.map((attribute) => (
            <Chip key={attribute.id}>{attribute.alias || attribute.name}</Chip>
          ))}
          {/* A SHORTER RESOLVED SET THAN THE STORED IDS is the backend's signal
              that the rule names an attribute which no longer exists. cantor
              dropped those silently; here the gap is visible. */}
          {row.attributes.length < row.attr_ids.length && (
            <Chip tone="warning">
              {tr(`${row.attr_ids.length - row.attributes.length} 个属性已不存在`, `${row.attr_ids.length - row.attributes.length} attribute(s) are gone`)}
            </Chip>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {tr(
            '唯一约束在写入时校验：不满足就拒绝。它与“标识属性”不同——标识属性只有一条，唯一约束可以有多组。',
            'A uniqueness rule is checked on write and the write is refused if it fails. It is not the identifying attribute: that is one, and there may be several rules.',
          )}
        </p>
        <Button variant="primary" size="sm" type="button" onClick={() => setCreating(true)} disabled={!isAdmin} className="inline-flex items-center gap-1.5">
          <Plus size={12} aria-hidden="true" />
          {tr('新建约束', 'New rule')}
        </Button>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={loading}
          error={err}
          onRetry={() => void load()}
          empty={tr('还没有唯一约束', 'No uniqueness rules yet')}
          actions={(row) => (
            <Hint content={adminTip}>
              <Button
                variant="dangerGhost"
                size="sm"
                type="button"
                onClick={() => void remove(row)}
                disabled={!isAdmin}
                aria-label={tr('删除这条约束', 'Delete this rule')}
                className="inline-flex items-center gap-1"
              >
                <Trash2 size={12} aria-hidden="true" />
                {tr('删除', 'Delete')}
              </Button>
            </Hint>
          )}
        />
      </Card>

      {creating && (
        <ConstraintModal
          modelRef={modelRef}
          attributes={attributes}
          onClose={() => setCreating(false)}
          onSaved={async (message) => {
            setCreating(false);
            toast.success(message);
            await load();
          }}
        />
      )}
      {dialog}
    </div>
  );
}

function ConstraintModal({
  modelRef,
  attributes,
  onClose,
  onSaved,
}: {
  modelRef: string;
  attributes: TypeAttribute[];
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const [selected, setSelected] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A MULTI-VALUED OR JSON ATTRIBUTE CANNOT BE PART OF A UNIQUENESS RULE: the
  // rule has no single value to compare. The backend refuses it, so the list
  // does not offer it rather than letting the operator find out on save.
  const eligible = attributes.filter((attribute) => !attribute.is_list && attribute.value_type !== '6');

  const submit = async () => {
    if (selected.length === 0) {
      setErr(tr('至少选一个属性', 'Pick at least one attribute'));
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      await createUniqueConstraint(modelRef, selected);
      await onSaved(tr('已创建', 'Created'));
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
      title={tr('新建唯一约束', 'New uniqueness rule')}
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
      <div className="max-h-64 overflow-y-auto rounded-md border border-border">
        {eligible.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-muted">
            {tr('没有可用的属性（多值与 JSON 属性不能参与唯一约束）', 'No eligible attributes (multi-valued and JSON attributes cannot take part)')}
          </p>
        ) : (
          eligible.map((attribute) => (
            <label key={attribute.id} className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-0 hover:bg-card">
              <Checkbox
                checked={selected.includes(attribute.id)}
                onCheckedChange={(next) =>
                  setSelected((current) => (next === true ? [...current, attribute.id] : current.filter((id) => id !== attribute.id)))
                }
              />
              <span className="min-w-0 flex-1 truncate">{attribute.alias || attribute.name}</span>
            </label>
          ))
        )}
      </div>
    </Modal>
  );
}

// --- triggers ---

// --- triggers ---

type TriggerEventCode = '0' | '1' | '2';

const TRIGGER_EVENTS: ReadonlyArray<{
  code: TriggerEventCode;
  zh: string;
  en: string;
  tone: 'success' | 'danger' | 'warning';
}> = [
  { code: '0', zh: '新增', en: 'Added', tone: 'success' },
  { code: '1', zh: '删除', en: 'Deleted', tone: 'danger' },
  { code: '2', zh: '修改', en: 'Updated', tone: 'warning' },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function triggerOption(row: Trigger): Record<string, unknown> {
  return asRecord(row.option);
}

function triggerName(row: Trigger): string {
  const name = triggerOption(row).name;
  return typeof name === 'string' && name.trim() ? name : `#${row.id}`;
}

function triggerDescription(row: Trigger): string {
  const description = triggerOption(row).description;
  return typeof description === 'string' ? description : '';
}

function triggerEvent(row: Trigger): TriggerEventCode | null {
  const action = triggerOption(row).action;
  return action === '0' || action === '1' || action === '2' ? action : null;
}

function triggerEventLabel(
  code: TriggerEventCode,
  tr: (zh: string, en: string) => string,
): string {
  const found = TRIGGER_EVENTS.find((event) => event.code === code);
  return found ? tr(found.zh, found.en) : code;
}

function triggerEventTone(code: TriggerEventCode): 'success' | 'danger' | 'warning' {
  return TRIGGER_EVENTS.find((event) => event.code === code)?.tone ?? 'warning';
}

function triggerIsDate(row: Trigger): boolean {
  return row.attr_id != null;
}

function triggerEnabled(row: Trigger): boolean {
  const value = triggerOption(row).enable;
  if (value === true || value === 1) return true;
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

function triggerTypeLabel(
  row: Trigger,
  tr: (zh: string, en: string) => string,
): string {
  return triggerIsDate(row) ? tr('日期提醒', 'Date reminder') : tr('数据变更', 'Data change');
}

export function TriggersTab({
  modelRef,
  attributes,
  isAdmin,
  adminTip,
}: {
  modelRef: string;
  attributes: TypeAttribute[];
  isAdmin: boolean;
  adminTip?: string;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const [rows, setRows] = useState<Trigger[]>([]);
  // The filter editor resolves reference attributes against the model
  // catalogue, so the trigger tab loads it alongside the list.
  const [models, setModels] = useState<CIType[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Trigger | 'new' | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  const [testing, setTesting] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [triggers, catalogue] = await Promise.all([
        listTriggers(modelRef),
        listCITypes().catch(() => [] as CIType[]),
      ]);
      setRows(triggers);
      setModels(catalogue);
    } catch (error) {
      setErr(describeError(error, tr('无法读取触发器', 'Could not load the triggers')));
    } finally {
      setLoading(false);
    }
  }, [modelRef, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (row: Trigger): Promise<boolean> => {
    const name = triggerName(row);
    const ok = await confirmAction(tr(`删除触发器「${name}」？`, `Delete the trigger “${name}”?`));
    if (!ok) return false;
    try {
      await deleteTrigger(modelRef, row.id);
      toast.success(tr('已删除', 'Deleted'));
      await load();
      return true;
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
      return false;
    }
  };

  // The switch is a one-field edit: everything else in the option document is
  // carried through untouched, including cantor's notify/date keys this build
  // does not dispatch.
  const toggleEnable = async (row: Trigger) => {
    if (!isAdmin || toggling === row.id) return;
    setToggling(row.id);
    try {
      await updateTrigger(modelRef, row.id, {
        attr_id: row.attr_id,
        option: { ...row.option, enable: !triggerEnabled(row) },
      });
      await load();
    } catch (error) {
      toast.error(describeError(error, tr('无法更新触发器', 'Could not update the trigger')));
    } finally {
      setToggling(null);
    }
  };

  const test = async (row: Trigger) => {
    if (!isAdmin || testing === row.id) return;
    setTesting(row.id);
    try {
      await testTrigger(modelRef, row.id);
      toast.success(tr('测试请求已发送', 'Test request sent'));
    } catch (error) {
      toast.error(describeError(error, tr('测试失败', 'Test failed')));
    } finally {
      setTesting(null);
    }
  };

  const columns: Column<Trigger>[] = [
    {
      key: 'name',
      header: tr('名称', 'Name'),
      width: 'w-[16rem]',
      cell: (row) => (
        <span className="block truncate font-semibold text-text" title={triggerName(row)}>
          {triggerName(row)}
        </span>
      ),
    },
    {
      key: 'description',
      header: tr('描述', 'Description'),
      width: 'w-full',
      cell: (row) => {
        const description = triggerDescription(row);
        return description ? (
          <span className="block truncate text-xs text-text-muted" title={description}>
            {description}
          </span>
        ) : (
          <span className="text-text-faint">—</span>
        );
      },
    },
    {
      key: 'type',
      header: tr('类型', 'Type'),
      width: 'w-[10rem]',
      cell: (row) => {
        const event = triggerEvent(row);
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <Chip tone={triggerIsDate(row) ? 'info' : 'default'} dense>
              {triggerTypeLabel(row, tr)}
            </Chip>
            {!triggerIsDate(row) && event && (
              <Chip tone={triggerEventTone(event)} dense>
                {triggerEventLabel(event, tr)}
              </Chip>
            )}
          </span>
        );
      },
    },
    {
      key: 'enable',
      header: tr('启用', 'Enabled'),
      width: 'w-[6rem]',
      cell: (row) => (
        <Switch
          checked={triggerEnabled(row)}
          disabled={!isAdmin || toggling === row.id}
          onCheckedChange={() => void toggleEnable(row)}
          aria-label={tr(`启用 ${triggerName(row)}`, `Enable ${triggerName(row)}`)}
        />
      ),
    },
  ];

  const editingTrigger = editing === 'new' ? null : editing;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs text-text-muted">
          {tr(
            '触发器在实例新增、删除或修改后执行。',
            'Triggers run after an instance is added, deleted or changed.',
          )}{' '}
          <span className="text-amber-600 dark:text-amber-300">
            {tr(
              '数据事件触发器会在实例写入后发送 Webhook；通知投递和日期触发器尚未接入。',
              'Data-event triggers send their webhook after an instance write; notification delivery and date triggers are not wired yet.',
            )}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-text-faint">
            {tr(`共 ${rows.length} 个触发器`, `${rows.length} triggers`)}
          </span>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => setEditing('new')}
            disabled={!isAdmin}
            className="inline-flex items-center gap-1.5"
          >
            <Plus size={12} aria-hidden="true" />
            {tr('新建触发器', 'New trigger')}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <DataTable
          fill
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={loading}
          error={err}
          onRetry={() => void load()}
          storageKey="model-triggers"
          empty={tr('还没有触发器', 'No triggers yet')}
          tableClassName="cmdb-instance-table"
          scrollerClassName="cmdb-instance-table-scroll"
          actions={(row) => {
            const testable =
              !triggerIsDate(row) && Object.keys(recordOf(triggerOption(row).webhooks)).length > 0;
            const testTip = testable
              ? adminTip
              : tr('只有 Webhook 触发器可以测试', 'Only webhook triggers can be tested');
            return (
              <>
                <Hint content={testTip}>
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    onClick={() => void test(row)}
                    disabled={!isAdmin || !testable || testing === row.id}
                    aria-label={tr(`测试触发器 ${triggerName(row)}`, `Test the trigger ${triggerName(row)}`)}
                    title={testable ? tr('测试', 'Test') : testTip}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-text-faint hover:text-indigo-600 dark:hover:text-indigo-300"
                  >
                    <Send size={13} aria-hidden="true" />
                  </Button>
                </Hint>
                <Hint content={adminTip}>
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    onClick={() => setEditing(row)}
                    disabled={!isAdmin}
                    aria-label={tr(`编辑触发器 ${triggerName(row)}`, `Edit the trigger ${triggerName(row)}`)}
                    title={tr('编辑', 'Edit')}
                    className="cmdb-liquid-action-edit inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </Button>
                </Hint>
                <Hint content={adminTip}>
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    onClick={() => void remove(row)}
                    disabled={!isAdmin}
                    aria-label={tr(`删除触发器 ${triggerName(row)}`, `Delete the trigger ${triggerName(row)}`)}
                    title={tr('删除', 'Delete')}
                    className="cmdb-liquid-action-danger inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </Button>
                </Hint>
              </>
            );
          }}
        />
      </div>

      {editing && (
        <TriggerDrawer
          modelRef={modelRef}
          row={editingTrigger}
          attributes={attributes}
          models={models}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            toast.success(message);
            await load();
          }}
          onDelete={
            editingTrigger
              ? async () => {
                  if (await remove(editingTrigger)) setEditing(null);
                }
              : undefined
          }
        />
      )}
      {dialog}
    </div>
  );
}

type TriggerCategory = 'data' | 'date';
type TriggerActionMode = 'notify' | 'webhook';

const TRIGGER_FORM_EVENTS: ReadonlyArray<{
  code: TriggerEventCode;
  zh: string;
  en: string;
}> = [
  { code: '0', zh: '新增实例', en: 'Instance added' },
  { code: '1', zh: '删除实例', en: 'Instance deleted' },
  { code: '2', zh: '实例变更', en: 'Instance changed' },
];

function parseEmails(raw: string): string[] {
  return raw
    .split(/[;,\s]+/)
    .map((email) => email.trim())
    .filter((email) => email.includes('@'));
}

function normalizeTos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const email = item.trim();
      if (email) out.push(email);
      continue;
    }
    const record = recordOf(item);
    if (typeof record.email === 'string' && record.email.trim()) {
      out.push(record.email.trim());
      continue;
    }
    // Cantor's employee tree stored an id here. Keep the identifier even though
    // this build has no employee directory, so editing the rest of the trigger
    // does not silently drop the recipient.
    if (record.employee_id != null) out.push(`employee:${String(record.employee_id)}`);
  }
  return [...new Set(out)];
}

function TriggerSegment<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange(next: T): void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="mt-1.5 inline-flex flex-wrap rounded-lg border border-border bg-card/50 p-0.5"
    >
      {options.map((option) => (
        <Button
          key={option.value}
          variant="plain"
          size="sm"
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled || option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs',
            value === option.value
              ? 'bg-indigo-500/15 text-indigo-600 shadow-sm dark:text-indigo-300'
              : 'text-text-muted hover:text-text',
          )}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function TriggerDrawer({
  modelRef,
  row,
  attributes,
  models,
  onClose,
  onSaved,
  onDelete,
}: {
  modelRef: string;
  row: Trigger | null;
  attributes: TypeAttribute[];
  models: CIType[];
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
  onDelete?(): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const option = useMemo(() => row?.option ?? {}, [row]);
  const notifies = recordOf(option.notifies);
  const hasWebhook = Object.keys(recordOf(option.webhooks)).length > 0;
  const isDate = Boolean(row && row.attr_id != null);
  const dateAttributes = useMemo(
    () => attributes.filter((attribute) => attribute.value_type === '3' || attribute.value_type === '4'),
    [attributes],
  );

  const initialWebhook = useMemo(() => {
    const config = webhookConfigOf(option.webhooks);
    if (row?.has_webhook_authorization && (config.auth_type === 'none' || !config.auth_type)) {
      return {
        ...config,
        auth_type: 'BasicAuth' as const,
        authorization: { ...config.authorization, type: 'BasicAuth' },
      };
    }
    return config;
  }, [option.webhooks, row?.has_webhook_authorization]);

  // Keep unknown channel values (cantor bots) so a save does not drop them.
  const initialMethods = Array.isArray(notifies.method)
    ? notifies.method.filter((method): method is string => typeof method === 'string')
    : [];

  const [name, setName] = useState(() => (typeof option.name === 'string' ? option.name : ''));
  const [description, setDescription] = useState(() =>
    typeof option.description === 'string' ? option.description : '',
  );
  const [enable, setEnable] = useState(() => (row ? triggerEnabled(row) : true));
  const [category, setCategory] = useState<TriggerCategory>(isDate ? 'date' : 'data');
  const [event, setEvent] = useState<TriggerEventCode>(() => {
    const value = option.action;
    return value === '0' || value === '1' || value === '2' ? value : '0';
  });
  const [attrIDs, setAttrIDs] = useState<number[]>(() =>
    Array.isArray(option.attr_ids)
      ? option.attr_ids
          .map((id) => Number(id))
          .filter((id) => Number.isSafeInteger(id) && id > 0)
      : [],
  );
  const [dateAttrID, setDateAttrID] = useState<number | null>(() => {
    if (isDate) return row?.attr_id ?? null;
    return dateAttributes[0]?.id ?? null;
  });
  const [beforeDays, setBeforeDays] = useState(() =>
    typeof notifies.before_days === 'number' ? notifies.before_days : 0,
  );
  const [notifyAt, setNotifyAt] = useState(() =>
    typeof notifies.notify_at === 'string' && notifies.notify_at ? notifies.notify_at : '08:00',
  );
  const [filter, setFilter] = useState(() =>
    typeof option.filter === 'string' ? option.filter : '',
  );
  const [actionMode, setActionMode] = useState<TriggerActionMode>(() => {
    if (isDate) return 'notify';
    return hasWebhook ? 'webhook' : 'notify';
  });
  const [webhook, setWebhook] = useState<WebhookConfig>(initialWebhook);
  const [recipientEmails, setRecipientEmails] = useState<string[]>(() => normalizeTos(notifies.tos));
  const [customEmail, setCustomEmail] = useState('');
  const [subject, setSubject] = useState(() =>
    typeof notifies.subject === 'string' ? notifies.subject : '',
  );
  const [body, setBody] = useState(() => (typeof notifies.body === 'string' ? notifies.body : ''));
  const [methods, setMethods] = useState<string[]>(() =>
    initialMethods.length ? initialMethods : ['email'],
  );
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setUsersLoading(true);
    void listUsers()
      .then((got) => {
        if (live) {
          setUsers(got.items ?? []);
          setUsersError(null);
        }
      })
      .catch((error) => {
        if (live) {
          setUsers([]);
          setUsersError(
            describeError(
              error,
              tr('无法读取员工列表；仍可填写自定义收件人。', 'Could not load people; custom recipients still work.'),
            ),
          );
        }
      })
      .finally(() => {
        if (live) setUsersLoading(false);
      });
    return () => {
      live = false;
    };
  }, [tr]);

  const changeCategory = (next: TriggerCategory) => {
    setCategory(next);
    if (next === 'date') {
      setActionMode('notify');
      if (dateAttrID == null) setDateAttrID(dateAttributes[0]?.id ?? null);
    }
  };

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (submitting) return;
    if (!name.trim()) {
      setErr(tr('名称不能为空', 'A name is required'));
      return;
    }
    if (category === 'date' && dateAttrID == null) {
      setErr(tr('请选择日期属性', 'Choose a date attribute'));
      return;
    }
    if (category === 'data' && actionMode === 'webhook' && !webhook.url.trim()) {
      setErr(tr('Webhook 地址不能为空', 'A webhook URL is required'));
      return;
    }

    const base: Record<string, unknown> = {
      ...option,
      name: name.trim(),
      description: description.trim(),
      enable,
      filter: filter.trim(),
    };
    const emails = [...new Set([...recipientEmails, ...parseEmails(customEmail)])];
    const notifyConfig: Record<string, unknown> = {
      tos: emails,
      subject: subject.trim(),
      body,
      body_html: body,
      method: methods.length ? methods : ['email'],
    };

    if (category === 'date') {
      delete base.action;
      delete base.attr_ids;
      delete base.webhooks;
      base.notifies = {
        ...notifyConfig,
        before_days: Math.max(0, beforeDays),
        notify_at: notifyAt || '08:00',
      };
    } else {
      base.action = event;
      if (event === '2') base.attr_ids = attrIDs;
      else delete base.attr_ids;

      if (actionMode === 'notify') {
        delete base.webhooks;
        base.notifies = notifyConfig;
      } else {
        delete base.notifies;
        const authType = webhook.auth_type ?? 'none';
        const initialAuthType = initialWebhook.auth_type ?? 'none';
        const values = authorizationValues(webhook.authorization);
        const nextWebhook: Record<string, unknown> = {
          method: webhook.method,
          url: webhook.url.trim(),
          parameters: webhook.parameters,
          headers: webhook.headers,
          body: webhook.body,
          auth_type: authType,
        };
        if (authType === 'none') {
          // An explicit None clears the stored credential.
          nextWebhook.authorization = {};
        } else if (Object.keys(values).length > 0) {
          nextWebhook.authorization = { type: authType, ...values };
        } else if (!(row?.has_webhook_authorization && authType === initialAuthType)) {
          // Changing the auth type without entering its values must not keep a
          // credential that belonged to the old type.
          nextWebhook.authorization = {};
        }
        base.webhooks = nextWebhook;
      }
    }

    const attrID = category === 'date' ? dateAttrID : null;
    setSubmitting(true);
    setErr(null);
    try {
      if (row) {
        await updateTrigger(modelRef, row.id, { attr_id: attrID, option: base });
      } else {
        await createTrigger(modelRef, { attr_id: attrID, option: base });
      }
      await onSaved(row ? tr('已保存', 'Saved') : tr('已创建', 'Created'));
    } catch (error) {
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open
      onClose={() => {
        if (!submitting) onClose();
      }}
      size="lg"
      title={row ? tr('编辑触发器', 'Edit trigger') : tr('新建触发器', 'New trigger')}
      description={row ? triggerName(row) : tr('配置触发条件和触发动作。', 'Configure the condition and the action.')}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              if (!submitting) onClose();
            }}
            disabled={submitting}
          >
            {tr('取消', 'Cancel')}
          </Button>
          {onDelete && (
            <Button
              variant="danger"
              type="button"
              onClick={() => void onDelete()}
              disabled={submitting}
            >
              {tr('删除', 'Delete')}
            </Button>
          )}
          <Button variant="primary" type="submit" form="cmdb-trigger-form" disabled={submitting}>
            {submitting ? tr('保存中…', 'Saving…') : tr('确定', 'Save')}
          </Button>
        </div>
      }
    >
      <form id="cmdb-trigger-form" onSubmit={(formEvent) => void submit(formEvent)} className="flex flex-col gap-5">
        {err && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            {err}
          </div>
        )}

        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {tr(
              '数据事件 + Webhook 触发器会在实例写入提交后发送请求；通知与日期触发器仍只保存配置。',
              'Data-event + webhook triggers send their request after an instance write commits; notification and date triggers still store configuration only.',
            )}
          </span>
        </div>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-text">{tr('基本信息', 'Basics')}</h3>
          <div>
            <Label htmlFor="cmdb-trigger-name">{tr('名称', 'Name')}</Label>
            <Input
              id="cmdb-trigger-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full"
              required
            />
          </div>
          <div>
            <span className="text-xs text-text-muted">{tr('类型', 'Type')}</span>
            <TriggerSegment
              label={tr('触发类型', 'Trigger type')}
              value={category}
              onChange={changeCategory}
              disabled={submitting}
              options={[
                { value: 'data', label: tr('数据变更', 'Data change') },
                {
                  value: 'date',
                  label: tr('日期属性', 'Date attribute'),
                  disabled: dateAttributes.length === 0,
                },
              ]}
            />
            <p className="mt-1 text-[11px] text-text-faint">
              {category === 'data'
                ? tr('当 CI 实例新增、删除或属性变更时触发。', 'Fires when an instance is added, deleted or changed.')
                : tr('在日期属性到期前提醒。', 'Reminds before a date attribute is due.')}
            </p>
            {dateAttributes.length === 0 && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">
                {tr('这个模型没有日期或时间属性，不能创建日期提醒。', 'This model has no date attribute, so it cannot hold a date reminder.')}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="cmdb-trigger-description">{tr('描述', 'Description')}</Label>
            <Textarea
              id="cmdb-trigger-description"
              rows={2}
              value={description}
              placeholder={tr('请输入描述', 'Optional description')}
              onChange={(event) => setDescription(event.target.value)}
              className="mt-1 w-full"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="cmdb-trigger-enabled"
              checked={enable}
              onCheckedChange={(next) => setEnable(next)}
              disabled={submitting}
            />
            <Label htmlFor="cmdb-trigger-enabled">{tr('启用', 'Enabled')}</Label>
          </div>
        </section>

        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="text-xs font-semibold text-text">{tr('触发条件', 'Trigger condition')}</h3>
          {category === 'date' ? (
            <>
              <div>
                <Label htmlFor="cmdb-trigger-date-attr">{tr('日期属性', 'Date attribute')}</Label>
                <Select
                  id="cmdb-trigger-date-attr"
                  label={tr('日期属性', 'Date attribute')}
                  value={dateAttrID != null ? String(dateAttrID) : ''}
                  onValueChange={(next) => setDateAttrID(next ? Number(next) : null)}
                  options={dateAttributes.map((attribute) => ({
                    value: String(attribute.id),
                    label: attribute.alias || attribute.name,
                  }))}
                  placeholder={tr('选择日期属性…', 'Choose a date attribute…')}
                  className="mt-1 w-full"
                  disabled={submitting || dateAttributes.length === 0}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="cmdb-trigger-before-days">{tr('提前天数', 'Days before')}</Label>
                  <Input
                    id="cmdb-trigger-before-days"
                    type="number"
                    min={0}
                    value={beforeDays}
                    onChange={(event) => setBeforeDays(Number(event.target.value) || 0)}
                    className="mt-1 w-full"
                    disabled={submitting}
                  />
                </div>
                <div>
                  <Label htmlFor="cmdb-trigger-notify-at">{tr('通知时间', 'Notify at')}</Label>
                  <Input
                    id="cmdb-trigger-notify-at"
                    type="time"
                    value={notifyAt}
                    onChange={(event) => setNotifyAt(event.target.value)}
                    className="mt-1 w-full"
                    disabled={submitting}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <span className="text-xs text-text-muted">{tr('事件', 'Event')}</span>
                <TriggerSegment
                  label={tr('触发事件', 'Trigger event')}
                  value={event}
                  onChange={(next) => setEvent(next as TriggerEventCode)}
                  disabled={submitting}
                  options={TRIGGER_FORM_EVENTS.map((item) => ({
                    value: item.code,
                    label: tr(item.zh, item.en),
                  }))}
                />
                <p className="mt-1 text-[11px] text-text-faint">
                  {tr(
                    '选择后可指定监听哪些字段的变更。',
                    'Choose the fields this trigger watches when an instance changes.',
                  )}
                </p>
              </div>
              {event === '2' && (
                <div>
                  <span className="text-xs text-text-muted">
                    {tr('模型属性', 'Model attributes')}
                  </span>
                  <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border">
                    {attributes.map((attribute) => (
                      <label
                        key={attribute.id}
                        className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-xs last:border-0 hover:bg-card"
                      >
                        <Checkbox
                          checked={attrIDs.includes(attribute.id)}
                          disabled={submitting}
                          onCheckedChange={(next) =>
                            setAttrIDs((current) =>
                              next === true
                                ? [...current, attribute.id]
                                : current.filter((id) => id !== attribute.id),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{attribute.alias || attribute.name}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-text-faint">
                    {tr('不选表示任何属性变化都触发。', 'Selecting none means any attribute change fires it.')}
                  </p>
                </div>
              )}
            </>
          )}

          <div>
            <span className="text-xs text-text-muted">{tr('过滤条件', 'Filter')}</span>
            <div className="mt-1.5">
              <ConditionFilter attributes={attributes} models={models} value={filter} onApply={setFilter} />
            </div>
            {filter && (
              <code className="mt-2 block break-all rounded-md border border-border bg-card/40 px-3 py-2 font-mono text-[10px] text-text-faint">
                {filter}
              </code>
            )}
          </div>
        </section>

        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="text-xs font-semibold text-text">{tr('触发动作', 'Action')}</h3>
          {category === 'date' ? (
            <p className="rounded-md border border-border bg-card/40 px-3 py-2 text-[11px] text-text-muted">
              {tr(
                '日期属性通过通知提醒：到达提前天数后，在每天的通知时间发送。',
                'A date attribute uses a notification: it is sent daily at the notify time once the lead days are reached.',
              )}
            </p>
          ) : (
            <TriggerSegment
              label={tr('动作方式', 'Action type')}
              value={actionMode}
              onChange={(next) => setActionMode(next as TriggerActionMode)}
              disabled={submitting}
              options={[
                { value: 'notify', label: tr('通知', 'Notify') },
                { value: 'webhook', label: tr('Webhook', 'Webhook') },
              ]}
            />
          )}

          {actionMode === 'notify' || category === 'date' ? (
            <TriggerNotifyEditor
              users={users}
              usersLoading={usersLoading}
              usersError={usersError}
              recipientEmails={recipientEmails}
              onRecipientEmailsChange={setRecipientEmails}
              customEmail={customEmail}
              onCustomEmailChange={setCustomEmail}
              subject={subject}
              onSubjectChange={setSubject}
              body={body}
              onBodyChange={setBody}
              methods={methods}
              onMethodsChange={setMethods}
              attributes={attributes}
              disabled={submitting}
            />
          ) : (
            <TriggerWebhookEditor
              value={webhook}
              onChange={setWebhook}
              hasStoredAuth={Boolean(row?.has_webhook_authorization)}
              disabled={submitting}
            />
          )}
        </section>
      </form>
    </Drawer>
  );
}
