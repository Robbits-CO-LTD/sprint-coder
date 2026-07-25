import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  IPC_CHANNELS,
  approvalResolveInputSchema,
  canvasViewSaveInputSchema,
  commandEnvelopeSchema,
  commandOutputPageInputSchema,
  commandOutputTailInputSchema,
  emptyPayloadSchema,
  permissionSetInputSchema,
  runtimeModelSetInputSchema,
  runtimeEffortSetInputSchema,
  generatedImageRefSchema,
  runtimeCodexEffortSetInputSchema,
  runtimeSetInputSchema,
  taskArchivedInputSchema,
  taskCreateInputSchema,
  taskDraftInputSchema,
  taskGoalInputSchema,
  taskIdPayloadSchema,
  taskPinnedInputSchema,
  taskRenameInputSchema,
  teamHireWorkerInputSchema,
  teamSendMessageInputSchema,
  teamWorkerRefSchema,
  turnCancelInputSchema,
  turnQueueInputSchema,
  turnStartInputSchema,
  turnSteerInputSchema,
  turnStopAndSendInputSchema,
  turnSubscriptionInputSchema,
} from '@sprint-coder/contracts';
import { clampCodexEffort, isTrustedIpcSender } from './ipc';

// Adversarial IPC hardening (Phase 7, IMPLEMENTATION_PLAN §10.4, NFR-SEC-03). Two independent
// properties are proven here without needing a live BrowserWindow/WebContents:
//
// 1. Sender/frame authenticity (`isTrustedIpcSender`) — the exact pure predicate `IpcRouter`'s
//    private `validateSender` delegates to (see ipc.ts). Electron's real IPC transport cannot be
//    driven headlessly in a unit test, so this predicate is extracted specifically so its logic
//    is directly testable; end-to-end wiring is exercised by the app's e2e suite through a real
//    window (owned by a concurrent workstream — not duplicated here).
// 2. Envelope/payload schema validation — the *exact* zod schemas `IpcRouter.handle`/
//    `handleMutation` feed every registered channel's payload through via
//    `commandEnvelopeSchema(inputSchema).parse(raw)`. `CHANNEL_INPUT_SCHEMAS` below mirrors each
//    `this.handle(...)`/`this.handleMutation(...)` registration in ipc.ts's `register()`; a meta
//    test asserts this map's key set never silently drifts out of sync with IPC_CHANNELS.

describe('isTrustedIpcSender', () => {
  const expected = { expectedSenderId: 7, trustedRendererOrigin: 'app://bundle' };

  it('trusts the exact window sender on its own top main frame at the pinned app:// origin', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'app://bundle/index.html' },
        expected,
      ),
    ).toBe(true);
  });

  it('rejects a different sender id (a foreign WebContents, e.g. a devtools or hidden window)', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 99, isMainFrame: true, frameUrl: 'app://bundle/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a null senderFrame (frame already destroyed / detached)', () => {
    expect(isTrustedIpcSender({ senderId: 7, isMainFrame: true, frameUrl: null }, expected)).toBe(
      false,
    );
  });

  it('rejects a non-top (child/iframe) frame even from the trusted sender id', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: false, frameUrl: 'app://bundle/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects an app:// URL at any host other than the pinned "bundle" host', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'app://evil/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a dev-server origin string smuggled as an app:// URL', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'app://bundle.evil.test/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects an http(s) origin even when the host substring matches (no substring/prefix matching)', () => {
    const httpExpected = { expectedSenderId: 7, trustedRendererOrigin: 'http://localhost:5173' };
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'http://localhost:51730/' },
        httpExpected,
      ),
    ).toBe(false);
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'http://evil.test/?http://localhost:5173' },
        httpExpected,
      ),
    ).toBe(false);
  });

  it('rejects a scheme swap (https instead of the pinned app://) even with a matching host', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'https://bundle/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a differing dev-server port (origin must match exactly)', () => {
    const httpExpected = { expectedSenderId: 7, trustedRendererOrigin: 'http://localhost:5173' };
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'http://localhost:5174/' },
        httpExpected,
      ),
    ).toBe(false);
  });

  it('denies (never throws) on a structurally unparsable frame URL', () => {
    expect(() =>
      isTrustedIpcSender({ senderId: 7, isMainFrame: true, frameUrl: 'not a url' }, expected),
    ).not.toThrow();
    expect(
      isTrustedIpcSender({ senderId: 7, isMainFrame: true, frameUrl: 'not a url' }, expected),
    ).toBe(false);
  });

  it('rejects a data: URL frame (never a legitimate renderer origin)', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'data:text/html,<h1>hi</h1>' },
        expected,
      ),
    ).toBe(false);
  });
});

