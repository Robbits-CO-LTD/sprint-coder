import { createHash } from 'node:crypto';

export const CAPTURE_WIRE_VERSION = 1;
export const CAPTURE_FRAME_LIMIT = 16 * 1024;
export const CAPTURE_STREAM_LIMIT = 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
const zero = '0'.repeat(64);
const events = new Set([
  'session',
  'preflight_started',
  'preflight_passed',
  'round_started',
  'parsed',
  'observation',
  'action_result',
  'native_started',
  'native_finished',
  'egress_authorized',
  'cost_limit_bound',
  'stop_requested',
  'stop_acknowledged',
]);
const numbers = new Set([
  'round',
  'revision',
  'responseBytes',
  'latencyMs',
  'imageBytes',
  'treeBytes',
  'inputAttemptCount',
  'cancelEpoch',
  'policyEpoch',
  'maxRounds',
]);
const digests = new Set([
  'sessionDigest',
  'appDigest',
  'windowDigest',
  'manifestDigest',
  'bindingDigest',
  'actionDigest',
  'responseDigest',
  'imageDigest',
  'treeDigest',
  'reasonDigest',
  'requestDigest',
  // Consent and cost bounds, plus the binding identity the round digests must resolve to.
  'egressDigest',
  'costLimitDigest',
  'connectionIdDigest',
  'modelIdDigest',
  'endpointDigest',
  'catalogDigest',
]);
const flags = [
  'isOpenRouter',
  'nativeAcknowledged',
  'ttlVerified',
  'selectedFromCurrentTask',
  'fallbackUsed',
  'credentialChanged',
];
const actions = new Set([
  'invoke',
  'set_text',
  'select',
  'toggle',
  'expand_collapse',
  'scroll',
  'click',
  'type',
  'key',
  'wait',
  'finish',
]);
const results = new Set(['completed', 'rejected', 'paused', 'unknown_effect', 'canceled']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = () => {
  throw new Error('Computer Use capture wire is invalid');
};
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
}
function validatePayload(kind, payload) {
  if (kind === 'hello') {
    exact(payload, [
      'pid',
      'parentPid',
      'platform',
      'sourceCommit',
      'nativeManifestDigest',
      'packaged',
      'packageReady',
    ]);
    if (
      ![payload.pid, payload.parentPid].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !['darwin', 'win32', 'linux'].includes(payload.platform) ||
      !/^[a-f0-9]{40}$/u.test(payload.sourceCommit) ||
      !digestPattern.test(payload.nativeManifestDigest) ||
      typeof payload.packaged !== 'boolean' ||
      typeof payload.packageReady !== 'boolean'
    )
      fail();
  } else if (kind === 'event') {
    if (!payload || !events.has(payload.type) || !digestPattern.test(payload.sessionDigest)) fail();
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'type') continue;
      if (digests.has(key) && typeof value === 'string' && digestPattern.test(value)) continue;
      if (numbers.has(key) && Number.isSafeInteger(value) && value >= 0) continue;
      if (flags.includes(key) && typeof value === 'boolean') continue;
      if (key === 'platform' && ['darwin', 'win32'].includes(value)) continue;
      if (key === 'actionClass' && actions.has(value)) continue;
      if (key === 'result' && results.has(value)) continue;
      fail();
    }
  } else if (kind === 'end') {
    exact(payload, ['valid']);
    if (typeof payload.valid !== 'boolean') fail();
  } else fail();
}

/** Hash chaining detects damage/order changes. It is not authentication of a producer. */
export function createCaptureEncoder(nonce) {
  if (!digestPattern.test(nonce)) fail();
  let sequence = 0;
  let previousDigest = zero;
  let bytes = 0;
  let ended = false;
  return (kind, payload) => {
    if (ended) fail();
    validatePayload(kind, payload);
    if ((sequence === 0) !== (kind === 'hello')) fail();
    const body = { version: CAPTURE_WIRE_VERSION, nonce, sequence, previousDigest, kind, payload };
    const digest = hash(JSON.stringify(body));
    const frame = `${JSON.stringify({ ...body, digest })}\n`;
    bytes += Buffer.byteLength(frame);
    if (Buffer.byteLength(frame) > CAPTURE_FRAME_LIMIT || bytes > CAPTURE_STREAM_LIMIT) fail();
    sequence += 1;
    previousDigest = digest;
    ended = kind === 'end';
    return frame;
  };
}

export function createCaptureDecoder(nonce, onFrame) {
  if (!digestPattern.test(nonce)) fail();
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let sequence = 0;
  let previousDigest = zero;
  let invalid = false;
  let ended = false;
  return {
    push(chunk) {
      if (invalid) fail();
      try {
        bytes += chunk.length;
        if (bytes > CAPTURE_STREAM_LIMIT) fail();
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const end = pending.indexOf(10);
          if (end < 0) break;
          if (end + 1 > CAPTURE_FRAME_LIMIT) fail();
          const line = pending.subarray(0, end).toString('utf8');
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            fail();
          }
          exact(frame, [
            'version',
            'nonce',
            'sequence',
            'previousDigest',
            'kind',
            'payload',
            'digest',
          ]);
          // The producer uses one canonical serialization. Duplicated keys and hidden payloads
          // cannot survive a parse-and-reencode equality check.
          if (
            JSON.stringify(frame) !== line ||
            frame.version !== CAPTURE_WIRE_VERSION ||
            frame.nonce !== nonce ||
            frame.sequence !== sequence ||
            frame.previousDigest !== previousDigest ||
            (sequence === 0) !== (frame.kind === 'hello')
          )
            fail();
          if (ended) fail();
          validatePayload(frame.kind, frame.payload);
          const { digest, ...body } = frame;
          if (hash(JSON.stringify(body)) !== digest) fail();
          previousDigest = digest;
          sequence += 1;
          if (frame.kind === 'end') {
            ended = true;
            if (!frame.payload.valid) fail();
          }
          pending = pending.subarray(end + 1);
          onFrame(frame);
        }
        if (pending.length > CAPTURE_FRAME_LIMIT) fail();
      } catch {
        invalid = true;
        pending = Buffer.alloc(0);
        fail();
      }
    },
    finish() {
      if (invalid || pending.length !== 0 || sequence === 0 || !ended) fail();
      return { frameCount: sequence, eventChainDigest: previousDigest };
    },
  };
}
