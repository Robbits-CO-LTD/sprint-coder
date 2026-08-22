import { describe, expect, it } from 'vitest';
import {
  clipboardCarriesImage,
  createTrustedImagePasteGate,
  TRUSTED_IMAGE_PASTE_WINDOW_MS,
} from './clipboard-image-paste';

describe('clipboardCarriesImage', () => {
  it('treats a paste as an image only when no text was copied alongside it', () => {
    expect(
      clipboardCarriesImage({ types: ['Files'], items: [{ kind: 'file', type: 'image/png' }] }),
    ).toBe(true);
    // Spreadsheet and slide editors put a picture of the selection on the clipboard next to the
    // text. Attaching that picture instead of pasting the text would be wrong far more often.
    expect(
      clipboardCarriesImage({
        types: ['text/plain', 'text/html', 'Files'],
        items: [
          { kind: 'string', type: 'text/plain' },
          { kind: 'file', type: 'image/png' },
        ],
      }),
    ).toBe(false);
    expect(
      clipboardCarriesImage({
        types: ['Files'],
        items: [{ kind: 'file', type: 'application/pdf' }],
      }),
    ).toBe(false);
    expect(clipboardCarriesImage(null)).toBe(false);
  });
});

describe('createTrustedImagePasteGate', () => {
  it('authorizes exactly one clipboard read per arming', () => {
    const now = 1_000;
    const gate = createTrustedImagePasteGate(() => now);

    expect(gate.consume()).toBe(false);
    gate.arm();
    expect(gate.consume()).toBe(true);
    // A second read off the same paste is what a compromised page would try.
    expect(gate.consume()).toBe(false);
  });

  it('expires so a past paste cannot authorize a later read', () => {
    let now = 1_000;
    const gate = createTrustedImagePasteGate(() => now);

    gate.arm();
    now += TRUSTED_IMAGE_PASTE_WINDOW_MS;
    expect(gate.consume()).toBe(true);

    gate.arm();
    now += TRUSTED_IMAGE_PASTE_WINDOW_MS + 1;
    expect(gate.consume()).toBe(false);
  });

  it('reads a backwards clock as expired rather than as an open window', () => {
    let now = 10_000;
    const gate = createTrustedImagePasteGate(() => now);

    gate.arm();
    now -= 5_000;
    expect(gate.consume()).toBe(false);
  });
});
