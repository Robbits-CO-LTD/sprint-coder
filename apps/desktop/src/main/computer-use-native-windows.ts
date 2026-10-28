import { parseNativeHandshake } from './computer-use-native-handshake';
import {
  computerUseNativeCloseReceiptSchema,
  type ComputerUseEligibility,
} from '@sprint-coder/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { win32 } from 'node:path';
import {
  COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES,
  COMPUTER_USE_NATIVE_MAGIC,
  COMPUTER_USE_NATIVE_PROTOCOL_VERSION,
  isKnownComputerUseNativeMessageType,
  COMPUTER_USE_NATIVE_MAX_BINARY_BYTES,
  COMPUTER_USE_NATIVE_MAX_METADATA_BYTES,
  decodeComputerUseNativeFrame,
  encodeComputerUseNativeFrame,
  newComputerUseNativeFrameId,
  type ComputerUseNativeFrame,
  type ComputerUseNativeFrameId,
  type ComputerUseNativeMessageType,
} from './computer-use-native-protocol';
import {
  COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
  COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
} from './computer-use-native-host';
import { computerUseWindowsSignerWaived } from './computer-use-acceptance-mode';
import type { ComputerUseNativeAddon } from './computer-use-native-types';

type NativeRecord = Record<string, unknown>;
export type WindowsComputerUseHelperTrust = Readonly<{
  binaryDigest: string;
  /**
   * `null` only in a `windows-unsigned-acceptance` build, where the compiled acceptance constant
   * waived Authenticode signer identity for a package that carries no signer.  Every other trust
   * field stays mandatory in both modes.
   */
  signerDigest: string | null;
  sourceCommit: string;
  /**
   * What the manifest declares about eligibility (ADR v2 D7). The helper's own handshake over the
   * pipe has to say the same thing: both declared and equal, or neither declared.
   */
  eligibility?: ComputerUseEligibility;
}>;
export type WindowsComputerUseHelperAttestation = Readonly<{
  imagePath: string;
  binaryDigest: string;
  signatureStatus: string;
  /** `null` is what Authenticode reports for an image that carries no signer certificate. */
  signerThumbprint: string | null;
}>;
type PendingRequest = Readonly<{
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  sessionId: ComputerUseNativeFrameId;
  /** Part of Stop's own lane, whose answer is what releases Main's input quarantine. */
  stopsSession: boolean;
  activityGeneration: number;
  helperGeneration: number;
  responseType: ComputerUseNativeMessageType;
  allowBinary: boolean;
}>;

