import { createHash } from 'node:crypto';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => {
  throw new Error('Computer Use round evidence is incomplete');
};

/** Consumed directly by the owned-child collector; this computes facts, not authenticity. */
export function summarizeComputerUseCaptureRounds(frames) {
  const sessions = new Map();
  for (const frame of frames) {
    if (frame.kind !== 'event') continue;
    const event = frame.payload;
    if (event.type === 'session') {
      if (sessions.has(event.sessionDigest)) fail();
      sessions.set(event.sessionDigest, {
        identity: event,
        rounds: [],
        pending: null,
        observation: null,
        requests: new Set(),
        stopped: false,
        invalid: false,
        preflightAttempts: 0,
        preflightPassed: false,
        bindingDigest: null,
        attemptCount: event.inputAttemptCount ?? null,
      });
      continue;
    }
    const session = sessions.get(event.sessionDigest);
    if (!session) fail();
    if (session.stopped) session.invalid = true;
    const pending = session.pending;
    if (event.type === 'preflight_started') {
      session.preflightAttempts += 1;
      session.bindingDigest = event.bindingDigest;
      if (event.isOpenRouter !== false || session.rounds.length || pending) session.invalid = true;
    } else if (event.type === 'preflight_passed') {
      if (
        session.preflightAttempts !== 1 ||
        session.preflightPassed ||
        event.bindingDigest !== session.bindingDigest
      )
        session.invalid = true;
      session.preflightPassed = true;
    } else if (event.type === 'observation') {
      if (
        event.appDigest !== session.identity.appDigest ||
        event.windowDigest !== session.identity.windowDigest
      )
        session.invalid = true;
      if (pending?.result) {
        if (
          event.revision <= pending.start.revision ||
          !pending.parse ||
          pending.requests.length === 0 ||
          pending.requests.length !== pending.receipts.length ||
          pending.inflight.size !== 0 ||
          pending.result.result !== 'completed'
        )
          session.invalid = true;
        else
          session.rounds.push({
            round: pending.start.round,
            revision: pending.start.revision,
            updatedRevision: event.revision,
            actionClass: pending.parse.actionClass,
            actionDigest: pending.parse.actionDigest,
            nativeActionDigest: pending.nativeActionDigest,
            nativeRequestDigests: pending.requests,
            nativeReceiptDigest: digest(pending.receipts),
            brokerDecisionDigest: digest(pending.result),
            latencyMs: pending.parse.latencyMs,
            ttlVerified: pending.ttl && event.ttlVerified === true,
            result: 'completed',
          });
        session.pending = null;
      } else if (pending) session.invalid = true;
      session.observation = event;
    } else if (event.type === 'round_started') {
      if (
        pending ||
        !session.observation ||
        event.revision !== session.observation.revision ||
        event.round !== session.rounds.length + 1 ||
        event.round > 3 ||
        !session.preflightPassed ||
        event.bindingDigest !== session.bindingDigest
      )
        session.invalid = true;
      session.pending = {
        start: event,
        parse: null,
        requests: [],
        receipts: [],
        inflight: new Set(),
        result: null,
        nativeActionDigest: null,
        ttl: session.observation?.ttlVerified === true,
      };
    } else if (event.type === 'parsed') {
      if (
        !pending ||
        pending.parse ||
        event.round !== pending.start.round ||
        event.revision !== pending.start.revision ||
        event.bindingDigest !== pending.start.bindingDigest
      ) {
        session.invalid = true;
        continue;
      }
      pending.parse = event;
      pending.ttl &&= event.ttlVerified === true;
    } else if (event.type === 'native_started') {
      if (
        !pending?.parse ||
        event.revision !== pending.start.revision ||
        event.actionDigest !== pending.parse.actionDigest ||
        session.requests.has(event.requestDigest) ||
        event.cancelEpoch !== session.identity.cancelEpoch
      ) {
        session.invalid = true;
        continue;
      }
      session.requests.add(event.requestDigest);
      pending.requests.push(event.requestDigest);
      pending.inflight.add(event.requestDigest);
      pending.nativeActionDigest = event.actionDigest;
      pending.ttl &&= event.ttlVerified === true;
    } else if (event.type === 'native_finished') {
      if (
        !pending ||
        !pending.inflight.delete(event.requestDigest) ||
        event.revision !== pending.start.revision ||
        event.actionDigest !== pending.parse?.actionDigest ||
        event.result !== 'completed' ||
        event.cancelEpoch === undefined ||
        event.cancelEpoch !== session.identity.cancelEpoch ||
        event.requestDigest !== pending.requests[pending.receipts.length] ||
        event.inputAttemptCount === undefined ||
        session.attemptCount === null ||
        event.inputAttemptCount < session.attemptCount
      ) {
        session.invalid = true;
        continue;
      }
      session.attemptCount = event.inputAttemptCount;
      pending.receipts.push(event);
    } else if (event.type === 'action_result') {
      if (
        !pending ||
        pending.result ||
        pending.inflight.size !== 0 ||
        event.actionDigest !== pending.parse?.actionDigest ||
        event.revision !== pending.start.revision
      ) {
        session.invalid = true;
        continue;
      }
      pending.result = event;
    } else if (event.type === 'stop_acknowledged') {
      if (
        event.nativeAcknowledged !== true ||
        pending ||
        event.inputAttemptCount !== session.attemptCount ||
        event.cancelEpoch !== session.identity.cancelEpoch + 1
      )
        session.invalid = true;
      session.stopped = true;
    }
  }
  return [...sessions.entries()].map(([sessionIdDigest, session]) => ({
    sessionIdDigest,
    platform: session.identity.platform,
    nativeManifestDigest: session.identity.manifestDigest,
    rounds: session.rounds,
    roundsComplete:
      !session.invalid &&
      session.stopped &&
      session.pending === null &&
      session.rounds.length === 3 &&
      session.rounds.every(({ ttlVerified }) => ttlVerified),
  }));
}
