import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';

import { getCIType } from '../../api/citype';
import { describeError } from '../../api/http';
import { getIPAMTree, isSubnet, type IPAMNode, type IPAMTree } from '../../api/ipam';
import { flattenTree, nodeLabel } from '../../lib/ipam';

export type IPAMTab = 'overview' | 'address' | 'ipSearch' | 'subnet' | 'history';

export const IPAM_TABS: Array<{ value: IPAMTab; zh: string; en: string }> = [
  { value: 'overview', zh: '总览', en: 'Overview' },
  { value: 'address', zh: '地址分配', en: 'Addresses' },
  { value: 'ipSearch', zh: 'IP 搜索', en: 'IP search' },
  { value: 'subnet', zh: '子网列表', en: 'Ranges' },
  { value: 'history', zh: '历史', en: 'History' },
];

type TreeState = {
  roots: IPAMNode[];
  raw: Map<string, IPAMNode>;
  parentOf: Map<string, string>;
  type2name: Record<string, string>;
  label(node: IPAMNode | null | undefined): string;
  flat: IPAMNode[];
};

const EMPTY_TREE: TreeState = {
  roots: [],
  raw: new Map(),
  parentOf: new Map(),
  type2name: {},
  label: () => '',
  flat: [],
};

function buildTree(got: IPAMTree): TreeState {
  const raw = new Map<string, IPAMNode>();
  const parentOf = new Map<string, string>();
  const walk = (node: IPAMNode, parent: string | null) => {
    raw.set(String(node._id), node);
    if (parent != null) parentOf.set(String(node._id), parent);
    for (const child of node.children ?? []) walk(child, String(node._id));
  };
  for (const node of got.result ?? []) walk(node, null);
  return {
    roots: got.result ?? [],
    raw,
    parentOf,
    type2name: got.type2name ?? {},
    label: (node) => nodeLabel(node, got.type2name ?? {}),
    flat: flattenTree(got.result ?? []),
  };
}

type ContextValue = {
  tree: TreeState;
  loading: boolean;
  error: string | null;
  reload(quiet?: boolean): Promise<void>;
  /** `'all'` or a node id. */
  selectedID: string;
  selectedNode: IPAMNode | null;
  selectedIsSubnet: boolean;
  selectNode(id: string): void;
  tab: IPAMTab;
  setTab(tab: IPAMTab): void;
  tick: number;
  bump(): void;
  canMutate: boolean;
  subnetTypeID: number | null;
  addressTypeID: number | null;
  /** The subnet model's identifying attribute name (`name`, `subnet_name`, ...). */
  subnetUniqueKey: string;
  /** The attribute the tree labels a subnet by. */
  subnetNameKey: string;
};

const IPAMContext = createContext<ContextValue | null>(null);

function parseTab(raw: string | null): IPAMTab {
  return IPAM_TABS.some((tab) => tab.value === raw) ? (raw as IPAMTab) : 'overview';
}

export function IPAMProvider({ children }: { children: ReactNode }) {
  const { tr } = useI18n();
  const { canMutate } = usePermissions();
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const selectedID = params.get('node') ?? 'all';

  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [subnetTypeID, setSubnetTypeID] = useState<number | null>(null);
  const [addressTypeID, setAddressTypeID] = useState<number | null>(null);
  const [subnetUniqueKey, setSubnetUniqueKey] = useState('name');
  const [subnetNameKey, setSubnetNameKey] = useState('name');

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value == null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const reload = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const got = await getIPAMTree();
        setTree(buildTree(got));
      } catch (failure) {
        setError(describeError(failure, tr('无法读取地址空间', 'Could not load the address space')));
      } finally {
        setLoading(false);
      }
    },
    [tr],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // The two model ids the tabs search with. A deployment without the models
  // gets null and the tab explains it rather than issuing an empty query.
  useEffect(() => {
    let live = true;
    void getCIType('ipam_subnet')
      .then((type) => {
        if (!live) return;
        setSubnetTypeID(type.id);
        setSubnetUniqueKey(type.unique_key || 'name');
        setSubnetNameKey(type.show_name || type.unique_key || 'name');
      })
      .catch(() => live && setSubnetTypeID(null));
    void getCIType('ipam_address')
      .then((type) => live && setAddressTypeID(type.id))
      .catch(() => live && setAddressTypeID(null));
    return () => {
      live = false;
    };
  }, []);

  // A DEEP LINK THAT NAMES A DELETED NODE falls back to the whole space once
  // the tree has loaded. Doing it before the fetch would rewrite every link
  // while the tree is still empty.
  useEffect(() => {
    if (loading) return;
    if (selectedID === 'all') return;
    if (!tree.raw.has(selectedID)) updateParam('node', 'all');
  }, [loading, selectedID, tree.raw, updateParam]);

  const selectedNode = selectedID === 'all' ? null : tree.raw.get(selectedID) ?? null;

  const value = useMemo<ContextValue>(
    () => ({
      tree,
      loading,
      error,
      reload,
      selectedID,
      selectedNode,
      selectedIsSubnet: isSubnet(selectedNode),
      selectNode: (id) => updateParam('node', id),
      tab,
      setTab: (next) => updateParam('tab', next),
      tick,
      bump: () => setTick((current) => current + 1),
      canMutate,
      subnetTypeID,
      addressTypeID,
      subnetUniqueKey,
      subnetNameKey,
    }),
    [
      tree,
      loading,
      error,
      reload,
      selectedID,
      selectedNode,
      tab,
      tick,
      canMutate,
      subnetTypeID,
      addressTypeID,
      subnetUniqueKey,
      subnetNameKey,
      updateParam,
    ],
  );

  return <IPAMContext.Provider value={value}>{children}</IPAMContext.Provider>;
}

export function useIPAM(): ContextValue {
  const value = useContext(IPAMContext);
  if (!value) throw new Error('useIPAM must be used inside IPAMProvider');
  return value;
}
