import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ComputerUseAction, ProviderConnection, TaskSummary } from '@sprint-coder/contracts';
import { computerUseActionDigest } from './computer-use-action';
import { COMPUTER_USE_PROVIDER_ADAPTER_VERSION } from './computer-use-adapter-version';
import {
  computerUseProviderEndpointRevision,
  ProviderComputerUsePlanner,
  type ComputerUsePlannerObservation,
} from './computer-use-planner';
import {
  ComputerUseRuntimeCapture,
  computerUseCaptureDigest,
} from './computer-use-runtime-capture';
import type { PermissionBroker } from './permission-broker';
import type { ProviderRuntime } from './provider-runtime';

/**
 * #786: a typed string must not be recoverable from what Computer Use writes down. The audit row
 * (SQLite, kept across restarts) and the runtime capture (final-gate evidence) carry digests of
 * what the planner wrote; a short secret it typed — a six-digit code, a PIN — has to stay out of
 * reach of anyone who reads them and guesses.
 *
 * The property is that the digests are keyed with a secret that never leaves the process. Against
 * an unkeyed hash every guess can be checked, so the only guess that matters is the right one:
 * each test checks the right value against every unkeyed construction, and one test walks the
 * whole six-digit space once to show what an attacker actually gets.
 */

const SECRET = '482913';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** The audit digest before #786: the text swapped for its unsalted sha256, then hashed whole. */
const auditGuess = (action: ComputerUseAction, field: 'text' | 'value', guess: string) =>
  sha256(
    stableStringify({
      ...action,
      [field]: { byteLength: Buffer.byteLength(guess, 'utf8'), sha256: sha256(guess) },
    }),
  );

/** Every unkeyed construction of the right answer an attacker would try. */
function unkeyed(action: ComputerUseAction, field: 'text' | 'value'): string[] {
  const guess = (action as Record<string, unknown>)[field] as string;
  return [
    auditGuess(action, field, guess),
    sha256(JSON.stringify(action)),
    sha256(stableStringify(action)),
    sha256(guess),
  ];
}

const typed: ComputerUseAction = { type: 'type', text: SECRET };
const setText: ComputerUseAction = { type: 'set_text', targetId: 'otp', text: SECRET };
const selected: ComputerUseAction = { type: 'select', targetId: 'otp', value: SECRET };

