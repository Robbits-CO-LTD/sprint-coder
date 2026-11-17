// A desktop-control screenshot of a primary Codex CLI Turn, the whole way Main takes it: the
// runtime host's `tool_request` as the Codex runtime sends it, the RuntimeHostClient's handler,
// Main's own handler for the Codex runtime (`createGenericManagedRuntimeToolHandlers().codexRuntime`),
// its managed dispatch, the ToolBroker and the managed `exec_command` with its command sessions,
// and back: the `tool_result` Main posts, through the IPC's JSON, into the Codex adapter's own
// conversion to the dynamic-tool response the CLI gets.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@sprint-coder/domain';

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

import { IpcRouter } from './ipc';
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
} from './desktop-control-screenshot';
import { codexDynamicToolResponseFromManaged } from '../runtime-host/codex-adapter';
import { RUNTIME_TOOL_RESULT_MAX_BYTES } from '../runtime-host/protocol';

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
  options: { cloneResult?: boolean; catalogBuilt?: boolean } = {},
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
  const toolCatalog = broker.startTurn(turn, 'codex');
  const catalog = { revision: options.catalogBuilt === false ? 0 : 1 };
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
    // Not built yet in this app run (nothing opened the model picker) unless asked otherwise.
    refreshModelCatalog: async () => {
      catalog.revision = 1;
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
    // The adapter's own conversion, given what the runtime host resolves the call with.
    return codexDynamicToolResponseFromManaged({
      success: posted!.success,
      output: posted!.output,
    });
  };
  return { call, client, sessions, stored, catalog };
}

/**
 * The value a nested dynamic tool call gives a Codex exec script: the response's items joined with
 * newlines, a text item as its text and an image item as its URL. Observed with the installed
 * codex-cli 0.153.4 (code mode, model metadata `tool_mode: code_mode_only`) answering a probe
 * script, for text + image, image alone and text alone, with a 661 KB data URL passed whole.
 */
function codexCodeModeNestedResult(
  items: ReturnType<typeof codexDynamicToolResponseFromManaged>['contentItems'],
): string {
  return items.map((item) => (item.type === 'inputText' ? item.text : item.imageUrl)).join('\n');
}

describe('a primary Codex CLI Turn’s screenshot, through Main’s real handler', () => {
  it.each([false, true])(
    'reaches the Codex adapter as an image beside its metadata and sentence (cursors on: %s)',
    async (cursors) => {
      const { call, client, sessions, stored } = await setUp(true, cursors);
      const response = await call(['screenshot', '--window-id', 'w-1']);
      expect(response.success).toBe(true);
      expect(response.contentItems).toHaveLength(2);
      const [text, image] = response.contentItems;
      expect(image).toMatchObject({ type: 'inputImage' });
      expect((image as { imageUrl: string }).imageUrl).toMatch(/^data:image\/png;base64,/u);
      expect(text?.type).toBe('inputText');
      const shown = JSON.parse((text as { text: string }).text) as Record<string, unknown>;
      expect(shown['picture']).toBe(SCREENSHOT_PICTURE_ATTACHED);
      expect(shown['stdout']).toBe(stored.at(-1)!.text);
      expect(JSON.stringify(stored)).not.toContain('base64');

      // What a script inside Codex's exec receives for the same response (probed against the
      // installed codex-cli 0.153.4 with a local stand-in for the model): one string, the items
      // in order, one per line, an image as its data URL; and the steps the host guidance gives.
      const nested = codexCodeModeNestedResult(response.contentItems);
      expect(nested.length).toBeLessThan(RUNTIME_TOOL_RESULT_MAX_BYTES);
      const cut = nested.indexOf('\n');
      const firstLine = JSON.parse(nested.slice(0, cut)) as Record<string, unknown>;
      const url = nested.slice(cut + 1);
      expect(url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u);
      expect(url.length).toBe(firstLine['pictureChars']);
      expect(url).toBe((image as { imageUrl: string }).imageUrl);
      expect(firstLine['picture']).toBe(SCREENSHOT_PICTURE_ATTACHED);
      expect(Buffer.from(url.split(',')[1]!, 'base64').byteLength).toBe(firstLine['byteLength']);
      client.dispose();
      await sessions.dispose();
    },
    30_000,
  );

  it.each([
    ['a copy of the result', { cloneResult: true }],
    ['a model catalog not built yet', { catalogBuilt: false }],
  ] as const)(
    'still reaches the adapter as an image from %s',
    async (_name, options) => {
      const { call, client, sessions, catalog } = await setUp(true, false, options);
      const response = await call(['screenshot', '--window-id', 'w-1']);
      expect(response.contentItems.map(({ type }) => type)).toEqual(['inputText', 'inputImage']);
      const shown = JSON.parse((response.contentItems[0] as { text: string }).text) as Record<
        string,
        unknown
      >;
      expect(shown['picture']).toBe(SCREENSHOT_PICTURE_ATTACHED);
      expect(catalog.revision).toBe(1);
      expect(heldScreenshotPictureCount()).toBe(0);
      client.dispose();
      await sessions.dispose();
    },
    30_000,
  );

  it.each([false, null])(
    'gives a model that does not take images (%s) only the sentence',
    async (takesImages) => {
      const { call, client, sessions } = await setUp(takesImages, false);
      const response = await call(['screenshot', '--window-id', 'w-1']);
      expect(response.contentItems).toHaveLength(1);
      const shown = JSON.parse((response.contentItems[0] as { text: string }).text) as Record<
        string,
        unknown
      >;
      expect(shown['picture']).toBe(SCREENSHOT_PICTURE_UNAVAILABLE);
      expect(shown).not.toHaveProperty('dataUrl');
      client.dispose();
      await sessions.dispose();
    },
    30_000,
  );
});
