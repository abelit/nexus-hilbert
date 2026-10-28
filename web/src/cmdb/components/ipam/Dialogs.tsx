import { useEffect, useId, useMemo, useState } from 'react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import { describeError } from '../../api/http';
import {
  createIPScope,
  createSubnet,
  deleteIPScope,
  deleteSubnet,
  getSubnet,
  moveSubnet,
  updateIPScope,
  updateSubnet,
  type IPAMNode,
} from '../../api/ipam';
import { cidrHostCount, isSubnet, subtreeHostCount } from '../../lib/ipam';
import { useIPAM } from './context';

type Saved = (message: string) => void | Promise<void>;

export function NodeDialogs({
  state,
  onClose,
  onSaved,
}: {
  state: DialogState | null;
  onClose(): void;
  onSaved: Saved;
}) {
  if (!state) return null;
  if (state.kind === 'scope') {
    return <ScopeDialog mode={state.mode} node={state.node} parent={state.parent} onClose={onClose} onSaved={onSaved} />;
  }
  if (state.kind === 'subnet') {
    return <SubnetDialog mode={state.mode} node={state.node} parent={state.parent} onClose={onClose} onSaved={onSaved} />;
  }
  if (state.kind === 'delete') {
    return <DeleteNodeDialog node={state.node} onClose={onClose} onSaved={onSaved} />;
  }
  return <MoveDialog node={state.node} onClose={onClose} onSaved={onSaved} />;
}

export type DialogState =
  | { kind: 'scope'; mode: 'create' | 'edit'; node?: IPAMNode | null; parent?: IPAMNode | null }
  | { kind: 'subnet'; mode: 'create' | 'edit'; node?: IPAMNode | null; parent?: IPAMNode | null }
  | { kind: 'delete'; node: IPAMNode }
  | { kind: 'move'; node: IPAMNode };

// --- scope ---

