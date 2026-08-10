import type {
  CodexModelOption,
  ImageAttachmentCapability,
  ModelSelection,
} from '@sprint-coder/contracts';
import { digestCanonical } from './context-compiler';
import { BUILTIN_CODEX_CONNECTION_ID } from './connection-identity';
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
  identity: ImageAttachmentSelectionIdentity,
): string {
  return digestCanonical(identity);
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
