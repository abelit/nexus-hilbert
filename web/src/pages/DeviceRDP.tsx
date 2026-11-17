// DeviceRDP — full-page Windows remote desktop using IronRDP's WebAssembly
// client and the Manager's RDCleanPath proxy.
//
// Flow:
//   1. Mount → load the WASM backend and append the <iron-remote-desktop>
//      element; its `ready` event exposes a UserInteraction.
//   2. User submits username/password/domain → mint a one-time RDP ticket and
//      build the IronRDP config (destination, proxy WS address, auth token).
//   3. The WASM client speaks RDCleanPath to the Manager, then CredSSP/NLA to
//      the Windows host. Passwords never reach the Manager.
//
// Security: only the 30-second ticket appears in the WebSocket URL; the same
// ticket is sent as RDCleanPath proxy_auth and verified server-side.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ClipboardPaste,
  ClipboardCopy,
  Files,
  FolderOpen,
  Keyboard,
  Maximize,
  Minimize,
  Monitor,
  Power,
  RotateCw,
  Scaling,
  Shield,
} from 'lucide-react';
import '@devolutions/iron-remote-desktop';
import { Backend, displayControl, init } from '@devolutions/iron-remote-desktop-rdp';
import type { UserInteraction } from '@devolutions/iron-remote-desktop';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { Input, Label } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { Hint } from '@/components/ui/Tooltip';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/DropdownMenu';
import { useAssistantPage } from '@/lib/assistantPage';
import { usePermissions } from '@/store/me';
import { useI18n } from '@/i18n/locale';
import { getEdge, listEdges, type Edge } from '@/api/edges';
import { createRDPTicket, rdpProxyURL } from '@/api/rdp';
import {
  downloadDeviceFile,
  listDeviceFiles,
  uploadDeviceFile,
  type DeviceFile,
} from '@/api/files';

type ConnState = 'idle' | 'connecting' | 'open' | 'closed';

type Credentials = {
  username: string;
  password: string;
  domain: string;
};

type IronRemoteDesktopElement = HTMLElement & {
  module?: unknown;
  flexcenter?: boolean;
  scale?: 'fit' | 'real' | 'full';
  shutdown?: () => void;
};

function stageSize(el: HTMLElement | null) {
  const width = Math.max(800, Math.floor(el?.clientWidth ?? window.innerWidth));
  const height = Math.max(600, Math.floor(el?.clientHeight ?? window.innerHeight - 48));
  return { width, height };
}

export default function DeviceRDPPage() {
  const { tr } = useI18n();
  const { canMutate } = usePermissions();
  useAssistantPage('设备 RDP', 'Device RDP', canMutate ? undefined : { access: 'read_only' });

  if (!canMutate) {
    return (
      <main className="anim-fade flex flex-1 flex-col overflow-hidden p-6">
        <PageHeader
          title={tr('远程桌面 (RDP)', 'Remote desktop (RDP)')}
          subtitle={tr('RDP — admin / user only', 'RDP — admin / user only')}
        />
        <Card className="p-6">
          <EmptyState
            icon={Shield}
            title={tr('只读账号不能进入远程桌面', 'Viewer accounts cannot open the remote desktop')}
            hint={tr(
              'RDP 需要输入设备账号并建立交互会话，只有 admin / user 能打开。',
              'RDP requires device credentials and an interactive session. Only admin and user roles can open it.',
            )}
          />
        </Card>
      </main>
    );
  }

  return <RDPWorkspace />;
}

