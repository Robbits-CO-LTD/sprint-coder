import { isDesktopControlScreenshot } from './desktop-control';
// A desktop-control screenshot's picture, made fit for the Turn's model: never upscaled, at most
// 1568 px on its long edge, PNG when it fits and JPEG otherwise, within what the runtime protocol
// carries; stored and shown only as what it is; and given to the model only where it may be.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@sprint-coder/domain';
import {
  SCREENSHOT_MAX_DATA_URL_CHARS,
  SCREENSHOT_MAX_EDGE,
  SCREENSHOT_PICTURE_ATTACHED,
  SCREENSHOT_PICTURE_UNAVAILABLE,
  fitScreenshotPicture,
  heldScreenshotPictureCount,
  holdScreenshotPicture,
  releaseScreenshotPicturesForTurn,
  isScreenshotToolResult,
  prepareScreenshotOutput,
  screenshotCallKey,
  screenshotToolResultFor,
  takeScreenshotPicture,
  turnModelTakesPictures,
} from './desktop-control-screenshot';
import { ToolBroker } from './tool-broker';
import {
  MANAGED_EXEC_COMMAND_TOOL,
  registerCommandRunnerTool,
  type CommandToolBoundary,
} from './default-tools';
import { CommandRunner, type CommandOutputChunk, type RunOptions } from './command-runner';
import * as desktopControlModule from './desktop-control';
import { configureDesktopControlTeamCursors } from './desktop-control-session';
import { ManagedCommandSessions } from './managed-command-sessions';
import {
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_TOOL_RESULT_MAX_BYTES,
  isMainToRuntimeEnvelope,
} from '../runtime-host/protocol';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  configureDesktopControlTeamCursors(false);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A flat PNG, which compresses to almost nothing. */
async function flatPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

/** A PNG of noise, which compresses as badly as a picture can. */
async function noisePng(width: number, height: number, seed = 1): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed;
  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    pixels[index] = state >>> 24;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** What the executable prints for a screenshot: its envelope with the picture as base64. */
function printedFor(png: Buffer, scale = 2): string {
  const meta = { width: 0, height: 0 };
  return JSON.stringify({
    version: '2.6',
    ok: true,
    command: 'screenshot',
    data: { data: png.toString('base64'), format: 'png', ...meta, scale_factor: scale },
  });
}

function dataOf(stdout: string): Record<string, unknown> {
  return (JSON.parse(stdout) as { data: Record<string, unknown> }).data;
}

describe('which runs are screenshots', () => {
  it('is the screenshot command itself, not its help or another command', () => {
    expect(isDesktopControlScreenshot(['screenshot', '--window-id', 'w-1'])).toBe(true);
    expect(isDesktopControlScreenshot(['screenshot'])).toBe(true);
    expect(isDesktopControlScreenshot(['screenshot', '--help'])).toBe(false);
    expect(isDesktopControlScreenshot(['snapshot', '--window-id', 'w-1'])).toBe(false);
    expect(isDesktopControlScreenshot(['batch', '[{"command":"screenshot","args":{}}]'])).toBe(
      false,
    );
  });
});

