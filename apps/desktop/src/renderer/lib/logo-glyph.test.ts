// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** An image that "loads" (or fails) as soon as it is given a source. */
function stubImage(loads: boolean): { made: number } {
  const count = { made: 0 };
  class FakeImage {
    decoding = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      count.made += 1;
    }
    set src(_value: string) {
      queueMicrotask(() => (loads ? this.onload?.() : this.onerror?.()));
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return count;
}

/** A canvas context whose pixels are the logo's blue (kept) or the icon's dark plate (cut away). */
function stubCanvas(pixel: [number, number, number]): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage() {},
        putImageData() {},
        getImageData(_x: number, _y: number, w: number, h: number) {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let p = 0; p < data.length; p += 4) data.set([...pixel, 255], p);
          return { data };
        },
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadLogoGlyph', () => {
  it('cuts the logo out of the icon once, and hands the same image to everyone', async () => {
    const images = stubImage(true);
    stubCanvas([69, 190, 252]);
    const { loadLogoGlyph } = await import('./logo-glyph');
    const first = loadLogoGlyph();
    expect(loadLogoGlyph()).toBe(first);
    await expect(first).resolves.toBe('data:image/png;base64,AA');
    expect(images.made).toBe(1);
  });

  it('gives no image when what it loaded has no logo in it', async () => {
    stubImage(true);
    stubCanvas([24, 26, 32]);
    const { loadLogoGlyph } = await import('./logo-glyph');
    await expect(loadLogoGlyph()).resolves.toBeNull();
  });

  it('gives no image when the icon cannot be loaded, or there is no canvas', async () => {
    stubImage(false);
    const failed = await import('./logo-glyph');
    await expect(failed.loadLogoGlyph()).resolves.toBeNull();
    vi.resetModules();
    stubImage(true);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const bare = await import('./logo-glyph');
    await expect(bare.loadLogoGlyph()).resolves.toBeNull();
  });
});
