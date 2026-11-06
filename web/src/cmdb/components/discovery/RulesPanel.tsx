import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Pencil, Plus, RefreshCw, Search, Trash2, UserRound } from 'lucide-react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';
import { cn } from '@/lib/cn';

import { describeError } from '../../api/http';
import {
  createRule,
  deleteRule,
  ensureBuiltinRules,
  listAccounts,
  listRules,
  replaceAccounts,
  updateRule,
  type Account,
  type AccountInput,
  type Rule,
  type RuleInput,
} from '../../api/discovery';
import { parseIconValue } from '../../lib/iconvalue';
import { CMDBIcon } from '../CMDBIcon';
import { Drawer } from '../Drawer';
import { IconPicker } from '../IconPicker';
import { useToast } from '../Toast';
import { AccountConfigDialog } from './AccountConfigDialog';
import {
  RULE_CATEGORY_ORDER,
  ruleCategory,
  ruleCategoryLabel,
  ruleHasAccountConfig,
  ruleIconValue,
  ruleProviderKey,
  ruleResources,
  type RuleCategory,
} from './rulePresentation';

// 规则 — what can be discovered.
//
// A RULE IS A TEMPLATE, NOT A JOB: it says a provider exists and which fields
// it reports. The job is a target, on the next tab. Keeping them apart is what
// makes one provider usable by several models without copying its credentials.

const RULE_TYPES = ['http', 'snmp', 'agent', 'components'] as const;

function ruleTypeLabel(tr: (zh: string, en: string) => string, type: string): string {
  switch (type) {
    case 'http':
      return tr('HTTP 接口', 'HTTP API');
    case 'snmp':
      return 'SNMP';
    case 'agent':
      return tr('Agent 采集', 'Agent');
    case 'components':
      return tr('组件', 'Component');
    default:
      return type || tr('未指定', 'Unspecified');
  }
}

