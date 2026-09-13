#!/usr/bin/env node
// Tests for lane-peek's turn acceptance (no CDP, no Electron).
//   node --test lane-peek-turn.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import turn from './lane-peek-turn.cjs';

const { decidePoll, turnIdentity } = turn;

// snapshot helper: userCount user messages, the run card anchored under user message #cardUnder
// (0 = no card at all), in state `status`.
const snap = ({ userCount = 1, cardUnder = 1, status = 'completed', approval = null, lastUser = 'u', lastAssistant = 'a' } = {}) => ({
  userCount, runCount: cardUnder === 0 ? 0 : 1, runCardUserIndex: cardUnder, lastRun: cardUnder === 0 ? null : status,
  lastUser, lastAssistant, approval, commands: [], files: [], audit: [],
});

const idle = snap({ userCount: 1, cardUnder: 1, status: 'completed' });
const baselineOf = (s) => ({ lane: 'claude', identity: turnIdentity(s), userCount: s.userCount, runCount: s.runCount, runCardUserIndex: s.runCardUserIndex, lastRun: s.lastRun });

test('an optimistic user message alone does not accept the previous turn (with baseline)', () => {
  const base = baselineOf(idle);
  // 送信 直後: the new user message is on screen, but the card still belongs to the previous one.
  const d = decidePoll(null, snap({ userCount: 2, cardUnder: 1, status: 'completed' }), base);
  assert.equal(d.newTurnObserved, false);
  assert.equal(d.accepted, null);
  assert.equal(d.done, false);
});

test('an optimistic user message alone does not accept the previous turn (no baseline)', () => {
  const d = decidePoll(null, snap({ userCount: 2, cardUnder: 1, status: 'completed' }));
  assert.equal(d.newTurnObserved, false);
  assert.equal(d.done, false);
});

test('a new run card going running -> completed is accepted', () => {
  const base = baselineOf(idle);
  const running = decidePoll(null, snap({ userCount: 2, cardUnder: 2, status: 'running' }), base);
  assert.equal(running.newTurnObserved, true);
  assert.equal(running.accepted, null, 'still running: keep polling');
  const done = decidePoll(running, snap({ userCount: 2, cardUnder: 2, status: 'completed' }), base);
  assert.equal(done.accepted, 'terminal');
  assert.equal(done.done, true);
});

test('with a baseline, a turn that finished between two reads is still accepted', () => {
  const base = baselineOf(idle);
  const d = decidePoll(null, snap({ userCount: 2, cardUnder: 2, status: 'completed' }), base);
  assert.equal(d.newTurnObserved, true);
  assert.equal(d.accepted, 'terminal');
});

test('without a baseline, only a card seen running counts (fail closed)', () => {
  const d = decidePoll(null, snap({ userCount: 2, cardUnder: 2, status: 'completed' }));
  assert.equal(d.newTurnObserved, false, 'cannot tell this from the previous turn without a baseline');
  assert.equal(d.accepted, null);
});

test("a leftover approval card from the previous turn is not accepted", () => {
  const base = baselineOf({ ...idle, approval: { text: '許可しますか' } });
  const d = decidePoll(null, snap({ userCount: 2, cardUnder: 1, status: 'completed', approval: { text: '許可しますか' } }), base);
  assert.equal(d.newTurnObserved, false);
  assert.equal(d.accepted, null);
});

test("this turn's approval card is accepted", () => {
  const base = baselineOf(idle);
  const d = decidePoll(null, snap({ userCount: 2, cardUnder: 2, status: 'running', approval: { text: '許可しますか' } }), base);
  assert.equal(d.newTurnObserved, true);
  assert.equal(d.accepted, 'approval');
  assert.equal(d.done, true);
});

test('the very first turn of a fresh lane is accepted', () => {
  const base = baselineOf(snap({ userCount: 0, cardUnder: 0 }));
  const running = decidePoll(null, snap({ userCount: 1, cardUnder: 1, status: 'running' }), base);
  assert.equal(running.newTurnObserved, true);
  assert.equal(decidePoll(running, snap({ userCount: 1, cardUnder: 1, status: 'failed' }), base).accepted, 'terminal');
});

test('a send that never reached the runtime stays unaccepted (optimistic message rolled back)', () => {
  const base = baselineOf(idle);
  const d = decidePoll(null, idle, base);
  assert.equal(d.newTurnObserved, false);
  assert.equal(d.accepted, null);
});

test('newTurnObserved is sticky but acceptance still needs the current card', () => {
  const base = baselineOf(idle);
  const running = decidePoll(null, snap({ userCount: 2, cardUnder: 2, status: 'running' }), base);
  // a transient read where the card is not rendered (message list re-render) must not accept
  const gap = decidePoll(running, snap({ userCount: 2, cardUnder: 0 }), base);
  assert.equal(gap.newTurnObserved, true);
  assert.equal(gap.accepted, null);
});

test('turnIdentity separates the pre-send snapshot from the new turn', () => {
  assert.notEqual(turnIdentity(idle), turnIdentity(snap({ userCount: 2, cardUnder: 2, status: 'running' })));
  assert.equal(turnIdentity(idle), turnIdentity(snap({ userCount: 1, cardUnder: 1, status: 'completed' })));
});
