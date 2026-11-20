import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * A desktop-control `screenshot` run's picture, made fit for a model to look at.
 *
 * The executable prints the whole capture as base64 inside its JSON (2x on a Retina display), far
 * more than a command result carries as text. For such a run Main keeps the printed output out of
 * the command's stored output and timeline, makes the picture small enough to travel (never larger
 * than the capture, at most `SCREENSHOT_MAX_EDGE` on its long edge, PNG when it fits, JPEG
 * otherwise), and stores and shows only what the picture is: its format, sizes, scale factor,
 * byte length and digest. The printed output is kept nowhere else (not in the command's session
 * either), and the picture itself is held in memory for the tool result only
 * (`takeScreenshotPicture`) and goes to the Turn's model only where Main decides it may.
 */
export const SCREENSHOT_MAX_EDGE = 1568;
/**
 * The longest `data:` URL a picture may be. A runtime `tool_result` is at most 1 MiB of JSON
 * (`RUNTIME_TOOL_RESULT_MAX_BYTES`); this leaves room for the command's own fields.
 */
export const SCREENSHOT_MAX_DATA_URL_CHARS = 800 * 1024;
/** How long Main waits for a screenshot run; it never goes on in the background. */
export const SCREENSHOT_WAIT_MS = 60_000;
/** The most of the executable's stderr a screenshot run keeps. */
export const SCREENSHOT_MAX_STDERR_BYTES = 4 * 1024;
/** The most of other (non-picture) output a screenshot run keeps, as a command result does. */
const SCREENSHOT_MAX_TEXT_BYTES = 64 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const JPEG_QUALITIES = [85, 75, 65, 55] as const;
const SMALLEST_EDGE = 320;

/** Told to the model when its connection cannot be given the picture. */
export const SCREENSHOT_PICTURE_UNAVAILABLE =
  'この接続では、撮った画像を AI に渡せない。画面の中身を確かめる時は snapshot を使う。';
/** Told to the model beside the picture it is given. */
export const SCREENSHOT_PICTURE_ATTACHED =
  '撮った画像をこの結果に添えた。画像の 1 px は points_per_pixel ポイントに当たる。部品の ref は snapshot で取る。';

export type ScreenshotPicture = Readonly<{
  mimeType: 'image/png' | 'image/jpeg';
  dataUrl: string;
  byteLength: number;
  sha256: string;
}>;

export type ScreenshotOutput = Readonly<{
  /** What is stored, shown and given to the model as the run's stdout. Never the picture. */
  stdout: string;
  picture?: ScreenshotPicture;
}>;

function failure(code: string, message: string): string {
  return JSON.stringify({ ok: false, command: 'screenshot', error: { code, message } });
}

const TOO_LARGE = failure(
  'SCREENSHOT_TOO_LARGE',
  '撮った画像が大きすぎて、AI に渡せる大きさにできなかった。画面の中身は snapshot で読む。',
);
const UNREADABLE = failure(
  'SCREENSHOT_UNREADABLE',
  '撮った画像を読めなかった。画面の中身は snapshot で読む。',
);

function clipText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString('utf8');
}

