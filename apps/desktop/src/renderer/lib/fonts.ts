// The bundled type families (issue #1253; the faces are declared in ../fonts.css). CSS names them
// through the --font-sans / --font-mono tokens in index.css; these strings are for the places that
// cannot read a CSS variable — a canvas `font` and an SVG attribute.
export const FONT_SANS = '"SC Sans", system-ui, sans-serif';
export const FONT_MONO = '"SC Mono", ui-monospace, monospace';

/** Latin, kana, kanji and a box-drawing line: enough to pull in every face a first screen uses. */
export const FONT_SAMPLE_TEXT = 'Aあ漢─';

/** How long the first paint may wait for the fonts. Past this the app draws anyway. */
export const STARTUP_FONT_WAIT_MS = 1000;

export type FontWaitResult = 'loaded' | 'timeout' | 'failed' | 'unsupported';

/** Puts `is-win` on the root for Windows (see `.is-win` in index.css), and only there. */
export function applyPlatformClass(root: Element, platform: string | undefined): void {
  root.classList.toggle('is-win', platform === 'win32');
}

/**
 * Every face, loaded before the first paint. They are local files and load in a few milliseconds;
 * a face first asked for later would leave its text blank (font-display: block) for that moment,
 * the first time a screen used that weight.
 */
export const STARTUP_FONT_SPECS: readonly string[] = [
  ...[400, 450, 500, 600, 700].map((weight) => `${weight} 14px "SC Sans"`),
  ...[400, 700].map((weight) => `${weight} 13px "SC Mono"`),
];

/**
 * Waits for `specs` to load, but never for longer than `timeoutMs`: the fonts are local, so this
 * normally settles in a few frames, and a slow or broken load must not hold the window blank.
 * Resolves (never rejects) with what happened.
 */
export function waitForFonts(
  fonts: Pick<FontFaceSet, 'load'> | undefined,
  specs: readonly string[],
  timeoutMs: number,
  text: string = FONT_SAMPLE_TEXT,
): Promise<FontWaitResult> {
  if (fonts === undefined || typeof fonts.load !== 'function')
    return Promise.resolve('unsupported');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FontWaitResult>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const loads = Promise.all(specs.map((spec) => fonts.load(spec, text))).then(
    (): FontWaitResult => 'loaded',
    (): FontWaitResult => 'failed',
  );
  return Promise.race([loads, timeout]).finally(() => clearTimeout(timer));
}
