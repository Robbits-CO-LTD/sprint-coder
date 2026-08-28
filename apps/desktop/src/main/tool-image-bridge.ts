import { createHash } from 'node:crypto';
import type { ImageAttachmentMimeType, ProviderExecutionRequest } from '@sprint-coder/contracts';
import { digestCanonical } from './context-compiler';
import { canonicalizeImage } from './image-attachment-store';
import type { ProviderSafeFailureCause } from './provider-failure-diagnostic';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type VerifiedToolImage = Readonly<{
  mimeType: ImageAttachmentMimeType;
  byteLength: number;
  sha256: string;
  base64: string;
}>;

export type ToolImageAuditInput = Readonly<{
  id?: string;
  mimeType: ImageAttachmentMimeType;
  byteLength: number;
  sha256: string;
  base64: string;
}>;

type ToolImageAcceptance = Readonly<{
  toolMessage: ProviderExecutionRequest['messages'][number];
  image?: VerifiedToolImage;
}>;

function supportedMimeType(value: string): value is ImageAttachmentMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

function imageMetadataMessage(
  toolCallId: string,
  toolName: string,
  image: VerifiedToolImage,
): ProviderExecutionRequest['messages'][number] {
  return {
    role: 'tool',
    toolCallId,
    toolName,
    content: JSON.stringify({
      ok: true,
      result: {
        mimeType: image.mimeType,
        byteLength: image.byteLength,
        sha256: image.sha256,
      },
    }),
  };
}

function invalidImageMessage(
  toolCallId: string,
  toolName: string,
): ProviderExecutionRequest['messages'][number] {
  return {
    role: 'tool',
    toolCallId,
    toolName,
    content: JSON.stringify({
      ok: false,
      error: {
        code: 'INVALID_TOOL_RESULT',
        message: 'view_image returned an invalid image result',
      },
    }),
  };
}

/** Validates raw view_image output before any result serialization can retain the data URL. */
export async function parseSuccessfulToolImageResult(
  result: unknown,
): Promise<VerifiedToolImage | null> {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const mimeType = record['mimeType'];
  const byteLength = record['byteLength'];
  const sha256 = record['sha256'];
  const dataUrl = record['dataUrl'];
  if (
    typeof mimeType !== 'string' ||
    !supportedMimeType(mimeType) ||
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    typeof sha256 !== 'string' ||
    typeof dataUrl !== 'string'
  )
    return null;
  if (
    byteLength < 1 ||
    byteLength > MAX_IMAGE_BYTES ||
    !SHA256.test(sha256) ||
    dataUrl.length > MAX_IMAGE_BYTES * 2
  )
    return null;
  const match = DATA_URL.exec(dataUrl);
  if (match === null || match[1] !== mimeType) return null;
  const base64 = match[2]!;
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.byteLength !== byteLength ||
    bytes.toString('base64') !== base64 ||
    createHash('sha256').update(bytes).digest('hex') !== sha256
  )
    return null;
  try {
    const canonical = await canonicalizeImage(bytes, { lossless: true });
    if (
      canonical.mimeType !== mimeType ||
      canonical.sha256 !== sha256 ||
      canonical.bytes.byteLength !== byteLength ||
      !canonical.bytes.equals(bytes)
    )
      return null;
  } catch {
    return null;
  }
  return Object.freeze({ mimeType, byteLength, sha256, base64 });
}

export class ToolImageBridge {
  private pendingImage: VerifiedToolImage | null = null;

  async acceptToolResult(input: {
    toolCallId: string;
    toolName: string;
    result: unknown;
  }): Promise<ToolImageAcceptance> {
    if (input.toolName !== 'view_image')
      return {
        toolMessage: {
          role: 'tool',
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          content: JSON.stringify({ ok: true, result: input.result }),
        },
      };
    const image = await parseSuccessfulToolImageResult(input.result);
    if (image === null)
      return Object.freeze({
        toolMessage: invalidImageMessage(input.toolCallId, input.toolName),
      });
    this.pendingImage = image;
    return Object.freeze({
      toolMessage: imageMetadataMessage(input.toolCallId, input.toolName, image),
      image,
    });
  }

  discardPending(): void {
    this.pendingImage = null;
  }

  consumeForNextDispatch(input: {
    baseMessages: ProviderExecutionRequest['messages'];
    directImages: readonly ToolImageAuditInput[];
  }): Readonly<{
    messages: ProviderExecutionRequest['messages'];
    toolImage?: VerifiedToolImage;
    audit: Readonly<{ manifestDigest: string; byteCount: number }>;
  }> {
    const toolImage = this.pendingImage;
    this.pendingImage = null;
    const messages =
      toolImage === null
        ? input.baseMessages
        : [
            ...input.baseMessages,
            {
              role: 'user' as const,
              content: 'A workspace image returned by view_image is attached below.',
              inlineImages: [{ mimeType: toolImage.mimeType, base64: toolImage.base64 }],
            },
          ];
    const manifest = [
      ...input.directImages.map(({ id, mimeType, byteLength, sha256 }, ordinal) => ({
        directAttachment: { id: id ?? `ordinal:${ordinal}`, ordinal, mimeType, byteLength, sha256 },
      })),
      ...(toolImage === null
        ? []
        : [
            {
              toolImage: {
                mimeType: toolImage.mimeType,
                byteLength: toolImage.byteLength,
                sha256: toolImage.sha256,
              },
            },
          ]),
    ];
    return Object.freeze({
      messages,
      ...(toolImage === null ? {} : { toolImage }),
      audit: Object.freeze({
        manifestDigest: digestCanonical(manifest),
        byteCount:
          input.directImages.reduce((total, image) => total + image.byteLength, 0) +
          (toolImage?.byteLength ?? 0),
      }),
    });
  }
}

export class ToolImageDispatchDeniedError extends Error {
  readonly code = 'TOOL_IMAGE_DISPATCH_DENIED';

  constructor() {
    super('Verified tool image cannot be dispatched to the current Provider');
    this.name = 'ToolImageDispatchDeniedError';
  }
}

export function assertVerifiedToolImageDispatch(input: {
  connection: Readonly<{ managedLocal: boolean; localEndpointTrusted: boolean }>;
  acceptedCapability: Readonly<{ value: boolean | null; revision: string; modelId: string }>;
  currentCapability: Readonly<{ value: boolean | null; revision: string; modelId: string }>;
}): void {
  if (
    !input.connection.managedLocal ||
    !input.connection.localEndpointTrusted ||
    input.acceptedCapability.value !== true ||
    input.currentCapability.value !== true ||
    input.acceptedCapability.revision !== input.currentCapability.revision ||
    input.acceptedCapability.modelId !== input.currentCapability.modelId
  )
    throw new ToolImageDispatchDeniedError();
}

export async function dispatchVerifiedToolImage<T>(input: {
  connection: Readonly<{ managedLocal: boolean; localEndpointTrusted: boolean }>;
  acceptedCapability: Readonly<{ value: boolean | null; revision: string; modelId: string }>;
  currentCapability: Readonly<{ value: boolean | null; revision: string; modelId: string }>;
  execute: () => Promise<T>;
}): Promise<T> {
  assertVerifiedToolImageDispatch(input);
  return input.execute();
}

export function toolImageEgressDenialCause(hasModelLease: boolean): ProviderSafeFailureCause {
  return Object.freeze({
    failureStage: 'provider_error',
    category: 'invalid_request',
    retryable: false,
    providerCode: 'policy_denied',
    modelPreparation: hasModelLease ? 'completed' : 'not_required',
  });
}
