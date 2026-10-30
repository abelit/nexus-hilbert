import { describe, expect, it, vi } from 'vitest';

const toPng = vi.hoisted(() => vi.fn());

vi.mock('html-to-image', () => ({ toPng }));

import { downloadTopologyPng } from './model-topology-export';

describe('downloadTopologyPng', () => {
  it('renders the element to a png and clicks a download link', async () => {
    toPng.mockResolvedValue('data:image/png;base64,abc');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const element = document.createElement('div');

    await downloadTopologyPng(element, 'cmdb-host-relations.png');

    expect(toPng).toHaveBeenCalledWith(element, expect.objectContaining({ pixelRatio: 2 }));
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor).toBeDefined();
    expect(anchor.download).toBe('cmdb-host-relations.png');
    expect(anchor.getAttribute('href')).toBe('data:image/png;base64,abc');
    click.mockRestore();
  });

  it('propagates a capture failure', async () => {
    toPng.mockRejectedValueOnce(new Error('capture failed'));

    await expect(downloadTopologyPng(document.createElement('div'), 'x.png')).rejects.toThrow(
      'capture failed',
    );
  });
});
