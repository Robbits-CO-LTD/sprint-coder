import { describe, expect, it } from 'vitest';
import type { ImageAttachmentAcceptanceSelection } from './persistence';
import {
  buildImageAttachmentSelectionIdentity,
  buildProviderImageAttachmentSelectionIdentity,
  imageAttachmentSelectionIdentityDigest,
  toPublicProviderImageAttachmentCapability,
  toPublicImageAttachmentCapability,
  validateProviderImageAttachmentCapabilitySnapshot,
  validateProviderImageAttachmentCurrent,
  validateImageAttachmentCapabilitySnapshot,
  type ImageAttachmentRuntimeCurrent,
  type ImageAttachmentRuntimeSnapshot,
} from './image-attachment-capability';

const selection: ImageAttachmentAcceptanceSelection = {
  taskId: 'task-1',
  modelSelection: {
    connectionId: 'builtin:codex-cli',
    requestedProvider: 'openai',
    requestedModel: 'gpt-5.6-sol',
  },
  runtimeKind: 'codex',
  model: 'gpt-5.6-sol',
};
const snapshot: ImageAttachmentRuntimeSnapshot = {
  runtimeKind: 'codex',
  available: true,
  readiness: 'ready',
  runtimeInstanceId: 'runtime-1',
  readinessRevision: 4,
  catalogRevision: 'catalog-7',
  modelIds: ['gpt-5.6-sol'],
  capturedAtMs: 10_000,
};
const current: ImageAttachmentRuntimeCurrent = {
  runtimeKind: 'codex',
  runtimeInstanceId: snapshot.runtimeInstanceId,
  readinessRevision: snapshot.readinessRevision,
  catalogRevision: snapshot.catalogRevision,
};

describe('image attachment capability identity', () => {
  it('binds the exact Task selection and current Runtime revisions', () => {
    const identity = buildImageAttachmentSelectionIdentity(selection, snapshot);
    expect(identity).toEqual({
      taskId: 'task-1',
      connectionId: 'builtin:codex-cli',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      runtimeKind: 'codex',
      runtimeInstanceId: 'runtime-1',
      readinessRevision: 4,
      catalogRevision: 'catalog-7',
    });
    expect(imageAttachmentSelectionIdentityDigest(identity!)).toMatch(/^[a-f0-9]{64}$/);
    expect(toPublicImageAttachmentCapability(selection, snapshot, current, 14_999)).toEqual({
      status: 'supported',
      reason: null,
      selectionIdentity: imageAttachmentSelectionIdentityDigest(identity!),
    });
  });

  it('rejects selection, instance, readiness, catalog, and age changes', () => {
    const cases = [
      { selection: { ...selection, runtimeKind: 'claude' as const } },
      { current: { ...current, runtimeInstanceId: 'runtime-2' } },
      { current: { ...current, readinessRevision: 5 } },
      { current: { ...current, catalogRevision: 'catalog-8' } },
      { current: { ...current, runtimeKind: 'claude' as const } },
      { snapshot: { ...snapshot, runtimeKind: 'claude' as const } },
      { snapshot: { ...snapshot, modelIds: [] } },
      { nowMs: 15_001 },
      { nowMs: Number.NaN },
      { snapshot: { ...snapshot, readiness: 'authentication_required' as const } },
    ];
    for (const changes of cases)
      expect(
        validateImageAttachmentCapabilitySnapshot({
          selection,
          snapshot,
          current,
          expectedSelectionIdentity: imageAttachmentSelectionIdentityDigest(
            buildImageAttachmentSelectionIdentity(selection, snapshot)!,
          ),
          nowMs: 10_000,
          ...changes,
        }),
      ).toBe(false);
  });

  it('rejects a valid Codex-to-Codex Task or model change after capture', () => {
    const expectedSelectionIdentity = imageAttachmentSelectionIdentityDigest(
      buildImageAttachmentSelectionIdentity(selection, snapshot)!,
    );
    for (const changed of [
      { ...selection, taskId: 'task-2' },
      {
        ...selection,
        model: 'gpt-5.5',
        modelSelection: { ...selection.modelSelection, requestedModel: 'gpt-5.5' },
      },
    ])
      expect(
        validateImageAttachmentCapabilitySnapshot({
          selection: changed,
          snapshot,
          current,
          expectedSelectionIdentity,
          nowMs: 10_000,
        }),
      ).toBe(false);
  });

  it('never grants Claude, Mock, Provider, or an unavailable Codex host', () => {
    expect(
      toPublicImageAttachmentCapability(
        {
          ...selection,
          modelSelection: {
            connectionId: 'builtin:claude-cli',
            requestedProvider: 'anthropic',
            requestedModel: 'claude-sonnet-5',
          },
          runtimeKind: 'claude',
          model: 'claude-sonnet-5',
        },
        snapshot,
        current,
        10_000,
      ),
    ).toMatchObject({ status: 'unsupported', selectionIdentity: null });
    expect(
      toPublicImageAttachmentCapability(
        selection,
        { ...snapshot, available: false, readiness: 'unavailable' },
        current,
        10_000,
      ),
    ).toEqual({
      status: 'unsupported',
      reason: 'Codex CLIが見つかりません',
      selectionIdentity: null,
    });
  });
});