export function createWindowsComputerUseNativeAddon(
  helperPath: string,
  probe: unknown,
  expectedTrust: WindowsComputerUseHelperTrust,
): ComputerUseNativeAddon {
  const client = new WindowsComputerUseHelperClient(helperPath, expectedTrust);
  return Object.freeze({
    probe: () => probe,
    // The packaged `--probe-json` response is the synchronous ABI manifest handshake. Every
    // stateful method additionally performs the same handshake over its random named pipe.
    handshake: () => probe,
    listTargets: () => client.call('probe', 'list_targets', {}, undefined, undefined),
    pickApplication: (input) =>
      client.call('probe', 'pick_application', record(input), undefined, undefined),
    listWindows: (input) => {
      const value = record(input);
      const identity = record(value['identity']);
      value['identityDigest'] = value['identityDigest'] ?? identity['identityDigest'];
      value['canonicalPath'] = value['canonicalPath'] ?? identity['executablePath'];
      value['executableDigest'] = value['executableDigest'] ?? identity['executableDigest'];
      value['signerDigest'] = identity['signerDigest'];
      return client.call('probe', 'list_windows', value, undefined, undefined);
    },
    startSession: (input) => {
      const value = record(input);
      const profile = record(value['profile']);
      const identity = record(profile['identity']);
      value['canonicalPath'] = profile['canonicalPath'];
      value['identityDigest'] = profile['identityDigest'];
      value['executableDigest'] = profile['executableDigest'];
      value['signerDigest'] = identity['signerDigest'];
      value['profileRevision'] = profile['revision'];
      return client.call(
        'probe',
        'start_session',
        value,
        stringField(value, 'sessionId'),
        undefined,
      );
    },
    observe: (input) => {
      const value = record(input);
      return client.call(
        'observe',
        'observe',
        value,
        stringField(value, 'sessionId'),
        stringField(value, 'requestId'),
      );
    },
    // The side-effect-free check that precedes every dispatch and answers with its one-time ticket
    // (ADR v2 S4-4 addendum 5). It travels as its own message type, so it can never be mistaken for
    // a dispatch, and under its own request key, so its answer is never confused with the
    // dispatch's cached result.
    preflight: (input) => {
      const value = record(input);
      return client.call(
        'preflight',
        'preflight',
        value,
        stringField(value, 'sessionId'),
        `preflight:${stringField(value, 'requestId')}`,
      );
    },
    // #785 T15-4w: the read of one node's value for `copy`. A probe operation of its own, under its own
    // request key, so its answer (which carries the value) is never confused with a dispatch's.
    readNodeValue: (input) => {
      const value = record(input);
      return client.call(
        'probe',
        'read_node_value',
        value,
        stringField(value, 'sessionId'),
        `readNodeValue:${stringField(value, 'requestId')}`,
      );
    },
    dispatch: (input) => {
      const value = record(input);
      return client.call(
        'dispatch',
        'dispatch',
        value,
        stringField(value, 'sessionId'),
        stringField(value, 'requestId'),
      );
    },
    cancel: (input) => {
      const value = record(input);
      const sessionId = stringField(value, 'sessionId');
      return client.call(
        'cancel',
        'cancel',
        value,
        sessionId,
        windowsStopRequestKey('cancel', sessionId, value['cancelEpoch']),
      );
    },
    close: (input) => {
      const value = record(input);
      const sessionId = stringField(value, 'sessionId');
      return client.call(
        'probe',
        'close_session',
        value,
        sessionId,
        windowsStopRequestKey('close', sessionId, value['cancelEpoch']),
      );
    },
    stopPendingStart: (input) => {
      const value = record(input);
      const sessionId = stringField(value, 'sessionId');
      if (
        Object.keys(value).length !== 1 ||
        sessionId.length === 0 ||
        Buffer.byteLength(sessionId, 'utf8') > 256
      )
        throw new Error('Invalid pending start stop request');
      // No epoch exists at the caller yet. Every logical retry gets a fresh wire request id.
      return client.call('probe', 'stop_pending_start', value, sessionId, undefined);
    },
    cancelUnsubmittedStart: (sessionId) => client.cancelUnsubmittedStart(sessionId),
  });
}

type StartTransmission = {
  sessionId: string;
  stopped: boolean;
  everSent: boolean;
  closed: boolean;
  attempts: Set<symbol>;
};

class WindowsComputerUseHelperClient {
  private child: ChildProcess | null = null;
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly transportSessionId = newComputerUseNativeFrameId();
  private idleShutdownPending = false;
  private activityGeneration = 0;
  private helperGeneration = 0;
  private readonly starts = new Map<string, StartTransmission>();

  constructor(
    private readonly helperPath: string,
    private readonly expectedTrust: WindowsComputerUseHelperTrust,
  ) {}

  shutdown(): void {
    this.abortTransport(new Error('Computer Use Windows helper closed'));
  }

  /**
   * The helper's lifetime ends with the session it owns, but Main re-sends an unconfirmed close for
   * the same session id while the first attempt is still in flight. Tearing the transport down as
   * soon as that first attempt settles would reject the re-send through `failAll` before the helper
   * could answer it, and the answer is the only thing that releases Main's input quarantine. So the
   * close only *arms* the teardown: whichever request settles last runs it, whether that is the
   * re-send, a per-request timeout, or any other request that was still on the wire. The helper
   * therefore ends with the session either way, without the teardown depending on the order in
   * which the helper answers. Today's helper serves one frame at a time
   * (`ServePipe` in computer-use-native/computer_use_windows_host.cc), so in practice that last
   * request is the re-send; the point of arming rather than checking once is that the teardown does
   * not rest on that serve loop staying single-threaded.
   *
   * A session started after that point disarms it again (`call`), because the teardown belongs to
   * the closed session and must not reach the helper the new session is running on. It disarms on
   * the attempt rather than on the answer: a start that the helper refuses therefore leaves an
   * idle, session-less helper behind until the next close arms the teardown again or Main exits
   * (the helper stops itself with its parent). That is the deliberate direction — re-arming on a
   * refused start would kill the helper of the session a refused *resume* is still running on.
   */
  shutdownWhenIdle(
    activity = this.activityGeneration,
    helper = this.helperGeneration,
    closingSession?: string,
  ): void {
    if (activity !== this.activityGeneration || helper !== this.helperGeneration) return;
    for (const [id, owner] of this.starts) {
      if (
        id !== closingSession &&
        !owner.closed &&
        (owner.everSent || (!owner.stopped && owner.attempts.size !== 0))
      )
        return;
    }
    this.idleShutdownPending = true;
    this.shutdownIfIdle();
  }

