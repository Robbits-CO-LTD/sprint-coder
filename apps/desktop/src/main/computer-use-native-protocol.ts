import { randomBytes } from 'node:crypto';

export const COMPUTER_USE_NATIVE_PROTOCOL_VERSION = 1 as const;
export const COMPUTER_USE_NATIVE_API_VERSION = 1 as const;
export const COMPUTER_USE_NATIVE_NAPI_VERSION = 10 as const;
export const COMPUTER_USE_NATIVE_MAX_METADATA_BYTES = 64 * 1024;
export const COMPUTER_USE_NATIVE_MAX_BINARY_BYTES = 16 * 1024 * 1024;
export const COMPUTER_USE_NATIVE_MAX_FRAME_BYTES =
  COMPUTER_USE_NATIVE_MAX_METADATA_BYTES + COMPUTER_USE_NATIVE_MAX_BINARY_BYTES;
export const COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES = 68;
export const COMPUTER_USE_NATIVE_MAGIC = 0x31554353;

export type ComputerUseNativeMessageType =
  | 'handshake'
  | 'handshake_result'
  | 'probe'
  | 'probe_result'
  | 'observe'
  | 'observe_result'
  | 'dispatch'
  | 'dispatch_result'
  | 'cancel'
  | 'error';

const MESSAGE_TYPES: Readonly<Record<ComputerUseNativeMessageType, number>> = Object.freeze({
  handshake: 1,
  handshake_result: 2,
  probe: 3,
  probe_result: 4,
  observe: 5,
  observe_result: 6,
  dispatch: 7,
  dispatch_result: 8,
  cancel: 9,
  error: 10,
});
const MESSAGE_TYPES_BY_NUMBER = new Map(
  Object.entries(MESSAGE_TYPES).map(([name, value]) => [
    value,
    name as ComputerUseNativeMessageType,
  ]),
);

export type ComputerUseNativeFrameId = Readonly<{
  hex: string;
}>;

export type ComputerUseNativeFrame = Readonly<{
  messageType: ComputerUseNativeMessageType;
  flags: number;
  requestId: ComputerUseNativeFrameId;
  sessionId: ComputerUseNativeFrameId;
  cancelId: ComputerUseNativeFrameId | null;
  metadata: Buffer;
  binary: Buffer;
}>;

export function newComputerUseNativeFrameId(): ComputerUseNativeFrameId {
  return Object.freeze({ hex: randomBytes(16).toString('hex') });
}

export function parseComputerUseNativeFrameId(value: unknown): ComputerUseNativeFrameId | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const hex = (value as Record<string, unknown>)['hex'];
  if (typeof hex !== 'string' || !/^[a-f0-9]{32}$/u.test(hex)) return null;
  if (/^0+$/u.test(hex)) return null;
  return Object.freeze({ hex });
}

