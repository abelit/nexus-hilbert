import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  FolderPlus,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Waypoints,
} from 'lucide-react';

import { Button, EmptyStateCard } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/store/me';

import { listCITypes, type CIType } from '../api/citype';
import { describeError } from '../api/http';
import {
  createTopologyGroup,
  deleteTopologyGroup,
  deleteTopologyView,
  getTopologyGraph,
  listTopologyGroups,
  listTopologyViews,
  reorderTopologyGroups,
  updateTopologyGroup,
  type TopologyGraph,
  type TopologyGroup,
  type TopologyView,
} from '../api/topology';
import { MetaPill } from '../components/MetaPill';
import type { DragSource } from '../components/GroupedSortable';
import { TopoGraph, type TopoSelectedNode } from '../components/topology/TopoGraph';
import { TopologyNodeCard } from '../components/topology/TopologyNodeCard';
import { TopologySidebar } from '../components/topology/TopologySidebar';
import { TopologyViewDrawer } from '../components/topology/TopologyViewDrawer';
import { useToast } from '../components/Toast';
import { WorkspaceBar } from '../components/WorkspaceBar';

// 拓扑视图 — saved walks drawn as graphs.
//
// THE SIDEBAR IS THE SAVED CONFIGURATION and the canvas is the current estate:
// selecting a view assembles it from today's relations, so an edge added this
// morning appears without re-saving anything. That is the whole difference
// between a view and an exported picture.
//
// THE PAGE OWNS THE WRITES. The sidebar rearranges a local copy and reports the
// drop; this page turns a group drop into the group order endpoint and a view
// drop into the affected groups' ordered membership. Nothing is written while
// the pointer is still moving.

