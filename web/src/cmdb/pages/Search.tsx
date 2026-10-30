import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  Copy,
  Eye,
  ExternalLink,
  History,
  Loader2,
  RefreshCw,
  Search as SearchIcon,
  Trash2,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { useDialogs } from '@/components/ui/useDialogs';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import { describeError } from '../api/http';
import {
  listAllAttributes,
  listCITypes,
  listTypeAttributes,
  type Attribute,
  type CIType,
  type TypeAttribute,
} from '../api/citype';
import { searchInstances, type SearchPage, type SearchRow } from '../api/instance';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  type SavedSearch,
} from '../api/preferences';
import { DataTable, type Column } from '../components/DataTable';
import { ExportMenu } from '../components/ipam/ExportMenu';
import { ModelMultiSelect } from '../components/ModelMultiSelect';
import { QueryBar, type QueryAttribute } from '../components/QueryBar';
import { SearchInstanceDrawer } from '../components/SearchInstanceDrawer';
import { useToast } from '../components/Toast';
import type { ExportColumn } from '../lib/export';
import { displayValue, isValueTypeCode } from '../lib/valuetype';

// 资源搜索 — a keyword-first search over every readable model.
//
// CANTOR'S RESOURCE SEARCH IS THE REFERENCE: a keyword, a grouped model scope,
// expression filters, and the user's recent/saved searches. The console keeps
// its own expression model (QueryBar) instead of cantor's rule popover, and
// uses the shared DataTable + InstanceDetailDrawer rather than copying cantor's
// card grid and sheet.
//
// THE EXPRESSION IS STILL THE CONTRACT. The page builds one `q` from three
// sources — model scope, the precise expression, and the keyword — and shows it
// before sending. A keyword is `*term*` (any searchable attribute); the precise
// builder remains available for field/operator queries.

const PAGE_SIZE = 20;
const RECENT_NAME = '__recent__';
const RESERVED_NAMES = new Set([RECENT_NAME, '__favor__', '__relation_favor__']);

type SearchOption = {
  keyword?: unknown;
  searchValue?: unknown;
  q?: unknown;
  expression?: unknown;
  types?: unknown;
  ciTypeIds?: unknown;
};