export function RDPWorkspace() {
  const { tr } = useI18n();
  const { deviceId = '' } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();

  const [edge, setEdge] = useState<Edge | null>(null);
  const [ui, setUi] = useState<UserInteraction | null>(null);
  const [conn, setConn] = useState<ConnState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [credsOpen, setCredsOpen] = useState(true);
  const [creds, setCreds] = useState<Credentials>({ username: '', password: '', domain: '' });
  const [filesOpen, setFilesOpen] = useState(false);
  const [remoteFiles, setRemoteFiles] = useState<DeviceFile[]>([]);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [scaleMode, setScaleMode] = useState<'fit' | 'real'>('fit');

  const workspaceRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<IronRemoteDesktopElement | null>(null);
  const uiRef = useRef<UserInteraction | null>(null);
  const sessionRunRef = useRef(0);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === workspaceRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // Keep the remote desktop resolution in sync with the stage. Display
  // control gives a true edge-to-edge canvas instead of a centered fixed-size
  // desktop with black bars.
  useEffect(() => {
    if (conn !== 'open') return;
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const size = stageSize(el);
        try {
          uiRef.current?.resize(size.width, size.height);
        } catch {
          /* display control unsupported by the backend */
        }
      }, 250);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [conn]);

  // Resolve the host name for the title and for the RDP destination/SNI.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await listEdges();
        if (cancelled) return;
        const target = (r.items ?? []).find((e) => String(e.device_id ?? '') === String(deviceId));
        if (!target) return;
        try {
          const detail = await getEdge(target.id);
          if (!cancelled) setEdge(detail);
        } catch {
          if (!cancelled) setEdge(target);
        }
      } catch {
        /* the session surfaces connectivity errors */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const saveBlob = useCallback((blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  // Load the backend and mount the web component. The element is created
  // imperatively so `module` and the ready listener are installed before the
  // element is attached (the component fires `ready` during setup).
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        await init('ERROR');
        if (disposed || !hostRef.current) return;

        const el = document.createElement('iron-remote-desktop') as IronRemoteDesktopElement;
        el.setAttribute('scale', 'fit');
        el.setAttribute('flexcenter', 'true');
        el.flexcenter = true;
        // Custom elements are inline by default; give the renderer a box.
        el.style.display = 'block';
        el.style.width = '100%';
        el.style.height = '100%';
        el.module = Backend;
        el.addEventListener('ready', (ev: Event) => {
          const interaction = (ev as CustomEvent<{ irgUserInteraction: UserInteraction }>).detail
            ?.irgUserInteraction;
          if (!interaction) return;
          uiRef.current = interaction;
          setUi(interaction);
        });
        hostRef.current.appendChild(el);
        elementRef.current = el;
      } catch (cause) {
        if (!disposed) setError((cause as Error).message || tr('无法加载 RDP 客户端', 'Failed to load the RDP client'));
      }
    })();
    return () => {
      disposed = true;
      try {
        uiRef.current?.shutdown();
      } catch {
        /* session may already be gone */
      }
      elementRef.current?.remove();
      elementRef.current = null;
      uiRef.current = null;
    };
  }, [tr]);

  const connect = useCallback(
    async (input: Credentials) => {
      const interaction = uiRef.current;
      if (!interaction) {
        setError(tr('RDP 客户端尚未就绪，请稍后重试', 'The RDP client is not ready yet; retry in a moment'));
        return;
      }
      setError(null);
      setTransfer(null);
      setConn('connecting');
      setCreds(input);

      try {
        const { ticket } = await createRDPTicket(deviceId);
        const proxyAddress = rdpProxyURL(deviceId, ticket);
        const destination = edge?.name || 'localhost';
        const desktopSize = stageSize(stageRef.current);

        const builder = interaction
          .configBuilder()
          .withUsername(input.username)
          .withPassword(input.password)
          .withDestination(destination)
          .withProxyAddress(proxyAddress)
          .withAuthToken(ticket)
          .withExtension(displayControl(true))
          .withDesktopSize(desktopSize);
        if (input.domain) builder.withServerDomain(input.domain);

        interaction.setEnableClipboard(true);
        interaction.setEnableAutoClipboard(false);
        interaction.onWarningCallback((message) => setError(message));
        // Register the hook so the backend has somewhere to deliver remote
        // clipboard updates; the user pulls them with the toolbar button.
        interaction.onClipboardRemoteUpdateCallback(() => undefined);

        const session = await interaction.connect(builder.build());
        // Ask the server to match the stage so the canvas fills the workspace
        // instead of letterboxing a fixed desktop size.
        try {
          interaction.resize(desktopSize.width, desktopSize.height);
        } catch {
          /* display control is optional */
        }
        interaction.setVisibility(true);
        setCredsOpen(false);
        setConn('open');

        const run = ++sessionRunRef.current;
        void session
          .run()
          .then(() => {
            if (sessionRunRef.current === run) setConn('closed');
          })
          .catch((cause: unknown) => {
            if (sessionRunRef.current !== run) return;
            setConn('closed');
            setError((cause as Error)?.message || tr('RDP 会话已断开', 'The RDP session ended'));
          });
      } catch (cause) {
        setConn('closed');
        setError((cause as Error)?.message || tr('无法建立 RDP 会话', 'Unable to establish the RDP session'));
      }
    },
    [deviceId, edge?.name, tr],
  );

  const reconnect = useCallback(() => {
    sessionRunRef.current += 1;
    try {
      uiRef.current?.shutdown();
    } catch {
      /* no active session */
    }
    setConn('idle');
    setRemoteFiles([]);
    setCredsOpen(true);
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      const result = await listDeviceFiles(deviceId);
      setRemoteFiles(result.items ?? []);
    } catch (cause) {
      setError((cause as Error)?.message || tr('无法读取设备文件', 'Unable to list device files'));
    }
  }, [deviceId, tr]);

  const uploadFiles = useCallback(
    async (list: File[]) => {
      if (list.length === 0) return;
      try {
        for (const [index, file] of list.entries()) {
          await uploadDeviceFile(deviceId, file, (loaded, total) => {
            const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
            setTransfer(
              tr(
                `上传 ${file.name}（${index + 1}/${list.length}）${pct}%`,
                `Uploading ${file.name} (${index + 1}/${list.length}) ${pct}%`,
              ),
            );
          });
        }
        setTransfer(tr('上传完成', 'Upload complete'));
        await refreshFiles();
      } catch (cause) {
        setError((cause as Error)?.message || tr('上传失败', 'Upload failed'));
      }
    },
    [deviceId, refreshFiles, tr],
  );

  const onDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (conn !== 'open') return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) await uploadFiles(files);
    },
    [conn, uploadFiles],
  );

  const download = useCallback(
    async (file: DeviceFile) => {
      try {
        setTransfer(tr(`下载 ${file.name}…`, `Downloading ${file.name}…`));
        const blob = await downloadDeviceFile(deviceId, file.name);
        saveBlob(blob, file.name);
        setTransfer(tr('下载完成', 'Download complete'));
      } catch (cause) {
        setError((cause as Error)?.message || tr('下载失败', 'Download failed'));
      }
    },
    [deviceId, saveBlob, tr],
  );

  const pasteRemoteClipboard = useCallback(async () => {
    try {
      await uiRef.current?.saveRemoteClipboardData();
    } catch {
      setError(tr(
        '无法读取远端剪贴板，请确认浏览器允许剪贴板权限。',
        'Unable to read the remote clipboard. Check the browser clipboard permission.',
      ));
    }
  }, [tr]);

  const sendLocalClipboard = useCallback(async () => {
    try {
      await uiRef.current?.sendClipboardData();
    } catch {
      setError(tr(
        '无法读取本机剪贴板（需要剪贴板权限或 HTTPS）。',
        'Unable to read the local clipboard (needs clipboard permission or HTTPS).',
      ));
    }
  }, [tr]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === workspaceRef.current) await document.exitFullscreen();
      else await workspaceRef.current?.requestFullscreen();
    } catch {
      setError(tr('无法切换全屏，请重试', 'Unable to toggle fullscreen. Please retry.'));
    }
  }, [tr]);

  const changeScale = useCallback((mode: 'fit' | 'real') => {
    setScaleMode(mode);
    elementRef.current?.setAttribute('scale', mode);
  }, []);

  const closePage = useCallback(() => {
    sessionRunRef.current += 1;
    try {
      uiRef.current?.shutdown();
    } catch {
      /* already closed */
    }
    window.close();
    if (!window.closed) navigate('/devices', { replace: true });
  }, [navigate]);

  const hostname = edge?.name || deviceId || tr('设备', 'device');

  const statusLabel = useMemo(() => {
    switch (conn) {
      case 'idle':
        return tr('未连接', 'Disconnected');
      case 'connecting':
        return tr('连接中…', 'Connecting…');
      case 'open':
        return tr('已连接', 'Connected');
      case 'closed':
        return tr('已断开', 'Closed');
    }
  }, [conn, tr]);

  useEffect(() => {
    const prev = document.title;
    document.title = `RDP · ${hostname}`;
    return () => {
      document.title = prev;
    };
  }, [hostname]);

  useAssistantPage('设备 RDP', 'Device RDP', {
    device_id: deviceId,
    connection: conn,
  });

  return (
    <main
      ref={workspaceRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-zinc-950"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-zinc-900/70 px-2 sm:px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={
              conn === 'open'
                ? 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300'
                : conn === 'connecting'
                  ? 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300'
                  : 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-zinc-400'
            }
          >
            <span
              className={
                conn === 'open'
                  ? 'h-1.5 w-1.5 rounded-full bg-emerald-400'
                  : conn === 'connecting'
                    ? 'h-1.5 w-1.5 rounded-full bg-amber-300'
                    : 'h-1.5 w-1.5 rounded-full bg-zinc-500'
              }
            />
            {statusLabel}
          </span>
          <Monitor size={14} className="shrink-0 text-zinc-500" />
          <span className="truncate text-xs font-medium text-zinc-100">{hostname}</span>
          {transfer && (
            <span className="hidden min-w-0 truncate text-[11px] text-zinc-400 sm:inline">
              · {transfer}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="plain"
            size="sm"
            disabled={conn !== 'open'}
            onClick={() => {
              setFilesOpen(true);
              void refreshFiles();
            }}
            aria-label={tr('文件传输', 'File transfer')}
            className="h-7 gap-1.5 rounded-md px-2 text-xs text-zinc-300 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Files size={14} />
            <span className="hidden sm:inline">{tr('文件', 'Files')}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={conn !== 'open'}
              aria-label={tr('剪贴板', 'Clipboard')}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-300 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ClipboardCopy size={14} />
              <span className="hidden sm:inline">{tr('剪贴板', 'Clipboard')}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={() => void pasteRemoteClipboard()}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800"
              >
                <ClipboardCopy size={13} /> {tr('取回远端剪贴板', 'Fetch remote clipboard')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void sendLocalClipboard()}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800"
              >
                <ClipboardPaste size={13} /> {tr('发送本机剪贴板', 'Send local clipboard')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Hint content={tr('发送 Ctrl+Alt+Del', 'Send Ctrl+Alt+Del')}>
            <Button
              variant="plain"
              size="sm"
              disabled={conn !== 'open'}
              onClick={() => uiRef.current?.ctrlAltDel()}
              aria-label={tr('发送 Ctrl+Alt+Del', 'Send Ctrl+Alt+Del')}
              className="h-7 w-7 rounded-md p-0 text-zinc-300 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Keyboard size={14} />
            </Button>
          </Hint>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={tr('显示比例', 'Display scale')}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
            >
              <Scaling size={14} />
              <span className="hidden md:inline">
                {scaleMode === 'fit' ? tr('适应窗口', 'Fit') : tr('原始大小', '1:1')}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onClick={() => changeScale('fit')}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800"
              >
                <Scaling size={13} /> {tr('适应窗口', 'Fit window')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => changeScale('real')}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800"
              >
                <Scaling size={13} /> {tr('原始大小', 'Original size')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Hint content={fullscreen ? tr('退出全屏', 'Exit fullscreen') : tr('全屏', 'Fullscreen')}>
            <Button
              variant="plain"
              size="sm"
              onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? tr('退出全屏', 'Exit fullscreen') : tr('全屏', 'Fullscreen')}
              className="h-7 w-7 rounded-md p-0 text-zinc-300 hover:bg-white/10 hover:text-white"
            >
              {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </Button>
          </Hint>
          <Hint content={tr('重新连接', 'Reconnect')}>
            <Button
              variant="plain"
              size="sm"
              onClick={reconnect}
              aria-label={tr('重新连接', 'Reconnect')}
              className="h-7 w-7 rounded-md p-0 text-zinc-300 hover:bg-white/10 hover:text-white"
            >
              <RotateCw size={14} />
            </Button>
          </Hint>
          <Hint content={tr('关闭远程桌面', 'Close remote desktop')}>
            <Button
              variant="plain"
              size="sm"
              onClick={closePage}
              aria-label={tr('关闭远程桌面', 'Close remote desktop')}
              className="h-7 w-7 rounded-md p-0 text-zinc-300 hover:bg-red-500/15 hover:text-red-300"
            >
              <Power size={14} />
            </Button>
          </Hint>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-200"
        >
          {error}
        </div>
      )}

      <div
        ref={stageRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[#09090b]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => void onDrop(e)}
      >
        <div ref={hostRef} className="absolute inset-0 flex items-center justify-center" data-testid="rdp-canvas" />
        {conn !== 'open' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto max-w-md rounded-xl border border-white/10 bg-zinc-900/95 p-5 text-center shadow-2xl">
              <p className="text-sm text-zinc-100">
                {conn === 'connecting'
                  ? tr('正在连接远程桌面…', 'Connecting to the remote desktop…')
                  : ui
                    ? tr('远程桌面未连接', 'Remote desktop disconnected')
                    : tr('正在加载 RDP 客户端…', 'Loading the RDP client…')}
              </p>
              <p className="mt-2 text-xs text-zinc-400">
                {tr(
                  '目标机需启用远程桌面（3389），账号需在 Remote Desktop Users 组。',
                  'Enable Remote Desktop (3389) on the host; the account must be in Remote Desktop Users.',
                )}
              </p>
              {conn === 'closed' && (
                <Button className="mt-4" size="sm" onClick={reconnect}>
                  <RotateCw size={12} />
                  {tr('重新连接', 'Reconnect')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <CredentialsModal
        open={credsOpen}
        uiReady={!!ui}
        initial={creds}
        onCancel={() => {
          if (conn === 'open') setCredsOpen(false);
          else navigate('/devices');
        }}
        onSubmit={(input) => void connect(input)}
      />

      <Modal
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
        title={tr('文件传输', 'File transfer')}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-zinc-500">
            {tr(
              '文件通过 Edge 文件通道写入设备沙箱目录。Windows：C:/ProgramData/ongrid-edge/transfer；Linux：/var/lib/ongrid-edge/transfer。单个文件上限 2 GB。',
              'Files are written to the edge sandbox over the device file channel. Windows: C:/ProgramData/ongrid-edge/transfer; Linux: /var/lib/ongrid-edge/transfer. Limit: 2 GB per file.',
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-8 cursor-pointer items-center rounded-md border border-border px-3 text-xs text-zinc-200 hover:bg-zinc-800">
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  void uploadFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {tr('上传本地文件', 'Upload local files')}
            </label>
            <Button size="sm" variant="subtle" onClick={() => void refreshFiles()}>
              {tr('刷新列表', 'Refresh')}
            </Button>
            <a
              href={`/devices/${encodeURIComponent(deviceId)}/files`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              <FolderOpen size={13} />
              {tr('打开文件管理器', 'Open file manager')}
            </a>
          </div>
          {remoteFiles.length === 0 ? (
            <p className="text-xs text-zinc-500">
              {tr('设备沙箱中还没有文件', 'No files in the device sandbox yet')}
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
              {remoteFiles.map((file) => (
                <li
                  key={file.name}
                  className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0"
                >
                  <span className="min-w-0 truncate text-zinc-200" title={file.name}>
                    {file.name}
                  </span>
                  <span className="shrink-0 text-zinc-500">{formatBytes(file.size)}</span>
                  <Button size="sm" variant="subtle" onClick={() => void download(file)}>
                    {tr('下载', 'Download')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-zinc-600">
            {tr('也可以直接把文件拖到桌面区域上传。', 'You can also drop files onto the desktop area to upload.')}
          </p>
        </div>
      </Modal>
    </main>
  );
}

function CredentialsModal({
  open,
  uiReady,
  initial,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  uiReady: boolean;
  initial: Credentials;
  onSubmit(input: Credentials): void;
  onCancel(): void;
}) {
  const { tr } = useI18n();
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState(initial.domain);
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    if (!username.trim()) {
      setErr(tr('请输入 Windows 用户名', 'Enter the Windows username'));
      return;
    }
    if (!password) {
      setErr(tr('请输入密码', 'Enter the password'));
      return;
    }
    onSubmit({ username: username.trim(), password, domain: domain.trim() });
    setPassword('');
  };

  return (
    <Modal open={open} onClose={onCancel} title={tr('远程桌面登录', 'Remote desktop sign-in')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-zinc-500">
          {tr(
            '密码通过 CredSSP/NLA 直接发送给设备，不会保存在 OnGrid。',
            'The password goes to the device through CredSSP/NLA and is never stored by OnGrid.',
          )}
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rdp-username">{tr('用户名', 'Username')}</Label>
          <Input
            id="rdp-username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={tr('Administrator', 'Administrator')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rdp-password">{tr('密码', 'Password')}</Label>
          <Input
            id="rdp-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rdp-domain">{tr('域（可选）', 'Domain (optional)')}</Label>
          <Input
            id="rdp-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={tr('WORKGROUP 或 AD 域名', 'WORKGROUP or AD domain')}
          />
        </div>
        {err && <p role="alert" className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="subtle" onClick={onCancel}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button onClick={submit} disabled={!uiReady}>
            {tr('连接', 'Connect')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
