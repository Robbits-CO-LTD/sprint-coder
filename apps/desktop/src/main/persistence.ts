import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chatMessageSchema,
  approvalSummarySchema,
  commandSummarySchema,
  taskSummarySchema,
  turnEventSchema,
  turnSnapshotSchema,
  type ChatMessage,
  type ApprovalDecision,
  type AutoPermissionDecision,
  type ApprovalState,
  type ApprovalSummary,
  type CommandState,
  type CommandSummary,
  type CommandOutputPage,
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
  type ExecutionSpec,
  executionSpecDigest,
  backgroundDeliveryId,
  backgroundEpochMismatch,
  transitionBackgroundActivity,
  type BackgroundActivityKind,
  type BackgroundActivityState,
  type BackgroundCompletionState,
  type BackgroundEpochs,
  type BackgroundWakePolicy,
} from '@vibe/domain';
import {
  ContextLedger,
  defaultContextUsage,
  estimateTokens,
  type ContextFragment,
  type ContextLedgerState,
  type PersistedFragment,
  type PreparedContext,
} from './context-ledger';
import { redactSecrets } from './secret-redactor';
import { sanitizeTerminalOutput } from './ansi-sanitizer';

type TaskRow = {
  id: string;
  title: string;
  pinned: number;
  archived: number;
  goal: string | null;
  workspace_path: string | null;
  draft: string;
  branch_epoch: number;
  context_epoch: number;
  created_at: string;
  updated_at: string;
};
type BackgroundActivityRow = {
  id: string;
  task_id: string;
  owner_thread_id: string;
  owner_turn_id: string;
  origin_worker_id: string | null;
  kind: BackgroundActivityKind;
  state: BackgroundActivityState;
  wake_policy: BackgroundWakePolicy;
  required_capabilities_json: string;
  branch_epoch: number;
  policy_epoch: number;
  context_epoch: number;
  heartbeat_at: string | null;
  output_cursor: number;
  volume_quota_bytes: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};
