import { useEffect, useState } from 'react';
import iconUrl from '../../../assets/sprint-coder-icon-master-v1.png';
import { keepLogoPixels, LOGO_CROP, LOGO_SOURCE_SIZE } from './setup-logo-intro';

// The logo by itself, as an image: the app icon with its dark plate cut away (the same cut-out the
// logo film uses, so the Setup shows the very same shape and colours). Made once, on first use;
// where it cannot be made (no canvas), there is simply no image.

let glyph: Promise<string | null> | null = null;

function cutOut(): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    image.onerror = () => resolve(null);
    image.onload = () => {
      try {
        const source = document.createElement('canvas');
        source.width = LOGO_SOURCE_SIZE;
        source.height = LOGO_SOURCE_SIZE;
        const sctx = source.getContext('2d', { willReadFrequently: true });
        if (!sctx) {
          resolve(null);
          return;
        }
        sctx.drawImage(image, 0, 0, LOGO_SOURCE_SIZE, LOGO_SOURCE_SIZE);
        const data = sctx.getImageData(LOGO_CROP.x, LOGO_CROP.y, LOGO_CROP.w, LOGO_CROP.h);
        if (!data?.data || keepLogoPixels(data.data) < 200) {
          resolve(null);
          return;
        }
        const out = document.createElement('canvas');
        out.width = LOGO_CROP.w;
        out.height = LOGO_CROP.h;
        const octx = out.getContext('2d');
        if (!octx) {
          resolve(null);
          return;
        }
        octx.putImageData(data, 0, 0);
        resolve(out.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    image.src = iconUrl;
  });
}

/** The logo as a data URL, or null where it cannot be made. */
export function loadLogoGlyph(): Promise<string | null> {
  glyph ??= cutOut();
  return glyph;
}

/** The logo's image URL once it is ready (null until then, and where it cannot be made). */
export function useLogoGlyph(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadLogoGlyph().then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return url;
}
