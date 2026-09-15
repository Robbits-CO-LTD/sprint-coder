import { EventEmitter } from 'node:events';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createComputerUseCaptureOutput as CaptureOutputFactory } from './computer-use-capture-output';

const state = vi.hoisted(() => ({ pipe: true, queued: 0, throws: false }));
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  writableLength = state.queued;
  writes: string[] = [];
  destroyed = false;
  constructor() {
    super();
    sockets.push(this);
  }
  unref() {}
  write(frame: string) {
    if (state.throws) throw new Error('EPIPE');
    this.writes.push(frame);
    return false;
  }
  end() {
    if (state.throws) throw new Error('EPIPE');
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
  }
}
vi.mock('node:fs', () => ({
  fstatSync: () => {
    if (!state.pipe) throw new Error('EBADF');
    return { isFIFO: () => true, isSocket: () => false };
  },
}));
let createComputerUseCaptureOutput: typeof CaptureOutputFactory;
beforeAll(async () => {
  vi.doMock('node:net', () => ({ Socket: FakeSocket }));
  ({ createComputerUseCaptureOutput } = await import('./computer-use-capture-output'));
});
const environment = {
  SPRINT_CODER_COMPUTER_USE_CAPTURE_PIPE: '1',
  SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE: 'a'.repeat(64),
};
const hello = {
  pid: 1,
  parentPid: 2,
  platform: 'darwin',
  sourceCommit: 'b'.repeat(40),
  nativeManifestDigest: 'c'.repeat(64),
  packaged: false,
  packageReady: false,
};
beforeEach(() => {
  vi.unstubAllGlobals();
  state.pipe = true;
  state.queued = 0;
  state.throws = false;
  sockets.length = 0;
});
describe('normal Main capture output has no control authority', () => {
  const compiledPin = {
    version: 1,
    sourceCommit: 'b'.repeat(40),
    platform: 'darwin',
    architecture: process.arch,
    artifactDigest: 'd'.repeat(64),
    manifestDigest: 'c'.repeat(64),
  };
  it('binds packaged CU-OFF hello to the compiled source without enabling the native host', () => {
    vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', compiledPin);
    const output = createComputerUseCaptureOutput({
      environment,
      hello: {
        ...hello,
        packaged: true,
        sourceCommit: '0'.repeat(40),
        nativeManifestDigest: '0'.repeat(64),
      },
    })!;
    expect(output.invalid()).toBe(false);
    expect(JSON.parse(sockets[0]!.writes[0]!).payload).toMatchObject({
      sourceCommit: compiledPin.sourceCommit,
      nativeManifestDigest: '0'.repeat(64),
      packageReady: false,
    });
  });
  it('preserves a ready source-bound hello without changing caller metadata', () => {
    vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', compiledPin);
    const metadata = Object.freeze({ ...hello, packaged: true, packageReady: true });
    const output = createComputerUseCaptureOutput({ environment, hello: metadata })!;
    expect(output.invalid()).toBe(false);
    expect(JSON.parse(sockets[0]!.writes[0]!).payload).toEqual(metadata);
  });
  it.each(['missing', 'invalid', 'wrong-platform', 'wrong-source', 'unbound-ready'])(
    'invalidates packaged hello with %s source pin, without throwing',
    (kind) => {
      if (kind !== 'missing')
        vi.stubGlobal(
          '__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__',
          kind === 'invalid'
            ? null
            : { ...compiledPin, platform: kind === 'wrong-platform' ? 'win32' : 'darwin' },
        );
      const output = createComputerUseCaptureOutput({
        environment,
        hello: {
          ...hello,
          packaged: true,
          sourceCommit: kind === 'wrong-source' ? 'e'.repeat(40) : '0'.repeat(40),
          packageReady: kind === 'unbound-ready',
        },
      })!;
      expect(output.invalid()).toBe(true);
      expect(sockets.every((socket) => socket.writes.length === 0)).toBe(true);
    },
  );
  it('is opt-in and never exposes a writable path or fd selector', () => {
    expect(createComputerUseCaptureOutput({ environment: {}, hello })).toBeUndefined();
    expect(
      createComputerUseCaptureOutput({
        environment: { ...environment, SPRINT_CODER_COMPUTER_USE_CAPTURE_PIPE: '2' },
        hello,
      }),
    ).toBeUndefined();
    expect(sockets).toHaveLength(0);
  });
  it.each(['missing', 'full', 'epipe'])(
    'invalidates %s output without throwing or awaiting drain',
    (failure) => {
      if (failure === 'missing') state.pipe = false;
      if (failure === 'full') state.queued = 64 * 1024;
      if (failure === 'epipe') state.throws = true;
      const output = createComputerUseCaptureOutput({ environment, hello })!;
      const invalid = vi.fn();
      expect(() => output.onInvalid(invalid)).not.toThrow();
      expect(output.invalid()).toBe(true);
      expect(invalid).toHaveBeenCalledOnce();
      expect(() => output.close()).not.toThrow();
    },
  );
  it('invalidates asynchronous pipe closure and keeps the observer no-throw', () => {
    const output = createComputerUseCaptureOutput({ environment, hello })!;
    const invalidate = vi.fn();
    output.onInvalid(invalidate);
    expect(sockets[0]!.writes).toHaveLength(1);
    expect(() => sockets[0]!.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(output.invalid()).toBe(true);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
