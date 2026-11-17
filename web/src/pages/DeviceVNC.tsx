// DeviceVNC — full-page noVNC viewer for Windows devices.
//
// Flow:
//   1. Page mounts → mint a one-time VNC ticket (REST) and open the
//      WebSocket bridge in the same request cycle.
//   2. noVNC's RFB consumes the raw RFB stream; the Manager has already
//      forwarded it over the edge tunnel to 127.0.0.1:5900.
//   3. If the VNC server asks for a password the browser shows the RFB
//      credential prompt; the password goes straight to the server and
//      never reaches OnGrid.
//
// Security:
//   - Only the 30-second capability ticket appears in the WebSocket URL.
//   - The password lives in component state and the RFB credential frame.
//   - Viewer accounts are blocked at the page boundary (device:shell).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ClipboardPaste,
  Keyboard,
  Maximize,
  Minimize,
  Monitor,
  Power,
  RotateCw,
  Shield,
} from 'lucide-react';
import RFB from '@novnc/novnc/core/rfb.js';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useAssistantPage } from '@/lib/assistantPage';
import { usePermissions } from '@/store/me';
import { useI18n } from '@/i18n/locale';
import { getEdge, listEdges, type Edge } from '@/api/edges';
import { createVNCTicket, openVNCSocket } from '@/api/vnc';

type ConnState = 'connecting' | 'open' | 'closed';

export default function DeviceVNCPage() {
  const { tr } = useI18n();
  const { canMutate } = usePermissions();
  useAssistantPage('设备 VNC', 'Device VNC', canMutate ? undefined : { access: 'read_only' });

  if (!canMutate) {
    return (
      <main className="anim-fade flex flex-1 flex-col overflow-hidden p-6">
        <PageHeader
          title={tr('远程桌面', 'Remote desktop')}
          subtitle={tr('VNC — admin / user only', 'VNC — admin / user only')}
        />
        <Card className="p-6">
          <EmptyState
            icon={Shield}
            title={tr('只读账号不能进入远程桌面', 'Viewer accounts cannot open the remote desktop')}
            hint={tr(
              'VNC 会给你设备的桌面控制权，只有 admin / user 能打开。',
              'VNC grants keyboard and mouse control of the host. Only admin and user roles can open it.',
            )}
          />
        </Card>
      </main>
    );
  }

  return <VNCWorkspace />;
}

