import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Copy,
  Info,
  Link2,
  ListTree,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState, EmptyStateCard } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';

import { describeError } from '../../api/http';
import {
  deleteTarget,
  getTargetHealth,
  listComponentAttributes,
  listDiscoverableAttributes,
  listHTTPAttributes,
  listRules,
  listSNMPAttributes,
  listTargetRelations,
  listTargets,
  replaceTargetRelations,
  updateTarget,
  type RelationReplaceResult,
  type Rule,
  type Target,
  type TargetHealthAgent,
  type TargetHealth as TargetHealthResponse,
  type TargetInput,
  type TargetRelation,
  type TargetTypeCount,
} from '../../api/discovery';
import {
  listTypeAttributes,
  relationChildren,
  relationParents,
  type RelatedType,
  type TypeAttribute,
} from '../../api/citype';
import { CMDBIcon } from '../CMDBIcon';
import { DataTable, type Column } from '../DataTable';
import { useToast } from '../Toast';
import { TargetDrawer } from './TargetDrawer';
import { CronField } from './CronField';
import { RuleDrawer } from './RulesPanel';
import {
  ruleCategory,
  ruleCategoryLabel,
  ruleCollectKey,
  ruleIconValue,
  ruleProviderKey,
} from './rulePresentation';
import {
  cmdbTimeValue,
  editableRelations,
  mappingKeys,
  mappingPayload,
  relationPayload,
  sameMapping,
  targetMapping,
  uniqueMapped,
  type EditableRelation,
} from './modelAutoDiscovery';

// The model's own auto-discovery page.
//
// THE MODEL IS THE UNIT AN OPERATOR THINKS IN. A rule answers "what can this
// provider report"; a target answers "which fields of this model does it fill";
// and the relation rows answer "which field points at which other model". All
// three are properties of THIS model, so they live under it instead of sending
// the operator to a global list and back.
//
// THE AGENT PULLS; THIS PAGE ONLY CONFIGURES THE PULL. The health panel reads
// the handover log the collector writes when it syncs, which is what makes
// "nobody has pulled this target yet" a visible answer rather than a silent
// configuration mistake.

type View = 'attributes' | 'relations';
type Mode = 'agent' | 'query' | 'all';

type FieldMeta = {
  name: string;
  type?: string;
  desc?: string;
  example?: unknown;
};

function modeOf(target: Target): Mode {
  if (target.agent_id.trim()) return 'agent';
  if (target.query_expr.trim()) return 'query';
  return 'all';
}

function targetAlias(target: Target): string {
  const alias = target.extra_option?.alias;
  return typeof alias === 'string' ? alias : '';
}

function targetLabel(target: Target, rule: Rule | undefined): string {
  return targetAlias(target) || target.adr_name || rule?.name || `#${target.adr_id}`;
}

function ruleCategoryText(tr: (zh: string, en: string) => string, rule: Rule): string {
  return ruleCategoryLabel(tr, ruleCategory(rule));
}

