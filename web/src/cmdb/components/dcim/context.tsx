import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';

import {
  getCIType,
  listAttributeGroups,
  listCITypes,
  listTypeAttributes,
  type AttributeGroup,
  type CIType,
  type TypeAttribute,
} from '../../api/citype';
import {
  getDCIMTree,
  roomRacks,
  type DCIMNode,
  type RackCounters as WireRackCounters,
} from '../../api/dcim';
import { describeError } from '../../api/http';
import { getShowFields } from '../../api/preferences';
import {
  buildDCIMTree,
  EMPTY_DCIM_TREE,
  rackCounters,
  rackFieldColumns,
  toRackRow,
  type DCIMTreeState,
  type RackCounters,
  type RackRow,
} from '../../lib/dcim';

type ContextValue = {
  tree: DCIMTreeState;
  treeLoading: boolean;
  treeError: string | null;
  reloadTree(quiet?: boolean): Promise<void>;

  /** `null` means no room is selected; racks are only listed for a room. */
  selectedRoomID: string | null;
  selectedRoom: DCIMNode | null;
  selectRoom(id: string | null): void;

  /** The `dcim_rack` model and the vocabulary the rack views read. */
  rackType: CIType | null;
  rackAttributes: TypeAttribute[];
  rackGroups: AttributeGroup[];
  rackFields: TypeAttribute[];
  models: CIType[];

  racks: RackRow[];
  stats: RackCounters;
  racksLoading: boolean;
  racksError: string | null;
  reloadRacks(quiet?: boolean): Promise<void>;

  /** Changes after a write so dependent views (history, drawer) refetch. */
  tick: number;
  bump(): void;
  canMutate: boolean;
};

const DcimContext = createContext<ContextValue | null>(null);

