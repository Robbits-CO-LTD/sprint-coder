// A desktop-control screenshot of a primary Codex CLI Turn, the whole way Main takes it: the
// runtime host's `tool_request` as the Codex runtime sends it, the RuntimeHostClient's handler,
// Main's own handler for the Codex runtime (`createGenericManagedRuntimeToolHandlers().codexRuntime`),
// its managed dispatch, the ToolBroker and the managed `exec_command` with its command sessions,
// and back: the `tool_result` Main posts, through the IPC's JSON, into the Codex adapter's own
// conversion to the dynamic-tool response the CLI gets and the message it adds to the thread.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, createToolDefinition, createToolId } from '@sprint-coder/domain';

class FakeUtilityProcess extends EventEmitter {
  readonly messages: unknown[] = [];
  readonly kill = vi.fn();

  postMessage(message: unknown): void {
    // What crosses to the runtime host is what survives its serialization.
    this.messages.push(JSON.parse(JSON.stringify(message)));
  }
}

const children = vi.hoisted(() => [] as unknown[]);

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    utilityProcess: {
      fork: vi.fn(() => {
        const child = new FakeUtilityProcess();
        children.push(child);
        return child;
      }),
    },
  };
});

import { IpcRouter, SCREENSHOT_CATALOG_TIMEOUT_MS } from './ipc';
import { RuntimeHostClient } from './runtime-host';
import { ToolBroker } from './tool-broker';
import {
  MANAGED_EXEC_COMMAND_TOOL,
  registerCommandRunnerTool,
  type CommandToolBoundary,
} from './default-tools';
import { CommandRunner, type CommandOutputChunk, type RunOptions } from './command-runner';
import { ManagedCommandSessions } from './managed-command-sessions';
import * as desktopControlModule from './desktop-control';
import { configureDesktopControlTeamCursors } from './desktop-control-session';
import {
  SCREENSHOT_PICTURE_ATTACHED,
  SCREENSHOT_PICTURE_UNAVAILABLE,
  heldScreenshotPictureCount,
  holdScreenshotPicture,
  releaseScreenshotPicturesForTurn,
  screenshotCallKey,
} from './desktop-control-screenshot';
import {
  CODEX_PICTURE_FOLLOWS,
  codexDynamicToolResponseFromManaged,
  codexManagedPictureItem,
} from '../runtime-host/codex-adapter';
import { RUNTIME_TOOL_RESULT_MAX_BYTES } from '../runtime-host/protocol';

