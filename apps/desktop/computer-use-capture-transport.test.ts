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
type JourneyOptions = {
  bindingDigest?: string;
  identity?: Record<string, string | number | boolean>;
  egress?: boolean;
  cost?: boolean;
  lateCost?: boolean;
  secondEgressDigest?: string;
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
  const bindingIdentity: Record<string, string | number | boolean> = {
    connectionIdDigest: '1'.repeat(64),
    modelIdDigest: '2'.repeat(64),
    endpointDigest: '3'.repeat(64),
    catalogDigest: '4'.repeat(64),
    policyEpoch: 7,
    selectedFromCurrentTask: true,
    fallbackUsed: false,
    credentialChanged: false,
  };
  const egressDigest = '5'.repeat(64);
  const costLimitDigest = '6'.repeat(64);
  function journeyFrames(options: JourneyOptions = {}) {
    const sessionDigest = 'd'.repeat(64),
      actionDigest = 'e'.repeat(64),
      bindingDigest = options.bindingDigest ?? 'f'.repeat(64);
    const observation = (revision: number) => ({
      type: 'observation',
      sessionDigest,
      appDigest: event.appDigest,
      windowDigest: event.windowDigest,
      revision,
      ttlVerified: true,
    });
    const costEvent = { type: 'cost_limit_bound', sessionDigest, costLimitDigest, maxRounds: 25 };
    const payloads: Record<string, string | number | boolean>[] = [
      { ...event, cancelEpoch: 0, inputAttemptCount: 0 },
      {
        type: 'preflight_started',
        sessionDigest,
        bindingDigest,
        isOpenRouter: false,
        ...(options.identity ?? {}),
      },
      { type: 'preflight_passed', sessionDigest, bindingDigest },
      ...(options.egress ? [{ type: 'egress_authorized', sessionDigest, egressDigest }] : []),
      ...(options.secondEgressDigest === undefined
        ? []
        : [
            {
              type: 'egress_authorized',
              sessionDigest,
              egressDigest: options.secondEgressDigest,
            },
          ]),
      ...(options.cost && !options.lateCost ? [costEvent] : []),
      observation(1),
    ];
    let inputAttemptCount = 0;
    for (let round = 1; round <= 3; round++) {
      payloads.push({
        type: 'round_started',
        sessionDigest,
        round,
        revision: round,
        bindingDigest,
      });
      if (options.lateCost && round === 1) payloads.push(costEvent);
      payloads.push({
        type: 'parsed',
        sessionDigest,
        round,
        revision: round,
        bindingDigest,
        actionDigest,
        actionClass: round === 1 ? 'type' : 'invoke',
        latencyMs: 10,
        ttlVerified: true,
      });
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
    payloads.push({ type: 'stop_requested', sessionDigest, reasonDigest: 'a'.repeat(64) });
    payloads.push({
      type: 'stop_acknowledged',
      sessionDigest,
      nativeAcknowledged: true,
      cancelEpoch: 1,
      inputAttemptCount,
    });
    return [
      { kind: 'hello', payload: { ...hello } as Record<string, string | number | boolean> },
      ...payloads.map((payload) => ({ kind: 'event', payload })),
    ];
  }
  it('aggregates Unicode scalar receipts into ordered canonical round summaries', async () => {
    const { summarizeComputerUseCaptureRounds } = await import(
      pathToFileURL(resolve(root, 'computer-use-capture-rounds.mjs')).href
    );
    const frames = journeyFrames();
    const summaries = summarizeComputerUseCaptureRounds(frames);
    expect(summaries[0].roundsComplete).toBe(true);
    expect(summaries[0].rounds[0].nativeRequestDigests).toHaveLength(2);
    expect(summaries[0].rounds[0].nativeActionDigest).toBe('e'.repeat(64));
    const broken = structuredClone(frames);
    const receipt = broken.find((frame) => frame.payload.type === 'native_finished')!;
    receipt.payload.cancelEpoch = 9;
    expect(summarizeComputerUseCaptureRounds(broken)[0].roundsComplete).toBe(false);
  });
  async function captureRounds() {
    return await import(pathToFileURL(resolve(root, 'computer-use-capture-rounds.mjs')).href);
  }

  it('derives the provider binding from measured rounds, consent and cost bounds', async () => {
    const rounds = await captureRounds();
    const bindingDigest = rounds.computerUseCaptureBindingDigest(bindingIdentity);
    const [summary] = rounds.summarizeComputerUseCaptureRounds(
      journeyFrames({ bindingDigest, identity: bindingIdentity, egress: true, cost: true }),
    );
    expect(summary.roundsComplete).toBe(true);
    expect(summary.egressConsentDigest).toBe(egressDigest);
    expect(summary.costLimitDigest).toBe(costLimitDigest);
    expect(summary.maxRounds).toBe(25);
    expect(summary.roundsAttempted).toBe(3);
    // Every field is measured from the owned stream or fixed by the module version; none of it
    // is transcribed from a producer-supplied binding object.
    expect(summary.binding).toEqual({
      ...bindingIdentity,
      adapterVersion: 'computer-use-v1',
      sessionIdDigest: 'd'.repeat(64),
      bindingStable: true,
      preflightAttempts: 1,
      preflightPassed: true,
      roundsAttempted: 3,
      roundsCompleted: 3,
      isOpenRouter: false,
    });
  });

  it.each([
    'no-egress',
    'no-cost',
    'no-identity',
    'partial-identity',
    'identity-digest-mismatch',
    'changed-egress',
    'late-cost',
    'incomplete-journey',
  ])('does not resolve a measured binding for %s', async (kind) => {
    const rounds = await captureRounds();
    const bindingDigest = rounds.computerUseCaptureBindingDigest(bindingIdentity);
    const options: JourneyOptions = {
      bindingDigest,
      identity: bindingIdentity,
      egress: true,
      cost: true,
    };
    if (kind === 'no-egress') options.egress = false;
    else if (kind === 'no-cost') options.cost = false;
    else if (kind === 'no-identity') delete options.identity;
    else if (kind === 'partial-identity')
      options.identity = Object.fromEntries(
        Object.entries(bindingIdentity).filter(([key]) => key !== 'policyEpoch'),
      );
    else if (kind === 'identity-digest-mismatch') options.bindingDigest = 'f'.repeat(64);
    else if (kind === 'changed-egress') options.secondEgressDigest = '7'.repeat(64);
    else if (kind === 'late-cost') options.lateCost = true;
    const frames = journeyFrames(options);
    if (kind === 'incomplete-journey')
      frames.splice(
        frames.findIndex((frame) => frame.payload.type === 'stop_acknowledged'),
        1,
      );
    const [summary] = rounds.summarizeComputerUseCaptureRounds(frames);
    expect(summary.binding).toBe(null);
    if (kind === 'no-egress') expect(summary.egressConsentDigest).toBe(null);
    if (kind === 'no-cost') expect(summary.costLimitDigest).toBe(null);
    if (kind === 'changed-egress' || kind === 'late-cost' || kind === 'partial-identity')
      expect(summary.roundsComplete).toBe(false);
  });

  it.each([
    'repeat-preflight',
    'early-stop',
    'missing-stop',
    'stop-during-dispatch',
    'post-ack-dispatch',
  ])('refuses a complete journey for %s', async (kind) => {
    const { summarizeComputerUseCaptureRounds } = await import(
      pathToFileURL(resolve(root, 'computer-use-capture-rounds.mjs')).href
    );
    const frames = journeyFrames();
    if (kind === 'repeat-preflight') frames.splice(4, 0, structuredClone(frames[2]!));
    else if (kind === 'post-ack-dispatch')
      frames.push(structuredClone(frames.find((f) => f.payload.type === 'native_started')!));
    else {
      const stop = frames.splice(
        frames.findIndex((f) => f.payload.type === 'stop_requested'),
        1,
      )[0]!;
      if (kind === 'early-stop') frames.splice(2, 0, stop);
      if (kind === 'stop-during-dispatch')
        frames.splice(
          frames.findIndex((f) => f.payload.type === 'native_finished'),
          0,
          stop,
        );
    }
    expect(summarizeComputerUseCaptureRounds(frames)[0].roundsComplete).toBe(false);
  });
  it('keeps repeated Stop intent monotonic without requiring exactly one Stop request', async () => {
    const { summarizeComputerUseCaptureRounds } = await import(
      pathToFileURL(resolve(root, 'computer-use-capture-rounds.mjs')).href
    );
    const frames = journeyFrames();
    frames.splice(frames.length - 1, 0, structuredClone(frames[frames.length - 2]!));
    expect(summarizeComputerUseCaptureRounds(frames)[0].roundsComplete).toBe(true);
  });
  it.each(['platform', 'manifestDigest'])('rejects session/hello mismatch: %s', async (key) => {
    const { summarizeComputerUseCaptureRounds } = await import(
      pathToFileURL(resolve(root, 'computer-use-capture-rounds.mjs')).href
    );
    const frames = journeyFrames();
    frames[1]!.payload[key] = key === 'platform' ? 'win32' : '9'.repeat(64);
    expect(() => summarizeComputerUseCaptureRounds(frames)).toThrow();
  });
  it.each(['missing', 'duplicate'])('rejects %s hello during aggregation', async (kind) => {
    const { summarizeComputerUseCaptureRounds } = await import(
      pathToFileURL(resolve(root, 'computer-use-capture-rounds.mjs')).href
    );
    const frames = journeyFrames();
    if (kind === 'missing') frames.shift();
    else frames.splice(1, 0, structuredClone(frames[0]!));
    expect(() => summarizeComputerUseCaptureRounds(frames)).toThrow();
  });
  it('returns detached deeply immutable canonical summaries', async () => {
    const { summarizeComputerUseCaptureRounds } = await import(
      pathToFileURL(resolve(root, 'computer-use-capture-rounds.mjs')).href
    );
    const frames = journeyFrames();
    const summaries = summarizeComputerUseCaptureRounds(frames);
    expect(() => {
      summaries[0].rounds[0].ttlVerified = false;
    }).toThrow();
    expect(() => {
      summaries[0].rounds[0].nativeRequestDigests.push('a'.repeat(64));
    }).toThrow();
    expect(() => {
      summaries[0].rounds = [];
    }).toThrow();
    frames.find((f) => f.payload.type === 'native_started')!.payload.requestDigest = 'a'.repeat(64);
    expect(summaries[0].rounds[0].nativeRequestDigests[0]).not.toBe('a'.repeat(64));
  });
  it.each(['valid', 'platform-mismatch', 'manifest-mismatch'])(
    'uses an actual owned Node child pipe (%s); not packaged Windows/macOS acceptance',
    async (kind) => {
      const directory = mkdtempSync(resolve(tmpdir(), 'computer-use-pipe-'));
      directories.push(directory);
      const child = resolve(directory, 'child.mjs');
      const wireUrl = pathToFileURL(resolve(root, 'computer-use-capture-wire.mjs')).href;
      const fixtureEvents = journeyFrames()
        .slice(1)
        .map(({ payload }) => payload);
      // Synthetic journey metadata only: this child never invokes a Provider or native input.
      const fixtureCode =
        kind === 'valid'
          ? `if (['darwin','win32'].includes(process.platform)) for (const payload of ${JSON.stringify(fixtureEvents)}) { if(payload.type==='session') payload.platform=process.platform; writeSync(3,encode('event',payload)); }`
          : `writeSync(3,encode('event',{...${JSON.stringify(event)},platform:${kind === 'platform-mismatch' ? "process.platform === 'win32' ? 'darwin' : 'win32'" : "process.platform === 'win32' ? 'win32' : 'darwin'"},manifestDigest:'${kind === 'manifest-mismatch' ? '9'.repeat(64) : 'c'.repeat(64)}'}));`;
      writeFileSync(
        child,
        `import {writeSync} from 'node:fs'; import {createCaptureEncoder} from ${JSON.stringify(wireUrl)};
const encode=createCaptureEncoder(process.env.SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE);
writeSync(3,encode('hello',{pid:process.pid,parentPid:process.ppid,platform:process.platform,sourceCommit:'b'.repeat(40),nativeManifestDigest:'c'.repeat(64),packaged:false,packageReady:false}));
${fixtureCode}
writeSync(3,encode('end',{valid:true}));`,
      );
      const collector = await import(
        pathToFileURL(resolve(root, 'collect-computer-use-runtime.mjs')).href
      );
      const capture = collector.startOwnedComputerUseCapture({
        executable: process.execPath,
        args: [child],
        environment: {},
      });
      try {
        const hello = await capture.handshake;
        expect(hello.packaged).toBe(false);
        if (kind !== 'valid') {
          await expect(capture.completed).rejects.toThrow(
            'Computer Use live capture is incomplete',
          );
          return;
        }
        const completed = await capture.completed;
        expect(completed.frameCount).toBe(
          ['darwin', 'win32'].includes(process.platform) ? fixtureEvents.length + 2 : 2,
        );
        if (['darwin', 'win32'].includes(process.platform)) {
          expect(completed.sessions[0].roundsComplete).toBe(true);
          expect(() => {
            completed.sessions[0].rounds[0].ttlVerified = false;
          }).toThrow();
          expect(() => {
            completed.sessions[0].rounds = [];
          }).toThrow();
          const identity = completed.frames.find(
            (frame: { payload: { type?: string } }) => frame.payload.type === 'session',
          );
          expect(() => {
            identity.payload.appDigest = 'a'.repeat(64);
          }).toThrow();
        }
        const verifiedDigest = completed.eventChainDigest;
        expect(() => {
          completed.hello.sourceCommit = 'e'.repeat(40);
        }).toThrow();
        expect(() => {
          completed.frames[0].payload.nativeManifestDigest = 'f'.repeat(64);
        }).toThrow();
        expect(() => {
          completed.sessions.push({});
        }).toThrow();
        expect(completed.eventChainDigest).toBe(verifiedDigest);
        expect(completed.executableSha256).toBe(
          createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
        );
      } finally {
        capture.stopOwnedChild();
      }
    },
  );
});