function parseTypes(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Keyword text cannot carry the DSL's structural punctuation. */
function keywordTerm(keyword: string): string {
  return keyword.trim().replace(/[,;()~]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildQuery(types: string[], expression: string, keyword: string): string {
  const typeTerm =
    types.length === 0
      ? ''
      : types.length === 1
        ? `_type:${types[0]}`
        : `_type:(${types.join(';')})`;
  const kw = keywordTerm(keyword);
  return [typeTerm, expression.trim(), kw ? `*${kw}*` : ''].filter(Boolean).join(',');
}

function optionKey(option: SearchOption): string {
  return JSON.stringify({
    keyword: stringValue(option.keyword) || stringValue(option.searchValue),
    q: stringValue(option.q) || stringValue(option.expression),
    types: Array.isArray(option.types) ? option.types : Array.isArray(option.ciTypeIds) ? option.ciTypeIds : [],
  });
}

function optionTypes(option: SearchOption, models: CIType[]): string[] {
  if (Array.isArray(option.types)) {
    return option.types.filter((value): value is string => typeof value === 'string');
  }
  if (Array.isArray(option.ciTypeIds)) {
    return option.ciTypeIds
      .map((value) => models.find((model) => model.id === Number(value))?.name)
      .filter((value): value is string => Boolean(value));
  }
  return [];
}

export default function SearchPage() {
  const { tr } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const [params, setParams] = useSearchParams();

  const initialTypes = parseTypes(params.get('type'));
  const initialKeyword = params.get('kw') ?? '';
  const initialExpression = params.get('q') ?? '';
  const initialPage = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const initialSearched = Boolean(
    initialTypes.length || initialKeyword.trim() || initialExpression.trim(),
  );

  const [models, setModels] = useState<CIType[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(initialTypes);
  const [keyword, setKeyword] = useState(initialKeyword);
  const [expression, setExpression] = useState(initialExpression);
  const [attributes, setAttributes] = useState<QueryAttribute[]>([]);
  const [result, setResult] = useState<SearchPage | null>(null);
  const [page, setPage] = useState(initialPage);
  const [searched, setSearched] = useState(initialSearched);
  const [loading, setLoading] = useState(initialSearched);
  // Keyword search is the primary path. The precise builder stays open on
  // desktop, but on a phone it would push the results below a very tall form.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => Boolean(initialExpression) || !window.matchMedia?.('(max-width: 767px)')?.matches,
  );
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [recent, setRecent] = useState<SavedSearch[]>([]);
  const [detail, setDetail] = useState<{ ciID: number; title: string; model: CIType } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);
  const lastQuery = useRef('');
  const booted = useRef(false);

  useEffect(() => {
    void listCITypes()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  // Deep links may spell a model by alias; the picker and the next request use
  // the stable name. Unknown names are dropped rather than sent as an error.
  useEffect(() => {
    if (models.length === 0) return;
    setSelectedTypes((current) => {
      const names = current
        .map((value) => models.find((model) => model.name === value || model.alias === value)?.name)
        .filter((value): value is string => Boolean(value));
      return names.length === current.length && names.every((value, index) => value === current[index])
        ? current
        : names;
    });
  }, [models]);

  const selectedKey = selectedTypes.join(',');

  // A model picker scoped to a few models gets their union of attributes; with
  // no scope (or a very broad one) the global dictionary is the useful list.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const byName = new Map<string, { attr: Attribute | TypeAttribute; password: boolean; json: boolean }>();
        if (selectedTypes.length === 0 || selectedTypes.length > 8) {
          for (const attr of await listAllAttributes()) {
            byName.set(attr.name, { attr, password: attr.is_password, json: attr.value_type === '6' });
          }
        } else {
          const groups = await Promise.all(
            selectedTypes.map((name) => listTypeAttributes(name).catch(() => null)),
          );
          for (const group of groups) {
            for (const attr of group?.attributes ?? []) {
              const existing = byName.get(attr.name);
              if (existing) {
                existing.password ||= attr.is_password;
                existing.json ||= attr.value_type === '6';
              } else {
                byName.set(attr.name, { attr, password: attr.is_password, json: attr.value_type === '6' });
              }
            }
          }
        }
        if (!live) return;
        setAttributes(
          [...byName.values()]
            .map(({ attr, password, json }) => ({
              ref: attr.name,
              label: attr.alias || attr.name,
              type: isValueTypeCode(attr.value_type) ? attr.value_type : ('2' as const),
              matchable: !password && !json,
            }))
            .sort((left, right) => left.label.localeCompare(right.label)),
        );
      } catch {
        if (live) setAttributes([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [selectedKey, selectedTypes]);

  const loadPresets = useCallback(async () => {
    try {
      const all = await listSavedSearches();
      setSaved(all.filter((search) => !RESERVED_NAMES.has(search.name)));
      setRecent(all.filter((search) => search.name === RECENT_NAME));
    } catch {
      // Saved searches are an accelerator, not a prerequisite for searching.
    }
  }, []);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  const run = useCallback(
    async (
      targetPage: number,
      override?: { keyword?: string; expression?: string; types?: string[]; user?: boolean },
    ) => {
      const kw = override?.keyword ?? keyword;
      const expr = override?.expression ?? expression;
      const types = override?.types ?? selectedTypes;
      const q = buildQuery(types, expr, kw);
      const seq = ++requestSeq.current;
      setLoading(true);
      setErr(null);
      setSearched(true);
      try {
        const got = await searchInstances({
          q,
          page: targetPage,
          count: PAGE_SIZE,
          sort: '_type',
        });
        if (seq !== requestSeq.current) return;
        lastQuery.current = q;
        setResult(got);
        setPage(got.page || targetPage);
        const next = new URLSearchParams();
        if (types.length > 0) next.set('type', types.join(','));
        if (expr.trim()) next.set('q', expr.trim());
        if (kw.trim()) next.set('kw', kw.trim());
        if ((got.page || targetPage) > 1) next.set('page', String(got.page || targetPage));
        setParams(next, { replace: true });
        if (override?.user && (kw.trim() || expr.trim() || types.length > 0)) {
          void createSavedSearch({
            name: RECENT_NAME,
            option: { keyword: kw.trim(), q: expr.trim(), types },
          })
            .then(loadPresets)
            .catch(() => undefined);
        }
      } catch (error) {
        if (seq === requestSeq.current) {
          setErr(describeError(error, tr('搜索失败', 'The search failed')));
        }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [expression, keyword, loadPresets, selectedTypes, setParams, tr],
  );

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    if (initialSearched) void run(initialPage);
    // The initial run reads the URL snapshot; later runs are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearAll = () => {
    requestSeq.current += 1;
    setKeyword('');
    setExpression('');
    setSelectedTypes([]);
    setResult(null);
    setErr(null);
    setSearched(false);
    setPage(1);
    setLoading(false);
    setParams(new URLSearchParams(), { replace: true });
  };

  const applySaved = (search: SavedSearch) => {
    const option = (search.option ?? {}) as SearchOption;
    const kw = stringValue(option.keyword) || stringValue(option.searchValue);
    const expr = (stringValue(option.q) || stringValue(option.expression)).replace(/^q=/, '');
    let types = optionTypes(option, models);
    if (types.length === 0 && search.type_id != null) {
      const model = models.find((item) => item.id === search.type_id);
      if (model) types = [model.name];
    }
    setKeyword(kw);
    setExpression(expr);
    setSelectedTypes(types);
    if (expr) setAdvancedOpen(true);
    void run(1, { keyword: kw, expression: expr, types, user: true });
  };

  const applyRecent = (search: SavedSearch) => {
    applySaved(search);
  };

  const clearRecent = async () => {
    if (recent.length === 0) return;
    const ok = await confirmAction(tr('清除最近搜索？', 'Clear recent searches?'));
    if (!ok) return;
    try {
      await Promise.all(recent.map((search) => deleteSavedSearch(search.id)));
      await loadPresets();
      toast.success(tr('已清除', 'Cleared'));
    } catch (error) {
      toast.error(describeError(error, tr('清除失败', 'Could not clear them')));
    }
  };

  const openSave = () => {
    setSaveName('');
    setSaveErr(null);
    setSaveOpen(true);
  };

  const saveSearch = async () => {
    const name = saveName.trim();
    if (!name || saving) return;
    if (RESERVED_NAMES.has(name)) {
      setSaveErr(tr('这个名称是系统保留的，请换一个。', 'That name is reserved; choose another.'));
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      const single = selectedTypes.length === 1
        ? models.find((model) => model.name === selectedTypes[0])
        : undefined;
      await createSavedSearch({
        name,
        option: { keyword: keyword.trim(), q: expression.trim(), types: selectedTypes },
        ...(single ? { type_id: single.id } : {}),
      });
      setSaveOpen(false);
      toast.success(tr('已保存', 'Saved'));
      await loadPresets();
    } catch (error) {
      setSaveErr(describeError(error, tr('保存失败', 'Could not save it')));
    } finally {
      setSaving(false);
    }
  };

  const rows = result?.result ?? [];

  const attributeLabels = useMemo(
    () => new Map(attributes.map((attribute) => [attribute.ref, attribute.label])),
    [attributes],
  );

  const dynamicNames = useMemo(() => {
    const names: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key.startsWith('_') || key === 'ci_id' || key === 'ci_type' || key === 'ci_type_alias' || key === 'unique' || key === 'unique_alias') continue;
        if (!names.includes(key)) names.push(key);
      }
      if (names.length >= 8) break;
    }
    return names;
  }, [rows]);

  const columns = useMemo<Column<SearchRow>[]>(() => {
    return [
      {
        key: '_id',
        header: tr('编号', 'ID'),
        width: 'w-px',
        cell: (row) => <code className="font-mono text-[11px] text-text-muted">{row._id}</code>,
      },
      {
        key: 'ci_type',
        header: tr('模型', 'Model'),
        cell: (row) => <Chip tone="info">{row.ci_type_alias || row.ci_type}</Chip>,
      },
      ...dynamicNames.map((name) => ({
        key: name,
        header: attributeLabels.get(name) ?? name,
        width: dynamicNames.length === 1 ? 'w-full' : undefined,
        cell: (row: SearchRow) => (
          <span className="block min-w-0 truncate" title={displayValue(row[name])}>
            {displayValue(row[name]) || '—'}
          </span>
        ),
      })),
      {
        key: '_updated_at',
        header: tr('最近修改', 'Last changed'),
        hideable: true,
        cell: (row) => <span className="whitespace-nowrap text-[11px] text-text-muted">{row._updated_at || '—'}</span>,
      },
    ];
  }, [attributeLabels, dynamicNames, tr]);

  const effective = useMemo(
    () => buildQuery(selectedTypes, expression, keyword),
    [expression, keyword, selectedTypes],
  );

  const copyEffective = async () => {
    try {
      await navigator.clipboard.writeText(effective);
      toast.success(tr('已复制查询表达式', 'Query copied'));
    } catch {
      toast.error(tr('复制失败', 'Could not copy'));
    }
  };

  const openDetail = (row: SearchRow) => {
    const model = models.find((item) => item.name === row.ci_type || item.id === row._type);
    if (!model) {
      toast.error(tr('无法确定这条资源所属的模型', 'Could not determine the resource model'));
      return;
    }
    const uniqueName = typeof row.unique === 'string' ? row.unique : '';
    const title =
      (uniqueName && displayValue(row[uniqueName])) || `#${row.ci_id}`;
    setDetail({ ciID: row.ci_id, title, model });
  };

  const recentUnique = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ search: SavedSearch; option: SearchOption }> = [];
    for (const search of [...recent].reverse()) {
      const option = (search.option ?? {}) as SearchOption;
      const key = optionKey(option);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ search, option });
      if (out.length >= 8) break;
    }
    return out;
  }, [recent]);

  const optionLabel = (option: SearchOption): string => {
    const parts = [
      stringValue(option.keyword) || stringValue(option.searchValue),
      stringValue(option.q) || stringValue(option.expression),
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(' · ');
    const types = optionTypes(option, models);
    return types.length > 0 ? types.join(', ') : tr('全部资源', 'All resources');
  };

  const hasFilters = Boolean(keyword.trim() || expression.trim() || selectedTypes.length > 0);
  const total = result?.numfound ?? 0;

  const exportColumns = useMemo<ExportColumn<SearchRow>[]>(
    () => [
      { key: '_id', header: tr('编号', 'ID'), value: (row) => row._id },
      { key: 'ci_type', header: tr('模型', 'Model'), value: (row) => row.ci_type_alias || row.ci_type },
      ...dynamicNames.map((name) => ({
        key: name,
        header: attributeLabels.get(name) ?? name,
        value: (row: SearchRow) => displayValue(row[name]),
      })),
      { key: '_updated_at', header: tr('最近修改', 'Last changed'), value: (row) => row._updated_at ?? '' },
    ],
    [attributeLabels, dynamicNames, tr],
  );

  // A mixed search can match far more than one page; export through the same
  // query in backend-sized pages, with a bound so a click cannot materialise an
  // unbounded result set.
  const fetchAllRows = async (): Promise<SearchRow[]> => {
    const cap = 5000;
    const limit = Math.min(total, cap);
    const out: SearchRow[] = [];
    for (let pageNo = 1; out.length < limit; pageNo += 1) {
      const got = await searchInstances({ q: lastQuery.current, page: pageNo, count: 500, sort: '_type' });
      out.push(...got.result);
      if (got.result.length < 500) break;
    }
    if (total > cap) {
      toast.info(tr(`一次最多导出 ${cap} 条，已截断。`, `Export is capped at ${cap} rows; the rest were omitted.`));
    }
    return out.slice(0, cap);
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        title={tr('资源搜索', 'Resource search')}
        subtitle={tr(
          '按关键词、模型或精确条件搜索全部资源；关键词匹配任意可检索属性。',
          'Search every resource by keyword, model, or precise conditions; keywords match any searchable attribute.',
        )}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={openSave}
              disabled={!hasFilters || saving}
              className="inline-flex items-center gap-1.5"
            >
              <BookmarkPlus size={12} aria-hidden="true" />
              {tr('保存搜索', 'Save search')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => void run(1, { user: true })}
              disabled={loading}
              className="inline-flex items-center gap-1.5 font-medium text-accent-fg"
            >
              {loading ? <RefreshCw size={12} className="animate-spin" aria-hidden="true" /> : <SearchIcon size={12} aria-hidden="true" />}
              {tr('搜索', 'Search')}
            </Button>
          </>
        }
        extra={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden="true" />
              <Input
                type="search"
                aria-label={tr('搜索关键词', 'Search keyword')}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void run(1, { user: true });
                  }
                }}
                placeholder={tr('搜索编号、名称或任意属性…', 'Search an id, name, or any attribute…')}
                className="pl-8 [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            <ModelMultiSelect models={models} selected={selectedTypes} onChange={setSelectedTypes} />
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={clearAll}
              disabled={!hasFilters && !searched}
              className="inline-flex items-center gap-1.5"
            >
              <X size={12} aria-hidden="true" />
              {tr('清除', 'Clear')}
            </Button>
          </div>
        }
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        <Card className="mb-4">
          <div className={advancedOpen ? 'mb-3 flex flex-wrap items-center justify-between gap-2' : 'flex flex-wrap items-center justify-between gap-2'}>
            <div className="flex min-w-0 items-start gap-1.5">
              <button
                type="button"
                onClick={() => setAdvancedOpen((value) => !value)}
                aria-expanded={advancedOpen}
                aria-label={advancedOpen ? tr('收起精确查询', 'Collapse precise query') : tr('展开精确查询', 'Expand precise query')}
                title={advancedOpen ? tr('收起精确查询', 'Collapse precise query') : tr('展开精确查询', 'Expand precise query')}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-text-faint transition-colors hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
              >
                <ChevronDown
                  size={14}
                  className={advancedOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
                  aria-hidden="true"
                />
              </button>
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-text">{tr('精确查询', 'Precise query')}</h2>
                {advancedOpen && (
                  <p className="mt-0.5 text-[11px] text-text-faint">
                    {tr('可选，与关键词和模型范围同时生效。', 'Optional; applied together with the keyword and model scope.')}
                  </p>
                )}
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-[11px] text-text-faint">{tr('发送表达式', 'Sent as')}</span>
              <code
                className="max-w-[46vw] truncate rounded bg-card px-1.5 py-0.5 font-mono text-[11px] text-text-muted"
                title={effective}
              >
                {effective || tr('（空，匹配全部）', '(empty — matches everything)')}
              </code>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={() => void copyEffective()}
                disabled={!effective}
                aria-label={tr('复制查询表达式', 'Copy query expression')}
                title={tr('复制查询表达式', 'Copy query expression')}
              >
                <Copy size={12} aria-hidden="true" />
              </Button>
            </div>
          </div>
          {advancedOpen && <QueryBar attributes={attributes} value={expression} onChange={setExpression} />}
        </Card>

        {(saved.length > 0 || recentUnique.length > 0) && (
          <Card className="mb-4">
            <div className="flex flex-col gap-2">
              {saved.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Bookmark size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
                  <span className="text-[11px] text-text-faint">{tr('保存搜索', 'Saved searches')}</span>
                  {saved.slice(0, 8).map((search) => (
                    <button
                      key={search.id}
                      type="button"
                      onClick={() => applySaved(search)}
                      className="max-w-56 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                      title={search.name}
                    >
                      <Chip dense className="max-w-56">
                        <span className="truncate">{search.name}</span>
                      </Chip>
                    </button>
                  ))}
                  {saved.length > 8 && <span className="text-[11px] text-text-faint">+{saved.length - 8}</span>}
                </div>
              )}
              {recentUnique.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <History size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
                  <span className="text-[11px] text-text-faint">{tr('最近搜索', 'Recent searches')}</span>
                  {recentUnique.map(({ search, option }) => (
                    <button
                      key={search.id}
                      type="button"
                      onClick={() => applyRecent(search)}
                      className="max-w-64 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                      title={optionLabel(option)}
                    >
                      <Chip dense className="max-w-64">
                        <span className="truncate">{optionLabel(option)}</span>
                      </Chip>
                    </button>
                  ))}
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    onClick={() => void clearRecent()}
                    aria-label={tr('清除最近搜索', 'Clear recent searches')}
                    title={tr('清除最近搜索', 'Clear recent searches')}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </Button>
                </div>
              )}
            </div>
          </Card>
        )}

        {err && (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            <span className="min-w-0 flex-1 break-words">{err}</span>
            <Button variant="outline" size="sm" type="button" onClick={() => void run(page)}>
              <RefreshCw size={12} aria-hidden="true" />
              {tr('重试', 'Retry')}
            </Button>
          </div>
        )}

        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-text">{tr('结果', 'Results')}</h2>
              {searched && (
                <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] leading-none text-text-muted">
                  {total}
                </span>
              )}
              {loading && <Loader2 size={12} className="animate-spin text-text-faint" aria-hidden="true" />}
            </div>
            {searched && (
              <div className="flex flex-wrap items-center gap-2">
                {total > 0 && (
                  <span className="text-[11px] text-text-faint">
                    {tr(`第 ${page} 页`, `Page ${page}`)}
                  </span>
                )}
                <ExportMenu
                  filename="cmdb-resource-search"
                  columns={exportColumns}
                  rows={rows}
                  totalCount={total}
                  fetchAll={fetchAllRows}
                  scopes={['page', 'all']}
                  disabled={rows.length === 0}
                  label={tr('导出', 'Export')}
                />
              </div>
            )}
          </div>

          {!searched ? (
            <EmptyState
              title={tr('输入关键词或选择模型开始搜索', 'Enter a keyword or choose models to start')}
              hint={tr(
                '关键词会匹配任意可检索属性；需要精确查询时使用下方的条件构造器。',
                'Keywords match any searchable attribute; use the condition builder below for precise queries.',
              )}
              className="flex min-h-52 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
            />
          ) : err && !result ? null : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row._id}
              loading={loading && rows.length === 0}
              storageKey="cmdb-resource-search"
              empty={
                <EmptyState
                  title={tr('没有匹配的资源', 'No resources match')}
                  hint={tr('换一个关键词，或清除搜索后重试。', 'Try another keyword, or clear the search.')}
                  action={
                    <Button variant="ghost" size="sm" type="button" onClick={clearAll}>
                      {tr('清除搜索', 'Clear search')}
                    </Button>
                  }
                />
              }
              actions={(row) => (
                <span className="flex items-center gap-1">
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    onClick={() => openDetail(row)}
                    aria-label={tr(`查看资源 ${row.ci_id}`, `View resource ${row.ci_id}`)}
                    title={tr('查看详情', 'View details')}
                  >
                    <Eye size={13} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    onClick={() =>
                      navigate(`/cmdb/instances?type=${encodeURIComponent(String(row.ci_type))}&ci=${row.ci_id}`)
                    }
                    aria-label={tr(`在资源数据中打开 ${row.ci_id}`, `Open resource ${row.ci_id} in resources`)}
                    title={tr('在资源数据中打开', 'Open in resources')}
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                  </Button>
                </span>
              )}
            />
          )}

          {searched && result && (
            <PaginationFooter
              page={page - 1}
              pageSize={PAGE_SIZE}
              shown={rows.length}
              total={total}
              loading={loading}
              matchLabel
              onPageChange={(next) => void run(next + 1)}
              className="mt-3"
            />
          )}
        </Card>
      </div>

      {detail && (
        <SearchInstanceDrawer
          ciID={detail.ciID}
          title={detail.title}
          model={detail.model}
          models={models}
          onClose={() => setDetail(null)}
          onSaved={() => void run(page)}
        />
      )}

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={tr('保存搜索', 'Save search')}
        size="md"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => setSaveOpen(false)} disabled={saving}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button variant="primary" type="button" onClick={() => void saveSearch()} disabled={saving || !saveName.trim()}>
              {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
            </Button>
          </div>
        }
      >
        {saveErr && (
          <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {saveErr}
          </div>
        )}
        <div className="space-y-3">
          <div>
            <Label htmlFor="cmdb-search-save-name">{tr('名称', 'Name')}</Label>
            <Input
              id="cmdb-search-save-name"
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder={tr('例如：生产环境主机', 'e.g. Production hosts')}
              className="mt-1 w-full"
              autoFocus
            />
          </div>
          <p className="text-[11px] text-text-faint">
            {tr(
              `保存当前的关键词、模型范围和精确查询。发送表达式：${effective || '（空）'}`,
              `Saves the current keyword, model scope, and precise query. Sent as: ${effective || '(empty)'}`,
            )}
          </p>
        </div>
      </Modal>

      {dialog}
    </div>
  );
}
