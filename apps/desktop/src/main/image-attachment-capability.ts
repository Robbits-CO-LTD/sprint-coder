import type {
  CodexModelOption,
  ImageAttachmentCapability,
  ModelSelection,
} from '@sprint-coder/contracts';
import { digestCanonical } from './context-compiler';
import {
  BUILTIN_CODEX_CONNECTION_ID,
  builtinRuntimeForModelSelection,
} from './connection-identity';
import type { ImageAttachmentAcceptanceSelection } from './persistence';

export const IMAGE_ATTACHMENT_CAPABILITY_MAX_AGE_MS = 5_000;

export type ImageAttachmentRuntimeSnapshot = Readonly<{
  runtimeKind: 'codex' | 'claude';
  available: boolean;
  readiness: 'ready' | 'authentication_required' | 'unavailable';
  runtimeInstanceId: string;
  readinessRevision: number;
  catalogRevision: string;
  modelIds: readonly string[];
  capturedAtMs: number;
}>;

export type ImageAttachmentRuntimeCurrent = Readonly<{
  runtimeKind: 'codex' | 'claude';
  runtimeInstanceId: string;
  readinessRevision: number;
  catalogRevision: string;
}>;

export function runtimeCapabilityCatalogRevision(models: readonly CodexModelOption[]): string {
  return digestCanonical(
    models.map(({ id, displayName, description, efforts, defaultEffort }) => ({
      id,
      displayName,
      description,
      efforts: efforts ?? null,
      defaultEffort: defaultEffort ?? null,
    })),
  );
}

export type ImageAttachmentSelectionIdentity = Readonly<{
  taskId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  runtimeKind: 'codex';
  runtimeInstanceId: string;
  readinessRevision: number;
  catalogRevision: string;
}>;

export type ProviderImageAttachmentCapabilitySnapshot = Readonly<{
  runtimeKind: 'provider';
  connectionId: string;
  providerId: string;
  modelId: string;
  value: boolean | null;
  revision: string;
  capturedAtMs: number;
}>;

export type ProviderImageAttachmentSelectionIdentity = Readonly<{
  taskId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  runtimeKind: 'provider_inline';
  capabilityRevision: string;
}>;

export type ProviderImageAttachmentCapabilityBinding = Readonly<{
  kind: 'provider_inline';
  snapshot: ProviderImageAttachmentCapabilitySnapshot;
  selectionIdentity: string;
}>;

export type CodexImageAttachmentCapabilityBinding = Readonly<{
  kind: 'codex_cli';
  snapshot: ImageAttachmentRuntimeSnapshot;
  selectionIdentity: string;
}>;

export type ImageAttachmentCapabilityBinding =
  CodexImageAttachmentCapabilityBinding | ProviderImageAttachmentCapabilityBinding;

export function buildImageAttachmentSelectionIdentity(
  selection: ImageAttachmentAcceptanceSelection,
  snapshot: ImageAttachmentRuntimeSnapshot,
): ImageAttachmentSelectionIdentity | null {
  const modelSelection = selection.modelSelection;
  if (
    snapshot.runtimeKind !== 'codex' ||
    selection.runtimeKind !== 'codex' ||
    modelSelection.connectionId !== BUILTIN_CODEX_CONNECTION_ID ||
    modelSelection.requestedProvider !== 'openai' ||
    modelSelection.requestedModel === null ||
    selection.model !== modelSelection.requestedModel
  )
    return null;
  return {
    taskId: selection.taskId,
    connectionId: modelSelection.connectionId,
    providerId: modelSelection.requestedProvider,
    modelId: modelSelection.requestedModel,
    runtimeKind: 'codex',
    runtimeInstanceId: snapshot.runtimeInstanceId,
    readinessRevision: snapshot.readinessRevision,
    catalogRevision: snapshot.catalogRevision,
  };
}

export function imageAttachmentSelectionIdentityDigest(
  identity: ImageAttachmentSelectionIdentity | ProviderImageAttachmentSelectionIdentity,
): string {
  return digestCanonical(identity);
}

export function buildProviderImageAttachmentSelectionIdentity(
  selection: ImageAttachmentAcceptanceSelection,
  snapshot: ProviderImageAttachmentCapabilitySnapshot,
): ProviderImageAttachmentSelectionIdentity | null {
  const modelSelection = selection.modelSelection;
  if (
    builtinRuntimeForModelSelection(modelSelection) !== null ||
    modelSelection.connectionId === null ||
    modelSelection.requestedProvider === null ||
    modelSelection.requestedModel === null ||
    modelSelection.connectionId !== snapshot.connectionId ||
    modelSelection.requestedProvider !== snapshot.providerId ||
    modelSelection.requestedModel !== snapshot.modelId
  )
    return null;
  return {
    taskId: selection.taskId,
    connectionId: snapshot.connectionId,
    providerId: snapshot.providerId,
    modelId: snapshot.modelId,
    runtimeKind: 'provider_inline',
    capabilityRevision: snapshot.revision,
  };
}

export function validateProviderImageAttachmentCapabilitySnapshot(input: {
  selection: ImageAttachmentAcceptanceSelection;
  snapshot: ProviderImageAttachmentCapabilitySnapshot;
  expectedSelectionIdentity: string;
  nowMs: number;
}): boolean {
  if (!freshProviderCapability(input.snapshot, input.nowMs) || input.snapshot.value !== true)
    return false;
  const identity = buildProviderImageAttachmentSelectionIdentity(input.selection, input.snapshot);
  return (
    identity !== null &&
    imageAttachmentSelectionIdentityDigest(identity) === input.expectedSelectionIdentity
  );
}

