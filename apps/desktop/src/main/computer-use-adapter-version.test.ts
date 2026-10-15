import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { COMPUTER_USE_PROVIDER_ADAPTER_VERSION } from './computer-use-adapter-version';
import { COMPUTER_USE_PROVIDER_ADAPTER_VERSION as PLANNER_ADAPTER_VERSION } from './computer-use-planner';
import type { TaskSummary } from '@sprint-coder/contracts';
import { digestCanonical } from './context-compiler';
import type * as ContextCompiler from './context-compiler';
import type { PermissionBroker } from './permission-broker';
import { authorizeComputerUseProviderEgress } from './provider-egress';

const root = resolve(__dirname, '../../../..');

// The egress audit facts reach the permission request only folded into `executionSpecDigest`, so
// they are read where they are folded.
const digested = vi.hoisted(() => [] as unknown[]);
vi.mock('./context-compiler', async (original) => {
  const actual = await original<typeof ContextCompiler>();
  return {
    ...actual,
    digestCanonical: (value: Parameters<typeof actual.digestCanonical>[0]) => {
      digested.push(value);
      return actual.digestCanonical(value);
    },
  };
});

async function rootModule(name: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(resolve(root, name)).href)) as Record<string, unknown>;
}

describe('Computer Use adapter version', () => {
  it('is the grammar that carries the closed answer (T15-2, decision 7)', () => {
    expect(COMPUTER_USE_PROVIDER_ADAPTER_VERSION).toBe('computer-use-v2');
    expect(PLANNER_ADAPTER_VERSION).toBe(COMPUTER_USE_PROVIDER_ADAPTER_VERSION);
  });

  it('is the version every Computer Use egress request is audited under', () => {
    const requests: unknown[] = [];
    const broker = {
      getPolicy: () => ({ policyEpoch: 0 }),
      // Stop at the first decision: only what the request says about the grammar matters here.
      preview: (input: { request: unknown }) => {
        requests.push(input.request);
        return { decision: 'deny', reason: 'fixture', policyEpoch: 0, evaluationTrace: [] };
      },
    } as unknown as PermissionBroker;
    authorizeComputerUseProviderEgress({
      broker,
      task: { id: 'task-1', goal: 'g', title: 't' } as TaskSummary,
      turnId: 'turn-1',
      sessionId: 'session-1',
      providerId: 'openai',
      connectionId: 'connection-1',
      modelId: 'model-1',
      prompt: 'p',
      screenshotMimeType: 'image/png',
      screenshotDigest: 'a'.repeat(64),
      screenshotByteCount: 1,
      accessibilityTreeDigest: 'b'.repeat(64),
      accessibilityTreeByteCount: 0,
      now: '2026-10-15T00:00:00.000Z',
      round: 1,
    });
    expect(requests).toHaveLength(1);
    const audits = digested
      .map((value) => (value as { egressAudit?: Record<string, unknown> } | null)?.egressAudit)
      .filter((audit) => audit !== undefined);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      adapterVersion: COMPUTER_USE_PROVIDER_ADAPTER_VERSION,
      toolCatalogDigest: digestCanonical([COMPUTER_USE_PROVIDER_ADAPTER_VERSION]),
    });
  });

  it('is the version the final-gate evidence pipeline records and accepts', async () => {
    // The capture names the grammar without measuring it, and the verifier and the parent closure
    // accept only that name. If they drift from the app, evidence from a v2 build would claim v1,
    // or valid evidence would be refused. Both directions fail here instead.
    const capture = await rootModule('computer-use-capture-rounds.mjs');
    const verifier = await rootModule('verify-computer-use-final-gate.mjs');
    expect(capture['COMPUTER_USE_CAPTURE_ADAPTER_VERSION']).toBe(
      COMPUTER_USE_PROVIDER_ADAPTER_VERSION,
    );
    expect(verifier['COMPUTER_USE_PROVIDER_ADAPTER_VERSION']).toBe(
      COMPUTER_USE_PROVIDER_ADAPTER_VERSION,
    );
  });
});
