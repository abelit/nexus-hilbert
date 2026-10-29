import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Loader2 } from 'lucide-react';

import { useI18n } from '@/i18n/locale';

import {
  fetchFilePreviewConfig,
  getFilePreviewLink,
  type CIFile,
  type FilePreviewConfig,
} from '../../api/files';
import { buildKkFilePreviewURL, resolveFileFetchBase } from '../../lib/file-preview';

/**
 * The kkFileView iframe.
 *
 * The file URL is a short-lived, file-scoped capability, not the user's JWT.
 * kkFileView is an external process and would otherwise receive a credential
 * that can call the rest of the API. The download link uses the same capability
 * with the attachment disposition.
 */
export function FilePreview({ file }: { file: CIFile }) {
  const { tr } = useI18n();
  const [config, setConfig] = useState<FilePreviewConfig | null>(null);
  const [kkFileURL, setKkFileURL] = useState('');
  // Browser-reachable capability path for "open in new tab". The kkFileURL
  // may point at an internal compose service the browser cannot resolve.
  const [openURL, setOpenURL] = useState('');
  const [downloadURL, setDownloadURL] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void Promise.all([fetchFilePreviewConfig(), getFilePreviewLink(file.file_id, false), getFilePreviewLink(file.file_id, true)])
      .then(([cfg, preview, download]) => {
        if (!live) return;
        setConfig(cfg);
        setKkFileURL(`${resolveFileFetchBase(cfg.file_fetch_base_url)}${preview.url}`);
        setOpenURL(preview.url);
        setDownloadURL(download.url);
        if (!cfg.preview_server_url) setLoading(false);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [file.file_id]);

  const iframeURL = useMemo(() => {
    if (!config || !kkFileURL) return '';
    return buildKkFilePreviewURL(
      config.preview_server_url,
      kkFileURL,
      file.original_name,
      config.force_updated_cache_types,
    );
  }, [config, file.original_name, kkFileURL]);

  // A dead kkFileView often returns an error page that still fires onLoad, but
  // a network hang does not. Stop the spinner anyway and leave the download
  // controls available.
  useEffect(() => {
    if (!iframeURL) return;
    const timer = window.setTimeout(() => setLoading(false), 8000);
    return () => window.clearTimeout(timer);
  }, [iframeURL]);

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
        {tr('无法准备预览：', 'Could not prepare the preview: ')}
        {error}
      </div>
    );
  }

  if (!loading && (!iframeURL || !config?.preview_server_url)) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-12 text-center">
        <p className="text-xs text-text-muted">
          {tr('还没有配置在线预览服务，请先在「设置 → 文件预览」中填写地址。', 'No preview server is configured. Set one under Settings → File preview.')}
        </p>
        {downloadURL && (
          <a
            href={downloadURL}
            download={file.original_name}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text hover:bg-card"
          >
            <Download size={12} aria-hidden="true" />
            {tr('下载原文件', 'Download original')}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-[68vh] min-h-[320px] w-full overflow-hidden rounded-lg border border-border bg-card">
      {iframeURL && (
        <iframe
          src={iframeURL}
          title={file.original_name}
          className="h-full w-full border-0"
          onLoad={() => setLoading(false)}
        />
      )}
      {loading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-bg/70 text-xs text-text-muted">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          {tr('预览加载中…', 'Loading preview…')}
        </div>
      )}
      <div className="absolute bottom-2 right-2 z-20 flex items-center gap-1 rounded-md border border-border bg-card/95 px-1.5 py-1 shadow-sm">
        {downloadURL && (
          <a
            href={downloadURL}
            download={file.original_name}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-text-muted hover:bg-bg hover:text-text"
          >
            <Download size={11} aria-hidden="true" />
            {tr('下载', 'Download')}
          </a>
        )}
        {openURL && (
          <a
            href={openURL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-text-muted hover:bg-bg hover:text-text"
          >
            <ExternalLink size={11} aria-hidden="true" />
            {tr('新窗口打开', 'Open in new tab')}
          </a>
        )}
      </div>
    </div>
  );
}
