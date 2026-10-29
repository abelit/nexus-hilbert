import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  CircleDot,
  GitFork,
  ListChecks,
  ListTree,
  Network,
  PanelRightClose,
  Pencil,
  PanelRightOpen,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Waypoints,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button, EmptyStateCard } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/store/me';

import { listCITypes, listRelations, type CIType, type ModelRelation } from '../api/citype';
import { describeError } from '../api/http';
import {
  createServiceTree,
  deleteServiceTree,
  listServiceTrees,
  updateServiceTree,
  type ServiceTree,
  type TypePair,
} from '../api/preferences';
import { MetaPill } from '../components/MetaPill';
import { DefinitionCard } from '../components/service-tree/DefinitionCard';
import { DefinitionDialog } from '../components/service-tree/DefinitionDialog';
import { DefinitionPairsDialog } from '../components/service-tree/DefinitionPairsDialog';
import { ModelNodeCard } from '../components/service-tree/ModelNodeCard';
import { RelationGraph } from '../components/service-tree/RelationGraph';
import { useToast } from '../components/Toast';
import { WorkspaceBar } from '../components/WorkspaceBar';
import {
  buildModelGraph,
  definitionModelIDs,
  definitionRoot,
  layoutModelGraph,
  pairKey,
  pairKeys,
  pairsFromSelection,
  serviceTreeChainTokens,
  type LayoutMode,
} from '../lib/model-relation-graph';

// 关系视图 — the model-relation canvas and the saved definitions on top of it.
//
// CANTOR'S SERVICE-TREE PAGE IS THE REFERENCE: the canvas is the CI-type graph,
// the right rail holds saved definitions as cards, and a definition highlights
// its chain. The console keeps the same interaction and adds a searchable rail,
// a definition-click highlight and a node-selection editor for the pairs.
//
// THE DEFINITION IS STILL A SET OF MODEL PAIRS, not instances. Editing selects
// models on the canvas and derives every live relation between the selected
// ones; the instance walk stays the resource tree's job.
//
// THE EXACT-PAIR EDITOR IS PART OF THIS PAGE, not a second page. The old
// “tree definitions” table was the only way to repair a branch or drop a stale
// pair, so its editor now opens from the definition cards and the canvas edit
// bar. One navigation entry, one save flow, one place to understand.

const LAYOUT_OPTIONS: Array<{ value: LayoutMode; label: [string, string]; icon: typeof ListTree }> = [
  { value: 'tree', label: ['树形', 'Tree'], icon: ListTree },
  { value: 'radial', label: ['径向', 'Radial'], icon: Radar },
  { value: 'concentric', label: ['同心', 'Ring'], icon: CircleDot },
  { value: 'mindmap', label: ['思维导图', 'Mind map'], icon: GitFork },
];

