import { createHash } from 'node:crypto';
import type { ImageAttachmentMimeType, ProviderExecutionRequest } from '@sprint-coder/contracts';
import { digestCanonical } from './context-compiler';
import { canonicalizeProviderToolImage } from './image-attachment-store';
import type { ProviderSafeFailureCause } from './provider-failure-diagnostic';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

type VerifiedToolImage = Readonly<{
  toolCallId: string;
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
}>;

type ToolImageAcceptance = Readonly<{
  toolMessage: ProviderExecutionRequest['messages'][number];
  accepted: boolean;
}>;

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

function fixedToolFailure(
  toolCallId: string,
  toolName: string,
  code: 'INVALID_TOOL_RESULT' | 'VIEW_IMAGE_NOT_PERMITTED',
  message: string,
): ProviderExecutionRequest['messages'][number] {
  return {
    role: 'tool',
    toolCallId,
    toolName,
    content: JSON.stringify({ ok: false, error: { code, message } }),
  };
}

export function toolImageNotPermittedMessage(
  toolCallId: string,
  toolName = 'view_image',
): ProviderExecutionRequest['messages'][number] {
  return fixedToolFailure(
    toolCallId,
    toolName,
    'VIEW_IMAGE_NOT_PERMITTED',
    '画像の利用は許可されていません。',
  );
}

function invalidImageMessage(
  toolCallId: string,
  toolName: string,
): ProviderExecutionRequest['messages'][number] {
  return fixedToolFailure(
    toolCallId,
    toolName,
    'INVALID_TOOL_RESULT',
    'view_image returned an invalid image result',
  );
}

async function parseSuccessfulToolImageResult(
  toolCallId: string,
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
    mimeType !== 'image/png' ||
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
    dataUrl.length > MAX_DATA_URL_CHARS
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
    const canonical = await canonicalizeProviderToolImage(bytes);
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
  return Object.freeze({ toolCallId, mimeType, byteLength, sha256, base64 });
}

export class ToolImageBridge {
  private pendingImage: VerifiedToolImage | null = null;

  async acceptToolResult(input: {
    toolCallId: string;
    toolName: string;
    result: unknown;
  }): Promise<ToolImageAcceptance> {
    if (input.toolName !== 'view_image')
      return Object.freeze({
        toolMessage: invalidImageMessage(input.toolCallId, input.toolName),
        accepted: false,
      });
    try {
      const image = await parseSuccessfulToolImageResult(input.toolCallId, input.result);
      if (image === null)
        return Object.freeze({
          toolMessage: invalidImageMessage(input.toolCallId, input.toolName),
          accepted: false,
        });
      this.pendingImage = image;
      return Object.freeze({
        toolMessage: imageMetadataMessage(input.toolCallId, input.toolName, image),
        accepted: true,
      });
    } catch {
      return Object.freeze({
        toolMessage: invalidImageMessage(input.toolCallId, input.toolName),
        accepted: false,
      });
    }
  }

  discardPending(): void {
    this.pendingImage = null;
  }

  consumeForNextDispatch(input: {
    baseMessages: ProviderExecutionRequest['messages'];
    directImages: readonly ToolImageAuditInput[];
  }): Readonly<{
    messages: ProviderExecutionRequest['messages'];
    hasToolImage: boolean;
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
        id: id ?? `ordinal:${ordinal}`,
        ordinal,
        mimeType,
        byteLength,
        sha256,
      })),
      ...(toolImage === null
        ? []
        : [
            {
              id: `tool:${toolImage.toolCallId}`,
              mimeType: toolImage.mimeType,
              byteLength: toolImage.byteLength,
              sha256: toolImage.sha256,
            },
          ]),
    ];
    return Object.freeze({
      messages,
      hasToolImage: toolImage !== null,
      audit: Object.freeze({
        manifestDigest: digestCanonical(manifest),
        byteCount:
          input.directImages.reduce((total, image) => total + image.byteLength, 0) +
          (toolImage?.byteLength ?? 0),
      }),
    });
  }
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
