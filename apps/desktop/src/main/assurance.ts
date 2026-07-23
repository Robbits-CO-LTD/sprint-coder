import { createHash, randomUUID } from 'node:crypto';

export type AssuranceProfile = 'quick' | 'standard';
export type EvidenceKind = 'edit_saga_committed';

export type AcceptanceCriterion = Readonly<{
  id: string;
  description: string;
  gating: boolean;
  evidenceKind: EvidenceKind;
  subjectDigest: string;
}>;

export type AcceptanceContract = Readonly<{
  version: 1;
  id: string;
  taskId: string;
  turnId: string;
  revision: number;
  objective: string;
  taskKind: 'answer' | 'edit';
  completionMode: 'response' | 'evidence';
  profile: AssuranceProfile;
  criteria: readonly AcceptanceCriterion[];
  nonGoals: readonly string[];
  allowedScope: readonly string[];
  maxRepairRounds: 0 | 1;
  digest: string;
  createdAt: string;
}>;

export type EvidenceRecord = Readonly<{
  version: 1;
  id: string;
  taskId: string;
  turnId: string;
  criterionId: string;
  criterionDigest: string;
  kind: EvidenceKind;
  producer: 'edit-saga';
  trust: 'main-observed';
  subjectDigest: string;
  contractRevision: number;
  createdAt: string;
  recordDigest: string;
}>;

export type CompletionDecision = Readonly<{
  allowed: boolean;
  openCriterionIds: readonly string[];
}>;

export function createInitialAcceptanceContract(input: {
  taskId: string;
  turnId: string;
  objective: string;
  createdAt: string;
}): AcceptanceContract {
  return sealContract({
    version: 1,
    id: randomUUID(),
    taskId: input.taskId,
    turnId: input.turnId,
    revision: 1,
    objective: input.objective,
    taskKind: 'answer',
    completionMode: 'response',
    profile: 'quick',
    criteria: [],
    nonGoals: [],
    allowedScope: [],
    maxRepairRounds: 0,
    createdAt: input.createdAt,
  });
}

export function appendEditSagaCriterion(
  current: AcceptanceContract,
  input: { sagaId: string; planDigest: string; paths: readonly string[] },
): AcceptanceContract {
  const criterionId = `edit-saga:${input.sagaId}`;
  const existing = current.criteria.find((criterion) => criterion.id === criterionId);
  if (existing !== undefined) {
    if (existing.subjectDigest !== input.planDigest)
      throw new Error('Acceptance criterion id was reused with another subject');
    return current;
  }
  return sealContract({
    ...withoutContractDigest(current),
    revision: current.revision + 1,
    taskKind: 'edit',
    completionMode: 'evidence',
    profile: 'standard',
    criteria: [
      ...current.criteria,
      {
        id: criterionId,
        description: `Edit Saga ${input.sagaId} committed its sealed patch`,
        gating: true,
        evidenceKind: 'edit_saga_committed',
        subjectDigest: input.planDigest,
      },
    ],
    allowedScope: [...new Set([...current.allowedScope, ...input.paths])].sort(),
    maxRepairRounds: 1,
  });
}

export function createEditSagaEvidence(input: {
  contract: AcceptanceContract;
  sagaId: string;
  planDigest: string;
  createdAt: string;
}): EvidenceRecord {
  const criterion = input.contract.criteria.find(
    (candidate) => candidate.id === `edit-saga:${input.sagaId}`,
  );
  if (
    criterion === undefined ||
    criterion.evidenceKind !== 'edit_saga_committed' ||
    criterion.subjectDigest !== input.planDigest
  )
    throw new Error('Committed Edit Saga is not present in the Acceptance Contract');
  const facts = {
    version: 1 as const,
    id: randomUUID(),
    taskId: input.contract.taskId,
    turnId: input.contract.turnId,
    criterionId: criterion.id,
    criterionDigest: acceptanceCriterionDigest(criterion),
    kind: criterion.evidenceKind,
    producer: 'edit-saga' as const,
    trust: 'main-observed' as const,
    subjectDigest: input.planDigest,
    contractRevision: input.contract.revision,
    createdAt: input.createdAt,
  };
  return Object.freeze({ ...facts, recordDigest: digest(facts) });
}

