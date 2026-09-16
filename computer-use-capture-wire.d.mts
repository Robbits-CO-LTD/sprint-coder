export type CapturePayload = Record<string, string | number | boolean>;
export type CaptureFrame = {
  version: 1;
  nonce: string;
  sequence: number;
  previousDigest: string;
  kind: 'hello' | 'event' | 'end';
  payload: CapturePayload;
  digest: string;
};
export const CAPTURE_WIRE_VERSION: 1;
export const CAPTURE_FRAME_LIMIT: number;
export const CAPTURE_STREAM_LIMIT: number;
export function createCaptureEncoder(
  nonce: string,
): (kind: 'hello' | 'event' | 'end', payload: CapturePayload) => string;
export function createCaptureDecoder(
  nonce: string,
  onFrame: (frame: CaptureFrame) => void,
): {
  push(chunk: Buffer): void;
  finish(): { frameCount: number; eventChainDigest: string };
};
