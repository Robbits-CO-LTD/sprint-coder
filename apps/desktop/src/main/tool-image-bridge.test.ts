import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ToolImageBridge, toolImageEgressDenialCause } from './tool-image-bridge';
import { canonicalizeProviderToolImage } from './image-attachment-store';
import { digestCanonical } from './context-compiler';

type ImageResult = {
  path: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteLength: number;
  sha256: string;
  dataUrl: string;
};

async function canonicalPng(red: number): Promise<Buffer> {
  const source = await sharp({
    create: {
      width: 900,
      height: 700,
      channels: 3,
      background: { r: red, g: 40, b: 60 },
    },
  })
    .png()
    .toBuffer();
  return (await canonicalizeProviderToolImage(source)).bytes;
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
    const accepted = await new ToolImageBridge().acceptToolResult({
      toolCallId: 'call-canonical',
      toolName: 'view_image',
      result: imageResult(canonical),
    });
    expect(accepted).toMatchObject({ accepted: true });
    expect(JSON.stringify(accepted)).not.toContain(canonical.toString('base64'));
  });

  it.each(['jpeg', 'webp'] as const)(
    'accepts a %s workspace image after lossless tool canonicalization',
    async (format) => {
      const width = 128;
      const height = 96;
      const raw = Buffer.alloc(width * height * 3);
      for (let offset = 0; offset < raw.length; offset += 1) raw[offset] = (offset * 37) % 256;
      const sourcePipeline = sharp(raw, { raw: { width, height, channels: 3 } });
      const source =
        format === 'jpeg'
          ? await sourcePipeline.jpeg({ quality: 83 }).toBuffer()
          : await sourcePipeline.webp({ quality: 83 }).toBuffer();
      const canonical = await canonicalizeProviderToolImage(source);
      const second = await canonicalizeProviderToolImage(canonical.bytes);
      const bridge = new ToolImageBridge();
      const accepted = await bridge.acceptToolResult({
        toolCallId: `call-${format}`,
        toolName: 'view_image',
        result: imageResult(canonical.bytes, canonical.mimeType),
      });
      const dispatched = bridge.consumeForNextDispatch({
        baseMessages: [accepted.toolMessage],
        directImages: [],
      });

      expect(canonical.mimeType).toBe('image/png');
      expect(second.bytes).toEqual(canonical.bytes);
      expect(accepted.toolMessage.content).not.toContain(canonical.bytes.toString('base64'));
      expect(dispatched.messages.at(-1)).toMatchObject({
        role: 'user',
        inlineImages: [{ mimeType: 'image/png', base64: canonical.bytes.toString('base64') }],
      });
    },
  );

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

    for (const [, result] of cases) {
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
      id: 'direct-1',
      mimeType: 'image/png' as const,
      byteLength: directBytes.byteLength,
      sha256: createHash('sha256').update(directBytes).digest('hex'),
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
      manifestDigest: digestCanonical([
        {
          id: 'direct-1',
          ordinal: 0,
          mimeType: directImage.mimeType,
          byteLength: directImage.byteLength,
          sha256: directImage.sha256,
        },
        {
          id: 'tool:call-last',
          mimeType: 'image/png',
          byteLength: lastImage.byteLength,
          sha256: createHash('sha256').update(lastImage).digest('hex'),
        },
      ]),
    });
    expect(dispatched.hasToolImage).toBe(true);

    const followingRound = bridge.consumeForNextDispatch({
      baseMessages,
      directImages: [directImage],
    });
    expect(followingRound.messages).toEqual(baseMessages);
    expect(JSON.stringify(followingRound.messages)).not.toContain(lastImage.toString('base64'));
    expect(followingRound.audit).toMatchObject({ byteCount: directImage.byteLength });
    expect(followingRound.hasToolImage).toBe(false);
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