export function DcimProvider({ children }: { children: ReactNode }) {
  const { tr } = useI18n();
  const { canMutate } = usePermissions();
  const [params, setParams] = useSearchParams();

  const [tree, setTree] = useState<DCIMTreeState>(EMPTY_DCIM_TREE);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [rackType, setRackType] = useState<CIType | null>(null);
  const [rackAttributes, setRackAttributes] = useState<TypeAttribute[]>([]);
  const [rackGroups, setRackGroups] = useState<AttributeGroup[]>([]);
  const [rackFields, setRackFields] = useState<TypeAttribute[]>([]);
  const [models, setModels] = useState<CIType[]>([]);

  const [racks, setRacks] = useState<RackRow[]>([]);
  const [wireCounters, setWireCounters] = useState<WireRackCounters | undefined>();
  const [racksLoading, setRacksLoading] = useState(false);
  const [racksError, setRacksError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // A slow request for room A must not overwrite room B's racks after the
  // operator has already selected B.
  const rackRequest = useRef(0);
  const racksRoom = useRef<string | null>(null);

  const selectedRoomID = params.get('node') || null;
  const selectedRoom = useMemo(
    () => (selectedRoomID ? tree.raw.get(selectedRoomID) ?? null : null),
    [selectedRoomID, tree.raw],
  );

  const selectRoom = useCallback(
    (id: string | null) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (id) next.set('node', id);
          else next.delete('node');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const reloadTree = useCallback(
    async (quiet = false) => {
      if (!quiet) setTreeLoading(true);
      setTreeError(null);
      try {
        setTree(buildDCIMTree(await getDCIMTree()));
      } catch (failure) {
        setTreeError(describeError(failure, tr('无法读取数据中心', 'Could not load the data centre')));
      } finally {
        setTreeLoading(false);
      }
    },
    [tr],
  );

  useEffect(() => {
    void reloadTree();
  }, [reloadTree]);

  // A deep link to a deleted or non-room node falls back to no selection once
  // the tree has loaded. Doing it earlier would rewrite links against an empty
  // tree.
  useEffect(() => {
    if (treeLoading || !selectedRoomID) return;
    const node = tree.raw.get(selectedRoomID);
    if (!node || node.ci_type !== 'dcim_server_room') selectRoom(null);
  }, [treeLoading, selectedRoomID, tree.raw, selectRoom]);

  // The model vocabulary is loaded once. A deployment without the rack model
  // gets the empty state rather than a request loop.
  useEffect(() => {
    let live = true;
    void Promise.all([
      getCIType('dcim_rack').catch(() => null),
      listCITypes().catch(() => [] as CIType[]),
    ]).then(async ([type, all]) => {
      if (!live) return;
      setModels(all);
      setRackType(type);
      if (!type) return;
      const [attrs, groups, show] = await Promise.all([
        listTypeAttributes(type.id).catch(() => null),
        listAttributeGroups(type.id, false).catch(() => [] as AttributeGroup[]),
        getShowFields(type.id).catch(() => null),
      ]);
      if (!live) return;
      const list = attrs?.attributes ?? [];
      setRackAttributes(list);
      setRackGroups(groups);
      setRackFields(
        rackFieldColumns(
          list,
          (show?.fields ?? []).map((field) => ({ attr_id: field.attr_id, name: field.name })),
          type.unique_key,
        ).filter((attribute) => attribute.name !== 'name' && attribute.name !== type.unique_key),
      );
    });
    return () => {
      live = false;
    };
  }, []);

  const reloadRacks = useCallback(
    async (quiet = false) => {
      if (!selectedRoomID) {
        rackRequest.current += 1;
        racksRoom.current = null;
        setRacks([]);
        setWireCounters(undefined);
        setRacksError(null);
        setRacksLoading(false);
        return;
      }
      const sequence = ++rackRequest.current;
      // Switching rooms replaces the rows; refreshing the same room keeps
      // them, so a failed refresh can still show what was already loaded.
      if (racksRoom.current !== selectedRoomID) {
        racksRoom.current = selectedRoomID;
        setRacks([]);
        setWireCounters(undefined);
      }
      if (!quiet) setRacksLoading(true);
      setRacksError(null);
      try {
        const got = await roomRacks(Number(selectedRoomID));
        if (sequence !== rackRequest.current) return;
        const nameKey = rackType?.show_name || rackType?.unique_key || 'name';
        setRacks((got.result ?? []).map((row) => toRackRow(row, nameKey)));
        setWireCounters(got.counter);
      } catch (failure) {
        if (sequence !== rackRequest.current) return;
        setRacksError(describeError(failure, tr('无法读取机柜', 'Could not load the racks')));
      } finally {
        if (sequence === rackRequest.current) setRacksLoading(false);
      }
    },
    [selectedRoomID, rackType?.show_name, rackType?.unique_key, tr],
  );

  useEffect(() => {
    void reloadRacks();
  }, [reloadRacks, tick]);

  const stats = useMemo(
    () => rackCounters(wireCounters as Record<string, unknown> | undefined, racks),
    [wireCounters, racks],
  );

  const value = useMemo<ContextValue>(
    () => ({
      tree,
      treeLoading,
      treeError,
      reloadTree,
      selectedRoomID,
      selectedRoom,
      selectRoom,
      rackType,
      rackAttributes,
      rackGroups,
      rackFields,
      models,
      racks,
      stats,
      racksLoading,
      racksError,
      reloadRacks,
      tick,
      bump: () => setTick((current) => current + 1),
      canMutate,
    }),
    [
      tree,
      treeLoading,
      treeError,
      reloadTree,
      selectedRoomID,
      selectedRoom,
      selectRoom,
      rackType,
      rackAttributes,
      rackGroups,
      rackFields,
      models,
      racks,
      stats,
      racksLoading,
      racksError,
      reloadRacks,
      tick,
      canMutate,
    ],
  );

  return <DcimContext.Provider value={value}>{children}</DcimContext.Provider>;
}

export function useDCIM(): ContextValue {
  const value = useContext(DcimContext);
  if (!value) throw new Error('useDCIM must be used inside DcimProvider');
  return value;
}