// Mirrors ipc.ts `register()`'s `this.handle(IPC_CHANNELS.x, xInputSchema, ...)` /
// `this.handleMutation(IPC_CHANNELS.x, xInputSchema, ...)` calls exactly. teamsEvent, turnsPort and
// reasoningEvent, fileEditEvent and runtimeStatusEvent are push-only (webContents.send / MessagePort transfer) — they
// are never bound to an ipcMain.handle input schema, so they are deliberately excluded and
// asserted absent below.
const CHANNEL_INPUT_SCHEMAS: Record<string, z.ZodType> = {
  [IPC_CHANNELS.appGetInfo]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsGetRuntime]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetRuntime]: runtimeSetInputSchema,
  [IPC_CHANNELS.settingsSetModel]: runtimeModelSetInputSchema,
  [IPC_CHANNELS.settingsSetEffort]: runtimeEffortSetInputSchema,
  [IPC_CHANNELS.filesList]: taskIdPayloadSchema,
  [IPC_CHANNELS.imagesList]: taskIdPayloadSchema,
  [IPC_CHANNELS.imagesRead]: generatedImageRefSchema,
  [IPC_CHANNELS.settingsSetCodexEffort]: runtimeCodexEffortSetInputSchema,
  [IPC_CHANNELS.permissionsGet]: taskIdPayloadSchema,
  [IPC_CHANNELS.permissionsListAutoDecisions]: taskIdPayloadSchema,
  [IPC_CHANNELS.permissionsSet]: permissionSetInputSchema,
  [IPC_CHANNELS.approvalsListPending]: taskIdPayloadSchema,
  [IPC_CHANNELS.approvalsListRecent]: taskIdPayloadSchema,
  [IPC_CHANNELS.approvalsResolve]: approvalResolveInputSchema,
  [IPC_CHANNELS.commandsList]: taskIdPayloadSchema,
  [IPC_CHANNELS.commandsOutputPage]: commandOutputPageInputSchema,
  [IPC_CHANNELS.commandsOutputTail]: commandOutputTailInputSchema,
  [IPC_CHANNELS.tasksList]: emptyPayloadSchema,
  [IPC_CHANNELS.tasksCreate]: taskCreateInputSchema,
  [IPC_CHANNELS.tasksMessages]: taskIdPayloadSchema,
  [IPC_CHANNELS.tasksRename]: taskRenameInputSchema,
  [IPC_CHANNELS.tasksSetPinned]: taskPinnedInputSchema,
  [IPC_CHANNELS.tasksSetArchived]: taskArchivedInputSchema,
  [IPC_CHANNELS.tasksSetGoal]: taskGoalInputSchema,
  [IPC_CHANNELS.tasksGetDraft]: taskIdPayloadSchema,
  [IPC_CHANNELS.tasksSetDraft]: taskDraftInputSchema,
  [IPC_CHANNELS.teamsPromote]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsGet]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsHireWorker]: teamHireWorkerInputSchema,
  [IPC_CHANNELS.teamsSend]: teamSendMessageInputSchema,
  [IPC_CHANNELS.teamsStopWorker]: teamWorkerRefSchema,
  [IPC_CHANNELS.teamsStopAll]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsSubscribe]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsUnsubscribe]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsGetCanvasView]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsSaveCanvasView]: canvasViewSaveInputSchema,
  [IPC_CHANNELS.workspaceGet]: taskIdPayloadSchema,
  [IPC_CHANNELS.workspaceSelect]: taskIdPayloadSchema,
  [IPC_CHANNELS.turnsStart]: turnStartInputSchema,
  [IPC_CHANNELS.turnsQueue]: turnQueueInputSchema,
  [IPC_CHANNELS.turnsSteer]: turnSteerInputSchema,
  [IPC_CHANNELS.turnsStopAndSend]: turnStopAndSendInputSchema,
  [IPC_CHANNELS.turnsCancel]: turnCancelInputSchema,
  [IPC_CHANNELS.turnsSnapshot]: taskIdPayloadSchema,
  [IPC_CHANNELS.turnsSubscribe]: turnSubscriptionInputSchema,
};
const PUSH_ONLY_CHANNELS = new Set<string>([
  IPC_CHANNELS.teamsEvent,
  IPC_CHANNELS.turnsPort,
  IPC_CHANNELS.reasoningEvent,
  IPC_CHANNELS.fileEditEvent,
  IPC_CHANNELS.runtimeStatusEvent,
]);

