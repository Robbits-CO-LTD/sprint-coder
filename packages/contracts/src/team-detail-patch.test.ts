import { describe, expect, it } from 'vitest';
import {
  applyTeamDetailPatch,
  diffTeamDetail,
  isEmptyTeamDetailPatch,
  teamDetailPatchSchema,
  teamDetailSchema,
  TeamDetailPatchMismatchError,
  type TeamDetail,
} from './index';
import {
  fixtureActivity,
  fixtureExecution,
  fixtureMessage,
  fixtureWorker,
  fixtureWorkerId,
  largeTeamDetail,
} from './team-detail-fixture';

/** A small deterministic generator, so a failing case can be replayed from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    chance: (p: number) => next() < p,
    text: (length: number) =>
      Array.from({ length }, () => 'abcdefgh \n日本'.charAt(Math.floor(next() * 12))).join(''),
  };
}

type Random = ReturnType<typeof random>;

/** One random change of the kinds a Team goes through: progress, hires, messages, state, order. */
function mutate(detail: TeamDetail, rng: Random, counter: { value: number }): TeamDetail {
  const next = structuredClone(detail);
  const changes = 1 + rng.int(4);
  for (let change = 0; change < changes; change += 1) {
    const kind = rng.int(12);
    const workers = next.workers;
    const pick = workers.length > 1 ? 1 + rng.int(workers.length - 1) : 0;
    const worker = workers[pick];
    if (kind <= 2 && worker !== undefined) {
      // Streamed output, kept to its last characters like the coordinator does.
      const limit = rng.chance(0.5) ? 20_000 : 300;
      worker.liveOutput = `${worker.liveOutput}${rng.text(1 + rng.int(400))}`.slice(-limit);
    } else if (kind === 3 && worker !== undefined) {
      worker.liveOutput = rng.chance(0.5) ? '' : rng.text(rng.int(50));
    } else if (kind === 4 && worker !== undefined) {
      worker.currentActivity = rng.chance(0.2) ? null : `step ${rng.int(1000)}`;
      worker.state = rng.chance(0.5) ? 'busy' : 'done';
      worker.updatedAt = new Date(Date.UTC(2026, 9, 18, 0, 0, rng.int(3600))).toISOString();
    } else if (kind === 5) {
      counter.value += 1;
      workers.push(fixtureWorker(1000 + counter.value, rng.chance(0.5) ? '' : rng.text(30)));
    } else if (kind === 6 && workers.length > 1) {
      workers.splice(pick, 1);
    } else if (kind === 7) {
      counter.value += 1;
      next.messages.push(fixtureMessage(500 + counter.value, 1 + rng.int(4), rng.chance(0.5)));
    } else if (kind === 8 && next.messages.length > 0) {
      const message = next.messages[rng.int(next.messages.length)]!;
      message.state = 'delivered';
      message.content = rng.text(1 + rng.int(80));
    } else if (kind === 9) {
      counter.value += 1;
      next.activities.push(fixtureActivity(500 + counter.value, 1));
      if (next.activities.length > 12) next.activities.shift();
    } else if (kind === 10) {
      if (next.executions.length > 0 && rng.chance(0.6)) {
        const execution = next.executions[rng.int(next.executions.length)]!;
        execution.state = 'completed';
        execution.workerQueueDepth = rng.int(3);
      } else {
        counter.value += 1;
        next.executions.unshift(fixtureExecution(900 + counter.value));
      }
    } else {
      if (rng.chance(0.5)) next.team.revision += 1;
      if (rng.chance(0.5)) next.budgets = [{ ...next.budgets[0]!, committed: rng.int(500) }];
      if (rng.chance(0.3)) next.workers.reverse();
    }
  }
  return teamDetailSchema.parse(next);
}

