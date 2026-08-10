import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@sprint-coder/domain';
import {
  RUNTIME_PROTOCOL_VERSION,
  runtimeImageManifestDigest,
  type MainToRuntimeEnvelope,
} from './protocol';

const hostMock = vi.hoisted(() => {
  const messages: unknown[] = [];
  const lifecycle: string[] = [];
  let receive: ((event: { data: unknown }) => void) | null = null;
  return {
    messages,
    lifecycle,
    resolveHungPrepare: null as (() => void) | null,
    parentPort: {
      on: vi.fn((_event: string, handler: (event: { data: unknown }) => void) => {
        receive = handler;
      }),
      postMessage: vi.fn((message: unknown) => messages.push(message)),
    },
    receive(message: unknown) {
      if (receive === null) throw new Error('Runtime Host listener is not installed');
      receive({ data: message });
    },
  };
});

vi.mock('./parent-port', () => ({ requireParentPort: () => hostMock.parentPort }));
vi.mock('./image-attachment-preparer', () => ({
  prepareRuntimeImages: vi.fn(async (manifest, paths, manifestDigest) => {
    const prepared = {
      manifest,
      paths,
      handles: [],
      manifestDigest,
      decodedByteLength: manifest.reduce(
        (total: number, entry: { byteLength: number }) => total + entry.byteLength,
        0,
      ),
    };
    if (manifest[0]?.id !== 'attachment-hung') return prepared;
    return new Promise((resolve) => {
      hostMock.resolveHungPrepare = () => resolve(prepared);
    });
  }),
  reverifyPreparedRuntimeImages: vi.fn(async () => {
    hostMock.lifecycle.push('reverify');
  }),
  releasePreparedRuntimeImages: vi.fn(async () => {
    hostMock.lifecycle.push('release');
  }),
}));
vi.mock('./codex-adapter', () => ({
  probeCodex: vi.fn(async () => ({ available: true, readiness: 'ready', models: [] })),
  CodexRuntimeAdapter: class {
    start(...args: unknown[]): void {
      const accepted = args[3] as () => void;
      const localImages = args[15] as
        | {
            beforeTurnStart(): Promise<void>;
            release(): Promise<void>;
          }
        | undefined;
      void (async () => {
        await localImages?.beforeTurnStart();
        hostMock.lifecycle.push('turn/start');
        accepted();
        await localImages?.release();
      })();
    }
    async cancel(): Promise<boolean> {
      return false;
    }
    dispose(): void {}
  },
}));
vi.mock('./claude-adapter', () => ({
  probeClaude: vi.fn(async () => ({ available: false, readiness: 'unavailable', models: [] })),
  ClaudeRuntimeAdapter: class {
    start(): void {}
    async cancel(): Promise<boolean> {
      return false;
    }
    dispose(): void {}
  },
}));

const runtimeInstanceId = 'runtime-index-test';
process.argv.push('--runtime-instance-id', runtimeInstanceId, '--runtime-kind', 'codex');

afterAll(() => {
  process.argv.splice(process.argv.indexOf('--runtime-instance-id'), 4);
});