  private shutdownIfIdle(): void {
    if (this.idleShutdownPending && this.pending.size === 0 && this.connecting === null)
      this.shutdown();
  }

  private hasPendingStop(): boolean {
    for (const request of this.pending.values())
      if (
        request.stopsSession &&
        request.activityGeneration === this.activityGeneration &&
        request.helperGeneration === this.helperGeneration
      )
        return true;
    return false;
  }

  cancelUnsubmittedStart(sessionId: string): 'never_sent' | 'may_have_been_sent' | 'unknown' {
    const owner = this.starts.get(sessionId);
    if (owner === undefined) return 'unknown';
    owner.stopped = true;
    if (owner.everSent) return 'may_have_been_sent';
    // Main consumes this proof after a failed call has settled. Until then, keep it distinct
    // from an unknown ID; once no attempt remains, no continuation can still write.
    if (owner.attempts.size === 0 && this.starts.get(sessionId) === owner)
      this.starts.delete(sessionId);
    this.shutdownWhenIdle(this.activityGeneration, this.helperGeneration, sessionId);
    return 'never_sent';
  }

  async call(
    messageType: ComputerUseNativeMessageType,
    operation: string,
    input: NativeRecord,
    sessionKey: string | undefined,
    requestKey: string | undefined,
  ): Promise<unknown> {
    let owner: StartTransmission | undefined;
    let attempt: symbol | undefined;
    if (operation === 'start_session') {
      if (sessionKey === undefined) throw new Error('A native start needs a session id');
      owner = this.starts.get(sessionKey);
      if (owner?.stopped) throw new Error('Computer Use start canceled before send');
      if (owner === undefined) {
        if (this.starts.size >= 16) throw new Error('Unconfirmed native starts remain');
        owner = {
          sessionId: sessionKey,
          stopped: false,
          everSent: false,
          closed: false,
          attempts: new Set(),
        };
        this.starts.set(sessionKey, owner);
      }
      attempt = Symbol('native-start-send');
      owner.attempts.add(attempt);
      this.activityGeneration += 1;
      this.idleShutdownPending = false;
    }
    const closes = operation === 'close_session' || operation === 'stop_pending_start';
    if (closes && sessionKey !== undefined) {
      const closing = this.starts.get(sessionKey);
      if (closing !== undefined) closing.stopped = true;
    }
    const activity = this.activityGeneration;
    let helper: number | undefined;
    try {
      await this.ensureConnected();
      helper = this.helperGeneration;
      if (owner !== undefined) {
        if (owner.stopped || this.starts.get(owner.sessionId) !== owner)
          throw new Error('Computer Use start canceled before send');
      }
      const result = await this.sendConnected(
        messageType,
        { ...input, operation },
        sessionKey === undefined
          ? this.transportSessionId
          : frameIdFromText(`session:${sessionKey}`),
        requestKey === undefined
          ? newComputerUseNativeFrameId()
          : frameIdFromText(`request:${requestKey}`),
        operationTimeoutMilliseconds(operation),
        isComputerUseStopOperation(operation),
        owner === undefined
          ? undefined
          : () => {
              const sending = owner;
              if (sending.stopped || this.starts.get(sending.sessionId) !== sending)
                throw new Error('Computer Use start canceled before send');
              // A synchronous/partial write failure is still a possible native submission.
              sending.everSent = true;
            },
      );
      if (closes && sessionKey !== undefined) {
        const receipt = computerUseNativeCloseReceiptSchema.safeParse(result);
        const closing = this.starts.get(sessionKey);
        if (closing !== undefined && receipt.success && receipt.data.sessionId === sessionKey) {
          closing.closed = true;
          if (closing.attempts.size === 0) this.starts.delete(sessionKey);
        }
      }
      return result;
    } finally {
      if (owner !== undefined && attempt !== undefined) {
        owner.attempts.delete(attempt);
        if (
          owner.attempts.size === 0 &&
          (owner.closed || (owner.stopped && !owner.everSent)) &&
          this.starts.get(owner.sessionId) === owner
        )
          this.starts.delete(owner.sessionId);
      }
      if (closes && helper !== undefined) this.shutdownWhenIdle(activity, helper, sessionKey);
      else this.shutdownIfIdle();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connecting !== null) {
      await this.connecting;
      return;
    }
    if (this.socket !== null) return;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  private async connect(): Promise<void> {
    this.helperGeneration += 1;
    const nonce = randomBytes(16).toString('hex');
    const pipePath = `\\\\.\\pipe\\sprint-coder-computer-use-${nonce}`;
    const child = spawn(
      this.helperPath,
      ['--pipe', pipePath, '--parent-pid', String(process.pid)],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: windowsHelperEnvironment(process.env),
      },
    );
    this.child = child;
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.failAll(
        new Error(`Computer Use Windows helper exited: ${String(code ?? signal ?? 'unknown')}`),
      );
      this.socket?.destroy();
      this.socket = null;
      this.child = null;
    });
    try {
      if (child.pid === undefined)
        throw new Error('Computer Use Windows helper PID is unavailable');
      assertWindowsComputerUseSpawnedHelperAttestation(
        this.helperPath,
        this.expectedTrust,
        attestSpawnedWindowsComputerUseHelper(child.pid),
      );
    } catch (error) {
      child.kill();
      if (this.child === child) this.child = null;
      throw error;
    }
    child.unref();

    let lastFailure: unknown = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const socket = await connectPipe(pipePath);
        this.socket = socket;
        // Partial frames belong to this pipe, including handshake retries on the same helper.
        const decoder: { readBuffer: Buffer } = { readBuffer: Buffer.alloc(0) };
        socket.on('data', (chunk) => {
          if (this.socket === socket) this.consume(chunk, decoder);
        });
        socket.on('error', (error) => {
          if (this.socket === socket) this.failAll(error);
        });
        socket.on('close', () => {
          if (this.socket !== socket) return;
          this.failAll(new Error('Computer Use Windows helper pipe closed'));
          this.socket = null;
        });
        const handshake = await this.sendConnected(
          'handshake',
          { operation: 'handshake', protocolVersion: 1, apiVersion: 3 },
          this.transportSessionId,
          newComputerUseNativeFrameId(),
        );
        assertWindowsComputerUseHelperHandshake(handshake, this.expectedTrust);
        return;
      } catch (error) {
        lastFailure = error;
        this.socket?.destroy();
        this.socket = null;
        await delay(100);
      }
    }
    child.kill();
    throw new Error(`Computer Use Windows helper pipe connection failed: ${String(lastFailure)}`);
  }

  private sendConnected(
    messageType: ComputerUseNativeMessageType,
    metadata: NativeRecord,
    sessionId: ComputerUseNativeFrameId,
    requestId: ComputerUseNativeFrameId,
    timeoutMilliseconds = 10_000,
    stopsSession = false,
    beforeWrite?: () => void,
  ): Promise<unknown> {
    const socket = this.socket;
    if (socket === null)
      return Promise.reject(new Error('Computer Use Windows helper is disconnected'));
    if (this.pending.has(requestId.hex))
      return Promise.reject(new Error('Computer Use Windows helper request is already pending'));
    const encoded = encodeComputerUseNativeFrame({
      messageType,
      flags: 0,
      requestId,
      sessionId,
      cancelId: messageType === 'cancel' ? newComputerUseNativeFrameId() : null,
      metadata: Buffer.from(JSON.stringify(metadata), 'utf8'),
      binary: Buffer.alloc(0),
    });
    const activityGeneration = this.activityGeneration;
    const helperGeneration = this.helperGeneration;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.get(requestId.hex) !== pending) return;
        this.pending.delete(requestId.hex);
        const error = new Error('Computer Use Windows helper request timed out');
        reject(error);
        // A request that never came back means the helper is unusable, so this normally ends it
        // outright rather than waiting for the transport to fall idle. The exception is a stop that
        // is still on the wire: the helper's answer to it is the only thing that can release Main's
        // input quarantine, and requests that were already in flight when Stop began keep timers of
        // their own that would otherwise expire inside Stop's window and kill the helper the stop
        // has to reach. Every stop carries its own bounded timeout, so deferring to it still ends
        // the transport — the last stop to time out finds no stop pending and aborts here.
        if (
          activityGeneration === this.activityGeneration &&
          helperGeneration === this.helperGeneration &&
          !this.hasPendingStop()
        )
          this.abortTransport(error);
        else this.shutdownIfIdle();
      }, timeoutMilliseconds);
      const pending: PendingRequest = {
        resolve,
        reject,
        timeout,
        sessionId,
        stopsSession,
        activityGeneration,
        helperGeneration,
        responseType: responseTypeFor(messageType),
        allowBinary: messageType === 'observe',
      };
      this.pending.set(requestId.hex, pending);
      try {
        if (this.socket !== socket)
          throw new Error('Computer Use Windows helper changed before send');
        beforeWrite?.();
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId.hex);
        reject(error);
        this.shutdownIfIdle();
        return;
      }
      try {
        socket.write(encoded, (error) => {
          if (this.socket !== socket || this.pending.get(requestId.hex) !== pending) return;
          if (error === null || error === undefined) return;
          clearTimeout(timeout);
          this.pending.delete(requestId.hex);
          reject(error);
          this.abortTransport(error);
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId.hex);
        const failure = error instanceof Error ? error : new Error(String(error));
        reject(failure);
        this.abortTransport(failure);
      }
    });
  }

  private consume(chunk: Buffer, decoder: { readBuffer: Buffer }): void {
    decoder.readBuffer = Buffer.concat([decoder.readBuffer, chunk]);
    while (decoder.readBuffer.byteLength >= COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES) {
      if (
        decoder.readBuffer.readUInt32LE(0) !== COMPUTER_USE_NATIVE_MAGIC ||
        decoder.readBuffer.readUInt16LE(4) !== COMPUTER_USE_NATIVE_PROTOCOL_VERSION ||
        !isKnownComputerUseNativeMessageType(decoder.readBuffer.readUInt16LE(6))
      ) {
        this.failAll(new Error('Computer Use Windows helper returned an invalid frame header'));
        this.socket?.destroy();
        return;
      }
      const metadataBytes = decoder.readBuffer.readUInt32LE(60);
      const binaryBytes = decoder.readBuffer.readUInt32LE(64);
      if (
        metadataBytes === 0 ||
        metadataBytes > COMPUTER_USE_NATIVE_MAX_METADATA_BYTES ||
        binaryBytes > COMPUTER_USE_NATIVE_MAX_BINARY_BYTES
      ) {
        this.failAll(new Error('Computer Use Windows helper returned an invalid frame length'));
        this.socket?.destroy();
        return;
      }
      const frameBytes = COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES + metadataBytes + binaryBytes;
      if (decoder.readBuffer.byteLength < frameBytes) return;
      const encoded = decoder.readBuffer.subarray(0, frameBytes);
      decoder.readBuffer = decoder.readBuffer.subarray(frameBytes);
      try {
        this.resolveFrame(decodeComputerUseNativeFrame(encoded));
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        this.socket?.destroy();
        return;
      }
    }
  }

  private resolveFrame(frame: ComputerUseNativeFrame): void {
    const pending = this.pending.get(frame.requestId.hex);
    if (pending === undefined) return;
    if (!isWindowsHelperResponseBound(frame, pending)) {
      const error = new Error('Computer Use Windows helper response binding mismatch');
      this.pending.delete(frame.requestId.hex);
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.abortTransport(error);
      return;
    }
    this.pending.delete(frame.requestId.hex);
    clearTimeout(pending.timeout);
    try {
      let parsed = JSON.parse(frame.metadata.toString('utf8')) as unknown;
      if (frame.messageType === 'error') {
        const value = asRecord(parsed, 'Computer Use Windows helper rejected the request');
        const code = typeof value['code'] === 'string' ? value['code'] : 'NATIVE_HELPER_REJECTED';
        pending.reject(
          Object.assign(new Error(code), { code, accepted: value['accepted'] === true }),
        );
        this.shutdownIfIdle();
        return;
      }
      if (frame.binary.byteLength > 0)
        parsed = decodeWindowsObservationPayload(parsed, frame.binary);
      pending.resolve(parsed);
      this.shutdownIfIdle();
    } catch (error) {
      const invalid =
        error instanceof Error
          ? error
          : new Error('Computer Use Windows helper returned an invalid response');
      pending.reject(invalid);
      this.abortTransport(invalid);
    }
  }

  private failAll(error: unknown): void {
    // Whatever armed the idle teardown is being failed right here, and the next request connects a
    // fresh helper that the old session's teardown has no claim on.
    this.idleShutdownPending = false;
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(normalized);
      this.pending.delete(requestId);
    }
  }

  private abortTransport(error: Error): void {
    this.failAll(error);
    this.socket?.destroy();
    this.socket = null;
    this.child?.kill();
    this.child = null;
  }
}