describe('fitting the picture', () => {
  it('never upscales a small capture and keeps it as PNG', async () => {
    const png = await flatPng(200, 100);
    const output = await prepareScreenshotOutput(printedFor(png), false);
    const data = dataOf(output.stdout);
    expect(data).toMatchObject({
      format: 'png',
      width: 200,
      height: 100,
      source_format: 'png',
      source_width: 200,
      source_height: 100,
      scale_factor: 2,
      points_per_pixel: 0.5,
    });
    expect(output.picture?.mimeType).toBe('image/png');
    const bytes = Buffer.from(output.picture!.dataUrl.split(',')[1]!, 'base64');
    expect(output.picture?.byteLength).toBe(bytes.byteLength);
    expect(data['byte_length']).toBe(bytes.byteLength);
    expect(data['sha256']).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(output.picture?.sha256).toBe(data['sha256']);
    const decoded = await sharp(bytes).metadata();
    expect([decoded.format, decoded.width, decoded.height]).toEqual(['png', 200, 100]);
    // What is stored and shown names the picture but never holds it.
    expect(output.stdout).not.toContain(png.toString('base64').slice(0, 40));
    expect(output.stdout).not.toContain('"data":"');
  });

  it('copies only bounded known fields beside the picture', async () => {
    const png = await flatPng(20, 10);
    const printedText = JSON.stringify({
      version: '2.6',
      ok: true,
      command: 'screenshot',
      extra: 'QUFB'.repeat(100),
      data: {
        data: png.toString('base64'),
        format: 'x'.repeat(500),
        scale_factor: 1e9,
        copy: 'QUFB',
      },
    });
    const output = await prepareScreenshotOutput(printedText, false);
    const envelope = JSON.parse(output.stdout) as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual(['version', 'ok', 'command', 'data']);
    expect(output.stdout).not.toContain('QUFB');
    expect(dataOf(output.stdout)).toMatchObject({ source_format: 'png', scale_factor: 1 });
  });

  it('brings a Retina capture down to the long-edge bound, keeping its shape', async () => {
    const png = await flatPng(3352, 2006);
    const output = await prepareScreenshotOutput(printedFor(png), false);
    const data = dataOf(output.stdout);
    expect(data['width']).toBe(SCREENSHOT_MAX_EDGE);
    expect(data['height']).toBe(Math.round((2006 * SCREENSHOT_MAX_EDGE) / 3352));
    expect(data['source_width']).toBe(3352);
    // 3352 px at 2x is 1676 points across 1568 picture pixels.
    expect(data['points_per_pixel']).toBeCloseTo(1676 / 1568, 3);
    const portrait = await prepareScreenshotOutput(printedFor(await flatPng(1000, 2400), 1), false);
    expect(dataOf(portrait.stdout)).toMatchObject({ width: 653, height: SCREENSHOT_MAX_EDGE });
  });

  it('falls back to JPEG, then to a smaller JPEG, then to a defined error', async () => {
    const png = await noisePng(400, 300);
    const pngSize = (await fitScreenshotPicture(png, Number.MAX_SAFE_INTEGER))!;
    expect(pngSize.mimeType).toBe('image/png');
    const limit = Math.floor((pngSize.bytes.byteLength * 4) / 3 / 2);
    const jpeg = (await fitScreenshotPicture(png, limit))!;
    expect(jpeg.mimeType).toBe('image/jpeg');
    expect([jpeg.width, jpeg.height]).toEqual([400, 300]);
    const large = await noisePng(1200, 900, 3);
    const quality55 = await sharp(large).jpeg({ quality: 55, mozjpeg: true }).toBuffer();
    const smaller = (await fitScreenshotPicture(
      large,
      Math.floor((quality55.byteLength * 4) / 3 / 2),
    ))!;
    expect(smaller.mimeType).toBe('image/jpeg');
    expect(smaller.width).toBeLessThan(1200);
    expect(smaller.width).toBeGreaterThanOrEqual(320);
    expect(smaller.width / smaller.height).toBeCloseTo(4 / 3, 1);
    const output = await prepareScreenshotOutput(printedFor(png), false, 100);
    expect(output.picture).toBeUndefined();
    expect(JSON.parse(output.stdout)).toEqual({
      ok: false,
      command: 'screenshot',
      error: {
        code: 'SCREENSHOT_TOO_LARGE',
        message:
          '撮った画像が大きすぎて、AI に渡せる大きさにできなかった。画面の中身は snapshot で読む。',
      },
    });
  });

  it('turns output the runner cut short, or cannot read as a picture, into an error naming snapshot', async () => {
    const cut = await prepareScreenshotOutput(printedFor(await flatPng(10, 10)), true);
    expect(cut.picture).toBeUndefined();
    expect(cut.stdout).toContain('SCREENSHOT_TOO_LARGE');
    const garbled = await prepareScreenshotOutput(
      `{"ok":true,"data":"${'A'.repeat(70_000)}`,
      false,
    );
    expect(garbled.stdout).toContain('SCREENSHOT_UNREADABLE');
    expect(garbled.stdout).toContain('snapshot');
    const notPicture = await prepareScreenshotOutput(
      JSON.stringify({ ok: true, command: 'screenshot', data: { data: 'bm90IGEgcGljdHVyZQ==' } }),
      false,
    );
    expect(notPicture.stdout).toContain('SCREENSHOT_UNREADABLE');
    // The executable's own error is kept as it is.
    const refused = JSON.stringify({
      version: '2.6',
      ok: false,
      command: 'screenshot',
      error: { code: 'PERM_DENIED', message: 'Screen Recording is not granted' },
    });
    expect(await prepareScreenshotOutput(refused, false)).toEqual({ stdout: refused });
    // Without any `data` it carried.
    const refusedWithData = JSON.stringify({
      ok: false,
      command: 'screenshot',
      error: { code: 'X', message: 'm' },
      data: { data: 'QUFB' },
    });
    expect(JSON.parse((await prepareScreenshotOutput(refusedWithData, false)).stdout)).toEqual({
      ok: false,
      command: 'screenshot',
      error: { code: 'X', message: 'm' },
    });
    // Any other shape, however small, is never stored as printed.
    for (const other of [
      'not json',
      JSON.stringify({ ok: true, command: 'screenshot', data: { pixels: 'QUFB' } }),
      JSON.stringify(['QUFB']),
    ])
      expect((await prepareScreenshotOutput(other, false)).stdout).toContain(
        'SCREENSHOT_UNREADABLE',
      );
  });

  it('keeps the worst picture of a Retina window within the runtime tool_result bound', async () => {
    const png = await noisePng(3352, 2006, 7);
    const output = await prepareScreenshotOutput(printedFor(png), false);
    expect(output.picture).toBeDefined();
    // Noise does not fit as PNG; it comes back as JPEG within the bound.
    expect(output.picture!.mimeType).toBe('image/jpeg');
    expect(output.picture!.dataUrl.length).toBeLessThanOrEqual(SCREENSHOT_MAX_DATA_URL_CHARS);
    const result = {
      executionId: 'execution',
      exitCode: 0,
      signal: null,
      canceled: false,
      termination: 'natural',
      durationMs: 675,
      outputBytes: Buffer.byteLength(output.stdout),
      stdout: output.stdout,
      stderr: 'w'.repeat(4096),
      truncated: false,
      picture: SCREENSHOT_PICTURE_UNAVAILABLE,
    };
    const toModel = screenshotToolResultFor(
      result,
      output.picture,
      true,
      RUNTIME_TOOL_RESULT_MAX_BYTES - 64 * 1024,
    ) as Record<string, unknown>;
    expect(toModel['dataUrl']).toBe(output.picture!.dataUrl);
    const envelope = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 3,
      operationId: 'operation-1',
      type: 'tool_result',
      callId: 'call-1',
      success: true,
      output: toModel,
    };
    expect(isMainToRuntimeEnvelope(envelope)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(
      RUNTIME_TOOL_RESULT_MAX_BYTES - 64 * 1024,
    );
  }, 60_000);
});

