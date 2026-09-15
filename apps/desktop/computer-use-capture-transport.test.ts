import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaptureDecoder, createCaptureEncoder } from '../../computer-use-capture-wire.mjs';

const root = resolve(__dirname, '../..');
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const nonce = 'a'.repeat(64);
const hello = {
  pid: 10,
  parentPid: 9,
  platform: 'darwin',
  sourceCommit: 'b'.repeat(40),
  nativeManifestDigest: 'c'.repeat(64),
  packaged: false,
  packageReady: false,
};
const event = {
  type: 'session',
  sessionDigest: 'd'.repeat(64),
  platform: 'darwin',
  appDigest: 'e'.repeat(64),
  windowDigest: 'f'.repeat(64),
  manifestDigest: 'c'.repeat(64),
};

describe('Computer Use normal capture framing', () => {
  it('accepts fragmented metadata frames and requires a valid terminal frame', () => {
    const encode = createCaptureEncoder(nonce);
    const sink = vi.fn();
    const decoder = createCaptureDecoder(nonce, sink);
    const bytes = Buffer.from(
      encode('hello', hello) + encode('event', event) + encode('end', { valid: true }),
    );
    for (let offset = 0; offset < bytes.length; offset += 7)
      decoder.push(bytes.subarray(offset, offset + 7));
    expect(decoder.finish().frameCount).toBe(3);
    expect(sink).toHaveBeenCalledTimes(3);
  });
  it.each(['nonce', 'tamper', 'duplicate-key', 'truncated', 'oversized', 'no-end'])(
    'rejects %s without reflecting bytes',
    (kind) => {
      const encode = createCaptureEncoder(nonce);
      let stream = encode('hello', hello);
      if (kind === 'nonce') stream = stream.replace(nonce, 'e'.repeat(64));
      if (kind === 'tamper') stream = stream.replace('"pid":10', '"pid":11');
      if (kind === 'duplicate-key') stream = stream.replace('"pid":10', '"pid":10,"pid":10');
      if (kind === 'truncated') stream = stream.slice(0, -2);
      if (kind === 'oversized') stream = 'PRIVATE_FIXTURE'.repeat(100_000);
      const decoder = createCaptureDecoder(nonce, () => {});
      expect(() => {
        decoder.push(Buffer.from(stream));
        decoder.finish();
      }).toThrow('Computer Use capture wire is invalid');
    },
  );
  it('refuses fields capable of carrying raw bodies', () => {
    const encode = createCaptureEncoder(nonce);
    encode('hello', hello);
    expect(() => encode('event', { ...event, rawBody: 'PRIVATE_FIXTURE' })).toThrow();
  });
  it('aggregates Unicode scalar receipts into ordered canonical round summaries', async () => {
    const { summarizeComputerUseCaptureRounds } = await import(
      pathToFileURL(resolve(root, 'computer-use-capture-rounds.mjs')).href
    );
    const sessionDigest = 'd'.repeat(64),
      actionDigest = 'e'.repeat(64),
      bindingDigest = 'f'.repeat(64);
    const observation = (revision: number) => ({
      type: 'observation',
      sessionDigest,
      appDigest: event.appDigest,
      windowDigest: event.windowDigest,
      revision,
      ttlVerified: true,
    });
    const payloads: Record<string, string | number | boolean>[] = [
      { ...event, cancelEpoch: 0, inputAttemptCount: 0 },
      { type: 'preflight_started', sessionDigest, bindingDigest, isOpenRouter: false },
      { type: 'preflight_passed', sessionDigest, bindingDigest },
      observation(1),
    ];
    let inputAttemptCount = 0;
    for (let round = 1; round <= 3; round++) {
      payloads.push(
        { type: 'round_started', sessionDigest, round, revision: round, bindingDigest },
        {
          type: 'parsed',
          sessionDigest,
          round,
          revision: round,
          bindingDigest,
          actionDigest,
          actionClass: round === 1 ? 'type' : 'invoke',
          latencyMs: 10,
          ttlVerified: true,
        },
      );
      for (let scalar = 0; scalar < (round === 1 ? 2 : 1); scalar++) {
        const requestDigest = createHash('sha256').update(`${round}:${scalar}`).digest('hex');
        payloads.push(
          {
            type: 'native_started',
            sessionDigest,
            revision: round,
            actionDigest,
            requestDigest,
            cancelEpoch: 0,
            ttlVerified: true,
          },
          {
            type: 'native_finished',
            sessionDigest,
            revision: round,
            actionDigest,
            requestDigest,
            cancelEpoch: 0,
            inputAttemptCount: ++inputAttemptCount,
            result: 'completed',
          },
        );
      }
      payloads.push(
        {
          type: 'action_result',
          sessionDigest,
          revision: round,
          actionDigest,
          result: 'completed',
        },
        observation(round + 1),
      );
    }
    payloads.push({
      type: 'stop_acknowledged',
      sessionDigest,
      nativeAcknowledged: true,
      cancelEpoch: 1,
      inputAttemptCount,
    });
    const frames = payloads.map((payload) => ({ kind: 'event', payload }));
    const summaries = summarizeComputerUseCaptureRounds(frames);
    expect(summaries[0].roundsComplete).toBe(true);
    expect(summaries[0].rounds[0].nativeRequestDigests).toHaveLength(2);
    expect(summaries[0].rounds[0].nativeActionDigest).toBe(actionDigest);
    const broken = structuredClone(frames);
    const receipt = broken.find((frame) => frame.payload.type === 'native_finished')!;
    receipt.payload.cancelEpoch = 9;
    expect(summarizeComputerUseCaptureRounds(broken)[0].roundsComplete).toBe(false);
  });
  it('uses an actual owned Node child pipe without treating it as packaged Windows/macOS acceptance', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'computer-use-pipe-'));
    directories.push(directory);
    const child = resolve(directory, 'child.mjs');
    const wireUrl = pathToFileURL(resolve(root, 'computer-use-capture-wire.mjs')).href;
    writeFileSync(
      child,
      `import {writeSync} from 'node:fs'; import {createCaptureEncoder} from ${JSON.stringify(wireUrl)};
const encode=createCaptureEncoder(process.env.SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE);
writeSync(3,encode('hello',{pid:process.pid,parentPid:process.ppid,platform:process.platform,sourceCommit:'b'.repeat(40),nativeManifestDigest:'c'.repeat(64),packaged:false,packageReady:false}));
writeSync(3,encode('end',{valid:true}));`,
    );
    const collector = await import(
      pathToFileURL(resolve(root, 'collect-computer-use-runtime.mjs')).href
    );
    const capture = collector.startOwnedComputerUseCapture({
      executable: process.execPath,
      args: [child],
      environment: process.env,
    });
    try {
      const hello = await capture.handshake;
      expect(hello.packaged).toBe(false);
      const completed = await capture.completed;
      expect(completed.frameCount).toBe(2);
      expect(completed.executableSha256).toBe(
        createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
      );
    } finally {
      capture.stopOwnedChild();
    }
  });
});
