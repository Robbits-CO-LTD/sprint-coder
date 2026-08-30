import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ProviderConnection, TaskSummary } from '@sprint-coder/contracts';
import type { PermissionBroker } from './permission-broker';
import type { ProviderRuntime } from './provider-runtime';
import {
  COMPUTER_USE_PROVIDER_ADAPTER_VERSION,
  COMPUTER_USE_PREFLIGHT_MARKER_PNG_BASE64,
  computerUseProviderEndpointRevision,
  parseComputerUseAction,
  preflightComputerUseProvider,
  ProviderComputerUsePlanner,
  type ComputerUsePlannerObservation,
} from './computer-use-planner';

const marker = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const markerDigest = createHash('sha256').update(marker).digest('hex');
const connection = {
  id: 'connection-1',
  providerId: 'openai',
  runtimeKind: 'official_api',
  displayName: 'Fixture',
  enabled: true,
  automaticModelRelease: false,
  secretReference: null,
  verification: {
    status: 'verified',
    verifiedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
    message: null,
  },
  rateLimit: {
    mode: 'bypass',
    maxConcurrentRequests: null,
    requestsPerMinute: null,
    tokensPerMinute: null,
    lastObservedRateLimitHeaders: null,
  },
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
} as ProviderConnection;
const task = {
  id: 'task-1',
  projectId: null,
  title: 'Computer Use',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: false,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
} as unknown as TaskSummary;
const observation: ComputerUsePlannerObservation = {
  sessionId: 'session-1',
  appIdentityDigest: 'a'.repeat(64),
  windowIdentityDigest: 'b'.repeat(64),
  profileRevision: 1,
  policyLanguage: 'en',
  maximumMode: 'full_access_app',
  screenBounds: { x: 0, y: 0, width: 1, height: 1 },
  revision: 1,
  observedAt: '2099-08-29T00:00:00.000Z',
  expiresAt: '2099-08-29T00:00:30.000Z',
  clientWidth: 1,
  clientHeight: 1,
  images: [
    {
      mimeType: 'image/png',
      digest: markerDigest,
      byteLength: marker.byteLength,
      width: 1,
      height: 1,
      base64: marker.toString('base64'),
    },
  ],
  treeDigest: null,
  treeByteLength: 0,
  treeDepth: 0,
  treeNodeCount: 0,
  accessibilityTree: '',
};

function runtimeFor(
  capture: (request: unknown) => void,
  output: string,
  resolution: { resolvedProvider?: string | null; resolvedModel?: string | null } = {},
): ProviderRuntime {
  return {
    verify: async () => {
      throw new Error('not used');
    },
    listModels: async () => [],
    execute: async function* (connection, request) {
      capture(request);
      yield { type: 'output_delta', text: output };
      yield {
        type: 'resolution',
        resolution: {
          resolvedProvider: resolution.resolvedProvider ?? connection.providerId,
          resolvedModel: resolution.resolvedModel ?? request.modelId,
        },
      };
      yield { type: 'completed', stopReason: 'stop' };
    },
    cancel: async () => undefined,
  } as ProviderRuntime;
}

function deps(runtime: ProviderRuntime, structuredOutputSupported = false) {
  const endpointRevision = computerUseProviderEndpointRevision(connection, 'model-1');
  const compatibilityBinding = {
    endpointRevision,
    catalogRevision: 7,
    policyEpoch: 0,
    adapterVersion: COMPUTER_USE_PROVIDER_ADAPTER_VERSION,
  } as const;
  return {
    runtime,
    connection,
    modelId: 'model-1',
    mode: 'full_access_app' as const,
    task,
    turnId: 'turn-1',
    permissionBroker: {} as PermissionBroker,
    catalogRevision: compatibilityBinding.catalogRevision,
    policyEpoch: compatibilityBinding.policyEpoch,
    compatibilityPermit: {
      sessionId: 'session-1',
      connectionId: connection.id,
      providerId: connection.providerId,
      modelId: 'model-1',
      mode: 'full_access_app' as const,
      ...compatibilityBinding,
      protocolVersion: 1 as const,
      expiresAt: '2099-08-29T00:05:00.000Z',
    },
    currentCompatibilityBinding: () => compatibilityBinding,
    structuredOutputSupported,
    egress: () => ({
      allowed: true,
      evaluation: {
        decision: 'allow' as const,
        reason: 'fixture',
        policyEpoch: 0,
        evaluationTrace: [],
      },
    }),
  };
}