export function encodeComputerUseNativeFrame(frame: ComputerUseNativeFrame): Buffer {
  const messageType = MESSAGE_TYPES[frame.messageType];
  const requestId = parseComputerUseNativeFrameId(frame.requestId);
  const sessionId = parseComputerUseNativeFrameId(frame.sessionId);
  const cancelId = frame.cancelId === null ? null : parseComputerUseNativeFrameId(frame.cancelId);
  if (
    messageType === undefined ||
    requestId === null ||
    sessionId === null ||
    (frame.messageType === 'cancel' ? cancelId === null : cancelId !== null)
  )
    throw new Error('Invalid Computer Use native frame identity');
  if (!Number.isSafeInteger(frame.flags) || frame.flags < 0 || frame.flags > 0xffff_ffff)
    throw new Error('Invalid Computer Use native frame flags');
  if (
    frame.metadata.byteLength === 0 ||
    frame.metadata.byteLength > COMPUTER_USE_NATIVE_MAX_METADATA_BYTES
  )
    throw new Error('Computer Use native frame metadata exceeds the bounded limit');
  if (frame.binary.byteLength > COMPUTER_USE_NATIVE_MAX_BINARY_BYTES)
    throw new Error('Computer Use native frame binary exceeds the bounded limit');
  // The cancel-id slot must be zero for every non-cancel frame. An unsafe allocation both makes
  // our own decoder reject the frame and could disclose stale heap bytes to the helper.
  const result = Buffer.alloc(
    COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES + frame.metadata.byteLength + frame.binary.byteLength,
  );
  result.writeUInt32LE(COMPUTER_USE_NATIVE_MAGIC, 0);
  result.writeUInt16LE(COMPUTER_USE_NATIVE_PROTOCOL_VERSION, 4);
  result.writeUInt16LE(messageType, 6);
  result.writeUInt32LE(frame.flags, 8);
  Buffer.from(requestId.hex, 'hex').copy(result, 12);
  Buffer.from(sessionId.hex, 'hex').copy(result, 28);
  if (cancelId !== null) Buffer.from(cancelId.hex, 'hex').copy(result, 44);
  result.writeUInt32LE(frame.metadata.byteLength, 60);
  result.writeUInt32LE(frame.binary.byteLength, 64);
  frame.metadata.copy(result, COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES);
  frame.binary.copy(result, COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES + frame.metadata.byteLength);
  return result;
}

export function decodeComputerUseNativeFrame(value: unknown): ComputerUseNativeFrame {
  if (!Buffer.isBuffer(value) || value.byteLength < COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES)
    throw new Error('Computer Use native frame is truncated');
  if (value.readUInt32LE(0) !== COMPUTER_USE_NATIVE_MAGIC)
    throw new Error('Computer Use native frame magic mismatch');
  if (value.readUInt16LE(4) !== COMPUTER_USE_NATIVE_PROTOCOL_VERSION)
    throw new Error('Computer Use native frame protocol mismatch');
  const messageType = MESSAGE_TYPES_BY_NUMBER.get(value.readUInt16LE(6));
  if (messageType === undefined) throw new Error('Unknown Computer Use native message type');
  const metadataBytes = value.readUInt32LE(60);
  const binaryBytes = value.readUInt32LE(64);
  if (metadataBytes === 0 || metadataBytes > COMPUTER_USE_NATIVE_MAX_METADATA_BYTES)
    throw new Error('Computer Use native frame metadata exceeds the bounded limit');
  if (binaryBytes > COMPUTER_USE_NATIVE_MAX_BINARY_BYTES)
    throw new Error('Computer Use native frame binary exceeds the bounded limit');
  const expectedBytes = COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES + metadataBytes + binaryBytes;
  if (value.byteLength < expectedBytes) throw new Error('Computer Use native frame is truncated');
  if (value.byteLength > expectedBytes)
    throw new Error('Computer Use native frame length mismatch');
  const requestId = idFromBytes(value.subarray(12, 28));
  const sessionId = idFromBytes(value.subarray(28, 44));
  const cancelBytes = idFromBytes(value.subarray(44, 60), true);
  const cancelId = cancelBytes?.hex === '0'.repeat(32) ? null : cancelBytes;
  if (
    requestId === null ||
    sessionId === null ||
    (messageType === 'cancel' ? cancelId === null : cancelId !== null)
  )
    throw new Error('Computer Use native frame identity is invalid');
  return Object.freeze({
    messageType,
    flags: value.readUInt32LE(8),
    requestId,
    sessionId,
    cancelId,
    metadata: Buffer.from(
      value.subarray(
        COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES,
        COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES + metadataBytes,
      ),
    ),
    binary: Buffer.from(value.subarray(COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES + metadataBytes)),
  });
}

function idFromBytes(value: Buffer, allowZero = false): ComputerUseNativeFrameId | null {
  if (value.byteLength !== 16) return null;
  const hex = value.toString('hex');
  if (!allowZero && /^0+$/u.test(hex)) return null;
  return Object.freeze({ hex });
}

export function computerUseNativeMessageTypeValue(type: ComputerUseNativeMessageType): number {
  return MESSAGE_TYPES[type];
}
