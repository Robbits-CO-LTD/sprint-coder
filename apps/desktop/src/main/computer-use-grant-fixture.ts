import {
  computerAppGrantStoredIdentity,
  type ComputerAppGrantRecord,
} from './computer-use-grant-record';
import {
  computerAppGrantMismatch,
  type ComputerAppGrantIdentity,
} from './computer-use-grant-identity';
import type {
  ComputerAppAccessRequestInput,
  ComputerAppAccessRequestRecord,
  ComputerAppAccessRequestTotals,
  ComputerAppGrantInput,
  ComputerAppGrantListing,
} from './persistence';

/**
 * An in-memory stand-in for the grant half of `PersistenceClient`, for tests that need a controller
 * rather than a database (`graph-tool-fixture.ts` is the existing precedent for a shared fixture
 * module that Vitest does not collect).
 *
 * It deliberately does *not* reimplement the MAC: authentication is a property of the SQLite store
 * and is covered where the bytes actually live, in `persistence.test.ts`. What it does reproduce is
 * the behaviour the controller depends on — lookup by verified identity, optimistic revisions, and
 * a `discarded` count that rides along with the listing.
 */
export function createComputerAppGrantFixtureStore(
  options: Readonly<{ discarded?: number }> = {},
): Readonly<{
  grants: Map<string, ComputerAppGrantRecord>;
  /** Access-request rows, keyed the way the table's primary key is. */
  accessRequests: Map<string, ComputerAppAccessRequestRecord>;
  api: Readonly<{
    listComputerAppGrants(): ComputerAppGrantListing;
    findComputerAppGrantByIdentity(
      platform: 'darwin' | 'win32',
      grantIdentityDigest: string,
    ): ComputerAppGrantRecord | null;
    getComputerAppGrant(grantId: string): ComputerAppGrantRecord;
    createComputerAppGrant(input: ComputerAppGrantInput): ComputerAppGrantRecord;
    touchComputerAppGrantUsed(
      grantId: string,
      usedAt: string,
      observed?: ComputerAppGrantIdentity | null,
    ): ComputerAppGrantRecord;
    countComputerAppGrantAccessRequest(
      grantId: string,
      outcome: 'requested' | 'denied',
    ): ComputerAppGrantRecord;
    setComputerAppGrantProviderEgress(
      grantId: string,
      providerEgress: Readonly<{ connectionId: string; modelId: string }> | null,
    ): ComputerAppGrantRecord;
    removeComputerAppGrant(grantId: string, expectedRevision: number): void;
    purgeUnauthenticatedComputerAppGrants(): number;
    recordComputerAppAccessRequest(
      input: ComputerAppAccessRequestInput,
    ): ComputerAppAccessRequestRecord;
    getComputerAppAccessRequest(
      platform: 'darwin' | 'win32',
      grantIdentityDigest: string,
      taskId: string,
    ): ComputerAppAccessRequestRecord | null;
    countComputerAppAccessRequestsForTask(taskId: string): number;
    listComputerAppAccessRequestTotals(limit?: number): readonly ComputerAppAccessRequestTotals[];
  }>;
}> {
  const grants = new Map<string, ComputerAppGrantRecord>();
  const accessRequests = new Map<string, ComputerAppAccessRequestRecord>();
  const accessKey = (platform: string, digest: string, taskId: string): string =>
    JSON.stringify([platform, digest, taskId]);
  let sequence = 0;
  const mustGet = (grantId: string): ComputerAppGrantRecord => {
    const grant = grants.get(grantId);
    if (grant === undefined) throw new Error('Computer Use app grant not found');
    return grant;
  };
  const rewrite = (
    grantId: string,
    mutate: (current: ComputerAppGrantRecord) => ComputerAppGrantRecord,
  ): ComputerAppGrantRecord => {
    const current = mustGet(grantId);
    const next = Object.freeze({
      ...mutate(current),
      id: current.id,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    grants.set(grantId, next);
    return next;
  };
  return {
    grants,
    accessRequests,
    api: {
      listComputerAppGrants: () => ({
        grants: [...grants.values()],
        discarded: options.discarded ?? 0,
      }),
      findComputerAppGrantByIdentity: (platform, grantIdentityDigest) =>
        [...grants.values()].find(
          (grant) =>
            grant.platform === platform && grant.grantIdentityDigest === grantIdentityDigest,
        ) ?? null,
      getComputerAppGrant: mustGet,
      createComputerAppGrant: (input) => {
        sequence += 1;
        const now = new Date().toISOString();
        const record: ComputerAppGrantRecord = Object.freeze({
          ...input.identity,
          id: input.id ?? `grant-${sequence}`,
          displayName: input.displayName,
          lastCdHash: null,
          cdHashChangedAt: null,
          maxMode: input.maxMode,
          scope: 'global' as const,
          denyRulesetVersion: input.denyRulesetVersion,
          grantVersion: 1,
          providerEgressConnectionId: input.providerEgress?.connectionId ?? null,
          providerEgressModelId: input.providerEgress?.modelId ?? null,
          requestCount: input.requestCount ?? 0,
          denialCount: input.denialCount ?? 0,
          lastUsedAt: input.lastUsedAt ?? null,
          createdAt: input.createdAt ?? now,
          updatedAt: input.updatedAt ?? now,
          revision: 1,
        });
        // Same rule as the SQLite store: a row for this identity that no longer describes the
        // application gives way to the fresh approval, and only a still-matching one is a duplicate.
        const conflicting = [...grants.values()].find(
          (grant) =>
            grant.platform === record.platform &&
            grant.grantIdentityDigest === record.grantIdentityDigest,
        );
        if (conflicting !== undefined) {
          if (
            computerAppGrantMismatch(
              computerAppGrantStoredIdentity(conflicting),
              input.identity,
              false,
            ) === null
          )
            throw new Error('Computer Use app grant already exists');
          grants.delete(conflicting.id);
        }
        grants.set(record.id, record);
        return record;
      },
      touchComputerAppGrantUsed: (grantId, usedAt, observed = null) =>
        rewrite(grantId, (current) => {
          const movedTo =
            observed !== null && observed.cdHash !== null && observed.cdHash !== current.cdHash
              ? observed.cdHash
              : null;
          return {
            ...current,
            lastUsedAt: usedAt,
            ...(movedTo === null
              ? {}
              : { lastCdHash: current.cdHash, cdHash: movedTo, cdHashChangedAt: usedAt }),
          };
        }),
      countComputerAppGrantAccessRequest: (grantId, outcome) =>
        rewrite(grantId, (current) => ({
          ...current,
          requestCount: current.requestCount + 1,
          denialCount: outcome === 'denied' ? current.denialCount + 1 : current.denialCount,
        })),
      setComputerAppGrantProviderEgress: (grantId, providerEgress) =>
        rewrite(grantId, (current) => ({
          ...current,
          providerEgressConnectionId: providerEgress?.connectionId ?? null,
          providerEgressModelId: providerEgress?.modelId ?? null,
        })),
      removeComputerAppGrant: (grantId, expectedRevision) => {
        const current = mustGet(grantId);
        if (current.revision !== expectedRevision)
          throw new Error('Computer Use app grant revision changed');
        grants.delete(grantId);
      },
      // Every row here authenticates by construction, so there is never anything to purge. The MAC
      // itself is covered where the bytes live, in `persistence.test.ts`.
      purgeUnauthenticatedComputerAppGrants: () => 0,
      recordComputerAppAccessRequest: (input) => {
        const key = accessKey(input.platform, input.grantIdentityDigest, input.taskId);
        const now = input.now ?? new Date().toISOString();
        const current = accessRequests.get(key);
        const next: ComputerAppAccessRequestRecord = Object.freeze({
          platform: input.platform,
          grantIdentityDigest: input.grantIdentityDigest,
          taskId: input.taskId,
          appId: input.appId,
          displayName: input.displayName,
          // Only a card that was shown counts as a request; the refusal that answers it moves the
          // refusal columns alone. Same rule as the SQLite store — see `recordComputerAppAccessRequest`.
          requestCount: (current?.requestCount ?? 0) + (input.outcome === 'denied' ? 0 : 1),
          denialCount: (current?.denialCount ?? 0) + (input.outcome === 'denied' ? 1 : 0),
          // A refusal inside a Task is final for that Task; a later request cannot clear it.
          denied: (current?.denied ?? false) || input.outcome === 'denied',
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        });
        accessRequests.set(key, next);
        return next;
      },
      getComputerAppAccessRequest: (platform, grantIdentityDigest, taskId) =>
        accessRequests.get(accessKey(platform, grantIdentityDigest, taskId)) ?? null,
      countComputerAppAccessRequestsForTask: (taskId) =>
        [...accessRequests.values()]
          .filter((row) => row.taskId === taskId)
          .reduce((total, row) => total + row.requestCount, 0),
      // Same contract as the store: most recent first, and bounded. A fixture that returns them in
      // insertion order would let a caller's truncation look correct while dropping the wrong ones.
      listComputerAppAccessRequestTotals: (limit = Number.MAX_SAFE_INTEGER) => {
        const totals = new Map<string, ComputerAppAccessRequestTotals>();
        for (const row of accessRequests.values()) {
          const key = `${row.platform}:${row.grantIdentityDigest}`;
          const current = totals.get(key);
          totals.set(
            key,
            Object.freeze({
              platform: row.platform,
              grantIdentityDigest: row.grantIdentityDigest,
              appId: row.appId,
              displayName: row.displayName,
              requestCount: (current?.requestCount ?? 0) + row.requestCount,
              denialCount: (current?.denialCount ?? 0) + row.denialCount,
              lastRequestedAt:
                current === undefined || current.lastRequestedAt < row.updatedAt
                  ? row.updatedAt
                  : current.lastRequestedAt,
            }),
          );
        }
        return [...totals.values()]
          .sort((left, right) =>
            left.lastRequestedAt === right.lastRequestedAt
              ? left.grantIdentityDigest.localeCompare(right.grantIdentityDigest)
              : right.lastRequestedAt.localeCompare(left.lastRequestedAt),
          )
          .slice(0, Math.max(0, Math.trunc(limit)));
      },
    },
  };
}
