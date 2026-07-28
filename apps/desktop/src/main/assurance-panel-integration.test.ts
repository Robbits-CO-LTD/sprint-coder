import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runAdversarialPanel, type SkepticRunner } from './adversarial-panel-runner';
import { buildSkepticPrompt } from './skeptic-prompt';
import {
  advanceStandardAssurance,
  appendEditSagaCriterion,
  createEditSagaEvidence,
  createInitialAcceptanceContract,
  createVerificationEvidence,
  decideCompletion,
  type AssuranceRound,
  type EvidenceRecord,
} from './assurance';

// The panel and the assurance state machine were built apart. This is the proof they compose: a
// refuting panel spends the repair round, a panel nobody answered does not, and only an approving
// one lets the Turn complete.

const planDigest = createHash('sha256').update('plan').digest('hex');
const sagaId = 'saga-1';
const taskId = 'task-1';
const turnId = 'turn-1';
const createdAt = '2026-01-01T00:00:00.000Z';

function contract() {
  return appendEditSagaCriterion(
    createInitialAcceptanceContract({ taskId, turnId, objective: 'add a CSV parser', createdAt }),
    { sagaId, planDigest, paths: ['src/csv.ts'] },
  );
}

const answers = {
  approve: JSON.stringify({ refuted: false, evidence: 'criteria hold', confidence: 'high' }),
  refuse: JSON.stringify({
    refuted: true,
    findings: [{ kind: 'gap', location: 'criterion 1', detail: 'the test asserts a constant' }],
    evidence: 'the committed test never calls parse()',
    confidence: 'medium',
  }),
};

const always =
  (answer: string): SkepticRunner =>
  async () =>
    answer;

async function verify(runner: SkepticRunner, previousRounds: readonly AssuranceRound[]) {
  const run = await runAdversarialPanel({
    runner,
    prompt: buildSkepticPrompt({
      objective: 'add a CSV parser',
      criteria: contract().criteria.map((criterion) => criterion.description),
      claim: 'I added parse() and tests.',
      changedPaths: [...contract().allowedScope],
      priorGaps: [],
    }),
  });
  const round = advanceStandardAssurance({
    taskId,
    turnId,
    sagaId,
    previousRounds,
    outcome: run.result.achieved ? 'passed' : 'failed',
    failureClass: run.failureClass,
    createdAt,
  });
  return { run, round };
}

describe('an adversarial panel driving the assurance state machine', () => {
  it('sends refuted work back for repair, with the gaps to fix', async () => {
    const { run, round } = await verify(always(answers.refuse), []);
    expect(round.decision).toBe('repair');
    expect(round.repairRoundsUsed).toBe(1);
    expect(run.actionableGaps.map((gap) => gap.detail)).toEqual(['the test asserts a constant']);
  });

  it('retries instead of spending the repair round when no skeptic could be reached', async () => {
    const { round } = await verify(() => Promise.reject(new Error('provider down')), []);
    expect(round.decision).toBe('retry_verification');
    expect(round.repairRoundsUsed).toBe(0);
  });

  it('blocks when the work is refuted again after its one repair', async () => {
    const { round: first } = await verify(always(answers.refuse), []);
    const { round: second } = await verify(always(answers.refuse), [first]);
    expect(second.decision).toBe('blocked');
  });

  it('completes and admits evidence only once the panel approves', async () => {
    const { round } = await verify(always(answers.approve), []);
    expect(round.decision).toBe('complete');

    const sealed = contract();
    const evidence: EvidenceRecord[] = [
      createEditSagaEvidence({ contract: sealed, sagaId, planDigest, createdAt }),
    ];
    // The committed patch alone is not completion: the verification criterion is still open.
    expect(decideCompletion(sealed, evidence).allowed).toBe(false);
    expect(decideCompletion(sealed, evidence).openCriterionIds).toEqual([`verification:${sagaId}`]);

    evidence.push(createVerificationEvidence({ contract: sealed, sagaId, planDigest, createdAt }));
    expect(decideCompletion(sealed, evidence).allowed).toBe(true);
  });

  it('does not let a Turn complete on a panel that only half agreed', async () => {
    const runner: SkepticRunner = async ({ skepticIndex }) =>
      skepticIndex === 2 ? answers.refuse : answers.approve;
    const { round } = await verify(runner, []);
    // Cold panel is skeptics 1 and 2, one each way — no majority, so no completion.
    expect(round.decision).toBe('repair');
  });
});