export function assertWindowsComputerUseSpawnedHelperAttestation(
  expectedPath: string,
  expected: WindowsComputerUseHelperTrust,
  actual: WindowsComputerUseHelperAttestation,
): void {
  // Each field is validated on its own so waiving the signer never relaxes the digest or commit
  // binding that replaces it as the helper's identity.  A binding without a signer is itself only
  // valid in a compiled acceptance build, so no caller can obtain the waiver by passing `null`.
  if (
    !/^[0-9a-f]{64}$/u.test(expected.binaryDigest) ||
    (expected.signerDigest === null
      ? !computerUseWindowsSignerWaived('win32', expected.signerDigest)
      : !/^[0-9a-f]{64}$/u.test(expected.signerDigest)) ||
    !/^[0-9a-f]{40}$/u.test(expected.sourceCommit)
  )
    throw new Error('Computer Use Windows helper trust binding is invalid');
  if (windowsPathIdentity(actual.imagePath) !== windowsPathIdentity(expectedPath))
    throw new Error('Computer Use Windows helper image path mismatch');
  if (actual.binaryDigest !== expected.binaryDigest)
    throw new Error('Computer Use Windows helper binary digest mismatch');
  if (expected.signerDigest === null) {
    // The waiver covers a helper that carries no signature at all.  One whose signature exists but
    // does not verify was altered after signing, which is not what the acceptance build produces.
    if (actual.signatureStatus !== 'NotSigned' || actual.signerThumbprint !== null)
      throw new Error('Computer Use Windows helper signer is invalid');
    return;
  }
  if (
    actual.signatureStatus !== 'Valid' ||
    actual.signerThumbprint === null ||
    !/^[0-9A-F]{40}$/u.test(actual.signerThumbprint)
  )
    throw new Error('Computer Use Windows helper signer is invalid');
  const signerDigest = createHash('sha256').update(actual.signerThumbprint, 'utf8').digest('hex');
  if (signerDigest !== expected.signerDigest)
    throw new Error('Computer Use Windows helper signer mismatch');
}

