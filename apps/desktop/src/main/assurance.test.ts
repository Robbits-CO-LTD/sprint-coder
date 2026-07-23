import { describe, expect, it } from 'vitest';
import {
  appendEditSagaCriterion,
  createEditSagaEvidence,
  createInitialAcceptanceContract,
  decideCompletion,
  parseAcceptanceContract,
  parseEvidenceRecord,
} from './assurance';

const createdAt = '2026-07-23T00:00:00.000Z';

describe('Standard Assurance contract and evidence', () => {
  it('allows an answer contract without fabricated evidence', () => {
    const contract = createInitialAcceptanceContract({
      taskId: 'task-1',
      turnId: 'turn-1',
      objective: 'Explain the repository.',
      createdAt,
    });
    expect(parseAcceptanceContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
    expect(decideCompletion(contract, [])).toEqual({ allowed: true, openCriterionIds: [] });
  });

  it('requires Main-observed evidence for every sealed Edit Saga criterion', () => {
    const initial = createInitialAcceptanceContract({
      taskId: 'task-1',
      turnId: 'turn-1',
      objective: 'Edit two files.',
      createdAt,
    });
    const contract = appendEditSagaCriterion(initial, {
      sagaId: 'saga-1',
      planDigest: 'a'.repeat(64),
      paths: ['src/a.ts', 'src/b.ts'],
    });
    expect(contract).toMatchObject({
      revision: 2,
      taskKind: 'edit',
      completionMode: 'evidence',
      profile: 'standard',
      maxRepairRounds: 1,
      allowedScope: ['src/a.ts', 'src/b.ts'],
    });
    expect(decideCompletion(contract, [])).toEqual({
      allowed: false,
      openCriterionIds: ['edit-saga:saga-1'],
    });

    const evidence = createEditSagaEvidence({
      contract,
      sagaId: 'saga-1',
      planDigest: 'a'.repeat(64),
      createdAt,
    });
    expect(parseEvidenceRecord(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
    expect(decideCompletion(contract, [evidence])).toEqual({
      allowed: true,
      openCriterionIds: [],
    });
  });

  it('rejects tampered evidence and criterion reuse with another plan', () => {
    const initial = createInitialAcceptanceContract({
      taskId: 'task-1',
      turnId: 'turn-1',
      objective: 'Edit safely.',
      createdAt,
    });
    const contract = appendEditSagaCriterion(initial, {
      sagaId: 'saga-1',
      planDigest: 'a'.repeat(64),
      paths: ['a.ts'],
    });
    expect(() =>
      appendEditSagaCriterion(contract, {
        sagaId: 'saga-1',
        planDigest: 'b'.repeat(64),
        paths: ['b.ts'],
      }),
    ).toThrow();
    const evidence = createEditSagaEvidence({
      contract,
      sagaId: 'saga-1',
      planDigest: 'a'.repeat(64),
      createdAt,
    });
    expect(
      decideCompletion(contract, [{ ...evidence, subjectDigest: 'b'.repeat(64) }]),
    ).toEqual({
      allowed: false,
      openCriterionIds: ['edit-saga:saga-1'],
    });
  });
});