describe('Runtime Host image two-phase state machine', () => {
  it('prepares once, rejects a mismatched commit, and re-verifies before an exact commit', async () => {
    await import('./index');
    const manifest = [
      {
        id: 'attachment-1',
        mimeType: 'image/png' as const,
        byteLength: 128,
        sha256: 'a'.repeat(64),
      },
    ];
    const manifestDigest = runtimeImageManifestDigest(manifest);
    hostMock.receive(
      prepareEnvelope('operation-mismatch', 'turn-mismatch', manifest, manifestDigest),
    );
    await vi.waitFor(() =>
      expect(
        hostMock.messages.some(
          (message) =>
            isRecord(message) &&
            message['type'] === 'images_prepared' &&
            message['operationId'] === 'operation-mismatch',
        ),
      ).toBe(true),
    );
    hostMock.receive(
      prepareEnvelope('operation-mismatch', 'turn-mismatch', manifest, manifestDigest),
    );
    await vi.waitFor(() =>
      expect(
        hostMock.messages.some(
          (message) =>
            isRecord(message) &&
            message['type'] === 'images_prepare_failed' &&
            message['operationId'] === 'operation-mismatch',
        ),
      ).toBe(true),
    );
    hostMock.receive({
      ...startEnvelope('operation-mismatch', 'turn-mismatch'),
      type: 'commit_images',
      selectionIdentity: 'f'.repeat(64),
      manifestDigest,
    });
    await vi.waitFor(() =>
      expect(
        hostMock.messages.some(
          (message) =>
            isRecord(message) &&
            message['type'] === 'error' &&
            message['operationId'] === 'operation-mismatch',
        ),
      ).toBe(true),
    );

    hostMock.receive(prepareEnvelope('operation-plain', 'turn-plain', manifest, manifestDigest));
    await vi.waitFor(() =>
      expect(
        hostMock.messages.some(
          (message) =>
            isRecord(message) &&
            message['type'] === 'images_prepared' &&
            message['operationId'] === 'operation-plain',
        ),
      ).toBe(true),
    );
    hostMock.receive({ ...startEnvelope('operation-text', 'turn-plain'), type: 'start' });
    await vi.waitFor(() =>
      expect(
        hostMock.messages.some(
          (message) =>
            isRecord(message) &&
            message['type'] === 'error' &&
            message['operationId'] === 'operation-text',
        ),
      ).toBe(true),
    );

    hostMock.receive(prepareEnvelope('operation-exact', 'turn-exact', manifest, manifestDigest));
    await vi.waitFor(() =>
      expect(
        hostMock.messages.some(
          (message) =>
            isRecord(message) &&
            message['type'] === 'images_prepared' &&
            message['operationId'] === 'operation-exact',
        ),
      ).toBe(true),
    );
    hostMock.receive({
      ...startEnvelope('operation-exact', 'turn-exact'),
      type: 'commit_images',
      selectionIdentity: 'b'.repeat(64),
      manifestDigest,
    });
    await vi.waitFor(() =>
      expect(hostMock.lifecycle).toEqual([
        'release',
        'release',
        'reverify',
        'turn/start',
        'release',
      ]),
    );
    expect(
      hostMock.messages.some(
        (message) =>
          isRecord(message) &&
          message['type'] === 'started' &&
          message['operationId'] === 'operation-exact',
      ),
    ).toBe(true);

    vi.useFakeTimers();
    hostMock.receive(
      prepareEnvelope('operation-timeout', 'turn-timeout', manifest, manifestDigest),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(
      hostMock.messages.some(
        (message) =>
          isRecord(message) &&
          message['type'] === 'images_prepare_failed' &&
          message['operationId'] === 'operation-timeout',
      ),
    ).toBe(true);
    expect(hostMock.lifecycle.at(-1)).toBe('release');

    const hungManifest = [{ ...manifest[0]!, id: 'attachment-hung' }];
    const hungDigest = runtimeImageManifestDigest(hungManifest);
    hostMock.receive(
      prepareEnvelope('operation-hung-duplicate', 'turn-hung-duplicate', hungManifest, hungDigest),
    );
    await Promise.resolve();
    hostMock.receive(
      prepareEnvelope('operation-hung-duplicate', 'turn-hung-duplicate', hungManifest, hungDigest),
    );
    await Promise.resolve();
    expect(
      hostMock.messages.some(
        (message) =>
          isRecord(message) &&
          message['type'] === 'images_prepare_failed' &&
          message['operationId'] === 'operation-hung-duplicate',
      ),
    ).toBe(true);
    hostMock.resolveHungPrepare?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      hostMock.messages.some(
        (message) =>
          isRecord(message) &&
          message['type'] === 'images_prepared' &&
          message['operationId'] === 'operation-hung-duplicate',
      ),
    ).toBe(false);

    hostMock.receive(prepareEnvelope('operation-hung', 'turn-hung', hungManifest, hungDigest));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(
      hostMock.messages.some(
        (message) =>
          isRecord(message) &&
          message['type'] === 'images_prepare_failed' &&
          message['operationId'] === 'operation-hung',
      ),
    ).toBe(true);
    const preparedCount = hostMock.messages.filter(
      (message) =>
        isRecord(message) &&
        message['type'] === 'images_prepared' &&
        message['operationId'] === 'operation-hung',
    ).length;
    hostMock.resolveHungPrepare?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      hostMock.messages.filter(
        (message) =>
          isRecord(message) &&
          message['type'] === 'images_prepared' &&
          message['operationId'] === 'operation-hung',
      ),
    ).toHaveLength(preparedCount);
    expect(hostMock.lifecycle.at(-1)).toBe('release');
    vi.useRealTimers();
  });
});

function prepareEnvelope(
  operationId: string,
  turnId: string,
  manifest: Array<{
    id: string;
    mimeType: 'image/png';
    byteLength: number;
    sha256: string;
  }>,
  manifestDigest: string,
): MainToRuntimeEnvelope {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId,
    taskId: 'task-1',
    turnId,
    seq: 1,
    operationId,
    type: 'prepare_images',
    selectionIdentity: 'b'.repeat(64),
    manifest,
    paths: [join(tmpdir(), 'custody', '001.png')],
    manifestDigest,
  };
}

function startEnvelope(operationId: string, turnId: string) {
  const payload = 'inspect';
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId,
    taskId: 'task-1',
    turnId,
    seq: 2,
    operationId,
    input: payload,
    workspace: {
      primaryRootId: null,
      roots: [],
      digest: createHash('sha256').update('').digest('hex'),
    },
    model: 'gpt-5.6-sol',
    contextFragments: [],
    projectItems: [],
    projectSnapshotDigest: null,
    payload,
    payloadDigest: createHash('sha256').update(payload).digest('hex'),
    toolCatalogSnapshot: new ToolRegistry().createSnapshot({
      providerId: 'codex',
      workspaceId: null,
    }),
  } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
