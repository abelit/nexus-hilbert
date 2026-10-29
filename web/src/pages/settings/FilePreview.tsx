import { useCallback, useEffect, useState } from 'react';
import { Loader2, MonitorPlay, PlugZap, Save } from 'lucide-react';

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
} from '@/cmdb/api/files';

type Status = { tone: 'success' | 'error'; message: string } | null;

const splitTypes = (value: string): string[] =>
  value
    .split(/[\s,，]+/)
    .map((item) => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);

const EMPTY: FilePreviewConfig = {
  preview_server_url: '',
  force_updated_cache_types: [],
};

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
      const got = await fetchFilePreviewConfig();
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

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const saved = await saveFilePreviewConfig(config);
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

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-4 flex items-center gap-2">
          <MonitorPlay size={14} className="text-zinc-400" />
          <h2 className="text-sm font-medium text-zinc-100">{tr('文件预览', 'File preview')}</h2>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-zinc-500">
          {tr(
            '预览由 kkFileView 提供。CMDB 只保存服务地址，不代理文件内容；kkFileView 必须能访问 CMDB API 的签名预览地址。若未配置，文件仍可下载。',
            'Preview is provided by kkFileView. CMDB stores only the service address and does not proxy content; kkFileView must be able to reach the CMDB signed preview URL. Without it, files remain downloadable.',
          )}
        </p>

        <div className="space-y-4">
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
              {tr('可填完整 URL，或同源路径 /file-preview/onlinePreview（内置服务）。', 'Use an absolute URL, or the same-origin /file-preview/onlinePreview path for the bundled service.')}
            </p>
          </div>

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
        <Button variant="outline" type="button" onClick={() => void test()} disabled={saving || testing}>
          {testing ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <PlugZap size={13} className="mr-1.5" />}
          {testing ? tr('测试中…', 'Testing…') : tr('测试连接', 'Test connection')}
        </Button>
        <Button variant="primary" type="button" onClick={() => void save()} disabled={saving || testing}>
          {saving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Save size={13} className="mr-1.5" />}
          {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
        </Button>
      </div>
    </div>
  );
}
