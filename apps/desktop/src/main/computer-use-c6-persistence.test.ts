import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  computerStartToolOutputSchema,
  computerUseAvailabilitySchema,
  type ComputerAppIdentity,
  type ComputerUseAction,
  type ComputerUseApproval,
  type ComputerUsePlannedAction,
  type ComputerUseSessionStatus,
  type SelectableComputerTarget,
} from '@sprint-coder/contracts';
import { computerUseActionDigest } from './computer-use-action';
import { ComputerUseArtifactStore } from './computer-use-artifact';
import {
  ComputerUseController,
  type ComputerUseNativeHost,
  type ComputerUseNativeObservation,
  type ComputerUseNativeWindow,
} from './computer-use-controller';
import {
  computerAppGrantIdentityFrom,
  computerAppNativeIdentityDigest,
} from './computer-use-grant-identity';
import { createComputerAppGrantFixtureStore } from './computer-use-grant-fixture';
import type { ComputerUsePlannerInput } from './computer-use-planner-port';
import { electronTestExecutablePath } from './electron-test-runtime';
import { SqlitePersistenceClient, type ComputerAppProfileRecord } from './persistence';

/**
 * #785 T15-10 PR-C (N12, J12): a copied value is not persisted.
 *
 * The in-memory audit stand-ins of the other suites cannot show this: what matters is which bytes
 * reach the database file. So the controller here writes its audit rows into a real
 * `SqlitePersistenceClient` (better-sqlite3, in a temporary directory), a value goes through a
 * whole copy, carry and approved paste, and every file the database left behind (the database,
 * its `-wal` and `-shm`, and anything else next to them, such as a backup) is read as bytes and
 * searched, both while the client is open and after it is closed.
 *
 * Like the other database suites, it runs under Electron's ABI only (`SPRINT_CODER_ELECTRON_DB_TEST=1`).
 */

const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';

/** Long, distinctive and ASCII, so no schema text or generated id can contain a piece of it. */
const BODY = 'Total 42 qzx-7f3a-Mk';

const directories: string[] = [];
/** Opened databases, closed after every test (an open file cannot be removed on Windows). */
const openDatabases: SqlitePersistenceClient[] = [];

