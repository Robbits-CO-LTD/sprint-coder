import { createHash, randomUUID } from 'node:crypto';

export type AssuranceProfile = 'quick' | 'standard';
export type EvidenceKind = 'edit_saga_committed' | 'verification_passed';
export type AssuranceFailureClass = 'verification' | 'provider' | 'infrastructure';
export type AssuranceDecision = 'complete' | 'repair' | 'retry_verification' | 'blocked';

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
  producer: 'edit-saga' | 'assurance-controller';
  trust: 'main-observed';
  subjectDigest: string;
  contractRevision: number;
  createdAt: string;
  recordDigest: string;
}>;

export type AssuranceRound = Readonly<{
  version: 1;
  id: string;
  taskId: string;
  turnId: string;
  sagaId: string;
  ordinal: number;
  outcome: 'passed' | 'failed';
  failureClass: AssuranceFailureClass | null;
  repairRoundsUsed: 0 | 1;
  decision: AssuranceDecision;
  createdAt: string;
  digest: string;
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
  const verificationId = `verification:${input.sagaId}`;
  const existingVerification = current.criteria.find(
    (criterion) => criterion.id === verificationId,
  );
  if (existing?.subjectDigest !== undefined && existing.subjectDigest !== input.planDigest)
    throw new Error('Acceptance criterion id was reused with another subject');
  if (
    existingVerification?.subjectDigest !== undefined &&
    existingVerification.subjectDigest !== input.planDigest
  )
    throw new Error('Acceptance criterion id was reused with another subject');
  if (existing !== undefined && existingVerification !== undefined) return current;
  const additions: AcceptanceCriterion[] = [];
  if (existing === undefined)
    additions.push({
      id: criterionId,
      description: `Edit Saga ${input.sagaId} committed its sealed patch`,
      gating: true,
      evidenceKind: 'edit_saga_committed',
      subjectDigest: input.planDigest,
    });
  if (existingVerification === undefined)
    additions.push({
      id: verificationId,
      description: `Deterministic verification passed for Edit Saga ${input.sagaId}`,
      gating: true,
      evidenceKind: 'verification_passed',
      subjectDigest: input.planDigest,
    });
  return sealContract({
    ...withoutContractDigest(current),
    revision: current.revision + 1,
    taskKind: 'edit',
    completionMode: 'evidence',
    profile: 'standard',
    criteria: [...current.criteria, ...additions],
    allowedScope: [...new Set([...current.allowedScope, ...input.paths])].sort(),
    maxRepairRounds: 1,
  });
}

export function advanceStandardAssurance(input: {
  taskId: string;
  turnId: string;
  sagaId: string;
  previousRounds: readonly AssuranceRound[];
  outcome: 'passed' | 'failed';
  failureClass: AssuranceFailureClass | null;
  createdAt: string;
}): AssuranceRound {
  const previous = input.previousRounds.at(-1);
  if (previous?.decision === 'complete' || previous?.decision === 'blocked')
    throw new Error('Assurance round is already terminal');
  if (
    (input.outcome === 'passed' && input.failureClass !== null) ||
    (input.outcome === 'failed' && input.failureClass === null)
  )
    throw new Error('Assurance outcome and failure class disagree');
  const repairRoundsUsed = input.previousRounds.reduce<0 | 1>(
    (used, round) => Math.max(used, round.repairRoundsUsed) as 0 | 1,
    0,
  );
  let decision: AssuranceDecision;
  let nextRepairRounds = repairRoundsUsed;
  if (input.outcome === 'passed') decision = 'complete';
  else if (input.failureClass === 'provider' || input.failureClass === 'infrastructure')
    decision = 'retry_verification';
  else if (repairRoundsUsed === 0) {
    decision = 'repair';
    nextRepairRounds = 1;
  } else decision = 'blocked';
  return sealAssuranceRound({
    version: 1,
    id: randomUUID(),
    taskId: input.taskId,
    turnId: input.turnId,
    sagaId: input.sagaId,
    ordinal: input.previousRounds.length + 1,
    outcome: input.outcome,
    failureClass: input.failureClass,
    repairRoundsUsed: nextRepairRounds,
    decision,
    createdAt: input.createdAt,
  });
}

