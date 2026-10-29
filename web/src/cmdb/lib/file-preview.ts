/**
 * Absolute base for URLs fetched by kkFileView. Unlike the browser's API
 * base, this URL must be reachable from the kkFileView host: set
 * VITE_FILE_API_BASE_URL when kkFileView runs in another container or on a
 * different machine. An empty value uses the browser origin.
 */
export function filePreviewBaseUrl(): string {
  return import.meta.env.VITE_FILE_API_BASE_URL || window.location.origin;
}

/**
 * Base for the signed file URL handed to kkFileView. The admin-configured
 * value wins because it is resolved at request time and can name the compose
 * service (for example http://ongrid-cmdb:8082) even when the browser origin
 * is not reachable from kkFileView. Trailing slashes are removed so the
 * relative capability path can be appended directly.
 */
export function resolveFileFetchBase(configured?: string | null): string {
  const value = (configured ?? '').trim();
  return (value || filePreviewBaseUrl()).replace(/\/+$/, '');
}

/** UTF-8 safe base64 without the deprecated unescape() round-trip. */
export function base64UTF8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

/**
 * Builds the kkFileView iframe URL.
 *
 * forceTypes is matched on the final extension. The `fullfilename` parameter
 * gives kkFileView the original name when the signed path has no extension
 * (our capability URLs do not expose the stored path).
 */
export function buildKkFilePreviewURL(
  previewServer: string,
  fileURL: string,
  fileName: string,
  forceTypes: string[],
): string {
  const server = previewServer.trim();
  if (!server) return '';
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const force = forceTypes.map((item) => item.trim().toLowerCase()).includes(ext);
  const withName = `${fileURL}${fileURL.includes('?') ? '&' : '?'}fullfilename=${encodeURIComponent(fileName)}`;
  return `${server}?url=${encodeURIComponent(base64UTF8(withName))}${force ? '&forceUpdatedCache=true' : ''}`;
}