export function decideCompletion(
  contract: AcceptanceContract,
  evidence: readonly EvidenceRecord[],
): CompletionDecision {
  const valid = new Set(
    evidence
      .filter(
        (record) =>
          record.taskId === contract.taskId &&
          record.turnId === contract.turnId &&
          record.contractRevision <= contract.revision &&
          record.recordDigest === digest(withoutRecordDigest(record)),
      )
      .map(
        (record) =>
          `${record.criterionId}:${record.criterionDigest}:${record.kind}:${record.subjectDigest}`,
      ),
  );
  const openCriterionIds = contract.criteria
    .filter(
      (criterion) =>
        criterion.gating &&
        !valid.has(
          `${criterion.id}:${acceptanceCriterionDigest(criterion)}:${criterion.evidenceKind}:${criterion.subjectDigest}`,
        ),
    )
    .map((criterion) => criterion.id);
  return Object.freeze({
    allowed: openCriterionIds.length === 0,
    openCriterionIds: Object.freeze(openCriterionIds),
  });
}

export function parseAcceptanceContract(value: unknown): AcceptanceContract {
  if (!isRecord(value)) throw new Error('Invalid Acceptance Contract');
  const contract = value as unknown as AcceptanceContract;
  if (
    contract.version !== 1 ||
    !isIdentifier(contract.id) ||
    !isIdentifier(contract.taskId) ||
    !isIdentifier(contract.turnId) ||
    !Number.isSafeInteger(contract.revision) ||
    contract.revision < 1 ||
    typeof contract.objective !== 'string' ||
    contract.objective.length < 1 ||
    contract.objective.length > 100_000 ||
    !['answer', 'edit'].includes(contract.taskKind) ||
    !['response', 'evidence'].includes(contract.completionMode) ||
    !['quick', 'standard'].includes(contract.profile) ||
    !Array.isArray(contract.criteria) ||
    !Array.isArray(contract.nonGoals) ||
    !Array.isArray(contract.allowedScope) ||
    ![0, 1].includes(contract.maxRepairRounds) ||
    !isIsoDate(contract.createdAt) ||
    !isDigest(contract.digest)
  )
    throw new Error('Invalid Acceptance Contract');
  for (const criterion of contract.criteria) validateCriterion(criterion);
  if (
    new Set(contract.criteria.map((criterion) => criterion.id)).size !==
      contract.criteria.length ||
    contract.nonGoals.some((item) => typeof item !== 'string' || item.length > 4_096) ||
    contract.allowedScope.some((item) => typeof item !== 'string' || item.length > 4_096) ||
    contract.digest !== digest(withoutContractDigest(contract))
  )
    throw new Error('Invalid Acceptance Contract');
  return deepFreeze(contract);
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  if (!isRecord(value)) throw new Error('Invalid Evidence Record');
  const record = value as unknown as EvidenceRecord;
  if (
    record.version !== 1 ||
    !isIdentifier(record.id) ||
    !isIdentifier(record.taskId) ||
    !isIdentifier(record.turnId) ||
    !isIdentifier(record.criterionId) ||
    !isDigest(record.criterionDigest) ||
    record.kind !== 'edit_saga_committed' ||
    record.producer !== 'edit-saga' ||
    record.trust !== 'main-observed' ||
    !isDigest(record.subjectDigest) ||
    !Number.isSafeInteger(record.contractRevision) ||
    record.contractRevision < 1 ||
    !isIsoDate(record.createdAt) ||
    !isDigest(record.recordDigest) ||
    record.recordDigest !== digest(withoutRecordDigest(record))
  )
    throw new Error('Invalid Evidence Record');
  return Object.freeze(record);
}

export function acceptanceCriterionDigest(criterion: AcceptanceCriterion): string {
  return digest(criterion);
}

function sealContract(
  facts: Omit<AcceptanceContract, 'digest'>,
): AcceptanceContract {
  return deepFreeze({ ...facts, digest: digest(facts) });
}

function validateCriterion(value: AcceptanceCriterion): void {
  if (
    !isRecord(value) ||
    !isIdentifier(value.id) ||
    typeof value.description !== 'string' ||
    value.description.length < 1 ||
    value.description.length > 4_096 ||
    typeof value.gating !== 'boolean' ||
    value.evidenceKind !== 'edit_saga_committed' ||
    !isDigest(value.subjectDigest)
  )
    throw new Error('Invalid Acceptance Criterion');
}

function withoutContractDigest(
  contract: AcceptanceContract,
): Omit<AcceptanceContract, 'digest'> {
  const { digest: _digest, ...facts } = contract;
  return facts;
}

function withoutRecordDigest(record: EvidenceRecord): Omit<EvidenceRecord, 'recordDigest'> {
  const { recordDigest: _digest, ...facts } = record;
  return facts;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value);
}