export default function TopologyViewsPage() {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();

  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [views, setViews] = useState<TopologyView[]>([]);
  const [models, setModels] = useState<CIType[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedID, setSelectedID] = useState<number | null>(null);

  const [graph, setGraph] = useState<TopologyGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphErr, setGraphErr] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TopoSelectedNode | null>(null);

  const [drawer, setDrawer] = useState<TopologyView | 'new' | null>(null);
  const [newViewGroupID, setNewViewGroupID] = useState<number | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupEdit, setGroupEdit] = useState<TopologyGroup | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupErr, setGroupErr] = useState<string | null>(null);

  const loadLists = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setErr(null);
      try {
        const [gotGroups, gotViews] = await Promise.all([listTopologyGroups(), listTopologyViews()]);
        setGroups(gotGroups);
        setViews(gotViews);
        setSelectedID((current) => {
          if (current != null && gotViews.some((view) => view.id === current)) return current;
          const firstGrouped = gotGroups.flatMap((group) => group.views)[0];
          return firstGrouped?.id ?? gotViews[0]?.id ?? null;
        });
      } catch (error) {
        setErr(describeError(error, tr('无法读取拓扑视图', 'Could not load the topology views')));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [tr],
  );

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  // Models are needed for the node card, not only for the create form; every
  // operator who can read a view can read the catalogue.
  useEffect(() => {
    void listCITypes()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  // A GRAPH BELONGS TO THE VIEW THAT ASKED FOR IT. The sequence guards against
  // a late response from a view the operator has already left; clearing the
  // previous graph before the request also stops a failed view from showing
  // its predecessor's picture under its own title.
  const graphSeq = useRef(0);

  const loadGraph = useCallback(
    async (id: number) => {
      const seq = ++graphSeq.current;
      setGraph(null);
      setGraphErr(null);
      setGraphLoading(true);
      try {
        const got = await getTopologyGraph(id);
        if (seq === graphSeq.current) setGraph(got);
      } catch (error) {
        if (seq === graphSeq.current) {
          setGraphErr(describeError(error, tr('无法装配拓扑图', 'Could not assemble the graph')));
        }
      } finally {
        if (seq === graphSeq.current) setGraphLoading(false);
      }
    },
    [tr],
  );

  useEffect(() => {
    setSelectedNode(null);
    if (selectedID == null) {
      graphSeq.current += 1;
      setGraph(null);
      setGraphErr(null);
      setGraphLoading(false);
      return;
    }
    void loadGraph(selectedID);
    return () => {
      // Invalidate this request on unmount or when the selection changes.
      graphSeq.current += 1;
    };
  }, [selectedID, loadGraph]);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await loadLists(true);
      if (selectedID != null) await loadGraph(selectedID);
    } finally {
      setRefreshing(false);
    }
  };

  const selectedView = views.find((view) => view.id === selectedID) ?? null;
  const grouped = new Set(groups.flatMap((group) => group.views.map((view) => view.id)));
  const ungrouped = views.filter((view) => !grouped.has(view.id));
  const centralModel = models.find((model) => model.id === selectedView?.central_node_type) ?? null;
  const typeLabels = useMemo(
    () => Object.fromEntries(models.map((model) => [model.id, model.alias || model.name])),
    [models],
  );
  const selectedGroupName = selectedView?.group_id
    ? groups.find((group) => group.id === selectedView.group_id)?.name
    : undefined;
  const nodeModel = models.find((model) => model.id === selectedNode?.typeID) ?? null;
  const rootQuery = selectedView?.central_node_instances?.trim() || tr('全部实例', 'All instances');

  const viewOptions = useMemo(() => {
    const seen = new Set<number>();
    const out: Array<{ value: string; label: string }> = [];
    for (const group of groups) {
      for (const view of group.views) {
        if (seen.has(view.id)) continue;
        seen.add(view.id);
        out.push({ value: String(view.id), label: `${group.name} · ${view.name}` });
      }
    }
    for (const view of ungrouped) {
      if (seen.has(view.id)) continue;
      seen.add(view.id);
      out.push({ value: String(view.id), label: view.name });
    }
    return out;
  }, [groups, ungrouped]);

  const selectView = (id: number) => {
    setSelectedNode(null);
    setSelectedID(id);
  };

  const openNewView = (groupID?: number) => {
    setNewViewGroupID(groupID ?? null);
    setDrawer('new');
  };

  const openEditView = (view: TopologyView) => {
    setNewViewGroupID(null);
    setDrawer(view);
  };

  const openGroupCreate = () => {
    setGroupEdit(null);
    setGroupName('');
    setGroupErr(null);
    setGroupOpen(true);
  };

  const openGroupEdit = (group: TopologyGroup) => {
    setGroupEdit(group);
    setGroupName(group.name);
    setGroupErr(null);
    setGroupOpen(true);
  };

  const removeView = async (view: TopologyView) => {
    const ok = await confirmAction(
      tr(`删除拓扑视图「${view.name}」？`, `Delete the topology view “${view.name}”?`),
    );
    if (!ok) return;
    try {
      await deleteTopologyView(view.id);
      toast.success(tr('已删除', 'Deleted'));
      setSelectedID(null);
      setSelectedNode(null);
      await loadLists(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const removeGroup = async (group: TopologyGroup) => {
    const ok = await confirmAction(
      tr(`删除分组「${group.name}」？分组里还有视图时会被拒绝。`,
        `Delete the group “${group.name}”? A group that still holds views is refused.`),
    );
    if (!ok) return;
    try {
      await deleteTopologyGroup(group.id);
      toast.success(tr('已删除', 'Deleted'));
      await loadLists(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  const saveGroup = async () => {
    const name = groupName.trim();
    if (!name) {
      setGroupErr(tr('名称不能为空', 'A name is required'));
      return;
    }
    setGroupSaving(true);
    setGroupErr(null);
    try {
      if (groupEdit) {
        // keep the membership while renaming: the endpoint also takes the order
        await updateTopologyGroup(groupEdit.id, {
          name,
          view_ids: groupEdit.views.map((view) => view.id),
        });
        toast.success(tr('已保存', 'Saved'));
      } else {
        await createTopologyGroup(name);
        toast.success(tr('已创建分组', 'Group created'));
      }
      setGroupOpen(false);
      setGroupEdit(null);
      setGroupName('');
      await loadLists(true);
    } catch (error) {
      setGroupErr(describeError(error, tr('保存失败', 'Could not save it')));
    } finally {
      setGroupSaving(false);
    }
  };

  const commitArrange = async (source: DragSource, next: TopologyGroup[]) => {
    setGroups(next);
    try {
      if (source.type === 'group') {
        await reorderTopologyGroups(next.map((group) => group.id));
      } else {
        // A view move can touch two groups. Writing every group's ordered
        // membership is idempotent and avoids reconstructing which side the
        // drop changed after dnd-kit's in-place updates.
        await Promise.all(
          next.map((group) =>
            updateTopologyGroup(group.id, {
              name: group.name,
              view_ids: group.views.map((view) => view.id),
            }),
          ),
        );
      }
      toast.success(tr('顺序已保存', 'Order saved'));
      await loadLists(true);
    } catch (error) {
      toast.error(describeError(error, tr('保存顺序失败', 'Could not save the order')));
      await loadLists(true);
    }
  };

  const handleNodeSelect = (node: TopoSelectedNode) => {
    if (!models.some((model) => model.id === node.typeID)) {
      toast.error(tr('找不到这个节点的模型', 'The node model could not be found'));
      return;
    }
    setSelectedNode(node);
  };

  const noData = !loading && groups.length === 0 && views.length === 0 && !err;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <WorkspaceBar
        leading={
          <>
            <span className="hidden lg:inline">{tr('资源模型', 'Resource models')}</span>
            <ChevronRight size={10} className="hidden lg:block" aria-hidden="true" />
            <h1 className="min-w-0 truncate text-xs font-medium text-text">
              {tr('拓扑视图', 'Topology views')}
            </h1>
            {selectedView && (
              <>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                <span className="flex min-w-0 items-center gap-1.5">
                  <Waypoints size={13} className="shrink-0 text-text-faint" aria-hidden="true" />
                  <span className="truncate text-text">{selectedView.name}</span>
                </span>
              </>
            )}
          </>
        }
        actions={
          <>
            <MetaPill label={tr('视图', 'Views')} value={views.length} />
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void refreshAll()}
              disabled={loading || graphLoading || refreshing}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw
                size={12}
                className={cn((loading || graphLoading || refreshing) && 'animate-spin')}
                aria-hidden="true"
              />
              {tr('刷新', 'Refresh')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={openGroupCreate}
              disabled={!isAdmin}
              className="inline-flex items-center gap-1.5"
            >
              <FolderPlus size={12} aria-hidden="true" />
              {tr('新建分组', 'New group')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => openNewView()}
              disabled={!isAdmin}
              className="inline-flex items-center gap-1.5"
            >
              <Plus size={12} aria-hidden="true" />
              {tr('新建视图', 'New view')}
            </Button>
          </>
        }
      />

      {loading && groups.length === 0 && views.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-text-muted">
          {tr('加载中…', 'Loading…')}
        </div>
      ) : err && groups.length === 0 && views.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-start justify-center p-6">
          <div role="alert" className="flex w-full max-w-xl flex-wrap items-center gap-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            <span className="min-w-0 flex-1 break-words">{err}</span>
            <Button variant="outline" size="sm" type="button" onClick={() => void loadLists()}>
              {tr('重试', 'Retry')}
            </Button>
          </div>
        </div>
      ) : noData ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6">
          <EmptyStateCard
            className="w-full max-w-xl"
            icon={Waypoints}
            title={tr('还没有拓扑视图', 'No topology view yet')}
            hint={tr(
              '拓扑视图保存一次关系遍历：中心模型、根实例查询，以及向下 / 向上的层级。',
              'A topology view saves a relation walk: a central model, a root query, and the levels below and above.',
            )}
            action={
              isAdmin ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="primary" size="sm" type="button" onClick={() => openNewView()} className="inline-flex items-center gap-1.5">
                    <Plus size={12} aria-hidden="true" />
                    {tr('新建视图', 'New view')}
                  </Button>
                  <Button variant="outline" size="sm" type="button" onClick={openGroupCreate} className="inline-flex items-center gap-1.5">
                    <FolderPlus size={12} aria-hidden="true" />
                    {tr('新建分组', 'New group')}
                  </Button>
                </div>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {err && (
            <div role="alert" className="mx-3 mt-3 flex flex-wrap items-center gap-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
              <span className="min-w-0 flex-1 break-words">{err}</span>
              <Button variant="outline" size="sm" type="button" onClick={() => void loadLists()}>
                {tr('重试', 'Retry')}
              </Button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="hidden w-72 shrink-0 border-e border-border/50 bg-card/30 lg:flex">
              <TopologySidebar
                groups={groups}
                ungrouped={ungrouped}
                selected={selectedID}
                loading={loading}
                isAdmin={isAdmin}
                onSelect={selectView}
                onNewView={openNewView}
                onEditGroup={openGroupEdit}
                onDeleteGroup={(group) => void removeGroup(group)}
                onEditView={openEditView}
                onDeleteView={(view) => void removeView(view)}
                onArrange={setGroups}
                onCommit={(source, next) => void commitArrange(source, next)}
                onCancelArrange={() => void loadLists(true)}
              />
            </aside>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="cmdb-workspace-band shrink-0 border-b border-border/50 px-4 py-2.5">
                <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <div className="w-full sm:w-64 lg:hidden">
                      <Select
                        label={tr('拓扑视图', 'Topology view')}
                        value={selectedID != null ? String(selectedID) : ''}
                        onValueChange={(value) => selectView(Number(value))}
                        options={viewOptions}
                        searchable
                        className="w-full"
                      />
                    </div>
                    {selectedView ? (
                      <>
                        <h2 className="min-w-0 truncate text-sm font-semibold text-text" title={selectedView.name}>
                          {selectedView.name}
                        </h2>
                        <Chip>{selectedGroupName ?? tr('未分组', 'Ungrouped')}</Chip>
                        <span className="text-[11px] text-text-muted">
                          {tr('中心模型', 'Central')}{' '}
                          <span className="text-text">
                            {centralModel?.alias || centralModel?.name || `#${selectedView.central_node_type}`}
                          </span>
                        </span>
                        <code
                          className="max-w-48 truncate rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-text-faint"
                          title={rootQuery}
                        >
                          {rootQuery}
                        </code>
                      </>
                    ) : (
                      <h2 className="text-sm font-semibold text-text">{tr('未选择视图', 'No view selected')}</h2>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {graph && (
                      <span className="text-[11px] text-text-faint">
                        {tr(
                          `${graph.nodes.length} 个节点，${graph.links.length} 条边`,
                          `${graph.nodes.length} nodes, ${graph.links.length} links`,
                        )}
                      </span>
                    )}
                    {selectedView && (
                      <>
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() => openEditView(selectedView)}
                          disabled={!isAdmin}
                          aria-label={tr('编辑拓扑视图', 'Edit the topology view')}
                          className="inline-flex items-center gap-1"
                        >
                          <Pencil size={12} aria-hidden="true" />
                          {tr('编辑', 'Edit')}
                        </Button>
                        <Button
                          variant="dangerGhost"
                          size="sm"
                          type="button"
                          onClick={() => void removeView(selectedView)}
                          disabled={!isAdmin}
                          aria-label={tr('删除拓扑视图', 'Delete the topology view')}
                          className="inline-flex items-center gap-1"
                        >
                          <Trash2 size={12} aria-hidden="true" />
                          {tr('删除', 'Delete')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col p-3">
                <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/60">
                  {selectedView == null ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                      <EmptyState
                        icon={Waypoints}
                        title={tr('选择一个拓扑视图', 'Choose a topology view')}
                        hint={tr('左侧列出已保存的视图；新建一个开始。', 'The left list holds the saved views. Create one to start.')}
                        action={
                          isAdmin ? (
                            <Button variant="primary" size="sm" type="button" onClick={() => openNewView()} className="inline-flex items-center gap-1.5">
                              <Plus size={12} aria-hidden="true" />
                              {tr('新建视图', 'New view')}
                            </Button>
                          ) : undefined
                        }
                      />
                    </div>
                  ) : graphErr ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                      <p role="alert" className="max-w-xl break-words rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
                        {graphErr}
                      </p>
                      <Button variant="outline" size="sm" type="button" onClick={() => void loadGraph(selectedView.id)}>
                        {tr('重试', 'Retry')}
                      </Button>
                    </div>
                  ) : graphLoading ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-text-muted">
                      {tr('正在装配拓扑图…', 'Assembling the graph…')}
                    </div>
                  ) : graph == null || graph.nodes.length === 0 ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                      <EmptyState
                        icon={Waypoints}
                        title={tr('这个视图没有匹配的实例', 'This view matches no instance')}
                        hint={tr(
                          '检查根实例查询与路径层级是否与现有关系一致。',
                          'Check that the root query and the path levels agree with the relations that exist.',
                        )}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="min-h-0 flex-1">
                        <TopoGraph
                          graph={graph}
                          selectedID={selectedNode?.id ?? null}
                          typeLabels={typeLabels}
                          onSelect={handleNodeSelect}
                        />
                      </div>
                      {selectedNode && nodeModel && (
                        <TopologyNodeCard
                          node={selectedNode}
                          model={nodeModel}
                          onClose={() => setSelectedNode(null)}
                        />
                      )}
                    </>
                  )}
                </section>
              </div>
            </section>
          </div>
        </div>
      )}

      {drawer && (
        <TopologyViewDrawer
          view={drawer === 'new' ? null : drawer}
          groups={groups}
          models={models}
          initialGroupID={drawer === 'new' ? newViewGroupID : undefined}
          onClose={() => {
            setDrawer(null);
            setNewViewGroupID(null);
          }}
          onSaved={async (message) => {
            setDrawer(null);
            setNewViewGroupID(null);
            toast.success(message);
            await loadLists(true);
          }}
        />
      )}

      <Modal
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        title={groupEdit ? tr('编辑分组', 'Edit group') : tr('新建分组', 'New group')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => setGroupOpen(false)} disabled={groupSaving}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button variant="primary" type="button" onClick={() => void saveGroup()} disabled={groupSaving}>
              {groupSaving
                ? tr('保存中…', 'Saving…')
                : groupEdit
                  ? tr('保存', 'Save')
                  : tr('创建', 'Create')}
            </Button>
          </div>
        }
      >
        {groupErr && (
          <p role="alert" className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-text-muted">
            {groupErr}
          </p>
        )}
        <Label htmlFor="topo-group-name">{tr('分组名称', 'Group name')}</Label>
        <Input
          id="topo-group-name"
          aria-label={tr('分组名称', 'Group name')}
          value={groupName}
          onChange={(event) => setGroupName(event.target.value)}
          className="mt-1 w-full"
        />
      </Modal>

      {dialog}
    </div>
  );
}