export function assertWindowsComputerUseHelperHandshake(
  value: unknown,
  expected: WindowsComputerUseHelperTrust,
): void {
  const handshake = asRecord(value, 'Computer Use Windows helper handshake is invalid');
  if (
    handshake['protocolVersion'] !== 1 ||
    handshake['apiVersion'] !== 3 ||
    handshake['platform'] !== 'win32'
  )
    throw new Error('Computer Use Windows helper handshake mismatch');
  if (handshake['sourceCommit'] !== expected.sourceCommit)
    throw new Error('Computer Use Windows helper source commit mismatch');
  const attested = parseNativeHandshake(handshake, 'win32');
  const declared = expected.eligibility;
  if (
    (declared === undefined) !== (attested === null) ||
    (declared !== undefined &&
      attested !== null &&
      (declared.mode !== attested.mode ||
        declared.rulesetVersion !== attested.rulesetVersion ||
        declared.classifierVersion !== attested.classifierVersion ||
        declared.lexiconVersion !== attested.lexiconVersion ||
        declared.ticketRequired !== attested.ticketRequired))
  )
    throw new Error('Computer Use Windows helper eligibility mismatch');
}

function attestSpawnedWindowsComputerUseHelper(pid: number): WindowsComputerUseHelperAttestation {
  const output = execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
        '$process = Get-Process -Id ([int]$env:SPRINT_CODER_COMPUTER_USE_HELPER_PID) -ErrorAction Stop',
        'try {',
        '  $imagePath = $process.MainModule.FileName',
        '  $stream = [System.IO.File]::Open($imagePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)',
        '  try {',
        '    $sha = [System.Security.Cryptography.SHA256]::Create()',
        "    try { $binaryDigest = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }",
        '    $signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $imagePath',
        '    [pscustomobject]@{imagePath=$imagePath;binaryDigest=$binaryDigest;signatureStatus=$signature.Status.ToString();signerThumbprint=$signature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress',
        '  } finally { $stream.Dispose() }',
        '} finally { $process.Dispose() }',
      ].join('\n'),
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: {
        ...windowsHelperEnvironment(process.env),
        SPRINT_CODER_COMPUTER_USE_HELPER_PID: String(pid),
      },
    },
  );
  return parseWindowsComputerUseHelperAttestation(JSON.parse(output) as unknown);
}

