import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  chatMessageSchema,
  taskSummarySchema,
  turnEventSchema,
  turnSnapshotSchema,
  type ChatMessage,
  type ContextUsage,
  type QueuedInput,
  type RuntimeKind,
  type TaskSummary,
  type TurnEvent,
  type TurnSnapshot,
  type TurnStage,
} from '@vibe/contracts';
import {
  capabilities,
  createSessionGrant,
  expandAccessPreset,
  transitionIntelligenceStep,
  transitionTurn,
  type AccessPreset,
  type Capability,
  type ExpandedAccessPolicy,
  type IntelligenceStepState,
  type PermissionEvaluation,
  type PermissionOperation,
  type PermissionRequest,
  type PermissionRule,
  type ProviderEgress,
  type ReasoningEffort,
  type ResourceSet,
  type SessionGrant,
  type SandboxProfile,
  type StepSnapshot,
  type TurnState,
} from '@vibe/domain';
import {
  ContextLedger,
  defaultContextUsage,
  type ContextFragment,
  type ContextLedgerState,
  type PersistedFragment,
  type PreparedContext,
} from './context-ledger';

type TaskRow = {
  id: string;
  title: string;
  pinned: number;
  archived: number;
  goal: string | null;
  workspace_path: string | null;
  draft: string;
  created_at: string;
  updated_at: string;
};
type MessageRow = {
  id: string;
  task_id: string;
  turn_id: string | null;
  author: ChatMessage['author'];
  content: string;
  created_at: string;
};
type TurnRow = {
  id: string;
  task_id: string;
  state: TurnState;
  assistant_message_id: string | null;
  created_at: string;
};
type QueueRow = { ordinal: number; payload_json: string };
type OperationRow = { request_hash: string; state: string; result_json: string | null };
type IntelligenceStepRow = {
  id: string;
  task_id: string;
  turn_id: string;
  ordinal: number;
  state: IntelligenceStepState;
  model: string;
  effort: ReasoningEffort;
  context_digest: string;
  tool_catalog_digest: string;
  policy_epoch: number;
  workspace_revision: string;
  contract_revision: number | null;
  created_at: string;
};
type PermissionPolicyRow = {
  preset_label: AccessPreset;
  approval_policy: 'ask' | 'auto';
  approval_reason: string | null;
  policy_epoch: number;
};
type PermissionRuleRow = {
  effect: 'allow' | 'immutable-deny';
  capability: Capability;
  resource_json: string;
  operations_json: string;
  audit_reason: string | null;
};
type PermissionGrantRow = {
  id: string;
  subject_id: string;
  capability: Capability;
  resource_json: string;
  operations_json: string;
  provider_egress_json: string;
  sandbox_profiles_json: string;
  scope: SessionGrant['scope'];
  execution_spec_digest: string | null;
  expires_at: string;
  issued_policy_epoch: number;
  revoked_at: string | null;
};
type EventWithoutSeq = TurnEvent extends infer Event
  ? Event extends TurnEvent
    ? Omit<Event, 'seq'>
    : never
  : never;

