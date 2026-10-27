/**
 * Starts a browser download for a JSON document.
 *
 * The caller owns the filename (including sanitising user-derived names) and
 * catches a thrown error so a failed download is not silent. The object URL is
 * revoked on the next task, after the browser has had a chance to start the
 * download.
 */
export function downloadJSON(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