function ScopeDialog({
  mode,
  node,
  parent,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  node?: IPAMNode | null;
  parent?: IPAMNode | null;
  onClose(): void;
  onSaved: Saved;
}) {
  const { tr } = useI18n();
  const { tree } = useIPAM();
  const [name, setName] = useState(mode === 'edit' && node ? tree.label(node) : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formID = useId();

  const submit = async () => {
    if (!name.trim()) {
      setError(tr('名称不能为空', 'A name is required'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'edit' && node) {
        await updateIPScope(node._id, name.trim());
        await onSaved(tr('分组已重命名', 'Group renamed'));
      } else {
        await createIPScope({ ...(parent ? { parent_id: parent._id } : {}), name: name.trim() });
        await onSaved(tr('已创建分组', 'Group created'));
      }
    } catch (failure) {
      setError(describeError(failure, tr('保存失败', 'Could not save it')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'edit' ? tr('重命名分组', 'Rename group') : tr('新建分组', 'New group')}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formID} disabled={submitting}>
            {submitting ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </>
      }
    >
      <form
        id={formID}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        {error && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <div>
          <Label htmlFor="ipam-scope-name">{tr('名称', 'Name')}</Label>
          <Input
            id="ipam-scope-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={Boolean(error) && !name.trim()}
            autoFocus
            className="mt-1 w-full"
          />
        </div>
        {mode === 'create' && parent && (
          <p className="text-[11px] text-text-faint">
            {tr(`将建在「${tree.label(parent)}」下面`, `Created under “${tree.label(parent)}”`)}
          </p>
        )}
      </form>
    </Modal>
  );
}

// --- subnet ---

function SubnetDialog({
  mode,
  node,
  parent,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  node?: IPAMNode | null;
  parent?: IPAMNode | null;
  onClose(): void;
  onSaved: Saved;
}) {
  const { tr } = useI18n();
  const { tree, subnetUniqueKey } = useIPAM();
  const [name, setName] = useState(mode === 'edit' && node ? tree.label(node) : '');
  const [cidr, setCidr] = useState(mode === 'edit' && node ? String(node.cidr ?? '') : '');
  const [scanEnabled, setScanEnabled] = useState(false);
  const [cron, setCron] = useState('');
  const [agentID, setAgentID] = useState('');
  const [loading, setLoading] = useState(mode === 'edit');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formID = useId();

  useEffect(() => {
    if (mode !== 'edit' || !node) return;
    let live = true;
    setLoading(true);
    void getSubnet(node._id)
      .then((detail) => {
        if (!live) return;
        setName(String(detail.name ?? detail.subnet_name ?? tree.label(node)));
        setCidr(String(detail.cidr ?? ''));
        setScanEnabled(Boolean(detail.scan_enabled));
        setCron(String(detail.cron ?? ''));
        setAgentID(String(detail.agent_id ?? ''));
      })
      .catch((failure) => live && setError(describeError(failure, tr('无法读取网段', 'Could not load the range'))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [mode, node, tree, tr]);

  const submit = async () => {
    if (!name.trim()) {
      setError(tr('名称不能为空', 'A name is required'));
      return;
    }
    if (!cidr.trim()) {
      setError(tr('网段不能为空', 'A range is required'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // THE MODEL'S OWN IDENTIFYING ATTRIBUTE. A deployment migrated from
      // cantor calls it `name`; an older built-in model calls it `subnet_name`.
      const named = { [subnetUniqueKey]: name.trim() };
      if (mode === 'edit' && node) {
        await updateSubnet(node._id, {
          cidr: cidr.trim(),
          ...named,
          scan_enabled: scanEnabled,
          agent_id: scanEnabled ? agentID.trim() : undefined,
          cron: scanEnabled ? cron.trim() : undefined,
        });
        await onSaved(tr('已保存', 'Saved'));
      } else {
        await createSubnet({
          ...(parent ? { parent_id: parent._id } : {}),
          cidr: cidr.trim(),
          ...named,
          ...(scanEnabled ? { scan_enabled: true, agent_id: agentID.trim(), cron: cron.trim() } : {}),
        });
        await onSaved(tr('已创建网段', 'Range created'));
      }
    } catch (failure) {
      setError(describeError(failure, tr('保存失败', 'Could not save it')));
    } finally {
      setSubmitting(false);
    }
  };

  const hostCount = cidrHostCount(cidr);

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'edit' ? tr('编辑网段', 'Edit range') : tr('新建网段', 'New range')}
      size="lg"
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formID} disabled={submitting || loading}>
            {submitting ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
      ) : (
        <form
          id={formID}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-3"
        >
          {error && (
            <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <div>
            <Label htmlFor="ipam-subnet-name">{tr('名称', 'Name')}</Label>
            <Input
              id="ipam-subnet-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              aria-invalid={Boolean(error) && !name.trim()}
              className="mt-1 w-full"
            />
          </div>
          <div>
            <Label htmlFor="ipam-subnet-cidr">{tr('网段 (CIDR)', 'Range (CIDR)')}</Label>
            <Input
              id="ipam-subnet-cidr"
              value={cidr}
              onChange={(event) => setCidr(event.target.value)}
              placeholder="10.0.0.0/24"
              aria-invalid={Boolean(error) && !cidr.trim()}
              className="mt-1 w-full font-mono"
            />
            <p className="mt-1 text-[11px] text-text-faint">
              {tr(
                `只接受 IPv4，前缀 8–31。${hostCount > 0 ? `该范围有 ${hostCount} 个可用地址。` : ''}`,
                `IPv4 only, prefix 8–31.${hostCount > 0 ? ` The range holds ${hostCount} usable addresses.` : ''}`,
              )}
            </p>
          </div>
          {mode === 'create' && parent && (
            <p className="text-[11px] text-text-faint">
              {tr(`将建在「${tree.label(parent)}」下面`, `Created under “${tree.label(parent)}”`)}
            </p>
          )}

          <div className="rounded-md border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-text">{tr('开启扫描', 'Enable scanning')}</div>
                <div className="text-[11px] text-text-faint">
                  {tr(
                    '扫描规则单独存储；调度由自动发现的执行端承担。',
                    'The rule is stored on its own; the discovery executor runs it.',
                  )}
                </div>
              </div>
              <Switch checked={scanEnabled} onCheckedChange={setScanEnabled} aria-label={tr('开启扫描', 'Enable scanning')} />
            </div>
            {scanEnabled && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="ipam-subnet-cron">{tr('Cron', 'Cron')}</Label>
                  <Input
                    id="ipam-subnet-cron"
                    value={cron}
                    onChange={(event) => setCron(event.target.value)}
                    placeholder="0 3 * * *"
                    className="mt-1 w-full font-mono"
                  />
                </div>
                <div>
                  <Label htmlFor="ipam-subnet-agent">{tr('执行目标', 'Execution target')}</Label>
                  <Input
                    id="ipam-subnet-agent"
                    value={agentID}
                    onChange={(event) => setAgentID(event.target.value)}
                    placeholder="0x0000"
                    className="mt-1 w-full font-mono"
                  />
                  <p className="mt-1 text-[11px] text-text-faint">
                    {tr('0x0000 表示 master；留空表示不限。', '0x0000 means the master; blank means unbound.')}
                  </p>
                </div>
              </div>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}

// --- delete ---

function DeleteNodeDialog({
  node,
  onClose,
  onSaved,
}: {
  node: IPAMNode;
  onClose(): void;
  onSaved: Saved;
}) {
  const { tr } = useI18n();
  const { tree } = useIPAM();
  const name = tree.label(node);
  const subnet = isSubnet(node);
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const children = (node.children ?? []).length;
  const hosts = subnet ? cidrHostCount(node.cidr) : subtreeHostCount(node);
  const formID = useId();

  const submit = async () => {
    if (typed.trim() !== name) return;
    setSubmitting(true);
    setError(null);
    try {
      if (subnet) await deleteSubnet(node._id);
      else await deleteIPScope(node._id);
      await onSaved(subnet ? tr('网段已删除', 'Range deleted') : tr('分组已删除', 'Group deleted'));
    } catch (failure) {
      setError(describeError(failure, tr('删除失败', 'Delete failed')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={subnet ? tr('删除网段', 'Delete range') : tr('删除分组', 'Delete group')}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            variant="danger"
            type="submit"
            form={formID}
            disabled={submitting || typed.trim() !== name}
          >
            {submitting ? tr('删除中…', 'Deleting…') : tr('删除', 'Delete')}
          </Button>
        </>
      }
    >
      <form
        id={formID}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          <div className="font-medium">{tr('此操作不可撤销。', 'This cannot be undone.')}</div>
          <div className="mt-1">
            {subnet
              ? tr(
                  `删除网段「${name}」？网段里还有地址时服务端会拒绝。`,
                  `Delete the range “${name}”? The server refuses while it still holds addresses.`,
                )
              : tr(
                  `删除分组「${name}」？分组里还有节点时服务端会拒绝。`,
                  `Delete the group “${name}”? The server refuses while it still has children.`,
                )}
          </div>
          {(children > 0 || hosts > 0) && (
            <div className="mt-1 text-[11px]">
              {tr(`当前包含 ${children} 个子节点、${hosts} 个地址容量。`, `It currently holds ${children} child nodes and ${hosts} addresses of capacity.`)}
            </div>
          )}
        </div>
        {error && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <div>
          <Label htmlFor="ipam-delete-confirm">
            {tr(`输入「${name}」确认`, `Type “${name}” to confirm`)}
          </Label>
          <Input
            id="ipam-delete-confirm"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoFocus
            className="mt-1 w-full font-mono"
          />
        </div>
      </form>
    </Modal>
  );
}

// --- move ---

function MoveDialog({
  node,
  onClose,
  onSaved,
}: {
  node: IPAMNode;
  onClose(): void;
  onSaved: Saved;
}) {
  const { tr } = useI18n();
  const { tree } = useIPAM();
  const ROOT = 'root';
  const [target, setTarget] = useState(ROOT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formID = useId();

  const excluded = useMemo(() => descendantIDs(node), [node]);
  const currentParent = tree.parentOf.get(String(node._id));
  const options = useMemo(
    () => [
      { value: ROOT, label: tr('根（无上级）', 'Root (no parent)') },
      ...tree.flat
        .filter((candidate) => String(candidate._id) !== String(node._id) && !excluded.has(String(candidate._id)))
        .map((candidate) => ({
          value: String(candidate._id),
          label: `${tree.label(candidate)}${isSubnet(candidate) ? ` · ${String(candidate.cidr ?? '')}` : ''}`,
        })),
    ],
    [excluded, node._id, tree, tr],
  );

  useEffect(() => {
    if (currentParent) setTarget(currentParent);
  }, [currentParent]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await moveSubnet(node._id, target === ROOT ? undefined : Number(target));
      await onSaved(tr('已移动', 'Moved'));
    } catch (failure) {
      setError(describeError(failure, tr('移动失败', 'Could not move it')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('移动网段', 'Move the range')}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formID} disabled={submitting}>
            {submitting ? tr('移动中…', 'Moving…') : tr('移动', 'Move')}
          </Button>
        </>
      }
    >
      <form
        id={formID}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        {error && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <p className="text-xs text-text-muted">
          {tr(
            `「${tree.label(node)}」当前在「${currentParent ? tree.label(tree.raw.get(currentParent)) : tr('根', 'the root')}」。`,
            `“${tree.label(node)}” currently sits under ${currentParent ? `“${tree.label(tree.raw.get(currentParent))}”` : 'the root'}.`,
          )}
        </p>
        <div>
          <Label htmlFor="ipam-move-target">{tr('新上级', 'New parent')}</Label>
          <Select
            id="ipam-move-target"
            label={tr('新上级', 'New parent')}
            value={target}
            onValueChange={setTarget}
            options={options}
            searchable
            className="mt-1 w-full"
          />
          <p className="mt-1 text-[11px] text-text-faint">
            {tr(
              '网段会在服务端按新上级重新校验范围。',
              'The server revalidates the range against the destination.',
            )}
          </p>
        </div>
      </form>
    </Modal>
  );
}

function descendantIDs(node: IPAMNode): Set<string> {
  const out = new Set<string>();
  const walk = (children: IPAMNode[] | undefined) => {
    for (const child of children ?? []) {
      out.add(String(child._id));
      walk(child.children);
    }
  };
  walk(node.children);
  return out;
}