describe('giving the picture to the model', () => {
  const picture = {
    mimeType: 'image/png' as const,
    dataUrl: 'data:image/png;base64,QUFB',
    byteLength: 3,
    sha256: 'a'.repeat(64),
  };
  const resultOf = (sha256 = 'a'.repeat(64)) => ({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, command: 'screenshot', data: { sha256 } }),
    picture: SCREENSHOT_PICTURE_UNAVAILABLE,
  });

  it('adds the picture for a connection that takes images, from a copy of the result', () => {
    // What reaches Main may be a copy of the object the command tool made.
    const result = JSON.parse(JSON.stringify(resultOf())) as ReturnType<typeof resultOf>;
    expect(isScreenshotToolResult(result)).toBe(true);
    expect(screenshotToolResultFor(result, picture, true, RUNTIME_TOOL_RESULT_MAX_BYTES)).toEqual({
      ...result,
      picture: SCREENSHOT_PICTURE_ATTACHED,
      mimeType: 'image/png',
      byteLength: 3,
      sha256: 'a'.repeat(64),
      dataUrl: 'data:image/png;base64,QUFB',
    });
  });

  it('holds a picture beside its call until it is taken, once, or its Turn ends', () => {
    vi.useFakeTimers();
    try {
      const key = screenshotCallKey('task', 'turn', 'call');
      holdScreenshotPicture(key, picture);
      expect(takeScreenshotPicture(screenshotCallKey('task', 'turn', 'other'))).toBeUndefined();
      // No clock decides it: a call whose result waits for an earlier one keeps its picture.
      vi.advanceTimersByTime(3_600_000);
      expect(takeScreenshotPicture(key)).toBe(picture);
      expect(takeScreenshotPicture(key)).toBeUndefined();
      holdScreenshotPicture(key, picture);
      holdScreenshotPicture(screenshotCallKey('task', 'other-turn', 'call'), picture);
      releaseScreenshotPicturesForTurn('task', 'turn');
      expect(takeScreenshotPicture(key)).toBeUndefined();
      expect(heldScreenshotPictureCount()).toBe(1);
      releaseScreenshotPicturesForTurn('task', 'other-turn');
      expect(heldScreenshotPictureCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a connection without images, another picture, or a result too large, with the sentence only', () => {
    const plain = resultOf();
    expect(screenshotToolResultFor(plain, picture, false, RUNTIME_TOOL_RESULT_MAX_BYTES)).toBe(
      plain,
    );
    expect(plain.picture).toBe(
      'この接続では、撮った画像を AI に渡せない。画面の中身を確かめる時は snapshot を使う。',
    );
    const otherPicture = resultOf('b'.repeat(64));
    expect(
      screenshotToolResultFor(otherPicture, picture, true, RUNTIME_TOOL_RESULT_MAX_BYTES),
    ).toBe(otherPicture);
    expect(screenshotToolResultFor(plain, undefined, true, RUNTIME_TOOL_RESULT_MAX_BYTES)).toBe(
      plain,
    );
    expect(screenshotToolResultFor(plain, picture, true, 64)).toBe(plain);
    // Any other result passes untouched.
    const other = { stdout: 'x' };
    expect(isScreenshotToolResult(other)).toBe(false);
    expect(screenshotToolResultFor(other, picture, true, RUNTIME_TOOL_RESULT_MAX_BYTES)).toBe(
      other,
    );
  });
});