const SLOW_TOOL = createToolDefinition({
  toolId: createToolId({ provider: 'builtin', namespace: 'test', name: 'slow', version: '1' }),
  providerName: 'slow_probe',
  kind: 'fileRead',
  schemaVersion: 1,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  sideEffect: 'read',
  risk: 'low',
  requiredCapabilities: ['workspace.read'],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 1,
  workspaceBinding: { kind: 'any' },
  providerCompatibility: ['*'],
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  configureDesktopControlTeamCursors(false);
  children.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const turn = { taskId: 'task-1', turnId: 'turn-1', workspaceId: 'workspace-1', policyEpoch: 1 };

async function setUp(
  modelTakesImages: boolean | null,
  cursors: boolean,
  options: {
    cloneResult?: boolean;
    catalogBuilt?: boolean;
    probe?: () => Promise<unknown>;
  } = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-screenshot-chain-'));
  roots.push(workspace);
  const png = await sharp({
    create: { width: 552, height: 908, channels: 3, background: { r: 40, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
  const printed = JSON.stringify({
    version: '2.6',
    ok: true,
    command: 'screenshot',
    data: { data: png.toString('base64'), format: 'png', width: 552, height: 908, scale_factor: 2 },
  });
  const runner = new CommandRunner({ sandboxed: true });
  vi.spyOn(runner, 'run').mockImplementation(async (spec, options: RunOptions = {}) => {
    options.beforeSpawn?.();
    options.onStarted?.({
      executionId: 'execution',
      pid: 1,
      startedAt: Date.now(),
      processStartIdentity: 'identity',
      executionImageDigest: 'a'.repeat(64),
      executionImageIdentity: 'identity',
    });
    const text =
      spec.argv[0] === 'screenshot'
        ? printed
        : spec.argv[1] === 'start'
          ? JSON.stringify({ ok: true, data: { session_id: 'run-1' } })
          : JSON.stringify({ ok: true, data: {} });
    const chunks: CommandOutputChunk[] = [];
    for (let offset = 0, seq = 1; offset < text.length; offset += 65_536, seq += 1) {
      const part = text.slice(offset, offset + 65_536);
      chunks.push({ seq, stream: 'stdout', text: part, byteLength: Buffer.byteLength(part) });
    }
    await options.onBatch?.(chunks);
    return {
      executionId: 'execution',
      exitCode: 0,
      signal: null,
      canceled: false,
      termination: 'natural',
      durationMs: 600,
      outputBytes: Buffer.byteLength(text),
      truncated: false,
    };
  });
  const rows = new Map<string, string>();
  const stored: CommandOutputChunk[] = [];
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
        rows.set(input.id, 'prepared');
        return { id: input.id } as never;
      },
      beginCommand: (id: string) => {
        rows.set(id, 'starting');
        return { id } as never;
      },
      startCommand: ({ commandId }: { commandId: string }) => {
        rows.set(commandId, 'running');
        return { command: {} as never, event: {} as never };
      },
      appendCommandOutputBatch: ({ chunks }: { chunks: CommandOutputChunk[] }) => {
        stored.push(...chunks);
        return [];
      },
      completeCommand: (input: { commandId: string; state: string }) => {
        rows.set(input.commandId, input.state);
        return { command: {} as never, event: {} as never };
      },
      getCommand: (id: string) => ({ id, state: rows.get(id), outputBytes: 0 }) as never,
      createBackgroundActivity: () => ({}) as never,
      transitionBackgroundActivity: () => ({}) as never,
      completeBackgroundActivity: () => ({}) as never,
    },
    publish: () => undefined,
  } as unknown as CommandToolBoundary;
  const registry = new ToolRegistry();
  registry.register(MANAGED_EXEC_COMMAND_TOOL);
  // A call of the same Turn whose result is held until the test lets it go (an approval card
  // answered late, for one): the ToolBroker returns later calls' results only after it.
  registry.register(SLOW_TOOL);
  const broker = new ToolBroker(
    registry,
    () => 1,
    () => ({
      decision: 'allow',
      reason: 'test',
      beforeExecute: () => true,
      approvalDecision: 'allow_once',
    }),
  );
  // Code Main does not control may hand on a copy of the result instead of the object itself.
  if (options.cloneResult === true) {
    const dispatch = broker.dispatch.bind(broker);
    vi.spyOn(broker, 'dispatch').mockImplementation(
      async (...args: Parameters<typeof broker.dispatch>) =>
        JSON.parse(JSON.stringify(await dispatch(...args))) as unknown,
    );
  }
  const sessions = new ManagedCommandSessions(runner);
  registerCommandRunnerTool(broker, runner, boundary, MANAGED_EXEC_COMMAND_TOOL, sessions, 10_000);
  let releaseSlow = (): void => undefined;
  broker.registerImplementation({
    toolId: SLOW_TOOL.toolId,
    implementationKind: 'built-in',
    execute: () =>
      new Promise((resolve) => {
        releaseSlow = () => resolve({ ok: true });
      }),
  });
  const toolCatalog = broker.startTurn(turn, 'codex');
  const catalog = { revision: options.catalogBuilt === false ? 0 : 1 };
  const refreshModelCatalog = vi.fn(async () => {
    catalog.revision = 1;
  });
  vi.spyOn(desktopControlModule, 'isDesktopControlExecutable').mockReturnValue(true);
  configureDesktopControlTeamCursors(cursors);

  // Main's own router, with only what this path reads.
  const models = [
    { modelId: 'auto', multimodalInput: { value: null } },
    { modelId: 'gpt-5.6-terra', multimodalInput: { value: modelTakesImages } },
  ];
  const router = Object.create(IpcRouter.prototype) as Record<string, unknown> & {
    createGenericManagedRuntimeToolHandlers(): {
      codexRuntime: ConstructorParameters<typeof RuntimeHostClient>[7];
    };
  };
  Object.assign(router, {
    managedWorkerTurn: new Map(),
    managedWorkerCall: new Map(),
    managedCodingHarness: { broker },
    persistence: {
      readTurnWorkspaceSetForTask: () => null,
      getTurnModelIdentity: () => ({
        selection: {
          connectionId: 'builtin:codex-cli',
          requestedProvider: 'openai',
          requestedModel: 'gpt-5.6-terra',
        },
        resolution: { resolvedProvider: null, resolvedModel: null },
      }),
    },
    // Not built yet in this app run (nothing opened the model picker) unless asked otherwise. A
    // screenshot never builds it: that would ask every external Provider for its models.
    refreshModelCatalog,
    codexRuntime: {
      probe:
        options.probe ??
        (async () => ({
          models: models.map(({ modelId, multimodalInput }) => ({
            id: modelId,
            capabilities: { multimodalInput },
          })),
        })),
    },
    modelCatalog: {
      get revision() {
        return catalog.revision;
      },
      find: (connectionId: string, modelId: string) =>
        connectionId === 'builtin:codex-cli'
          ? models.find((model) => model.modelId === modelId)
          : undefined,
      list: (connectionId: string) => (connectionId === 'builtin:codex-cli' ? models : []),
    },
  });
  const handlers = router.createGenericManagedRuntimeToolHandlers();

  const client = new RuntimeHostClient(
    vi.fn(),
    vi.fn(),
    undefined,
    undefined,
    'codex',
    undefined,
    undefined,
    handlers.codexRuntime,
  );
  const child = children[0] as FakeUtilityProcess;
  child.emit('spawn');
  client.start(turn.taskId, turn.turnId, 'look at the window', null, 'gpt-5.6-terra', toolCatalog);
  await Promise.resolve();
  const start = child.messages.find(
    (message) => (message as { type?: unknown }).type === 'start',
  ) as Record<string, unknown>;
  const envelope = {
    protocolVersion: start['protocolVersion'],
    runtimeInstanceId: start['runtimeInstanceId'],
    taskId: start['taskId'],
    turnId: start['turnId'],
    operationId: start['operationId'],
  };
  child.emit('message', {
    ...envelope,
    seq: 1,
    type: 'started',
    acceptedContextFragmentIds: [],
    acceptedProjectItemIds: [],
    acceptedProjectSnapshotDigest: null,
    acceptedPayloadDigest: start['payloadDigest'],
  });

  /** The Codex runtime's call of `sprint_exec_command`, as its tool_request reaches Main. */
  const call = async (argv: string[]) => {
    child.emit('message', {
      ...envelope,
      seq: 2,
      type: 'tool_request',
      request: {
        callId: 'call-screenshot',
        toolName: 'exec_command',
        arguments: { executable: process.execPath, argv, purpose: 'look at the window' },
        catalogDigest: toolCatalog.digest,
      },
    });
    let posted: { success: boolean; output: unknown } | undefined;
    await vi.waitFor(
      () => {
        posted = child.messages.find(
          (message) => (message as { type?: unknown }).type === 'tool_result',
        ) as typeof posted;
        expect(posted).toBeDefined();
      },
      { timeout: 20_000 },
    );
    // The adapter's own conversion, given what the runtime host resolves the call with: the
    // message it adds to the Turn's thread, and its answer once Codex has taken that message.
    const managed = { success: posted!.success, output: posted!.output };
    const picture = codexManagedPictureItem(managed);
    return {
      picture,
      response: codexDynamicToolResponseFromManaged(
        managed,
        picture !== undefined ? 'given' : 'not_given',
      ),
    };
  };
  /** A call as the Codex runtime's request reaches Main's own handler, without the runtime host. */
  const dispatch = (callId: string, toolName: string, args: unknown) =>
    handlers.codexRuntime!(
      turn.taskId,
      turn.turnId,
      { callId, toolName, arguments: args, catalogDigest: toolCatalog.digest },
      new AbortController().signal,
    );
  return {
    call,
    client,
    sessions,
    stored,
    catalog,
    refreshModelCatalog,
    dispatch,
    releaseSlow: () => releaseSlow(),
    png,
  };
}

/** The picture a message the Codex adapter adds to the thread carries, and that message's label. */
function injectedPicture(item: Record<string, unknown> | undefined): {
  label: string;
  dataUrl: string;
} {
  const content = (item?.['content'] ?? []) as Array<Record<string, unknown>>;
  expect(item).toMatchObject({ type: 'message', role: 'user' });
  expect(content.map(({ type }) => type)).toEqual(['input_text', 'input_image']);
  return { label: content[0]!['text'] as string, dataUrl: content[1]!['image_url'] as string };
}

describe('a primary Codex CLI Turn’s screenshot, through Main’s real handler', () => {
  it.each([false, true])(
    'reaches the Codex thread as a message the host adds, and the call’s answer as text (cursors on: %s)',
    async (cursors) => {
      const { call, client, sessions, stored, png } = await setUp(true, cursors);
      const { response, picture } = await call(['screenshot', '--window-id', 'w-1']);
      expect(response.success).toBe(true);
      // The answer the model's script gets is text only: no picture to pass on, none to print.
      expect(response.contentItems.map(({ type }) => type)).toEqual(['inputText']);
      const shown = JSON.parse(response.contentItems[0]!.text) as Record<string, unknown>;
      expect(shown['picture']).toBe(CODEX_PICTURE_FOLLOWS);
      expect(shown['stdout']).toBe(stored.at(-1)!.text);
      expect(JSON.stringify(response)).not.toContain('base64');
      // The picture goes to the Turn's own thread, labelled with the digest the answer names.
      const { label, dataUrl } = injectedPicture(picture);
      expect(dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u);
      expect(dataUrl.length).toBeLessThan(RUNTIME_TOOL_RESULT_MAX_BYTES);
      expect(label).toContain(`sha256 ${String(shown['sha256'])}`);
      expect(Buffer.from(dataUrl.split(',')[1]!, 'base64').byteLength).toBe(shown['byteLength']);
      // Nothing of the picture is stored: neither the capture's own base64 nor any PNG's.
      const storedText = JSON.stringify(stored);
      expect(storedText).not.toContain(png.toString('base64').slice(0, 64));
      expect(storedText).not.toContain('iVBORw0KGgo');
      client.dispose();
      await sessions.dispose();
    },
    30_000,
  );

  it('keeps the picture while an earlier call of the Turn holds the result back past 120 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { dispatch, releaseSlow, client, sessions } = await setUp(true, false);
      const earlier = dispatch('call-earlier', 'slow_probe', {});
      const screenshot = dispatch('call-screenshot', 'exec_command', {
        executable: process.execPath,
        argv: ['screenshot', '--window-id', 'w-1'],
        purpose: 'look at the window',
      });
      // The screenshot ran and its picture is held, waiting for the earlier call's result.
      await vi.waitUntil(() => heldScreenshotPictureCount() === 1, { timeout: 20_000 });
      vi.advanceTimersByTime(130_000);
      expect(heldScreenshotPictureCount()).toBe(1);
      releaseSlow();
      await earlier;
      const result = (await screenshot) as Record<string, unknown>;
      expect(result['picture']).toBe(SCREENSHOT_PICTURE_ATTACHED);
      expect(result['dataUrl']).toMatch(/^data:image\/png;base64,/u);
      expect(heldScreenshotPictureCount()).toBe(0);
      client.dispose();
      await sessions.dispose();
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('holds no picture once its call has returned, and drops any left when the Turn ends', async () => {
    const { dispatch, client, sessions } = await setUp(true, false);
    await dispatch('call-screenshot', 'exec_command', {
      executable: process.execPath,
      argv: ['screenshot', '--window-id', 'w-1'],
      purpose: 'look at the window',
    });
    expect(heldScreenshotPictureCount()).toBe(0);
    holdScreenshotPicture(screenshotCallKey(turn.taskId, turn.turnId, 'never-taken'), {
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,QUFB',
      byteLength: 3,
      sha256: 'a'.repeat(64),
    });
    releaseScreenshotPicturesForTurn(turn.taskId, turn.turnId);
    expect(heldScreenshotPictureCount()).toBe(0);
    client.dispose();
    await sessions.dispose();
  }, 30_000);

  it.each([
    ['a copy of the result', { cloneResult: true }],
    ['a model catalog not built yet', { catalogBuilt: false }],
  ] as const)(
    'still reaches the Codex thread from %s',
    async (_name, options) => {
      const { call, client, sessions, catalog, refreshModelCatalog } = await setUp(
        true,
        false,
        options,
      );
      const { response, picture } = await call(['screenshot', '--window-id', 'w-1']);
      expect(response.contentItems.map(({ type }) => type)).toEqual(['inputText']);
      const shown = JSON.parse(response.contentItems[0]!.text) as Record<string, unknown>;
      expect(shown['picture']).toBe(CODEX_PICTURE_FOLLOWS);
      injectedPicture(picture);
      // Learned from the Turn's own CLI runtime: the catalog (and every external Provider's model
      // list with it) is not built for a screenshot.
      expect(refreshModelCatalog).not.toHaveBeenCalled();
      expect(catalog.revision).toBe('catalogBuilt' in options ? 0 : 1);
      expect(heldScreenshotPictureCount()).toBe(0);
      client.dispose();
      await sessions.dispose();
    },
    30_000,
  );

  it.each([
    ['fails', () => Promise.reject(new Error('probe failed'))],
    ['does not answer in time', () => new Promise<never>(() => undefined)],
  ] as const)(
    'gives only the sentence when the CLI’s model list %s and no catalog is built',
    async (_name, probe) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let asked = false;
        const { call, client, sessions, refreshModelCatalog } = await setUp(true, false, {
          catalogBuilt: false,
          probe: () => {
            asked = true;
            return probe();
          },
        });
        const answered = call(['screenshot', '--window-id', 'w-1']);
        await vi.waitUntil(() => asked, { timeout: 20_000 });
        await vi.advanceTimersByTimeAsync(SCREENSHOT_CATALOG_TIMEOUT_MS + 1);
        const { response, picture } = await answered;
        expect(picture).toBeUndefined();
        const shown = JSON.parse(response.contentItems[0]!.text) as Record<string, unknown>;
        expect(shown['picture']).toBe(SCREENSHOT_PICTURE_UNAVAILABLE);
        expect(shown).not.toHaveProperty('dataUrl');
        expect(refreshModelCatalog).not.toHaveBeenCalled();
        expect(heldScreenshotPictureCount()).toBe(0);
        client.dispose();
        await sessions.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
    30_000,
  );

  it.each([false, null])(
    'gives a model that does not take images (%s) only the sentence',
    async (takesImages) => {
      const { call, client, sessions } = await setUp(takesImages, false);
      const { response, picture } = await call(['screenshot', '--window-id', 'w-1']);
      expect(picture).toBeUndefined();
      expect(response.contentItems).toHaveLength(1);
      const shown = JSON.parse(response.contentItems[0]!.text) as Record<string, unknown>;
      expect(shown['picture']).toBe(SCREENSHOT_PICTURE_UNAVAILABLE);
      expect(shown).not.toHaveProperty('dataUrl');
      client.dispose();
      await sessions.dispose();
    },
    30_000,
  );
});