export function ModelAutoDiscovery({
  modelRef,
  modelLabel,
  isAdmin,
}: {
  modelRef: string;
  modelLabel: string;
  isAdmin: boolean;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();

  const [view, setView] = useState<View>('attributes');
  const [rules, setRules] = useState<Rule[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [uniqueKey, setUniqueKey] = useState('');
  const [typeID, setTypeID] = useState<number | null>(null);
  const [discoverable, setDiscoverable] = useState<string[]>([]);
  const [discoverableErr, setDiscoverableErr] = useState<string | null>(null);
  const [selectedID, setSelectedID] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingRuleID, setCreatingRuleID] = useState<number | null>(null);
  const [editing, setEditing] = useState<Target | null>(null);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [creatingRule, setCreatingRule] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (!modelRef) return;
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      setDiscoverableErr(null);
      try {
        const [gotRules, gotTargets, gotAttributes, gotDiscoverable] = await Promise.all([
          listRules(),
          listTargets(modelRef),
          listTypeAttributes(modelRef),
          listDiscoverableAttributes(modelRef).catch((error) => {
            setDiscoverableErr(
              describeError(error, tr('无法读取可发现字段', 'Could not load discoverable fields')),
            );
            return [] as string[];
          }),
        ]);
        setRules(gotRules);
        setTargets(gotTargets);
        setAttributes(gotAttributes.attributes ?? []);
        setUniqueKey(gotAttributes.unique ?? '');
        setTypeID(gotAttributes.type_id ?? null);
        setDiscoverable(gotDiscoverable);
        setSelectedID((current) => {
          if (current != null && gotTargets.some((target) => target.id === current)) return current;
          return gotTargets[0]?.id ?? null;
        });
      } catch (error) {
        setErr(describeError(error, tr('无法读取自动发现配置', 'Could not load auto-discovery')));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [modelRef, tr],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const ruleByID = useMemo(() => new Map(rules.map((rule) => [rule.id, rule])), [rules]);
  const selected = useMemo(
    () => targets.find((target) => target.id === selectedID) ?? null,
    [targets, selectedID],
  );
  const selectedRule = selected ? ruleByID.get(selected.adr_id) : undefined;

  const drawerType: TargetTypeCount = {
    type_id: typeID ?? Number(modelRef),
    name: modelLabel,
    target_count: targets.length,
  };

  const remove = async (target: Target) => {
    const label = targetLabel(target, ruleByID.get(target.adr_id));
    const ok = await confirmAction(
      tr(
        `删除「${label}」的发现目标？采集器将不再拉取它，已经发现的数据不会被删除。`,
        `Delete the “${label}” discovery target? Collectors will stop pulling it; data already discovered is left alone.`,
      ),
    );
    if (!ok) return;
    try {
      await deleteTarget(target.id);
      toast.success(tr('目标已删除', 'Target deleted'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除目标失败', 'Could not delete the target')));
    }
  };

  const openPicker = () => {
    if (rules.length === 0) {
      setCreatingRule(true);
      return;
    }
    setPickerOpen(true);
  };

  if (loading && targets.length === 0 && rules.length === 0) {
    return (
      <Card>
        <div className="flex items-center gap-2 px-4 py-8 text-xs text-text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {tr('加载自动发现配置…', 'Loading auto-discovery…')}
        </div>
      </Card>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {err && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          <span>{err}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => void load()}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}

      <Tabs value={view} onValueChange={(next) => setView(next as View)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList className="w-fit overflow-visible rounded-lg border border-border bg-card/50 p-0.5">
            <TabsTrigger
              value="attributes"
              className="rounded-md border-b-0 px-3 py-1.5 data-[active]:bg-indigo-500/15 data-[active]:text-indigo-600 dark:data-[active]:text-indigo-300"
            >
              {tr('属性自动发现', 'Attribute discovery')}
            </TabsTrigger>
            <TabsTrigger
              value="relations"
              className="rounded-md border-b-0 px-3 py-1.5 data-[active]:bg-indigo-500/15 data-[active]:text-indigo-600 dark:data-[active]:text-indigo-300"
            >
              {tr('关系自动发现', 'Relation discovery')}
            </TabsTrigger>
          </TabsList>
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              to="/cmdb/adc"
              className="og-button inline-flex items-center gap-1.5"
              data-variant="outline"
              data-size="sm"
            >
              <ScanLine size={12} aria-hidden="true" />
              {tr('发现池', 'Discovery pool')}
            </Link>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                setRefreshNonce((current) => current + 1);
                void load(true);
              }}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
              {tr('刷新', 'Refresh')}
            </Button>
          </div>
        </div>

        <TabsContent value="attributes" className="pt-3">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {targets.map((target) => {
                const rule = ruleByID.get(target.adr_id);
                const active = target.id === selectedID;
                return (
                  <button
                    key={target.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelectedID(target.id)}
                    className={cn(
                      'inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
                      active
                        ? 'border-indigo-500 bg-indigo-500 text-white shadow-sm'
                        : 'border-border bg-card/40 text-text-muted hover:bg-card hover:text-text',
                    )}
                  >
                    <CMDBIcon value={rule ? ruleIconValue(rule) : ''} size={13} label={targetLabel(target, rule)} />
                    <span className="max-w-[14rem] truncate">{targetLabel(target, rule)}</span>
                    {!target.enabled && (
                      <span className={cn('text-[10px]', active ? 'text-white/75' : 'text-text-faint')}>
                        {tr('停用', 'Off')}
                      </span>
                    )}
                  </button>
                );
              })}
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={openPicker}
                className="inline-flex items-center gap-1 border-dashed"
              >
                <Plus size={12} aria-hidden="true" />
                {tr('添加自动发现', 'Add discovery')}
              </Button>
            </div>

            {selected ? (
              <TargetEditor
                key={`${selected.id}-${selected.updated_at ?? ''}`}
                target={selected}
                rule={selectedRule}
                attributes={attributes}
                uniqueKey={uniqueKey}
                discoverableErr={discoverableErr}
                refreshKey={refreshNonce}
                isAdmin={isAdmin}
                onEdit={() => setEditing(selected)}
                onEditRule={() => setEditingRule(selectedRule ?? null)}
                onDelete={() => void remove(selected)}
                onSaved={async (message) => {
                  toast.success(message);
                  await load(true);
                }}
              />
            ) : (
              <EmptyStateCard
                icon={ScanLine}
                title={
                  rules.length
                    ? tr('这个模型还没有发现目标', 'This model has no discovery target yet')
                    : tr('还没有可用的发现规则', 'No discovery rule is available yet')
                }
                hint={
                  rules.length
                    ? tr(
                        `把一条发现规则绑定到「${modelLabel}」，并决定提供方字段写进哪些模型属性。`,
                        `Bind a discovery rule to “${modelLabel}” and decide which model attributes the provider's fields become.`,
                      )
                    : tr(
                        '规则描述采集什么；先创建规则，再把它绑定到模型。',
                        'A rule describes what to collect. Create one first, then bind it to a model.',
                      )
                }
                action={
                  <Button
                    variant="primary"
                    size="sm"
                    type="button"
                    onClick={openPicker}
                    className="inline-flex items-center gap-1.5"
                  >
                    {rules.length ? <Plus size={12} aria-hidden="true" /> : <ScanLine size={12} aria-hidden="true" />}
                    {rules.length ? tr('添加发现目标', 'Add discovery target') : tr('新建发现规则', 'Create a discovery rule')}
                  </Button>
                }
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="relations" className="pt-3">
          <RelationEditor
            modelRef={modelRef}
            modelLabel={modelLabel}
            sourceKeys={discoverable}
            sourceErr={discoverableErr}
            refreshKey={refreshNonce}
          />
        </TabsContent>
      </Tabs>

      {pickerOpen && (
        <RulePicker
          rules={rules}
          onClose={() => setPickerOpen(false)}
          onPick={(rule) => {
            setPickerOpen(false);
            setCreatingRuleID(rule.id);
          }}
          onCreateRule={() => {
            setPickerOpen(false);
            setCreatingRule(true);
          }}
        />
      )}

      {creatingRuleID != null && (
        <TargetDrawer
          type={drawerType}
          target={null}
          initialRuleID={creatingRuleID}
          onClose={() => setCreatingRuleID(null)}
          onSaved={async (message) => {
            setCreatingRuleID(null);
            toast.success(message);
            await load(true);
          }}
        />
      )}

      {editing && (
        <TargetDrawer
          type={drawerType}
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            toast.success(message);
            await load(true);
          }}
        />
      )}

      {editingRule && (
        <RuleDrawer
          rule={editingRule}
          onClose={() => setEditingRule(null)}
          onSaved={async (message) => {
            setEditingRule(null);
            toast.success(message);
            await load(true);
          }}
        />
      )}

      {creatingRule && (
        <RuleDrawer
          rule={null}
          onClose={() => setCreatingRule(false)}
          onSaved={async (message) => {
            setCreatingRule(false);
            toast.success(message);
            await load(true);
          }}
        />
      )}

      {dialog}
    </div>
  );
}

// --- the attribute mapping and execution form ---

function SectionHeading({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text">
          <span className="size-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
          {title}
        </h3>
        <p className="mt-1 text-[11px] text-text-muted">{hint}</p>
      </div>
    </div>
  );
}

function TargetEditor({
  target,
  rule,
  attributes,
  uniqueKey,
  discoverableErr,
  refreshKey,
  isAdmin,
  onEdit,
  onEditRule,
  onDelete,
  onSaved,
}: {
  target: Target;
  rule: Rule | undefined;
  attributes: TypeAttribute[];
  uniqueKey: string;
  discoverableErr: string | null;
  refreshKey: number;
  isAdmin: boolean;
  onEdit(): void;
  onEditRule(): void;
  onDelete(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const [mapping, setMapping] = useState<Record<string, string>>(() => targetMapping(target));
  const [catalogFields, setCatalogFields] = useState<FieldMeta[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [extraKeys, setExtraKeys] = useState<string[]>([]);
  const [customKey, setCustomKey] = useState('');
  const [mode, setMode] = useState<Mode>(() => modeOf(target));
  const [agentID, setAgentID] = useState(target.agent_id ?? '');
  const [queryExpr, setQueryExpr] = useState(target.query_expr ?? '');
  const [cron, setCron] = useState(target.cron ?? '');
  const [autoAccept, setAutoAccept] = useState(target.auto_accept);
  const [enabled, setEnabled] = useState(target.enabled);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const category = typeof target.extra_option?.category === 'string' ? target.extra_option.category : '';

  useEffect(() => {
    let live = true;
    setCatalogFields([]);
    setCatalogErr(null);
    setCatalogLoading(false);
    if (!rule) return () => { live = false; };
    const apply = (fields: FieldMeta[]) => {
      if (live) {
        setCatalogFields(fields);
        setCatalogLoading(false);
      }
    };
    const fail = (error: unknown) => {
      if (live) {
        setCatalogErr(describeError(error, tr('无法读取提供方字段', 'Could not load the provider fields')));
        setCatalogLoading(false);
      }
    };

    if (rule.type === 'snmp') {
      setCatalogLoading(true);
      void listSNMPAttributes().then(apply).catch(fail);
    } else if (rule.type === 'components') {
      setCatalogLoading(true);
      void listComponentAttributes(ruleCollectKey(rule)).then(apply).catch(fail);
    } else if (rule.type === 'http' && category) {
      setCatalogLoading(true);
      void listHTTPAttributes(ruleProviderKey(rule), category).then(apply).catch(fail);
    }
    return () => {
      live = false;
    };
  }, [category, rule, tr]);

  const fieldByKey = useMemo(() => {
    const fields = new Map<string, FieldMeta>();
    for (const field of catalogFields) fields.set(field.name, field);
    // A rule's own field list describes the provider better than a catalogue
    // fallback, so it wins on a duplicate name.
    for (const field of rule?.attributes ?? []) fields.set(field.name, field);
    return fields;
  }, [catalogFields, rule]);

  const keys = useMemo(
    () => mappingKeys(rule ?? null, target, catalogFields.map((field) => field.name), [], extraKeys),
    [catalogFields, extraKeys, rule, target],
  );
  const payload = mappingPayload(mapping);
  const matchedCount = keys.filter((key) => (mapping[key] ?? '').trim() !== '').length;
  const missingUnique = Boolean(uniqueKey) && !uniqueMapped(payload, uniqueKey);
  const usesCollector = rule?.type === 'http' || rule?.type === 'snmp';
  const dirty =
    !sameMapping(mapping, targetMapping(target)) ||
    mode !== modeOf(target) ||
    (mode === 'agent' && agentID.trim() !== (target.agent_id ?? '').trim()) ||
    (mode === 'query' && queryExpr.trim() !== (target.query_expr ?? '').trim()) ||
    cron.trim() !== (target.cron ?? '').trim() ||
    autoAccept !== target.auto_accept ||
    enabled !== target.enabled;

  const addCustomKey = () => {
    const key = customKey.trim();
    if (!key) return;
    setExtraKeys((current) => (current.includes(key) ? current : [...current, key]));
    setCustomKey('');
  };

  const reset = () => {
    setMapping(targetMapping(target));
    setExtraKeys([]);
    setCustomKey('');
    setMode(modeOf(target));
    setAgentID(target.agent_id ?? '');
    setQueryExpr(target.query_expr ?? '');
    setCron(target.cron ?? '');
    setAutoAccept(target.auto_accept);
    setEnabled(target.enabled);
    setFormErr(null);
  };

  const save = async () => {
    setFormErr(null);
    if (missingUnique) {
      setFormErr(
        tr(
          `模型的标识属性「${uniqueKey}」必须出现在映射里。`,
          `The model's identifying attribute “${uniqueKey}” must appear among the mapped fields.`,
        ),
      );
      return;
    }
    if (mode === 'agent' && !agentID.trim()) {
      setFormErr(tr('指定 Agent 方式需要填写 Agent ID。', 'A named-agent target needs an agent id.'));
      return;
    }
    if (mode === 'query' && !queryExpr.trim()) {
      setFormErr(tr('按查询选择方式需要填写查询表达式。', 'A query-scoped target needs a query expression.'));
      return;
    }
    if (mode === 'all' && !isAdmin) {
      setFormErr(tr('只有管理员可以创建对所有采集器生效的目标。', 'Only an administrator may target every collector.'));
      return;
    }
    if (enabled && !cron.trim()) {
      setFormErr(tr('启用目标需要填写 Cron 表达式。', 'An enabled target needs a cron expression.'));
      return;
    }

    const input: TargetInput = {
      attributes: payload,
      auto_accept: autoAccept,
      agent_id: mode === 'agent' ? agentID.trim() : '',
      query_expr: mode === 'query' ? queryExpr.trim() : '',
      cron: cron.trim(),
      enabled,
    };

    setSaving(true);
    try {
      const saved = await updateTarget(target.id, input);
      setMapping(targetMapping(saved));
      setMode(modeOf(saved));
      setAgentID(saved.agent_id ?? '');
      setQueryExpr(saved.query_expr ?? '');
      setCron(saved.cron ?? '');
      setAutoAccept(saved.auto_accept);
      setEnabled(saved.enabled);
      await onSaved(tr('发现目标已保存', 'Discovery target saved'));
    } catch (error) {
      setFormErr(describeError(error, tr('保存发现目标失败', 'Could not save the discovery target')));
    } finally {
      setSaving(false);
    }
  };

  const label = targetLabel(target, rule);
  const modeOptions: Array<{ value: Mode; label: string; hint: string; disabled?: boolean }> = [
    {
      value: 'all',
      label: tr('所有机器', 'Every collector'),
      hint: tr('在所有符合条件的采集器上运行', 'Runs on every eligible collector'),
      disabled: !isAdmin,
    },
    {
      value: 'agent',
      label: tr('指定节点', 'Named collector'),
      hint: tr('只在一台指定采集器上运行', 'Runs on one named collector'),
    },
    {
      value: 'query',
      label: tr('从 CMDB 中选取', 'Match from CMDB'),
      hint: tr('用查询表达式匹配采集器', 'Selects collectors with a query'),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {formErr && (
        <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {formErr}
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 p-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <CMDBIcon value={rule ? ruleIconValue(rule) : ''} size={18} label={label} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h2 className="min-w-0 truncate text-sm font-medium text-text">{label}</h2>
                {rule ? <Chip tone={target.is_plugin ? 'accent' : 'info'}>{ruleCategoryText(tr, rule)}</Chip> : null}
                {target.adr_missing && <Chip tone="warning">{tr('规则已不存在', 'Rule is gone')}</Chip>}
                {!target.enabled && <Chip>{tr('停用', 'Disabled')}</Chip>}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-faint">
                <span>{tr('目标', 'Target')} #{target.id}</span>
                {rule?.unique_key && <span>{tr('规则标识字段', 'Rule key')} <code className="font-mono">{rule.unique_key}</code></span>}
                {uniqueKey && <span>{tr('模型标识属性', 'Model key')} <code className="font-mono">{uniqueKey}</code></span>}
                <span>{tr('提供方字段', 'Provider fields')} {keys.length}</span>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" type="button" onClick={onEdit} className="inline-flex items-center gap-1">
              <Pencil size={12} aria-hidden="true" />
              {tr('编辑目标', 'Edit target')}
            </Button>
            <Button
              variant="dangerGhost"
              size="sm"
              type="button"
              onClick={onDelete}
              aria-label={tr('删除发现目标', 'Delete discovery target')}
              title={tr('删除发现目标', 'Delete discovery target')}
              className="size-7 px-0"
            >
              <Trash2 size={12} aria-hidden="true" />
            </Button>
            <label className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[11px] text-text-muted">
              <Switch
                aria-label={tr('启用目标', 'Enable target')}
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              {tr('启用', 'Enabled')}
            </label>
          </div>
        </div>

        <div className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading
              icon={<ListTree size={15} aria-hidden="true" />}
              title={tr('属性映射', 'Attribute mapping')}
              hint={tr(
                '选择每个发现字段写入哪个模型属性；留空表示不写入。',
                'Choose the model attribute each discovered field fills; leave it empty to drop the field.',
              )}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={keys.length > 0 && matchedCount === keys.length ? 'success' : 'warning'}>
                {tr(`${matchedCount}/${keys.length} 已匹配`, `${matchedCount}/${keys.length} mapped`)}
              </Chip>
              {rule && !rule.is_inner && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={onEditRule}
                  className="inline-flex items-center gap-1"
                >
                  <Pencil size={12} aria-hidden="true" />
                  {tr('编辑规则', 'Edit rule')}
                </Button>
              )}
            </div>
          </div>

          {(catalogErr || discoverableErr) && (
            <p role="alert" className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
              {catalogErr || discoverableErr}
            </p>
          )}
          {catalogLoading && (
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-text-faint">
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {tr('读取提供方字段…', 'Loading provider fields…')}
            </p>
          )}

          {keys.length === 0 ? (
            <p className="mt-3 rounded-lg border border-border px-3 py-5 text-xs text-text-muted">
              {tr(
                '还没有可映射的提供方字段。可以在下面手动添加字段，或先编辑目标选择云资源类型。',
                'No provider fields are known yet. Add a field below by hand, or edit the target to choose a cloud resource kind.',
              )}
            </p>
          ) : (
            <div className="mt-3 overflow-hidden rounded-lg border border-border">
              <div className="hidden grid-cols-[minmax(0,1fr)_2rem_minmax(0,1.15fr)] gap-2 border-b border-border bg-card/40 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-text-faint sm:grid">
                <span>{tr('模型属性', 'Model attribute')}</span>
                <span aria-hidden="true" />
                <span>{tr('自动发现', 'Discovered field')}</span>
              </div>
              {keys.map((key) => {
                const field = fieldByKey.get(key);
                const identity = uniqueKey !== '' && (mapping[key] ?? '').trim() === uniqueKey;
                const detail =
                  field?.desc ||
                  (field?.example !== undefined ? `${tr('示例', 'Example')}: ${String(field.example)}` : '');
                return (
                  <div
                    key={key}
                    className="grid grid-cols-1 gap-2 border-b border-border/60 px-3 py-2.5 last:border-0 sm:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1.15fr)] sm:items-center"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={cn('w-2 shrink-0 text-center text-xs font-bold', identity ? 'text-red-500' : 'invisible')}
                      >
                        *
                      </span>
                      <Select
                        aria-label={tr(`映射 ${key}`, `Map ${key}`)}
                        label={tr(`映射 ${key}`, `Map ${key}`)}
                        value={mapping[key] ?? ''}
                        onValueChange={(value) => setMapping((current) => ({ ...current, [key]: value }))}
                        options={[
                          { value: '', label: tr('（不映射）', '(unmapped)') },
                          ...attributes.map((attribute) => ({
                            value: attribute.name,
                            label:
                              attribute.name === uniqueKey
                                ? `${attribute.alias || attribute.name} · ${tr('标识', 'key')}`
                                : attribute.alias || attribute.name,
                          })),
                        ]}
                        searchable={attributes.length > 10}
                        className="w-full"
                      />
                    </div>
                    <div className="hidden items-center justify-center gap-1 text-indigo-500/60 sm:flex" aria-hidden="true">
                      <span className="w-3 border-t border-dashed border-current" />
                      <ArrowRight size={12} />
                    </div>
                    <div className="min-w-0 rounded-md border border-border/70 bg-card/40 px-2.5 py-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <code className="truncate font-mono text-[11px] text-text">{key}</code>
                        {field?.type && <Chip dense>{field.type}</Chip>}
                        {identity && <Chip dense tone="warning">{tr('标识', 'Key')}</Chip>}
                      </div>
                      {detail && (
                        <p className="mt-0.5 truncate text-[10px] text-text-faint" title={detail}>
                          {detail}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {missingUnique && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-300">
              {tr(
                `模型的标识属性「${uniqueKey}」必须出现在映射里。`,
                `The model’s identifying attribute “${uniqueKey}” must appear among the mapped fields.`,
              )}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              aria-label={tr('添加提供方字段', 'Add provider field')}
              placeholder={tr('手动添加提供方字段', 'Add a provider field by hand')}
              value={customKey}
              onChange={(event) => setCustomKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCustomKey();
                }
              }}
              className="w-56 font-mono"
            />
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={addCustomKey}
              disabled={!customKey.trim() || keys.includes(customKey.trim())}
              className="inline-flex items-center gap-1"
            >
              <Plus size={12} aria-hidden="true" />
              {tr('添加字段', 'Add field')}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-4 p-4">
          <SectionHeading
            icon={<SlidersHorizontal size={15} aria-hidden="true" />}
            title={tr('执行配置', 'Execution')}
            hint={tr(
              '决定哪些采集器拉取这个目标，以及多久拉取一次。',
              'Which collectors pull this target, and how often.',
            )}
          />

          <div role="radiogroup" aria-label={tr('执行目标', 'Execution scope')} className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {modeOptions.map((option) => {
              const active = mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={option.disabled}
                  onClick={() => setMode(option.value)}
                  className={cn(
                    'flex min-w-0 items-start gap-2 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
                    active
                      ? 'border-indigo-500/50 bg-indigo-500/10'
                      : 'border-border bg-card/40 hover:bg-card',
                    option.disabled && 'cursor-not-allowed opacity-50',
                    option.value === 'query' && 'sm:col-span-2 xl:col-span-1',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                      active ? 'border-indigo-500' : 'border-text-faint',
                    )}
                  >
                    {active && <span className="size-1.5 rounded-full bg-indigo-500" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-text">{option.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-text-faint">{option.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {mode === 'agent' && (
            <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3">
              <Label htmlFor={`cmdb-model-discovery-agent-${target.id}`}>{tr('采集器 ID', 'Collector ID')}</Label>
              <Input
                id={`cmdb-model-discovery-agent-${target.id}`}
                value={agentID}
                onChange={(event) => setAgentID(event.target.value)}
                placeholder="0x..."
                className="mt-1 w-full font-mono"
              />
              <p className="mt-1 text-[11px] text-text-faint">
                {tr('填写 euler ID；只有这一台采集器会拉取该目标。', 'The euler ID; only this collector pulls the target.')}
              </p>
            </div>
          )}

          {mode === 'query' && (
            <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3">
              <Label htmlFor={`cmdb-model-discovery-query-${target.id}`}>{tr('查询表达式', 'Query expression')}</Label>
              <Input
                id={`cmdb-model-discovery-query-${target.id}`}
                value={queryExpr}
                onChange={(event) => setQueryExpr(event.target.value)}
                className="mt-1 w-full font-mono"
              />
              <p className="mt-1 text-[11px] text-text-faint">
                {tr('用 CMDB 查询匹配运行该目标的采集器实例。', 'Match collector instances with a CMDB query.')}
              </p>
            </div>
          )}

          <label className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-xs font-medium text-text">{tr('自动接受', 'Auto-accept')}</span>
              <span className="mt-0.5 block text-[11px] text-text-faint">
                {tr('发现后直接写入资源数据，不再逐条确认。', 'Write discoveries straight into resource data instead of confirming each one.')}
              </span>
            </span>
            <Switch
              aria-label={tr('自动接受', 'Auto-accept')}
              checked={autoAccept}
              onCheckedChange={setAutoAccept}
            />
          </label>

          <CronField
            id={`cmdb-model-discovery-cron-${target.id}`}
            value={cron}
            onChange={setCron}
          />

          {mode === 'all' && (
            <p className="text-[11px] text-text-faint">
              {tr('全部采集器是管理操作：目标会在每个符合条件的采集器上运行。', 'Every collector is an administrative scope: the target runs on every eligible collector.')}
            </p>
          )}
          {usesCollector && mode !== 'agent' && (
            <p className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] text-text-muted">
              {tr(
                '云平台 / SNMP 目标必须绑定具体采集器；全部采集器或查询表达式不会把它们下发给主机采集器。',
                'Cloud and SNMP targets must name a collector. Every-collector and query scopes do not hand them to a host collector.',
              )}
            </p>
          )}
        </div>
      </Card>

      <TargetHealth target={target} refreshKey={refreshKey} dirty={dirty} />

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-bg/95 px-1 py-3 backdrop-blur">
        <p className="text-[11px] text-text-faint">
          {tr('保存后，采集器在下一次同步时拿到新配置。', 'After saving, a collector receives the new configuration on its next sync.')}
        </p>
        <div className="flex flex-wrap items-center gap-2 pe-32">
          <Button variant="outline" size="sm" type="button" onClick={reset} disabled={saving}>
            {tr('重置', 'Reset')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => void save()}
            disabled={saving || missingUnique}
          >
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- the collector health panel ---

function TargetHealth({
  target,
  refreshKey,
  dirty,
}: {
  target: Target;
  refreshKey: number;
  dirty: boolean;
}) {
  const { tr } = useI18n();
  const [health, setHealth] = useState<TargetHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setHealth(await getTargetHealth(target.id));
    } catch (error) {
      setErr(describeError(error, tr('无法读取采集健康', 'Could not load collector health')));
    } finally {
      setLoading(false);
    }
  }, [target.id, tr]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const agents = health?.agents ?? [];
  const onlineCount = agents.filter((agent) => agent.online).length;
  const handovers = agents
    .map((agent) => agent.last_handover_at)
    .filter((value): value is string => Boolean(value))
    .sort();
  const latestHandover = handovers.length > 0 ? handovers[handovers.length - 1] : '';
  const windowMinutes = Math.max(1, Math.round((health?.online_window_seconds ?? 600) / 60));

  const timeAgo = (raw?: string) => {
    const ms = cmdbTimeValue(raw);
    return ms == null ? (raw ?? '—') : relativeTime(new Date(ms));
  };

  const columns: Column<TargetHealthAgent>[] = [
    {
      key: 'collector',
      header: tr('采集器', 'Collector'),
      width: 'w-full',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-text">{row.euler_name || tr('未命名采集器', 'Unnamed collector')}</span>
          <code className="truncate font-mono text-[10px] text-text-faint">{row.euler_id || '—'}</code>
        </span>
      ),
    },
    {
      key: 'status',
      header: tr('状态', 'Status'),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          {!row.registered ? (
            <Chip tone="warning">{tr('未注册', 'Not registered')}</Chip>
          ) : row.online ? (
            <Chip tone="success">{tr('在线', 'Online')}</Chip>
          ) : (
            <Chip>{tr('离线', 'Offline')}</Chip>
          )}
          {row.registered && !row.eligible && <Chip>{tr('不再匹配', 'No longer matches')}</Chip>}
        </span>
      ),
    },
    {
      key: 'seen',
      header: tr('最近心跳', 'Last heartbeat'),
      cell: (row) => (
        <span className="whitespace-nowrap text-text-muted" title={row.last_seen_at || ''}>
          {timeAgo(row.last_seen_at)}
        </span>
      ),
    },
    {
      key: 'handover',
      header: tr('最近下发', 'Last handover'),
      cell: (row) => (
        <span className="whitespace-nowrap text-text-muted" title={row.last_handover_at || ''}>
          {timeAgo(row.last_handover_at)}
        </span>
      ),
    },
  ];

  const summary = loading
    ? tr('读取中…', 'Loading…')
    : err
      ? err
      : agents.length > 0
      ? tr(
          `共 ${agents.length} 个采集器，${onlineCount} 个在线${latestHandover ? `，最近下发 ${latestHandover}` : ''}。`,
          `${agents.length} collector(s), ${onlineCount} online${latestHandover ? `, last handover ${latestHandover}` : ''}.`,
        )
      : health?.warnings?.[0] ||
        tr(
          '还没有符合条件的采集器。确认目标绑定了采集器，且采集器已注册并连接到 riemann。',
          'No collector matches this target yet. Check that the target names a collector, and that the collector is enrolled and connected to riemann.',
        );

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500/15 to-sky-400/15 text-indigo-600 dark:text-indigo-300">
              <Activity size={16} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text">
                <span className="size-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
                {tr('健康检查', 'Health check')}
              </h3>
              <p className="mt-1 text-[11px] text-text-muted">
                {dirty
                  ? tr('检查前请先保存当前配置。', 'Save the current configuration before checking.')
                  : tr('检查采集器同步状态和最近下发记录。', 'Check collector sync status and the latest handover.')}
              </p>
            </div>
          </div>
        </div>
        <div className="px-4 pb-4">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-text">{tr('执行机器同步规则检查', 'Collector sync check')}</span>
                <Chip tone="info">
                  {tr(`每 ${windowMinutes} 分钟自动同步`, `Syncs every ${windowMinutes} minutes`)}
                </Chip>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">
                {tr(
                  '快速查看发现规则在各执行节点上的实时同步状态和最近下发记录。',
                  'See each eligible collector’s live status and the latest task handover.',
                )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                setOpen(true);
                void load();
              }}
              disabled={dirty || loading}
              title={dirty ? tr('请先保存当前配置', 'Save the current configuration first') : undefined}
              className="inline-flex shrink-0 items-center gap-1"
            >
              <Search size={12} aria-hidden="true" />
              {tr('触发检查', 'Run check')}
            </Button>
          </div>
          {!err && <p className="mt-2 text-[11px] text-text-faint">{summary}</p>}
          {err && (
            <p role="alert" className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
              {err}
            </p>
          )}
        </div>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={tr(`采集健康 · 目标 #${target.id}`, `Collector health · target #${target.id}`)}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={12} className={cn(loading && 'animate-spin')} aria-hidden="true" />
              {tr('刷新', 'Refresh')}
            </Button>
            <Button variant="primary" type="button" onClick={() => setOpen(false)}>
              {tr('关闭', 'Close')}
            </Button>
          </div>
        }
      >
        <p className="mb-3 flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] text-text-muted">
          <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {tr(
            `在线状态来自采集器心跳，最近 ${windowMinutes} 分钟没有心跳视为离线；最近下发来自任务交接记录。检查只读，不会触发采集。`,
            `Online status comes from the collector heartbeat; no heartbeat in the last ${windowMinutes} minutes reads as offline. The last handover comes from the task log. This check is read-only and does not start a collection.`,
          )}
        </p>
        {health?.warnings && health.warnings.length > 0 && (
          <ul className="mb-3 flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-300">
            {health.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <DataTable
          columns={columns}
          rows={agents}
          rowKey={(row) => row.euler_id}
          loading={loading}
          error={err}
          onRetry={() => void load()}
          empty={tr('还没有符合条件的采集器。', 'No collector matches this target yet.')}
          hideColumnPicker
        />
      </Modal>
    </>
  );
}

// --- the rule picker ---

function RulePicker({
  rules,
  onPick,
  onClose,
  onCreateRule,
}: {
  rules: Rule[];
  onPick(rule: Rule): void;
  onClose(): void;
  onCreateRule(): void;
}) {
  const { tr } = useI18n();
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const filtered = rules.filter((rule) => {
    if (!needle) return true;
    const haystack = `${rule.name} ${rule.type ?? ''} ${rule.unique_key ?? ''} ${ruleProviderKey(rule)}`.toLowerCase();
    return haystack.includes(needle);
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={tr('选择发现规则', 'Choose a discovery rule')}
      footer={
        <Button variant="outline" type="button" onClick={onClose}>
          {tr('取消', 'Cancel')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">
          {tr(
            '规则决定采集什么；下一步再选择字段映射和执行方式。',
            'The rule decides what to collect; the next step chooses the field mapping and execution scope.',
          )}
        </p>
        <Input
          type="search"
          aria-label={tr('搜索发现规则', 'Search discovery rules')}
          placeholder={tr('搜索名称、类型或标识字段', 'Search by name, type or identifying field')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {filtered.length === 0 ? (
          <EmptyState
            icon={ScanLine}
            title={rules.length ? tr('没有匹配的规则', 'No matching rule') : tr('还没有发现规则', 'No discovery rule yet')}
            hint={
              rules.length
                ? tr('换一个关键词试试。', 'Try a different search term.')
                : tr('先创建一条规则，再把它绑定到模型。', 'Create a rule first, then bind it to a model.')
            }
            action={
              rules.length ? undefined : (
                <Button variant="primary" size="sm" type="button" onClick={onCreateRule}>
                  {tr('打开规则配置', 'Open rule configuration')}
                </Button>
              )
            }
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((rule) => (
              <li key={rule.id}>
                <button
                  type="button"
                  onClick={() => onPick(rule)}
                  className="flex w-full min-w-0 items-start gap-2.5 rounded-md border border-border bg-card/40 px-3 py-2 text-left transition-colors hover:bg-card focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                >
                  <CMDBIcon value={ruleIconValue(rule)} size={16} label={rule.name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-text">{rule.name}</span>
                      <Chip tone={rule.is_plugin ? 'accent' : 'info'}>{ruleCategoryText(tr, rule)}</Chip>
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-text-faint">
                      {rule.unique_key && <span>{tr('标识', 'Key')} <code className="font-mono">{rule.unique_key}</code></span>}
                      <span>{tr('字段', 'Fields')} {rule.attribute_count}</span>
                    </span>
                  </span>
                  <ArrowRight size={14} className="mt-0.5 shrink-0 text-text-faint" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// --- the relation editor ---

type Peer = {
  id: number;
  label: string;
  attributes: TypeAttribute[];
};

function mergePeers(groups: RelatedType[][]): Peer[] {
  const peers = new Map<number, Peer>();
  for (const group of groups) {
    for (const relation of group) {
      const type = relation.type;
      if (!type) continue;
      const existing = peers.get(type.id);
      if (!existing) {
        peers.set(type.id, {
          id: type.id,
          label: type.alias || type.name || `#${type.id}`,
          attributes: [...(relation.attributes ?? [])],
        });
        continue;
      }
      for (const attribute of relation.attributes ?? []) {
        if (!existing.attributes.some((item) => item.id === attribute.id)) {
          existing.attributes.push(attribute);
        }
      }
    }
  }
  return [...peers.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function RelationEditor({
  modelRef,
  modelLabel,
  sourceKeys,
  sourceErr,
  refreshKey,
}: {
  modelRef: string;
  modelLabel: string;
  sourceKeys: string[];
  sourceErr: string | null;
  refreshKey: number;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction } = useDialogs();
  const keyRef = useRef(0);
  const makeKey = useCallback(() => `relation-${++keyRef.current}`, []);

  const [relations, setRelations] = useState<TargetRelation[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [rows, setRows] = useState<EditableRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [gotRelations, gotChildren, gotParents] = await Promise.all([
        listTargetRelations(modelRef),
        relationChildren(modelRef),
        relationParents(modelRef),
      ]);
      const gotPeers = mergePeers([gotChildren, gotParents]);
      // A stored relation whose peer model is no longer related stays visible
      // and saveable instead of disappearing from a form that still holds it.
      for (const relation of gotRelations) {
        const peerID = relation.peer_type_id ?? 0;
        if (peerID && !gotPeers.some((peer) => peer.id === peerID)) {
          gotPeers.push({ id: peerID, label: tr('模型 #%d', 'Model #%d').replace('%d', String(peerID)), attributes: [] });
        }
      }
      setRelations(gotRelations);
      setPeers(gotPeers);
      setRows(editableRelations(gotRelations, makeKey));
    } catch (error) {
      setErr(describeError(error, tr('无法读取关系自动发现', 'Could not load relation discovery')));
    } finally {
      setLoading(false);
    }
  }, [makeKey, modelRef, tr]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const sourceOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (key: string | undefined) => {
      const value = key?.trim();
      if (value && !seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    };
    for (const key of sourceKeys) add(key);
    for (const relation of relations) add(relation.ad_key);
    return out;
  }, [relations, sourceKeys]);

  const peerOptions = useMemo(
    () => peers.map((peer) => ({ value: String(peer.id), label: peer.label })),
    [peers],
  );

  const patch = (key: string, next: Partial<EditableRelation>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...next } : row)));
  };

  const add = () => setRows((current) => [...current, { key: makeKey(), adKey: '', peerTypeID: '', peerAttrID: '' }]);
  const copy = (row: EditableRelation) =>
    setRows((current) => [...current, { ...row, key: makeKey() }]);
  const remove = (key: string) =>
    setRows((current) => {
      const next = current.filter((row) => row.key !== key);
      return next.length > 0 ? next : [{ key: makeKey(), adKey: '', peerTypeID: '', peerAttrID: '' }];
    });

  const peerAttributes = (row: EditableRelation): TypeAttribute[] =>
    peers.find((peer) => String(peer.id) === row.peerTypeID)?.attributes ?? [];

  const save = async () => {
    setFormErr(null);
    const got = relationPayload(rows);
    if (got.error === 'incomplete') {
      setFormErr(tr('每一行都要选好发现字段、对端模型和对端属性。', 'Every row needs a discovery field, peer model and peer attribute.'));
      return;
    }
    if (got.error === 'duplicate') {
      setFormErr(tr('同一组关系出现了两次。', 'The same relation appears twice.'));
      return;
    }
    if (got.relations.length === 0 && relations.length > 0) {
      const ok = await confirmAction(
        tr('清空这个模型的全部自动发现关系？', 'Remove every auto-discovered relation of this model?'),
      );
      if (!ok) return;
    }

    setSaving(true);
    try {
      const result: RelationReplaceResult = await replaceTargetRelations(modelRef, got.relations);
      toast.success(
        tr(
          `已保存：新增 ${result.added} 条，移除 ${result.removed} 条`,
          `Saved: ${result.added} added, ${result.removed} removed`,
        ),
      );
      await load();
    } catch (error) {
      setFormErr(describeError(error, tr('保存关系自动发现失败', 'Could not save relation discovery')));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 px-4 py-8 text-xs text-text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {tr('读取关系自动发现…', 'Loading relation discovery…')}
        </div>
      </Card>
    );
  }

  if (err) {
    return (
      <Card>
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-red-600 dark:text-red-300">
          <span>{err}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => void load()}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      </Card>
    );
  }

  if (peers.length === 0 && relations.length === 0) {
    return (
      <EmptyStateCard
        icon={Link2}
        title={tr('还没有可用于自动发现的关系', 'No relation is available for auto-discovery')}
        hint={tr(
          `先为「${modelLabel}」建立模型关系，采集到的字段才能连到其他模型的实例。`,
          `Create a model relation for “${modelLabel}” first; a discovered field can only link to instances of a related model.`,
        )}
        action={
          <Link
            to={`/cmdb/models/${encodeURIComponent(modelRef)}?tab=relations`}
            className="og-button inline-flex items-center gap-1.5 text-xs"
            data-variant="primary"
            data-size="sm"
          >
            <Link2 size={12} aria-hidden="true" />
            {tr('打开模型关系', 'Open model relations')}
          </Link>
        }
      />
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] text-text-muted">
          <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {tr(
              '发现字段的值会匹配对端模型的属性，并在接纳实例时建立关系。这里保存的是模型的整组关系配置。',
              'A discovered field’s value is matched against the peer model’s attribute and becomes a relation when the instance is accepted. Saving replaces the model’s whole relation set.',
            )}
          </span>
        </div>

        {formErr && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            {formErr}
          </div>
        )}

        {sourceErr && (
          <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
            {sourceErr}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {rows.map((row, index) => {
            const attributeOptions = peerAttributes(row).map((attribute) => ({
              value: String(attribute.id),
              label: attribute.alias || attribute.name,
            }));
            if (row.peerAttrID && !attributeOptions.some((option) => option.value === row.peerAttrID)) {
              attributeOptions.push({ value: row.peerAttrID, label: `#${row.peerAttrID}` });
            }
            return (
              <div key={row.key} className="rounded-md border border-border bg-card/30 p-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
                  <div className="min-w-0">
                    <Label htmlFor={`${row.key}-source`}>{tr('发现字段', 'Discovery field')}</Label>
                    <Select
                      id={`${row.key}-source`}
                      label={tr('发现字段', 'Discovery field')}
                      value={row.adKey}
                      onValueChange={(value) => patch(row.key, { adKey: value })}
                      options={[
                        { value: '', label: tr('（选择字段）', '(choose a field)') },
                        ...sourceOptions.map((key) => ({ value: key, label: key })),
                      ]}
                      searchable={sourceOptions.length > 10}
                      className="mt-1 w-full font-mono"
                    />
                  </div>
                  <div className="min-w-0">
                    <Label htmlFor={`${row.key}-peer`}>{tr('对端模型', 'Peer model')}</Label>
                    <Select
                      id={`${row.key}-peer`}
                      label={tr('对端模型', 'Peer model')}
                      value={row.peerTypeID}
                      onValueChange={(value) => patch(row.key, { peerTypeID: value, peerAttrID: '' })}
                      options={[{ value: '', label: tr('（选择模型）', '(choose a model)') }, ...peerOptions]}
                      searchable={peerOptions.length > 10}
                      className="mt-1 w-full"
                    />
                  </div>
                  <div className="min-w-0">
                    <Label htmlFor={`${row.key}-attr`}>{tr('对端属性', 'Peer attribute')}</Label>
                    <Select
                      id={`${row.key}-attr`}
                      label={tr('对端属性', 'Peer attribute')}
                      value={row.peerAttrID}
                      onValueChange={(value) => patch(row.key, { peerAttrID: value })}
                      options={[{ value: '', label: tr('（选择属性）', '(choose an attribute)') }, ...attributeOptions]}
                      searchable={attributeOptions.length > 10}
                      disabled={!row.peerTypeID}
                      className="mt-1 w-full"
                    />
                  </div>
                  <div className="flex items-center gap-1 md:pb-0.5">
                    <Button
                      variant="subtle"
                      size="sm"
                      type="button"
                      onClick={() => copy(row)}
                      aria-label={tr(`复制第 ${index + 1} 条关系`, `Copy relation ${index + 1}`)}
                      title={tr('复制', 'Copy')}
                      className="size-7 rounded-full px-0"
                    >
                      <Copy size={12} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="subtle"
                      size="sm"
                      type="button"
                      onClick={() => remove(row.key)}
                      aria-label={tr(`删除第 ${index + 1} 条关系`, `Delete relation ${index + 1}`)}
                      title={tr('删除', 'Delete')}
                      className="size-7 rounded-full px-0"
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {sourceOptions.length === 0 && (
          <p className="text-[11px] text-text-faint">
            {tr(
              '还没有可用的发现字段。先在属性自动发现里配置一个带字段映射的目标。',
              'No discovery field is available yet. Configure a target with a field mapping under attribute discovery first.',
            )}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <Button variant="outline" size="sm" type="button" onClick={add} className="inline-flex items-center gap-1">
            <Plus size={12} aria-hidden="true" />
            {tr('添加关系', 'Add relation')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={saving}>
            {saving ? tr('保存中…', 'Saving…') : tr('保存关系', 'Save relations')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