export function RulesPanel() {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();

  const [rows, setRows] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Rule | 'new' | 'new-plugin' | null>(null);
  const [accountRule, setAccountRule] = useState<Rule | null>(null);
  const [ensuring, setEnsuring] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | RuleCategory>('all');

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      try {
        setRows(await listRules());
      } catch (error) {
        setErr(describeError(error, tr('无法读取发现规则', 'Could not load the discovery rules')));
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

  const adminTip = isAdmin ? undefined : tr('需要管理员权限', 'Administrator role required');

  const remove = async (row: Rule) => {
    const ok = await confirmAction(
      tr(`删除规则「${row.name}」？使用它的目标会失去提供方。`, `Delete the rule “${row.name}”? Targets built on it lose their provider.`),
    );
    if (!ok) return;
    try {
      await deleteRule(row.id);
      toast.success(tr('已删除', 'Deleted'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const ensureBuiltins = async () => {
    setEnsuring(true);
    try {
      const got = await ensureBuiltinRules();
      toast.success(
        tr(`新建 ${got.created?.length ?? 0} 个内置规则，已存在 ${got.existing?.length ?? 0} 个。`,
          `Created ${got.created?.length ?? 0} built-in rules; ${got.existing?.length ?? 0} were already there.`),
      );
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('生成内置规则失败', 'Could not create the built-in rules')));
    } finally {
      setEnsuring(false);
    }
  };

  const searching = query.trim() !== '';

  const counts = useMemo(() => {
    const out = Object.fromEntries(RULE_CATEGORY_ORDER.map((key) => [key, 0])) as Record<
      RuleCategory,
      number
    >;
    for (const row of rows) out[ruleCategory(row)] += 1;
    return out;
  }, [rows]);

  // THE COUNTS STAY ON THE WHOLE SET while a search narrows the cards, so the
  // chips do not jump around on every keystroke.
  const categories = RULE_CATEGORY_ORDER.filter((key) => counts[key] > 0);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (category !== 'all' && ruleCategory(row) !== category) return false;
      if (!needle) return true;
      const haystack = [row.name, row.type ?? '', row.unique_key ?? '', ruleProviderKey(row)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, query, category]);

  const sections = RULE_CATEGORY_ORDER.map((key) => ({
    key,
    rows: visible.filter((row) => ruleCategory(row) === key),
  })).filter((section) => section.rows.length > 0);

  // THE PLUGIN SECTION IS THE ONLY ONE A PERSON ADDS TO, so it keeps an empty
  // state of its own with the add tile, exactly as cantor's grid did. It is
  // hidden while searching: a search is about what exists, not what could.
  const showPluginTile = isAdmin && !searching && (category === 'all' || category === 'plugin');
  if (showPluginTile && !sections.some((section) => section.key === 'plugin') && rows.length > 0) {
    sections.push({ key: 'plugin', rows: [] });
  }

  const clearFilters = () => {
    setQuery('');
    setCategory('all');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search
            size={13}
            className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-text-faint"
            aria-hidden="true"
          />
          <Input
            aria-label={tr('搜索规则', 'Search rules')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr('搜索规则名称或标识字段', 'Search by rule or identifying field')}
            className="w-full ps-8"
          />
        </div>

        <div
          role="group"
          aria-label={tr('规则分类', 'Rule categories')}
          className="flex flex-wrap items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          <CategoryTab
            active={category === 'all'}
            label={tr('全部', 'All')}
            count={rows.length}
            onClick={() => setCategory('all')}
          />
          {categories.map((key) => (
            <CategoryTab
              key={key}
              active={category === key}
              label={ruleCategoryLabel(tr, key)}
              count={counts[key]}
              onClick={() => setCategory(key)}
            />
          ))}
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => void ensureBuiltins()}
            disabled={!isAdmin || ensuring}
            className="inline-flex items-center gap-1.5"
          >
            {ensuring ? tr('生成中…', 'Creating…') : tr('生成内置规则', 'Create built-in rules')}
          </Button>
          <Hint content={adminTip}>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => setEditing('new')}
              disabled={!isAdmin}
              className="inline-flex items-center gap-1.5"
            >
              <Plus size={12} aria-hidden="true" />
              {tr('新建规则', 'New rule')}
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
      </div>

      {err && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300"
        >
          <span className="min-w-0 flex-1 break-words">{err}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => void load()}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && rows.length === 0 ? (
          <p className="py-16 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-card/40">
            <EmptyState
              icon={Search}
              title={tr('还没有发现规则', 'No discovery rules yet')}
              hint={tr(
                '新建一条规则，或先创建内置的提供方规则。',
                'Create a rule, or start from the built-in providers.',
              )}
              action={
                isAdmin ? (
                  <Button variant="primary" size="sm" type="button" onClick={() => setEditing('new')}>
                    <Plus size={12} aria-hidden="true" />
                    {tr('新建规则', 'New rule')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : sections.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-card/40">
            <EmptyState
              icon={Search}
              title={tr('没有匹配的规则', 'No rules match')}
              hint={tr('换个关键词，或清除当前的分类筛选。', 'Try another term, or clear the category filter.')}
              action={
                <Button variant="outline" size="sm" type="button" onClick={clearFilters}>
                  {tr('清除筛选', 'Clear filters')}
                </Button>
              }
            />
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {sections.map((section) => {
              const headingID = `cmdb-discovery-category-${section.key}`;
              return (
                <section key={section.key} aria-labelledby={headingID} className="min-w-0">
                  <div className="mb-2 flex items-center gap-2">
                    <h2 id={headingID} className="text-sm font-semibold text-text">
                      {ruleCategoryLabel(tr, section.key)}
                    </h2>
                    {section.rows.length > 0 && (
                      <span className="text-[11px] tabular-nums text-text-faint">
                        {section.rows.length}
                      </span>
                    )}
                    <span className="h-px min-w-4 flex-1 bg-border/50" aria-hidden="true" />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {section.rows.map((row) => (
                      <RuleCard
                        key={row.id}
                        rule={row}
                        isAdmin={isAdmin}
                        adminTip={adminTip}
                        onEdit={() => setEditing(row)}
                        onDelete={() => void remove(row)}
                        onAccounts={
                          ruleHasAccountConfig(row) ? () => setAccountRule(row) : undefined
                        }
                      />
                    ))}
                    {section.key === 'plugin' && showPluginTile && (
                      <button
                        type="button"
                        onClick={() => setEditing('new-plugin')}
                        aria-label={tr('添加插件规则', 'Add a plugin rule')}
                        className="flex min-h-[9rem] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-text-faint transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/5 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
                      >
                        <Plus size={18} aria-hidden="true" />
                        <span className="text-xs">{tr('添加插件', 'Add plugin')}</span>
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {accountRule && (
        <AccountConfigDialog rule={accountRule} onClose={() => setAccountRule(null)} />
      )}

      {editing && (
        <RuleDrawer
          rule={editing === 'new' || editing === 'new-plugin' ? null : editing}
          defaultPlugin={editing === 'new-plugin'}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            toast.success(message);
            await load(true);
          }}
        />
      )}
      {dialog}
    </div>
  );
}

function CategoryTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
        active ? 'bg-text/10 font-medium text-text' : 'text-text-muted hover:bg-text/5 hover:text-text',
      )}
    >
      {label}
      <span className="text-[10px] tabular-nums text-text-faint">{count}</span>
    </button>
  );
}

function RuleCard({
  rule,
  isAdmin,
  adminTip,
  onEdit,
  onDelete,
  onAccounts,
}: {
  rule: Rule;
  isAdmin: boolean;
  adminTip?: string;
  onEdit(): void;
  onDelete(): void;
  onAccounts?(): void;
}) {
  const { tr } = useI18n();
  const resources = ruleResources(rule);
  const editLabel = tr(`编辑 ${rule.name}`, `Edit ${rule.name}`);
  const deleteLabel = tr(`删除 ${rule.name}`, `Delete ${rule.name}`);
  const accountsLabel = tr(`账号配置 ${rule.name}`, `Account settings for ${rule.name}`);

  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-border/60 bg-card/40 p-3 transition-colors hover:border-border hover:bg-card/60">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card">
          <CMDBIcon value={ruleIconValue(rule)} size={18} label={rule.name} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-text" title={rule.name}>
            {rule.name}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <code className="font-mono text-[10px] text-text-faint">{rule.type || '—'}</code>
            {rule.is_inner && <Chip dense>{tr('内置', 'Built-in')}</Chip>}
            {rule.is_plugin && (
              <Chip tone="info" dense>
                {tr('插件', 'Plugin')}
              </Chip>
            )}
          </div>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div className="min-w-0">
          <dt className="text-[10px] text-text-faint">{tr('标识字段', 'Identifying field')}</dt>
          <dd
            className="mt-0.5 truncate font-mono text-[11px] text-text-muted"
            title={rule.unique_key || '—'}
          >
            {rule.unique_key || '—'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] text-text-faint">{tr('字段数', 'Fields')}</dt>
          <dd className="mt-0.5 text-[11px] tabular-nums text-text-muted">{rule.attribute_count}</dd>
        </div>
      </dl>

      {resources.length > 0 && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1 text-[10px] text-text-faint">
          <Layers size={11} aria-hidden="true" />
          <span>{tr(`${resources.length} 个资源`, `${resources.length} resources`)}</span>
          {resources.slice(0, 2).map((item) => (
            <span
              key={item}
              title={item}
              className="inline-block max-w-[7.5rem] truncate rounded bg-text/5 px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
            >
              {item}
            </span>
          ))}
          {resources.length > 2 && <span aria-hidden="true">…</span>}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/40 pt-2.5">
        <span className="font-mono text-[10px] text-text-faint">#{rule.id}</span>
        <span className="flex items-center gap-1">
          {onAccounts && (
            <Button
              variant="subtle"
              size="sm"
              type="button"
              onClick={onAccounts}
              aria-label={accountsLabel}
              title={accountsLabel}
              className="inline-flex size-7 items-center justify-center p-0"
            >
              <UserRound size={12} aria-hidden="true" />
            </Button>
          )}
          <Hint content={adminTip}>
            <Button
              variant="subtle"
              size="sm"
              type="button"
              onClick={onEdit}
              disabled={!isAdmin}
              aria-label={editLabel}
              title={editLabel}
              className="inline-flex size-7 items-center justify-center p-0"
            >
              <Pencil size={12} aria-hidden="true" />
            </Button>
          </Hint>
          <Hint content={adminTip}>
            <Button
              variant="dangerGhost"
              size="sm"
              type="button"
              onClick={onDelete}
              disabled={!isAdmin}
              aria-label={deleteLabel}
              title={deleteLabel}
              className="inline-flex size-7 items-center justify-center p-0"
            >
              <Trash2 size={12} aria-hidden="true" />
            </Button>
          </Hint>
        </span>
      </div>
    </article>
  );
}

// --- the drawer ---

type AccountDraft = {
  key: string;
  id?: number;
  name: string;
  /** The JSON text, not the parsed object: an edit in progress is often invalid. */
  config: string;
};

function draftsFrom(accounts: Account[]): AccountDraft[] {
  return accounts.map((account) => ({
    key: `id-${account.id}`,
    id: account.id,
    name: account.name,
    config: JSON.stringify(account.config ?? {}, null, 2),
  }));
}

// The types cantor's plugin editor offered. They are the script's own words,
// not this console's value-type codes — a mapping from one to the other is the
// target's job.
const PLUGIN_ATTRIBUTE_TYPES = ['String', 'Integer', 'Float', 'Date', 'DateTime', 'Time', 'JSON'] as const;

type AttributeDraft = {
  key: string;
  name: string;
  type: string;
  desc: string;
  /** Carried through untouched: the form edits the three fields cantor showed. */
  example?: unknown;
};

function RuleDrawer({
  rule,
  defaultPlugin,
  onClose,
  onSaved,
}: {
  rule: Rule | null;
  /** Opens a new rule already marked as a plugin, for the plugin section's tile. */
  defaultPlugin?: boolean;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const [name, setName] = useState(rule?.name ?? '');
  const [type, setType] = useState(rule?.type || (defaultPlugin ? 'agent' : 'http'));
  const [uniqueKey, setUniqueKey] = useState(rule?.unique_key ?? '');
  const [isPlugin, setIsPlugin] = useState(rule?.is_plugin ?? defaultPlugin ?? false);
  const [pluginScript, setPluginScript] = useState('');
  // An untouched icon is an omission, not a clear: a rule may carry an icon
  // this picker cannot draw (an uploaded image), and saving the form must not
  // erase it.
  const [icon, setIcon] = useState(() => (rule ? ruleIconValue(rule) : ''));
  const [iconTouched, setIconTouched] = useState(false);
  const [attributes, setAttributes] = useState<AttributeDraft[]>(() =>
    (rule?.attributes ?? []).map((attribute, index) => ({
      key: `attr-${index}`,
      name: attribute.name,
      type: attribute.type || 'String',
      desc: attribute.desc ?? '',
      example: attribute.example,
    })),
  );
  const [accounts, setAccounts] = useState<AccountDraft[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  // A FAILED READ MUST NOT BECOME A WRITE. Saving an empty list after a load
  // failure would delete every account on the rule.
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountsErr, setAccountsErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nextAccountKey = useRef(1);
  const nextAttributeKey = useRef(1);

  useEffect(() => {
    if (!rule) return;
    let live = true;
    setAccountsLoading(true);
    setAccountsLoaded(false);
    setAccountsErr(null);
    void listAccounts(rule.id)
      .then((rows) => {
        if (!live) return;
        setAccounts(draftsFrom(rows));
        setAccountsLoaded(true);
      })
      .catch((error) => {
        if (live) {
          setAccountsErr(describeError(error, tr('无法读取账号', 'Could not load the accounts')));
        }
      })
      .finally(() => {
        if (live) setAccountsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [rule, tr]);

  const addAccount = () => {
    setAccounts((current) => [
      ...current,
      { key: `new-${nextAccountKey.current++}`, name: '', config: '{}' },
    ]);
  };

  const removeAccount = (key: string) => {
    setAccounts((current) => current.filter((account) => account.key !== key));
  };

  const addAttribute = () => {
    setAttributes((current) => [
      ...current,
      { key: `attr-new-${nextAttributeKey.current++}`, name: '', type: 'String', desc: '' },
    ]);
  };

  const removeAttribute = (key: string) => {
    setAttributes((current) => current.filter((attribute) => attribute.key !== key));
  };

  const updateAttribute = (key: string, patch: Partial<AttributeDraft>) => {
    setAttributes((current) =>
      current.map((attribute) => (attribute.key === key ? { ...attribute, ...patch } : attribute)),
    );
  };

  const submit = async () => {
    if (!name.trim()) {
      setErr(tr('名称不能为空', 'A name is required'));
      return;
    }
    if (isPlugin && !uniqueKey.trim()) {
      setErr(tr('插件规则需要填写标识字段', 'A plugin rule needs the field that identifies an instance'));
      return;
    }
    if (isPlugin && !rule?.has_plugin_script && !pluginScript.trim()) {
      setErr(tr('插件规则需要一段脚本', 'A plugin rule needs a script'));
      return;
    }
    if (isPlugin) {
      const seen = new Set<string>();
      for (let index = 0; index < attributes.length; index += 1) {
        const field = attributes[index].name.trim();
        if (!field) {
          setErr(tr(`第 ${index + 1} 个字段没有名称`, `Field ${index + 1} has no name`));
          return;
        }
        if (seen.has(field)) {
          setErr(tr(`字段「${field}」重复`, `The field “${field}” appears twice`));
          return;
        }
        seen.add(field);
      }
    }

    // THE ACCOUNTS ARE PARSED BEFORE ANY WRITE, so a malformed config refuses
    // the whole save rather than leaving the rule updated and its credentials
    // half-written.
    const parsedAccounts: AccountInput[] = [];
    if (rule) {
      for (let index = 0; index < accounts.length; index += 1) {
        const draft = accounts[index];
        if (!draft.name.trim()) {
          setErr(tr(`第 ${index + 1} 个账号没有名称`, `Account ${index + 1} has no name`));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(draft.config.trim() || '{}');
        } catch {
          setErr(tr(`第 ${index + 1} 个账号的配置不是合法 JSON`, `Account ${index + 1}'s config is not valid JSON`));
          return;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setErr(tr(`第 ${index + 1} 个账号的配置必须是一个 JSON 对象`, `Account ${index + 1}'s config must be a JSON object`));
          return;
        }
        parsedAccounts.push({
          id: draft.id,
          name: draft.name.trim(),
          config: parsed as Record<string, unknown>,
        });
      }
    }

    const input: RuleInput = {
      name: name.trim(),
      type,
      is_plugin: isPlugin,
    };
    if (uniqueKey.trim()) input.unique_key = uniqueKey.trim();
    // AN EMPTY SCRIPT IS AN OMISSION, not a clear: the read path never returns
    // the stored script, so the form always starts empty and sending it would
    // erase a script the operator did not touch.
    if (pluginScript.trim()) input.plugin_script = pluginScript;

    if (isPlugin) {
      // THE FIELD LIST IS THE CALLER'S. cantor read it by running the script;
      // this port never executes it, so the list is maintained by hand and
      // written as-is. `example` is carried through untouched.
      input.attributes = attributes.map((attribute) => ({
        name: attribute.name.trim(),
        type: attribute.type || 'String',
        ...(attribute.desc.trim() ? { desc: attribute.desc.trim() } : {}),
        ...(attribute.example !== undefined ? { example: attribute.example } : {}),
      }));
      if (iconTouched) {
        const parsed = parseIconValue(icon);
        const option = { ...(rule?.option ?? {}) };
        if (parsed.type) option.icon = { name: parsed.type, color: parsed.color };
        else delete option.icon;
        input.option = option;
      }
    }

    setSubmitting(true);
    setErr(null);
    try {
      if (rule) {
        await updateRule(rule.id, input);
        // ONLY A LOADED SET IS WRITTEN BACK. An unloaded one is not an empty
        // one, and a failed read leaves the stored accounts untouched.
        if (accountsLoaded) await replaceAccounts(rule.id, parsedAccounts);
        await onSaved(tr('已保存', 'Saved'));
      } else {
        await createRule(input);
        await onSaved(tr('已创建', 'Created'));
      }
    } catch (error) {
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={rule ? tr('编辑发现规则', 'Edit discovery rule') : tr('新建发现规则', 'New discovery rule')}
      description={tr(
        '规则是一个提供方模板；账号是它运行时的凭据。',
        'A rule is a provider template; its accounts are the credentials it runs with.',
      )}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => void submit()}
            disabled={submitting || accountsLoading}
          >
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

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="cmdb-discovery-rule-name">{tr('名称', 'Name')}</Label>
          <Input
            id="cmdb-discovery-rule-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full"
          />
        </div>

        {isPlugin && (
          <div>
            <span className="text-xs font-medium text-text-muted">{tr('图标', 'Icon')}</span>
            <div className="mt-1">
              <IconPicker
                value={icon}
                onChange={(next) => {
                  setIcon(next);
                  setIconTouched(true);
                }}
                label={name.trim() || tr('规则图标', 'Rule icon')}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="cmdb-discovery-rule-type">{tr('类型', 'Type')}</Label>
            <Select
              id="cmdb-discovery-rule-type"
              label={tr('类型', 'Type')}
              value={type}
              onValueChange={setType}
              options={RULE_TYPES.map((kind) => ({ value: kind, label: ruleTypeLabel(tr, kind) }))}
              className="mt-1 w-full"
            />
          </div>
          <div>
            <Label htmlFor="cmdb-discovery-rule-unique">{tr('标识字段', 'Identifying field')}</Label>
            <Input
              id="cmdb-discovery-rule-unique"
              value={uniqueKey}
              onChange={(event) => setUniqueKey(event.target.value)}
              placeholder="hostname"
              className="mt-1 w-full font-mono"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-text-muted">
          <Checkbox
            checked={isPlugin}
            disabled={!isAdmin}
            onCheckedChange={(next) => setIsPlugin(next === true)}
          />
          {tr('插件规则', 'Plugin rule')}
        </label>
        <p className="-mt-1 text-[11px] text-text-faint">
          {tr(
            '插件规则携带一段由管理员维护的 Python 脚本；脚本只存储，不会回显，也不会在这里执行。',
            'A plugin rule carries Python maintained by an administrator. The script is stored, never echoed back, and not run here.',
          )}
        </p>

        {isPlugin && (
          <div>
            <Label htmlFor="cmdb-discovery-rule-script">{tr('插件脚本', 'Plugin script')}</Label>
            <Textarea
              id="cmdb-discovery-rule-script"
              aria-label={tr('插件脚本', 'Plugin script')}
              value={pluginScript}
              onChange={(event) => setPluginScript(event.target.value)}
              placeholder={
                rule?.has_plugin_script
                  ? tr('已存有一段脚本。留空保持不变；填写即替换。', 'A script is stored. Leave this empty to keep it, or write one to replace it.')
                  : 'def collect(config):\n    ...'
              }
              className="mt-1 min-h-[10rem] w-full font-mono text-xs"
            />
          </div>
        )}

        {isPlugin && (
          <section className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-xs font-semibold text-text">{tr('采集字段', 'Collected fields')}</h3>
                <p className="mt-0.5 text-[11px] text-text-faint">
                  {tr(
                    '字段在这里维护；脚本只存储、不执行。已有字段的示例值保持原样。',
                    'Fields are maintained here; the script is stored, not run. A stored example value is carried through unchanged.',
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={addAttribute}
                className="inline-flex items-center gap-1.5"
              >
                <Plus size={12} aria-hidden="true" />
                {tr('添加字段', 'Add field')}
              </Button>
            </div>

            {attributes.length === 0 ? (
              <p className="mt-2 text-xs text-text-faint">
                {tr('还没有字段。脚本返回的属性可以从这里声明。', 'No fields yet. Declare the attributes the script returns here.')}
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {attributes.map((attribute, index) => (
                  <div key={attribute.key} className="rounded-md border border-border/60 p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-text-faint">
                        {tr(`字段 ${index + 1}`, `Field ${index + 1}`)}
                      </span>
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        type="button"
                        onClick={() => removeAttribute(attribute.key)}
                        aria-label={tr(`删除字段 ${index + 1}`, `Remove field ${index + 1}`)}
                        className="inline-flex size-7 items-center justify-center p-0"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_7.5rem]">
                      <div className="min-w-0">
                        <Label htmlFor={`cmdb-discovery-attribute-name-${attribute.key}`}>
                          {tr('名称', 'Name')}
                        </Label>
                        <Input
                          id={`cmdb-discovery-attribute-name-${attribute.key}`}
                          aria-label={tr(`字段名称 ${index + 1}`, `Field name ${index + 1}`)}
                          value={attribute.name}
                          onChange={(event) => updateAttribute(attribute.key, { name: event.target.value })}
                          placeholder="hostname"
                          className="mt-1 w-full font-mono"
                        />
                      </div>
                      <div className="min-w-0">
                        <Label htmlFor={`cmdb-discovery-attribute-type-${attribute.key}`}>
                          {tr('类型', 'Type')}
                        </Label>
                        <Select
                          id={`cmdb-discovery-attribute-type-${attribute.key}`}
                          aria-label={tr(`字段类型 ${index + 1}`, `Field type ${index + 1}`)}
                          value={attribute.type}
                          onValueChange={(next) => updateAttribute(attribute.key, { type: next })}
                          options={PLUGIN_ATTRIBUTE_TYPES.map((kind) => ({ value: kind, label: kind }))}
                          className="mt-1 w-full"
                        />
                      </div>
                    </div>
                    <div className="mt-2">
                      <Label htmlFor={`cmdb-discovery-attribute-desc-${attribute.key}`}>
                        {tr('说明', 'Description')}
                      </Label>
                      <Input
                        id={`cmdb-discovery-attribute-desc-${attribute.key}`}
                        aria-label={tr(`字段说明 ${index + 1}`, `Field description ${index + 1}`)}
                        value={attribute.desc}
                        onChange={(event) => updateAttribute(attribute.key, { desc: event.target.value })}
                        className="mt-1 w-full"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {rule && (
          <section className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-xs font-semibold text-text">{tr('账号', 'Accounts')}</h3>
                <p className="mt-0.5 text-[11px] text-text-faint">
                  {tr(
                    '凭据（secret / password）保存后不会再显示；留空表示保持原值。',
                    'Credentials (secret / password) are never returned; leaving them out keeps the stored values.',
                  )}
                </p>
              </div>
              <Button variant="outline" size="sm" type="button" onClick={addAccount} className="inline-flex items-center gap-1.5">
                <Plus size={12} aria-hidden="true" />
                {tr('添加账号', 'Add account')}
              </Button>
            </div>

            {accountsErr && (
              <p role="alert" className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                {accountsErr}
              </p>
            )}
            {accountsLoading ? (
              <p className="mt-3 text-xs text-text-muted">{tr('加载账号…', 'Loading accounts…')}</p>
            ) : accounts.length === 0 ? (
              <p className="mt-3 text-xs text-text-faint">{tr('这条规则还没有账号。', 'This rule has no accounts yet.')}</p>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                {accounts.map((account, index) => (
                  <div key={account.key} className="rounded-md border border-border p-3">
                    <div className="flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <Label htmlFor={`cmdb-discovery-account-name-${account.key}`}>
                          {tr('账号名称', 'Account name')}
                        </Label>
                        <Input
                          id={`cmdb-discovery-account-name-${account.key}`}
                          aria-label={tr(`账号名称 ${index + 1}`, `Account name ${index + 1}`)}
                          value={account.name}
                          onChange={(event) =>
                            setAccounts((current) =>
                              current.map((item) =>
                                item.key === account.key ? { ...item, name: event.target.value } : item,
                              ),
                            )
                          }
                          className="mt-1 w-full"
                        />
                      </div>
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        type="button"
                        onClick={() => removeAccount(account.key)}
                        aria-label={tr(`删除账号 ${index + 1}`, `Remove account ${index + 1}`)}
                        className="inline-flex items-center gap-1"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                        {tr('删除', 'Delete')}
                      </Button>
                    </div>
                    <div className="mt-2">
                      <Label htmlFor={`cmdb-discovery-account-config-${account.key}`}>
                        {tr('配置 JSON', 'Config JSON')}
                      </Label>
                      <Textarea
                        id={`cmdb-discovery-account-config-${account.key}`}
                        aria-label={tr(`账号配置 ${index + 1}`, `Account config ${index + 1}`)}
                        value={account.config}
                        onChange={(event) =>
                          setAccounts((current) =>
                            current.map((item) =>
                              item.key === account.key ? { ...item, config: event.target.value } : item,
                            ),
                          )
                        }
                        className="mt-1 min-h-[6rem] w-full font-mono text-xs"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </Drawer>
  );
}
