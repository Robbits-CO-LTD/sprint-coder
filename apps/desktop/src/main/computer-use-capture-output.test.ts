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
  state.pipe = true;
  state.queued = 0;
  state.throws = false;
  sockets.length = 0;
});
describe('normal Main capture output has no control authority', () => {
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