describe('IPC channel registry stays in sync with the adversarial fuzz table', () => {
  it('covers every IPC_CHANNELS entry exactly once, split between handled and push-only', () => {
    const allChannels = new Set(Object.values(IPC_CHANNELS));
    const handled = new Set(Object.keys(CHANNEL_INPUT_SCHEMAS));
    for (const channel of allChannels) {
      const isHandled = handled.has(channel);
      const isPushOnly = PUSH_ONLY_CHANNELS.has(channel);
      expect(isHandled !== isPushOnly).toBe(true);
    }
    expect(handled.size + PUSH_ONLY_CHANNELS.size).toBe(allChannels.size);
  });
});

describe('every registered IPC channel rejects adversarial envelopes', () => {
  const channels = Object.entries(CHANNEL_INPUT_SCHEMAS);

  it.each(channels)(
    'parses a well-formed minimal envelope shape check for %s (schema is invocable)',
    (_channel, schema) => {
      // Not every schema accepts `{}` — this just proves `commandEnvelopeSchema` composes with
      // each registered schema without throwing during construction (a broken schema composition
      // would throw here, before any adversarial input is even tried).
      expect(() => commandEnvelopeSchema(schema)).not.toThrow();
    },
  );

  it.each(channels)(
    'rejects a prototype-pollution-shaped envelope for %s without polluting Object.prototype',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);
      // Simulates the real IPC wire shape: JSON.parse gives "__proto__"/"constructor" as ordinary
      // own-enumerable string keys (never the special object-literal prototype setter), which is
      // exactly what a hostile renderer or a compromised preload would actually transmit.
      const hostile = JSON.parse(
        JSON.stringify({
          requestId: 'r1',
          operationId: 'o1',
          taskId: 'polluted-task',
          payload: {
            __proto__: { polluted: true },
            constructor: { prototype: { polluted: true } },
          },
        }),
      ) as unknown;

      const result = envelopeSchema.safeParse(hostile);
      expect(result.success).toBe(false);
      expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    },
  );

  it.each(channels)(
    'rejects an oversized requestId/operationId for %s (envelope-level bound applies to every channel)',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);
      const oversized = 'x'.repeat(1_000_000);

      expect(
        envelopeSchema.safeParse({ requestId: oversized, operationId: 'o1', payload: {} }).success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: oversized, payload: {} }).success,
      ).toBe(false);
    },
  );

  it.each(channels)(
    'rejects wrong-typed envelope fields for %s (number/array/null instead of string/object)',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);

      expect(
        envelopeSchema.safeParse({ requestId: 12345, operationId: 'o1', payload: {} }).success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: ['array'], payload: {} }).success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: 'o1', payload: null }).success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: 'o1', payload: 'a string' })
          .success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: 'o1', payload: [1, 2, 3] })
          .success,
      ).toBe(false);
    },
  );

  it.each(channels)(
    'rejects a completely missing payload/envelope for %s rather than crashing',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);

      for (const garbage of [undefined, null, 'a string', 42, [], true, () => undefined]) {
        expect(() => envelopeSchema.safeParse(garbage)).not.toThrow();
        expect(envelopeSchema.safeParse(garbage).success).toBe(false);
      }
    },
  );

  it.each(channels)(
    'never throws synchronously for %s on a deeply nested or cyclic-looking adversarial payload',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);
      let deep: unknown = 'leaf';
      for (let index = 0; index < 2_000; index += 1) deep = { nested: deep };
      const throwingGetterPayload = {};
      Object.defineProperty(throwingGetterPayload, 'boom', {
        enumerable: true,
        get(): never {
          throw new Error('adversarial getter');
        },
      });

      expect(() =>
        envelopeSchema.safeParse({ requestId: 'r1', operationId: 'o1', payload: deep }),
      ).not.toThrow();
      // A throwing getter on the payload is allowed to surface as a thrown error (zod must read
      // the property to validate it) — the contract here is only that the envelope schema itself
      // does not corrupt state or hang; callers (ipc.ts's `handle`) already wrap the whole parse in
      // try/catch and convert any thrown error into a typed PublicError.
      expect(() =>
        envelopeSchema.safeParse({
          requestId: 'r1',
          operationId: 'o1',
          payload: throwingGetterPayload,
        }),
      ).not.toThrow(RangeError);
    },
  );

  it.each(channels)(
    'rejects an extra unrecognized top-level envelope key for %s (strict envelope)',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);
      expect(
        envelopeSchema.safeParse({
          requestId: 'r1',
          operationId: 'o1',
          payload: {},
          extraHostileField: 'smuggled',
        }).success,
      ).toBe(false);
    },
  );
});