describe('which Turn models take the picture', () => {
  type Value = boolean | null;
  const catalogOf = (connections: Record<string, Record<string, Value>>) => ({
    find: (connectionId: string, modelId: string) => {
      const value = connections[connectionId]?.[modelId];
      return value === undefined ? undefined : { modelId, multimodalInput: { value } };
    },
    list: (connectionId: string) =>
      Object.entries(connections[connectionId] ?? {}).map(([modelId, value]) => ({
        modelId,
        multimodalInput: { value },
      })),
  });
  const identity = (
    connectionId: string | null,
    requested: string | null,
    resolved: string | null = null,
  ) => ({
    selection: { connectionId, requestedModel: requested },
    resolution: { resolvedModel: resolved },
  });
  // As the Codex CLI catalog lists them: `auto` unknown, each listed model from model/list.
  const allImages = catalogOf({ codex: { auto: null, 'gpt-a': true, 'gpt-b': true } });
  const oneUnknown = catalogOf({ codex: { auto: null, 'gpt-a': true, 'gpt-b': null } });
  const oneTextOnly = catalogOf({ codex: { auto: null, 'gpt-a': true, 'gpt-b': false } });
  const onlyAuto = catalogOf({ codex: { auto: null } });

  it('gives the automatic choice the picture when every listed model takes images', () => {
    expect(turnModelTakesPictures(identity('codex', 'auto'), allImages)).toBe(true);
  });

  it('gives the automatic choice none when a listed model is unknown, text-only, or none is listed', () => {
    expect(turnModelTakesPictures(identity('codex', 'auto'), oneUnknown)).toBe(false);
    expect(turnModelTakesPictures(identity('codex', 'auto'), oneTextOnly)).toBe(false);
    expect(turnModelTakesPictures(identity('codex', 'auto'), onlyAuto)).toBe(false);
  });

  it('follows an automatic choice the catalog itself says takes images (the Claude CLI)', () => {
    const claude = catalogOf({ claude: { auto: true, sonnet: true } });
    expect(turnModelTakesPictures(identity('claude', 'auto'), claude)).toBe(true);
  });

  it('judges an explicit model by its own entry', () => {
    expect(turnModelTakesPictures(identity('codex', 'gpt-a'), oneTextOnly)).toBe(true);
    expect(turnModelTakesPictures(identity('codex', 'gpt-b'), oneTextOnly)).toBe(false);
    expect(turnModelTakesPictures(identity('codex', 'gpt-b'), oneUnknown)).toBe(false);
    expect(turnModelTakesPictures(identity('codex', 'gone'), allImages)).toBe(false);
    expect(turnModelTakesPictures(identity(null, null), allImages)).toBe(false);
  });

  it('lets a recorded resolved model decide', () => {
    expect(turnModelTakesPictures(identity('codex', 'auto', 'gpt-b'), oneTextOnly)).toBe(false);
    expect(turnModelTakesPictures(identity('codex', 'auto', 'gpt-a'), oneTextOnly)).toBe(true);
  });
});