/**
 * Authenticode reports no signer certificate for an unsigned image, so PowerShell serializes the
 * thumbprint as `null`.  The shape is accepted here and judged by
 * `assertWindowsComputerUseSpawnedHelperAttestation`, which refuses it for every signed binding.
 */
export function parseWindowsComputerUseHelperAttestation(
  input: unknown,
): WindowsComputerUseHelperAttestation {
  const value = asRecord(input, 'Computer Use Windows helper attestation is invalid');
  const signerThumbprint = value['signerThumbprint'];
  if (
    typeof value['imagePath'] !== 'string' ||
    typeof value['binaryDigest'] !== 'string' ||
    typeof value['signatureStatus'] !== 'string' ||
    (signerThumbprint !== null && typeof signerThumbprint !== 'string')
  )
    throw new Error('Computer Use Windows helper attestation is invalid');
  return Object.freeze({
    imagePath: value['imagePath'],
    binaryDigest: value['binaryDigest'],
    signatureStatus: value['signatureStatus'],
    signerThumbprint: signerThumbprint === null ? null : signerThumbprint.toUpperCase(),
  });
}

function windowsPathIdentity(value: string): string {
  return win32.normalize(value).toLowerCase();
}

export function isWindowsHelperResponseBound(
  frame: ComputerUseNativeFrame,
  expected: Readonly<{
    sessionId: ComputerUseNativeFrameId;
    responseType: ComputerUseNativeMessageType;
    allowBinary: boolean;
  }>,
): boolean {
  return (
    frame.sessionId.hex === expected.sessionId.hex &&
    (frame.messageType === 'error' || frame.messageType === expected.responseType) &&
    (frame.binary.byteLength === 0 ||
      (frame.messageType === 'observe_result' && expected.allowBinary))
  );
}