describe('Team detail patches (issue #863)', () => {
  it('rebuilds exactly the next detail over long random histories, also after crossing IPC', () => {
    // 40 seeds × 60 steps of a 50-message Team, each patch validated and cloned: about 2 s locally
    // and 8 s on a busy CI runner, so it gets an explicit budget rather than the 5 s default.
    for (let seed = 1; seed <= 40; seed += 1) {
      const rng = random(seed);
      const counter = { value: 0 };
      let held = largeTeamDetail(4, 50);
      let truth = held;
      for (let step = 0; step < 60; step += 1) {
        const next = mutate(truth, rng, counter);
        const patch = diffTeamDetail(truth, next);
        expect(patch, `seed ${seed} step ${step}`).not.toBeNull();
        // What Preload receives: the patch validated and copied.
        const received = teamDetailPatchSchema.parse(structuredClone(patch));
        held = applyTeamDetailPatch(held, received);
        expect(held, `seed ${seed} step ${step}`).toEqual(next);
        truth = next;
      }
    }
  }, 60_000);

  it('keeps everything the patch leaves alone, so only what changed re-renders', () => {
    const base = largeTeamDetail(32, 2_000);
    const next = structuredClone(base);
    next.workers[3]!.liveOutput += 'more';
    next.workers[5]!.currentActivity = 'testing';
    const patch = diffTeamDetail(base, next)!;
    expect(Object.keys(patch).sort()).toEqual(['liveOutputs', 'workers']);
    const applied = applyTeamDetailPatch(base, patch);
    expect(applied).toEqual(next);
    expect(applied.messages).toBe(base.messages);
    expect(applied.activities).toBe(base.activities);
    expect(applied.executions).toBe(base.executions);
    expect(applied.workers[1]).toBe(base.workers[1]);
    expect(applied.workers[3]).not.toBe(base.workers[3]);
  });

  it('sends only the new text of a live output, also once old text falls off its front', () => {
    const base = largeTeamDetail(2, 0);
    const grown = structuredClone(base);
    grown.workers[1]!.liveOutput = 'a'.repeat(19_990) + 'b'.repeat(10);
    const capped = structuredClone(grown);
    capped.workers[1]!.liveOutput = `${grown.workers[1]!.liveOutput}${'c'.repeat(50)}`.slice(
      -20_000,
    );
    expect(diffTeamDetail(base, grown)!.liveOutputs).toEqual([
      { agentId: fixtureWorkerId(1), drop: 0, append: grown.workers[1]!.liveOutput },
    ]);
    expect(diffTeamDetail(grown, capped)!.liveOutputs).toEqual([
      { agentId: fixtureWorkerId(1), drop: 50, append: 'c'.repeat(50) },
    ]);
    expect(applyTeamDetailPatch(grown, diffTeamDetail(grown, capped)!)).toEqual(capped);
  });

  it('has nothing to send for an equal detail and refuses another Team', () => {
    const base = largeTeamDetail(3, 10);
    expect(isEmptyTeamDetailPatch(diffTeamDetail(base, structuredClone(base))!)).toBe(true);
    const other = structuredClone(base);
    other.team.id = 'team-other';
    expect(diffTeamDetail(base, other)).toBeNull();
  });

  it('rejects a patch made from another detail instead of building a wrong one', () => {
    const base = largeTeamDetail(3, 10);
    const next = structuredClone(base);
    next.workers.push(fixtureWorker(77, 'hello'));
    const patch = diffTeamDetail(base, next)!;
    const unrelated = { ...base, workers: base.workers.slice(0, 1) };
    const stale = { ...patch, workers: { upserts: patch.workers!.upserts } };
    expect(() => applyTeamDetailPatch(unrelated, patch)).toThrow(TeamDetailPatchMismatchError);
    expect(() => applyTeamDetailPatch(base, stale)).toThrow(TeamDetailPatchMismatchError);
    const shorter = structuredClone(base);
    shorter.workers[1]!.liveOutput = '';
    const grown = structuredClone(base);
    grown.workers[1]!.liveOutput = `${base.workers[1]!.liveOutput.slice(5)}!`;
    expect(() => applyTeamDetailPatch(shorter, diffTeamDetail(base, grown)!)).toThrow(
      TeamDetailPatchMismatchError,
    );
  });
});
