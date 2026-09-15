import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import {
  createCaptureEncoder,
  type CapturePayload,
} from '../../../../computer-use-capture-wire.mjs';
import type { ComputerUseRuntimeEvent } from './computer-use-runtime-capture';
import { parseComputerUseNativeCompiledPin } from './computer-use-native-provenance';

function sourceBoundHello(hello: CapturePayload): CapturePayload {
  if (hello['packaged'] !== true) return hello;
  const pin = parseComputerUseNativeCompiledPin(
    typeof __SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__ === 'undefined'
      ? null
      : __SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__,
  );
  const disabledSource = hello['sourceCommit'] === '0'.repeat(40);
  if (
    pin.sourceCommit === '0'.repeat(40) ||
    pin.platform !== hello['platform'] ||
    pin.architecture !== process.arch ||
    (disabledSource ? hello['packageReady'] !== false : hello['sourceCommit'] !== pin.sourceCommit)
  )
    throw new Error('Computer Use capture source binding is unavailable');
  // CU OFF deliberately returns a disabled native binding. The existing Main build pin
  // identifies its source without loading/enabling native code or asserting package readiness.
  return { ...hello, sourceCommit: pin.sourceCommit };
}

export type ComputerUseCaptureOutput = {
  record(event: ComputerUseRuntimeEvent): void;
  close(): void;
  invalid(): boolean;
  invalidate(): void;
  onInvalid(listener: () => void): void;
};

/** One-way opt-in metadata output on the parent's inherited pipe. It accepts no input/commands. */
export function createComputerUseCaptureOutput(input: {
  environment: NodeJS.ProcessEnv;
  hello: CapturePayload;
}): ComputerUseCaptureOutput | undefined {
  if (input.environment['SPRINT_CODER_COMPUTER_USE_CAPTURE_PIPE'] !== '1') return undefined;
  let socket: Socket | undefined;
  let invalid = false;
  let closed = false;
  let listener: (() => void) | undefined;
  const fail = () => {
    if (invalid) return;
    invalid = true;
    try {
      socket?.destroy();
    } catch {
      /* No control authority. */
    }
    try {
      listener?.();
    } catch {
      /* No control authority. */
    }
  };
  const unavailable = (): ComputerUseCaptureOutput => ({
    record: () => {},
    close: () => {},
    invalid: () => true,
    invalidate: () => {},
    onInvalid: (notify) => {
      try {
        notify();
      } catch {
        /* No control authority. */
      }
    },
  });
  try {
    const nonce = input.environment['SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE'];
    if (nonce === undefined || !/^[a-f0-9]{64}$/u.test(nonce)) return unavailable();
    const hello = sourceBoundHello(input.hello);
    const stat = fstatSync(3);
    if (!stat.isFIFO() && !stat.isSocket()) return unavailable();
    const encode = createCaptureEncoder(nonce);
    socket = new Socket({ fd: 3, readable: false, writable: true });
    socket.unref();
    socket.on('error', fail);
    socket.on('close', () => {
      if (!closed) fail();
    });
    const write = (kind: 'hello' | 'event' | 'end', payload: CapturePayload) => {
      if (invalid || closed || socket === undefined) return;
      try {
        const frame = encode(kind, payload);
        if (socket.writableLength + Buffer.byteLength(frame) > 64 * 1024) {
          fail();
          return;
        }
        socket.write(frame, (error) => {
          if (error) fail();
        });
      } catch {
        fail();
      }
    };
    write('hello', hello);
    return {
      record: (event) => {
        const payload: CapturePayload = {};
        for (const [key, value] of Object.entries(event)) {
          if (value !== undefined) payload[key] = value;
        }
        write('event', payload);
      },
      close: () => {
        if (closed) return;
        write('end', { valid: !invalid });
        closed = true;
        try {
          socket?.end();
        } catch {
          fail();
        }
      },
      invalid: () => invalid,
      invalidate: fail,
      onInvalid: (notify) => {
        listener = notify;
        if (invalid) {
          try {
            notify();
          } catch {
            /* No control authority. */
          }
        }
      },
    };
  } catch {
    fail();
    return unavailable();
  }
}
