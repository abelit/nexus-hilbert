import { useCallback, useEffect, useState } from 'react';
import { Cloud, HardDrive, Loader2, PlugZap, Save } from 'lucide-react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Switch } from '@/components/ui/Switch';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  fetchFileStorageConfig,
  saveFileStorageConfig,
  testFileStorageConfig,
  type FileStorageConfig,
} from '@/cmdb/api/files';

type Status = { tone: 'success' | 'error'; message: string } | null;

const splitExtensions = (value: string): string[] =>
  value
    .split(/[\s,，]+/)
    .map((item) => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);

const EMPTY: FileStorageConfig = {
  storage_backend: 'local',
  local_path: '',
  s3_endpoint_url: '',
  s3_access_key: '',
  s3_secret_key: '',
  s3_bucket_name: 'cmdb-files',
  s3_region: 'us-east-1',
  s3_use_ssl: true,
  allowed_extensions: [],
  max_file_size_mb: 50,
};

export default function SettingsFileStorage() {
  const { tr } = useI18n();
  const [config, setConfig] = useState<FileStorageConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  // Keep the raw text so typing a comma does not get normalized away before
  // the next extension is typed.
  const [extensionsText, setExtensionsText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const got = await fetchFileStorageConfig();
      setConfig(got);
      setExtensionsText(got.allowed_extensions.join(', '));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = <K extends keyof FileStorageConfig>(key: K, value: FileStorageConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const saved = await saveFileStorageConfig(config);
      setConfig(saved);
      setExtensionsText(saved.allowed_extensions.join(', '));
      setStatus({ tone: 'success', message: tr('文件存储设置已保存。', 'File storage settings saved.') });
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
      const result = await testFileStorageConfig(config);
      setStatus({
        tone: result.ok ? 'success' : 'error',
        message: result.ok ? tr('连接成功。', 'Connection succeeded.') : result.error || tr('连接失败。', 'Connection failed.'),
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

  const isS3 = config.storage_backend === 's3';

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-4 flex items-center gap-2">
          <HardDrive size={14} className="text-zinc-400" />
          <h2 className="text-sm font-medium text-zinc-100">{tr('文件存储', 'File storage')}</h2>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-zinc-500">
          {tr(
            'CMDB 文件属性的附件保存在本地卷或 S3 兼容存储中。切换存储不会迁移已有文件；旧文件仍按上传时记录的存储类型读取。',
            'Attachments for CMDB file attributes live on the local volume or an S3-compatible store. Switching storage does not migrate existing files; old files still read from the backend recorded at upload time.',
          )}
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          {[
            { value: 'local' as const, icon: HardDrive, zh: '本地存储', en: 'Local', hintZh: 'CMDB 数据卷', hintEn: 'CMDB data volume' },
            { value: 's3' as const, icon: Cloud, zh: 'S3 / MinIO', en: 'S3 / MinIO', hintZh: 'S3 兼容对象存储', hintEn: 'S3-compatible object store' },
          ].map((option) => {
            const Icon = option.icon;
            const selected = config.storage_backend === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => update('storage_backend', option.value)}
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
          {!isS3 && (
            <div>
              <Label htmlFor="cmdb-file-local-path">{tr('本地目录', 'Local directory')}</Label>
              <Input
                id="cmdb-file-local-path"
                value={config.local_path}
                onChange={(event) => update('local_path', event.target.value)}
                className="mt-1 w-full font-mono"
                placeholder="/var/lib/ongrid/cmdb-files"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                {tr('必须是绝对路径；CMDB 容器需要对该目录有写权限。', 'Must be absolute; the CMDB container needs write access.')}
              </p>
            </div>
          )}

          <div>
            <Label htmlFor="cmdb-file-allowed">{tr('允许的扩展名', 'Allowed extensions')}</Label>
            <Input
              id="cmdb-file-allowed"
              value={extensionsText}
              onChange={(event) => {
                setExtensionsText(event.target.value);
                update('allowed_extensions', splitExtensions(event.target.value));
              }}
              className="mt-1 w-full font-mono"
              placeholder="pdf, png, docx, xlsx"
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              {tr('用逗号或空格分隔。SVG/HTML 默认不允许，避免内联脚本。', 'Comma or space separated. SVG/HTML are excluded by default to avoid inline script.')}
            </p>
          </div>

          <div>
            <Label htmlFor="cmdb-file-max">{tr('单文件上限（MB）', 'Max file size (MB)')}</Label>
            <Input
              id="cmdb-file-max"
              type="number"
              min={1}
              max={500}
              value={config.max_file_size_mb}
              onChange={(event) => update('max_file_size_mb', Number(event.target.value))}
              className="mt-1 w-32"
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              {tr('默认部署的 nginx 请求上限为 60 MB；调大后需同步调整 nginx。', 'The default nginx request limit is 60 MB; raise it too when increasing this.')}
            </p>
          </div>
        </div>
      </section>

      {isS3 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Cloud size={14} className="text-zinc-400" />
            <h2 className="text-sm font-medium text-zinc-100">{tr('S3 / MinIO 连接', 'S3 / MinIO connection')}</h2>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="cmdb-file-s3-endpoint">{tr('Endpoint', 'Endpoint')}</Label>
              <Input
                id="cmdb-file-s3-endpoint"
                value={config.s3_endpoint_url}
                onChange={(event) => update('s3_endpoint_url', event.target.value)}
                className="mt-1 w-full font-mono"
                placeholder="http://minio:9000"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="cmdb-file-s3-access">{tr('Access Key', 'Access key')}</Label>
                <Input
                  id="cmdb-file-s3-access"
                  value={config.s3_access_key}
                  onChange={(event) => update('s3_access_key', event.target.value)}
                  className="mt-1 w-full font-mono"
                  autoComplete="off"
                />
              </div>
              <div>
                <Label htmlFor="cmdb-file-s3-secret">{tr('Secret Key', 'Secret key')}</Label>
                <Input
                  id="cmdb-file-s3-secret"
                  type="password"
                  value={config.s3_secret_key}
                  onChange={(event) => update('s3_secret_key', event.target.value)}
                  className="mt-1 w-full font-mono"
                  placeholder={tr('保持 ****** 表示不修改', 'Keep ****** to leave unchanged')}
                  autoComplete="new-password"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  {tr('已保存的密钥不会回显；保持不变即可继续使用。', 'A saved key is never shown again; leaving it unchanged keeps it.')}
                </p>
              </div>
              <div>
                <Label htmlFor="cmdb-file-s3-bucket">{tr('Bucket', 'Bucket')}</Label>
                <Input
                  id="cmdb-file-s3-bucket"
                  value={config.s3_bucket_name}
                  onChange={(event) => update('s3_bucket_name', event.target.value)}
                  className="mt-1 w-full"
                  placeholder="cmdb-files"
                />
              </div>
              <div>
                <Label htmlFor="cmdb-file-s3-region">{tr('Region', 'Region')}</Label>
                <Input
                  id="cmdb-file-s3-region"
                  value={config.s3_region}
                  onChange={(event) => update('s3_region', event.target.value)}
                  className="mt-1 w-full"
                  placeholder="us-east-1"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3">
              <div>
                <div className="text-[13px] font-medium text-zinc-200">{tr('使用 HTTPS', 'Use HTTPS')}</div>
                <div className="mt-0.5 text-[11px] text-zinc-500">{tr('MinIO 在纯内网常见 http://', 'MinIO on a private network often uses http://')}</div>
              </div>
              <Switch
                checked={config.s3_use_ssl}
                onCheckedChange={(next) => update('s3_use_ssl', next)}
                aria-label={tr('使用 HTTPS', 'Use HTTPS')}
              />
            </div>
          </div>
        </section>
      )}

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