export function VNCWorkspace() {
  const { tr } = useI18n();
  const { deviceId = '' } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();

  const [edge, setEdge] = useState<Edge | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [desktopName, setDesktopName] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  const workspaceRef = useRef<HTMLElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Generation counter: increments on every (re)connect and on unmount so
  // late async results from a torn-down session are ignored.
  const genRef = useRef(0);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === workspaceRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    setFullscreenError(null);
    try {
      if (document.fullscreenElement === workspaceRef.current) await document.exitFullscreen();
      else await workspaceRef.current?.requestFullscreen();
    } catch {
      setFullscreenError(tr('无法切换全屏，请重试', 'Unable to toggle fullscreen. Please retry.'));
    }
  }, [tr]);

  // Resolve the host name for the title. The route param is the Prom-label
  // device_id, so scan the edge list like DeviceShell does.
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
        /* the session itself surfaces connectivity errors */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const teardown = useCallback(() => {
    const rfb = rfbRef.current;
    rfbRef.current = null;
    if (rfb) {
      try {
        rfb.disconnect();
      } catch {
        /* already gone */
      }
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close(1000, 'client');
      } catch {
        /* already closed */
      }
    }
    if (canvasHostRef.current) canvasHostRef.current.innerHTML = '';
  }, []);

  const connect = useCallback(
    async (initialPassword?: string) => {
      const gen = ++genRef.current;
      teardown();
      setError(null);
      setAuthRequired(false);
      setDesktopName('');
      setConn('connecting');

      const host = canvasHostRef.current;
      if (!host) return;

      let ticket: string;
      try {
        const res = await createVNCTicket(deviceId);
        ticket = res.ticket;
      } catch (cause) {
        if (genRef.current !== gen) return;
        setConn('closed');
        setError((cause as Error).message || tr('无法创建 VNC 会话', 'Unable to create a VNC session'));
        return;
      }
      if (genRef.current !== gen) return;

      const ws = openVNCSocket(deviceId, ticket);
      wsRef.current = ws;
      ws.addEventListener('error', () => {
        if (genRef.current !== gen) return;
        setError(tr('VNC 连接失败，请检查设备是否在线、VNC 服务是否启动。', 'VNC connection failed. Check that the device is online and the VNC server is running.'));
      });

      const rfb = new RFB(host, ws, {
        shared: true,
        credentials: initialPassword ? { password: initialPassword } : {},
      });
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = '#09090b';

      rfb.addEventListener('connect', () => {
        if (genRef.current !== gen) return;
        setConn('open');
        setAuthRequired(false);
        setPassword('');
      });
      rfb.addEventListener('disconnect', (ev) => {
        if (genRef.current !== gen) return;
        setConn('closed');
        setAuthRequired(false);
        if (!ev.detail?.clean) {
          setError(tr('VNC 会话已断开。', 'The VNC session was disconnected.'));
        }
      });
      rfb.addEventListener('credentialsrequired', () => {
        if (genRef.current !== gen) return;
        setAuthRequired(true);
      });
      rfb.addEventListener('securityfailure', (ev) => {
        if (genRef.current !== gen) return;
        setConn('closed');
        setAuthRequired(false);
        setError(ev.detail?.reason || tr('VNC 安全校验失败', 'VNC security check failed'));
      });
      rfb.addEventListener('desktopname', (ev) => {
        if (genRef.current !== gen) return;
        setDesktopName(ev.detail?.name ?? '');
      });
      rfb.addEventListener('clipboard', (ev) => {
        const text = ev.detail?.text;
        if (!text) return;
        // Best-effort local clipboard sync; insecure contexts and missing
        // permissions reject, which is fine — the user can still paste
        // into the remote desktop manually.
        void navigator.clipboard?.writeText(text).catch(() => undefined);
      });
    },
    [deviceId, teardown, tr],
  );

  useEffect(() => {
    void connect();
    return () => {
      genRef.current += 1;
      teardown();
    };
  }, [connect, teardown]);

  const submitPassword = () => {
    const rfb = rfbRef.current;
    if (!rfb || !password) return;
    rfb.sendCredentials({ password });
    setAuthRequired(false);
    setPassword('');
  };

  const pasteToRemote = async () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    try {
      const text = await navigator.clipboard.readText();
      rfb.clipboardPasteFrom(text);
    } catch {
      setError(tr(
        '无法读取本机剪贴板（需要剪贴板权限或 HTTPS）。',
        'Unable to read the local clipboard (needs clipboard permission or HTTPS).',
      ));
    }
  };

  const closePage = useCallback(() => {
    genRef.current += 1;
    teardown();
    window.close();
    if (!window.closed) navigate('/devices', { replace: true });
  }, [navigate, teardown]);

  const hostname = edge?.name || desktopName || deviceId || tr('设备', 'device');

  const statusLabel = useMemo(() => {
    switch (conn) {
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
    document.title = `VNC · ${hostname}`;
    return () => {
      document.title = prev;
    };
  }, [hostname]);

  useAssistantPage('设备 VNC', 'Device VNC', {
    device_id: deviceId,
    connection: conn,
  });

  return (
    <main
      ref={workspaceRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden bg-bg p-3 sm:p-6"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-300">
          <Monitor size={14} className="text-zinc-500" />
          <span className="truncate font-medium text-zinc-100">{hostname}</span>
          <span className="text-zinc-600">·</span>
          <span
            className={
              conn === 'open' ? 'text-emerald-400' : conn === 'connecting' ? 'text-amber-300' : 'text-zinc-500'
            }
          >
            {statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            disabled={conn !== 'open'}
            onClick={() => rfbRef.current?.sendCtrlAltDel()}
            aria-label={tr('发送 Ctrl+Alt+Del', 'Send Ctrl+Alt+Del')}
          >
            <Keyboard size={12} />
            {tr('Ctrl+Alt+Del', 'Ctrl+Alt+Del')}
          </Button>
          <Button
            variant="ghost"
            disabled={conn !== 'open'}
            onClick={() => void pasteToRemote()}
            aria-label={tr('粘贴本机剪贴板到远端', 'Paste local clipboard to the remote desktop')}
          >
            <ClipboardPaste size={12} />
            {tr('粘贴', 'Paste')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void connect()}
            aria-label={tr('重新连接', 'Reconnect')}
          >
            <RotateCw size={12} />
            {tr('重连', 'Reconnect')}
          </Button>
          <Button
            variant="ghost"
            disabled={conn !== 'open' && !fullscreen}
            onClick={() => void toggleFullscreen()}
            aria-label={fullscreen ? tr('退出全屏', 'Exit fullscreen') : tr('全屏', 'Fullscreen')}
          >
            {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            {fullscreen ? tr('退出全屏', 'Exit fullscreen') : tr('全屏', 'Fullscreen')}
          </Button>
          <Button variant="ghost" onClick={closePage} aria-label={tr('关闭远程桌面', 'Close remote desktop')}>
            <Power size={12} />
            {tr('关闭', 'Close')}
          </Button>
        </div>
      </header>

      {fullscreenError && (
        <p role="alert" className="shrink-0 text-xs text-red-500">
          {fullscreenError}
        </p>
      )}

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-zinc-950">
        <div ref={canvasHostRef} className="h-full w-full" data-testid="vnc-canvas" />
        {conn !== 'open' && !authRequired && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto max-w-md rounded-lg border border-border bg-bg/95 p-5 text-center shadow-lg">
              <p className="text-sm text-zinc-200">
                {conn === 'connecting'
                  ? tr('正在连接远程桌面…', 'Connecting to the remote desktop…')
                  : tr('远程桌面未连接', 'Remote desktop disconnected')}
              </p>
              {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
              <p className="mt-2 text-xs text-zinc-500">
                {tr(
                  '请确认设备上的 VNC 服务已启动并监听 5900 端口。',
                  'Make sure the VNC server on the device is running and listening on port 5900.',
                )}
              </p>
              {conn === 'closed' && (
                <Button className="mt-4" size="sm" onClick={() => void connect()}>
                  <RotateCw size={12} />
                  {tr('重新连接', 'Reconnect')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <Modal
        open={authRequired}
        onClose={() => {
          setAuthRequired(false);
          rfbRef.current?.disconnect();
        }}
        title={tr('远程桌面密码', 'Remote desktop password')}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-zinc-500">
            {tr(
              '远程 VNC 服务要求密码。密码只发送给设备，不会保存在 OnGrid。',
              'The remote VNC server requires a password. It is sent only to the device and is never stored by OnGrid.',
            )}
          </p>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPassword();
            }}
            aria-label={tr('VNC 密码', 'VNC password')}
            className="h-9 w-full rounded-md border border-border bg-bg px-3 text-sm text-zinc-100 outline-none focus:border-brand"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="subtle"
              onClick={() => {
                setAuthRequired(false);
                rfbRef.current?.disconnect();
              }}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button onClick={submitPassword} disabled={!password}>
              {tr('连接', 'Connect')}
            </Button>
          </div>
        </div>
      </Modal>
    </main>
  );
}
