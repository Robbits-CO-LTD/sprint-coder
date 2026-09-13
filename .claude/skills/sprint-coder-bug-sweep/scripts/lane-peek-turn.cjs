// Turn-progress decisions for lane-peek.cjs, kept free of CDP so they can be unit tested
// (scripts/lane-peek-turn.test.mjs) without an Electron instance.
//
// What the renderer actually does (apps/desktop/src/renderer: appStore.startTurn / handleTurnEvent
// 'turn.accepted', ChatSurface/Timeline.tsx):
//   - Exactly ONE run card is in the DOM: the CURRENT turn's. Timeline renders it under the user
//     message whose turnId equals turnByTask[taskId].turnId, so the card count never grows.
//   - 送信 first appends an OPTIMISTIC user message and only the later 'turn.accepted' event moves
//     turnByTask to the new turn. Between the two, the DOM shows the NEW user message and the
//     PREVIOUS turn's terminal card still anchored under the PREVIOUS user message.
// So neither "a user message appeared" nor "the last card is terminal" says anything about the turn
// we just sent. The only sound signal is that the run card sits under the NEWEST user message —
// `runCardUserIndex` (how many user messages precede the card in document order) === `userCount`.
'use strict';
const crypto = require('node:crypto');

const TERMINAL = ['completed', 'failed', 'canceled', 'interrupted'];

/** The single run card describes the newest user message's turn (not a leftover from the last one). */
function currentTurnCard(snap) {
  return snap.runCount > 0 && snap.userCount > 0 && snap.runCardUserIndex === snap.userCount;
}

/** Stable identity of what is on screen; the pre-send baseline stores it. */
function turnIdentity(snap) {
  return crypto.createHash('sha256').update(JSON.stringify([
    snap.userCount, snap.lastUser, snap.runCount, snap.runCardUserIndex, snap.lastRun, snap.lastAssistant,
    snap.commands?.length ?? 0, snap.files?.length ?? 0, snap.audit?.length ?? 0, snap.approval?.text ?? null,
  ])).digest('hex').slice(0, 16);
}

/**
 * One --poll step. `prev` is the previous return value (or null), `snap` the fresh read, `baseline`
 * the --baseline-out snapshot recorded before 送信 (or null).
 *   newTurnObserved  sticky: a run card for the newest user message was seen at least once
 *   accepted         'terminal' | 'approval' | null — what may be reported as THIS turn's result
 *   done             stop polling
 * Without a baseline the only evidence of a new turn is watching that card go running→terminal, so a
 * turn that starts and finishes between two reads is never accepted (that is what --baseline is for).
 */
function decidePoll(prev, snap, baseline = null) {
  const current = currentTurnCard(snap);
  const fresh = current && (baseline
    ? snap.userCount > (baseline.userCount ?? Number.POSITIVE_INFINITY) || (snap.lastRun === 'running' && turnIdentity(snap) !== baseline.identity)
    : snap.lastRun === 'running');
  const newTurnObserved = Boolean(prev?.newTurnObserved) || fresh;
  let accepted = null;
  if (newTurnObserved && current) {
    if (snap.approval) accepted = 'approval';
    else if (TERMINAL.includes(snap.lastRun)) accepted = 'terminal';
  }
  return { newTurnObserved, accepted, done: accepted !== null };
}

module.exports = { TERMINAL, currentTurnCard, turnIdentity, decidePoll };