describe('Computer Use action digest (#786)', () => {
  it('stays a 64-character hex digest, so the audit column and native ticket accept it', () => {
    for (const action of [typed, setText, { type: 'wait', milliseconds: 0 } as const])
      expect(computerUseActionDigest(action)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('binds the exact text within the process: same action, same digest; other text, other digest', () => {
    // Plan grants, approvals and request-id reuse compare digests, so a same-length string must
    // never pass for the approved one. This is why a byte length alone would not do.
    expect(computerUseActionDigest(typed)).toBe(computerUseActionDigest({ ...typed }));
    expect(computerUseActionDigest(typed)).not.toBe(
      computerUseActionDigest({ type: 'type', text: '482914' }),
    );
    expect(computerUseActionDigest(setText)).not.toBe(
      computerUseActionDigest({ ...setText, text: '000000' }),
    );
  });

  it('is keyed per process: a fresh process key gives the same action another digest', async () => {
    vi.resetModules();
    const fresh = await import('./computer-use-action');
    expect(fresh.computerUseActionDigest(typed)).not.toBe(computerUseActionDigest(typed));
    vi.resetModules();
  });

  it.each([
    ['type', typed, 'text'],
    ['set_text', setText, 'text'],
    ['select', selected, 'value'],
  ] as const)('matches no unkeyed construction of the right %s text', (_kind, action, field) => {
    expect(unkeyed(action, field)).not.toContain(computerUseActionDigest(action));
  });

  it('gives a typed six-digit code back to no guess among all 10^6 (audit construction)', () => {
    const recorded = computerUseActionDigest(typed);
    let matches = 0;
    for (let value = 0; value < 1_000_000; value += 1)
      if (auditGuess(typed, 'text', String(value).padStart(6, '0')) === recorded) matches += 1;
    expect(matches).toBe(0);
  }, 60_000);
});

describe('Computer Use runtime capture digests (#786)', () => {
  const sessionId = 'session-1';

  function startedCapture(events: Record<string, unknown>[]): ComputerUseRuntimeCapture {
    const capture = new ComputerUseRuntimeCapture((event) =>
      events.push(event as Record<string, unknown>),
    );
    capture.start({
      type: 'session',
      sessionDigest: computerUseCaptureDigest(sessionId),
      appDigest: 'a'.repeat(64),
      windowDigest: 'b'.repeat(64),
      manifestDigest: 'f'.repeat(64),
      platform: 'darwin',
    });
    return capture;
  }

  it('keys the action digest of an action result', () => {
    const events: Record<string, unknown>[] = [];
    startedCapture(events).actionResult(sessionId, 1, typed, 'completed', null);
    const recorded = events.find((event) => event['type'] === 'action_result')?.['actionDigest'];
    expect(recorded).toMatch(/^[0-9a-f]{64}$/u);
    expect(unkeyed(typed, 'text')).not.toContain(recorded);
  });

  it('keys both digests of the parsed planner reply, whose raw text is the typed action', async () => {
    const events: Record<string, unknown>[] = [];
    const capture = startedCapture(events);
    const reply = JSON.stringify(typed);
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const connection = {
      id: 'connection-1',
      providerId: 'openai',
      runtimeKind: 'official_api',
      enabled: true,
      secretReference: null,
      verification: { status: 'verified', verifiedAt: null, expiresAt: null, message: null },
    } as ProviderConnection;
    const binding = {
      endpointRevision: computerUseProviderEndpointRevision(connection, 'model-1'),
      catalogRevision: 7,
      policyEpoch: 0,
      adapterVersion: COMPUTER_USE_PROVIDER_ADAPTER_VERSION,
    } as const;
    const runtime = {
      execute: async function* (_connection: ProviderConnection, request: { modelId: string }) {
        yield { type: 'output_delta', text: reply };
        yield {
          type: 'resolution',
          resolution: { resolvedProvider: 'openai', resolvedModel: request.modelId },
        };
        yield { type: 'completed', stopReason: 'stop' };
      },
      cancel: async () => undefined,
    } as unknown as ProviderRuntime;
    const planner = new ProviderComputerUsePlanner({
      runtime,
      runtimeCapture: capture,
      connection,
      modelId: 'model-1',
      mode: 'full_access_app',
      task: { id: 'task-1', title: 'Fixture', goal: null } as unknown as TaskSummary,
      turnId: 'turn-1',
      permissionBroker: {} as PermissionBroker,
      compatibilityPermit: {
        sessionId,
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId: 'model-1',
        mode: 'full_access_app',
        ...binding,
        protocolVersion: 1,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      currentCompatibilityBinding: () => binding,
      egress: () => ({
        allowed: true,
        evaluation: { decision: 'allow', reason: 'fixture', policyEpoch: 0, evaluationTrace: [] },
      }),
    });
    const observation: ComputerUsePlannerObservation = {
      sessionId,
      appIdentityDigest: 'a'.repeat(64),
      windowIdentityDigest: 'b'.repeat(64),
      profileRevision: 1,
      policyLanguage: 'en',
      maximumMode: 'full_access_app',
      screenBounds: { x: 0, y: 0, width: 1, height: 1 },
      revision: 1,
      observedAt: '2099-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:30.000Z',
      clientWidth: 1,
      clientHeight: 1,
      images: [
        {
          mimeType: 'image/png',
          digest: sha256(image),
          byteLength: image.byteLength,
          width: 1,
          height: 1,
          base64: image.toString('base64'),
        },
      ],
      treeDigest: null,
      treeByteLength: 0,
      treeDepth: 0,
      treeNodeCount: 0,
      accessibilityTree: '',
    };
    await expect(
      planner.plan({ observation, round: 1, signal: new AbortController().signal }),
    ).resolves.toEqual(typed);
    const parsed = events.find((event) => event['type'] === 'parsed');
    expect(parsed).toBeDefined();
    // The exact length is still recorded, which is what made an unkeyed digest guessable.
    expect(parsed!['responseBytes']).toBe(Buffer.byteLength(reply));
    for (const field of ['responseDigest', 'actionDigest']) {
      expect(parsed![field]).toMatch(/^[0-9a-f]{64}$/u);
      expect([...unkeyed(typed, 'text'), sha256(reply)]).not.toContain(parsed![field]);
    }
    // Two uses of one key, kept apart: the reply digest is not the action digest.
    expect(parsed!['responseDigest']).not.toBe(parsed!['actionDigest']);
  });
});
