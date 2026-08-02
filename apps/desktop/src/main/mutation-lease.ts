import { createHash } from 'node:crypto';

export type MutationLeasePurpose = 'forward' | 'recovery';
export type WorkspaceMutationState = 'idle' | 'held' | 'quarantined';

export type MutationLeaseToken = Readonly<{
  version: 1;
  rootId: string | null;
  workspaceKey: string;
  rootIdentityDigest: string;
  leaseId: string;
  holderInstanceId: string;
  taskId: string;
  turnId: string;
  sagaId: string;
  purpose: MutationLeasePurpose;
  policyEpoch: number;
  intentDigest: string;
  fence: number;
  revision: number;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}>;

export type MutationQuarantine = Readonly<{
  taskId: string;
  workspaceKey: string;
  reason: string;
  sourceSagaId: string | null;
  fence: number;
  createdAt: string;
}>;

export class MutationLeaseBusyError extends Error {
  constructor() {
    super('Workspace mutation lease is already held');
    this.name = 'MutationLeaseBusyError';
  }
}

export class MutationLeaseStaleError extends Error {
  constructor() {
    super('Workspace mutation lease token is stale');
    this.name = 'MutationLeaseStaleError';
  }
}

export class MutationQuarantinedError extends Error {
  constructor() {
    super('Workspace mutation is quarantined for recovery');
    this.name = 'MutationQuarantinedError';
  }
}

export class MutationClockRollbackError extends Error {
  constructor() {
    super('Workspace mutation clock moved backwards');
    this.name = 'MutationClockRollbackError';
  }
}

export function mutationWorkspaceKey(canonicalPath: string, rootIdentityDigest: string): string {
  return digestJson(['workspace-mutation-v1', canonicalPath, rootIdentityDigest]);
}

export function legacyMutationWorkspaceKey(canonicalPath: string): string {
  return digestJson(['workspace-mutation-legacy-v1', canonicalPath]);
}

export function validateMutationDigest(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${name}`);
}

export function validateMutationTimestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`Invalid ${name}`);
  return parsed;
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