beforeEach(() => {
  // Not in the launcher run, which waits for a child process on real timers.
  if (runsWithElectronAbi) vi.useFakeTimers({ now: new Date('2026-09-21T00:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
  for (const persistence of openDatabases.splice(0)) {
    try {
      persistence.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const availability = computerUseAvailabilitySchema.parse({
  platform: 'darwin',
  state: 'ready',
  featureEnabled: true,
  packageReady: true,
  handshakeReady: true,
  observe: true,
  control: true,
  available: true,
  reasonCode: null,
  manifestDigest: 'c'.repeat(64),
});

function macIdentity(): ComputerAppIdentity {
  const draft = {
    platform: 'darwin',
    identityDigest: '',
    bundleId: 'com.example.notes',
    executablePath: '/Applications/Notes.app/Contents/MacOS/Notes',
    executableDigest: 'b'.repeat(64),
    teamId: 'TEAMID1234',
    signingIdentifier: 'com.example.notes',
    cdHash: null,
    displayName: 'Notes',
    policyLanguage: 'en',
    maximumMode: 'full_access_app',
  } as ComputerAppIdentity;
  const derived = computerAppGrantIdentityFrom(draft);
  if (derived === null) throw new Error('fixture identity cannot be derived');
  const digest = computerAppNativeIdentityDigest(draft, derived);
  if (digest === null) throw new Error('fixture identity has no native digest');
  return { ...draft, identityDigest: digest } as ComputerAppIdentity;
}

function profileRecord(): ComputerAppProfileRecord {
  const identity = macIdentity();
  return {
    id: 'profile-notes',
    platform: identity.platform,
    kind: 'macos-bundle',
    label: identity.displayName,
    canonicalPath: identity.executablePath,
    appUrl: null,
    identity: identity as unknown as Record<string, unknown>,
    identityDigest: identity.identityDigest,
    version: null,
    executableDigest: identity.executableDigest,
    mode: 'full_access_app',
    connectionId: 'connection-1',
    modelId: 'model-1',
    providerEgressConsent: false,
    remember: false,
    revision: 3,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  };
}

const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
const imageDigest = createHash('sha256').update(imageBytes).digest('hex');

function observation(
  sessionId: string,
  revision: number,
  appIdentityDigest: string,
): ComputerUseNativeObservation {
  return {
    sessionId,
    appIdentityDigest,
    windowIdentityDigest: 'd'.repeat(64),
    profileRevision: 3,
    maximumMode: 'full_access_app',
    policyLanguage: 'en',
    screenBounds: { x: 0, y: 0, width: 800, height: 600 },
    revision,
    observedAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    clientWidth: 800,
    clientHeight: 600,
    images: [
      {
        mimeType: 'image/png',
        digest: imageDigest,
        byteLength: imageBytes.byteLength,
        width: 1,
        height: 1,
        base64: imageBytes.toString('base64'),
      },
    ],
    treeDigest: null,
    treeByteLength: 0,
    treeDepth: 0,
    treeNodeCount: 0,
    focusedElementSignature: 'f'.repeat(64),
    dialogSetRevision: 1,
    dialogSetDigest: '1'.repeat(64),
    activeWindowIdentityDigest: 'd'.repeat(64),
    activeWindowKind: 'application',
    targetSignatures: { 'node-1': 'a'.repeat(64) },
    targetMetadata: { 'node-1': {} },
  } as ComputerUseNativeObservation;
}

async function settle<T>(pending: Promise<T>, steps = 200, stepMs = 1_000): Promise<T> {
  const sentinel = Symbol('pending');
  const race = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  for (let step = 0; step < steps; step += 1) {
    const outcome = await Promise.race([race, Promise.resolve(sentinel)]);
    if (outcome !== sentinel) {
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    }
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error('Computer Use fixture never settled');
}

type Journey = Readonly<{
  persistence: SqlitePersistenceClient;
  directory: string;
  databasePath: string;
  taskId: string;
  statuses: ComputerUseSessionStatus[];
  approvals: ComputerUseApproval[];
  pastedTexts: string[];
  /** Copy in A, carry into B, paste in B with a card answered `allow_once`. */
  run: () => Promise<Record<string, unknown>[]>;
  dispose: () => Promise<void>;
}>;

function createJourney(): Journey {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-c6-'));
  directories.push(directory);
  const databasePath = join(directory, 'sprint-coder.sqlite3');
  const persistence = new SqlitePersistenceClient(databasePath);
  openDatabases.push(persistence);
  const taskId = persistence.createTask('c6 persistence').id;
  const profile = profileRecord();
  persistence.createComputerAppProfile(profile);
  const context = { taskId, turnId: 'turn-1', workspaceId: null, policyEpoch: 0 } as const;

  const grantStore = createComputerAppGrantFixtureStore();
  const statuses: ComputerUseSessionStatus[] = [];
  const approvals: ComputerUseApproval[] = [];
  const pastedTexts: string[] = [];
  const plans: ComputerUsePlannedAction[] = [];
  let revision = 0;

  const window = {
    platform: 'darwin',
    windowId: 'native-window-notes',
    appIdentityDigest: profile.identityDigest,
    windowIdentityDigest: 'd'.repeat(64),
    title: 'Notes',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    screenBounds: { x: 0, y: 0, width: 800, height: 600 },
    focused: true,
    eligible: true,
    ownerKind: 'application',
    modal: false,
    revision: 1,
    policyLanguage: 'en',
    maximumMode: 'full_access_app',
  } as ComputerUseNativeWindow;

  const native: ComputerUseNativeHost = {
    availability: () => availability,
    pickApplication: async () => null,
    listWindows: async () => [window],
    startSession: async (input) => ({
      sessionId: input.sessionId,
      platform: 'darwin',
      appIdentityDigest: profile.identityDigest,
      windowIdentityDigest: 'd'.repeat(64),
      windowId: input.windowId,
      profileRevision: input.profile.revision,
      cancelEpoch: 0,
      policyLanguage: 'en',
      maximumMode: 'full_access_app',
      screenBounds: { x: 0, y: 0, width: 800, height: 600 },
    }),
    observe: async (session) => {
      revision += 1;
      return observation(session.sessionId, revision, session.appIdentityDigest);
    },
    artifactReadSupported: () => true,
    readNodeValue: async () => ({ ok: true as const, text: BODY }),
    artifactPasteSupported: () => true,
    dispatch: async (input) => {
      const action = input.action as ComputerUseAction;
      if (action.type === 'set_text' || action.type === 'type') pastedTexts.push(action.text);
      return { result: 'completed', reasonCode: null };
    },
    cancel: async () => undefined,
    close: async () => undefined,
  };

  // The audit, the profile and nothing else is the real database; the rest of the controller's
  // storage (grants, the Turn, the policy epoch) is the in-memory stand-in the other suites use.
  const hybrid = {
    listComputerAppProfiles: () => persistence.listComputerAppProfiles(),
    getComputerAppProfile: (id: string) => persistence.getComputerAppProfile(id),
    createComputerAppProfile: (input: never) => persistence.createComputerAppProfile(input),
    updateComputerAppProfile: (...args: never[]) =>
      (persistence.updateComputerAppProfile as (...rest: never[]) => unknown)(...args),
    removeComputerAppProfile: vi.fn(),
    ...grantStore.api,
    recordComputerActionAudit: (input: never) => persistence.recordComputerActionAudit(input),
    completeComputerActionAudit: (input: never) => persistence.completeComputerActionAudit(input),
    recordComputerActionApprovalOutcome: (input: never) =>
      persistence.recordComputerActionApprovalOutcome(input),
    listComputerActionAudits: (id: string, limit?: number) =>
      persistence.listComputerActionAudits(id, limit),
    getActiveTurnId: () => context.turnId,
    getPermissionPolicy: () => ({ policyEpoch: 0 }),
  } as unknown as ConstructorParameters<typeof ComputerUseController>[0]['persistence'];

  const store = new ComputerUseArtifactStore({ now: () => performance.now() });
  const controller = new ComputerUseController({
    persistence: hybrid,
    native,
    featureEnabled: () => true,
    agentDrivenEnabled: () => true,
    artifactStore: store,
    providerEgressBindingFor: () => ({ connectionId: 'connection-1', modelId: 'model-1' }),
    currentPolicyEpoch: () => 0,
    repositionEmergencyStop: () => true,
    publishStatus: (status) => statuses.push(status),
    publishApproval: (approval) => approvals.push(approval as ComputerUseApproval),
    publishGrantRequest: () => undefined,
    planner: {
      plan: async (_input: ComputerUsePlannerInput): Promise<ComputerUseAction> =>
        (plans.shift() as ComputerUseAction | undefined) ?? { type: 'finish' },
    },
  });

  const targetToken = async (): Promise<string> => {
    const row = (await controller.listTargets({}, context)).targets.find(
      (target): target is SelectableComputerTarget =>
        (target as { kind?: string }).kind === 'selectable',
    );
    if (row === undefined) throw new Error('no selectable target');
    return row.targetToken;
  };

  const run = async (): Promise<Record<string, unknown>[]> => {
    const identity = computerAppGrantIdentityFrom(
      profile.identity as unknown as ComputerAppIdentity,
    );
    if (identity === null) throw new Error('fixture identity cannot be derived');
    controller.createAppGrant(identity, {
      maxMode: 'full_access_app',
      providerEgress: { connectionId: 'connection-1', modelId: 'model-1' },
    });
    // A: copies the value and finishes. Only a reference leaves.
    plans.push({ type: 'copy', targetId: 'node-1' });
    const outA = await settle(
      controller.startForAgent({ targetToken: await targetToken(), goal: 'copy' }, context),
    );
    const artifacts = (outA as { artifacts?: { artifactId: string }[] }).artifacts;
    if (artifacts === undefined || artifacts.length !== 1) throw new Error('nothing was copied');
    // B: the reference is carried in and pasted, and the person says yes to the card.
    plans.push({ type: 'set_text', targetId: 'node-1', artifactRef: artifacts[0]!.artifactId });
    const running = controller.startForAgent(
      {
        targetToken: await targetToken(),
        goal: 'paste',
        carry: [{ artifactId: artifacts[0]!.artifactId }],
      },
      context,
    );
    for (
      let step = 0;
      step < 100 && !approvals.some((approval) => approval.state === 'pending');
      step += 1
    )
      await vi.advanceTimersByTimeAsync(10);
    const card = approvals.filter((approval) => approval.state === 'pending').at(-1);
    if (card === undefined) throw new Error('no card was raised');
    await controller.resolveApproval({
      approvalId: card.id,
      expectedRevision: card.revision,
      decision: 'allow_once',
      challenge: card.challenge,
    });
    const outB = await settle(running);
    computerStartToolOutputSchema.parse(outA);
    computerStartToolOutputSchema.parse(outB);
    return [outA, outB] as unknown as Record<string, unknown>[];
  };

  return {
    persistence,
    directory,
    databasePath,
    taskId,
    statuses,
    approvals,
    pastedTexts,
    run,
    dispose: async () => {
      await controller.dispose();
    },
  };
}

/** Every file in the directory (database, `-wal`, `-shm`, a backup...), as bytes. */
function filesOf(directory: string): { name: string; bytes: Buffer }[] {
  return readdirSync(directory).map((name) => ({
    name,
    bytes: readFileSync(join(directory, name)),
  }));
}

/** The body, and every form of it that a careless writer might leave behind. */
function needlesFor(body: string): { label: string; value: Buffer }[] {
  const needles: { label: string; value: Buffer }[] = [];
  const add = (label: string, text: string): void => {
    needles.push({ label: `${label} (utf8)`, value: Buffer.from(text, 'utf8') });
    needles.push({ label: `${label} (utf16le)`, value: Buffer.from(text, 'utf16le') });
  };
  add('body', body);
  add('body NFKC', body.normalize('NFKC'));
  add('body base64', Buffer.from(body, 'utf8').toString('base64'));
  add('body hex', Buffer.from(body, 'utf8').toString('hex'));
  const sha = createHash('sha256').update(body, 'utf8');
  const digest = sha.digest();
  add('sha256 hex', digest.toString('hex'));
  add('sha256 HEX', digest.toString('hex').toUpperCase());
  add('sha256 base64', digest.toString('base64'));
  needles.push({ label: 'sha256 raw', value: digest });
  // Every piece of eight characters or more, so a cut-off copy is found too.
  for (let start = 0; start < body.length; start += 1)
    for (let end = start + 8; end <= body.length; end += 1)
      add(`part ${start}-${end}`, body.slice(start, end));
  return needles;
}

function findIn(files: { name: string; bytes: Buffer }[], body: string): string[] {
  const found: string[] = [];
  for (const file of files)
    for (const needle of needlesFor(body))
      if (file.bytes.includes(needle.value)) found.push(`${file.name}: ${needle.label}`);
  return found;
}

describe.skipIf(!runsWithElectronAbi)('a copied value is not persisted (N12, T15-10 PR-C)', () => {
  it('writes none of the value, its forms or its excerpt to the database files, open or closed, and keeps the digests', async () => {
    const journey = createJourney();
    const [outA, outB] = await journey.run();
    // The journey did what it claims: the value was copied, carried and pasted after a card.
    expect(outA).toHaveProperty('artifacts');
    expect(outB).not.toHaveProperty('artifacts');
    expect(journey.pastedTexts).toEqual([BODY]);
    // The excerpt did reach the screen's channel (status.copied and the card), which is the point
    // of looking for it in the files and not finding it.
    expect(JSON.stringify(journey.statuses)).toContain('Total 42');
    expect(
      journey.approvals.some((approval) => JSON.stringify(approval).includes('Total 42')),
    ).toBe(true);

    // The audit has the rows, with keyed digests.
    const audits = journey.persistence.listComputerActionAudits(journey.taskId);
    const copy = audits.find((audit) => audit.actionKind === 'copy');
    const paste = audits.find((audit) => audit.actionKind === 'set_text');
    expect(copy?.actionDigest).toBe(computerUseActionDigest({ type: 'copy', targetId: 'node-1' }));
    expect(paste?.actionDigest).toBe(
      computerUseActionDigest({ type: 'set_text', targetId: 'node-1', text: BODY }),
    );
    expect(paste?.actionDigest).not.toBe(createHash('sha256').update(BODY).digest('hex'));
    expect(JSON.stringify(audits)).not.toContain('Total 42');

    // With the client still open, the write-ahead log holds what has not been checkpointed.
    expect(readdirSync(journey.directory).some((name) => name.endsWith('-wal'))).toBe(true);
    expect(findIn(filesOf(journey.directory), BODY)).toEqual([]);

    await journey.dispose();
    journey.persistence.close();
    expect(findIn(filesOf(journey.directory), BODY)).toEqual([]);
  });

  it('would find the value if something wrote it (the scan reads the log and the database)', async () => {
    const journey = createJourney();
    await journey.run();
    // A second connection writes the value where a careless writer might: it must be seen both
    // in the log (not yet checkpointed) and, after the client is closed, in the database.
    const writer = new Database(journey.databasePath);
    writer.exec('CREATE TABLE scan_probe (v TEXT)');
    writer.prepare('INSERT INTO scan_probe(v) VALUES (?)').run(BODY);
    writer.close();
    const open = findIn(filesOf(journey.directory), BODY);
    expect(open.some((entry) => entry.includes('body (utf8)'))).toBe(true);
    await journey.dispose();
    journey.persistence.close();
    expect(
      findIn(filesOf(journey.directory), BODY).some((entry) => entry.includes('body (utf8)')),
    ).toBe(true);
  });
});

// The suite needs better-sqlite3 built for Electron. Where the variable is not set (the ordinary
// vitest run, CI), one test starts this file again under Electron's ABI, so the real run is part
// of every run and a failure in the child fails this test.
if (!runsWithElectronAbi)
  it('runs the persistence scan with the bundled Electron ABI', async () => {
    await promisify(execFile)(
      electronTestExecutablePath(),
      [
        join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
        'run',
        'src/main/computer-use-c6-persistence.test.ts',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  }, 125_000);