/** Keeps at most `maxBytes` of stderr for a screenshot run. */
export function clipScreenshotStderr(text: string): string {
  return clipText(text, SCREENSHOT_MAX_STDERR_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Encoded = {
  mimeType: ScreenshotPicture['mimeType'];
  bytes: Buffer;
  width: number;
  height: number;
};

async function encode(
  source: Buffer,
  width: number,
  height: number,
  format: 'png' | 'jpeg',
  quality: number,
): Promise<Encoded> {
  const pipeline = sharp(source, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).resize(
    width,
    height,
    { fit: 'fill' },
  );
  const output =
    format === 'png'
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await pipeline
          .flatten({ background: '#ffffff' })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
  return {
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    bytes: output.data,
    width: output.info.width,
    height: output.info.height,
  };
}

function fits(encoded: Encoded, maxDataUrlChars: number): boolean {
  return (
    `data:${encoded.mimeType};base64,`.length + Math.ceil(encoded.bytes.byteLength / 3) * 4 <=
    maxDataUrlChars
  );
}

function sizeWithin(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The smallest change of the capture that fits: the capture at most `maxEdge` on its long edge as
 * PNG, else as JPEG at falling quality, else smaller as JPEG, down to `SMALLEST_EDGE`. `null` when
 * nothing fits.
 */
export async function fitScreenshotPicture(
  source: Buffer,
  maxDataUrlChars = SCREENSHOT_MAX_DATA_URL_CHARS,
  maxEdge = SCREENSHOT_MAX_EDGE,
): Promise<(Encoded & { sourceWidth: number; sourceHeight: number }) | null> {
  const metadata = await sharp(source, {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
  }).metadata();
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.height;
  if (
    sourceWidth === undefined ||
    sourceHeight === undefined ||
    sourceWidth < 1 ||
    sourceHeight < 1
  )
    return null;
  const done = (encoded: Encoded) => ({ ...encoded, sourceWidth, sourceHeight });
  let edge = Math.min(maxEdge, Math.max(sourceWidth, sourceHeight));
  const first = sizeWithin(sourceWidth, sourceHeight, edge);
  const png = await encode(source, first.width, first.height, 'png', 0);
  if (fits(png, maxDataUrlChars)) return done(png);
  for (const quality of JPEG_QUALITIES) {
    const jpeg = await encode(source, first.width, first.height, 'jpeg', quality);
    if (fits(jpeg, maxDataUrlChars)) return done(jpeg);
  }
  while (edge > SMALLEST_EDGE) {
    edge = Math.max(SMALLEST_EDGE, Math.floor(edge * 0.75));
    const size = sizeWithin(sourceWidth, sourceHeight, edge);
    const jpeg = await encode(
      source,
      size.width,
      size.height,
      'jpeg',
      JPEG_QUALITIES[JPEG_QUALITIES.length - 1]!,
    );
    if (fits(jpeg, maxDataUrlChars)) return done(jpeg);
  }
  return null;
}

/**
 * What a screenshot run's printed output becomes: its stored and shown stdout (the executable's
 * envelope with the picture replaced by what it is), and the picture fit to travel. The
 * executable's own error (`ok: false`) is kept without any `data`; output the runner cut short
 * becomes the too-large error; anything else that is not a picture becomes the unreadable error,
 * so no other shape of printed output reaches the store. Both errors name `snapshot`.
 */
export async function prepareScreenshotOutput(
  printed: string,
  runnerTruncated: boolean,
  maxDataUrlChars = SCREENSHOT_MAX_DATA_URL_CHARS,
): Promise<ScreenshotOutput> {
  if (runnerTruncated) return { stdout: TOO_LARGE };
  let envelope: unknown;
  try {
    envelope = JSON.parse(printed);
  } catch {
    return { stdout: UNREADABLE };
  }
  if (!isRecord(envelope)) return { stdout: UNREADABLE };
  // The executable's own error is what the AI needs to read; it is kept, without any `data`.
  if (envelope['ok'] === false) {
    const { data: _data, ...error } = envelope;
    const kept = JSON.stringify(error);
    return {
      stdout: Buffer.byteLength(kept, 'utf8') <= SCREENSHOT_MAX_TEXT_BYTES ? kept : UNREADABLE,
    };
  }
  const data = envelope['data'];
  if (envelope['ok'] !== true || !isRecord(data) || typeof data['data'] !== 'string')
    return { stdout: UNREADABLE };
  const source = Buffer.from(data['data'], 'base64');
  let fitted: Awaited<ReturnType<typeof fitScreenshotPicture>>;
  try {
    fitted = source.byteLength === 0 ? null : await fitScreenshotPicture(source, maxDataUrlChars);
  } catch {
    return { stdout: UNREADABLE };
  }
  if (fitted === null) return { stdout: TOO_LARGE };
  const scaleFactor =
    typeof data['scale_factor'] === 'number' &&
    Number.isFinite(data['scale_factor']) &&
    data['scale_factor'] > 0 &&
    data['scale_factor'] <= 16
      ? data['scale_factor']
      : 1;
  const sha256 = createHash('sha256').update(fitted.bytes).digest('hex');
  const base64 = fitted.bytes.toString('base64');
  // Only these fields are copied, each bounded, so nothing else the executable printed (a second
  // copy of the picture, for one) reaches the store beside it.
  const version = envelope['version'];
  const sourceFormat = data['format'];
  const stdout = JSON.stringify({
    ...(typeof version === 'string' && version.length <= 16 ? { version } : {}),
    ok: true,
    command: 'screenshot',
    data: {
      format: fitted.mimeType === 'image/png' ? 'png' : 'jpg',
      width: fitted.width,
      height: fitted.height,
      source_format: sourceFormat === 'png' || sourceFormat === 'jpg' ? sourceFormat : 'png',
      source_width: fitted.sourceWidth,
      source_height: fitted.sourceHeight,
      scale_factor: scaleFactor,
      points_per_pixel: Number((fitted.sourceWidth / scaleFactor / fitted.width).toFixed(4)),
      byte_length: fitted.bytes.byteLength,
      sha256,
    },
  });
  return {
    stdout,
    picture: Object.freeze({
      mimeType: fitted.mimeType,
      dataUrl: `data:${fitted.mimeType};base64,${base64}`,
      byteLength: fitted.bytes.byteLength,
      sha256,
    }),
  };
}

// The picture of a screenshot run's tool call, kept in Main beside the call (the Task, the Turn and
// the call id the ToolBroker ran it under) and never in the result object, so no route that does
// not ask for it (a stored record, an API provider's text, a log) can carry it, and no copy of the
// result made on the way loses it. It lives as long as the call: Main's managed dispatch takes it
// as the call returns, fails or is canceled, and the Turn's end drops any left.
const pictures = new Map<string, ScreenshotPicture>();

/** The key a screenshot's picture is held under: the call as the ToolBroker ran it. */
export function screenshotCallKey(taskId: string, turnId: string, callId: string): string {
  return JSON.stringify([taskId, turnId, callId]);
}

export function holdScreenshotPicture(key: string, picture: ScreenshotPicture): void {
  pictures.set(key, picture);
}

/** The picture held for this call, once; `undefined` for any other call. */
export function takeScreenshotPicture(key: string): ScreenshotPicture | undefined {
  const picture = pictures.get(key);
  pictures.delete(key);
  return picture;
}

/** Drops every picture still held for a Turn's calls (as the Turn ends). */
export function releaseScreenshotPicturesForTurn(taskId: string, turnId: string): void {
  for (const key of [...pictures.keys()]) {
    const [keyTask, keyTurn] = JSON.parse(key) as [string, string, string];
    if (keyTask === taskId && keyTurn === turnId) pictures.delete(key);
  }
}

/** How many pictures are held (for tests). */
export function heldScreenshotPictureCount(): number {
  return pictures.size;
}

/** Whether this tool result is a screenshot run's (it has a `picture` sentence). */
export function isScreenshotToolResult(result: unknown): result is Record<string, unknown> & {
  picture: string;
} {
  return (
    isRecord(result) &&
    (result['picture'] === SCREENSHOT_PICTURE_UNAVAILABLE ||
      result['picture'] === SCREENSHOT_PICTURE_ATTACHED)
  );
}

/** The model id a CLI connection's catalog gives its own automatic choice. */
export const AUTOMATIC_MODEL_ID = 'auto';

type CatalogModel = Readonly<{
  modelId: string;
  multimodalInput: Readonly<{ value: boolean | null }>;
}>;

/**
 * Whether a Turn's model takes images, by the model catalog's `multimodalInput`. Unknown counts as
 * no. The model the Turn resolved to decides when it is recorded; otherwise the model it asked for.
 * The connection's automatic choice, whose own entry may say unknown, takes images when every
 * concrete model the connection's catalog lists is known to take them: whichever it picks does.
 */
export function turnModelTakesPictures(
  identity: Readonly<{
    selection: Readonly<{ connectionId: string | null; requestedModel: string | null }>;
    resolution: Readonly<{ resolvedModel: string | null }>;
  }>,
  catalog: Readonly<{
    find(connectionId: string, modelId: string): CatalogModel | undefined;
    list(connectionId: string): readonly CatalogModel[];
  }>,
): boolean {
  const { connectionId, requestedModel } = identity.selection;
  if (connectionId === null) return false;
  const resolved = identity.resolution.resolvedModel;
  if (resolved !== null && resolved !== AUTOMATIC_MODEL_ID)
    return catalog.find(connectionId, resolved)?.multimodalInput.value === true;
  if (requestedModel === null) return false;
  const requested = catalog.find(connectionId, requestedModel)?.multimodalInput.value;
  if (requested === true || requested === false) return requested;
  if (requestedModel !== AUTOMATIC_MODEL_ID) return false;
  const concrete = catalog
    .list(connectionId)
    .filter(({ modelId }) => modelId !== AUTOMATIC_MODEL_ID);
  return (
    concrete.length > 0 && concrete.every(({ multimodalInput }) => multimodalInput.value === true)
  );
}

/**
 * The tool result a Turn's model gets: with the picture as `dataUrl` (which the CLI adapters hand
 * over as an image) when `accepted`, the picture is the one the result's own metadata names (its
 * digest), and the whole result stays within `maxResultBytes`; else the result as it is, which
 * tells the model it has no picture.
 */
export function screenshotToolResultFor(
  result: unknown,
  picture: ScreenshotPicture | undefined,
  accepted: boolean,
  maxResultBytes: number,
): unknown {
  if (!accepted || picture === undefined || !isScreenshotToolResult(result)) return result;
  if (screenshotDigestOf(result) !== picture.sha256) return result;
  const withPicture = {
    ...result,
    picture: SCREENSHOT_PICTURE_ATTACHED,
    mimeType: picture.mimeType,
    byteLength: picture.byteLength,
    sha256: picture.sha256,
    dataUrl: picture.dataUrl,
  };
  return Buffer.byteLength(JSON.stringify(withPicture), 'utf8') <= maxResultBytes
    ? withPicture
    : result;
}

export function matchesScreenshotPicture(result: unknown, picture: ScreenshotPicture): boolean {
  return isScreenshotToolResult(result) && screenshotDigestOf(result) === picture.sha256;
}

function screenshotDigestOf(result: Record<string, unknown>): string | undefined {
  if (typeof result['stdout'] !== 'string') return undefined;
  try {
    const envelope: unknown = JSON.parse(result['stdout']);
    const data = isRecord(envelope) ? envelope['data'] : undefined;
    return isRecord(data) && typeof data['sha256'] === 'string' ? data['sha256'] : undefined;
  } catch {
    return undefined;
  }
}