export function validateProviderImageAttachmentCurrent(input: {
  selection: ImageAttachmentAcceptanceSelection;
  binding: ProviderImageAttachmentCapabilityBinding;
  current: ProviderImageAttachmentCapabilitySnapshot;
  nowMs: number;
}): boolean {
  const expected = buildProviderImageAttachmentSelectionIdentity(
    input.selection,
    input.binding.snapshot,
  );
  const actual = buildProviderImageAttachmentSelectionIdentity(input.selection, input.current);
  return (
    expected !== null &&
    actual !== null &&
    freshProviderCapability(input.current, input.nowMs) &&
    input.current.value === true &&
    input.current.revision === input.binding.snapshot.revision &&
    imageAttachmentSelectionIdentityDigest(expected) === input.binding.selectionIdentity &&
    imageAttachmentSelectionIdentityDigest(actual) === input.binding.selectionIdentity
  );
}

export function toPublicProviderImageAttachmentCapability(
  selection: ImageAttachmentAcceptanceSelection,
  snapshot: ProviderImageAttachmentCapabilitySnapshot,
  nowMs: number,
): ImageAttachmentCapability {
  const identity = buildProviderImageAttachmentSelectionIdentity(selection, snapshot);
  const selectionIdentity =
    identity === null ? '' : imageAttachmentSelectionIdentityDigest(identity);
  if (
    !validateProviderImageAttachmentCapabilitySnapshot({
      selection,
      snapshot,
      expectedSelectionIdentity: selectionIdentity,
      nowMs,
    })
  )
    return {
      status: 'unsupported',
      reason:
        snapshot.value === false
          ? '選択中のモデルは画像入力に対応していません'
          : snapshot.value === null
            ? '選択中のモデルは画像入力対応を確認できません'
            : '画像入力の準備状況が変わりました。もう一度確認してください',
      selectionIdentity: null,
    };
  return { status: 'supported', reason: null, selectionIdentity };
}

function freshProviderCapability(
  snapshot: ProviderImageAttachmentCapabilitySnapshot,
  nowMs: number,
): boolean {
  return (
    Number.isSafeInteger(nowMs) &&
    nowMs >= 0 &&
    Number.isSafeInteger(snapshot.capturedAtMs) &&
    snapshot.capturedAtMs >= 0 &&
    nowMs >= snapshot.capturedAtMs &&
    nowMs - snapshot.capturedAtMs <= IMAGE_ATTACHMENT_CAPABILITY_MAX_AGE_MS
  );
}

export function validateImageAttachmentCapabilitySnapshot(input: {
  selection: ImageAttachmentAcceptanceSelection;
  snapshot: ImageAttachmentRuntimeSnapshot;
  current: ImageAttachmentRuntimeCurrent;
  expectedSelectionIdentity: string;
  nowMs: number;
}): boolean {
  const { snapshot, current } = input;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) return false;
  if (!snapshot.available || snapshot.readiness !== 'ready') return false;
  if (
    !Number.isSafeInteger(snapshot.capturedAtMs) ||
    input.nowMs < snapshot.capturedAtMs ||
    input.nowMs - snapshot.capturedAtMs > IMAGE_ATTACHMENT_CAPABILITY_MAX_AGE_MS
  )
    return false;
  if (
    current.runtimeKind !== 'codex' ||
    snapshot.runtimeInstanceId !== current.runtimeInstanceId ||
    snapshot.readinessRevision !== current.readinessRevision ||
    snapshot.catalogRevision !== current.catalogRevision
  )
    return false;
  const identity = buildImageAttachmentSelectionIdentity(input.selection, snapshot);
  return (
    identity !== null &&
    snapshot.modelIds.includes(identity.modelId) &&
    imageAttachmentSelectionIdentityDigest(identity) === input.expectedSelectionIdentity
  );
}

export function toPublicImageAttachmentCapability(
  selection: ImageAttachmentAcceptanceSelection,
  snapshot: ImageAttachmentRuntimeSnapshot,
  current: ImageAttachmentRuntimeCurrent,
  nowMs: number,
): ImageAttachmentCapability {
  const identity = buildImageAttachmentSelectionIdentity(selection, snapshot);
  const expectedSelectionIdentity =
    identity === null ? '' : imageAttachmentSelectionIdentityDigest(identity);
  if (
    !validateImageAttachmentCapabilitySnapshot({
      selection,
      snapshot,
      current,
      expectedSelectionIdentity,
      nowMs,
    })
  )
    return {
      status: 'unsupported',
      reason: imageAttachmentCapabilityReason(selection.modelSelection, snapshot),
      selectionIdentity: null,
    };
  return {
    status: 'supported',
    reason: null,
    selectionIdentity: expectedSelectionIdentity,
  };
}

function imageAttachmentCapabilityReason(
  selection: ModelSelection,
  snapshot: ImageAttachmentRuntimeSnapshot,
): string {
  if (
    selection.connectionId !== BUILTIN_CODEX_CONNECTION_ID ||
    selection.requestedProvider !== 'openai'
  )
    return '画像添付はCodex CLI Runtimeで利用できます';
  if (!snapshot.available) return 'Codex CLIが見つかりません';
  if (snapshot.readiness === 'authentication_required') return 'Codex CLIの認証が必要です';
  if (snapshot.readiness !== 'ready') return 'Codex CLIを利用できません';
  return '画像添付の準備状況が変わりました。もう一度確認してください';
}
