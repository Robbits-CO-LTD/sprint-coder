import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  ToolImageBridge,
  dispatchVerifiedToolImage,
  parseSuccessfulToolImageResult,
  toolImageEgressDenialCause,
} from './tool-image-bridge';

type ImageResult = {
  path: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteLength: number;
  sha256: string;
  dataUrl: string;
};

async function canonicalPng(red: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 900,
      height: 700,
      channels: 3,
      background: { r: red, g: 40, b: 60 },
    },
  })
    .png()
    .toBuffer();
}

function imageResult(bytes: Buffer, mimeType: ImageResult['mimeType'] = 'image/png'): ImageResult {
  return {
    path: 'fixture.png',
    mimeType,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
  };
}

describe('tool image bridge', () => {
  it('accepts only a fully canonical successful view_image result', async () => {
    const canonical = await canonicalPng(20);
    await expect(parseSuccessfulToolImageResult(imageResult(canonical))).resolves.toEqual({
      mimeType: 'image/png',
      byteLength: canonical.byteLength,
      sha256: createHash('sha256').update(canonical).digest('hex'),
      base64: canonical.toString('base64'),
    });
  });

  it('rejects malformed and noncanonical results without retaining their Base64', async () => {
    const canonical = await canonicalPng(30);
    const valid = imageResult(canonical);
    const appended = Buffer.concat([canonical, Buffer.from('TOOL_IMAGE_TRAILING_SENTINEL')]);
    const cases: Array<[string, ImageResult]> = [
      [
        'noncanonical Base64',
        { ...valid, dataUrl: valid.dataUrl.replace(';base64,', ';base64,\n') },
      ],
      ['malformed Base64', { ...valid, dataUrl: 'data:image/png;base64,%%%' }],
      ['zero declared length', { ...valid, byteLength: 0 }],
      ['declared length mismatch', { ...valid, byteLength: canonical.byteLength + 1 }],
      ['SHA-256 mismatch', { ...valid, sha256: '0'.repeat(64) }],
      [
        'result MIME and data URL MIME mismatch',
        { ...valid, dataUrl: valid.dataUrl.replace('image/png', 'image/jpeg') },
      ],
      [
        'MIME and decoded pixels mismatch',
        {
          ...valid,
          mimeType: 'image/jpeg',
          dataUrl: valid.dataUrl.replace('image/png', 'image/jpeg'),
        },
      ],
      ['trailing payload', imageResult(appended)],
      ['non-image bytes', imageResult(Buffer.from('not an image'))],
    ];

    for (const [name, result] of cases) {
      expect(await parseSuccessfulToolImageResult(result), name).toBeNull();
      const accepted = await new ToolImageBridge().acceptToolResult({
        toolCallId: 'call-invalid-image',
        toolName: 'view_image',
        result,
      });
      expect(accepted.toolMessage).toMatchObject({
        role: 'tool',
        toolCallId: 'call-invalid-image',
        toolName: 'view_image',
        content: expect.stringContaining('INVALID_TOOL_RESULT'),
      });
      expect(JSON.stringify(accepted)).not.toContain(result.dataUrl);
      expect(JSON.stringify(accepted)).not.toContain('base64,');
    }
  });

  it('uses only the last successful tool image once and keeps tool results metadata-only', async () => {
    const firstImage = await canonicalPng(70);
    const lastImage = await canonicalPng(120);
    const directBytes = Buffer.from('direct-image-bytes');
    const directImage = {
      mimeType: 'image/png' as const,
      byteLength: directBytes.byteLength,
      sha256: createHash('sha256').update(directBytes).digest('hex'),
      base64: directBytes.toString('base64'),
    };
    const bridge = new ToolImageBridge();
    const first = await bridge.acceptToolResult({
      toolCallId: 'call-first',
      toolName: 'view_image',
      result: imageResult(firstImage),
    });
    const last = await bridge.acceptToolResult({
      toolCallId: 'call-last',
      toolName: 'view_image',
      result: imageResult(lastImage),
    });
    const invalidAfterSuccess = await bridge.acceptToolResult({
      toolCallId: 'call-invalid',
      toolName: 'view_image',
      result: {
        ...imageResult(lastImage),
        dataUrl: 'data:image/png;base64,LEAK_SENTINEL',
      },
    });
    const nonImageAfterSuccess = await bridge.acceptToolResult({
      toolCallId: 'call-read',
      toolName: 'read_file',
      result: { path: 'notes.txt', content: 'ordinary tool result' },
    });
    const baseMessages = [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [
          { callId: 'call-first', name: 'view_image', input: { path: 'first.png' } },
          { callId: 'call-last', name: 'view_image', input: { path: 'last.png' } },
          { callId: 'call-invalid', name: 'view_image', input: { path: 'invalid.png' } },
          { callId: 'call-read', name: 'read_file', input: { path: 'notes.txt' } },
        ],
      },
      first.toolMessage,
      last.toolMessage,
      invalidAfterSuccess.toolMessage,
      nonImageAfterSuccess.toolMessage,
    ];
    const immutableBase = structuredClone(baseMessages);
    const dispatched = bridge.consumeForNextDispatch({ baseMessages, directImages: [directImage] });

    expect(baseMessages).toEqual(immutableBase);
    expect(dispatched.messages.map(({ role }) => role)).toEqual([
      'assistant',
      'tool',
      'tool',
      'tool',
      'tool',
      'user',
    ]);
    expect(dispatched.messages.at(-1)).toMatchObject({
      role: 'user',
      inlineImages: [
        expect.objectContaining({
          mimeType: 'image/png',
          base64: lastImage.toString('base64'),
        }),
      ],
    });
    expect(first.toolMessage.content).not.toContain(firstImage.toString('base64'));
    expect(last.toolMessage.content).not.toContain(lastImage.toString('base64'));
    expect(invalidAfterSuccess.toolMessage.content).not.toContain('LEAK_SENTINEL');
    expect(dispatched.audit).toMatchObject({
      byteCount: directImage.byteLength + lastImage.byteLength,
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const followingRound = bridge.consumeForNextDispatch({
      baseMessages,
      directImages: [directImage],
    });
    expect(followingRound.messages).toEqual(baseMessages);
    expect(JSON.stringify(followingRound.messages)).not.toContain(lastImage.toString('base64'));
    expect(followingRound.audit).toMatchObject({ byteCount: directImage.byteLength });
  });

  it.each([
    [
      'a remote connection',
      {
        connection: { managedLocal: false, localEndpointTrusted: false },
        acceptedCapability: { value: true, revision: 'revision-a', modelId: 'model-a' },
        currentCapability: { value: true, revision: 'revision-a', modelId: 'model-a' },
      },
    ],
    [
      'a capability that became unknown',
      {
        connection: { managedLocal: true, localEndpointTrusted: true },
        acceptedCapability: { value: true, revision: 'revision-a', modelId: 'model-a' },
        currentCapability: { value: null, revision: 'revision-a', modelId: 'model-a' },
      },
    ],
    [
      'a changed capability revision',
      {
        connection: { managedLocal: true, localEndpointTrusted: true },
        acceptedCapability: { value: true, revision: 'revision-a', modelId: 'model-a' },
        currentCapability: { value: true, revision: 'revision-b', modelId: 'model-a' },
      },
    ],
  ] as const)('denies %s before executing a tool image request', async (_name, input) => {
    const execute = vi.fn(async () => undefined);
    await expect(dispatchVerifiedToolImage({ ...input, execute })).rejects.toMatchObject({
      code: 'TOOL_IMAGE_DISPATCH_DENIED',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'not_required'],
    [true, 'completed'],
  ] as const)('maps egress denial safely before=%s', (hasModelLease, modelPreparation) => {
    expect(toolImageEgressDenialCause(hasModelLease)).toEqual({
      failureStage: 'provider_error',
      category: 'invalid_request',
      retryable: false,
      providerCode: 'policy_denied',
      modelPreparation,
    });
  });
});