const migrations = [
  {
    version: 1,
    checksum: 'chat-alpha-v1-tasks-messages-turns-events',
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT, author TEXT NOT NULL CHECK (author IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL REFERENCES messages(id), assistant_message_id TEXT REFERENCES messages(id),
        state TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE turn_events (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(turn_id, seq)
      );
      CREATE INDEX messages_task_created_idx ON messages(task_id, created_at, id);
      CREATE INDEX turns_task_state_idx ON turns(task_id, state);
    `,
  },
  {
    version: 2,
    checksum: 'chat-alpha-v2-ledger-task-seq-queue-workspace',
    sql: `
      ALTER TABLE tasks ADD COLUMN goal TEXT;
      ALTER TABLE tasks ADD COLUMN workspace_path TEXT;
      ALTER TABLE tasks ADD COLUMN draft TEXT NOT NULL DEFAULT '';

      ALTER TABLE turn_events RENAME TO turn_events_v1;
      CREATE TABLE turn_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, seq)
      );
      INSERT INTO turn_events(id, task_id, turn_id, seq, schema_version, type, payload_json, created_at)
        SELECT e.id, t.task_id, e.turn_id,
          (SELECT COUNT(*) FROM turn_events_v1 e2
            JOIN turns t2 ON t2.id = e2.turn_id
            WHERE t2.task_id = t.task_id
              AND (e2.created_at < e.created_at OR (e2.created_at = e.created_at AND e2.rowid <= e.rowid))),
          e.schema_version, e.type,
          json_set(e.payload_json, '$.seq',
            (SELECT COUNT(*) FROM turn_events_v1 e3
              JOIN turns t3 ON t3.id = e3.turn_id
              WHERE t3.task_id = t.task_id
                AND (e3.created_at < e.created_at OR (e3.created_at = e.created_at AND e3.rowid <= e.rowid)))),
          e.created_at
        FROM turn_events_v1 e JOIN turns t ON t.id = e.turn_id
        ORDER BY t.task_id, e.created_at, e.rowid;
      DROP TABLE turn_events_v1;
      CREATE INDEX turn_events_task_seq_idx ON turn_events(task_id, seq);

      CREATE TABLE input_queue (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('queue')),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'dequeued')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, ordinal)
      );
      CREATE INDEX input_queue_pending_idx ON input_queue(task_id, state, ordinal);

      CREATE TABLE operations (
        principal TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(principal, task_id, kind, operation_id)
      );
      UPDATE turns SET state = 'interrupted', updated_at = datetime('now')
        WHERE state IN ('queued', 'understanding', 'planning', 'executing', 'synthesizing', 'canceling')
          AND id NOT IN (
            SELECT id FROM turns latest
            WHERE latest.id = (
              SELECT candidate.id FROM turns candidate
              WHERE candidate.task_id = latest.task_id
                AND candidate.state IN ('queued', 'understanding', 'planning', 'executing', 'synthesizing', 'canceling')
              ORDER BY candidate.created_at DESC, candidate.rowid DESC LIMIT 1
            )
          );
      CREATE UNIQUE INDEX turns_one_active_per_task ON turns(task_id)
        WHERE state IN ('queued', 'understanding', 'planning', 'executing', 'synthesizing', 'canceling');
    `,
  },
  {
    version: 3,
    checksum: 'chat-alpha-v3-settings-runtime',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO settings(key, value, updated_at)
        VALUES ('runtime.kind', 'mock', datetime('now'));
    `,
  },
  {
    version: 4,
    checksum: 'chat-alpha-v4-context-fragments',
    sql: `
      CREATE TABLE context_fragments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('system', 'history', 'goal', 'compaction')),
        trust TEXT NOT NULL CHECK (trust IN ('system', 'user', 'assistant')),
        token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
        created_at TEXT NOT NULL,
        superseded_by_compaction_id TEXT REFERENCES context_fragments(id),
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX context_fragments_task_active_idx
        ON context_fragments(task_id, source, superseded_by_compaction_id, created_at);
      CREATE UNIQUE INDEX context_fragments_message_idx
        ON context_fragments(message_id) WHERE message_id IS NOT NULL;
    `,
  },
  {
    version: 5,
    checksum: 'intelligence-baseline-v5-step-snapshots',
    sql: `
      CREATE TABLE intelligence_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'sampling', 'sampled', 'dispatching', 'toolsCommitted', 'completed', 'failed'
        )),
        model TEXT NOT NULL,
        effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
        context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
        tool_catalog_digest TEXT NOT NULL CHECK (length(tool_catalog_digest) = 64),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        workspace_revision TEXT NOT NULL,
        contract_revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(turn_id, ordinal)
      );
      CREATE INDEX intelligence_steps_turn_idx ON intelligence_steps(turn_id, ordinal);
    `,
  },
  {
    version: 6,
    checksum: 'permissions-v6-policy-rules-grants-audit',
    sql: `
      CREATE TABLE permission_policy_state (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        preset_label TEXT NOT NULL CHECK (preset_label IN ('ask', 'auto', 'full')),
        approval_policy TEXT NOT NULL CHECK (approval_policy IN ('ask', 'auto')),
        approval_reason TEXT,
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE permission_rules (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('preset')),
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'immutable-deny')),
        capability TEXT NOT NULL,
        resource_json TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        audit_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX permission_rules_task_idx ON permission_rules(task_id, effect);
      CREATE TABLE permission_grants (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subject_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('once', 'task')),
        capability TEXT NOT NULL,
        resource_json TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        execution_spec_digest TEXT,
        expires_at TEXT NOT NULL,
        issued_policy_epoch INTEGER NOT NULL CHECK (issued_policy_epoch >= 0),
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX permission_grants_active_idx
        ON permission_grants(task_id, subject_id, capability, expires_at)
        WHERE revoked_at IS NULL;
      CREATE TABLE permission_audit (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subject_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        operation TEXT NOT NULL,
        resource_digest TEXT NOT NULL CHECK (length(resource_digest) = 64),
        execution_spec_digest TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        evaluation_trace_json TEXT NOT NULL,
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        created_at TEXT NOT NULL
      );
      CREATE INDEX permission_audit_task_created_idx
        ON permission_audit(task_id, created_at, id);
    `,
  },
  {
    version: 7,
    checksum: 'permissions-v7-policy-epoch-outbox',
    sql: `
      CREATE TABLE permission_policy_epoch_outbox (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(task_id, policy_epoch)
      );
      CREATE INDEX permission_policy_epoch_outbox_pending_idx
        ON permission_policy_epoch_outbox(delivered_at, created_at, id);
    `,
  },
  {
    version: 8,
    checksum: 'permissions-v8-reviewer-audit-facts',
    sql: `
      ALTER TABLE permission_audit ADD COLUMN reviewer_json TEXT;
    `,
  },
  {
    version: 9,
    checksum: 'permissions-v9-one-time-permit-consumption',
    sql: `
      CREATE TABLE permission_one_time_permits (
        token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX permission_one_time_permits_active_idx
        ON permission_one_time_permits(task_id, policy_epoch, expires_at)
        WHERE consumed_at IS NULL;
    `,
  },
  {
    version: 10,
    checksum: 'permissions-v10-capability-revocations',
    sql: `
      CREATE TABLE permission_capability_revocations (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        revoked_at TEXT NOT NULL,
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        PRIMARY KEY(task_id, capability)
      );
    `,
  },
  {
    version: 11,
    checksum: 'permissions-v11-grant-egress-sandbox-bounds',
    sql: `
      ALTER TABLE permission_grants
        ADD COLUMN provider_egress_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE permission_grants
        ADD COLUMN sandbox_profiles_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
];

export type PermissionPolicyRecord = {
  preset: AccessPreset;
  policyEpoch: number;
  expandedPolicy: ExpandedAccessPolicy;
  revokedCapabilities: Capability[];
};

export type StartedTurn = { turnId: string; text: string; event: TurnEvent };
export type QueueTransition = { started: StartedTurn; queueEvent: TurnEvent } | null;

export interface PersistenceClient {
  listTasks(): TaskSummary[];
  createTask(title?: string): TaskSummary;
  renameTask(taskId: string, title: string): TaskSummary;
  setPinned(taskId: string, pinned: boolean): TaskSummary;
  setArchived(taskId: string, archived: boolean): TaskSummary;
  setGoal(taskId: string, goal: string): TaskSummary;
  getDraft(taskId: string): string;
  setDraft(taskId: string, draft: string): void;
  getWorkspace(taskId: string): string | null;
  setWorkspace(taskId: string, path: string): void;
  getRuntime(): RuntimeKind;
  setRuntime(kind: RuntimeKind): void;
  getModel(): string;
  setModel(model: string): void;
  getPermissionPolicy(taskId: string): PermissionPolicyRecord;
  setAccessPreset(
    taskId: string,
    preset: AccessPreset,
    expectedPolicyEpoch?: number,
  ): PermissionPolicyRecord;
  savePermissionGrant(taskId: string, grant: SessionGrant): void;
  listPermissionGrants(taskId: string, subjectId: string, now: string): SessionGrant[];
  revokePermissionCapability(taskId: string, capability: Capability, now: string): number;
  listPendingPermissionPolicyEpochs(): {
    id: string;
    taskId: string;
    policyEpoch: number;
  }[];
  markPermissionPolicyEpochDelivered(id: string, deliveredAt: string): void;
  registerPermissionOneTimeToken(
    taskId: string,
    token: string,
    policyEpoch: number,
    expiresAt: string,
  ): void;
  consumePermissionOneTimeToken(
    taskId: string,
    token: string,
    policyEpoch: number,
    now: string,
  ): boolean;
  recordPermissionAudit(
    taskId: string,
    request: PermissionRequest,
    evaluation: PermissionEvaluation,
  ): void;
  listMessages(taskId: string): ChatMessage[];
  startTurn(taskId: string, text: string): StartedTurn;
  queueInput(
    taskId: string,
    text: string,
    operationId: string,
  ): { ordinal: number; event: TurnEvent };
  steerTurn(taskId: string, text: string, expectedTurnId: string): void;
  startNextQueued(taskId: string): QueueTransition;
  getActiveTurnId(taskId: string): string | null;
  changeStage(taskId: string, turnId: string, stage: TurnStage): TurnEvent;
  appendDelta(taskId: string, turnId: string, messageId: string, delta: string): TurnEvent;
  completeTurn(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
  ): TurnEvent;
  cancelTurn(taskId: string, turnId: string): TurnEvent | null;
  snapshot(taskId: string): TurnSnapshot;
  prepareContext(taskId: string, turnId: string): PreparedContext;
  createIntelligenceStep(input: {
    taskId: string;
    turnId: string;
    model: string;
    effort: ReasoningEffort;
    contextDigest: string;
    toolCatalogDigest: string;
    policyEpoch: number;
    workspaceRevision: string;
    contractRevision: number | null;
  }): StepSnapshot;
  transitionIntelligenceStep(stepId: string, state: IntelligenceStepState): void;
  listIntelligenceSteps(turnId: string): StepSnapshot[];
  listEventsAfter(taskId: string, afterSeq: number): TurnEvent[];
  executeOperation<T>(
    principal: string,
    taskId: string,
    kind: string,
    operationId: string,
    requestHash: string,
    action: () => T,
  ): T;
  getOperationResult<T>(
    principal: string,
    taskId: string,
    kind: string,
    operationId: string,
    requestHash: string,
  ): { found: boolean; value?: T };
  interruptActiveTurns(): number;
  close(): void;
}

export class SqlitePersistenceClient implements PersistenceClient {
  private readonly db: Database.Database;
  private readonly contextLedger: ContextLedger;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.runMigrations(databasePath);
    this.contextLedger = new ContextLedger(this);
  }

  private runMigrations(databasePath: string): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const applied = new Map(
      (
        this.db.prepare('SELECT version, checksum FROM schema_migrations').all() as {
          version: number;
          checksum: string;
        }[]
      ).map((row) => [row.version, row.checksum]),
    );
    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (pending.length > 0 && existsSync(databasePath) && applied.size > 0)
      copyFileSync(databasePath, `${databasePath}.pre-migration.bak`);
    for (const migration of migrations) {
      const checksum = applied.get(migration.version);
      if (checksum !== undefined && checksum !== migration.checksum)
        throw new Error('Migration checksum mismatch');
      if (checksum !== undefined) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.checksum, new Date().toISOString());
      })();
    }
  }

  listTasks(): TaskSummary[] {
    return (
      this.db
        .prepare('SELECT * FROM tasks WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC')
        .all() as TaskRow[]
    ).map(toTask);
  }

  createTask(title = '新しいタスク'): TaskSummary {
    const now = new Date().toISOString();
    const task = taskSummarySchema.parse({
      id: randomUUID(),
      title,
      pinned: false,
      archived: false,
      goal: null,
      workspacePath: null,
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        "INSERT INTO tasks(id, title, pinned, archived, goal, workspace_path, draft, created_at, updated_at) VALUES (?, ?, 0, 0, NULL, NULL, '', ?, ?)",
      )
      .run(task.id, task.title, now, now);
    return task;
  }

  renameTask(taskId: string, title: string): TaskSummary {
    return this.updateTask(taskId, 'title', title);
  }
  setPinned(taskId: string, pinned: boolean): TaskSummary {
    return this.updateTask(taskId, 'pinned', pinned ? 1 : 0);
  }
  setArchived(taskId: string, archived: boolean): TaskSummary {
    return this.updateTask(taskId, 'archived', archived ? 1 : 0);
  }
  setGoal(taskId: string, goal: string): TaskSummary {
    return this.updateTask(taskId, 'goal', goal);
  }

  getDraft(taskId: string): string {
    return this.getTaskRow(taskId).draft;
  }

  setDraft(taskId: string, draft: string): void {
    const result = this.db
      .prepare('UPDATE tasks SET draft = ?, updated_at = ? WHERE id = ?')
      .run(draft, new Date().toISOString(), taskId);
    if (result.changes !== 1) throw new NotFoundError('Task not found');
  }

  getWorkspace(taskId: string): string | null {
    return this.getTaskRow(taskId).workspace_path;
  }

  setWorkspace(taskId: string, path: string): void {
    const result = this.db
      .prepare('UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ?')
      .run(path, new Date().toISOString(), taskId);
    if (result.changes !== 1) throw new NotFoundError('Task not found');
  }

  getRuntime(): RuntimeKind {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'runtime.kind'").get() as
      { value: string } | undefined;
    return row?.value === 'codex' ? 'codex' : 'mock';
  }

  setRuntime(kind: RuntimeKind): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('runtime.kind', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(kind, new Date().toISOString());
  }

  getModel(): string {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'runtime.codex.model'")
      .get() as { value: string } | undefined;
    return row?.value ?? 'auto';
  }

  setModel(model: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('runtime.codex.model', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(model, new Date().toISOString());
  }

  getPermissionPolicy(taskId: string): PermissionPolicyRecord {
    this.assertTask(taskId);
    const state = this.db
      .prepare('SELECT * FROM permission_policy_state WHERE task_id = ?')
      .get(taskId) as PermissionPolicyRow | undefined;
    if (state === undefined)
      return {
        preset: 'ask',
        policyEpoch: 0,
        expandedPolicy: expandAccessPreset('ask'),
        revokedCapabilities: [],
      };
    const revokedCapabilities = (
      this.db
        .prepare(
          'SELECT capability FROM permission_capability_revocations WHERE task_id = ? ORDER BY capability',
        )
        .all(taskId) as { capability: Capability }[]
    ).map(({ capability }) => capability);
    if (revokedCapabilities.some((capability) => !capabilities.includes(capability)))
      throw new Error('Invalid stored revoked capability');
    const rules = this.db
      .prepare(
        `SELECT effect, capability, resource_json, operations_json, audit_reason
        FROM permission_rules WHERE task_id = ? ORDER BY rowid`,
      )
      .all(taskId) as PermissionRuleRow[];
    const parsed = rules.map(parsePermissionRuleRow);
    const canonical = expandAccessPreset(state.preset_label);
    const expectedRules = [
      ...canonical.allowRules.map((rule) => ({ effect: 'allow' as const, rule })),
      ...(canonical.immutableDeny ?? []).map((rule) => ({
        effect: 'immutable-deny' as const,
        rule,
      })),
    ];
    if (
      state.approval_policy !== canonical.approvalPolicy ||
      state.approval_reason !== (canonical.approvalReason ?? null) ||
      JSON.stringify(parsed.map(permissionRuleKey).sort()) !==
        JSON.stringify(expectedRules.map(permissionRuleKey).sort())
    )
      return {
        preset: 'ask',
        policyEpoch: state.policy_epoch,
        expandedPolicy: expandAccessPreset('ask'),
        revokedCapabilities,
      };
    return {
      preset: state.preset_label,
      policyEpoch: state.policy_epoch,
      expandedPolicy: canonical,
      revokedCapabilities,
    };
  }

  setAccessPreset(
    taskId: string,
    preset: AccessPreset,
    expectedPolicyEpoch?: number,
  ): PermissionPolicyRecord {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      const current = this.getPermissionPolicy(taskId);
      if (expectedPolicyEpoch !== undefined && current.policyEpoch !== expectedPolicyEpoch)
        throw new Error('Permission policy epoch changed');
      const expanded = expandAccessPreset(preset);
      const now = new Date().toISOString();
      const policyEpoch = current.policyEpoch + 1;
      this.db
        .prepare(
          `INSERT INTO permission_policy_state(
            task_id, preset_label, approval_policy, approval_reason, policy_epoch, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            preset_label = excluded.preset_label,
            approval_policy = excluded.approval_policy,
            approval_reason = excluded.approval_reason,
            policy_epoch = excluded.policy_epoch,
            updated_at = excluded.updated_at`,
        )
        .run(
          taskId,
          preset,
          expanded.approvalPolicy,
          expanded.approvalReason ?? null,
          policyEpoch,
          now,
        );
      this.db.prepare('DELETE FROM permission_rules WHERE task_id = ?').run(taskId);
      const insert = this.db.prepare(
        `INSERT INTO permission_rules(
          id, task_id, source, effect, capability, resource_json,
          operations_json, audit_reason, created_at
        ) VALUES (?, ?, 'preset', ?, ?, ?, ?, ?, ?)`,
      );
      for (const [effect, rules] of [
        ['allow', expanded.allowRules],
        ['immutable-deny', expanded.immutableDeny ?? []],
      ] as const)
        for (const rule of rules)
          insert.run(
            randomUUID(),
            taskId,
            effect,
            rule.capability,
            JSON.stringify(rule.resourceSet),
            JSON.stringify(rule.operations),
            rule.auditReason ?? null,
            now,
          );
      this.enqueuePermissionPolicyEpoch(taskId, policyEpoch, now);
      return {
        preset,
        policyEpoch,
        expandedPolicy: expanded,
        revokedCapabilities: current.revokedCapabilities,
      };
    })();
  }

  savePermissionGrant(taskId: string, grant: SessionGrant): void {
    this.db.transaction(() => {
      this.assertTask(taskId);
      const validated = createSessionGrant(grant);
      if (validated.policyEpoch !== this.getPermissionPolicy(taskId).policyEpoch)
        throw new Error('Grant policy epoch must match the current Task policy epoch');
      this.db
        .prepare(
          `INSERT INTO permission_grants(
            id, task_id, subject_id, scope, capability, resource_json, operations_json,
            provider_egress_json, sandbox_profiles_json, execution_spec_digest,
            expires_at, issued_policy_epoch, revoked_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validated.id,
          taskId,
          validated.subjectId,
          validated.scope,
          validated.capability,
          JSON.stringify(validated.resourceSet),
          JSON.stringify(validated.operations),
          JSON.stringify(validated.providerEgress),
          JSON.stringify(validated.sandboxProfiles),
          validated.executionSpecDigest ?? null,
          new Date(validated.expiresAt).toISOString(),
          validated.policyEpoch,
          validated.revokedAt ?? null,
          new Date().toISOString(),
        );
    })();
  }

  listPermissionGrants(taskId: string, subjectId: string, now: string): SessionGrant[] {
    this.assertTask(taskId);
    const canonicalNow = new Date(now).toISOString();
    return (
      this.db
        .prepare(
          `SELECT * FROM permission_grants
          WHERE task_id = ? AND subject_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY created_at, id`,
        )
        .all(taskId, subjectId, canonicalNow) as PermissionGrantRow[]
    ).map(parsePermissionGrantRow);
  }

  revokePermissionCapability(taskId: string, capability: Capability, now: string): number {
    return this.db.transaction(() => {
      const canonicalNow = new Date(now).toISOString();
      const current = this.getPermissionPolicy(taskId);
      const updated = this.db
        .prepare(
          `UPDATE permission_grants SET revoked_at = ?
          WHERE task_id = ? AND capability = ? AND revoked_at IS NULL`,
        )
        .run(canonicalNow, taskId, capability);
      const nextEpoch = current.policyEpoch + 1;
      const expanded = current.expandedPolicy;
      this.db
        .prepare(
          `INSERT INTO permission_policy_state(
            task_id, preset_label, approval_policy, approval_reason, policy_epoch, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET policy_epoch = excluded.policy_epoch,
            updated_at = excluded.updated_at`,
        )
        .run(
          taskId,
          current.preset,
          expanded.approvalPolicy,
          expanded.approvalReason ?? null,
          nextEpoch,
          canonicalNow,
        );
      this.db
        .prepare(
          `INSERT INTO permission_capability_revocations(
            task_id, capability, revoked_at, policy_epoch
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(task_id, capability) DO UPDATE SET
            revoked_at = excluded.revoked_at, policy_epoch = excluded.policy_epoch`,
        )
        .run(taskId, capability, canonicalNow, nextEpoch);
      this.enqueuePermissionPolicyEpoch(taskId, nextEpoch, canonicalNow);
      return updated.changes;
    })();
  }

  listPendingPermissionPolicyEpochs(): {
    id: string;
    taskId: string;
    policyEpoch: number;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT id, task_id, policy_epoch FROM permission_policy_epoch_outbox
          WHERE delivered_at IS NULL ORDER BY created_at, id`,
        )
        .all() as { id: string; task_id: string; policy_epoch: number }[]
    ).map((row) => ({ id: row.id, taskId: row.task_id, policyEpoch: row.policy_epoch }));
  }

  markPermissionPolicyEpochDelivered(id: string, deliveredAt: string): void {
    this.db
      .prepare(
        `UPDATE permission_policy_epoch_outbox SET delivered_at = ?
        WHERE id = ? AND delivered_at IS NULL`,
      )
      .run(new Date(deliveredAt).toISOString(), id);
  }

  registerPermissionOneTimeToken(
    taskId: string,
    token: string,
    policyEpoch: number,
    expiresAt: string,
  ): void {
    this.assertTask(taskId);
    this.db
      .prepare(
        `INSERT INTO permission_one_time_permits(
          token_hash, task_id, policy_epoch, expires_at, consumed_at, created_at
        ) VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT(token_hash) DO NOTHING`,
      )
      .run(
        createHash('sha256').update(token).digest('hex'),
        taskId,
        policyEpoch,
        new Date(expiresAt).toISOString(),
        new Date().toISOString(),
      );
  }

  consumePermissionOneTimeToken(
    taskId: string,
    token: string,
    policyEpoch: number,
    now: string,
  ): boolean {
    const canonicalNow = new Date(now).toISOString();
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE permission_one_time_permits SET consumed_at = ?
          WHERE token_hash = ? AND task_id = ? AND policy_epoch = ?
            AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(
          canonicalNow,
          createHash('sha256').update(token).digest('hex'),
          taskId,
          policyEpoch,
          canonicalNow,
        );
      return result.changes === 1;
    })();
  }

  private enqueuePermissionPolicyEpoch(
    taskId: string,
    policyEpoch: number,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO permission_policy_epoch_outbox(
          id, task_id, policy_epoch, created_at, delivered_at
        ) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(task_id, policy_epoch) DO NOTHING`,
      )
      .run(randomUUID(), taskId, policyEpoch, createdAt);
  }

  recordPermissionAudit(
    taskId: string,
    request: PermissionRequest,
    evaluation: PermissionEvaluation,
  ): void {
    this.assertTask(taskId);
    if (
      evaluation.reviewerAudit !== undefined &&
      (!/^[a-f0-9]{64}$/.test(evaluation.reviewerAudit.requestFingerprint) ||
        !/^[a-f0-9]{64}$/.test(evaluation.reviewerAudit.executionSpecDigest) ||
        !/^[a-f0-9]{64}$/.test(evaluation.reviewerAudit.inputDigest))
    )
      throw new Error('Invalid reviewer audit digest');
    const resourceDigest = createHash('sha256')
      .update(JSON.stringify(request.resource))
      .digest('hex');
    this.db
      .prepare(
        `INSERT INTO permission_audit(
          id, task_id, subject_id, capability, operation, resource_digest,
          execution_spec_digest, decision, reason, evaluation_trace_json, policy_epoch,
          reviewer_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        request.subjectId,
        request.capability,
        request.operation,
        resourceDigest,
        request.executionSpecDigest,
        evaluation.decision,
        evaluation.reason,
        JSON.stringify(evaluation.evaluationTrace),
        evaluation.policyEpoch,
        evaluation.reviewerAudit === undefined ? null : JSON.stringify(evaluation.reviewerAudit),
        new Date().toISOString(),
      );
  }

  listMessages(taskId: string): ChatMessage[] {
    this.assertTask(taskId);
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at, rowid')
        .all(taskId) as MessageRow[]
    ).map(toMessage);
  }

  startTurn(taskId: string, text: string): StartedTurn {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      if (this.getActiveTurnId(taskId) !== null) throw new TurnActiveError();
      return this.startTurnInTransaction(taskId, text);
    })();
  }

  queueInput(
    taskId: string,
    text: string,
    operationId: string,
  ): { ordinal: number; event: TurnEvent } {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      const row = this.db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM input_queue WHERE task_id = ?',
        )
        .get(taskId) as { ordinal: number };
      this.db
        .prepare(
          `INSERT INTO input_queue(task_id, ordinal, operation_id, mode, payload_json, state, created_at)
        VALUES (?, ?, ?, 'queue', ?, 'queued', ?)`,
        )
        .run(taskId, row.ordinal, operationId, JSON.stringify({ text }), new Date().toISOString());
      const event = this.queueChangedEvent(taskId);
      return { ordinal: row.ordinal, event };
    })();
  }

  steerTurn(taskId: string, text: string, expectedTurnId: string): void {
    this.db.transaction(() => {
      this.assertTask(taskId);
      const activeTurnId = this.getActiveTurnId(taskId);
      if (activeTurnId !== expectedTurnId) throw new SteerStaleError();
      const now = new Date().toISOString();
      this.db
        .prepare(
          'INSERT INTO messages(id, task_id, turn_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), taskId, activeTurnId, 'user', text, now);
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
    })();
  }

  startNextQueued(taskId: string): QueueTransition {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      if (this.getActiveTurnId(taskId) !== null) return null;
      const row = this.db
        .prepare(
          `SELECT ordinal, payload_json FROM input_queue
        WHERE task_id = ? AND state = 'queued' ORDER BY ordinal LIMIT 1`,
        )
        .get(taskId) as QueueRow | undefined;
      if (row === undefined) return null;
      const parsed = JSON.parse(row.payload_json) as { text: string };
      this.db
        .prepare("UPDATE input_queue SET state = 'dequeued' WHERE task_id = ? AND ordinal = ?")
        .run(taskId, row.ordinal);
      const started = this.startTurnInTransaction(taskId, parsed.text);
      return { started, queueEvent: this.queueChangedEvent(taskId) };
    })();
  }

  getActiveTurnId(taskId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM turns WHERE task_id = ? AND state IN
      ('queued', 'understanding', 'planning', 'executing', 'synthesizing', 'canceling') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  changeStage(taskId: string, turnId: string, stage: TurnStage): TurnEvent {
    return this.db.transaction(() => {
      const turn = this.getTurn(taskId, turnId);
      transitionTurn(turn.state, stage);
      this.updateTurn(turnId, stage);
      return this.appendEvent({ type: 'stage.changed', taskId, turnId, stage });
    })();
  }

  appendDelta(taskId: string, turnId: string, messageId: string, delta: string): TurnEvent {
    return this.db.transaction(() => {
      const turn = this.getTurn(taskId, turnId);
      if (turn.state !== 'synthesizing') throw new Error('Turn is not streaming');
      const now = new Date().toISOString();
      if (turn.assistant_message_id === null) {
        this.db
          .prepare(
            'INSERT INTO messages(id, task_id, turn_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(messageId, taskId, turnId, 'assistant', delta, now);
        this.db
          .prepare('UPDATE turns SET assistant_message_id = ? WHERE id = ?')
          .run(messageId, turnId);
      } else {
        if (turn.assistant_message_id !== messageId)
          throw new Error('Assistant message identity mismatch');
        this.db
          .prepare('UPDATE messages SET content = content || ? WHERE id = ?')
          .run(delta, messageId);
      }
      this.updateTurn(turnId, turn.state);
      return this.appendEvent({ type: 'message.delta', taskId, turnId, messageId, delta });
    })();
  }

  completeTurn(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
  ): TurnEvent {
    return this.db.transaction(() => this.completeTurnInTransaction(taskId, turnId, state))();
  }

  cancelTurn(taskId: string, turnId: string): TurnEvent | null {
    return this.db.transaction(() => {
      const turn = this.getTurn(taskId, turnId);
      if (isTerminal(turn.state)) return null;
      transitionTurn(turn.state, 'canceling');
      this.updateTurn(turnId, 'canceling');
      return this.completeTurnInTransaction(taskId, turnId, 'canceled');
    })();
  }

  snapshot(taskId: string): TurnSnapshot {
    this.assertTask(taskId);
    const lastSeq = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM turn_events WHERE task_id = ?')
        .get(taskId) as { seq: number }
    ).seq;
    const active = this.db
      .prepare(
        `SELECT * FROM turns WHERE task_id = ? AND state IN
      ('queued', 'understanding', 'planning', 'executing', 'synthesizing', 'canceling') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as TurnRow | undefined;
    const activeTurn =
      active === undefined
        ? null
        : {
            turnId: active.id,
            stage: stateToStage(active.state),
            startedAtEpochMs: new Date(active.created_at).getTime(),
            streamedText:
              active.assistant_message_id === null
                ? ''
                : (
                    this.db
                      .prepare('SELECT content FROM messages WHERE id = ?')
                      .get(active.assistant_message_id) as { content: string }
                  ).content,
            messageId: active.assistant_message_id,
          };
    const usageRow = this.db
      .prepare(
        "SELECT payload_json FROM turn_events WHERE task_id = ? AND type = 'context.usage' ORDER BY seq DESC LIMIT 1",
      )
      .get(taskId) as { payload_json: string } | undefined;
    const contextUsage =
      usageRow === undefined
        ? defaultContextUsage()
        : extractContextUsage(turnEventSchema.parse(JSON.parse(usageRow.payload_json)));
    return turnSnapshotSchema.parse({
      lastSeq,
      activeTurn,
      queued: this.listQueued(taskId),
      contextUsage,
    });
  }

  prepareContext(taskId: string, turnId: string): PreparedContext {
    return this.db.transaction(() => this.contextLedger.prepare(taskId, turnId))();
  }

  createIntelligenceStep(input: {
    taskId: string;
    turnId: string;
    model: string;
    effort: ReasoningEffort;
    contextDigest: string;
    toolCatalogDigest: string;
    policyEpoch: number;
    workspaceRevision: string;
    contractRevision: number | null;
  }): StepSnapshot {
    return this.db.transaction(() => {
      this.getTurn(input.taskId, input.turnId);
      const ordinal = (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM intelligence_steps WHERE turn_id = ?',
          )
          .get(input.turnId) as { ordinal: number }
      ).ordinal;
      const now = new Date().toISOString();
      const snapshot: StepSnapshot = {
        stepId: randomUUID(),
        ordinal,
        createdAt: now,
        ...input,
      };
      this.db
        .prepare(
          `INSERT INTO intelligence_steps(
            id, task_id, turn_id, ordinal, state, model, effort, context_digest,
            tool_catalog_digest, policy_epoch, workspace_revision, contract_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.stepId,
          snapshot.taskId,
          snapshot.turnId,
          snapshot.ordinal,
          snapshot.model,
          snapshot.effort,
          snapshot.contextDigest,
          snapshot.toolCatalogDigest,
          snapshot.policyEpoch,
          snapshot.workspaceRevision,
          snapshot.contractRevision,
          now,
          now,
        );
      return snapshot;
    })();
  }

  transitionIntelligenceStep(stepId: string, state: IntelligenceStepState): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT state FROM intelligence_steps WHERE id = ?')
        .get(stepId) as { state: IntelligenceStepState } | undefined;
      if (row === undefined) throw new NotFoundError('Intelligence step not found');
      transitionIntelligenceStep(row.state, state);
      this.db
        .prepare('UPDATE intelligence_steps SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, new Date().toISOString(), stepId);
    })();
  }

  listIntelligenceSteps(turnId: string): StepSnapshot[] {
    return (
      this.db
        .prepare('SELECT * FROM intelligence_steps WHERE turn_id = ? ORDER BY ordinal')
        .all(turnId) as IntelligenceStepRow[]
    ).map(toStepSnapshot);
  }

  listEventsAfter(taskId: string, afterSeq: number): TurnEvent[] {
    this.assertTask(taskId);
    return (
      this.db
        .prepare(
          "SELECT payload_json FROM turn_events WHERE task_id = ? AND seq > ? AND type != 'context.compacted' ORDER BY seq",
        )
        .all(taskId, afterSeq) as { payload_json: string }[]
    ).map((row) => turnEventSchema.parse(JSON.parse(row.payload_json)));
  }

  executeOperation<T>(
    principal: string,
    taskId: string,
    kind: string,
    operationId: string,
    requestHash: string,
    action: () => T,
  ): T {
    return this.db.transaction(() => {
      const cached = this.getOperationResult<T>(principal, taskId, kind, operationId, requestHash);
      if (cached.found) return cached.value as T;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO operations(principal, task_id, kind, operation_id, request_hash, state, result_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
        )
        .run(principal, taskId, kind, operationId, requestHash, now, now);
      const value = action();
      this.db
        .prepare(
          "UPDATE operations SET state = 'completed', result_json = ?, updated_at = ? WHERE principal = ? AND task_id = ? AND kind = ? AND operation_id = ?",
        )
        .run(
          JSON.stringify({ value }),
          new Date().toISOString(),
          principal,
          taskId,
          kind,
          operationId,
        );
      return value;
    })();
  }

  getOperationResult<T>(
    principal: string,
    taskId: string,
    kind: string,
    operationId: string,
    requestHash: string,
  ): { found: boolean; value?: T } {
    const row = this.db
      .prepare(
        `SELECT request_hash, state, result_json FROM operations
      WHERE principal = ? AND task_id = ? AND kind = ? AND operation_id = ?`,
      )
      .get(principal, taskId, kind, operationId) as OperationRow | undefined;
    if (row === undefined) return { found: false };
    if (row.request_hash !== requestHash) throw new OperationConflictError();
    if (row.state !== 'completed' || row.result_json === null) throw new OperationInProgressError();
    const decoded = JSON.parse(row.result_json) as { value: T };
    return { found: true, value: decoded.value };
  }

  interruptActiveTurns(): number {
    return this.db.transaction(() => {
      const turns = this.db
        .prepare(
          `SELECT * FROM turns WHERE state IN
        ('queued', 'understanding', 'planning', 'executing', 'synthesizing', 'canceling')`,
        )
        .all() as TurnRow[];
      for (const turn of turns)
        this.completeTurnInTransaction(turn.task_id, turn.id, 'interrupted');
      return turns.length;
    })();
  }

  close(): void {
    this.db.close();
  }

  private startTurnInTransaction(taskId: string, text: string): StartedTurn {
    const now = new Date().toISOString();
    const turnId = randomUUID();
    const userMessage = chatMessageSchema.parse({
      id: randomUUID(),
      taskId,
      turnId,
      author: 'user',
      content: text,
      createdAt: now,
    });
    this.db
      .prepare(
        'INSERT INTO messages(id, task_id, turn_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(userMessage.id, taskId, turnId, userMessage.author, userMessage.content, now);
    this.db
      .prepare(
        'INSERT INTO turns(id, task_id, user_message_id, state, seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      )
      .run(turnId, taskId, userMessage.id, 'queued', now, now);
    const event = this.appendEvent({ type: 'turn.accepted', taskId, turnId, userMessage });
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
    return { turnId, text, event };
  }

  private completeTurnInTransaction(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
  ): TurnEvent {
    const turn = this.getTurn(taskId, turnId);
    transitionTurn(turn.state, state);
    this.updateTurn(turnId, state);
    const row =
      turn.assistant_message_id === null
        ? undefined
        : (this.db.prepare('SELECT * FROM messages WHERE id = ?').get(turn.assistant_message_id) as
            MessageRow | undefined);
    return this.appendEvent(
      row === undefined
        ? { type: 'turn.completed', taskId, turnId, state }
        : { type: 'turn.completed', taskId, turnId, state, message: toMessage(row) },
    );
  }

  private queueChangedEvent(taskId: string): TurnEvent {
    return this.appendEvent({ type: 'queue.changed', taskId, queued: this.listQueued(taskId) });
  }

  private listQueued(taskId: string): QueuedInput[] {
    return (
      this.db
        .prepare(
          "SELECT ordinal, payload_json FROM input_queue WHERE task_id = ? AND state = 'queued' ORDER BY ordinal",
        )
        .all(taskId) as QueueRow[]
    ).map((row) => ({
      ordinal: row.ordinal,
      text: (JSON.parse(row.payload_json) as { text: string }).text,
    }));
  }

  private appendEvent(event: EventWithoutSeq): TurnEvent {
    const seq = this.nextEventSeq(event.taskId);
    const parsed = turnEventSchema.parse({ ...event, seq });
    const turnId = 'turnId' in parsed ? parsed.turnId : null;
    this.db
      .prepare(
        'INSERT INTO turn_events(id, task_id, turn_id, seq, schema_version, type, payload_json, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        parsed.taskId,
        turnId,
        parsed.seq,
        parsed.type,
        JSON.stringify(parsed),
        new Date().toISOString(),
      );
    return parsed;
  }

  private nextEventSeq(taskId: string): number {
    return (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turn_events WHERE task_id = ?')
        .get(taskId) as { seq: number }
    ).seq;
  }

  loadContextLedgerState(taskId: string): ContextLedgerState {
    const task = this.getTaskRow(taskId);
    const messages = this.db
      .prepare(
        `SELECT m.id, m.author, m.content, m.created_at,
          f.id AS fragment_id, f.superseded_by_compaction_id
        FROM messages m
        LEFT JOIN context_fragments f ON f.message_id = m.id AND f.source = 'history'
        WHERE m.task_id = ? AND m.author IN ('user', 'assistant')
        ORDER BY m.created_at, m.rowid`,
      )
      .all(taskId) as {
      id: string;
      author: 'user' | 'assistant';
      content: string;
      created_at: string;
      fragment_id: string | null;
      superseded_by_compaction_id: string | null;
    }[];
    const compactions = this.db
      .prepare(
        `SELECT f.id, f.task_id, f.source, f.trust, f.token_estimate, f.created_at,
          f.message_id, e.payload_json
        FROM context_fragments f
        JOIN turn_events e ON e.id = f.id
        WHERE f.task_id = ? AND f.source = 'compaction'
        ORDER BY f.created_at, f.rowid`,
      )
      .all(taskId) as {
      id: string;
      task_id: string;
      source: 'compaction';
      trust: ContextFragment['trust'];
      token_estimate: number;
      created_at: string;
      message_id: null;
      payload_json: string;
    }[];
    return {
      goal: task.goal,
      messages: messages.map((message) => ({
        id: message.id,
        author: message.author,
        content: message.content,
        createdAt: message.created_at,
        fragmentId: message.fragment_id,
        supersededByCompactionId: message.superseded_by_compaction_id,
      })),
      compactions: compactions.map((fragment) => ({
        id: fragment.id,
        taskId: fragment.task_id,
        source: fragment.source,
        trust: fragment.trust,
        tokenEstimate: fragment.token_estimate,
        content: readCompactionSummary(fragment.payload_json),
        createdAt: fragment.created_at,
        messageId: fragment.message_id,
      })),
    };
  }

  recordContextFragments(fragments: PersistedFragment[]): void {
    const insert = this.db.prepare(
      `INSERT INTO context_fragments(
        id, task_id, source, trust, token_estimate, created_at,
        superseded_by_compaction_id, message_id
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    for (const fragment of fragments)
      insert.run(
        fragment.id,
        fragment.taskId,
        fragment.source,
        fragment.trust,
        fragment.tokenEstimate,
        fragment.createdAt,
        fragment.messageId,
      );
  }

  recordContextUsage(taskId: string, _turnId: string, usage: ContextUsage): TurnEvent {
    return this.appendEvent({ type: 'context.usage', taskId, usage });
  }

  recordContextCompaction(
    taskId: string,
    turnId: string,
    fragment: ContextFragment,
    supersededFragmentIds: string[],
  ): void {
    this.db
      .prepare(
        `INSERT INTO context_fragments(
          id, task_id, source, trust, token_estimate, created_at,
          superseded_by_compaction_id, message_id
        ) VALUES (?, ?, 'compaction', ?, ?, ?, NULL, NULL)`,
      )
      .run(fragment.id, taskId, fragment.trust, fragment.tokenEstimate, fragment.createdAt);
    const placeholders = supersededFragmentIds.map(() => '?').join(', ');
    const updated = this.db
      .prepare(
        `UPDATE context_fragments SET superseded_by_compaction_id = ?
        WHERE task_id = ? AND source = 'history' AND superseded_by_compaction_id IS NULL
          AND id IN (${placeholders})`,
      )
      .run(fragment.id, taskId, ...supersededFragmentIds);
    if (updated.changes !== supersededFragmentIds.length)
      throw new Error('Context compaction superseded an unexpected fragment set');
    const seq = this.nextEventSeq(taskId);
    const audit = {
      type: 'context.compacted',
      taskId,
      turnId,
      seq,
      compactionId: fragment.id,
      supersededFragmentIds,
      summary: fragment.content,
    };
    this.db
      .prepare(
        'INSERT INTO turn_events(id, task_id, turn_id, seq, schema_version, type, payload_json, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      )
      .run(fragment.id, taskId, turnId, seq, audit.type, JSON.stringify(audit), fragment.createdAt);
  }

  private updateTask(
    taskId: string,
    column: 'title' | 'pinned' | 'archived' | 'goal',
    value: string | number,
  ): TaskSummary {
    const result = this.db
      .prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .run(value, new Date().toISOString(), taskId);
    if (result.changes !== 1) throw new NotFoundError('Task not found');
    return toTask(this.getTaskRow(taskId));
  }

  private updateTurn(turnId: string, state: TurnState): void {
    this.db
      .prepare('UPDATE turns SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), turnId);
  }

  private getTaskRow(taskId: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      TaskRow | undefined;
    if (row === undefined) throw new NotFoundError('Task not found');
    return row;
  }

  private assertTask(taskId: string): void {
    this.getTaskRow(taskId);
  }

  private getTurn(taskId: string, turnId: string): TurnRow {
    const row = this.db
      .prepare('SELECT * FROM turns WHERE id = ? AND task_id = ?')
      .get(turnId, taskId) as TurnRow | undefined;
    if (row === undefined) throw new NotFoundError('Turn not found');
    return row;
  }
}

export class NotFoundError extends Error {}
export class TurnActiveError extends Error {}
export class SteerStaleError extends Error {}
export class OperationConflictError extends Error {}
export class OperationInProgressError extends Error {}

function toTask(row: TaskRow): TaskSummary {
  return taskSummarySchema.parse({
    id: row.id,
    title: row.title,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    goal: row.goal,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toMessage(row: MessageRow): ChatMessage {
  return chatMessageSchema.parse({
    id: row.id,
    taskId: row.task_id,
    turnId: row.turn_id,
    author: row.author,
    content: row.content,
    createdAt: row.created_at,
  });
}

function toStepSnapshot(row: IntelligenceStepRow): StepSnapshot {
  return {
    stepId: row.id,
    taskId: row.task_id,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    model: row.model,
    effort: row.effort,
    contextDigest: row.context_digest,
    toolCatalogDigest: row.tool_catalog_digest,
    policyEpoch: row.policy_epoch,
    workspaceRevision: row.workspace_revision,
    contractRevision: row.contract_revision,
    createdAt: row.created_at,
  };
}

function isTerminal(state: TurnState): boolean {
  return (
    state === 'completed' || state === 'canceled' || state === 'failed' || state === 'interrupted'
  );
}

function stateToStage(state: TurnState): TurnStage {
  if (state === 'planning' || state === 'executing' || state === 'synthesizing') return state;
  return 'understanding';
}

function extractContextUsage(event: TurnEvent): ContextUsage {
  if (event.type !== 'context.usage') throw new Error('Expected a context usage event');
  return event.usage;
}

function readCompactionSummary(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as unknown;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('type' in payload) ||
    payload.type !== 'context.compacted' ||
    !('summary' in payload) ||
    typeof payload.summary !== 'string'
  )
    throw new Error('Invalid context compaction audit payload');
  return payload.summary;
}

function parsePermissionRuleRow(row: PermissionRuleRow): {
  effect: PermissionRuleRow['effect'];
  rule: PermissionRule;
} {
  if (!capabilities.includes(row.capability)) throw new Error('Invalid stored capability');
  const operations = parsePermissionOperations(row.operations_json);
  const resourceSet = parseResourceSet(row.resource_json);
  return {
    effect: row.effect,
    rule: {
      capability: row.capability,
      resourceSet,
      operations,
      ...(row.audit_reason === null ? {} : { auditReason: row.audit_reason }),
    },
  };
}

function parsePermissionGrantRow(row: PermissionGrantRow): SessionGrant {
  if (!capabilities.includes(row.capability)) throw new Error('Invalid stored grant capability');
  return createSessionGrant({
    id: row.id,
    subjectId: row.subject_id,
    capability: row.capability,
    resourceSet: parseResourceSet(row.resource_json),
    operations: parsePermissionOperations(row.operations_json),
    scope: row.scope,
    expiresAt: row.expires_at,
    policyEpoch: row.issued_policy_epoch,
    providerEgress: parseStringEnumArray(
      row.provider_egress_json,
      ['none', 'trusted-local', 'trusted-remote', 'untrusted-remote'] as const,
      'provider egress',
    ) as ProviderEgress[],
    sandboxProfiles: parseStringEnumArray(
      row.sandbox_profiles_json,
      ['read-only', 'workspace-write', 'full'] as const,
      'sandbox profiles',
    ) as SandboxProfile[],
    ...(row.execution_spec_digest === null
      ? {}
      : { executionSpecDigest: row.execution_spec_digest }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  });
}

function parsePermissionOperations(json: string): PermissionOperation[] {
  const value = JSON.parse(json) as unknown;
  const valid = ['read', 'write', 'execute', 'fetch', 'open', 'use', 'egress'] as const;
  if (!Array.isArray(value) || !value.every((item) => valid.includes(item as PermissionOperation)))
    throw new Error('Invalid stored permission operations');
  return value as PermissionOperation[];
}

function parseStringEnumArray<T extends string>(
  json: string,
  valid: readonly T[],
  label: string,
): T[] {
  const value = JSON.parse(json) as unknown;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    !value.every((item) => typeof item === 'string' && valid.includes(item as T))
  )
    throw new Error(`Invalid stored ${label}`);
  return value as T[];
}

function parseResourceSet(json: string): ResourceSet {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== 'object' || value === null || !('kind' in value))
    throw new Error('Invalid stored resource set');
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'all' && Object.keys(record).length === 1) return { kind: 'all' };
  if (
    record['kind'] === 'workspace' &&
    Object.keys(record).every((key) => key === 'kind' || key === 'workspaceId') &&
    (record['workspaceId'] === undefined ||
      (typeof record['workspaceId'] === 'string' && record['workspaceId'].length > 0))
  )
    return record['workspaceId'] === undefined
      ? { kind: 'workspace' }
      : { kind: 'workspace', workspaceId: record['workspaceId'] as string };
  if (
    (record['kind'] === 'path-exact' || record['kind'] === 'path-prefix') &&
    Object.keys(record).every(
      (key) => key === 'kind' || key === 'canonicalPath' || key === 'workspaceId',
    ) &&
    typeof record['canonicalPath'] === 'string' &&
    record['canonicalPath'].length > 0 &&
    (record['workspaceId'] === undefined ||
      (typeof record['workspaceId'] === 'string' && record['workspaceId'].length > 0))
  )
    return {
      kind: record['kind'],
      canonicalPath: record['canonicalPath'],
      ...(record['workspaceId'] === undefined
        ? {}
        : { workspaceId: record['workspaceId'] as string }),
    };
  if (
    record['kind'] === 'path-classification' &&
    Object.keys(record).every((key) => key === 'kind' || key === 'classifications') &&
    Array.isArray(record['classifications']) &&
    record['classifications'].length > 0 &&
    record['classifications'].every((item) =>
      [
        'workspace',
        'external',
        'app-private',
        'os-protected',
        'credential',
        'signing-key',
        'update-key',
        'unclassified',
      ].includes(item as string),
    )
  )
    return {
      kind: 'path-classification',
      classifications: record['classifications'] as ResourceSet & string[],
    } as ResourceSet;
  if (record['kind'] === 'network-origin' && typeof record['origin'] === 'string')
    return { kind: 'network-origin', origin: record['origin'] };
  if (record['kind'] === 'secret-exact' && typeof record['secretId'] === 'string')
    return { kind: 'secret-exact', secretId: record['secretId'] };
  if (record['kind'] === 'external-exact' && typeof record['target'] === 'string')
    return { kind: 'external-exact', target: record['target'] };
  if (
    record['kind'] === 'provider-egress' &&
    Array.isArray(record['providerIds']) &&
    record['providerIds'].every((item) => typeof item === 'string') &&
    Array.isArray(record['fragmentKinds']) &&
    record['fragmentKinds'].every((item) => typeof item === 'string') &&
    Array.isArray(record['allowedProviderTrust']) &&
    record['allowedProviderTrust'].every(
      (item) =>
        item === 'trusted-local' || item === 'trusted-remote' || item === 'untrusted-remote',
    ) &&
    Array.isArray(record['allowedResidencies']) &&
    record['allowedResidencies'].every((item) => typeof item === 'string' && item.length > 0) &&
    Array.isArray(record['allowedProvenance']) &&
    record['allowedProvenance'].every(
      (item) =>
        item === 'system' || item === 'user' || item === 'workspace' || item === 'untrusted',
    ) &&
    Object.keys(record).every(
      (key) =>
        key === 'kind' ||
        key === 'providerIds' ||
        key === 'fragmentKinds' ||
        key === 'maxBytes' ||
        key === 'allowedProviderTrust' ||
        key === 'allowedResidencies' ||
        key === 'allowedProvenance' ||
        key === 'requireSecretScanClean' ||
        key === 'allowLocalOnlyTaskRemote',
    ) &&
    typeof record['maxBytes'] === 'number' &&
    Number.isSafeInteger(record['maxBytes']) &&
    record['maxBytes'] >= 0 &&
    typeof record['requireSecretScanClean'] === 'boolean' &&
    typeof record['allowLocalOnlyTaskRemote'] === 'boolean'
  )
    return {
      kind: 'provider-egress',
      providerIds: record['providerIds'] as string[],
      fragmentKinds: record['fragmentKinds'] as string[],
      maxBytes: record['maxBytes'],
      allowedProviderTrust: record['allowedProviderTrust'] as (
        'trusted-local' | 'trusted-remote' | 'untrusted-remote'
      )[],
      allowedResidencies: record['allowedResidencies'] as string[],
      allowedProvenance: record['allowedProvenance'] as (
        'system' | 'user' | 'workspace' | 'untrusted'
      )[],
      requireSecretScanClean: record['requireSecretScanClean'],
      allowLocalOnlyTaskRemote: record['allowLocalOnlyTaskRemote'],
    };
  throw new Error('Invalid stored resource set');
}

function permissionRuleKey(input: {
  effect: 'allow' | 'immutable-deny';
  rule: PermissionRule;
}): string {
  return JSON.stringify([
    input.effect,
    input.rule.capability,
    input.rule.resourceSet,
    [...input.rule.operations],
    input.rule.auditReason ?? null,
  ]);
}