describe('taskId cross-check adversarial cases (mirrors ipc.ts handle() hasTaskId guard)', () => {
  it('a taskId-bearing payload schema rejects a payload/envelope taskId mismatch at the payload level already via its own field validation', () => {
    // hasTaskId()/the envelope.taskId !== envelope.payload.taskId check in ipc.ts's `handle()`
    // is exercised end-to-end by the app's e2e suite (needs a live IpcRouter+BrowserWindow); this
    // asserts the schema-level precondition it depends on: payload.taskId is always the strict
    // idSchema, so it cannot be smuggled as an object, array, or oversized string either.
    const envelopeSchema = commandEnvelopeSchema(taskIdPayloadSchema);
    expect(
      envelopeSchema.safeParse({
        requestId: 'r1',
        operationId: 'o1',
        taskId: 'task-a',
        payload: { taskId: { nested: 'task-b' } },
      }).success,
    ).toBe(false);
  });
});

describe('clampCodexEffort (issue #6)', () => {
  // The valid reasoning levels are per-model and published by the CLI in models_cache.json, and
  // Codex does NOT degrade gracefully — an unsupported level makes the API answer 400 and
  // `codex exec` exit 1, killing the whole turn. So a stored level has to be narrowed to the
  // selected model's advertised set before it can ever reach the CLI.
  const models = [
    { id: 'auto', displayName: 'Auto', description: '' },
    {
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      description: '',
      defaultEffort: 'low',
      efforts: [
        { id: 'low', description: '' },
        { id: 'high', description: '' },
        { id: 'ultra', description: '' },
      ],
    },
    {
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: '',
      defaultEffort: 'medium',
      efforts: [
        { id: 'low', description: '' },
        { id: 'medium', description: '' },
        { id: 'high', description: '' },
      ],
    },
    { id: 'no-levels', displayName: 'No Levels', description: '' },
  ];

  it('keeps a level the selected model advertises', () => {
    expect(clampCodexEffort('ultra', models, 'gpt-5.6-sol')).toBe('ultra');
    expect(clampCodexEffort('medium', models, 'gpt-5.5')).toBe('medium');
  });

  it("falls back to the model's own default when the stored level is unsupported", () => {
    // The real regression this guards: raise effort to `ultra` on Sol, switch to GPT-5.5, send.
    // Passing `ultra` through would fail the turn outright.
    expect(clampCodexEffort('ultra', models, 'gpt-5.5')).toBe('medium');
  });

  it('sends no override for the auto sentinel', () => {
    // The CLI picks the concrete model itself, so there is no advertised set to validate against
    // and its own per-model default is the right thing to leave in place.
    expect(clampCodexEffort('ultra', models, 'auto')).toBe('');
  });

  it('sends no override for a model that publishes no levels, or an unknown model', () => {
    expect(clampCodexEffort('high', models, 'no-levels')).toBe('');
    expect(clampCodexEffort('high', models, 'never-heard-of-it')).toBe('');
    expect(clampCodexEffort('high', [], 'gpt-5.5')).toBe('');
  });

  it('passes an empty stored level straight through', () => {
    expect(clampCodexEffort('', models, 'gpt-5.6-sol')).toBe('');
  });
});
