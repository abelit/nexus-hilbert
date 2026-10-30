import { useCallback, useEffect, useState } from 'react';
import { EyeOff, Globe2, Loader2, MonitorPlay, PlugZap, Save } from 'lucide-react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  fetchFilePreviewConfig,
  saveFilePreviewConfig,
  testFilePreviewConfig,
  type FilePreviewConfig,
  type PreviewService,
} from '@/cmdb/api/files';
import { BUILTIN_PREVIEW_PATH } from '@/cmdb/lib/file-preview';

type Status = { tone: 'success' | 'error'; message: string } | null;

const splitTypes = (value: string): string[] =>
  value
    .split(/[\s,，]+/)
    .map((item) => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);

const EMPTY: FilePreviewConfig = {
  preview_service: 'off',
  preview_server_url: '',
  file_fetch_base_url: '',
  force_updated_cache_types: [],
};

const SERVICES = [
  {
    value: 'builtin' as const,
    icon: MonitorPlay,
    zh: '内置服务',
    en: 'Built-in',
    hintZh: '同源服务，无需地址',
    hintEn: 'Same-origin, no address',
  },
  {
    value: 'custom' as const,
    icon: Globe2,
    zh: '自定义服务',
    en: 'Custom',
    hintZh: '外部 kkFileView 地址',
    hintEn: 'External kkFileView address',
  },
  {
    value: 'off' as const,
    icon: EyeOff,
    zh: '关闭预览',
    en: 'Off',
    hintZh: '仅保留上传和下载',
    hintEn: 'Upload and download only',
  },
];

/**
 * A configuration saved before the service selector existed has only an
 * address. Treat a root-relative one as the bundled service, matching the
 * server's derivation, and keep an absolute one custom.
 */
function normalizeConfig(got: FilePreviewConfig): FilePreviewConfig {
  const known = got.preview_service === 'builtin' || got.preview_service === 'custom' || got.preview_service === 'off';
  const service: PreviewService = known
    ? got.preview_service
    : !got.preview_server_url.trim()
      ? 'off'
      : got.preview_server_url.startsWith('/')
        ? 'builtin'
        : 'custom';
  return {
    ...got,
    preview_service: service,
    preview_server_url:
      service === 'builtin' ? BUILTIN_PREVIEW_PATH : service === 'off' ? '' : got.preview_server_url,
  };
}