const owner = {
  taskId: 'task-screenshot',
  turnId: 'turn-screenshot',
  workspaceId: 'workspace-screenshot',
  policyEpoch: 1,
};

/**
 * `exec_command` over a runner that prints `printed` in 64 KiB chunks for a screenshot, with a
 * store that records what it is given.
 */
async function setUp(printed: string, withSessions: boolean) {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-screenshot-'));
  roots.push(workspace);
  const rows = new Map<string, { state: string; outputBytes: number }>();
  const stored: CommandOutputChunk[] = [];
  const completed: Array<{ outputBytes: number; truncated: boolean; state: string }> = [];
  const published: unknown[] = [];
  let storeFails = false;
  const boundary = {
    persistence: {
      readTurnWorkspaceSet: () => ({
        source: 'task' as const,
        projectId: null,
        primaryRootId: 'root-a',
        roots: [
          {
            rootId: 'root-a',
            path: workspace,
            label: 'Workspace',
            role: 'primary' as const,
            status: 'available' as const,
          },
        ],
        digest: 'a'.repeat(64),
      }),
      getTurnWorkspaceRootIdentities: () => new Map(),
      prepareCommand: (input: { id: string }) => {
        rows.set(input.id, { state: 'prepared', outputBytes: 0 });
        return { id: input.id } as never;
      },
      beginCommand: (id: string) => {
        rows.get(id)!.state = 'starting';
        return { id } as never;
      },
      startCommand: ({ commandId }: { commandId: string }) => {
        rows.get(commandId)!.state = 'running';
        return { command: {} as never, event: { type: 'command.started' } as never };
      },
      appendCommandOutputBatch: ({ chunks }: { chunks: CommandOutputChunk[] }) => {
        if (storeFails) throw new Error('store failed');
        stored.push(...chunks);
        return chunks.map((chunk) => ({ type: 'command.output', text: chunk.text }) as never);
      },
      completeCommand: (input: {
        commandId: string;
        state: string;
        outputBytes: number;
        truncated: boolean;
      }) => {
        completed.push(input);
        rows.get(input.commandId)!.state = input.state;
        return { command: {} as never, event: { type: 'command.completed' } as never };
      },
      getCommand: (id: string) => ({ id, ...rows.get(id)! }) as never,
      createBackgroundActivity: () => ({}) as never,
      transitionBackgroundActivity: () => ({}) as never,
      completeBackgroundActivity: () => ({}) as never,
    },
    publish: (event: unknown) => published.push(event),
  } as unknown as CommandToolBoundary;
  const runner = new CommandRunner({ sandboxed: true });
  vi.spyOn(runner, 'run').mockImplementation(async (_spec, options: RunOptions = {}) => {
    expect(options.privateScreenshotOutput === true).toBe(isDesktopControlScreenshot(_spec.argv));
    options.beforeSpawn?.();
    options.onStarted?.({
      executionId: 'execution',
      pid: 1,
      startedAt: Date.now(),
      processStartIdentity: 'identity',
      executionImageDigest: 'a'.repeat(64),
      executionImageIdentity: 'identity',
    });
    const chunks: CommandOutputChunk[] = [];
    for (let offset = 0, seq = 1; offset < printed.length; offset += 65_536, seq += 1) {
      const text = printed.slice(offset, offset + 65_536);
      chunks.push({ seq, stream: 'stdout', text, byteLength: Buffer.byteLength(text) });
    }
    await options.onBatch?.(chunks);
    return {
      executionId: 'execution',
      exitCode: 0,
      signal: null,
      canceled: false,
      termination: 'natural',
      durationMs: 675,
      outputBytes: Buffer.byteLength(printed),
      truncated: false,
    };
  });
  const registry = new ToolRegistry();
  registry.register(MANAGED_EXEC_COMMAND_TOOL);
  const broker = new ToolBroker(
    registry,
    () => 1,
    () => ({
      decision: 'allow' as const,
      reason: 'test',
      beforeExecute: () => true,
      approvalDecision: 'allow_once' as const,
    }),
  );
  const sessions = withSessions ? new ManagedCommandSessions(runner) : undefined;
  registerCommandRunnerTool(broker, runner, boundary, MANAGED_EXEC_COMMAND_TOOL, sessions, 50);
  broker.startTurn(owner, 'codex');
  vi.spyOn(desktopControlModule, 'isDesktopControlExecutable').mockReturnValue(true);
  let lastCallId = '';
  const dispatch = (argv: string[], background?: boolean) =>
    broker.dispatch({
      ...owner,
      callId: (lastCallId = `call-${Math.random()}`),
      providerName: 'exec_command',
      input: {
        executable: process.execPath,
        argv,
        purpose: 'screenshot',
        ...(background === undefined ? {} : { background }),
      },
    });
  const failStore = () => {
    storeFails = true;
  };
  const lastCallKey = () => screenshotCallKey(owner.taskId, owner.turnId, lastCallId);
  return { dispatch, stored, completed, published, sessions, failStore, lastCallKey };
}

