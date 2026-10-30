import { toPng } from 'html-to-image';

// The canvas is a DOM subtree (glass cards, CSS variables, foreign objects), so
// the browser's own rasteriser is the only faithful exporter. html-to-image
// serialises that subtree; picking a filename and clicking a link is all that
// is left. The caller owns the busy state and the error toast.

export async function downloadTopologyPng(element: HTMLElement, filename: string): Promise<void> {
  const dataUrl = await toPng(element, { pixelRatio: 2, cacheBust: true });
  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  link.click();
}
