import { createHash } from 'node:crypto';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => {
  throw new Error('Computer Use round evidence is incomplete');
};

/** Fixed by this module's version, not measured: the schema pins the same adapter contract. */
export const COMPUTER_USE_CAPTURE_ADAPTER_VERSION = 'computer-use-v1';
const BINDING_IDENTITY_KEYS = [
  'connectionIdDigest',
  'modelIdDigest',
  'endpointDigest',
  'catalogDigest',
  'policyEpoch',
  'selectedFromCurrentTask',
  'fallbackUsed',
  'credentialChanged',
];

/**
 * Canonical digest of the Provider binding identity. Every preflight/round/parse event carries a
 * `bindingDigest`; requiring it to equal this makes the opaque token a checked commitment to the
 * identity fields, so a claimed identity that the rounds never bound to fails closed.
 */
export function computerUseCaptureBindingDigest(identity) {
  return digest(BINDING_IDENTITY_KEYS.map((key) => identity[key]));
}

/** `null` when unclaimed, `undefined` when partially claimed (never completed from elsewhere). */
function bindingIdentity(event) {
  const present = BINDING_IDENTITY_KEYS.filter((key) => event[key] !== undefined);
  if (present.length === 0) return null;
  if (present.length !== BINDING_IDENTITY_KEYS.length) return undefined;
  return Object.fromEntries(BINDING_IDENTITY_KEYS.map((key) => [key, event[key]]));
}

/**
 * Builds the Provider binding out of measured facts only. A missing consent, missing cost bound,
 * unclaimed or unbound identity, or an incomplete journey yields `null`: an unresolved binding is
 * left unresolved rather than filled in from a producer-supplied object.
 */
function measuredBinding(session, sessionIdDigest, roundsComplete) {
  const identity = session.bindingIdentity;
  if (
    !roundsComplete ||
    !identity ||
    session.bindingDigest === null ||
    session.egressDigest === null ||
    session.costLimitDigest === null ||
    !session.bindingStable ||
    computerUseCaptureBindingDigest(identity) !== session.bindingDigest
  )
    return null;
  return {
    ...identity,
    adapterVersion: COMPUTER_USE_CAPTURE_ADAPTER_VERSION,
    sessionIdDigest,
    bindingStable: session.bindingStable,
    preflightAttempts: session.preflightAttempts,
    preflightPassed: session.preflightPassed,
    roundsAttempted: session.roundsAttempted,
    roundsCompleted: session.rounds.length,
    isOpenRouter: session.isOpenRouter,
  };
}

/** Detach bounded JSON metadata before freezing; never freeze caller-owned state. */
export function immutableCaptureResult(value) {
  const freeze = (item) => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(structuredClone(value));
}

/** Consumed directly by the owned-child collector; this computes facts, not authenticity. */
export function summarizeComputerUseCaptureRounds(frames) {
  const sessions = new Map();
  const hello = frames[0]?.kind === 'hello' ? frames[0].payload : null;
  if (!hello || frames.filter((frame) => frame.kind === 'hello').length !== 1) fail();
  for (const frame of frames) {
    if (frame.kind !== 'event') continue;
    const event = frame.payload;
    if (event.type === 'session') {
      if (
        sessions.has(event.sessionDigest) ||
        event.platform !== hello.platform ||
        event.manifestDigest !== hello.nativeManifestDigest
      )
        fail();
      sessions.set(event.sessionDigest, {
        identity: event,
        rounds: [],
        pending: null,
        observation: null,
        requests: new Set(),
        stopped: false,
        stopping: false,
        invalid: false,
        preflightAttempts: 0,
        preflightPassed: false,
        bindingDigest: null,
        bindingIdentity: null,
        bindingStable: true,
        isOpenRouter: null,
        roundsAttempted: 0,
        egressDigest: null,
        costLimitDigest: null,
        maxRounds: null,
        attemptCount: event.inputAttemptCount ?? null,
      });
      continue;
    }
    const session = sessions.get(event.sessionDigest);
    if (!session) fail();
    if (session.stopped) session.invalid = true;
    // Drain receipts may arrive after Stop intent, but no new work may start or be
    // promoted into a completed Core journey after that boundary.
    if (
      session.stopping &&
      !['native_finished', 'stop_requested', 'stop_acknowledged'].includes(event.type)
    )
      session.invalid = true;
    const pending = session.pending;
    if (event.type === 'preflight_started') {
      session.preflightAttempts += 1;
      session.bindingDigest = event.bindingDigest;
      session.isOpenRouter = event.isOpenRouter;
      const identity = bindingIdentity(event);
      if (identity === undefined) session.invalid = true;
      else session.bindingIdentity = identity;
      if (
        session.preflightAttempts !== 1 ||
        event.isOpenRouter !== false ||
        session.rounds.length ||
        pending
      )
        session.invalid = true;
    } else if (event.type === 'preflight_passed') {
      if (event.bindingDigest !== session.bindingDigest) session.bindingStable = false;
      if (
        session.preflightAttempts !== 1 ||
        session.preflightPassed ||
        event.bindingDigest !== session.bindingDigest
      )
        session.invalid = true;
      session.preflightPassed = true;
    } else if (event.type === 'egress_authorized') {
      // One consent decision governs the whole run: a later divergent one is not a second run.
      if (session.rounds.length || pending) session.invalid = true;
      if (session.egressDigest === null) session.egressDigest = event.egressDigest;
      else if (session.egressDigest !== event.egressDigest) session.invalid = true;
    } else if (event.type === 'cost_limit_bound') {
      if (session.rounds.length || pending || event.maxRounds === undefined) session.invalid = true;
      if (session.costLimitDigest === null) {
        session.costLimitDigest = event.costLimitDigest;
        session.maxRounds = event.maxRounds ?? null;
      } else if (
        session.costLimitDigest !== event.costLimitDigest ||
        session.maxRounds !== (event.maxRounds ?? null)
      )
        session.invalid = true;
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
      session.roundsAttempted += 1;
      if (event.bindingDigest !== session.bindingDigest) session.bindingStable = false;
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
      if (event.bindingDigest !== session.bindingDigest) session.bindingStable = false;
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
    } else if (event.type === 'stop_requested') {
      session.stopping = true;
    } else if (event.type === 'stop_acknowledged') {
      if (
        !session.stopping ||
        event.nativeAcknowledged !== true ||
        pending ||
        event.inputAttemptCount !== session.attemptCount ||
        event.cancelEpoch !== session.identity.cancelEpoch + 1
      )
        session.invalid = true;
      session.stopped = true;
    }
  }
  return immutableCaptureResult(
    [...sessions.entries()].map(([sessionIdDigest, session]) => {
      const roundsComplete =
        !session.invalid &&
        session.preflightAttempts === 1 &&
        session.preflightPassed &&
        session.stopping &&
        session.stopped &&
        session.pending === null &&
        session.rounds.length === 3 &&
        session.rounds.every(({ ttlVerified }) => ttlVerified);
      return {
        sessionIdDigest,
        platform: session.identity.platform,
        nativeManifestDigest: session.identity.manifestDigest,
        rounds: session.rounds,
        roundsAttempted: session.roundsAttempted,
        // `null` means the run never bound one, not that it was unconstrained.
        egressConsentDigest: session.egressDigest,
        costLimitDigest: session.costLimitDigest,
        maxRounds: session.maxRounds,
        roundsComplete,
        binding: measuredBinding(session, sessionIdDigest, roundsComplete),
      };
    }),
  );
}