describe('a screenshot run through exec_command', () => {
  it.each([true, false])(
    'stores and shows only what the picture is, and holds the picture for the model (sessions: %s)',
    async (withSessions) => {
      const png = await flatPng(3352, 2006);
      const printed = printedFor(png);
      const harness = await setUp(printed, withSessions);
      const result = (await harness.dispatch(['screenshot', '--window-id', 'w-1'])) as Record<
        string,
        unknown
      >;
      // Stored and shown: one chunk of metadata, nothing of the picture.
      expect(harness.stored).toHaveLength(1);
      expect(harness.stored[0]).toMatchObject({ seq: 1, stream: 'stdout' });
      const shown = JSON.stringify([harness.stored, harness.published]);
      expect(shown).not.toContain(png.toString('base64').slice(100, 160));
      expect(shown).not.toContain(png.toString('base64').slice(0, 64));
      expect(shown).not.toContain('iVBORw0KGgo');
      expect(dataOf(harness.stored[0]!.text)).toMatchObject({
        format: 'png',
        width: SCREENSHOT_MAX_EDGE,
        source_width: 3352,
        scale_factor: 2,
      });
      expect(harness.completed.at(-1)).toMatchObject({
        state: 'exited',
        truncated: false,
        outputBytes: harness.stored[0]!.byteLength,
      });
      // The tool result: the same metadata, the no-picture sentence, and the picture beside it.
      expect(result['stdout']).toBe(harness.stored[0]!.text);
      expect(result['picture']).toBe(SCREENSHOT_PICTURE_UNAVAILABLE);
      expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo');
      const held = takeScreenshotPicture(harness.lastCallKey());
      expect(held?.mimeType).toBe('image/png');
      expect(held?.sha256).toBe(dataOf(harness.stored[0]!.text)['sha256']);
      await harness.sessions?.dispose();
    },
    60_000,
  );

  it('leaves nothing of the printed picture in the session store', async () => {
    const png = await flatPng(600, 400);
    const harness = await setUp(printedFor(png), true);
    await harness.dispatch(['screenshot', '--window-id', 'w-1']);
    const kept = (
      harness.sessions as unknown as { sessions: Map<string, { chunks: CommandOutputChunk[] }> }
    ).sessions;
    expect(kept.size).toBeGreaterThan(0);
    for (const session of kept.values()) expect(session.chunks).toEqual([]);
    expect(JSON.stringify([...kept.values()].map(({ chunks }) => chunks))).not.toContain(
      'iVBORw0KGgo',
    );
    await harness.sessions?.dispose();
  });

  it('ends the record as failed when storing the screenshot fails', async () => {
    const harness = await setUp(printedFor(await flatPng(20, 10)), true);
    harness.failStore();
    await expect(harness.dispatch(['screenshot', '--window-id', 'w-1'])).rejects.toThrow(
      'store failed',
    );
    expect(harness.completed.at(-1)).toMatchObject({ state: 'failed', outputBytes: 0 });
    await harness.sessions?.dispose();
  });

  it('refuses a screenshot in the background before any card', async () => {
    const harness = await setUp('', true);
    await expect(harness.dispatch(['screenshot', '--window-id', 'w-1'], true)).rejects.toThrow(
      'screenshot は background では実行できない',
    );
    expect(harness.completed).toEqual([]);
    await harness.sessions?.dispose();
  });

  it('keeps another desktop-control run as it was', async () => {
    const printedText = JSON.stringify({ ok: true, command: 'snapshot', data: { tree: [] } });
    const harness = await setUp(printedText, false);
    const result = (await harness.dispatch(['snapshot', '--window-id', 'w-1'])) as Record<
      string,
      unknown
    >;
    expect(result['stdout']).toBe(printedText);
    expect(result).not.toHaveProperty('picture');
    expect(harness.stored.map(({ text }) => text).join('')).toBe(printedText);
  });
});