export default function ServiceTreePage() {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const isAdmin = usePermissions().isAdmin;
  const navigate = useNavigate();

  const [definitions, setDefinitions] = useState<ServiceTree[]>([]);
  const [models, setModels] = useState<CIType[]>([]);
  const [relations, setRelations] = useState<ModelRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedID, setSelectedID] = useState<number | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('tree');
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [definitionQuery, setDefinitionQuery] = useState('');

  const [editMode, setEditMode] = useState(false);
  const [editingTree, setEditingTree] = useState<ServiceTree | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<number>>(() => new Set());
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [pairEditor, setPairEditor] = useState<{ tree: ServiceTree | null; pairs: TypePair[] } | null>(null);
  const [pairSaving, setPairSaving] = useState(false);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [locateValue, setLocateValue] = useState('');
  // A one-off focus for "locate a model": the node and its direct neighbours,
  // so a new definition can be built on a 61-node canvas without zooming out
  // until the labels disappear.
  const [focusOverride, setFocusOverride] = useState<number[] | null>(null);
  const [focusVersion, setFocusVersion] = useState(0);
  // View-mode node preview. Edit mode owns the canvas click to toggle a
  // model into the definition, so the card is closed when editing starts.
  const [previewNodeID, setPreviewNodeID] = useState<number | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      try {
        const [trees, allModels, allRelations] = await Promise.all([
          listServiceTrees(),
          listCITypes(),
          listRelations(),
        ]);
        setDefinitions(trees);
        setModels(allModels);
        setRelations(allRelations);
        setSelectedID((current) => {
          if (current != null && trees.some((tree) => tree.id === current)) return current;
          return trees[0]?.id ?? null;
        });
      } catch (error) {
        setErr(describeError(error, tr('无法读取关系视图', 'Could not load the relation view')));
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

  useEffect(() => {
    if (editMode) setPreviewNodeID(null);
  }, [editMode]);

  const graph = useMemo(() => buildModelGraph(models, relations), [models, relations]);

  const previewModel = useMemo(
    () => (previewNodeID == null ? null : models.find((item) => item.id === previewNodeID) ?? null),
    [models, previewNodeID],
  );

  const togglePreviewNode = useCallback((id: number) => {
    setPreviewNodeID((current) => (current === id ? null : id));
  }, []);

  const labelByID = useMemo(() => {
    const map = new Map<number, string>();
    for (const model of models) map.set(model.id, model.alias || model.name);
    for (const node of graph.nodes) if (!map.has(node.id)) map.set(node.id, node.label);
    return map;
  }, [graph.nodes, models]);
  const label = useCallback((id: number) => labelByID.get(id) ?? `#${id}`, [labelByID]);

  const selectedDefinition = definitions.find((tree) => tree.id === selectedID) ?? null;
  const shownDefinition = editingTree ?? selectedDefinition;
  const layoutRoot = definitionRoot((editingTree ?? selectedDefinition)?.pairs ?? []);
  const positions = useMemo(
    () => layoutModelGraph(graph, layoutMode, layoutRoot),
    [graph, layoutMode, layoutRoot],
  );
  const availablePairKeys = useMemo(
    () => new Set(graph.links.map((link) => `${link.from}:${link.to}`)),
    [graph.links],
  );
  const selectionPairs = useMemo(
    () => pairsFromSelection(relations, selectedModels),
    [relations, selectedModels],
  );
  const selectionTokens = useMemo(
    () => serviceTreeChainTokens(selectionPairs, label),
    [label, selectionPairs],
  );

  const highlightedNodes = useMemo(() => {
    if (editMode) return selectedModels;
    if (!selectedDefinition) return new Set<number>();
    return new Set(definitionModelIDs(selectedDefinition.pairs));
  }, [editMode, selectedDefinition, selectedModels]);

  const highlightedPairs = useMemo(() => {
    if (editMode) return pairKeys(selectionPairs);
    return selectedDefinition ? pairKeys(selectedDefinition.pairs) : new Set<string>();
  }, [editMode, selectedDefinition, selectionPairs]);

  // The canvas frames the definition (or the selection at the start of an edit)
  // instead of shrinking 61 models to fit a single viewport. Selecting another
  // definition re-frames; ticking another node in edit mode does not.
  const focusIDs = useMemo(
    () =>
      focusOverride ??
      (editMode
        ? [...selectedModels]
        : selectedDefinition
          ? definitionModelIDs(selectedDefinition.pairs)
          : []),
    [editMode, focusOverride, selectedDefinition, selectedModels],
  );
  const focusKey = `${layoutMode}-${layoutVersion}-${focusVersion}-${
    editMode ? (editingTree?.id ?? 'new') : (selectedID ?? 'none')
  }`;

  const filteredDefinitions = useMemo(() => {
    const term = definitionQuery.trim().toLowerCase();
    return term ? definitions.filter((tree) => tree.name.toLowerCase().includes(term)) : definitions;
  }, [definitionQuery, definitions]);

  const unresolved = useCallback(
    (tree: ServiceTree) => tree.pairs.some((pair) => !availablePairKeys.has(pairKey(pair))),
    [availablePairKeys],
  );

  const selectDefinition = (id: number) => {
    if (editMode) {
      toast.info(tr('正在编辑定义，请先保存或取消。', 'Finish or cancel the current edit first.'));
      return;
    }
    setFocusOverride(null);
    setSelectedID(id);
  };

  const startNew = () => {
    if (!isAdmin || graph.nodes.length === 0) return;
    setEditMode(true);
    setEditingTree(null);
    setSelectedModels(new Set());
    setSelectedID(null);
    setSaveErr(null);
    setFocusOverride(null);
  };

  const openPairEditor = (tree: ServiceTree | null, pairs: TypePair[]) => {
    if (!isAdmin) return;
    setPairErr(null);
    setPairEditor({ tree, pairs });
  };

  const startEdit = (tree: ServiceTree) => {
    if (!isAdmin) return;
    if (unresolved(tree)) {
      // The canvas derives pairs from models and would silently drop the broken
      // edge. Go straight to the exact list so the operator can repair it.
      toast.info(
        tr(
          '这个定义包含已失效的模型关系，已打开精确编辑。',
          'This definition contains a model relation that no longer exists; the exact editor is open.',
        ),
      );
      setSelectedID(tree.id);
      openPairEditor(tree, tree.pairs);
      return;
    }
    setEditMode(true);
    setEditingTree(tree);
    setSelectedModels(new Set(definitionModelIDs(tree.pairs)));
    setSelectedID(tree.id);
    setSaveErr(null);
    setFocusOverride(null);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditingTree(null);
    setSelectedModels(new Set());
    setSaveOpen(false);
    setSaveErr(null);
    setPairEditor(null);
    setPairErr(null);
    setFocusOverride(null);
  };

  const locateModel = (id: number) => {
    const neighbours = graph.links.flatMap((link) => {
      if (link.from === id) return [link.to];
      if (link.to === id) return [link.from];
      return [];
    });
    setSelectedModels((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    setFocusOverride([...new Set([id, ...neighbours])]);
    setFocusVersion((version) => version + 1);
  };

  const toggleModel = (id: number) => {
    if (!editMode) return;
    setSelectedModels((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openSave = () => {
    if (selectionPairs.length === 0) {
      toast.error(
        tr('至少选择一对有关系的模型。', 'Select at least one connected pair of models.'),
      );
      return;
    }
    setSaveErr(null);
    setSaveOpen(true);
  };

  const saveDefinition = async (name: string, isPublic: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setSaveErr(tr('名称不能为空', 'A name is required'));
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      const input = {
        name: trimmed,
        cr_ids: selectionPairs,
        is_public: isPublic,
        option: editingTree?.option,
      };
      const saved = editingTree
        ? await updateServiceTree(editingTree.id, input)
        : await createServiceTree(input);
      setSaveOpen(false);
      setEditMode(false);
      setEditingTree(null);
      setSelectedModels(new Set());
      setFocusOverride(null);
      setSelectedID(saved.id);
      toast.success(editingTree ? tr('已保存', 'Saved') : tr('已创建', 'Created'));
      await load(true);
    } catch (error) {
      setSaveErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSaving(false);
    }
  };

  const saveExactDefinition = async (name: string, isPublic: boolean, pairs: TypePair[]) => {
    const target = pairEditor?.tree ?? null;
    setPairSaving(true);
    setPairErr(null);
    try {
      const input = {
        name,
        cr_ids: pairs,
        is_public: isPublic,
        option: target?.option,
      };
      const saved = target
        ? await updateServiceTree(target.id, input)
        : await createServiceTree(input);
      setPairEditor(null);
      setEditMode(false);
      setEditingTree(null);
      setSelectedModels(new Set());
      setSaveOpen(false);
      setSaveErr(null);
      setFocusOverride(null);
      setSelectedID(saved.id);
      toast.success(target ? tr('已保存', 'Saved') : tr('已创建', 'Created'));
      await load(true);
    } catch (error) {
      setPairErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setPairSaving(false);
    }
  };

  const removeDefinition = async (tree: ServiceTree) => {
    const ok = await confirmAction(
      tr(`删除服务树定义「${tree.name}」？用它的页面就打不开了。`, `Delete the tree definition “${tree.name}”? Pages that use it stop working.`),
    );
    if (!ok) return;
    try {
      await deleteServiceTree(tree.id);
      toast.success(tr('已删除', 'Deleted'));
      if (selectedID === tree.id) setSelectedID(null);
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const chosenTokens = shownDefinition ? serviceTreeChainTokens(shownDefinition.pairs, label) : [];
  const noRelations = !loading && graph.nodes.length === 0;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <WorkspaceBar
        leading={
          <>
            <span className="hidden lg:inline">{tr('资源模型', 'Resource models')}</span>
            <ChevronRight size={10} className="hidden lg:block" aria-hidden="true" />
            <h1 className="min-w-0 truncate text-xs font-medium text-text">{tr('关系视图', 'Relation view')}</h1>
            {shownDefinition && (
              <>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                <span className="flex min-w-0 items-center gap-1.5">
                  <Waypoints size={13} className="shrink-0 text-text-faint" aria-hidden="true" />
                  <span className="truncate text-text">{shownDefinition.name}</span>
                  {shownDefinition.is_public && <Chip tone="info" dense>{tr('公开', 'Public')}</Chip>}
                </span>
              </>
            )}
          </>
        }
        actions={
          <>
            <MetaPill label={tr('模型', 'Models')} value={graph.nodes.length} />
            <MetaPill label={tr('关系', 'Links')} value={graph.links.length} />
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing || editMode}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} className={cn((loading || refreshing) && 'animate-spin')} aria-hidden="true" />
              {tr('刷新', 'Refresh')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={startNew}
              disabled={!isAdmin || editMode || graph.nodes.length === 0}
              title={isAdmin ? undefined : tr('需要管理员权限', 'Administrator role required')}
              className="inline-flex items-center gap-1.5"
            >
              <Plus size={12} aria-hidden="true" />
              {tr('新建定义', 'New definition')}
            </Button>
          </>
        }
      />

      {loading && graph.nodes.length === 0 && definitions.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-text-muted">
          {tr('加载中…', 'Loading…')}
        </div>
      ) : err && graph.nodes.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-start justify-center p-6">
          <div role="alert" className="flex w-full max-w-xl flex-wrap items-center gap-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            <span className="min-w-0 flex-1 break-words">{err}</span>
            <Button variant="outline" size="sm" type="button" onClick={() => void load()}>
              {tr('重试', 'Retry')}
            </Button>
          </div>
        </div>
      ) : noRelations ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6">
          <EmptyStateCard
            className="w-full max-w-xl"
            icon={Waypoints}
            title={tr('还没有模型关系', 'No model relation yet')}
            hint={tr(
              '关系视图的节点来自模型关系。先在「关系」里把模型连起来，再回来定义服务树。',
              'The relation view is built from model relations. Connect some models under “Relations”, then define a tree here.',
            )}
            action={
              <Button variant="primary" size="sm" type="button" onClick={() => navigate('/cmdb/relations')} className="inline-flex items-center gap-1.5">
                <ChevronRight size={12} aria-hidden="true" />
                {tr('去模型关系', 'Go to relations')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {err && (
            <div role="alert" className="mx-3 mt-3 flex flex-wrap items-center gap-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
              <span className="min-w-0 flex-1 break-words">{err}</span>
              <Button variant="outline" size="sm" type="button" onClick={() => void load()}>
                {tr('重试', 'Retry')}
              </Button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="cmdb-workspace-band shrink-0 border-b border-border/50 px-4 py-2.5">
                {editMode ? (
                  <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-text">
                        {editingTree
                          ? tr(`编辑 ${editingTree.name}`, `Editing ${editingTree.name}`)
                          : tr('新建服务树定义', 'New tree definition')}
                      </span>
                      <span className="text-[11px] text-text-faint">
                        {tr(
                          '点击模型勾选，或用「定位模型」查找；至少组成一对有关系的关系。',
                          'Tick models on the canvas or use “Find a model”; at least one connected pair is required.',
                        )}
                      </span>
                      <div className="w-44 shrink-0">
                        <Select
                          label={tr('定位模型', 'Locate a model')}
                          value={locateValue}
                          onValueChange={(value) => {
                            if (!value) return;
                            locateModel(Number(value));
                            setLocateValue('');
                          }}
                          options={graph.nodes.map((node) => ({ value: String(node.id), label: node.label }))}
                          placeholder={tr('定位模型…', 'Find a model…')}
                          searchable
                          className="w-full"
                        />
                      </div>
                      {selectionTokens.length > 0 && (
                        <span className="flex min-w-0 flex-wrap items-center gap-1 text-[11px]">
                          {selectionTokens.map((token, index) => (
                            <span key={`${token}-${index}`} className="flex items-center gap-1">
                              {index > 0 && <ChevronRight size={10} className="text-text-faint" aria-hidden="true" />}
                              <span className="rounded border border-border bg-card px-1.5 py-0.5 text-text">
                                {token}
                              </span>
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={() => openPairEditor(editingTree, editingTree?.pairs ?? selectionPairs)}
                        className="inline-flex items-center gap-1.5"
                        title={tr('逐条编辑模型对', 'Edit individual model pairs')}
                      >
                        <ListChecks size={12} aria-hidden="true" />
                        {tr('精确模型对', 'Edit pairs')}
                      </Button>
                      <Button variant="outline" size="sm" type="button" onClick={cancelEdit}>
                        {tr('取消', 'Cancel')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        type="button"
                        onClick={openSave}
                        disabled={selectionPairs.length === 0}
                      >
                        {tr('保存', 'Save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <div className="w-full sm:w-64 lg:hidden">
                        <Select
                          label={tr('服务树定义', 'Tree definition')}
                          value={selectedID != null ? String(selectedID) : ''}
                          onValueChange={(value) => {
                            if (value) selectDefinition(Number(value));
                            else setSelectedID(null);
                          }}
                          options={[
                            { value: '', label: tr('全部模型', 'All models') },
                            ...definitions.map((tree) => ({
                              value: String(tree.id),
                              label: tree.is_public ? `${tree.name} · ${tr('公开', 'public')}` : tree.name,
                            })),
                          ]}
                          searchable
                          className="w-full"
                        />
                      </div>
                      {shownDefinition ? (
                        <>
                          <span className="truncate text-xs font-semibold text-text" title={shownDefinition.name}>
                            {shownDefinition.name}
                          </span>
                          <Chip dense>
                            {tr(
                              `${shownDefinition.pairs.length} 对关系`,
                              `${shownDefinition.pairs.length} ${shownDefinition.pairs.length === 1 ? 'pair' : 'pairs'}`,
                            )}
                          </Chip>
                          <span className="hidden min-w-0 flex-wrap items-center gap-1 text-[11px] lg:flex">
                            {chosenTokens.map((token, index) => (
                              <span key={`${token}-${index}`} className="flex items-center gap-1">
                                {index > 0 && <ChevronRight size={10} className="text-text-faint" aria-hidden="true" />}
                                <span className="rounded border border-border bg-card px-1.5 py-0.5 text-text">
                                  {token}
                                </span>
                              </span>
                            ))}
                          </span>
                        </>
                      ) : (
                        <span className="text-[11px] text-text-faint">
                          {definitions.length === 0
                            ? tr('还没有服务树定义，可先在画布上新建。', 'No definition yet; create one on the canvas.')
                            : tr('选择一个定义以高亮它的模型链。', 'Choose a definition to highlight its model chain.')}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div
                        role="group"
                        aria-label={tr('布局', 'Layout')}
                        className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
                      >
                        {LAYOUT_OPTIONS.map((option) => {
                          const Icon = option.icon;
                          return (
                            <Button
                              key={option.value}
                              variant="plain"
                              size="sm"
                              type="button"
                              aria-pressed={layoutMode === option.value}
                              aria-label={tr(option.label[0], option.label[1])}
                              title={tr(option.label[0], option.label[1])}
                              onClick={() => setLayoutMode(option.value)}
                              className={cn(
                                'inline-flex items-center gap-1 rounded px-2 py-1 text-[11px]',
                                layoutMode === option.value
                                  ? 'bg-card font-medium text-text shadow-sm'
                                  : 'text-text-muted hover:text-text',
                              )}
                            >
                              <Icon size={12} aria-hidden="true" />
                              <span className="hidden xl:inline">{tr(option.label[0], option.label[1])}</span>
                            </Button>
                          );
                        })}
                      </div>
                      {selectedDefinition && isAdmin && (
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() => startEdit(selectedDefinition)}
                          aria-label={tr('编辑当前定义', 'Edit the selected definition')}
                          title={tr('编辑当前定义', 'Edit the selected definition')}
                          className="inline-flex items-center gap-1 lg:hidden"
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </Button>
                      )}
                      {selectedDefinition && (
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() => setSelectedID(null)}
                          aria-label={tr('显示全部模型', 'Show all models')}
                          title={tr('显示全部模型', 'Show all models')}
                          className="inline-flex items-center gap-1"
                        >
                          <Network size={12} aria-hidden="true" />
                          <span className="hidden sm:inline">{tr('全部', 'All')}</span>
                        </Button>
                      )}
                      <Button
                        variant="subtle"
                        size="sm"
                        type="button"
                        onClick={() => setLayoutVersion((version) => version + 1)}
                        aria-label={tr('重置布局', 'Reset layout')}
                        title={tr('重置布局', 'Reset layout')}
                      >
                        <RotateCcw size={12} aria-hidden="true" />
                      </Button>
                      <Button
                        variant="subtle"
                        size="sm"
                        type="button"
                        onClick={() => setSidebarOpen((open) => !open)}
                        aria-label={sidebarOpen ? tr('收起定义栏', 'Collapse definitions') : tr('展开定义栏', 'Expand definitions')}
                        title={sidebarOpen ? tr('收起定义栏', 'Collapse definitions') : tr('展开定义栏', 'Expand definitions')}
                        className="hidden lg:inline-flex"
                      >
                        {sidebarOpen ? <PanelRightClose size={12} aria-hidden="true" /> : <PanelRightOpen size={12} aria-hidden="true" />}
                      </Button>
                    </div>
                  </div>
                )}
                {!editMode && shownDefinition && (
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] lg:hidden">
                    {chosenTokens.map((token, index) => (
                      <span key={`${token}-${index}`} className="flex items-center gap-1">
                        {index > 0 && <ChevronRight size={10} className="text-text-faint" aria-hidden="true" />}
                        <span className="rounded border border-border bg-card px-1.5 py-0.5 text-text">{token}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex min-h-0 flex-1 flex-col p-3">
                <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border/60 bg-card/60">
                  <RelationGraph
                    graph={graph}
                    positions={positions}
                    layoutMode={layoutMode}
                    resetKey={layoutVersion}
                    editMode={editMode}
                    selectedNodes={selectedModels}
                    highlightedNodes={highlightedNodes}
                    highlightedPairs={highlightedPairs}
                    focusIDs={focusIDs}
                    focusKey={focusKey}
                    onToggleNode={toggleModel}
                    onOpenNode={togglePreviewNode}
                    onCloseNode={() => setPreviewNodeID(null)}
                  />
                  {!editMode && previewModel && (
                    <ModelNodeCard
                      key={previewModel.id}
                      model={previewModel}
                      onClose={() => setPreviewNodeID(null)}
                    />
                  )}
                </div>
              </div>
            </section>

            {sidebarOpen && (
              <aside className="hidden w-80 shrink-0 flex-col border-s border-border/50 bg-card/30 lg:flex">
                <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="truncate text-[11px] font-medium text-text-muted">
                      {tr('服务树定义', 'Tree definitions')}
                    </h2>
                    <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] leading-none text-text-faint">
                      {definitions.length}
                    </span>
                  </div>
                  {!editMode && (
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => setSidebarOpen(false)}
                      aria-label={tr('收起定义栏', 'Collapse definitions')}
                      title={tr('收起定义栏', 'Collapse definitions')}
                    >
                      <PanelRightClose size={12} aria-hidden="true" />
                    </Button>
                  )}
                </div>
                <div className="px-3 py-2">
                  <Input
                    type="search"
                    value={definitionQuery}
                    onChange={(event) => setDefinitionQuery(event.target.value)}
                    placeholder={tr('搜索定义', 'Search definitions')}
                    aria-label={tr('搜索服务树定义', 'Search tree definitions')}
                  />
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
                  {filteredDefinitions.length === 0 ? (
                    <div className="px-2 py-8 text-center text-xs text-text-faint">
                      {definitions.length === 0
                        ? tr('还没有服务树定义', 'No tree definition yet')
                        : tr('没有匹配的定义', 'No matching definition')}
                    </div>
                  ) : (
                    filteredDefinitions.map((tree) => (
                      <DefinitionCard
                        key={tree.id}
                        tree={tree}
                        label={label}
                        selected={!editMode && selectedID === tree.id}
                        editing={editMode && editingTree?.id === tree.id}
                        unresolved={unresolved(tree)}
                        isAdmin={isAdmin && !editMode}
                        onSelect={() => selectDefinition(tree.id)}
                        onEdit={() => startEdit(tree)}
                        onAdvancedEdit={() => openPairEditor(tree, tree.pairs)}
                        onDelete={() => void removeDefinition(tree)}
                      />
                    ))
                  )}
                </div>
                {!editMode && isAdmin && (
                  <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2.5">
                    <Button
                      variant="subtle"
                      size="sm"
                      type="button"
                      onClick={startNew}
                      aria-label={tr('新建定义', 'New definition')}
                      title={tr('新建定义', 'New definition')}
                      disabled={graph.nodes.length === 0}
                    >
                      <Plus size={12} aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </aside>
            )}
          </div>
        </div>
      )}

      {saveOpen && (
        <DefinitionDialog
          tree={editingTree}
          pairs={selectionPairs}
          label={label}
          saving={saving}
          error={saveErr}
          onClose={() => {
            setSaveOpen(false);
            setSaveErr(null);
          }}
          onSubmit={(name, isPublic) => void saveDefinition(name, isPublic)}
        />
      )}

      {pairEditor && (
        <DefinitionPairsDialog
          tree={pairEditor.tree}
          relations={relations}
          initialPairs={pairEditor.pairs}
          saving={pairSaving}
          error={pairErr}
          onClose={() => {
            setPairEditor(null);
            setPairErr(null);
          }}
          onSubmit={(name, isPublic, pairs) => void saveExactDefinition(name, isPublic, pairs)}
        />
      )}

      {dialog}
    </div>
  );
}