export function decodeWindowsObservationPayload(
  metadata: unknown,
  binary: Uint8Array,
): NativeRecord {
  const value = asRecord(metadata, 'Computer Use Windows helper observation is invalid');
  const screenshotBytes = value['screenshotBytes'];
  const treeBytes = value['treeBytes'];
  if (
    !Number.isSafeInteger(screenshotBytes) ||
    Number(screenshotBytes) <= 0 ||
    Number(screenshotBytes) > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(treeBytes) ||
    Number(treeBytes) <= 0 ||
    Number(treeBytes) > 512 * 1024 ||
    Number(screenshotBytes) + Number(treeBytes) !== binary.byteLength
  )
    throw new Error('Computer Use Windows helper observation payload is invalid');
  const bytes = Buffer.from(binary);
  let tree: string;
  try {
    tree = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(Number(screenshotBytes)),
    );
  } catch {
    throw new Error('Computer Use Windows helper observation tree is invalid');
  }
  if (Buffer.byteLength(tree, 'utf8') !== Number(treeBytes))
    throw new Error('Computer Use Windows helper observation tree length is invalid');
  const result = { ...value };
  delete result['screenshotBytes'];
  delete result['treeBytes'];
  result['screenshot'] = Buffer.from(bytes.subarray(0, Number(screenshotBytes)));
  result['tree'] = tree;
  return result;
}