export default function SettingsFilePreview() {
  const { tr } = useI18n();
  const [config, setConfig] = useState<FilePreviewConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [typesText, setTypesText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const got = normalizeConfig(await fetchFilePreviewConfig());
      setConfig(got);
      setTypesText(got.force_updated_cache_types.join(', '));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectService = (service: PreviewService) => {
    setConfig((current) => {
      if (current.preview_service === service) return current;
      return {
        ...current,
        preview_service: service,
        // Leaving custom clears the address it owned; builtin gets its fixed
        // path so a later save cannot keep a stale external URL.
        preview_server_url: service === 'builtin' ? BUILTIN_PREVIEW_PATH : '',
      };
    });
    setStatus(null);
  };

  const save = async () => {
    setStatus(null);
    if (config.preview_service === 'custom' && !config.preview_server_url.trim()) {
      setStatus({ tone: 'error', message: tr('请填写自定义预览服务地址。', 'Enter the custom preview service URL.') });
      return;
    }
    setSaving(true);
    try {
      const saved = normalizeConfig(await saveFilePreviewConfig(config));
      setConfig(saved);
      setTypesText(saved.force_updated_cache_types.join(', '));
      setStatus({ tone: 'success', message: tr('文件预览设置已保存。', 'File preview settings saved.') });
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const result = await testFilePreviewConfig(config.preview_server_url);
      setStatus({
        tone: result.ok ? 'success' : 'error',
        message: result.ok ? tr('预览服务可访问。', 'Preview service is reachable.') : result.error || tr('连接失败。', 'Connection failed.'),
      });
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-zinc-500">
        <Loader2 size={14} className="mr-2 animate-spin" /> {tr('加载中…', 'Loading…')}
      </div>
    );
  }

  if (loadError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-400">
        <span className="min-w-0 flex-1 break-words">{loadError}</span>
        <Button variant="outline" type="button" onClick={() => void load()}>
          {tr('重试', 'Retry')}
        </Button>
      </div>
    );
  }

  const isOff = config.preview_service === 'off';

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-4 flex items-center gap-2">
          <MonitorPlay size={14} className="text-zinc-400" />
          <h2 className="text-sm font-medium text-zinc-100">{tr('文件预览', 'File preview')}</h2>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-zinc-500">
          {tr(
            '预览由内置 kkFileView 或外部兼容服务提供。CMDB 只保存服务设置，不代理文件内容；kkFileView 必须能访问 CMDB API 的签名预览地址。关闭预览后，文件仍可上传和下载。',
            'Preview is provided by the bundled kkFileView or an external compatible service. CMDB stores only the service settings and does not proxy content; kkFileView must be able to reach the CMDB signed preview URL. When preview is off, files can still be uploaded and downloaded.',
          )}
        </p>

        <div className="grid gap-2 sm:grid-cols-3">
          {SERVICES.map((option) => {
            const Icon = option.icon;
            const selected = config.preview_service === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => selectService(option.value)}
                aria-pressed={selected}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3.5 py-3 text-start transition-colors',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
                  selected ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-zinc-800 hover:border-indigo-500/30 hover:bg-zinc-900',
                )}
              >
                <span
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md',
                    selected ? 'bg-indigo-500/15 text-indigo-300' : 'bg-zinc-800 text-zinc-400',
                  )}
                >
                  <Icon size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-zinc-100">{tr(option.zh, option.en)}</span>
                  <span className="block text-[11px] text-zinc-500">{tr(option.hintZh, option.hintEn)}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 space-y-4">
          {config.preview_service === 'builtin' && (
            <div>
              <Label>{tr('预览地址', 'Preview address')}</Label>
              <div className="mt-1 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 font-mono text-xs text-zinc-300">
                {BUILTIN_PREVIEW_PATH}
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                {tr(
                  '由内置服务提供，固定使用同源 /file-preview/ 代理；无需填写地址。',
                  'Provided by the bundled service through the same-origin /file-preview/ proxy; no address is needed.',
                )}
              </p>
            </div>
          )}

          {config.preview_service === 'custom' && (
            <div>
              <Label htmlFor="cmdb-file-preview-url">{tr('预览服务地址', 'Preview server URL')}</Label>
              <Input
                id="cmdb-file-preview-url"
                value={config.preview_server_url}
                onChange={(event) => {
                  setConfig((current) => ({ ...current, preview_server_url: event.target.value }));
                  setStatus(null);
                }}
                className="mt-1 w-full font-mono"
                placeholder="http://127.0.0.1:8012/onlinePreview"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                {tr(
                  '填写 kkFileView 的 onlinePreview 地址，可填完整 URL 或同源路径。',
                  'The kkFileView onlinePreview endpoint; use an absolute URL or a same-origin path.',
                )}
              </p>
            </div>
          )}

          {isOff && (
            <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3.5 py-3 text-xs leading-relaxed text-zinc-500">
              {tr(
                '在线预览已关闭，预览入口会提示改用下载。重新开启时需要重新选择服务；关闭会清除已保存的预览地址。',
                'Online preview is off; the preview action falls back to download. Turning it back on requires choosing a service again; turning it off clears the saved preview address.',
              )}
            </p>
          )}

          {!isOff && (
            <div>
              <Label htmlFor="cmdb-file-fetch-base">{tr('文件访问地址', 'File access address')}</Label>
              <Input
                id="cmdb-file-fetch-base"
                value={config.file_fetch_base_url}
                onChange={(event) => {
                  setConfig((current) => ({ ...current, file_fetch_base_url: event.target.value }));
                  setStatus(null);
                }}
                className="mt-1 w-full font-mono"
                placeholder="http://ongrid-cmdb:8082"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                {tr(
                  'kkFileView 拉取附件时使用的 CMDB 地址，必须能从 kkFileView 进程访问。内置 docker compose 填 http://ongrid-cmdb:8082；留空使用浏览器当前域名。',
                  'CMDB address kkFileView uses to fetch attachments; it must be reachable from the kkFileView process. Use http://ongrid-cmdb:8082 for the bundled docker compose stack, or leave empty to use the browser origin.',
                )}
              </p>
            </div>
          )}

          {!isOff && (
            <div>
              <Label htmlFor="cmdb-file-preview-types">{tr('强制刷新缓存的扩展名', 'Force-refresh extensions')}</Label>
              <Input
                id="cmdb-file-preview-types"
                value={typesText}
                onChange={(event) => {
                  setTypesText(event.target.value);
                  setConfig((current) => ({ ...current, force_updated_cache_types: splitTypes(event.target.value) }));
                  setStatus(null);
                }}
                className="mt-1 w-full font-mono"
                placeholder="txt, md, log"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                {tr('这些类型每次预览都会要求 kkFileView 重新转换，适合经常变化的文本文件。', 'These types are reconverted on every preview; useful for frequently changing text files.')}
              </p>
            </div>
          )}
        </div>
      </section>

      {status && (
        <div
          role={status.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'rounded-lg border px-3 py-2 text-xs',
            status.tone === 'error'
              ? 'border-red-500/40 bg-red-500/5 text-red-400'
              : 'border-emerald-500/40 bg-emerald-500/5 text-emerald-400',
          )}
        >
          {status.message}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {!isOff && (
          <Button variant="outline" type="button" onClick={() => void test()} disabled={saving || testing}>
            {testing ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <PlugZap size={13} className="mr-1.5" />}
            {testing ? tr('测试中…', 'Testing…') : tr('测试连接', 'Test connection')}
          </Button>
        )}
        <Button variant="primary" type="button" onClick={() => void save()} disabled={saving || testing}>
          {saving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Save size={13} className="mr-1.5" />}
          {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
        </Button>
      </div>
    </div>
  );
}