describe('Computer Use planner parser', () => {
  it('accepts only one canonical action and rejects unknown fields', () => {
    expect(parseComputerUseAction({ type: 'click', x: 0.5, y: 0.5, button: 'left' })).toEqual({
      type: 'click',
      x: 0.5,
      y: 0.5,
      button: 'left',
    });
    expect(() =>
      parseComputerUseAction({ type: 'click', x: 0.5, y: 0.5, extra: 'prompt injection' }),
    ).toThrow();
    expect(() => parseComputerUseAction({ type: 'shell', command: 'id' })).toThrow();
  });

  it('rejects alternate discriminator aliases in the V1 grammar', () => {
    expect(() => parseComputerUseAction({ action: 'finish' })).toThrow();
  });
});

describe('Computer Use provider preflight', () => {
  it('ships a valid 64px PNG with the red marker at the required normalized position', () => {
    const png = Buffer.from(COMPUTER_USE_PREFLIGHT_MARKER_PNG_BASE64, 'base64');
    const decoded = decodeUnfilteredRgbaPng(png);
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);
    const red: Array<readonly [number, number]> = [];
    for (let y = 0; y < decoded.height; y += 1)
      for (let x = 0; x < decoded.width; x += 1) {
        const offset = (y * decoded.width + x) * 4;
        if (
          decoded.pixels[offset]! > 200 &&
          decoded.pixels[offset + 1]! < 80 &&
          decoded.pixels[offset + 2]! < 80
        )
          red.push([x, y]);
      }
    expect(red).toHaveLength(256);
    const xs = red.map(([x]) => x);
    const ys = red.map(([, y]) => y);
    expect((Math.min(...xs) + Math.max(...xs)) / 2 / decoded.width).toBeCloseTo(0.742, 3);
    expect((Math.min(...ys) + Math.max(...ys)) / 2 / decoded.height).toBeCloseTo(0.242, 3);
  });

  it('binds a permit only when the model locates the fixed visual marker', async () => {
    let seen: unknown;
    const permit = await preflightComputerUseProvider(
      {
        ...deps(
          runtimeFor(
            (request) => (seen = request),
            '{"type":"click","x":0.75,"y":0.25,"button":"left"}',
          ),
        ),
        sessionId: 'session-1',
      },
      new AbortController().signal,
    );

    expect(permit).toMatchObject({
      sessionId: 'session-1',
      connectionId: 'connection-1',
      modelId: 'model-1',
      mode: 'full_access_app',
      catalogRevision: 7,
      policyEpoch: 0,
      adapterVersion: COMPUTER_USE_PROVIDER_ADAPTER_VERSION,
      protocolVersion: 1,
    });
    expect(seen).toMatchObject({
      messages: [
        {
          inlineImages: [
            {
              mimeType: 'image/png',
            },
          ],
        },
      ],
    });
  });

  it('does not accept a text-only finish response as image compatibility proof', async () => {
    await expect(
      preflightComputerUseProvider(
        {
          ...deps(runtimeFor(() => undefined, '{"type":"finish"}')),
          sessionId: 'session-1',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'preflight_action_mismatch' });
  });

  it('rejects a preflight resolution that falls back to another model', async () => {
    await expect(
      preflightComputerUseProvider(
        {
          ...deps(
            runtimeFor(() => undefined, '{"type":"click","x":0.75,"y":0.25,"button":"left"}', {
              resolvedModel: 'different-model',
            }),
          ),
          sessionId: 'session-1',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'preflight_provider_binding_mismatch' });
  });
});

describe('ProviderComputerUsePlanner', () => {
  it('uses plain JSON when structured output capability is not confirmed', async () => {
    let seen: unknown;
    const planner = new ProviderComputerUsePlanner(
      deps(runtimeFor((request) => (seen = request), '{"type":"finish"}')),
    );
    await expect(
      planner.plan({ observation, round: 1, signal: new AbortController().signal }),
    ).resolves.toEqual({
      type: 'finish',
    });
    expect(seen).not.toHaveProperty('structuredOutput');
    expect(seen).toMatchObject({
      messages: [
        {
          content: expect.stringContaining('Trusted Task objective: Computer Use'),
        },
        expect.any(Object),
      ],
    });
  });

  it('adds strict structured output only after capability confirmation', async () => {
    let seen: unknown;
    const planner = new ProviderComputerUsePlanner(
      deps(
        runtimeFor((request) => (seen = request), '{"type":"finish"}'),
        true,
      ),
    );
    await planner.plan({ observation, round: 1, signal: new AbortController().signal });
    expect(seen).toMatchObject({
      structuredOutput: { name: 'computer_use_action_v1', strict: true },
    });
  });

  it('rejects a planner response whose runtime resolution does not match the permit', async () => {
    const planner = new ProviderComputerUsePlanner(
      deps(
        runtimeFor(() => undefined, '{"type":"finish"}', {
          resolvedProvider: 'different-provider',
        }),
      ),
    );
    await expect(
      planner.plan({ observation, round: 1, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'planner_provider_binding_mismatch' });
  });

  it('limits observe-only planning instructions to wait or finish', async () => {
    let seen: unknown;
    const base = deps(runtimeFor((request) => (seen = request), '{"type":"finish"}'));
    const planner = new ProviderComputerUsePlanner({
      ...base,
      mode: 'observe_only',
      compatibilityPermit: { ...base.compatibilityPermit, mode: 'observe_only' },
    });
    await planner.plan({ observation, round: 1, signal: new AbortController().signal });
    expect(seen).toMatchObject({
      messages: [
        { content: expect.stringContaining('Return only wait or finish') },
        expect.any(Object),
      ],
    });
  });

  it('sends only a redacted tree projection with matching egress metadata', async () => {
    const rawTree = JSON.stringify({
      role: 'AXWindow',
      title: 'Document',
      identifier: 'main',
      children: [
        {
          role: 'AXSecureTextField',
          title: 'Private credential',
          identifier: 'credential-input',
          value: 'example-sensitive-input',
          children: [],
        },
        {
          role: 'AXButton',
          title: 'Purchase contract',
          identifier: 'purchase-contract',
          children: [],
        },
      ],
    });
    let seenRequest: unknown;
    let seenEgress: unknown;
    const planner = new ProviderComputerUsePlanner({
      ...deps(runtimeFor((request) => (seenRequest = request), '{"type":"finish"}')),
      egress: (input) => {
        seenEgress = input;
        return {
          allowed: true,
          evaluation: {
            decision: 'allow',
            reason: 'fixture',
            policyEpoch: 0,
            evaluationTrace: [],
          },
        };
      },
    });

    await planner.plan({
      observation: {
        ...observation,
        accessibilityTree: rawTree,
        treeDigest: createHash('sha256').update(rawTree, 'utf8').digest('hex'),
        treeByteLength: Buffer.byteLength(rawTree, 'utf8'),
        treeDepth: 1,
        treeNodeCount: 3,
      },
      round: 1,
      signal: new AbortController().signal,
    });

    const prompt = providerUserPrompt(seenRequest);
    expect(prompt).not.toContain('Private credential');
    expect(prompt).not.toContain('credential-input');
    expect(prompt).not.toContain('example-sensitive-input');
    expect(prompt).not.toContain('Purchase contract');
    expect(prompt).not.toContain('purchase-contract');
    expect(prompt).toContain('[redacted]');
    const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
      accessibilityTree: string;
    };
    expect(seenEgress).toMatchObject({
      accessibilityTreeDigest: createHash('sha256')
        .update(payload.accessibilityTree, 'utf8')
        .digest('hex'),
      accessibilityTreeByteCount: Buffer.byteLength(payload.accessibilityTree, 'utf8'),
    });
  });

  it('rejects provider tool calls even when the provider completes', async () => {
    const planner = new ProviderComputerUsePlanner(
      deps({
        ...runtimeFor(() => undefined, ''),
        execute: async function* () {
          yield { type: 'tool_call', callId: 'call-1', name: 'shell', input: {} };
          yield { type: 'completed', stopReason: 'stop' };
        },
      } as ProviderRuntime),
    );
    await expect(
      planner.plan({ observation, round: 1, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'planner_tool_call_not_allowed' });
  });

  it('rejects a stale compatibility permit before Provider egress or execution', async () => {
    let executions = 0;
    const base = deps(
      runtimeFor(() => {
        executions += 1;
      }, '{"type":"finish"}'),
    );
    const planner = new ProviderComputerUsePlanner({
      ...base,
      currentCompatibilityBinding: () => ({
        ...base.currentCompatibilityBinding(),
        policyEpoch: 1,
      }),
    });
    await expect(
      planner.plan({ observation, round: 1, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'compatibility_permit_stale' });
    expect(executions).toBe(0);
  });

  it('discards a valid Provider action when its compatibility binding changes in flight', async () => {
    const base = deps(runtimeFor(() => undefined, '{"type":"click","x":0.5,"y":0.5}'));
    let checks = 0;
    const planner = new ProviderComputerUsePlanner({
      ...base,
      currentCompatibilityBinding: () => {
        checks += 1;
        return {
          ...base.currentCompatibilityBinding(),
          catalogRevision: checks === 1 ? 7 : 8,
        };
      },
    });
    await expect(
      planner.plan({ observation, round: 1, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'compatibility_permit_stale' });
    expect(checks).toBe(2);
  });

  it('cancels a Provider stream that misses the bounded first-event deadline', async () => {
    let cancels = 0;
    const runtime = {
      ...runtimeFor(() => undefined, ''),
      execute: async function* () {
        await new Promise(() => undefined);
        yield { type: 'completed' as const, stopReason: 'stop' };
      },
      cancel: async () => {
        cancels += 1;
      },
    } as ProviderRuntime;
    const planner = new ProviderComputerUsePlanner({
      ...deps(runtime),
      streamDeadlines: { firstEventTimeoutMs: 5, idleTimeoutMs: 5 },
    });
    await expect(
      planner.plan({ observation, round: 1, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'planner_provider_timeout' });
    expect(cancels).toBe(1);
  });

  it('cancels a non-conforming Provider immediately when the session signal aborts', async () => {
    let cancels = 0;
    const runtime = {
      ...runtimeFor(() => undefined, ''),
      execute: async function* () {
        await new Promise(() => undefined);
        yield { type: 'completed' as const, stopReason: 'stop' };
      },
      cancel: async () => {
        cancels += 1;
      },
    } as ProviderRuntime;
    const controller = new AbortController();
    const planner = new ProviderComputerUsePlanner({
      ...deps(runtime),
      streamDeadlines: { firstEventTimeoutMs: 10_000, idleTimeoutMs: 10_000 },
    });
    const pending = planner.plan({ observation, round: 1, signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error('session stopped'));
    await expect(pending).rejects.toThrow('session stopped');
    expect(cancels).toBe(1);
  });
});

function providerUserPrompt(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new Error('request missing');
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length < 2) throw new Error('messages missing');
  const user = messages[1];
  if (typeof user !== 'object' || user === null) throw new Error('user message missing');
  const content = (user as { content?: unknown }).content;
  if (typeof content !== 'string') throw new Error('user prompt missing');
  return content;
}

function decodeUnfilteredRgbaPng(png: Buffer): Readonly<{
  width: number;
  height: number;
  pixels: Buffer;
}> {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= png.byteLength) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([...data.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0]);
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') sawEnd = true;
    offset += 12 + length;
  }
  expect(offset).toBe(png.byteLength);
  expect(sawEnd).toBe(true);
  const raw = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (1 + width * 4);
    expect(raw[rowOffset]).toBe(0);
    raw.copy(pixels, y * width * 4, rowOffset + 1, rowOffset + 1 + width * 4);
  }
  return { width, height, pixels };
}