type BackgroundCompletionRow = {
  completion_id: string;
  delivery_id: string;
  activity_id: string;
  task_id: string;
  owner_thread_id: string;
  owner_turn_id: string;
  branch_epoch: number;
  policy_epoch: number;
  context_epoch: number;
  wake_policy: BackgroundWakePolicy;
  outcome: 'completed' | 'failed';
  payload: string;
  payload_digest: string;
  output_cursor: number;
  state: BackgroundCompletionState;
  target_turn_id: string | null;
  fragment_id: string;
  quarantine_reason: string | null;
  created_at: string;
  attached_at: string | null;
  runtime_acked_at: string | null;
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
  runtime_kind: RuntimeKind;
  model: string;
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
type ApprovalRow = {
  id: string;
  task_id: string;
  turn_id: string;
  item_id: string;
  call_id: string;
  runtime_call_id: string;
  runtime_instance_id: string;
  subject_id: string;
  provider_name: string;
  tool_id: string;
  tool_catalog_digest: string;
  schema_digest: string;
  spec_digest: string;
  policy_epoch: number;
  capability: Capability;
  resource_json: string;
  operation: PermissionOperation;
  provider_egress: ProviderEgress;
  sandbox_profile: SandboxProfile;
  risk: 'low' | 'medium' | 'high';
  reason_untrusted: string;
  display_json: string;
  state: ApprovalState;
  decision: ApprovalDecision | null;
  challenge_digest: string;
  revision: number;
  expires_at: string;
  requested_at: string;
  resolved_at: string | null;
  decision_operation_id: string | null;
};
type CommandRow = {
  id: string;
  task_id: string;
  turn_id: string;
  call_id: string;
  spec_json: string;
  spec_digest: string;
  purpose: string;
  risk: 'low' | 'medium' | 'high';
  state: CommandState;
  pid: number | null;
  process_start_time: string | null;
  exit_code: number | null;
  signal: string | null;
  output_bytes: number;
  truncated: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
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
  {
    version: 12,
    checksum: 'approvals-v12-lifecycle-binding-grants',
    sql: `
      DROP INDEX turns_one_active_per_task;
      CREATE UNIQUE INDEX turns_one_active_per_task ON turns(task_id)
        WHERE state IN (
          'queued', 'understanding', 'planning', 'executing', 'waiting_approval',
          'blocked', 'synthesizing', 'canceling'
        );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        tool_catalog_digest TEXT NOT NULL CHECK (length(tool_catalog_digest) = 64),
        schema_digest TEXT NOT NULL CHECK (length(schema_digest) = 64),
        spec_digest TEXT NOT NULL CHECK (length(spec_digest) = 64),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        capability TEXT NOT NULL,
        resource_json TEXT NOT NULL,
        operation TEXT NOT NULL,
        provider_egress TEXT NOT NULL,
        sandbox_profile TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
        reason_untrusted TEXT NOT NULL,
        display_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'canceled', 'stale', 'expired')),
        decision TEXT CHECK (decision IN ('allow_once', 'allow_task', 'deny')),
        challenge_digest TEXT NOT NULL CHECK (length(challenge_digest) = 64),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        expires_at TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        decision_operation_id TEXT,
        UNIQUE(turn_id, call_id)
      );
      CREATE INDEX approvals_task_pending_idx ON approvals(task_id, state, requested_at, id);
      ALTER TABLE permission_one_time_permits ADD COLUMN approval_id TEXT REFERENCES approvals(id);
      ALTER TABLE permission_one_time_permits ADD COLUMN request_digest TEXT;
      ALTER TABLE permission_one_time_permits ADD COLUMN spec_digest TEXT;
      ALTER TABLE permission_one_time_permits ADD COLUMN turn_id TEXT;
      ALTER TABLE permission_one_time_permits ADD COLUMN call_id TEXT;
      ALTER TABLE permission_one_time_permits ADD COLUMN subject_id TEXT;
    `,
  },
  {
    version: 13,
    checksum: 'approvals-v13-capability-requirement-key',
    sql: `
      ALTER TABLE approvals ADD COLUMN runtime_call_id TEXT;
      UPDATE approvals SET runtime_call_id = call_id WHERE runtime_call_id IS NULL;
      CREATE INDEX approvals_runtime_call_capability_idx
        ON approvals(turn_id, runtime_call_id, capability);
    `,
  },
  {
    version: 14,
    checksum: 'commands-v14-runs-sequenced-output',
    sql: `
      CREATE TABLE command_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        spec_digest TEXT NOT NULL CHECK (length(spec_digest) = 64),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'starting', 'running', 'exited', 'canceled', 'failed', 'interrupted'
        )),
        pid INTEGER,
        process_start_time TEXT,
        exit_code INTEGER,
        signal TEXT,
        output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(turn_id, call_id)
      );
      CREATE INDEX command_runs_task_created_idx ON command_runs(task_id, created_at, id);
      CREATE TABLE command_output_chunks (
        command_id TEXT NOT NULL REFERENCES command_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
        text TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 65536),
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY(command_id, seq)
      );
    `,
  },
  {
    version: 15,
    checksum: 'commands-v15-display-projection',
    sql: `
      ALTER TABLE command_runs
        ADD COLUMN purpose TEXT NOT NULL DEFAULT 'コマンドを実行します';
      ALTER TABLE command_runs
        ADD COLUMN risk TEXT NOT NULL DEFAULT 'high'
        CHECK (risk IN ('low', 'medium', 'high'));
    `,
  },
  {
    version: 16,
    checksum: 'permissions-v16-reviewer-permit-binding',
    sql: `
      ALTER TABLE permission_one_time_permits ADD COLUMN review_request_id TEXT;
      CREATE UNIQUE INDEX permission_one_time_permits_review_request_idx
        ON permission_one_time_permits(review_request_id)
        WHERE review_request_id IS NOT NULL;
      CREATE TABLE auto_permission_decisions (
        review_request_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('policy', 'narrow_allow', 'reviewer')),
        effective_decision TEXT NOT NULL CHECK (effective_decision IN ('allow', 'allow_once', 'deny')),
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
        model TEXT NOT NULL,
        template_version TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
        execution_spec_digest TEXT NOT NULL CHECK (length(execution_spec_digest) = 64),
        input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(task_id, turn_id, call_id, capability)
      );
    `,
  },
  {
    version: 17,
    checksum: 'background-v17-durable-completion-delivery',
    sql: `
      ALTER TABLE tasks ADD COLUMN branch_epoch INTEGER NOT NULL DEFAULT 0 CHECK (branch_epoch >= 0);
      ALTER TABLE tasks ADD COLUMN context_epoch INTEGER NOT NULL DEFAULT 0 CHECK (context_epoch >= 0);
      CREATE TABLE background_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        owner_thread_id TEXT NOT NULL,
        owner_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        origin_worker_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('command', 'monitor', 'scheduler')),
        state TEXT NOT NULL CHECK (state IN ('registered', 'running', 'completed', 'failed', 'canceled')),
        wake_policy TEXT NOT NULL CHECK (wake_policy IN ('immediate', 'nextSafePoint', 'manual')),
        required_capabilities_json TEXT NOT NULL,
        branch_epoch INTEGER NOT NULL CHECK (branch_epoch >= 0),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        context_epoch INTEGER NOT NULL CHECK (context_epoch >= 0),
        heartbeat_at TEXT,
        output_cursor INTEGER NOT NULL DEFAULT 0 CHECK (output_cursor >= 0),
        volume_quota_bytes INTEGER NOT NULL CHECK (volume_quota_bytes > 0 AND volume_quota_bytes <= 1048576),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX background_activities_task_state_idx
        ON background_activities(task_id, state, created_at, id);
      CREATE TABLE background_completions (
        completion_id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE CHECK (length(delivery_id) = 64),
        activity_id TEXT NOT NULL REFERENCES background_activities(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        owner_thread_id TEXT NOT NULL,
        owner_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        branch_epoch INTEGER NOT NULL CHECK (branch_epoch >= 0),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        context_epoch INTEGER NOT NULL CHECK (context_epoch >= 0),
        wake_policy TEXT NOT NULL CHECK (wake_policy IN ('immediate', 'nextSafePoint', 'manual')),
        outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
        payload TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
        output_cursor INTEGER NOT NULL CHECK (output_cursor >= 0),
        state TEXT NOT NULL CHECK (state IN ('persisted', 'attached', 'runtimeAcked', 'quarantined')),
        target_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        fragment_id TEXT NOT NULL UNIQUE,
        quarantine_reason TEXT,
        created_at TEXT NOT NULL,
        attached_at TEXT,
        runtime_acked_at TEXT
      );
      CREATE INDEX background_completions_delivery_idx
        ON background_completions(task_id, state, wake_policy, created_at, completion_id);
    `,
  },
  {
    version: 18,
    checksum: 'runtime-v18-turn-model-snapshot',
    sql: `
      ALTER TABLE turns ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'mock'
        CHECK (runtime_kind IN ('mock', 'codex'));
      ALTER TABLE turns ADD COLUMN model TEXT NOT NULL DEFAULT 'auto';
    `,
  },
];

export type ApprovalRequestInput = {
  id: string;
  taskId: string;
  turnId: string;
  itemId: string;
  callId: string;
  runtimeInstanceId: string;
  subjectId: string;
  providerName: string;
  toolId: string;
  toolCatalogDigest: string;
  schemaDigest: string;
  specDigest: string;
  policyEpoch: number;
  capability: Capability;
  resource: ResourceSet;
  operation: PermissionOperation;
  providerEgress: ProviderEgress;
  sandboxProfile: SandboxProfile;
  risk: 'low' | 'medium' | 'high';
  reasonUntrusted: string;
  display: { target: string; impact: string; execution: string };
  challenge: string;
  expiresAt: string;
  requestedAt: string;
};

export type PersistedApproval = ApprovalSummary & {
  itemId: string;
  runtimeInstanceId: string;
  subjectId: string;
  toolId: string;
  toolCatalogDigest: string;
  schemaDigest: string;
  specDigest: string;
  resource: ResourceSet;
  operation: PermissionOperation;
  providerEgress: ProviderEgress;
  sandboxProfile: SandboxProfile;
};

export type ApprovalResolutionInput = {
  taskId: string;
  approvalId: string;
  expectedTurnId: string;
  expectedRevision: number;
  challenge: string;
  decision: ApprovalDecision;
  operationId: string;
  decidedAt: string;
  grantExpiresAt?: string;
};

export type ApprovalPersistenceResult = {
  approval: PersistedApproval;
  event: TurnEvent;
  oneTimePermitToken?: string;
};

export type CommandOutputRecord = Readonly<{
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  byteLength: number;
}>;

export type PermissionPolicyRecord = {
  preset: AccessPreset;
  policyEpoch: number;
  expandedPolicy: ExpandedAccessPolicy;
  revokedCapabilities: Capability[];
};

export type StartedTurn = {
  turnId: string;
  text: string;
  runtimeKind: RuntimeKind;
  model: string;
  event: TurnEvent;
};
export type QueueTransition = { started: StartedTurn; queueEvent: TurnEvent } | null;
export type BackgroundActivityRecord = Readonly<{
  id: string;
  taskId: string;
  ownerThreadId: string;
  ownerTurnId: string;
  originWorkerId: string | null;
  kind: BackgroundActivityKind;
  state: BackgroundActivityState;
  wakePolicy: BackgroundWakePolicy;
  requiredCapabilities: Capability[];
  epochs: BackgroundEpochs;
  heartbeatAt: string | null;
  outputCursor: number;
  volumeQuotaBytes: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}>;
export type BackgroundCompletionRecord = Readonly<{
  completionId: string;
  deliveryId: string;
  activityId: string;
  taskId: string;
  ownerThreadId: string;
  ownerTurnId: string;
  epochs: BackgroundEpochs;
  wakePolicy: BackgroundWakePolicy;
  outcome: 'completed' | 'failed';
  payload: string;
  outputCursor: number;
  state: BackgroundCompletionState;
  targetTurnId: string | null;
  fragmentId: string;
  quarantineReason: string | null;
  createdAt: string;
  attachedAt: string | null;
  runtimeAckedAt: string | null;
}>;

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
    binding?: {
      reviewRequestId: string;
      turnId: string;
      callId: string;
      subjectId: string;
      specDigest: string;
    },
  ): void;
  consumePermissionOneTimeToken(
    taskId: string,
    token: string,
    policyEpoch: number,
    now: string,
    binding?: {
      approvalId?: string;
      reviewRequestId?: string;
      turnId: string;
      callId: string;
      subjectId: string;
      specDigest: string;
    },
  ): boolean;
  recordPermissionAudit(
    taskId: string,
    request: PermissionRequest,
    evaluation: PermissionEvaluation,
  ): void;
  commitPermissionEvaluation(
    taskId: string,
    request: PermissionRequest,
    evaluation: PermissionEvaluation,
    autoDecision?: AutoPermissionDecision,
  ): TurnEvent | undefined;
  requestApproval(input: ApprovalRequestInput): ApprovalPersistenceResult;
  listPendingApprovals(taskId: string): PersistedApproval[];
  listRecentApprovals(taskId: string, limit?: number): PersistedApproval[];
  getApproval(taskId: string, approvalId: string): PersistedApproval;
  resolveApproval(input: ApprovalResolutionInput): ApprovalPersistenceResult;
  invalidatePendingApprovalsForTask(
    taskId: string,
    policyEpoch: number,
    invalidatedAt: string,
  ): ApprovalPersistenceResult[];
  prepareCommand(input: {
    id: string;
    taskId: string;
    turnId: string;
    callId: string;
    spec: ExecutionSpec;
    purpose: string;
    risk: 'low' | 'medium' | 'high';
    createdAt: string;
  }): CommandSummary;
  startCommand(input: {
    commandId: string;
    pid: number;
    processStartTime: string;
    startedAt: string;
  }): { command: CommandSummary; event: TurnEvent };
  beginCommand(commandId: string): CommandSummary;
  appendCommandOutput(input: {
    commandId: string;
    seq: number;
    stream: 'stdout' | 'stderr';
    text: string;
    byteLength: number;
    createdAt: string;
  }): TurnEvent;
  appendCommandOutputBatch(input: {
    commandId: string;
    chunks: readonly {
      seq: number;
      stream: 'stdout' | 'stderr';
      text: string;
      byteLength: number;
    }[];
    createdAt: string;
  }): TurnEvent[];
  completeCommand(input: {
    commandId: string;
    state: Extract<CommandState, 'exited' | 'canceled' | 'failed'>;
    exitCode: number | null;
    signal: string | null;
    outputBytes: number;
    truncated: boolean;
    finishedAt: string;
  }): { command: CommandSummary; event: TurnEvent };
  getCommand(commandId: string): CommandSummary;
  listCommands(taskId: string): CommandSummary[];
  listCommandOutput(
    commandId: string,
    afterSeq?: number,
    limit?: number,
    maxBytes?: number,
  ): CommandOutputRecord[];
  commandOutputPage(input: {
    taskId: string;
    commandId: string;
    afterSeq: number;
    limit: number;
    maxBytes: number;
  }): CommandOutputPage;
  commandOutputTail(input: {
    taskId: string;
    commandId: string;
    maxBytes: number;
  }): CommandOutputPage;
  listAutoPermissionDecisions(taskId: string): AutoPermissionDecision[];
  getBackgroundEpochs(taskId: string): BackgroundEpochs;
  createBackgroundActivity(input: {
    id: string;
    taskId: string;
    ownerThreadId: string;
    ownerTurnId: string;
    originWorkerId?: string;
    kind: BackgroundActivityKind;
    wakePolicy: BackgroundWakePolicy;
    requiredCapabilities: Capability[];
    volumeQuotaBytes: number;
    createdAt: string;
  }): BackgroundActivityRecord;
  transitionBackgroundActivity(
    activityId: string,
    state: Extract<BackgroundActivityState, 'running' | 'canceled'>,
    occurredAt: string,
  ): BackgroundActivityRecord;
  completeBackgroundActivity(input: {
    activityId: string;
    completionId: string;
    outcome: 'completed' | 'failed';
    payload: string;
    outputCursor: number;
    completedAt: string;
  }): BackgroundCompletionRecord;
  releaseBackgroundCompletion(completionId: string): BackgroundCompletionRecord;
  listBackgroundCompletions(taskId: string): BackgroundCompletionRecord[];
  acknowledgeBackgroundFragments(
    taskId: string,
    turnId: string,
    fragmentIds: readonly string[],
  ): TurnEvent[];
  quarantineBackgroundForPolicyEpoch(taskId: string, policyEpoch: number, now: string): number;
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
    this.interruptActiveCommands();
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
    if (!archived) return this.updateTask(taskId, 'archived', 0);
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE tasks SET archived = 1, branch_epoch = branch_epoch + 1,
             context_epoch = context_epoch + 1, updated_at = ? WHERE id = ?`,
        )
        .run(new Date().toISOString(), taskId);
      if (result.changes !== 1) throw new NotFoundError('Task not found');
      this.quarantineStaleBackgroundInTransaction(taskId);
      return toTask(this.getTaskRow(taskId));
    })();
  }
  setGoal(taskId: string, goal: string): TaskSummary {
    return this.db.transaction(() => {
      const current = this.getTaskRow(taskId);
      const result = this.db
        .prepare(
          `UPDATE tasks SET goal = ?, context_epoch = context_epoch + ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(goal, current.goal === goal ? 0 : 1, new Date().toISOString(), taskId);
      if (result.changes !== 1) throw new NotFoundError('Task not found');
      this.quarantineStaleBackgroundInTransaction(taskId);
      return toTask(this.getTaskRow(taskId));
    })();
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
    this.db.transaction(() => {
      const current = this.getTaskRow(taskId);
      const result = this.db
        .prepare(
          `UPDATE tasks SET workspace_path = ?, context_epoch = context_epoch + ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(path, current.workspace_path === path ? 0 : 1, new Date().toISOString(), taskId);
      if (result.changes !== 1) throw new NotFoundError('Task not found');
      this.quarantineStaleBackgroundInTransaction(taskId);
    })();
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

  getBackgroundEpochs(taskId: string): BackgroundEpochs {
    const task = this.getTaskRow(taskId);
    return {
      branchEpoch: task.branch_epoch,
      policyEpoch: this.getPermissionPolicy(taskId).policyEpoch,
      contextEpoch: task.context_epoch,
    };
  }

  createBackgroundActivity(input: {
    id: string;
    taskId: string;
    ownerThreadId: string;
    ownerTurnId: string;
    originWorkerId?: string;
    kind: BackgroundActivityKind;
    wakePolicy: BackgroundWakePolicy;
    requiredCapabilities: Capability[];
    volumeQuotaBytes: number;
    createdAt: string;
  }): BackgroundActivityRecord {
    return this.db.transaction(() => {
      if (input.id.length < 1 || input.id.length > 128) throw new Error('Invalid activity id');
      if (input.ownerThreadId.length < 1 || input.ownerThreadId.length > 128)
        throw new Error('Invalid owner thread id');
      this.getTurn(input.taskId, input.ownerTurnId);
      if (
        !Number.isInteger(input.volumeQuotaBytes) ||
        input.volumeQuotaBytes < 1 ||
        input.volumeQuotaBytes > 1_048_576
      )
        throw new Error('Invalid background volume quota');
      const uniqueCapabilities = [...new Set(input.requiredCapabilities)];
      if (
        uniqueCapabilities.length !== input.requiredCapabilities.length ||
        uniqueCapabilities.some((capability) => !capabilities.includes(capability))
      )
        throw new Error('Invalid background capabilities');
      const epochs = this.getBackgroundEpochs(input.taskId);
      this.db
        .prepare(
          `INSERT INTO background_activities(
            id, task_id, owner_thread_id, owner_turn_id, origin_worker_id, kind, state,
            wake_policy, required_capabilities_json, branch_epoch, policy_epoch, context_epoch,
            volume_quota_bytes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.taskId,
          input.ownerThreadId,
          input.ownerTurnId,
          input.originWorkerId ?? null,
          input.kind,
          input.wakePolicy,
          JSON.stringify(uniqueCapabilities),
          epochs.branchEpoch,
          epochs.policyEpoch,
          epochs.contextEpoch,
          input.volumeQuotaBytes,
          input.createdAt,
        );
      return this.backgroundActivity(input.id);
    })();
  }

  transitionBackgroundActivity(
    activityId: string,
    state: Extract<BackgroundActivityState, 'running' | 'canceled'>,
    occurredAt: string,
  ): BackgroundActivityRecord {
    return this.db.transaction(() => {
      const current = this.backgroundActivityRow(activityId);
      transitionBackgroundActivity(current.state, state);
      const result = this.db
        .prepare(
          `UPDATE background_activities
           SET state = ?, started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
             finished_at = CASE WHEN ? = 'canceled' THEN ? ELSE finished_at END
           WHERE id = ? AND state = ?`,
        )
        .run(state, state, occurredAt, state, occurredAt, activityId, current.state);
      if (result.changes !== 1) throw new Error('Background activity transition conflict');
      return this.backgroundActivity(activityId);
    })();
  }

  completeBackgroundActivity(input: {
    activityId: string;
    completionId: string;
    outcome: 'completed' | 'failed';
    payload: string;
    outputCursor: number;
    completedAt: string;
  }): BackgroundCompletionRecord {
    return this.db.transaction(() => {
      if (Buffer.byteLength(input.payload, 'utf8') > 1_048_576)
        throw new Error('Background completion input exceeds the ingestion limit');
      const redactedPayload = redactSecrets(sanitizeTerminalOutput(input.payload));
      const payloadBytes = Buffer.byteLength(redactedPayload, 'utf8');
      const payloadDigest = sha256(redactedPayload);
      const replay = this.backgroundCompletionRow(input.completionId);
      if (replay !== undefined) {
        if (
          replay.activity_id !== input.activityId ||
          replay.outcome !== input.outcome ||
          replay.payload_digest !== payloadDigest ||
          replay.payload !== redactedPayload ||
          replay.output_cursor !== input.outputCursor
        )
          throw new OperationConflictError();
        return toBackgroundCompletion(replay);
      }
      const activity = this.backgroundActivityRow(input.activityId);
      if (activity.state !== 'running') throw new Error('Background activity is not running');
      if (payloadBytes < 1 || payloadBytes > Math.min(activity.volume_quota_bytes, 29_000))
        throw new Error('Background completion exceeds its bounded fragment quota');
      if (!Number.isInteger(input.outputCursor) || input.outputCursor < activity.output_cursor)
        throw new Error('Invalid background output cursor');
      const terminalState = input.outcome === 'completed' ? 'completed' : 'failed';
      transitionBackgroundActivity(activity.state, terminalState);
      const deliveryId = backgroundDeliveryId({
        completionId: input.completionId,
        activityId: activity.id,
        ownerThreadId: activity.owner_thread_id,
      });
      this.db
        .prepare(
          `UPDATE background_activities SET state = ?, output_cursor = ?, finished_at = ?
           WHERE id = ? AND state = 'running'`,
        )
        .run(terminalState, input.outputCursor, input.completedAt, input.activityId);
      this.db
        .prepare(
          `INSERT INTO background_completions(
            completion_id, delivery_id, activity_id, task_id, owner_thread_id, owner_turn_id,
            branch_epoch, policy_epoch, context_epoch, wake_policy, outcome, payload,
            payload_digest, output_cursor, state, fragment_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'persisted', ?, ?)`,
        )
        .run(
          input.completionId,
          deliveryId,
          activity.id,
          activity.task_id,
          activity.owner_thread_id,
          activity.owner_turn_id,
          activity.branch_epoch,
          activity.policy_epoch,
          activity.context_epoch,
          activity.wake_policy,
          input.outcome,
          redactedPayload,
          payloadDigest,
          input.outputCursor,
          input.completionId,
          input.completedAt,
        );
      return toBackgroundCompletion(this.requireBackgroundCompletionRow(input.completionId));
    })();
  }

  releaseBackgroundCompletion(completionId: string): BackgroundCompletionRecord {
    return this.db.transaction(() => {
      const row = this.requireBackgroundCompletionRow(completionId);
      if (row.state === 'persisted' && row.wake_policy === 'manual')
        this.db
          .prepare(
            `UPDATE background_completions SET wake_policy = 'nextSafePoint'
             WHERE completion_id = ? AND state = 'persisted' AND wake_policy = 'manual'`,
          )
          .run(completionId);
      return toBackgroundCompletion(this.requireBackgroundCompletionRow(completionId));
    })();
  }

  listBackgroundCompletions(taskId: string): BackgroundCompletionRecord[] {
    this.assertTask(taskId);
    return (
      this.db
        .prepare(
          'SELECT * FROM background_completions WHERE task_id = ? ORDER BY created_at, rowid',
        )
        .all(taskId) as BackgroundCompletionRow[]
    ).map(toBackgroundCompletion);
  }

  quarantineBackgroundForPolicyEpoch(taskId: string, policyEpoch: number, now: string): number {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      if (!Number.isInteger(policyEpoch) || policyEpoch < 0)
        throw new Error('Invalid policy epoch');
      this.db
        .prepare(
          `UPDATE background_activities SET state = 'canceled', finished_at = ?
           WHERE task_id = ? AND policy_epoch <> ? AND state IN ('registered', 'running')`,
        )
        .run(now, taskId, policyEpoch);
      return this.db
        .prepare(
          `UPDATE background_completions
           SET state = 'quarantined', quarantine_reason = 'policy_epoch_changed'
           WHERE task_id = ? AND policy_epoch <> ? AND state IN ('persisted', 'attached')`,
        )
        .run(taskId, policyEpoch).changes;
    })();
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
    binding?: {
      reviewRequestId: string;
      turnId: string;
      callId: string;
      subjectId: string;
      specDigest: string;
    },
  ): void {
    this.assertTask(taskId);
    const inserted = this.db
      .prepare(
        `INSERT INTO permission_one_time_permits(
          token_hash, task_id, policy_epoch, expires_at, consumed_at, created_at,
          review_request_id, turn_id, call_id, subject_id, spec_digest
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO NOTHING`,
      )
      .run(
        createHash('sha256').update(token).digest('hex'),
        taskId,
        policyEpoch,
        new Date(expiresAt).toISOString(),
        new Date().toISOString(),
        binding?.reviewRequestId ?? null,
        binding?.turnId ?? null,
        binding?.callId ?? null,
        binding?.subjectId ?? null,
        binding?.specDigest ?? null,
      );
    if (binding !== undefined && inserted.changes !== 1)
      throw new Error('Reviewer one-time permit already exists');
  }

  requestApproval(input: ApprovalRequestInput): ApprovalPersistenceResult {
    return this.db.transaction(() => {
      validateApprovalRequest(input);
      const duplicate = this.db
        .prepare(
          'SELECT * FROM approvals WHERE turn_id = ? AND runtime_call_id = ? AND capability = ?',
        )
        .get(input.turnId, input.callId, input.capability) as ApprovalRow | undefined;
      if (duplicate !== undefined) {
        const existingChallenge = this.challengeForApproval(duplicate.task_id, duplicate.id);
        const existing = this.toPersistedApproval(duplicate, existingChallenge);
        if (approvalRequestDigest(input) !== persistedApprovalRequestDigest(existing))
          throw new OperationConflictError();
        const event = this.findApprovalEvent(input.taskId, duplicate.id, 'approval.requested');
        return { approval: existing, event };
      }
      const turn = this.getTurn(input.taskId, input.turnId);
      if (turn.state !== 'executing' && turn.state !== 'planning')
        throw new Error('Turn is not eligible to request approval');
      if (this.getPermissionPolicy(input.taskId).policyEpoch !== input.policyEpoch)
        throw new Error('Approval policy epoch is stale');
      this.db
        .prepare(
          `INSERT INTO approvals(
            id, task_id, turn_id, item_id, call_id, runtime_instance_id, subject_id,
            provider_name, tool_id, tool_catalog_digest, schema_digest, spec_digest,
            policy_epoch, capability, resource_json, operation, provider_egress,
            sandbox_profile, risk, reason_untrusted, display_json, state, decision,
            challenge_digest, revision, expires_at, requested_at, resolved_at,
            decision_operation_id, runtime_call_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'pending', NULL, ?, 0, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          input.id,
          input.taskId,
          input.turnId,
          input.itemId,
          approvalStorageCallId(input.callId, input.capability),
          input.runtimeInstanceId,
          input.subjectId,
          input.providerName,
          input.toolId,
          input.toolCatalogDigest,
          input.schemaDigest,
          input.specDigest,
          input.policyEpoch,
          input.capability,
          JSON.stringify(input.resource),
          input.operation,
          input.providerEgress,
          input.sandboxProfile,
          input.risk,
          sanitizeApprovalText(input.reasonUntrusted, 500),
          JSON.stringify({
            target: sanitizeApprovalText(input.display.target, 500),
            impact: sanitizeApprovalText(input.display.impact, 500),
            execution: sanitizeApprovalText(input.display.execution, 100_000),
          }),
          sha256(input.challenge),
          new Date(input.expiresAt).toISOString(),
          new Date(input.requestedAt).toISOString(),
          input.callId,
        );
      transitionTurn(turn.state, 'waiting_approval');
      this.updateTurn(input.turnId, 'waiting_approval');
      const approval = this.getApprovalWithChallenge(input.taskId, input.id, input.challenge);
      const event = this.appendEvent({
        type: 'approval.requested',
        taskId: input.taskId,
        turnId: input.turnId,
        approvalId: input.id,
        approval: toApprovalSummary(approval),
      });
      return { approval, event };
    })();
  }

  listPendingApprovals(taskId: string): PersistedApproval[] {
    this.assertTask(taskId);
    return (
      this.db
        .prepare(
          "SELECT * FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY requested_at, id",
        )
        .all(taskId) as ApprovalRow[]
    ).map((row) => this.toPersistedApproval(row, this.challengeForApproval(taskId, row.id)));
  }

  listRecentApprovals(taskId: string, limit = 200): PersistedApproval[] {
    this.assertTask(taskId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid approval history limit');
    return (
      this.db
        .prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY requested_at DESC, id LIMIT ?')
        .all(taskId, limit) as ApprovalRow[]
    )
      .reverse()
      .map((row) => this.toPersistedApproval(row, this.challengeForApproval(taskId, row.id)));
  }

  getApproval(taskId: string, approvalId: string): PersistedApproval {
    const row = this.getApprovalRow(approvalId);
    if (row.task_id !== taskId) throw new Error('Approval does not belong to this Task');
    return this.toPersistedApproval(row, this.challengeForApproval(taskId, approvalId));
  }

  resolveApproval(input: ApprovalResolutionInput): ApprovalPersistenceResult {
    const requestHash = sha256(JSON.stringify(input));
    const cached = this.getOperationResult<ApprovalPersistenceResult>(
      'approval',
      input.taskId,
      'approval.resolve',
      input.operationId,
      requestHash,
    );
    if (cached.found) return cached.value!;
    return this.executeOperation(
      'approval',
      input.taskId,
      'approval.resolve',
      input.operationId,
      requestHash,
      () => this.resolveApprovalInTransaction(input),
    );
  }

  invalidatePendingApprovalsForTask(
    taskId: string,
    policyEpoch: number,
    invalidatedAt: string,
  ): ApprovalPersistenceResult[] {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      const at = new Date(invalidatedAt).toISOString();
      const rows = this.db
        .prepare(
          "SELECT * FROM approvals WHERE task_id = ? AND state = 'pending' AND policy_epoch <> ? ORDER BY requested_at, id",
        )
        .all(taskId, policyEpoch) as ApprovalRow[];
      const results: ApprovalPersistenceResult[] = [];
      for (const row of rows) {
        const updated = this.db
          .prepare(
            `UPDATE approvals SET state = 'stale', decision = NULL, revision = revision + 1,
              resolved_at = ? WHERE id = ? AND state = 'pending' AND revision = ?`,
          )
          .run(at, row.id, row.revision);
        if (updated.changes !== 1) continue;
        this.resumeTurnAfterApproval(row.task_id, row.turn_id);
        const approval = this.getApprovalWithChallenge(
          row.task_id,
          row.id,
          this.challengeForApproval(row.task_id, row.id),
        );
        const event = this.appendEvent({
          type: 'approval.stale',
          taskId: row.task_id,
          turnId: row.turn_id,
          approvalId: row.id,
          approval: toApprovalAuditSummary(approval),
        });
        results.push({ approval, event });
      }
      return results;
    })();
  }

  private resolveApprovalInTransaction(input: ApprovalResolutionInput): ApprovalPersistenceResult {
    const row = this.getApprovalRow(input.approvalId);
    if (row.task_id !== input.taskId) throw new Error('Approval does not belong to this Task');
    if (row.turn_id !== input.expectedTurnId) throw new Error('Approval Turn changed');
    if (row.state === 'resolved') throw new Error('Approval is already resolved');
    if (row.state !== 'pending') throw new Error('Approval is no longer pending');
    if (row.revision !== input.expectedRevision) throw new Error('Approval revision changed');
    if (!timingSafeDigestEqual(row.challenge_digest, sha256(input.challenge)))
      throw new Error('Approval challenge mismatch');
    const decidedAt = new Date(input.decidedAt).toISOString();
    const currentEpoch = this.getPermissionPolicy(input.taskId).policyEpoch;
    const nextState: ApprovalState =
      Date.parse(row.expires_at) <= Date.parse(decidedAt)
        ? 'expired'
        : currentEpoch !== row.policy_epoch
          ? 'stale'
          : 'resolved';
    const decision = nextState === 'resolved' ? input.decision : null;
    const updated = this.db
      .prepare(
        `UPDATE approvals SET state = ?, decision = ?, revision = revision + 1,
          resolved_at = ?, decision_operation_id = ?
        WHERE id = ? AND state = 'pending' AND revision = ?`,
      )
      .run(
        nextState,
        decision,
        decidedAt,
        input.operationId,
        input.approvalId,
        input.expectedRevision,
      );
    if (updated.changes !== 1) throw new Error('Approval was resolved concurrently');

    let oneTimePermitToken: string | undefined;
    if (decision === 'allow_once') {
      oneTimePermitToken = `${randomUUID()}${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO permission_one_time_permits(
            token_hash, task_id, policy_epoch, expires_at, consumed_at, created_at,
            approval_id, request_digest, spec_digest, turn_id, call_id, subject_id
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sha256(oneTimePermitToken),
          input.taskId,
          row.policy_epoch,
          row.expires_at,
          decidedAt,
          row.id,
          approvalRowRequestDigest(row),
          row.spec_digest,
          row.turn_id,
          row.runtime_call_id,
          row.subject_id,
        );
    } else if (decision === 'allow_task') {
      const grantExpiresAt = new Date(input.grantExpiresAt ?? row.expires_at).toISOString();
      if (Date.parse(grantExpiresAt) <= Date.parse(decidedAt))
        throw new Error('Approval grant expiry must be in the future');
      this.savePermissionGrant(
        input.taskId,
        createSessionGrant({
          id: randomUUID(),
          subjectId: row.subject_id,
          capability: row.capability,
          resourceSet: parseResourceSet(row.resource_json),
          operations: [row.operation],
          scope: 'task',
          expiresAt: grantExpiresAt,
          policyEpoch: row.policy_epoch,
          providerEgress: [row.provider_egress],
          sandboxProfiles: [row.sandbox_profile],
          executionSpecDigest: row.spec_digest,
        }),
      );
    }

    this.resumeTurnAfterApproval(row.task_id, row.turn_id);
    const approval = this.getApprovalWithChallenge(row.task_id, row.id, input.challenge);
    const type = `approval.${nextState}` as
      'approval.resolved' | 'approval.stale' | 'approval.expired';
    const event =
      type === 'approval.resolved'
        ? this.appendEvent({
            type,
            taskId: row.task_id,
            turnId: row.turn_id,
            approvalId: row.id,
            decision: decision!,
            approval: toApprovalAuditSummary(approval),
          })
        : this.appendEvent({
            type,
            taskId: row.task_id,
            turnId: row.turn_id,
            approvalId: row.id,
            approval: toApprovalAuditSummary(approval),
          });
    return {
      approval,
      event,
      ...(oneTimePermitToken === undefined ? {} : { oneTimePermitToken }),
    };
  }

  consumePermissionOneTimeToken(
    taskId: string,
    token: string,
    policyEpoch: number,
    now: string,
    binding?: {
      approvalId?: string;
      reviewRequestId?: string;
      turnId: string;
      callId: string;
      subjectId: string;
      specDigest: string;
    },
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
      if (result.changes !== 1) return false;
      if (binding !== undefined) {
        const row = this.db
          .prepare(
            `SELECT approval_id, review_request_id, turn_id, call_id, subject_id, spec_digest
             FROM permission_one_time_permits WHERE token_hash = ?`,
          )
          .get(sha256(token)) as
          | {
              approval_id: string | null;
              review_request_id: string | null;
              turn_id: string | null;
              call_id: string | null;
              subject_id: string | null;
              spec_digest: string | null;
            }
          | undefined;
        if (
          row === undefined ||
          (binding.approvalId !== undefined && row.approval_id !== binding.approvalId) ||
          (binding.reviewRequestId !== undefined &&
            row.review_request_id !== binding.reviewRequestId) ||
          row.turn_id !== binding.turnId ||
          row.call_id !== binding.callId ||
          row.subject_id !== binding.subjectId ||
          row.spec_digest !== binding.specDigest
        )
          throw new Error('One-time permit binding mismatch');
      }
      return true;
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

  commitPermissionEvaluation(
    taskId: string,
    request: PermissionRequest,
    evaluation: PermissionEvaluation,
    autoDecision?: AutoPermissionDecision,
  ): TurnEvent | undefined {
    return this.db.transaction(() => {
      if (autoDecision !== undefined)
        this.db
          .prepare(
            `INSERT INTO auto_permission_decisions(
              review_request_id, task_id, turn_id, call_id, capability, source,
              effective_decision, outcome, reason, risk, model, template_version,
              request_fingerprint, execution_spec_digest, input_digest, policy_epoch, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            autoDecision.reviewRequestId,
            autoDecision.taskId,
            autoDecision.turnId,
            autoDecision.callId,
            autoDecision.capability,
            autoDecision.source,
            autoDecision.decision,
            autoDecision.outcome,
            autoDecision.reason,
            autoDecision.risk,
            autoDecision.model,
            autoDecision.templateVersion,
            autoDecision.requestFingerprint,
            autoDecision.executionSpecDigest,
            autoDecision.inputDigest,
            autoDecision.policyEpoch,
            autoDecision.createdAt,
          );
      if (
        evaluation.permit?.source === 'reviewer_allow_once' &&
        evaluation.permit.oneTimeToken !== undefined
      ) {
        const permit = evaluation.permit;
        if (
          permit.oneTimeToken === undefined ||
          permit.reviewRequestId === undefined ||
          permit.turnId === undefined ||
          permit.callId === undefined
        )
          throw new Error('Reviewer permit binding is incomplete');
        this.registerPermissionOneTimeToken(
          taskId,
          permit.oneTimeToken,
          permit.policyEpoch,
          permit.expiresAt,
          {
            reviewRequestId: permit.reviewRequestId,
            turnId: permit.turnId,
            callId: permit.callId,
            subjectId: permit.subjectId,
            specDigest: permit.executionSpecDigest,
          },
        );
      }
      this.recordPermissionAudit(taskId, request, evaluation);
      return autoDecision === undefined
        ? undefined
        : this.recordAutoPermissionDecision(autoDecision);
    })();
  }

  prepareCommand(input: {
    id: string;
    taskId: string;
    turnId: string;
    callId: string;
    spec: ExecutionSpec;
    purpose: string;
    risk: 'low' | 'medium' | 'high';
    createdAt: string;
  }): CommandSummary {
    const specDigest = executionSpecDigest(input.spec);
    const createdAt = new Date(input.createdAt).toISOString();
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM command_runs WHERE turn_id = ? AND call_id = ?')
        .get(input.turnId, input.callId) as CommandRow | undefined;
      if (existing !== undefined) {
        if (existing.spec_digest !== specDigest) throw new Error('Command callId spec conflict');
        return toCommandSummary(existing);
      }
      this.db
        .prepare(
          `INSERT INTO command_runs(
            id, task_id, turn_id, call_id, spec_json, spec_digest, purpose, risk, state,
            pid, process_start_time, exit_code, signal, output_bytes, truncated,
            created_at, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, NULL, NULL, 0, 0, ?, NULL, NULL)`,
        )
        .run(
          input.id,
          input.taskId,
          input.turnId,
          input.callId,
          JSON.stringify(input.spec),
          specDigest,
          sanitizeApprovalText(input.purpose, 500),
          input.risk,
          createdAt,
        );
      return this.getCommand(input.id);
    })();
  }

  beginCommand(commandId: string): CommandSummary {
    return this.db.transaction(() => {
      const updated = this.db
        .prepare("UPDATE command_runs SET state = 'starting' WHERE id = ? AND state = 'prepared'")
        .run(commandId);
      if (updated.changes !== 1) throw new Error('Command is not prepared');
      return this.getCommand(commandId);
    })();
  }

  startCommand(input: {
    commandId: string;
    pid: number;
    processStartTime: string;
    startedAt: string;
  }): { command: CommandSummary; event: TurnEvent } {
    return this.db.transaction(() => {
      const startedAt = new Date(input.startedAt).toISOString();
      const updated = this.db
        .prepare(
          `UPDATE command_runs SET state = 'running', pid = ?, process_start_time = ?, started_at = ?
           WHERE id = ? AND state = 'starting'`,
        )
        .run(input.pid, input.processStartTime, startedAt, input.commandId);
      if (updated.changes !== 1) throw new Error('Command is not starting');
      const command = this.getCommand(input.commandId);
      const event = this.appendEvent({
        type: 'command.started',
        taskId: command.taskId,
        turnId: command.turnId,
        command,
      });
      return { command, event };
    })();
  }

  appendCommandOutput(input: {
    commandId: string;
    seq: number;
    stream: 'stdout' | 'stderr';
    text: string;
    byteLength: number;
    createdAt: string;
  }): TurnEvent {
    return this.appendCommandOutputBatch({
      commandId: input.commandId,
      chunks: [input],
      createdAt: input.createdAt,
    })[0]!;
  }

  appendCommandOutputBatch(input: {
    commandId: string;
    chunks: readonly {
      seq: number;
      stream: 'stdout' | 'stderr';
      text: string;
      byteLength: number;
    }[];
    createdAt: string;
  }): TurnEvent[] {
    return this.db.transaction(() => {
      if (input.chunks.length === 0) return [];
      const row = this.commandRow(input.commandId);
      if (row.state !== 'running') throw new Error('Command is not running');
      let expected = (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM command_output_chunks WHERE command_id = ?',
          )
          .get(input.commandId) as { seq: number }
      ).seq;
      const createdAt = new Date(input.createdAt).toISOString();
      const insert = this.db.prepare(
        `INSERT INTO command_output_chunks(
          command_id, seq, stream, text, byte_length, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const events: TurnEvent[] = [];
      let totalBytes = 0;
      for (const chunk of input.chunks) {
        if (Buffer.byteLength(chunk.text) !== chunk.byteLength || chunk.byteLength > 65_536)
          throw new Error('Command output byte length mismatch');
        if (chunk.seq !== expected++) throw new Error('Command output sequence mismatch');
        insert.run(
          input.commandId,
          chunk.seq,
          chunk.stream,
          chunk.text,
          chunk.byteLength,
          sha256(chunk.text),
          createdAt,
        );
        totalBytes += chunk.byteLength;
        events.push(
          this.appendEvent({
            type: 'command.output',
            taskId: row.task_id,
            turnId: row.turn_id,
            commandId: row.id,
            outputSeq: chunk.seq,
            stream: chunk.stream,
            text: chunk.text,
            byteLength: chunk.byteLength,
          }),
        );
      }
      this.db
        .prepare('UPDATE command_runs SET output_bytes = output_bytes + ? WHERE id = ?')
        .run(totalBytes, input.commandId);
      return events;
    })();
  }

  completeCommand(input: {
    commandId: string;
    state: Extract<CommandState, 'exited' | 'canceled' | 'failed'>;
    exitCode: number | null;
    signal: string | null;
    outputBytes: number;
    truncated: boolean;
    finishedAt: string;
  }): { command: CommandSummary; event: TurnEvent } {
    return this.db.transaction(() => {
      const finishedAt = new Date(input.finishedAt).toISOString();
      const updated = this.db
        .prepare(
          `UPDATE command_runs SET state = ?, exit_code = ?, signal = ?, output_bytes = ?,
            truncated = ?, finished_at = ? WHERE id = ? AND state IN ('prepared', 'starting', 'running')`,
        )
        .run(
          input.state,
          input.exitCode,
          input.signal,
          input.outputBytes,
          input.truncated ? 1 : 0,
          finishedAt,
          input.commandId,
        );
      if (updated.changes !== 1) throw new Error('Command is not active');
      const command = this.getCommand(input.commandId);
      const event = this.appendEvent({
        type: 'command.completed',
        taskId: command.taskId,
        turnId: command.turnId,
        command,
      });
      return { command, event };
    })();
  }

  getCommand(commandId: string): CommandSummary {
    return toCommandSummary(this.commandRow(commandId));
  }

  listCommands(taskId: string): CommandSummary[] {
    this.assertTask(taskId);
    return (
      this.db
        .prepare('SELECT * FROM command_runs WHERE task_id = ? ORDER BY created_at, rowid')
        .all(taskId) as CommandRow[]
    ).map(toCommandSummary);
  }

  listCommandOutput(
    commandId: string,
    afterSeq = 0,
    limit = 200,
    maxBytes = 262_144,
  ): CommandOutputRecord[] {
    this.commandRow(commandId);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error('Invalid output cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid output limit');
    if (!Number.isInteger(maxBytes) || maxBytes < 65_536 || maxBytes > 1_048_576)
      throw new Error('Invalid output byte budget');
    return (
      this.db
        .prepare(
          `WITH candidates AS (
             SELECT seq, stream, text, byte_length, content_hash,
               SUM(byte_length) OVER (ORDER BY seq) AS running_bytes,
               ROW_NUMBER() OVER (ORDER BY seq) AS page_ordinal
             FROM command_output_chunks WHERE command_id = ? AND seq > ?
           )
           SELECT seq, stream, text, byte_length, content_hash FROM candidates
           WHERE running_bytes <= ? OR page_ordinal = 1
           ORDER BY seq LIMIT ?`,
        )
        .all(commandId, afterSeq, maxBytes, limit) as {
        seq: number;
        stream: 'stdout' | 'stderr';
        text: string;
        byte_length: number;
        content_hash: string;
      }[]
    ).map(toVerifiedCommandOutput);
  }

  commandOutputPage(input: {
    taskId: string;
    commandId: string;
    afterSeq: number;
    limit: number;
    maxBytes: number;
  }): CommandOutputPage {
    const command = this.getCommand(input.commandId);
    if (command.taskId !== input.taskId) throw new NotFoundError('Command not found');
    const items = this.listCommandOutput(
      input.commandId,
      input.afterSeq,
      input.limit,
      input.maxBytes,
    );
    const nextAfterSeq = items.at(-1)?.seq ?? input.afterSeq;
    const next = this.db
      .prepare(
        'SELECT 1 AS present FROM command_output_chunks WHERE command_id = ? AND seq > ? LIMIT 1',
      )
      .get(input.commandId, nextAfterSeq) as { present: number } | undefined;
    return {
      commandId: input.commandId,
      items,
      nextAfterSeq,
      eof: next === undefined,
      pageBytes: items.reduce((total, item) => total + item.byteLength, 0),
    };
  }

  commandOutputTail(input: {
    taskId: string;
    commandId: string;
    maxBytes: number;
  }): CommandOutputPage {
    const command = this.getCommand(input.commandId);
    if (command.taskId !== input.taskId) throw new NotFoundError('Command not found');
    if (!Number.isInteger(input.maxBytes) || input.maxBytes < 65_536 || input.maxBytes > 262_144)
      throw new Error('Invalid output byte budget');
    const items = (
      this.db
        .prepare(
          `WITH candidates AS (
             SELECT seq, stream, text, byte_length, content_hash,
               SUM(byte_length) OVER (ORDER BY seq DESC) AS running_bytes,
               ROW_NUMBER() OVER (ORDER BY seq DESC) AS page_ordinal
             FROM command_output_chunks WHERE command_id = ?
           )
           SELECT seq, stream, text, byte_length, content_hash FROM candidates
           WHERE running_bytes <= ? OR page_ordinal = 1
           ORDER BY seq`,
        )
        .all(input.commandId, input.maxBytes) as {
        seq: number;
        stream: 'stdout' | 'stderr';
        text: string;
        byte_length: number;
        content_hash: string;
      }[]
    ).map(toVerifiedCommandOutput);
    const firstSeq = items[0]?.seq;
    const hasEarlier =
      firstSeq === undefined
        ? false
        : (this.db
            .prepare(
              'SELECT 1 AS present FROM command_output_chunks WHERE command_id = ? AND seq < ? LIMIT 1',
            )
            .get(input.commandId, firstSeq) as { present: number } | undefined) !== undefined;
    return {
      commandId: input.commandId,
      items,
      nextAfterSeq: items.at(-1)?.seq ?? 0,
      eof: !hasEarlier,
      pageBytes: items.reduce((total, item) => total + item.byteLength, 0),
    };
  }

  private commandRow(commandId: string): CommandRow {
    const row = this.db.prepare('SELECT * FROM command_runs WHERE id = ?').get(commandId) as
      CommandRow | undefined;
    if (row === undefined) throw new NotFoundError('Command not found');
    return row;
  }

  private backgroundActivityRow(activityId: string): BackgroundActivityRow {
    const row = this.db
      .prepare('SELECT * FROM background_activities WHERE id = ?')
      .get(activityId) as BackgroundActivityRow | undefined;
    if (row === undefined) throw new NotFoundError('Background activity not found');
    return row;
  }

  private backgroundActivity(activityId: string): BackgroundActivityRecord {
    return toBackgroundActivity(this.backgroundActivityRow(activityId));
  }

  private backgroundCompletionRow(completionId: string): BackgroundCompletionRow | undefined {
    return this.db
      .prepare('SELECT * FROM background_completions WHERE completion_id = ?')
      .get(completionId) as BackgroundCompletionRow | undefined;
  }

  private requireBackgroundCompletionRow(completionId: string): BackgroundCompletionRow {
    const row = this.backgroundCompletionRow(completionId);
    if (row === undefined) throw new NotFoundError('Background completion not found');
    return row;
  }

  private interruptActiveCommands(): void {
    this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT id FROM command_runs WHERE state IN ('prepared', 'starting', 'running')")
        .all() as { id: string }[];
      const finishedAt = new Date().toISOString();
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE command_runs SET state = 'interrupted', finished_at = ?
             WHERE id = ? AND state IN ('prepared', 'starting', 'running')`,
          )
          .run(finishedAt, row.id);
        const command = this.getCommand(row.id);
        this.appendEvent({
          type: 'command.completed',
          taskId: command.taskId,
          turnId: command.turnId,
          command,
        });
      }
    })();
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
      ('queued', 'understanding', 'planning', 'executing', 'waiting_approval', 'blocked',
       'synthesizing', 'canceling') ORDER BY created_at DESC LIMIT 1`,
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
      ('queued', 'understanding', 'planning', 'executing', 'waiting_approval', 'blocked',
       'synthesizing', 'canceling') ORDER BY created_at DESC LIMIT 1`,
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
      pendingApprovals: this.listPendingApprovals(taskId).map(toApprovalSummary),
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

  private recordAutoPermissionDecision(decision: AutoPermissionDecision): TurnEvent {
    this.assertTask(decision.taskId);
    return this.appendEvent({
      type: 'permission.auto_decided',
      taskId: decision.taskId,
      turnId: decision.turnId,
      autoDecision: decision,
    });
  }

  listAutoPermissionDecisions(taskId: string): AutoPermissionDecision[] {
    this.assertTask(taskId);
    return (
      this.db
        .prepare(
          `SELECT payload_json FROM turn_events
           WHERE task_id = ? AND type = 'permission.auto_decided'
           ORDER BY seq DESC LIMIT 200`,
        )
        .all(taskId) as { payload_json: string }[]
    )
      .map((row) => turnEventSchema.parse(JSON.parse(row.payload_json)))
      .flatMap((event) => (event.type === 'permission.auto_decided' ? [event.autoDecision] : []))
      .reverse();
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
        ('queued', 'understanding', 'planning', 'executing', 'waiting_approval', 'blocked',
         'synthesizing', 'canceling')`,
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
    const runtimeKind = this.getRuntime();
    const model = this.getModel();
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
        `INSERT INTO turns(
          id, task_id, user_message_id, state, seq, runtime_kind, model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(turnId, taskId, userMessage.id, 'queued', runtimeKind, model, now, now);
    this.attachBackgroundCompletionsInTransaction(taskId, turnId, now);
    const event = this.appendEvent({ type: 'turn.accepted', taskId, turnId, userMessage });
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
    return { turnId, text, runtimeKind, model, event };
  }

  private attachBackgroundCompletionsInTransaction(
    taskId: string,
    targetTurnId: string,
    attachedAt: string,
  ): void {
    const currentEpochs = this.getBackgroundEpochs(taskId);
    const rows = this.db
      .prepare(
        `SELECT * FROM background_completions
         WHERE task_id = ? AND state IN ('persisted', 'attached')
         ORDER BY created_at, rowid`,
      )
      .all(taskId) as BackgroundCompletionRow[];
    let attachedBytes = 0;
    const maxBackgroundContextBytes = 24_000;
    for (const row of rows) {
      const mismatch = backgroundEpochMismatch(
        {
          branchEpoch: row.branch_epoch,
          policyEpoch: row.policy_epoch,
          contextEpoch: row.context_epoch,
        },
        currentEpochs,
      );
      if (mismatch !== null) {
        this.db
          .prepare(
            `UPDATE background_completions SET state = 'quarantined', quarantine_reason = ?
             WHERE completion_id = ? AND state = 'persisted'`,
          )
          .run(mismatch, row.completion_id);
        continue;
      }
      if (row.wake_policy === 'manual') continue;
      const bytes = Buffer.byteLength(row.payload, 'utf8');
      if (attachedBytes + bytes > maxBackgroundContextBytes) continue;
      const result = this.db
        .prepare(
          `UPDATE background_completions
           SET state = 'attached', target_turn_id = ?, attached_at = ?
           WHERE completion_id = ? AND state = 'persisted'`,
        )
        .run(targetTurnId, attachedAt, row.completion_id);
      if (result.changes === 1) attachedBytes += bytes;
    }
  }

  private quarantineStaleBackgroundInTransaction(taskId: string): number {
    const current = this.getBackgroundEpochs(taskId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE background_activities SET state = 'canceled', finished_at = ?
         WHERE task_id = ? AND state IN ('registered', 'running')
           AND (branch_epoch <> ? OR policy_epoch <> ? OR context_epoch <> ?)`,
      )
      .run(now, taskId, current.branchEpoch, current.policyEpoch, current.contextEpoch);
    const rows = this.db
      .prepare(
        `SELECT * FROM background_completions
         WHERE task_id = ? AND state = 'persisted'
           AND (branch_epoch <> ? OR policy_epoch <> ? OR context_epoch <> ?)`,
      )
      .all(
        taskId,
        current.branchEpoch,
        current.policyEpoch,
        current.contextEpoch,
      ) as BackgroundCompletionRow[];
    for (const row of rows) {
      const reason = backgroundEpochMismatch(
        {
          branchEpoch: row.branch_epoch,
          policyEpoch: row.policy_epoch,
          contextEpoch: row.context_epoch,
        },
        current,
      );
      if (reason === null) continue;
      this.db
        .prepare(
          `UPDATE background_completions SET state = 'quarantined', quarantine_reason = ?
           WHERE completion_id = ? AND state = 'persisted'`,
        )
        .run(reason, row.completion_id);
    }
    return rows.length;
  }

  private getApprovalRow(approvalId: string): ApprovalRow {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
      ApprovalRow | undefined;
    if (row === undefined) throw new NotFoundError('Approval not found');
    return row;
  }

  private getApprovalWithChallenge(
    taskId: string,
    approvalId: string,
    challenge: string,
  ): PersistedApproval {
    const row = this.getApprovalRow(approvalId);
    if (row.task_id !== taskId) throw new Error('Approval does not belong to this Task');
    return this.toPersistedApproval(row, challenge);
  }

  private toPersistedApproval(row: ApprovalRow, challenge: string): PersistedApproval {
    const display = parseApprovalDisplay(row.display_json);
    return {
      id: row.id,
      taskId: row.task_id,
      turnId: row.turn_id,
      callId: row.runtime_call_id,
      state: row.state,
      decision: row.decision,
      revision: row.revision,
      policyEpoch: row.policy_epoch,
      toolName: row.provider_name,
      reason: row.reason_untrusted,
      target: display.target,
      impact: display.impact,
      execution: display.execution,
      risk: row.risk,
      capability: row.capability,
      challenge,
      createdAt: row.requested_at,
      expiresAt: row.expires_at,
      ...(row.resolved_at === null ? {} : { decidedAt: row.resolved_at }),
      itemId: row.item_id,
      runtimeInstanceId: row.runtime_instance_id,
      subjectId: row.subject_id,
      toolId: row.tool_id,
      toolCatalogDigest: row.tool_catalog_digest,
      schemaDigest: row.schema_digest,
      specDigest: row.spec_digest,
      resource: parseResourceSet(row.resource_json),
      operation: row.operation,
      providerEgress: row.provider_egress,
      sandboxProfile: row.sandbox_profile,
    };
  }

  private challengeForApproval(taskId: string, approvalId: string): string {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM turn_events WHERE task_id = ? AND type = 'approval.requested' ORDER BY seq DESC",
      )
      .all(taskId) as { payload_json: string }[];
    for (const { payload_json } of rows) {
      const event = turnEventSchema.parse(JSON.parse(payload_json));
      if (event.type === 'approval.requested' && event.approvalId === approvalId)
        return event.approval.challenge;
    }
    throw new Error('Approval challenge event is missing');
  }

  private findApprovalEvent(
    taskId: string,
    approvalId: string,
    type: TurnEvent['type'],
  ): TurnEvent {
    const rows = this.db
      .prepare('SELECT payload_json FROM turn_events WHERE task_id = ? AND type = ? ORDER BY seq')
      .all(taskId, type) as { payload_json: string }[];
    const event = rows
      .map(({ payload_json }) => turnEventSchema.parse(JSON.parse(payload_json)))
      .find((candidate) => 'approvalId' in candidate && candidate.approvalId === approvalId);
    if (event === undefined) throw new Error('Approval event is missing');
    return event;
  }

  private resumeTurnAfterApproval(taskId: string, turnId: string): void {
    const pending = (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM approvals WHERE turn_id = ? AND state = 'pending'")
        .get(turnId) as { count: number }
    ).count;
    if (pending !== 0) return;
    const turn = this.getTurn(taskId, turnId);
    if (turn.state !== 'waiting_approval') return;
    transitionTurn(turn.state, 'executing');
    this.updateTurn(turnId, 'executing');
  }

  private cancelPendingApprovals(taskId: string, turnId: string, at: string): void {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE task_id = ? AND turn_id = ? AND state = 'pending'")
      .all(taskId, turnId) as ApprovalRow[];
    for (const row of rows) {
      this.db
        .prepare(
          `UPDATE approvals SET state = 'canceled', decision = NULL, revision = revision + 1,
            resolved_at = ? WHERE id = ? AND state = 'pending'`,
        )
        .run(at, row.id);
      const approval = this.toPersistedApproval(
        this.getApprovalRow(row.id),
        this.challengeForApproval(taskId, row.id),
      );
      this.appendEvent({
        type: 'approval.canceled',
        taskId,
        turnId,
        approvalId: row.id,
        approval: toApprovalAuditSummary(approval),
      });
    }
  }

  private completeTurnInTransaction(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
  ): TurnEvent {
    const turn = this.getTurn(taskId, turnId);
    this.cancelPendingApprovals(taskId, turnId, new Date().toISOString());
    transitionTurn(turn.state, state);
    this.updateTurn(turnId, state);
    this.requeueUnacknowledgedBackgroundInTransaction(taskId, turnId);
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

  private requeueUnacknowledgedBackgroundInTransaction(taskId: string, turnId: string): void {
    const current = this.getBackgroundEpochs(taskId);
    const rows = this.db
      .prepare(
        `SELECT * FROM background_completions
         WHERE task_id = ? AND target_turn_id = ? AND state = 'attached'`,
      )
      .all(taskId, turnId) as BackgroundCompletionRow[];
    for (const row of rows) {
      const mismatch = backgroundEpochMismatch(
        {
          branchEpoch: row.branch_epoch,
          policyEpoch: row.policy_epoch,
          contextEpoch: row.context_epoch,
        },
        current,
      );
      this.db
        .prepare(
          `UPDATE background_completions
           SET state = ?, target_turn_id = NULL, attached_at = NULL, quarantine_reason = ?
           WHERE completion_id = ? AND state = 'attached' AND target_turn_id = ?`,
        )
        .run(mismatch === null ? 'persisted' : 'quarantined', mismatch, row.completion_id, turnId);
    }
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

  loadContextLedgerState(taskId: string, turnId: string): ContextLedgerState {
    const task = this.getTaskRow(taskId);
    this.getTurn(taskId, turnId);
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
    const background = this.db
      .prepare(
        `SELECT completion_id, payload, payload_digest, outcome, created_at
         FROM background_completions
         WHERE task_id = ? AND target_turn_id = ? AND state = 'attached'
         ORDER BY created_at, rowid`,
      )
      .all(taskId, turnId) as Pick<
      BackgroundCompletionRow,
      'completion_id' | 'payload' | 'payload_digest' | 'outcome' | 'created_at'
    >[];
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
      background: background.map((fragment) => {
        if (!timingSafeDigestEqual(fragment.payload_digest, sha256(fragment.payload)))
          throw new Error('Background completion content integrity check failed');
        return {
          id: fragment.completion_id,
          taskId,
          source: 'background' as const,
          trust: 'assistant' as const,
          tokenEstimate: estimateTokens(fragment.payload),
          content: `[Background ${fragment.outcome} result — untrusted data]\n${fragment.payload}`,
          createdAt: fragment.created_at,
          messageId: null,
        };
      }),
    };
  }

  acknowledgeBackgroundFragments(
    taskId: string,
    turnId: string,
    fragmentIds: readonly string[],
  ): TurnEvent[] {
    return this.db.transaction(() => {
      const events: TurnEvent[] = [];
      for (const fragmentId of fragmentIds) {
        const row = this.backgroundCompletionRow(fragmentId);
        if (
          row === undefined ||
          row.task_id !== taskId ||
          row.target_turn_id !== turnId ||
          row.state !== 'attached'
        )
          throw new Error('Background fragment acknowledgement binding mismatch');
        const now = new Date().toISOString();
        const result = this.db
          .prepare(
            `UPDATE background_completions SET state = 'runtimeAcked', runtime_acked_at = ?
             WHERE completion_id = ? AND task_id = ? AND target_turn_id = ? AND state = 'attached'`,
          )
          .run(now, fragmentId, taskId, turnId);
        if (result.changes !== 1) throw new Error('Background acknowledgement conflict');
        events.push(
          this.appendEvent({
            type: 'delivery.acknowledged',
            taskId,
            turnId,
            deliveryId: row.delivery_id,
            completionId: row.completion_id,
            fragmentId: row.fragment_id,
          }),
        );
      }
      return events;
    })();
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

export function toApprovalSummary(approval: PersistedApproval): ApprovalSummary {
  return approvalSummarySchema.parse({
    id: approval.id,
    taskId: approval.taskId,
    turnId: approval.turnId,
    callId: approval.callId,
    state: approval.state,
    decision: approval.decision,
    revision: approval.revision,
    policyEpoch: approval.policyEpoch,
    toolName: approval.toolName,
    reason: approval.reason,
    target: approval.target,
    impact: approval.impact,
    execution: approval.execution,
    risk: approval.risk,
    capability: approval.capability,
    challenge: approval.challenge,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    ...(approval.decidedAt === undefined ? {} : { decidedAt: approval.decidedAt }),
  });
}

export function toApprovalAuditSummary(approval: PersistedApproval): ApprovalSummary {
  return approvalSummarySchema.parse({ ...toApprovalSummary(approval), challenge: 'redacted' });
}

function toCommandSummary(row: CommandRow): CommandSummary {
  const spec = JSON.parse(row.spec_json) as ExecutionSpec;
  if (executionSpecDigest(spec) !== row.spec_digest)
    throw new Error('Command spec digest mismatch');
  return commandSummarySchema.parse({
    id: row.id,
    taskId: row.task_id,
    turnId: row.turn_id,
    callId: row.call_id,
    specDigest: row.spec_digest,
    executable: spec.absoluteExecutable,
    argv: [...spec.argv],
    cwd: spec.cwdIdentity.canonicalPath,
    envDelta: { ...spec.envDelta },
    purpose: row.purpose,
    risk: row.risk,
    state: row.state,
    pid: row.pid,
    exitCode: row.exit_code,
    signal: row.signal,
    outputBytes: row.output_bytes,
    truncated: row.truncated === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

function validateApprovalRequest(input: ApprovalRequestInput): void {
  for (const value of [
    input.id,
    input.taskId,
    input.turnId,
    input.itemId,
    input.callId,
    input.runtimeInstanceId,
    input.subjectId,
    input.providerName,
    input.toolId,
  ])
    if (value.length === 0 || value.length > 256) throw new Error('Invalid approval identity');
  for (const digest of [input.toolCatalogDigest, input.schemaDigest, input.specDigest])
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid approval digest');
  if (!capabilities.includes(input.capability)) throw new Error('Invalid approval capability');
  if (!Number.isInteger(input.policyEpoch) || input.policyEpoch < 0)
    throw new Error('Invalid approval policy epoch');
  if (input.challenge.length < 8 || input.challenge.length > 256)
    throw new Error('Invalid approval challenge');
  if (
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    !Number.isFinite(Date.parse(input.requestedAt)) ||
    Date.parse(input.expiresAt) <= Date.parse(input.requestedAt)
  )
    throw new Error('Invalid approval lifetime');
  parseResourceSet(JSON.stringify(input.resource));
}

function parseApprovalDisplay(value: string): {
  target: string;
  impact: string;
  execution: string;
} {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    typeof parsed.target !== 'string' ||
    typeof parsed.impact !== 'string' ||
    typeof parsed.execution !== 'string'
  )
    throw new Error('Invalid approval display projection');
  return {
    target: sanitizeApprovalText(parsed.target, 500),
    impact: sanitizeApprovalText(parsed.impact, 500),
    execution: sanitizeApprovalText(parsed.execution, 100_000),
  };
}

function sanitizeApprovalText(value: string, maxLength: number): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
      ? '�'
      : character;
  })
    .join('')
    .trim();
  if (sanitized.length === 0) return '詳細なし';
  return sanitized.slice(0, maxLength);
}

function approvalRequestDigest(input: ApprovalRequestInput): string {
  return sha256(
    JSON.stringify({
      taskId: input.taskId,
      turnId: input.turnId,
      callId: input.callId,
      runtimeInstanceId: input.runtimeInstanceId,
      subjectId: input.subjectId,
      providerName: input.providerName,
      toolId: input.toolId,
      toolCatalogDigest: input.toolCatalogDigest,
      schemaDigest: input.schemaDigest,
      specDigest: input.specDigest,
      policyEpoch: input.policyEpoch,
      capability: input.capability,
      resource: input.resource,
      operation: input.operation,
      providerEgress: input.providerEgress,
      sandboxProfile: input.sandboxProfile,
      risk: input.risk,
      reason: sanitizeApprovalText(input.reasonUntrusted, 500),
      display: {
        target: sanitizeApprovalText(input.display.target, 500),
        impact: sanitizeApprovalText(input.display.impact, 500),
        execution: sanitizeApprovalText(input.display.execution, 100_000),
      },
    }),
  );
}

function persistedApprovalRequestDigest(approval: PersistedApproval): string {
  return sha256(
    JSON.stringify({
      taskId: approval.taskId,
      turnId: approval.turnId,
      callId: approval.callId,
      runtimeInstanceId: approval.runtimeInstanceId,
      subjectId: approval.subjectId,
      providerName: approval.toolName,
      toolId: approval.toolId,
      toolCatalogDigest: approval.toolCatalogDigest,
      schemaDigest: approval.schemaDigest,
      specDigest: approval.specDigest,
      policyEpoch: approval.policyEpoch,
      capability: approval.capability,
      resource: approval.resource,
      operation: approval.operation,
      providerEgress: approval.providerEgress,
      sandboxProfile: approval.sandboxProfile,
      risk: approval.risk,
      reason: approval.reason,
      display: {
        target: approval.target,
        impact: approval.impact,
        execution: approval.execution,
      },
    }),
  );
}

function approvalRowRequestDigest(row: ApprovalRow): string {
  return sha256(
    JSON.stringify({
      taskId: row.task_id,
      turnId: row.turn_id,
      callId: row.runtime_call_id,
      itemId: row.item_id,
      runtimeInstanceId: row.runtime_instance_id,
      subjectId: row.subject_id,
      providerName: row.provider_name,
      toolId: row.tool_id,
      toolCatalogDigest: row.tool_catalog_digest,
      schemaDigest: row.schema_digest,
      specDigest: row.spec_digest,
      policyEpoch: row.policy_epoch,
      capability: row.capability,
      resource: parseResourceSet(row.resource_json),
      operation: row.operation,
      providerEgress: row.provider_egress,
      sandboxProfile: row.sandbox_profile,
      risk: row.risk,
      reason: row.reason_untrusted,
      display: parseApprovalDisplay(row.display_json),
    }),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toVerifiedCommandOutput(row: {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  byte_length: number;
  content_hash: string;
}): CommandOutputRecord {
  if (
    Buffer.byteLength(row.text) !== row.byte_length ||
    !timingSafeDigestEqual(sha256(row.text), row.content_hash)
  )
    throw new Error('Command output integrity check failed');
  return {
    seq: row.seq,
    stream: row.stream,
    text: row.text,
    byteLength: row.byte_length,
  };
}

function approvalStorageCallId(callId: string, capability: Capability): string {
  return JSON.stringify([callId, capability]);
}

function toBackgroundActivity(row: BackgroundActivityRow): BackgroundActivityRecord {
  const requiredCapabilities = JSON.parse(row.required_capabilities_json) as unknown;
  if (
    !Array.isArray(requiredCapabilities) ||
    new Set(requiredCapabilities).size !== requiredCapabilities.length ||
    !requiredCapabilities.every((capability) => capabilities.includes(capability as Capability))
  )
    throw new Error('Invalid stored background capabilities');
  return {
    id: row.id,
    taskId: row.task_id,
    ownerThreadId: row.owner_thread_id,
    ownerTurnId: row.owner_turn_id,
    originWorkerId: row.origin_worker_id,
    kind: row.kind,
    state: row.state,
    wakePolicy: row.wake_policy,
    requiredCapabilities: requiredCapabilities as Capability[],
    epochs: {
      branchEpoch: row.branch_epoch,
      policyEpoch: row.policy_epoch,
      contextEpoch: row.context_epoch,
    },
    heartbeatAt: row.heartbeat_at,
    outputCursor: row.output_cursor,
    volumeQuotaBytes: row.volume_quota_bytes,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toBackgroundCompletion(row: BackgroundCompletionRow): BackgroundCompletionRecord {
  if (!timingSafeDigestEqual(row.payload_digest, sha256(row.payload)))
    throw new Error('Background completion content integrity check failed');
  return {
    completionId: row.completion_id,
    deliveryId: row.delivery_id,
    activityId: row.activity_id,
    taskId: row.task_id,
    ownerThreadId: row.owner_thread_id,
    ownerTurnId: row.owner_turn_id,
    epochs: {
      branchEpoch: row.branch_epoch,
      policyEpoch: row.policy_epoch,
      contextEpoch: row.context_epoch,
    },
    wakePolicy: row.wake_policy,
    outcome: row.outcome,
    payload: row.payload,
    outputCursor: row.output_cursor,
    state: row.state,
    targetTurnId: row.target_turn_id,
    fragmentId: row.fragment_id,
    quarantineReason: row.quarantine_reason,
    createdAt: row.created_at,
    attachedAt: row.attached_at,
    runtimeAckedAt: row.runtime_acked_at,
  };
}

function timingSafeDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function isTerminal(state: TurnState): boolean {
  return (
    state === 'completed' || state === 'canceled' || state === 'failed' || state === 'interrupted'
  );
}

function stateToStage(state: TurnState): NonNullable<TurnSnapshot['activeTurn']>['stage'] {
  if (state === 'waiting_approval') return 'waiting_approval';
  if (state === 'planning' || state === 'executing' || state === 'synthesizing') return state;
  if (state === 'blocked') return 'executing';
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