export function createVerificationEvidence(input: {
  contract: AcceptanceContract;
  sagaId: string;
  planDigest: string;
  createdAt: string;
}): EvidenceRecord {
  const criterion = input.contract.criteria.find(
    (candidate) => candidate.id === `verification:${input.sagaId}`,
  );
  if (
    criterion === undefined ||
    criterion.evidenceKind !== 'verification_passed' ||
    criterion.subjectDigest !== input.planDigest
  )
    throw new Error('Verified Edit Saga is not present in the Acceptance Contract');
  const facts = {
    version: 1 as const,
    id: randomUUID(),
    taskId: input.contract.taskId,
    turnId: input.contract.turnId,
    criterionId: criterion.id,
    criterionDigest: acceptanceCriterionDigest(criterion),
    kind: criterion.evidenceKind,
    producer: 'assurance-controller' as const,
    trust: 'main-observed' as const,
    subjectDigest: input.planDigest,
    contractRevision: input.contract.revision,
    createdAt: input.createdAt,
  };
  return Object.freeze({ ...facts, recordDigest: digest(facts) });
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
    new Set(contract.criteria.map((criterion) => criterion.id)).size !== contract.criteria.length ||
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
    !['edit_saga_committed', 'verification_passed'].includes(record.kind) ||
    !['edit-saga', 'assurance-controller'].includes(record.producer) ||
    (record.kind === 'edit_saga_committed' && record.producer !== 'edit-saga') ||
    (record.kind === 'verification_passed' && record.producer !== 'assurance-controller') ||
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

export function parseAssuranceRound(value: unknown): AssuranceRound {
  if (!isRecord(value)) throw new Error('Invalid Assurance Round');
  const round = value as unknown as AssuranceRound;
  if (
    round.version !== 1 ||
    !isIdentifier(round.id) ||
    !isIdentifier(round.taskId) ||
    !isIdentifier(round.turnId) ||
    !isIdentifier(round.sagaId) ||
    !Number.isSafeInteger(round.ordinal) ||
    round.ordinal < 1 ||
    !['passed', 'failed'].includes(round.outcome) ||
    ![null, 'verification', 'provider', 'infrastructure'].includes(round.failureClass) ||
    ![0, 1].includes(round.repairRoundsUsed) ||
    !['complete', 'repair', 'retry_verification', 'blocked'].includes(round.decision) ||
    !isIsoDate(round.createdAt) ||
    !isDigest(round.digest) ||
    round.digest !== digest(withoutRoundDigest(round))
  )
    throw new Error('Invalid Assurance Round');
  return Object.freeze(round);
}

export function acceptanceCriterionDigest(criterion: AcceptanceCriterion): string {
  return digest(criterion);
}

function sealContract(facts: Omit<AcceptanceContract, 'digest'>): AcceptanceContract {
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
    !['edit_saga_committed', 'verification_passed'].includes(value.evidenceKind) ||
    !isDigest(value.subjectDigest)
  )
    throw new Error('Invalid Acceptance Criterion');
}

function withoutContractDigest(contract: AcceptanceContract): Omit<AcceptanceContract, 'digest'> {
  const { digest: _digest, ...facts } = contract;
  return facts;
}

function withoutRecordDigest(record: EvidenceRecord): Omit<EvidenceRecord, 'recordDigest'> {
  const { recordDigest: _digest, ...facts } = record;
  return facts;
}

function sealAssuranceRound(facts: Omit<AssuranceRound, 'digest'>): AssuranceRound {
  return Object.freeze({ ...facts, digest: digest(facts) });
}

function withoutRoundDigest(round: AssuranceRound): Omit<AssuranceRound, 'digest'> {
  const { digest: _digest, ...facts } = round;
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