function frameIdFromText(value: string): ComputerUseNativeFrameId {
  return Object.freeze({
    hex: createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32),
  });
}

function record(value: unknown): NativeRecord {
  return { ...asRecord(value, 'Computer Use Windows request must be an object') };
}

function asRecord(value: unknown, message: string): NativeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  return value as NativeRecord;
}

function stringField(value: NativeRecord, key: string, fallback?: string): string {
  const candidate = value[key];
  if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 256)
    return candidate;
  if (fallback !== undefined) return fallback;
  throw new Error(`Computer Use Windows request is missing ${key}`);
}

function connectPipe(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseTypeFor(requestType: ComputerUseNativeMessageType): ComputerUseNativeMessageType {
  switch (requestType) {
    case 'handshake':
      return 'handshake_result';
    case 'probe':
      return 'probe_result';
    case 'observe':
      return 'observe_result';
    case 'dispatch':
    case 'cancel':
      return 'dispatch_result';
    case 'preflight':
      return 'preflight_result';
    default:
      throw new Error(`Unsupported Computer Use Windows request type: ${requestType}`);
  }
}

/**
 * Main re-sends an unconfirmed stop for the same session id with a higher epoch, so the request id
 * has to carry that epoch. The helper keys its response cache on the request id and answers a
 * repeat id whose payload changed with `request_id_conflict`, and this client refuses a request id
 * that is still pending, so a fixed id would stop a re-sent close from ever reaching
 * CloseWindowsSession.
 */
export function windowsStopRequestKey(
  kind: 'cancel' | 'close',
  sessionId: string,
  cancelEpoch: unknown,
): string {
  return `${kind}:${sessionId}:${String(cancelEpoch)}`;
}

/**
 * The close round trip has to outlast every close deadline Main can still be waiting on, not just
 * the one for the close that is on the wire. Main arms
 * `COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS` per attempt and re-sends the close
 * `COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT` times, so the last attempt's deadline expires at
 * limit × deadline. Budgeting the transport for the same span would make the two fire in the same
 * timers phase: Main's deadline rejects first, Stop re-sends the close onto the same transport,
 * and the first close's timeout then aborts the transport, kills the helper and rejects the
 * re-send through `failAll` — taking the helper's `closed_sessions` receipt with it and leaving
 * the input quarantine permanently on. Outlasting the whole re-send window instead lets the
 * helper answer the first close late and then answer the re-send from that registry, which is the
 * recovery Issue #484 asks for. It stays a bounded deadline: a helper that never answers any close
 * is still aborted and killed here, when the last attempt's budget runs out — one transport budget
 * after that attempt was sent, by which point Stop has long since given up and reported
 * `native_unavailable`.
 */
export const COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS =
  COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * (COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT + 1);

/**
 * Stop's own lane. Main quarantines input for the whole of it and only a close receipt lifts that,
 * so these two requests have to survive a timeout raised by anything else on the transport.
 */
export function isComputerUseStopOperation(operation: string): boolean {
  return (
    operation === 'cancel' || operation === 'close_session' || operation === 'stop_pending_start'
  );
}

export function operationTimeoutMilliseconds(operation: string): number {
  if (operation === 'pick_application') return 5 * 60_000;
  if (operation === 'list_windows' || operation === 'observe') return 30_000;
  if (operation === 'start_session') return 15_000;
  // The helper answers a read within the lane's 500 ms hold; a longer wait is a helper that is stuck.
  if (operation === 'read_node_value') return 5_000;
  if (operation === 'close_session' || operation === 'stop_pending_start')
    return COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS;
  return 10_000;
}

export function windowsHelperEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const allowed = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const;
  return Object.freeze(
    Object.fromEntries(
      allowed.flatMap((key) => {
        const value = environment[key];
        return typeof value === 'string' && value.length > 0 ? [[key, value]] : [];
      }),
    ),
  );
}