describe('provider image attachment capability identity', () => {
  const providerSelection: ImageAttachmentAcceptanceSelection = {
    taskId: 'task-provider',
    modelSelection: {
      connectionId: 'ollama:local',
      requestedProvider: 'ollama',
      requestedModel: 'gemma4:12b',
    },
    runtimeKind: 'codex',
    model: 'gpt-5.6-sol',
  };
  const providerSnapshot = {
    runtimeKind: 'provider' as const,
    connectionId: 'ollama:local',
    providerId: 'ollama',
    modelId: 'gemma4:12b',
    value: true,
    revision: 'capability-revision-1',
    capturedAtMs: 10_000,
  };

  it('binds task, connection, provider, model, and capability revision', () => {
    const identity = buildProviderImageAttachmentSelectionIdentity(
      providerSelection,
      providerSnapshot,
    );
    const selectionIdentity = imageAttachmentSelectionIdentityDigest(identity!);

    expect(identity).toEqual({
      taskId: 'task-provider',
      connectionId: 'ollama:local',
      providerId: 'ollama',
      modelId: 'gemma4:12b',
      runtimeKind: 'provider_inline',
      capabilityRevision: 'capability-revision-1',
    });
    expect(
      validateProviderImageAttachmentCapabilitySnapshot({
        selection: providerSelection,
        snapshot: providerSnapshot,
        expectedSelectionIdentity: selectionIdentity,
        nowMs: 14_999,
      }),
    ).toBe(true);
    expect(
      toPublicProviderImageAttachmentCapability(providerSelection, providerSnapshot, 14_999),
    ).toEqual({ status: 'supported', reason: null, selectionIdentity });
  });

  it('fails closed for non-vision, unknown, stale, and changed provider identities', () => {
    expect(
      toPublicProviderImageAttachmentCapability(
        providerSelection,
        { ...providerSnapshot, value: false },
        10_000,
      ),
    ).toMatchObject({
      status: 'unsupported',
      reason: '選択中のモデルは画像入力に対応していません',
    });
    expect(
      toPublicProviderImageAttachmentCapability(
        providerSelection,
        { ...providerSnapshot, value: null },
        10_000,
      ),
    ).toMatchObject({
      status: 'unsupported',
      reason: '選択中のモデルは画像入力対応を確認できません',
    });
    const selectionIdentity = imageAttachmentSelectionIdentityDigest(
      buildProviderImageAttachmentSelectionIdentity(providerSelection, providerSnapshot)!,
    );
    for (const changes of [
      { nowMs: 15_001 },
      { snapshot: { ...providerSnapshot, revision: 'capability-revision-2' } },
      {
        selection: {
          ...providerSelection,
          modelSelection: { ...providerSelection.modelSelection, requestedModel: 'other:model' },
        },
      },
    ])
      expect(
        validateProviderImageAttachmentCapabilitySnapshot({
          selection: providerSelection,
          snapshot: providerSnapshot,
          expectedSelectionIdentity: selectionIdentity,
          nowMs: 10_000,
          ...changes,
        }),
      ).toBe(false);
  });

  it('revalidates a fresh matching capability before provider send', () => {
    const selectionIdentity = imageAttachmentSelectionIdentityDigest(
      buildProviderImageAttachmentSelectionIdentity(providerSelection, providerSnapshot)!,
    );
    const binding = {
      kind: 'provider_inline' as const,
      snapshot: providerSnapshot,
      selectionIdentity,
    };
    expect(
      validateProviderImageAttachmentCurrent({
        selection: providerSelection,
        binding,
        current: { ...providerSnapshot, capturedAtMs: 20_000 },
        nowMs: 20_000,
      }),
    ).toBe(true);
    expect(
      validateProviderImageAttachmentCurrent({
        selection: providerSelection,
        binding,
        current: {
          ...providerSnapshot,
          revision: 'capability-revision-2',
          capturedAtMs: 20_000,
        },
        nowMs: 20_000,
      }),
    ).toBe(false);
  });
});
