import Database from 'better-sqlite3';
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { COPYFILE_EXCL } from 'node:constants';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chatMessageSchema,
  approvalSummarySchema,
  commandSummarySchema,
  executionResolutionSchema,
  modelSelectionSchema,
  modelFallbackNoticeSchema,
  updateHealthSchema,
  normalizedProviderUsageSchema,
  providerConnectionSchema,
  projectSummarySchema,
  taskSummarySchema,
  teamModelRestrictionSchema,
  teamBlueprintSchema,
  teamExecutionIsolationSchema,
  turnSkillSelectionsSchema,
  turnSkillSelectionSchema,
  turnEventSchema,
  turnSnapshotSchema,
  workerReportSchema,
  type ChatMessage,
  type ApprovalDecision,
  type AutoPermissionDecision,
  type ApprovalState,
  type ApprovalSummary,
  type ClaudeEffort,
  type CommandState,
  type CommandSummary,
  type CommandOutputPage,
  type ContextUsage,
  type ExecutionResolution,
  type ModelSelection,
  type ModelFallbackNotice,
  type UpdateErrorCategory,
  type UpdateHealth,
  type NormalizedProviderUsage,
  type ProviderConnection,
  type ProjectReference,
  type ProjectFolder,
  type ProjectFolderInput,
  type EffectiveWorkspaceSet,
  type ProjectMemory,
  type ProjectContextManifest as PublicProjectContextManifest,
  type ProjectContextManifestSummary,
  type ProjectSummary,
  type ProviderRuntimeKind,
  type QueuedInput,
  type RuntimeKind,
  type SkillDraft,
  type DatabaseRecovery,
  type FileChange,
  type FileChangeRecord,
  type GeneratedImage,
  generatedImageSchema,
  imageAttachmentMetadataSchema,
  imageAttachmentMetadataListSchema,
  imageAttachmentIdsSchema,
  IMAGE_ATTACHMENT_MAX_COUNT,
  IMAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  type TaskSummary,
  type ImageAttachmentMetadata,
  type ImageAttachmentMimeType,
  type TeamBudgetStatus,
  type TeamBlueprint,
  type TeamMissionAccess,
  type TeamMissionCheckpoint,
  type TeamMissionState,
  type TeamMissionWorktreeState,
  type TeamExecutionIsolation,
  type WorkerReport,
  type TeamModelRestriction,
  type TeamUsageTotals,
  type TurnEvent,
  type TurnSnapshot,
  type TurnSkillSelection,
  type TurnStage,
} from '@sprint-coder/contracts';
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
  assertTeamMessageAllowed,
  assertDelegationAllowed,
  assertManagerPolicy,
  assertTeamPolicy,
  assertWorkerPersistenceInput,
  transitionTeam,
  transitionTeamMessage,
  transitionWorker,
  createExecutionInstruction,
  nextTeamAttemptOrdinal,
  reviseQueuedExecutionInstruction,
  transitionTeamAttempt,
  transitionTeamExecution,
  DEFAULT_TEAM_BUDGET_LIMITS,
  DEFAULT_MANAGER_POLICY,
  DEFAULT_TEAM_POLICY,
  assertReservationWithinCap,
  transitionBudgetReservation,
  assertDeliveryRetryAllowed,
  transitionTeamDelivery as transitionTeamDeliveryState,
  teamDeliveryId,
  TEAM_DELIVERY_MAX_ATTEMPTS,
  budgetKinds,
  type BudgetScope,
  type BudgetKind,
  type BudgetReservationState,
  type TeamDeliveryState,
  type CapabilityCeiling,
  type ContextInheritancePolicy,
  type ManagerPolicy,
  type TeamMessageState,
  type TeamState,
  type TeamPolicy,
  type TeamAttemptState,
  type TeamExecutionState,
  type TeamQueueReason,
  type ExecutionInstruction,
  type WorkerState,
} from '@sprint-coder/domain';
import {
  ContextLedger,
  CONTEXT_HARD_CAP_TOKENS,
  CONTEXT_SYSTEM_PROMPT,
  aggregateContextUsage,
  defaultContextUsage,
  estimateTokens,
  type ContextFragment,
  type ContextLedgerState,
  type PersistedFragment,
  type PreparedContext,
  type ProjectContextItem,
} from './context-ledger';
import { BUILTIN_TEAM_SKILL_CONTENT, BUILTIN_TEAM_SKILL_FRAGMENT_ID } from './team-skill';
import { readProjectReference } from './project-reference-file';
import {
  isExistingTeamFollowupInput,
  isTeamContinuationInput,
  isTeamScenarioInput,
} from './team-tools';
import type { LiveState } from './context-reminder';
import { deriveLiveState } from './live-state';
import { redactSecrets } from './secret-redactor';
import { deriveTaskTitle } from './task-title';
import {
  BUILTIN_CLAUDE_CONNECTION_ID,
  BUILTIN_CODEX_CONNECTION_ID,
  builtinRuntimeForModelSelection,
  modelSelectionForRuntime,
} from './connection-identity';
import { sanitizeTerminalOutput } from './ansi-sanitizer';
import {
  isRuntimeFailureDiagnostic,
  type RuntimeFailureDiagnostic,
} from '../runtime-host/protocol';
import { RUNTIME_DIAGNOSTIC_MAX_BYTES } from '../runtime-host/runtime-failure-diagnostics';
import { pathComparisonKey, pathsEquivalent } from '../path-comparison';
import {
  legacyMutationWorkspaceKey,
  MutationClockRollbackError,
  MutationLeaseBusyError,
  MutationLeaseStaleError,
  MutationQuarantinedError,
  validateMutationDigest,
  validateMutationTimestamp,
  type MutationLeasePurpose,
  type MutationLeaseToken,
  type MutationQuarantine,
} from './mutation-lease';
import {
  aggregateTurnDiff,
  createEditSagaSnapshot,
  journaledPatchDigest,
  parseEditSagaSnapshot,
  transitionEditSagaSnapshot,
  type EditSagaLeaseGuard,
  type EditSagaCreateRequest,
  type EditSagaSnapshot,
  type JournaledPatchOperation,
  type OperationObservation,
  type TurnDiffEntry,
} from './edit-saga';
import {
  createNativeMutationIntentSnapshot,
  deriveNativeMutationEffectKind,
  parseNativeMutationIntentSeed,
  parseNativeMutationIntentSnapshot,
  transitionNativeMutationIntent,
  type NativeMutationIntentSeed,
  type NativeMutationIntentSnapshot,
  type NativeMutationIntentTransition,
} from './native-mutation-intent';
import {
  appendEditSagaCriterion,
  advanceStandardAssurance,
  createEditSagaEvidence,
  createInitialAcceptanceContract,
  createVerificationEvidence,
  decideCompletion,
  parseAcceptanceContract,
  parseAssuranceRound,
  parseEvidenceRecord,
  type AcceptanceContract,
  type AssuranceFailureClass,
  type AssuranceRound,
  type EvidenceRecord,
} from './assurance';
import type { SaveOutcome } from './workspace-edit';
import type { UserFileSaveIntent } from './user-file-save-saga';

class SqliteEditSagaLeaseHandle {
  timer: ReturnType<typeof setTimeout> | null = null;
  failure: unknown | null = null;
  stopped = false;

  constructor(
    readonly sagaId: string,
    public token: MutationLeaseToken,
  ) {}
}

export class SqliteEditSagaLeaseGuard implements EditSagaLeaseGuard {
  private readonly issued = new Map<string, SqliteEditSagaLeaseHandle>();

  constructor(
    private readonly persistence: PersistenceClient,
    private readonly holderInstanceId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 60_000,
    private readonly onReleased?: (lease: MutationLeaseToken) => Promise<void>,
  ) {
    validateMutationIdentifier(holderInstanceId, 'holder instance id');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000)
      throw new Error('Invalid mutation lease TTL');
  }

  async acquire(saga: EditSagaSnapshot, purpose: MutationLeasePurpose): Promise<unknown> {
    if (saga.workspaceKey === null || saga.rootIdentityDigest === null)
      throw new MutationQuarantinedError();
    const now = this.now();
    const token = this.persistence.acquireMutationLease({
      rootId: saga.rootId,
      workspaceKey: saga.workspaceKey,
      rootIdentityDigest: saga.rootIdentityDigest,
      holderInstanceId: this.holderInstanceId,
      taskId: saga.taskId,
      turnId: saga.turnId,
      sagaId: saga.id,
      purpose,
      policyEpoch: saga.policyEpoch,
      intentDigest: saga.planDigest,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    });
    const handle = new SqliteEditSagaLeaseHandle(saga.id, token);
    this.issued.set(saga.id, handle);
    this.scheduleRenewal(handle);
    return handle;
  }

  current(lease: unknown, saga: EditSagaSnapshot): MutationLeaseToken {
    const handle = this.requireIssued(lease, saga.id);
    if (handle.failure !== null) throw handle.failure;
    return handle.token;
  }

  async assertCurrent(lease: unknown, saga: EditSagaSnapshot): Promise<void> {
    const token = this.current(lease, saga);
    this.persistence.assertMutationLease(token, this.now().toISOString());
  }

  async release(lease: unknown, saga: EditSagaSnapshot): Promise<void> {
    const handle = this.requireIssued(lease, saga.id);
    this.stopRenewal(handle);
    try {
      if (handle.failure !== null) throw handle.failure;
      await this.onReleased?.(handle.token);
    } finally {
      if (handle.failure === null)
        this.persistence.releaseMutationLease(handle.token, this.now().toISOString());
      this.issued.delete(saga.id);
    }
  }

  async stop(lease: unknown, saga: EditSagaSnapshot): Promise<void> {
    if (lease instanceof SqliteEditSagaLeaseHandle && lease.stopped && lease.sagaId === saga.id)
      return;
    const handle = this.requireIssued(lease, saga.id);
    this.stopRenewal(handle);
    this.issued.delete(saga.id);
  }

  private scheduleRenewal(handle: SqliteEditSagaLeaseHandle): void {
    handle.timer = setTimeout(
      () => {
        if (handle.stopped || this.issued.get(handle.sagaId) !== handle) return;
        try {
          const now = this.now();
          handle.token = this.persistence.renewMutationLease(
            handle.token,
            now.toISOString(),
            new Date(now.getTime() + this.ttlMs).toISOString(),
          );
        } catch (error) {
          handle.failure = error;
          handle.timer = null;
          return;
        }
        this.scheduleRenewal(handle);
      },
      Math.max(1, Math.floor(this.ttlMs / 3)),
    );
  }

  private stopRenewal(handle: SqliteEditSagaLeaseHandle): void {
    handle.stopped = true;
    if (handle.timer !== null) clearTimeout(handle.timer);
    handle.timer = null;
  }

  private requireIssued(lease: unknown, sagaId: string): SqliteEditSagaLeaseHandle {
    const handle = this.issued.get(sagaId);
    if (
      !(lease instanceof SqliteEditSagaLeaseHandle) ||
      handle === undefined ||
      handle !== lease ||
      handle.stopped
    )
      throw new MutationLeaseStaleError();
    return handle;
  }
}

type GeneratedImageRow = {
  id: string;
  task_id: string;
  turn_id: string;
  mime_type: 'image/png';
  byte_length: number;
  created_at: string;
};

function toGeneratedImage(row: GeneratedImageRow): GeneratedImage {
  return generatedImageSchema.parse({
    id: row.id,
    taskId: row.task_id,
    turnId: row.turn_id,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    createdAt: row.created_at,
  });
}

/** A single generated icon is tens of KB; this is a sanity ceiling, not a target. */
const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The 8-byte PNG signature.
 *
 * Checked because the extension of a file in a directory the CLI owns proves nothing about its
 * contents, and these bytes end up in a `data:` URL in the renderer. Refusing anything else is what
 * keeps "display a generated image" from becoming "render whatever landed in that directory".
 */
function isPngBuffer(bytes: Buffer): boolean {
  return (
    bytes.byteLength > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

type TaskRow = {
  id: string;
  project_id: string | null;
  primary_thread_id: string;
  title: string;
  pinned: number;
  archived: number;
  goal: string | null;
  goal_status: 'active' | 'paused' | 'completed' | 'blocked' | null;
  goal_token_budget: number | null;
  goal_tokens_used: number;
  goal_time_used_seconds: number;
  goal_started_at: string | null;
  goal_updated_at: string | null;
  workspace_path: string | null;
  local_only: number;
  mutation_scope_key: string | null;
  mutation_root_identity_digest: string | null;
  legacy_project_workspace_fallback: number;
  draft: string;
  branch_epoch: number;
  context_epoch: number;
  title_source: 'default' | 'auto' | 'manual';
  connection_id: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  created_at: string;
  updated_at: string;
};
type ProjectRow = {
  id: string;
  name: string;
  archived: number;
  revision: number;
  instruction: string;
  context_epoch: number;
  workspace_roots_configured: number;
  task_count: number;
  folder_count: number;
  primary_folder_id: string | null;
  primary_folder_path: string | null;
  primary_folder_label: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
};
type ProjectReferenceRow = {
  id: string;
  project_id: string;
  source_task_id: string | null;
  project_root_id: string | null;
  relative_path: string;
  registered_root_identity: string;
  enabled: number;
  revision: number;
  last_sealed_digest: string | null;
  created_at: string;
  updated_at: string;
};
type ProjectWorkspaceRootRow = {
  id: string;
  project_id: string;
  canonical_path: string;
  label: string;
  role: 'primary' | 'secondary';
  ordinal: number;
  workspace_key: string;
  root_identity_digest: string;
  created_at: string;
  updated_at: string;
};

export type ProjectFolderBinding = Omit<ProjectFolderInput, 'path' | 'label'> & {
  path: string;
  canonicalPath: string;
  label: string;
  workspaceKey: string;
  rootIdentityDigest: string;
};
type ProjectMemoryRow = {
  id: string;
  project_id: string;
  source_task_id: string;
  source_turn_id: string;
  content: string;
  created_by: 'user' | 'assistant';
  status: 'active' | 'disabled';
  revision: number;
  local_only: number;
  created_at: string;
  updated_at: string;
};
type ProviderConnectionRow = {
  id: string;
  provider_id: string;
  runtime_kind: ProviderRuntimeKind;
  display_name: string;
  enabled: number;
  automatic_model_release: number;
  secret_reference: string | null;
  verification_status:
    | 'not_required'
    | 'unverified'
    | 'verified'
    | 'verification_expired'
    | 'invalid_credentials'
    | 'unavailable';
  verified_at: string | null;
  verification_expires_at: string | null;
  verification_message: string | null;
  rate_limit_mode: 'bypass' | 'auto' | 'manual';
  max_concurrent_requests: number | null;
  requests_per_minute: number | null;
  tokens_per_minute: number | null;
  last_observed_rate_limit_headers_json: string | null;
  created_at: string;
  updated_at: string;
};
type TeamRow = {
  id: string;
  task_id: string;
  state: TeamState;
  leader_agent_id: string;
  budget_json: string;
  policy_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
type AgentRow = {
  id: string;
  team_id: string | null;
  thread_id: string;
  task_id: string;
  kind: 'leader' | 'worker';
  role: string;
  state: WorkerState;
  objective: string | null;
  parent_capability_ceiling_json: string | null;
  context_inheritance_policy: ContextInheritancePolicy | null;
  write_capable: number;
  current_activity: string | null;
  runtime_kind: RuntimeKind;
  connection_id: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  parent_agent_id: string | null;
  depth: number;
  can_delegate: number;
  manager_policy_json: string | null;
  blueprint_role_key: string | null;
  created_at: string;
  updated_at: string;
};
type TeamBudgetReservationRow = {
  id: string;
  team_id: string;
  agent_id: string | null;
  scope: BudgetScope;
  kind: BudgetKind;
  amount: number;
  settled_amount: number | null;
  state: BudgetReservationState;
  purpose: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
type TeamDeliveryRow = {
  message_id: string;
  delivery_id: string;
  state: TeamDeliveryState;
  attempt: number;
  last_error: string | null;
  dispatched_at: string | null;
  acked_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
type WorkerWorktreeRow = {
  agent_id: string;
  path: string;
  base_head: string;
  state: WorkerWorktreeState;
  reason: string | null;
  created_at: string;
  updated_at: string;
};
type TeamMissionWorktreeRow = {
  execution_id: string;
  agent_id: string;
  repo_path: string;
  path: string;
  base_head: string;
  state: TeamMissionWorktreeState;
  worker_head: string | null;
  integrated_head: string | null;
  changed_files_json: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
};
type TeamExecutionIsolationRow = {
  execution_id: string;
  phase: TeamExecutionIsolation['phase'];
  resume_kind: TeamExecutionIsolation['resumeKind'];
  repositories_json: string;
  roots_json: string;
  reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
type TeamExecutionIsolationCompletionRow = {
  execution_id: string;
  attempt_id: string;
  team_task_id: string;
  agent_id: string;
  report_json: string;
  done_evidence_json: string;
  created_at: string;
};
type TeamMessageRow = {
  id: string;
  team_id: string;
  source_agent_id: string;
  target_agent_id: string;
  seq: number;
  state: TeamMessageState;
  content: string;
  execution_id: string | null;
  attempt_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
type TeamTaskRow = {
  id: string;
  team_id: string;
  message_id: string | null;
  assignee_agent_id: string;
  created_by_agent_id: string;
  description: string;
  status: TeamTaskRecord['status'];
  done_criteria_json: string;
  done_evidence_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
type TeamExecutionRow = {
  id: string;
  team_id: string;
  assignee_agent_id: string;
  created_by_agent_id: string;
  access_mode: TeamMissionAccess;
  state: TeamExecutionState;
  instruction_revision: number;
  queue_ordinal: number | null;
  queue_reason: TeamQueueReason | null;
  connection_id: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  revision: number;
  assigned_at: string;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};
type TeamInstructionRow = {
  execution_id: string;
  revision: number;
  content: string;
  created_by_agent_id: string;
  reason: 'initial' | 'steer';
  created_at: string;
};
type TeamAttemptRow = {
  id: string;
  execution_id: string;
  ordinal: number;
  state: TeamAttemptState;
  instruction_revision: number;
  connection_id: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  provider_call_ordinal: number;
  terminal_reason: string | null;
  start_reason: TeamAttemptStartReason;
  last_progress_at: string | null;
  resolved_provider: string | null;
  resolved_model: string | null;
  resolution_json: string | null;
  provider_usage_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};
type TeamMissionRow = {
  id: string;
  team_id: string;
  created_by_agent_id: string;
  state: TeamMissionState;
  objective: string;
  done_criteria_json: string;
  current_step_ordinal: number;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};
type TeamMissionStepRow = {
  mission_id: string;
  ordinal: number;
  execution_id: string;
  access_mode: TeamMissionAccess;
  checkpoint_json: string | null;
  checkpoint_digest: string | null;
  completed_at: string | null;
};
export const teamV2ActivityTypes = [
  'worker_hired',
  'task_assigned',
  'execution_queued',
  'execution_waiting',
  'execution_started',
  'execution_finished',
  'steered',
  'attempt_started',
  'attempt_finished',
  'worker_reported',
  'worker_stopped',
] as const;
export type TeamV2ActivityType = (typeof teamV2ActivityTypes)[number];
type TeamV2ActivityRow = {
  id: string;
  team_id: string;
  seq: number;
  type: TeamV2ActivityType;
  actor_agent_id: string | null;
  subject_agent_id: string | null;
  execution_id: string | null;
  attempt_id: string | null;
  payload_json: string;
  recorded_at: string;
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
  work_content: string | null;
  created_at: string;
};
type TurnRow = {
  id: string;
  task_id: string;
  state: TurnState;
  assistant_message_id: string | null;
  runtime_kind: RuntimeKind;
  model: string;
  connection_id: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  resolved_provider: string | null;
  resolved_model: string | null;
  resolution_json: string | null;
  provider_usage_json: string | null;
  created_at: string;
};
type QueueRow = {
  ordinal: number;
  operation_id: string;
  payload_json: string;
  payload_digest: string;
};
type ContextSealRow = {
  id: string;
  owner_type: ContextSealOwnerType;
  owner_id: string;
  task_id: string;
  project_id: string | null;
  project_revision: number | null;
  project_context_epoch: number | null;
  candidate_snapshot_digest: string;
  sealed_digest: string;
  compacted: number;
  created_at: string;
};
type ContextSealFragmentRow = {
  fragment_id: string;
  source: ContextFragment['source'];
  trust: ContextFragment['trust'];
  token_estimate: number;
  content: string;
  created_at: string;
  message_id: string | null;
};
type ProjectContextManifestItemRow = {
  item_id: string;
  kind: ProjectContextManifestItem['kind'];
  source_task_id: string | null;
  source_turn_id: string | null;
  source_reference_id: string | null;
  candidate_digest: string;
  sealed_digest: string | null;
  included: number;
  exclusion_reason: string | null;
  authority: ProjectContextManifestItem['authority'];
  local_only: number;
  content: string | null;
  captured_at: string;
};
type SkillBindingIdentityRow = {
  source: TurnSkillSelection['ref']['source'];
  skill_id: string;
  digest: string;
  kind: TurnSkillSelection['kind'];
};
type TurnSkillBindingRow = SkillBindingIdentityRow & {
  name: string;
  description: string;
  content: string;
  package_path: string;
};
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
type EditSagaRow = {
  id: string;
  task_id: string;
  turn_id: string;
  operation_id: string;
  plan_digest: string;
  policy_epoch: number;
  root_id: string | null;
  workspace_key: string | null;
  root_identity_digest: string | null;
  binding_version: number;
  native_binding_version: number;
  root_binding_version: number;
  state: EditSagaSnapshot['state'];
  revision: number;
  artifact_cleanup_pending: number;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
};
type NativeMutationIntentRow = {
  id: string;
  saga_id: string;
  ordinal: number;
  direction: NativeMutationIntentSnapshot['direction'];
  operation_digest: string;
  workspace_key: string;
  root_identity_digest: string;
  policy_epoch: number;
  lease_fence: string;
  native_session_id: string;
  seed_digest: string;
  intent_digest: string;
  record_digest: string;
  auxiliary_key: string | null;
  state: NativeMutationIntentSnapshot['state'];
  revision: number;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
};
export type NativeMutationRecoveryBinding = Readonly<{
  version: 1;
  intentId: string;
  attempt: number;
  intentDigest: string;
  leaseId: string;
  leaseFence: string;
  nativeSessionId: string;
  bindingDigest: string;
  createdAt: string;
}>;
type NativeMutationRecoveryBindingRow = {
  intent_id: string;
  attempt: number;
  intent_digest: string;
  lease_id: string;
  lease_fence: string;
  native_session_id: string;
  binding_digest: string;
  created_at: string;
};
type WorkspaceMutationRow = {
  workspace_key: string;
  root_identity_digest: string;
  root_id: string | null;
  state: 'idle' | 'held' | 'quarantined';
  fence: number;
  revision: number;
  lease_id: string | null;
  holder_instance_id: string | null;
  task_id: string | null;
  turn_id: string | null;
  saga_id: string | null;
  purpose: MutationLeasePurpose | null;
  policy_epoch: number | null;
  intent_digest: string | null;
  acquired_at: string | null;
  renewed_at: string | null;
  expires_at: string | null;
  last_observed_at: string;
  quarantine_reason: string | null;
};
type EventWithoutSeq = TurnEvent extends infer Event
  ? Event extends TurnEvent
    ? Omit<Event, 'seq'>
    : never
  : never;
type UserFileSaveIntentRow = {
  principal: string;
  task_id: string;
  kind: string;
  operation_id: string;
  request_hash: string;
  root_id: string;
  root_label: string;
  path: string;
  base_digest: string;
  replacement_digest: string;
  byte_length: number;
  state: UserFileSaveIntent['state'];
};

type WorkerWorktreeState = 'created' | 'active' | 'cleaned' | 'quarantined';

const workerWorktreeTransitions: Readonly<
  Record<WorkerWorktreeState, readonly WorkerWorktreeState[]>
> = {
  created: ['active', 'cleaned'],
  active: ['cleaned', 'quarantined'],
  cleaned: [],
  quarantined: [],
};

const teamTaskTransitions: Readonly<
  Record<TeamTaskRecord['status'], readonly TeamTaskRecord['status'][]>
> = {
  created: ['assigned', 'canceled'],
  assigned: ['running', 'failed', 'canceled'],
  running: ['waiting', 'completed', 'blocked', 'failed', 'canceled'],
  waiting: ['running', 'completed', 'blocked', 'failed', 'canceled'],
  completed: [],
  blocked: ['running', 'failed', 'canceled'],
  failed: [],
  canceled: [],
};

const TEAM_GLOBAL_LIMITS_SEED = JSON.stringify(DEFAULT_TEAM_BUDGET_LIMITS.global);
const TEAM_BUDGET_STRUCTURED_SEED = JSON.stringify({
  team: DEFAULT_TEAM_BUDGET_LIMITS.team,
  worker: DEFAULT_TEAM_BUDGET_LIMITS.worker,
});
const TEAM_POLICY_SEED = JSON.stringify(DEFAULT_TEAM_POLICY);
const MANAGER_POLICY_SEED = JSON.stringify(DEFAULT_MANAGER_POLICY);

/**
 * A development build briefly shipped a different migration lineage that reused versions 35–38.
 * Keep the old checksums as an explicitly recognised compatibility case instead of weakening the
 * checksum guard for arbitrary database edits.
 */
const LEGACY_MIGRATION_LINEAGE = new Map<number, string>([
  [35, 'real-runtimes-only-v35-migrate-legacy-runtime-records'],
  [36, 'project-context-hub-a1-v36-projects-and-task-membership'],
  [37, 'project-context-hub-v37-references-memories-manifests'],
  [38, 'project-context-hub-v38-reference-content-digest'],
]);
const LEGACY_MIGRATION_COMPATIBILITY_KEY = 'legacy-team-project-lineage-v1';
const LEGACY_IMAGE_ATTACHMENT_CHECKSUM = 'image-attachment-drafts-v64';
const LEGACY_IMAGE_ATTACHMENT_COMPATIBILITY_KEY = 'legacy-image-attachment-v64-collision-v1';
const LEGACY_RUNTIME_DIAGNOSTIC_CHECKSUM = 'runtime-failure-diagnostics-v66';
const LEGACY_RUNTIME_DIAGNOSTIC_COMPATIBILITY_KEY = 'legacy-runtime-diagnostics-v66-collision-v1';

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
  {
    version: 19,
    checksum: 'edit-saga-v19-durable-journal',
    sql: `
      CREATE TABLE edit_sagas (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'applying', 'compensating', 'committed', 'restored', 'recovery_required'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        artifact_cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (artifact_cleanup_pending IN (0, 1)),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, turn_id, operation_id)
      );
      CREATE INDEX edit_sagas_recovery_idx ON edit_sagas(state, updated_at, id);
    `,
  },
  {
    version: 20,
    checksum: 'workspace-mutation-lease-v20',
    sql: `
      ALTER TABLE tasks ADD COLUMN mutation_scope_key TEXT;
      ALTER TABLE tasks ADD COLUMN mutation_root_identity_digest TEXT;

      CREATE TABLE workspace_mutation_state (
        workspace_key TEXT PRIMARY KEY CHECK (length(workspace_key) = 64),
        root_identity_digest TEXT NOT NULL CHECK (length(root_identity_digest) = 64),
        state TEXT NOT NULL CHECK (state IN ('idle', 'held', 'quarantined')),
        fence INTEGER NOT NULL CHECK (fence >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        lease_id TEXT,
        holder_instance_id TEXT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        saga_id TEXT REFERENCES edit_sagas(id) ON DELETE SET NULL,
        purpose TEXT CHECK (purpose IN ('forward', 'recovery')),
        policy_epoch INTEGER CHECK (policy_epoch >= 0),
        intent_digest TEXT CHECK (intent_digest IS NULL OR length(intent_digest) = 64),
        acquired_at TEXT,
        renewed_at TEXT,
        expires_at TEXT,
        last_observed_at TEXT NOT NULL,
        quarantine_reason TEXT
      );

      CREATE TABLE task_mutation_quarantines (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        workspace_key TEXT NOT NULL REFERENCES workspace_mutation_state(workspace_key),
        reason TEXT NOT NULL,
        source_saga_id TEXT REFERENCES edit_sagas(id) ON DELETE SET NULL,
        fence INTEGER NOT NULL CHECK (fence >= 0),
        created_at TEXT NOT NULL,
        cleared_at TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        PRIMARY KEY(task_id, workspace_key)
      );
      CREATE INDEX task_mutation_quarantine_active_idx
        ON task_mutation_quarantines(task_id, cleared_at, workspace_key);
    `,
  },
  {
    version: 21,
    checksum: 'edit-saga-workspace-binding-v21',
    sql: `
      ALTER TABLE edit_sagas ADD COLUMN workspace_key TEXT;
      ALTER TABLE edit_sagas ADD COLUMN root_identity_digest TEXT;
      CREATE INDEX edit_sagas_workspace_recovery_idx
        ON edit_sagas(workspace_key, state, updated_at, id);
    `,
  },
  {
    version: 22,
    checksum: 'edit-saga-binding-seal-v22',
    sql: `
      ALTER TABLE edit_sagas ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 0
        CHECK (binding_version IN (0, 1));
    `,
  },
  {
    version: 23,
    checksum: 'native-mutation-intent-v23-record-seal',
    sql: `
      ALTER TABLE edit_sagas ADD COLUMN native_binding_version INTEGER NOT NULL DEFAULT 0
        CHECK (native_binding_version IN (0, 1));
      CREATE TABLE native_mutation_intents (
        id TEXT PRIMARY KEY,
        saga_id TEXT NOT NULL REFERENCES edit_sagas(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
        direction TEXT NOT NULL CHECK (direction IN ('forward', 'compensation')),
        operation_digest TEXT NOT NULL CHECK (length(operation_digest) = 64),
        workspace_key TEXT NOT NULL CHECK (length(workspace_key) = 64),
        root_identity_digest TEXT NOT NULL CHECK (length(root_identity_digest) = 64),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 0),
        lease_fence TEXT NOT NULL,
        native_session_id TEXT NOT NULL CHECK (length(native_session_id) = 32),
        seed_digest TEXT NOT NULL CHECK (length(seed_digest) = 64),
        intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
        record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
        auxiliary_key TEXT CHECK (auxiliary_key IS NULL OR length(auxiliary_key) = 64),
        state TEXT NOT NULL CHECK (state IN (
          'planned', 'aux_pending', 'aux_observed', 'effect_pending', 'effect_observed',
          'cleanup_pending', 'completed', 'recovery_required'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(saga_id, ordinal, direction),
        UNIQUE(workspace_key, auxiliary_key)
      );
      CREATE INDEX native_mutation_intents_recovery_idx
        ON native_mutation_intents(state, updated_at, id);
      CREATE INDEX native_mutation_intents_saga_idx
        ON native_mutation_intents(saga_id, ordinal, direction);
      CREATE TABLE native_mutation_recovery_bindings (
        intent_id TEXT NOT NULL REFERENCES native_mutation_intents(id) ON DELETE RESTRICT,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
        lease_id TEXT NOT NULL,
        lease_fence TEXT NOT NULL,
        native_session_id TEXT NOT NULL CHECK (length(native_session_id) = 32),
        binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY(intent_id, attempt),
        UNIQUE(intent_id, lease_id, native_session_id)
      );
    `,
  },
  {
    version: 24,
    checksum: 'standard-assurance-v24-contract-evidence',
    sql: `
      CREATE TABLE acceptance_contracts (
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(turn_id, revision),
        UNIQUE(id, revision)
      );
      CREATE INDEX acceptance_contracts_task_idx
        ON acceptance_contracts(task_id, turn_id, revision);

      CREATE TABLE evidence_records (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        criterion_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('edit_saga_committed')),
        subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64),
        record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(turn_id, criterion_id, kind, subject_digest)
      );
      CREATE INDEX evidence_records_turn_idx
        ON evidence_records(turn_id, created_at, id);
    `,
  },
  {
    version: 25,
    checksum: 'standard-assurance-v25-bounded-rounds',
    sql: `
      DROP INDEX evidence_records_turn_idx;
      ALTER TABLE evidence_records RENAME TO evidence_records_v24;
      CREATE TABLE evidence_records (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        criterion_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('edit_saga_committed', 'verification_passed')),
        subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64),
        record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(turn_id, criterion_id, kind, subject_digest)
      );
      INSERT INTO evidence_records
        SELECT * FROM evidence_records_v24;
      DROP TABLE evidence_records_v24;
      CREATE INDEX evidence_records_turn_idx
        ON evidence_records(turn_id, created_at, id);

      CREATE TABLE assurance_rounds (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        saga_id TEXT NOT NULL REFERENCES edit_sagas(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        decision TEXT NOT NULL CHECK (
          decision IN ('complete', 'repair', 'retry_verification', 'blocked')
        ),
        repair_rounds_used INTEGER NOT NULL CHECK (repair_rounds_used IN (0, 1)),
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(saga_id, ordinal)
      );
      CREATE INDEX assurance_rounds_turn_idx
        ON assurance_rounds(turn_id, saga_id, ordinal);
    `,
  },
  {
    version: 26,
    checksum: 'provider-egress-v26-local-only-task',
    sql: `
      ALTER TABLE tasks ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0
        CHECK (local_only IN (0, 1));
    `,
  },
  {
    version: 27,
    checksum: 'team-persistence-v27-threads-membership-delivery',
    sql: `
      CREATE TABLE agent_threads (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('mock', 'codex')),
        state TEXT NOT NULL CHECK (state IN ('idle', 'active', 'paused', 'interrupted', 'completed')),
        active_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX agent_threads_task_idx ON agent_threads(task_id, created_at, id);

      ALTER TABLE tasks ADD COLUMN primary_thread_id TEXT REFERENCES agent_threads(id);

      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (
          state IN ('draft', 'forming', 'active', 'paused', 'winding_down', 'completed', 'failed')
        ),
        leader_agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) DEFERRABLE INITIALLY DEFERRED,
        budget_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL UNIQUE REFERENCES agent_threads(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('leader', 'worker')),
        role TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('invited', 'spawning', 'ready', 'busy', 'waiting', 'done', 'failed', 'stopped')
        ),
        objective TEXT,
        parent_capability_ceiling_json TEXT,
        context_inheritance_policy TEXT CHECK (
          context_inheritance_policy IS NULL OR
          context_inheritance_policy IN ('none', 'summary', 'selected_items', 'full_fork')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (kind = 'leader' AND objective IS NULL AND parent_capability_ceiling_json IS NULL
            AND context_inheritance_policy IS NULL) OR
          (kind = 'worker' AND objective IS NOT NULL AND parent_capability_ceiling_json IS NOT NULL
            AND context_inheritance_policy IS NOT NULL)
        )
      );
      CREATE INDEX agents_team_idx ON agents(team_id, kind, created_at, id);

      CREATE TABLE team_memberships (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('leader', 'worker')),
        joined_at TEXT NOT NULL,
        left_at TEXT,
        PRIMARY KEY(team_id, agent_id)
      );

      CREATE TABLE team_messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        source_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        target_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        seq INTEGER NOT NULL CHECK (seq > 0),
        state TEXT NOT NULL CHECK (
          state IN ('created', 'persisted', 'dispatching', 'delivered', 'acknowledged')
        ),
        content TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, seq),
        CHECK (source_agent_id <> target_agent_id)
      );
      CREATE INDEX team_messages_delivery_idx ON team_messages(team_id, state, seq);

      CREATE TABLE team_message_events (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        from_state TEXT,
        to_state TEXT NOT NULL CHECK (
          to_state IN ('created', 'persisted', 'dispatching', 'delivered', 'acknowledged')
        ),
        recorded_at TEXT NOT NULL,
        UNIQUE(message_id, revision)
      );

      INSERT INTO agent_threads(
        id, task_id, runtime_kind, state, active_turn_id, revision, created_at, updated_at
      )
        SELECT id, id, 'mock', 'active', NULL, 0, created_at, updated_at FROM tasks;
      UPDATE tasks SET primary_thread_id = id;
      INSERT INTO agents(
        id, team_id, thread_id, task_id, kind, role, state, objective,
        parent_capability_ceiling_json, context_inheritance_policy, created_at, updated_at
      )
        SELECT id || ':leader', NULL, id, id, 'leader', 'leader', 'ready', NULL,
          NULL, NULL, created_at, updated_at
        FROM tasks;
    `,
  },
  {
    version: 28,
    checksum: 'team-coordinator-v28-budget-delivery-worktree',
    sql: `
      CREATE TABLE team_global_limits (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        limits_json TEXT NOT NULL
      );
      INSERT INTO team_global_limits(id, limits_json) VALUES (1, '${TEAM_GLOBAL_LIMITS_SEED}');

      CREATE TABLE team_budget_reservations (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'team', 'worker')),
        kind TEXT NOT NULL CHECK (
          kind IN ('costCents', 'tokens', 'timeMs', 'toolCalls', 'spawnSlots')
        ),
        amount INTEGER NOT NULL CHECK (amount > 0),
        settled_amount INTEGER CHECK (settled_amount IS NULL OR settled_amount >= 0),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
        purpose TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        CHECK (
          (scope = 'worker' AND agent_id IS NOT NULL) OR
          (scope <> 'worker' AND agent_id IS NULL)
        )
      );
      CREATE INDEX team_budget_reservations_team_idx
        ON team_budget_reservations(team_id, state);
      CREATE INDEX team_budget_reservations_scope_idx
        ON team_budget_reservations(scope, kind, state);
      CREATE INDEX team_budget_reservations_agent_idx
        ON team_budget_reservations(agent_id, state);

      CREATE TABLE team_message_deliveries (
        message_id TEXT PRIMARY KEY REFERENCES team_messages(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL UNIQUE CHECK (length(delivery_id) = 64),
        state TEXT NOT NULL CHECK (
          state IN ('persisted', 'dispatched', 'acked', 'timedOut', 'failed')
        ),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        last_error TEXT,
        dispatched_at TEXT,
        acked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
      );

      CREATE TABLE team_delivery_events (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES team_message_deliveries(message_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        from_state TEXT CHECK (
          from_state IS NULL OR
          from_state IN ('persisted', 'dispatched', 'acked', 'timedOut', 'failed')
        ),
        to_state TEXT NOT NULL CHECK (
          to_state IN ('persisted', 'dispatched', 'acked', 'timedOut', 'failed')
        ),
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        error TEXT,
        recorded_at TEXT NOT NULL,
        UNIQUE(message_id, revision)
      );

      CREATE TABLE worker_worktrees (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        base_head TEXT NOT NULL CHECK (length(base_head) = 40),
        state TEXT NOT NULL CHECK (state IN ('created', 'active', 'cleaned', 'quarantined')),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ALTER TABLE agents ADD COLUMN write_capable INTEGER NOT NULL DEFAULT 0
        CHECK (write_capable IN (0, 1));
      ALTER TABLE agents ADD COLUMN current_activity TEXT;

      UPDATE teams SET budget_json = '${TEAM_BUDGET_STRUCTURED_SEED}' WHERE budget_json = '{}';
    `,
  },
  {
    version: 29,
    checksum: 'canvas-views-v29-camera-node-layout',
    sql: `
      CREATE TABLE canvas_views (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        camera_x REAL NOT NULL,
        camera_y REAL NOT NULL,
        camera_scale REAL NOT NULL CHECK (camera_scale > 0),
        node_positions_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 30,
    checksum: 'runtime-v30-claude-kind-support',
    // Widens the `runtime_kind` CHECK on `turns` and `agent_threads` to allow 'claude' (Slice
    // 3.4). SQLite cannot ALTER a CHECK constraint in place, so both tables are rebuilt under a
    // new name, repopulated, and the original dropped and replaced via RENAME (never the other
    // way around: renaming the *original* table away first would make SQLite rewrite every
    // other table's REFERENCES clause to point at the transient name, so a plain DROP+RENAME of
    // the *new* table into the original name is the only order that leaves every foreign key —
    // turn_events/background_completions/edit_sagas/agent_threads.active_turn_id -> turns, and
    // tasks.primary_thread_id/team_workers.thread_id -> agent_threads — correctly resolved).
    // Requires requiresForeignKeysOff (see runMigrations): with FK enforcement on, SQLite runs
    // an implicit cascading DELETE before a DROP TABLE of a table other rows still reference.
    sql: `
      CREATE TABLE turns_v30 (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL REFERENCES messages(id), assistant_message_id TEXT REFERENCES messages(id),
        state TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        runtime_kind TEXT NOT NULL DEFAULT 'mock' CHECK (runtime_kind IN ('mock', 'codex', 'claude')),
        model TEXT NOT NULL DEFAULT 'auto'
      );
      INSERT INTO turns_v30 (
        id, task_id, user_message_id, assistant_message_id, state, seq, created_at, updated_at, runtime_kind, model
      )
        SELECT id, task_id, user_message_id, assistant_message_id, state, seq, created_at, updated_at, runtime_kind, model
        FROM turns;
      DROP TABLE turns;
      ALTER TABLE turns_v30 RENAME TO turns;
      CREATE INDEX turns_task_state_idx ON turns(task_id, state);

      CREATE TABLE agent_threads_v30 (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('mock', 'codex', 'claude')),
        state TEXT NOT NULL CHECK (state IN ('idle', 'active', 'paused', 'interrupted', 'completed')),
        active_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_threads_v30 (id, task_id, runtime_kind, state, active_turn_id, revision, created_at, updated_at)
        SELECT id, task_id, runtime_kind, state, active_turn_id, revision, created_at, updated_at
        FROM agent_threads;
      DROP TABLE agent_threads;
      ALTER TABLE agent_threads_v30 RENAME TO agent_threads;
      CREATE INDEX agent_threads_task_idx ON agent_threads(task_id, created_at, id);
    `,
    requiresForeignKeysOff: true,
  },
  {
    version: 31,
    checksum: 'task-title-v31-auto-naming-source',
    // Tracks where a Task's title came from, so automatic naming from the first user message
    // (issue #4) can never overwrite a name the user chose. 'default' is the only state eligible
    // for auto-naming; it becomes 'auto' once derived and 'manual' on any explicit rename.
    //
    // Every pre-existing row is frozen to 'manual' rather than left at the column default. Those
    // Tasks already have history, so their next message is not a first message — auto-naming them
    // would rename an established conversation after the fact, and for any the user had already
    // renamed by hand it would silently discard that name.
    sql: `
      ALTER TABLE tasks ADD COLUMN title_source TEXT NOT NULL DEFAULT 'default'
        CHECK (title_source IN ('default', 'auto', 'manual'));
      UPDATE tasks SET title_source = 'manual';
    `,
  },
  {
    // v32, not v31: issue #4's auto-naming migration landed on this number first. Two migrations
    // sharing a version would leave whichever ran second permanently unapplied on any database that
    // already recorded the number.
    version: 32,
    checksum: 'generated-images-v32-codex-imagegen',
    // Images a Runtime generated during a Turn (issue #11). Bytes live in the row rather than on
    // disk: they are small (a single icon), already content-addressed, and keeping them in the same
    // transaction as the Turn event means an image can never be referenced by a committed event
    // while its file is missing.
    //
    // `id` is the SHA-256 of the bytes, so re-generating the same image stores it once. `mime_type`
    // is CHECKed rather than free-form because the only accepted format is verified by magic bytes
    // before insert — an extension is not evidence.
    sql: `
      CREATE TABLE generated_images (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL CHECK (mime_type = 'image/png'),
        byte_length INTEGER NOT NULL CHECK (byte_length > 0),
        bytes BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX generated_images_task_idx ON generated_images(task_id, created_at, id);
    `,
  },
  {
    version: 33,
    checksum: 'team-runtime-v33-tasks-activity-reports',
    sql: `
      CREATE TABLE team_tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        message_id TEXT UNIQUE REFERENCES team_messages(id) ON DELETE SET NULL,
        assignee_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('created', 'assigned', 'running', 'waiting', 'completed', 'blocked', 'failed', 'canceled')
        ),
        done_criteria_json TEXT NOT NULL,
        done_evidence_json TEXT NOT NULL DEFAULT '[]',
        blocked_reason TEXT,
        started_at TEXT,
        completed_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX team_tasks_team_status_idx ON team_tasks(team_id, status, created_at);
      CREATE INDEX team_tasks_assignee_idx ON team_tasks(assignee_agent_id, status);
      CREATE TABLE team_activity_events (
        id TEXT PRIMARY KEY,
        team_task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (
          type IN ('accepted', 'activity', 'fileChange', 'blocked', 'completed', 'failed', 'canceled')
        ),
        payload_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX team_activity_events_task_idx
        ON team_activity_events(team_task_id, recorded_at, id);
      CREATE TABLE team_reports (
        id TEXT PRIMARY KEY,
        team_task_id TEXT NOT NULL UNIQUE REFERENCES team_tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('completed', 'blocked', 'needs_input', 'failed')),
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 34,
    checksum: 'team-spawn-slots-v34-release-concurrency-leases',
    sql: `
      UPDATE team_budget_reservations
      SET state = 'released', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE kind = 'spawnSlots' AND state = 'settled';
    `,
  },
  {
    version: 35,
    checksum: 'team-v2-core-v35-connection-model-identity',
    sql: `
      ALTER TABLE turns ADD COLUMN connection_id TEXT;
      ALTER TABLE turns ADD COLUMN requested_provider TEXT;
      ALTER TABLE turns ADD COLUMN requested_model TEXT;
      ALTER TABLE turns ADD COLUMN resolved_provider TEXT;
      ALTER TABLE turns ADD COLUMN resolved_model TEXT;

      ALTER TABLE agent_threads ADD COLUMN connection_id TEXT;
      ALTER TABLE agent_threads ADD COLUMN requested_provider TEXT;
      ALTER TABLE agent_threads ADD COLUMN requested_model TEXT;

      ALTER TABLE agents ADD COLUMN connection_id TEXT;
      ALTER TABLE agents ADD COLUMN requested_provider TEXT;
      ALTER TABLE agents ADD COLUMN requested_model TEXT;
    `,
  },
  {
    version: 36,
    checksum: 'team-v2-core-v36-task-model-selection',
    sql: `
      ALTER TABLE tasks ADD COLUMN connection_id TEXT;
      ALTER TABLE tasks ADD COLUMN requested_provider TEXT;
      ALTER TABLE tasks ADD COLUMN requested_model TEXT;
    `,
  },
  {
    version: 37,
    checksum: 'team-v2-core-v37-hierarchy-team-policy',
    sql: `
      ALTER TABLE teams ADD COLUMN policy_json TEXT NOT NULL DEFAULT '${TEAM_POLICY_SEED}';

      ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT;
      ALTER TABLE agents ADD COLUMN depth INTEGER NOT NULL DEFAULT 0
        CHECK (depth BETWEEN 0 AND 4);
      ALTER TABLE agents ADD COLUMN can_delegate INTEGER NOT NULL DEFAULT 0
        CHECK (can_delegate IN (0, 1));
      ALTER TABLE agents ADD COLUMN manager_policy_json TEXT;

      UPDATE agents
      SET can_delegate = 1, manager_policy_json = '${MANAGER_POLICY_SEED}'
      WHERE kind = 'leader';
      UPDATE agents
      SET parent_agent_id = (
            SELECT teams.leader_agent_id FROM teams WHERE teams.id = agents.team_id
          ),
          depth = 1
      WHERE kind = 'worker';

      CREATE INDEX agents_parent_idx
        ON agents(team_id, parent_agent_id, depth, created_at, id);
    `,
  },
  {
    version: 38,
    checksum: 'team-v2-core-v38-execution-attempt-queue',
    sql: `
      CREATE TABLE team_executions (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        assignee_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (
          'assigned', 'queued', 'waiting_verification', 'waiting_rate_limit',
          'running', 'completed', 'failed', 'canceled'
        )),
        instruction_revision INTEGER NOT NULL DEFAULT 1 CHECK (instruction_revision >= 1),
        queue_ordinal INTEGER,
        queue_reason TEXT CHECK (
          queue_reason IS NULL OR queue_reason IN (
            'global_concurrency', 'connection_concurrency', 'verification',
            'rate_limit', 'budget', 'recovery'
          )
        ),
        connection_id TEXT,
        requested_provider TEXT,
        requested_model TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        assigned_at TEXT NOT NULL,
        queued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, queue_ordinal)
      );
      CREATE INDEX team_executions_queue_idx
        ON team_executions(state, queue_ordinal, queued_at, id);
      CREATE INDEX team_executions_assignee_idx
        ON team_executions(assignee_agent_id, state, assigned_at, id);

      CREATE TABLE team_execution_instructions (
        execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        content TEXT NOT NULL,
        created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (reason IN ('initial', 'steer')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(execution_id, revision)
      );

      CREATE TABLE team_attempts (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'waiting_verification', 'waiting_rate_limit', 'running',
          'completed', 'failed', 'canceled', 'interrupted'
        )),
        instruction_revision INTEGER NOT NULL CHECK (instruction_revision >= 1),
        connection_id TEXT,
        requested_provider TEXT,
        requested_model TEXT,
        provider_call_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (provider_call_ordinal >= 0),
        terminal_reason TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(execution_id, ordinal)
      );
      CREATE INDEX team_attempts_execution_idx
        ON team_attempts(execution_id, ordinal);
      CREATE INDEX team_attempts_active_idx
        ON team_attempts(state, updated_at, id);
    `,
  },
  {
    version: 39,
    checksum: 'team-v2-core-v39-direct-message-audit-links',
    sql: `
      ALTER TABLE team_messages
        ADD COLUMN execution_id TEXT REFERENCES team_executions(id) ON DELETE SET NULL;
      ALTER TABLE team_messages
        ADD COLUMN attempt_id TEXT REFERENCES team_attempts(id) ON DELETE SET NULL;
      CREATE INDEX team_messages_execution_idx
        ON team_messages(execution_id, attempt_id, seq);
    `,
  },
  {
    version: 40,
    checksum: 'team-v2-core-v40-activity-timeline',
    sql: `
      CREATE TABLE team_v2_activity_events (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 1),
        type TEXT NOT NULL CHECK (type IN (
          'worker_hired', 'task_assigned', 'execution_queued', 'execution_waiting',
          'execution_started', 'execution_finished', 'steered', 'attempt_started',
          'attempt_finished', 'worker_reported', 'worker_stopped'
        )),
        actor_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        subject_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        execution_id TEXT REFERENCES team_executions(id) ON DELETE SET NULL,
        attempt_id TEXT REFERENCES team_attempts(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(team_id, seq)
      );
      CREATE INDEX team_v2_activity_timeline_idx
        ON team_v2_activity_events(team_id, seq);
      CREATE INDEX team_v2_activity_execution_idx
        ON team_v2_activity_events(execution_id, attempt_id, seq);
    `,
  },
  {
    version: 41,
    checksum: 'provider-p1a-v41-connection-domain-builtins',
    sql: `
      CREATE TABLE provider_connections (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL CHECK (runtime_kind IN (
          'builtin_cli', 'official_api', 'openai_compatible', 'mock'
        )),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX provider_connections_provider_idx
        ON provider_connections(provider_id, runtime_kind, enabled, id);

      INSERT INTO provider_connections(
        id, provider_id, runtime_kind, display_name, enabled, created_at, updated_at
      ) VALUES
        ('${BUILTIN_CLAUDE_CONNECTION_ID}', 'anthropic', 'builtin_cli', 'Claude CLI', 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('${BUILTIN_CODEX_CONNECTION_ID}', 'openai', 'builtin_cli', 'Codex CLI', 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
  {
    version: 42,
    checksum: 'provider-p1a-v42-legacy-builtin-identity-backfill',
    sql: `
      UPDATE turns
      SET connection_id = CASE runtime_kind
            WHEN 'claude' THEN '${BUILTIN_CLAUDE_CONNECTION_ID}'
            WHEN 'codex' THEN '${BUILTIN_CODEX_CONNECTION_ID}'
          END,
          requested_provider = CASE runtime_kind
            WHEN 'claude' THEN 'anthropic'
            WHEN 'codex' THEN 'openai'
          END,
          requested_model = model
      WHERE runtime_kind IN ('claude', 'codex')
        AND (connection_id IS NULL OR requested_provider IS NULL OR requested_model IS NULL);

      UPDATE agent_threads
      SET connection_id = CASE runtime_kind
            WHEN 'claude' THEN '${BUILTIN_CLAUDE_CONNECTION_ID}'
            WHEN 'codex' THEN '${BUILTIN_CODEX_CONNECTION_ID}'
          END,
          requested_provider = CASE runtime_kind
            WHEN 'claude' THEN 'anthropic'
            WHEN 'codex' THEN 'openai'
          END,
          requested_model = COALESCE(
            (
              SELECT turns.model
              FROM turns
              WHERE turns.task_id = agent_threads.task_id
                AND turns.runtime_kind = agent_threads.runtime_kind
              ORDER BY turns.created_at DESC, turns.rowid DESC
              LIMIT 1
            ),
            (
              SELECT settings.value
              FROM settings
              WHERE settings.key = CASE agent_threads.runtime_kind
                WHEN 'claude' THEN 'runtime.claude.model'
                ELSE 'runtime.codex.model'
              END
            ),
            'auto'
          )
      WHERE runtime_kind IN ('claude', 'codex')
        AND (connection_id IS NULL OR requested_provider IS NULL OR requested_model IS NULL);

      UPDATE agents
      SET connection_id = (
            SELECT agent_threads.connection_id
            FROM agent_threads
            WHERE agent_threads.id = agents.thread_id
          ),
          requested_provider = (
            SELECT agent_threads.requested_provider
            FROM agent_threads
            WHERE agent_threads.id = agents.thread_id
          ),
          requested_model = (
            SELECT agent_threads.requested_model
            FROM agent_threads
            WHERE agent_threads.id = agents.thread_id
          )
      WHERE EXISTS (
        SELECT 1
        FROM agent_threads
        WHERE agent_threads.id = agents.thread_id
          AND agent_threads.runtime_kind IN ('claude', 'codex')
      )
        AND (connection_id IS NULL OR requested_provider IS NULL OR requested_model IS NULL);

      UPDATE tasks
      SET connection_id = (
            SELECT turns.connection_id
            FROM turns
            WHERE turns.task_id = tasks.id AND turns.connection_id IS NOT NULL
            ORDER BY turns.created_at DESC, turns.rowid DESC
            LIMIT 1
          ),
          requested_provider = (
            SELECT turns.requested_provider
            FROM turns
            WHERE turns.task_id = tasks.id AND turns.connection_id IS NOT NULL
            ORDER BY turns.created_at DESC, turns.rowid DESC
            LIMIT 1
          ),
          requested_model = (
            SELECT turns.requested_model
            FROM turns
            WHERE turns.task_id = tasks.id AND turns.connection_id IS NOT NULL
            ORDER BY turns.created_at DESC, turns.rowid DESC
            LIMIT 1
          )
      WHERE connection_id IS NULL
        AND EXISTS (
          SELECT 1 FROM turns
          WHERE turns.task_id = tasks.id AND turns.connection_id IS NOT NULL
        );

      UPDATE tasks
      SET connection_id = CASE (
            SELECT value FROM settings WHERE key = 'runtime.kind'
          )
            WHEN 'claude' THEN '${BUILTIN_CLAUDE_CONNECTION_ID}'
            WHEN 'codex' THEN '${BUILTIN_CODEX_CONNECTION_ID}'
          END,
          requested_provider = CASE (
            SELECT value FROM settings WHERE key = 'runtime.kind'
          )
            WHEN 'claude' THEN 'anthropic'
            WHEN 'codex' THEN 'openai'
          END,
          requested_model = COALESCE(
            (
              SELECT value
              FROM settings
              WHERE key = CASE (
                SELECT value FROM settings WHERE key = 'runtime.kind'
              )
                WHEN 'claude' THEN 'runtime.claude.model'
                ELSE 'runtime.codex.model'
              END
            ),
            'auto'
          )
      WHERE connection_id IS NULL
        AND (SELECT value FROM settings WHERE key = 'runtime.kind') IN ('claude', 'codex');
    `,
  },
  {
    version: 43,
    checksum: 'provider-p1b-v43-secret-reference',
    sql: `
      ALTER TABLE provider_connections ADD COLUMN secret_reference TEXT;
    `,
  },
  {
    version: 44,
    checksum: 'provider-p1b-v44-connection-verification',
    sql: `
      ALTER TABLE provider_connections
        ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (verification_status IN (
          'not_required', 'unverified', 'verified', 'verification_expired',
          'invalid_credentials', 'unavailable'
        ));
      ALTER TABLE provider_connections ADD COLUMN verified_at TEXT;
      ALTER TABLE provider_connections ADD COLUMN verification_expires_at TEXT;
      ALTER TABLE provider_connections ADD COLUMN verification_message TEXT;
      UPDATE provider_connections
      SET verification_status = 'not_required'
      WHERE runtime_kind = 'builtin_cli';
    `,
  },
  {
    version: 45,
    checksum: 'provider-p1b-v45-connection-rate-limits',
    sql: `
      ALTER TABLE provider_connections
        ADD COLUMN rate_limit_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK (rate_limit_mode IN ('bypass', 'auto', 'manual'));
      ALTER TABLE provider_connections
        ADD COLUMN max_concurrent_requests INTEGER DEFAULT 2
        CHECK (max_concurrent_requests IS NULL OR max_concurrent_requests >= 1);
      ALTER TABLE provider_connections
        ADD COLUMN requests_per_minute INTEGER
        CHECK (requests_per_minute IS NULL OR requests_per_minute >= 1);
      ALTER TABLE provider_connections
        ADD COLUMN tokens_per_minute INTEGER
        CHECK (tokens_per_minute IS NULL OR tokens_per_minute >= 1);
      ALTER TABLE provider_connections ADD COLUMN last_observed_rate_limit_headers_json TEXT;
      UPDATE provider_connections
      SET rate_limit_mode = 'bypass', max_concurrent_requests = NULL,
          requests_per_minute = NULL, tokens_per_minute = NULL
      WHERE runtime_kind = 'builtin_cli';
    `,
  },
  {
    version: 46,
    checksum: 'provider-p2-v46-turn-usage',
    sql: `
      ALTER TABLE turns ADD COLUMN provider_usage_json TEXT;
    `,
  },
  {
    version: 47,
    checksum: 'provider-p2-v47-team-attempt-result',
    sql: `
      ALTER TABLE team_attempts ADD COLUMN resolved_provider TEXT;
      ALTER TABLE team_attempts ADD COLUMN resolved_model TEXT;
      ALTER TABLE team_attempts ADD COLUMN provider_usage_json TEXT;
    `,
  },
  {
    version: 48,
    checksum: 'provider-p3-v48-routing-resolution',
    sql: `
      ALTER TABLE turns ADD COLUMN resolution_json TEXT;
      ALTER TABLE team_attempts ADD COLUMN resolution_json TEXT;
    `,
  },
  {
    version: 49,
    checksum: 'skills-v2-v49-turn-draft-bindings',
    sql: `
      CREATE TABLE task_draft_skill_bindings (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 6),
        source TEXT NOT NULL CHECK (source IN ('builtin', 'created', 'agents', 'claude')),
        skill_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'team')),
        PRIMARY KEY(task_id, ordinal),
        UNIQUE(task_id, source, skill_id, digest)
      );

      CREATE TABLE turn_skill_bindings (
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 6),
        source TEXT NOT NULL CHECK (source IN ('builtin', 'created', 'agents', 'claude')),
        skill_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'team')),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        package_path TEXT NOT NULL,
        PRIMARY KEY(turn_id, ordinal),
        UNIQUE(turn_id, source, skill_id, digest)
      );
      CREATE INDEX turn_skill_bindings_turn_idx
        ON turn_skill_bindings(turn_id, ordinal);
    `,
  },
  {
    version: 50,
    checksum: 'team-blueprint-v50-pinned-binding',
    sql: `
      ALTER TABLE agents ADD COLUMN blueprint_role_key TEXT;

      CREATE TABLE team_blueprint_bindings (
        team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('builtin', 'created', 'agents', 'claude')),
        skill_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        name TEXT NOT NULL,
        package_path TEXT NOT NULL,
        blueprint_json TEXT NOT NULL,
        bound_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 51,
    checksum: 'chat-work-summary-v51-message-boundary',
    sql: `
      ALTER TABLE messages ADD COLUMN work_content TEXT;
    `,
  },
  {
    version: 52,
    checksum: 'team-long-run-v52-attempt-progress',
    sql: `
      ALTER TABLE team_attempts
        ADD COLUMN start_reason TEXT NOT NULL DEFAULT 'initial'
        CHECK (start_reason IN (
          'initial', 'automatic_retry', 'manual_resume', 'steer', 'app_restart'
        ));
      ALTER TABLE team_attempts ADD COLUMN last_progress_at TEXT;
    `,
  },
  {
    version: 53,
    checksum: 'team-long-run-v53-missions-and-resume',
    sql: `
      CREATE TABLE team_executions_v53 (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        assignee_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (
          'assigned', 'queued', 'waiting_verification', 'waiting_rate_limit',
          'running', 'waiting_resume', 'completed', 'failed', 'canceled'
        )),
        instruction_revision INTEGER NOT NULL DEFAULT 1 CHECK (instruction_revision >= 1),
        queue_ordinal INTEGER,
        queue_reason TEXT CHECK (
          queue_reason IS NULL OR queue_reason IN (
            'global_concurrency', 'connection_concurrency', 'verification',
            'rate_limit', 'budget', 'recovery', 'automatic_retry'
          )
        ),
        connection_id TEXT,
        requested_provider TEXT,
        requested_model TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        assigned_at TEXT NOT NULL,
        queued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, queue_ordinal)
      );
      INSERT INTO team_executions_v53 (
        id, team_id, assignee_agent_id, created_by_agent_id, state,
        instruction_revision, queue_ordinal, queue_reason,
        connection_id, requested_provider, requested_model,
        revision, assigned_at, queued_at, started_at, completed_at, updated_at
      )
        SELECT id, team_id, assignee_agent_id, created_by_agent_id, state,
               instruction_revision, queue_ordinal, queue_reason,
               connection_id, requested_provider, requested_model,
               revision, assigned_at, queued_at, started_at, completed_at, updated_at
        FROM team_executions;
      DROP TABLE team_executions;
      ALTER TABLE team_executions_v53 RENAME TO team_executions;
      CREATE INDEX team_executions_queue_idx
        ON team_executions(state, queue_ordinal, queued_at, id);
      CREATE INDEX team_executions_assignee_idx
        ON team_executions(assignee_agent_id, state, assigned_at, id);

      CREATE TABLE team_missions (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'running', 'waiting_resume', 'completed', 'failed', 'canceled'
        )),
        objective TEXT NOT NULL,
        done_criteria_json TEXT NOT NULL,
        current_step_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (
          current_step_ordinal >= 1 AND current_step_ordinal <= 12
        ),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX team_missions_team_idx ON team_missions(team_id, created_at, id);

      CREATE TABLE team_mission_steps (
        mission_id TEXT NOT NULL REFERENCES team_missions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 12),
        execution_id TEXT NOT NULL UNIQUE REFERENCES team_executions(id) ON DELETE CASCADE,
        access_mode TEXT NOT NULL CHECK (access_mode IN ('read-only', 'workspace-write')),
        checkpoint_json TEXT,
        checkpoint_digest TEXT,
        completed_at TEXT,
        PRIMARY KEY(mission_id, ordinal)
      );
      CREATE INDEX team_mission_steps_execution_idx
        ON team_mission_steps(execution_id);
    `,
    requiresForeignKeysOff: true,
  },
  {
    version: 54,
    checksum: 'team-mission-v54-worker-worktree-integration',
    sql: `
      CREATE TABLE team_mission_step_worktrees (
        execution_id TEXT PRIMARY KEY
          REFERENCES team_mission_steps(execution_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        repo_path TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        base_head TEXT NOT NULL CHECK (
          length(base_head) >= 40 AND length(base_head) <= 64
        ),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'active', 'ready', 'integrated', 'cleaned', 'quarantined'
        )),
        worker_head TEXT CHECK (
          worker_head IS NULL OR (length(worker_head) >= 40 AND length(worker_head) <= 64)
        ),
        integrated_head TEXT CHECK (
          integrated_head IS NULL OR (
            length(integrated_head) >= 40 AND length(integrated_head) <= 64
          )
        ),
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX team_mission_step_worktrees_agent_idx
        ON team_mission_step_worktrees(agent_id, state, created_at);
    `,
  },
  {
    version: 55,
    checksum: 'project-context-hub-v55-project-core',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) >= 1 AND length(name) <= 120),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
      CREATE INDEX tasks_project_activity_idx
        ON tasks(project_id, pinned DESC, updated_at DESC, id);
    `,
  },
  {
    version: 56,
    checksum: 'project-context-hub-v56-context-seals',
    sql: `
      ALTER TABLE projects ADD COLUMN instruction TEXT NOT NULL DEFAULT '';
      ALTER TABLE projects ADD COLUMN context_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (context_epoch >= 0);

      CREATE TABLE context_seals (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('turn', 'team_execution')),
        owner_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        project_revision INTEGER CHECK (project_revision IS NULL OR project_revision >= 1),
        project_context_epoch INTEGER CHECK (
          project_context_epoch IS NULL OR project_context_epoch >= 0
        ),
        candidate_snapshot_digest TEXT NOT NULL CHECK (length(candidate_snapshot_digest) = 64),
        sealed_digest TEXT NOT NULL CHECK (length(sealed_digest) = 64),
        compacted INTEGER NOT NULL CHECK (compacted IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(owner_type, owner_id)
      );
      CREATE INDEX context_seals_task_created_idx
        ON context_seals(task_id, created_at, id);
      CREATE INDEX context_seals_project_epoch_idx
        ON context_seals(project_id, project_context_epoch, created_at);

      CREATE TABLE context_seal_fragments (
        seal_id TEXT NOT NULL REFERENCES context_seals(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        fragment_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (
          source IN ('system', 'history', 'goal', 'compaction', 'background', 'skill')
        ),
        trust TEXT NOT NULL CHECK (trust IN ('system', 'user', 'assistant')),
        token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        message_id TEXT,
        PRIMARY KEY(seal_id, ordinal),
        UNIQUE(seal_id, fragment_id)
      );

      CREATE TABLE project_context_manifest_items (
        seal_id TEXT NOT NULL REFERENCES context_seals(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('instruction', 'memory', 'reference')),
        source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        source_turn_id TEXT,
        source_reference_id TEXT,
        candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
        sealed_digest TEXT CHECK (sealed_digest IS NULL OR length(sealed_digest) = 64),
        included INTEGER NOT NULL CHECK (included IN (0, 1)),
        exclusion_reason TEXT,
        authority TEXT NOT NULL CHECK (authority IN ('user', 'none')),
        local_only INTEGER NOT NULL CHECK (local_only IN (0, 1)),
        content TEXT,
        captured_at TEXT NOT NULL,
        PRIMARY KEY(seal_id, ordinal),
        UNIQUE(seal_id, item_id),
        CHECK (
          (included = 1 AND sealed_digest IS NOT NULL AND content IS NOT NULL
            AND exclusion_reason IS NULL)
          OR
          (included = 0 AND sealed_digest IS NULL AND content IS NULL
            AND exclusion_reason IS NOT NULL)
        )
      );

      ALTER TABLE input_queue ADD COLUMN payload_digest TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 57,
    checksum: 'project-context-hub-v57-reference-files',
    sql: `
      CREATE TABLE project_references (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL CHECK (length(relative_path) >= 1 AND length(relative_path) <= 1024),
        registered_root_identity TEXT NOT NULL CHECK (length(registered_root_identity) = 64),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        last_sealed_digest TEXT CHECK (last_sealed_digest IS NULL OR length(last_sealed_digest) = 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, source_task_id, relative_path)
      );
      CREATE INDEX project_references_project_order_idx
        ON project_references(project_id, created_at, id);
      CREATE INDEX project_references_source_task_idx
        ON project_references(source_task_id, id);
    `,
  },
  {
    version: 58,
    checksum: 'project-context-hub-v58-explicit-memory',
    sql: `
      CREATE TABLE project_memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        source_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
        content TEXT NOT NULL CHECK (length(content) >= 1 AND length(content) <= 4000),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        local_only INTEGER NOT NULL CHECK (local_only IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX project_memories_project_order_idx
        ON project_memories(project_id, status, updated_at DESC, id);
    `,
  },
  {
    version: 59,
    checksum: 'project-context-hub-v59-memory-provenance',
    sql: `
      ALTER TABLE project_memories ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user'
        CHECK (created_by IN ('user', 'assistant'));
    `,
  },
  {
    version: 60,
    checksum: 'project-multi-folder-v60-foundation',
    sql: `
      ALTER TABLE tasks ADD COLUMN legacy_project_workspace_fallback INTEGER NOT NULL DEFAULT 0
        CHECK (legacy_project_workspace_fallback IN (0, 1));
      UPDATE tasks SET legacy_project_workspace_fallback = 1
        WHERE project_id IS NOT NULL AND workspace_path IS NOT NULL;
      ALTER TABLE projects ADD COLUMN workspace_roots_configured INTEGER NOT NULL DEFAULT 0
        CHECK (workspace_roots_configured IN (0, 1));

      CREATE TABLE project_workspace_roots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        canonical_path TEXT NOT NULL,
        label TEXT NOT NULL CHECK (length(label) >= 1 AND length(label) <= 255),
        role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 16),
        workspace_key TEXT NOT NULL CHECK (length(workspace_key) = 64),
        root_identity_digest TEXT NOT NULL CHECK (length(root_identity_digest) = 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, root_identity_digest)
      );
      CREATE UNIQUE INDEX project_workspace_roots_primary_idx
        ON project_workspace_roots(project_id) WHERE role = 'primary';
      CREATE INDEX project_workspace_roots_project_order_idx
        ON project_workspace_roots(project_id, ordinal, id);
      CREATE INDEX project_workspace_roots_project_path_idx
        ON project_workspace_roots(project_id, canonical_path, id);

      ALTER TABLE project_references RENAME TO project_references_v57;
      CREATE TABLE project_references (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        project_root_id TEXT REFERENCES project_workspace_roots(id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL CHECK (length(relative_path) >= 1 AND length(relative_path) <= 1024),
        registered_root_identity TEXT NOT NULL CHECK (length(registered_root_identity) = 64),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        last_sealed_digest TEXT CHECK (last_sealed_digest IS NULL OR length(last_sealed_digest) = 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((source_task_id IS NULL) <> (project_root_id IS NULL))
      );
      INSERT INTO project_references(
        id, project_id, source_task_id, project_root_id, relative_path,
        registered_root_identity, enabled, revision, last_sealed_digest, created_at, updated_at
      ) SELECT id, project_id, source_task_id, NULL, relative_path,
          registered_root_identity, enabled, revision, last_sealed_digest, created_at, updated_at
        FROM project_references_v57;
      DROP TABLE project_references_v57;
      CREATE UNIQUE INDEX project_references_task_path_idx
        ON project_references(project_id, source_task_id, relative_path)
        WHERE source_task_id IS NOT NULL;
      CREATE UNIQUE INDEX project_references_root_path_idx
        ON project_references(project_id, project_root_id, relative_path)
        WHERE project_root_id IS NOT NULL;
      CREATE INDEX project_references_project_order_idx
        ON project_references(project_id, created_at, id);
      CREATE INDEX project_references_source_task_idx
        ON project_references(source_task_id, id) WHERE source_task_id IS NOT NULL;
      CREATE INDEX project_references_project_root_idx
        ON project_references(project_root_id, id) WHERE project_root_id IS NOT NULL;

      CREATE TABLE turn_workspace_sets (
        turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('project', 'task', 'none')),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        primary_root_id TEXT,
        root_set_digest TEXT NOT NULL CHECK (length(root_set_digest) = 64),
        created_at TEXT NOT NULL
      );
      CREATE TABLE turn_workspace_roots (
        turn_id TEXT NOT NULL REFERENCES turn_workspace_sets(turn_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 16),
        root_id TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        label TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
        workspace_key TEXT NOT NULL CHECK (length(workspace_key) = 64),
        root_identity_digest TEXT NOT NULL CHECK (length(root_identity_digest) = 64),
        PRIMARY KEY(turn_id, ordinal),
        UNIQUE(turn_id, root_id)
      );
    `,
    requiresForeignKeysOff: true,
  },
  {
    version: 61,
    checksum: 'edit-saga-root-binding-v61',
    sql: `
      ALTER TABLE edit_sagas ADD COLUMN root_id TEXT;
      ALTER TABLE edit_sagas ADD COLUMN root_binding_version INTEGER NOT NULL DEFAULT 0
        CHECK (root_binding_version IN (0, 1));
      ALTER TABLE workspace_mutation_state ADD COLUMN root_id TEXT;
    `,
  },
  {
    version: 62,
    checksum: 'team-execution-access-mode-v62',
    sql: `
      ALTER TABLE team_executions ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'read-only'
        CHECK (access_mode IN ('read-only', 'workspace-write'));
      UPDATE team_executions SET access_mode = COALESCE(
        (SELECT access_mode FROM team_mission_steps
         WHERE team_mission_steps.execution_id = team_executions.id),
        'read-only'
      );
    `,
  },
  {
    version: 63,
    checksum: 'team-multi-repository-isolation-v63',
    sql: `
      CREATE TABLE team_execution_isolations (
        execution_id TEXT PRIMARY KEY REFERENCES team_executions(id) ON DELETE CASCADE,
        phase TEXT NOT NULL CHECK (phase IN (
          'preparing', 'running', 'finalizing', 'integrating',
          'waiting_resume', 'completed', 'quarantined'
        )),
        resume_kind TEXT CHECK (resume_kind IS NULL OR resume_kind IN ('worker', 'integration')),
        repositories_json TEXT NOT NULL,
        roots_json TEXT NOT NULL,
        reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX team_execution_isolations_phase_idx
        ON team_execution_isolations(phase, updated_at, execution_id);

      CREATE TABLE team_integration_root_leases (
        mutation_key TEXT PRIMARY KEY CHECK (length(mutation_key) = 64),
        root_id TEXT NOT NULL,
        execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
        root_identity TEXT NOT NULL CHECK (length(root_identity) = 64),
        acquired_at TEXT NOT NULL
      );
      CREATE INDEX team_integration_root_leases_execution_idx
        ON team_integration_root_leases(execution_id, root_id);

      CREATE TABLE team_execution_isolation_completions (
        execution_id TEXT PRIMARY KEY REFERENCES team_execution_isolations(execution_id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES team_attempts(id),
        team_task_id TEXT NOT NULL REFERENCES team_tasks(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        report_json TEXT NOT NULL,
        done_evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 64,
    checksum: 'goal-control-v64-lifecycle',
    sql: `
      ALTER TABLE tasks ADD COLUMN goal_status TEXT
        CHECK (goal_status IS NULL OR goal_status IN ('active', 'paused', 'completed', 'blocked'));
      ALTER TABLE tasks ADD COLUMN goal_token_budget INTEGER
        CHECK (goal_token_budget IS NULL OR goal_token_budget > 0);
      ALTER TABLE tasks ADD COLUMN goal_tokens_used INTEGER NOT NULL DEFAULT 0
        CHECK (goal_tokens_used >= 0);
      ALTER TABLE tasks ADD COLUMN goal_time_used_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (goal_time_used_seconds >= 0);
      ALTER TABLE tasks ADD COLUMN goal_started_at TEXT;
      ALTER TABLE tasks ADD COLUMN goal_updated_at TEXT;
      UPDATE tasks
         SET goal_status = 'paused', goal_started_at = updated_at, goal_updated_at = updated_at
       WHERE goal IS NOT NULL AND length(trim(goal)) > 0;
    `,
  },
  {
    version: 65,
    checksum: 'team-waiting-integration-v65',
    sql: `
      DROP INDEX team_execution_isolations_phase_idx;
      ALTER TABLE team_execution_isolation_completions
        RENAME TO team_execution_isolation_completions_v64;
      ALTER TABLE team_execution_isolations RENAME TO team_execution_isolations_v64;

      CREATE TABLE team_execution_isolations (
        execution_id TEXT PRIMARY KEY REFERENCES team_executions(id) ON DELETE CASCADE,
        phase TEXT NOT NULL CHECK (phase IN (
          'preparing', 'running', 'finalizing', 'waiting_integration', 'integrating',
          'waiting_resume', 'completed', 'quarantined'
        )),
        resume_kind TEXT CHECK (resume_kind IS NULL OR resume_kind IN ('worker', 'integration')),
        repositories_json TEXT NOT NULL,
        roots_json TEXT NOT NULL,
        reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX team_execution_isolations_phase_idx
        ON team_execution_isolations(phase, updated_at, execution_id);

      INSERT INTO team_execution_isolations
      SELECT * FROM team_execution_isolations_v64;

      CREATE TABLE team_execution_isolation_completions (
        execution_id TEXT PRIMARY KEY REFERENCES team_execution_isolations(execution_id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES team_attempts(id),
        team_task_id TEXT NOT NULL REFERENCES team_tasks(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        report_json TEXT NOT NULL,
        done_evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO team_execution_isolation_completions
      SELECT * FROM team_execution_isolation_completions_v64;

      DROP TABLE team_execution_isolation_completions_v64;
      DROP TABLE team_execution_isolations_v64;
    `,
  },
  {
    version: 66,
    checksum: 'provider-automatic-model-release-v66',
    sql: `
      ALTER TABLE provider_connections ADD COLUMN automatic_model_release INTEGER NOT NULL DEFAULT 0
        CHECK (automatic_model_release IN (0, 1));
      UPDATE provider_connections
         SET automatic_model_release = 1
       WHERE provider_id = 'ollama';
    `,
  },
  {
    version: 67,
    checksum: 'image-attachment-drafts-v67',
    sql: `
      CREATE UNIQUE INDEX messages_id_task_unique ON messages(id, task_id);
      CREATE TABLE image_attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('draft', 'message')),
        file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 5242880),
        sha256 TEXT NOT NULL CHECK (
          length(sha256) = 64
          AND sha256 = lower(sha256)
          AND sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        bytes BLOB NOT NULL CHECK (length(bytes) = byte_length),
        created_at TEXT NOT NULL,
        CHECK (
          (state = 'draft' AND message_id IS NULL) OR
          (state = 'message' AND message_id IS NOT NULL)
        ),
        FOREIGN KEY (message_id, task_id) REFERENCES messages(id, task_id) ON DELETE CASCADE
      );
      CREATE INDEX image_attachments_task_draft_idx
        ON image_attachments(task_id, created_at, id) WHERE state = 'draft';
      CREATE INDEX image_attachments_message_idx
        ON image_attachments(message_id, created_at, id);
    `,
  },
  {
    version: 68,
    checksum: 'image-attachment-message-order-v68',
    sql: `
      CREATE TABLE image_attachment_v68_migration_guard (
        valid INTEGER NOT NULL CHECK (valid = 1)
      );
      INSERT INTO image_attachment_v68_migration_guard(valid)
        SELECT 0 FROM image_attachments WHERE state = 'message' LIMIT 1;
      DROP TABLE image_attachment_v68_migration_guard;
      ALTER TABLE image_attachments ADD COLUMN message_ordinal INTEGER
        CHECK (message_ordinal IS NULL OR message_ordinal BETWEEN 0 AND 3);
      CREATE UNIQUE INDEX image_attachments_message_ordinal_idx
        ON image_attachments(message_id, message_ordinal) WHERE state = 'message';
      CREATE TRIGGER image_attachments_state_insert_guard
      BEFORE INSERT ON image_attachments
      WHEN NOT (
        (NEW.state = 'draft' AND NEW.message_id IS NULL AND NEW.message_ordinal IS NULL) OR
        (NEW.state = 'message' AND NEW.message_id IS NOT NULL
          AND NEW.message_ordinal BETWEEN 0 AND 3)
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid image attachment ownership state');
      END;
      CREATE TRIGGER image_attachments_state_update_guard
      BEFORE UPDATE OF state, message_id, message_ordinal ON image_attachments
      WHEN NOT (
        (NEW.state = 'draft' AND NEW.message_id IS NULL AND NEW.message_ordinal IS NULL) OR
        (NEW.state = 'message' AND NEW.message_id IS NOT NULL
          AND NEW.message_ordinal BETWEEN 0 AND 3)
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid image attachment ownership state');
      END;
    `,
  },
  {
    version: 69,
    checksum: 'runtime-failure-diagnostics-v69',
    sql: `
      CREATE TABLE runtime_failure_diagnostics (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
        runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('codex', 'claude')),
        failure_stage TEXT NOT NULL CHECK (failure_stage IN (
          'first_event_timeout', 'idle_timeout', 'total_timeout', 'protocol_error',
          'startup_error', 'spawn_error', 'abnormal_exit'
        )),
        diagnostic_json TEXT NOT NULL
          CHECK (length(CAST(diagnostic_json AS BLOB)) <= 16384),
        created_at TEXT NOT NULL
      );
      CREATE INDEX runtime_failure_diagnostics_task_created_idx
        ON runtime_failure_diagnostics(task_id, created_at DESC, id DESC);
    `,
  },
  {
    version: 70,
    checksum: 'user-file-save-intent-v70',
    sql: `
      CREATE TABLE user_file_save_intents (
        principal TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        root_id TEXT NOT NULL,
        root_label TEXT NOT NULL,
        path TEXT NOT NULL,
        base_digest TEXT NOT NULL CHECK (length(base_digest) = 64),
        replacement_digest TEXT NOT NULL CHECK (length(replacement_digest) = 64),
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        state TEXT NOT NULL CHECK (state IN ('prepared', 'completed', 'recovery_required')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(principal, task_id, kind, operation_id),
        UNIQUE(principal, task_id, kind, request_hash, root_id, path, base_digest, replacement_digest)
      );
      CREATE INDEX user_file_save_intents_recovery_idx
        ON user_file_save_intents(state, created_at, operation_id);
    `,
  },
];

// Canvas view persistence (Slice 6.1, FR-CAN-02/06): per-Task camera + Worker node layout.
// Bounds mirror packages/contracts's canvasCameraSchema/canvasNodePositionSchema (kept as literal
// duplicates here, not imports, since main must reject bad data even if a caller bypasses the IPC
// schema — e.g. direct PersistenceClient use in tests).
/** Placeholder a Task is born with. Auto-naming replaces it on the first message (issue #4). */
export const DEFAULT_TASK_TITLE = '新しいタスク';

export const CANVAS_MIN_SCALE = 0.18;
export const CANVAS_MAX_SCALE = 1.6;
export const CANVAS_WORLD_BOUND = 20_000;
// Domain max is leader + 3 workers; headroom is left for future node kinds (kept in sync with
// packages/contracts's canvasNodePositionsSchema).
export const CANVAS_NODE_POSITIONS_MAX_ENTRIES = 32;
// Defends against a pathological serialized payload independent of the entry-count cap above.
export const CANVAS_VIEW_MAX_SERIALIZED_BYTES = 16 * 1024;

export type CanvasCameraRecord = { x: number; y: number; scale: number };
export type CanvasViewRecord = {
  taskId: string;
  camera: CanvasCameraRecord;
  nodePositions: Record<string, { x: number; y: number }>;
  revision: number;
  updatedAt: string;
};

export type DraftImageAttachmentInput = Readonly<{
  taskId: string;
  fileName: string;
  mimeType: ImageAttachmentMimeType;
  bytes: Buffer;
  createdAt?: string;
}>;

type ImageAttachmentRow = Readonly<{
  id: string;
  task_id: string;
  message_id: string | null;
  state: 'draft' | 'message';
  file_name: string;
  mime_type: ImageAttachmentMimeType;
  byte_length: number;
  sha256: string;
  bytes: Buffer;
  created_at: string;
  message_ordinal: number | null;
}>;

type ImageAttachmentMetadataRow = Pick<
  ImageAttachmentRow,
  'id' | 'message_id' | 'file_name' | 'mime_type' | 'byte_length' | 'created_at'
>;

function toImageAttachmentMetadata(row: ImageAttachmentMetadataRow): ImageAttachmentMetadata {
  return imageAttachmentMetadataSchema.parse({
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    createdAt: row.created_at,
  });
}

function assertCanvasCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > CANVAS_WORLD_BOUND)
    throw new InvalidCanvasViewError(`${label} is out of the allowed world range`);
}

export function validateCanvasCamera(camera: CanvasCameraRecord): void {
  assertCanvasCoordinate(camera.x, 'camera.x');
  assertCanvasCoordinate(camera.y, 'camera.y');
  if (
    !Number.isFinite(camera.scale) ||
    camera.scale < CANVAS_MIN_SCALE ||
    camera.scale > CANVAS_MAX_SCALE
  )
    throw new InvalidCanvasViewError('camera.scale is out of the allowed zoom range');
}

export function validateCanvasNodePositions(
  positions: Readonly<Record<string, { x: number; y: number }>>,
): void {
  if (Object.keys(positions).length > CANVAS_NODE_POSITIONS_MAX_ENTRIES)
    throw new InvalidCanvasViewError(
      `nodePositions cannot have more than ${CANVAS_NODE_POSITIONS_MAX_ENTRIES} entries`,
    );
  for (const [agentId, position] of Object.entries(positions)) {
    assertCanvasCoordinate(position.x, `nodePositions.${agentId}.x`);
    assertCanvasCoordinate(position.y, `nodePositions.${agentId}.y`);
  }
}

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
  modelSelection: ModelSelection;
  skills: PersistedTurnSkill[];
  /** Computed once with context sealing and reused by dispatch so Team routing cannot diverge. */
  teamTurn: boolean;
  event: TurnEvent;
  sealId: string;
  contextUsageEvents: TurnEvent[];
  /** Immutable Workspace roots sealed in the same transaction as the Turn. */
  workspaceSet: EffectiveWorkspaceSet;
  /** Present only when this Turn's message triggered automatic naming (issue #4), so the caller
   * can push the new title to the renderer without a dedicated event. */
  renamedTask?: TaskSummary;
};
export type StartedGoalTurn = { task: TaskSummary; started: StartedTurn };
export type QueueTransition = { started: StartedTurn; queueEvent: TurnEvent } | null;
export type StopAndSendTransition = {
  canceledEvent: TurnEvent | null;
  started: StartedTurn;
};

export type ContextSealOwnerType = 'turn' | 'team_execution';
export type ProjectContextManifestItem = Readonly<{
  itemId: string;
  kind: 'instruction' | 'memory' | 'reference';
  sourceTaskId: string | null;
  sourceTurnId: string | null;
  sourceReferenceId: string | null;
  candidateDigest: string;
  sealedDigest: string | null;
  included: boolean;
  exclusionReason: string | null;
  authority: 'user' | 'none';
  localOnly: boolean;
  content: string | null;
  capturedAt: string;
}>;
export type ContextSealManifest = Readonly<{
  sealId: string;
  ownerType: ContextSealOwnerType;
  ownerId: string;
  taskId: string;
  projectId: string | null;
  projectRevision: number | null;
  projectContextEpoch: number | null;
  candidateSnapshotDigest: string;
  sealedDigest: string;
  compacted: boolean;
  createdAt: string;
  items: readonly ProjectContextManifestItem[];
}>;
export type PersistedTurnSkill = Readonly<{
  selection: TurnSkillSelection;
  name: string;
  description: string;
  content: string;
  packagePath: string;
}>;
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
export type PersistedRuntimeFailureDiagnostic = RuntimeFailureDiagnostic &
  Readonly<{ taskId: string; turnId: string }>;
type PersistedJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly PersistedJsonValue[]
  | Readonly<{ [key: string]: PersistedJsonValue }>;
export type TeamRecord = Readonly<{
  id: string;
  taskId: string;
  state: TeamState;
  leaderAgentId: string;
  budget: Readonly<Record<string, PersistedJsonValue>>;
  policy: TeamPolicy;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type AgentRecord = Readonly<{
  id: string;
  teamId: string | null;
  threadId: string;
  taskId: string;
  kind: 'leader' | 'worker';
  role: string;
  state: WorkerState;
  objective: string | null;
  parentCapabilityCeiling: CapabilityCeiling | null;
  contextInheritancePolicy: ContextInheritancePolicy | null;
  writeCapable: boolean;
  currentActivity: string | null;
  runtimeKind: RuntimeKind;
  modelSelection: ModelSelection;
  parentAgentId: string | null;
  depth: number;
  canDelegate: boolean;
  managerPolicy: ManagerPolicy | null;
  blueprintRoleKey: string | null;
  createdAt: string;
  updatedAt: string;
}>;
export type TeamBlueprintBindingRecord = Readonly<{
  teamId: string;
  selection: TurnSkillSelection;
  name: string;
  packagePath: string;
  blueprint: TeamBlueprint;
  boundAt: string;
}>;
export type TurnModelIdentity = Readonly<{
  selection: ModelSelection;
  resolution: ExecutionResolution;
}>;
export type TeamBudgetReservationRecord = Readonly<{
  id: string;
  teamId: string;
  agentId: string | null;
  scope: BudgetScope;
  kind: BudgetKind;
  amount: number;
  settledAmount: number | null;
  state: BudgetReservationState;
  purpose: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type TeamDeliveryRecord = Readonly<{
  messageId: string;
  deliveryId: string;
  state: TeamDeliveryState;
  attempt: number;
  lastError: string | null;
  dispatchedAt: string | null;
  ackedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type WorkerWorktreeRecord = Readonly<{
  agentId: string;
  path: string;
  baseHead: string;
  state: WorkerWorktreeState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}>;
export type TeamMessageRecord = Readonly<{
  id: string;
  teamId: string;
  sourceAgentId: string;
  targetAgentId: string;
  seq: number;
  state: TeamMessageState;
  content: string;
  executionId: string | null;
  attemptId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type TeamTaskRecord = Readonly<{
  id: string;
  teamId: string;
  messageId: string | null;
  assigneeAgentId: string;
  createdByAgentId: string;
  description: string;
  status:
    | 'created'
    | 'assigned'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'blocked'
    | 'failed'
    | 'canceled';
  doneCriteria: readonly string[];
  doneEvidence: readonly { criterion: string; evidence: string }[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type TeamExecutionRecord = Readonly<{
  id: string;
  teamId: string;
  assigneeAgentId: string;
  createdByAgentId: string;
  accessMode: TeamMissionAccess;
  state: TeamExecutionState;
  instruction: ExecutionInstruction;
  queueOrdinal: number | null;
  queueReason: TeamQueueReason | null;
  modelSelection: ModelSelection;
  revision: number;
  assignedAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;
export const teamAttemptStartReasons = [
  'initial',
  'automatic_retry',
  'manual_resume',
  'steer',
  'app_restart',
] as const;
export type TeamAttemptStartReason = (typeof teamAttemptStartReasons)[number];
export type TeamAttemptRecord = Readonly<{
  id: string;
  executionId: string;
  ordinal: number;
  state: TeamAttemptState;
  instructionRevision: number;
  modelSelection: ModelSelection;
  providerCallOrdinal: number;
  terminalReason: string | null;
  startReason: TeamAttemptStartReason;
  lastProgressAt: string | null;
  resolution: ExecutionResolution;
  providerUsage: NormalizedProviderUsage | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}>;
export type TeamMissionStepRecord = Readonly<{
  missionId: string;
  ordinal: number;
  executionId: string;
  access: TeamMissionAccess;
  checkpoint: TeamMissionCheckpoint | null;
  checkpointDigest: string | null;
  completedAt: string | null;
}>;
export type TeamMissionWorktreeRecord = Readonly<{
  executionId: string;
  agentId: string;
  repoPath: string;
  path: string;
  baseHead: string;
  state: TeamMissionWorktreeState;
  workerHead: string | null;
  integratedHead: string | null;
  changedFiles: readonly string[];
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}>;
export type TeamExecutionIsolationRecord = Readonly<
  TeamExecutionIsolation & {
    executionId: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
  }
>;
export type TeamExecutionIsolationCompletionRecord = Readonly<{
  executionId: string;
  attemptId: string;
  teamTaskId: string;
  agentId: string;
  report: WorkerReport;
  doneEvidence: readonly { criterion: string; evidence: string }[];
  createdAt: string;
}>;
export type TeamMissionRecord = Readonly<{
  id: string;
  teamId: string;
  createdByAgentId: string;
  state: TeamMissionState;
  objective: string;
  doneCriteria: readonly string[];
  currentStepOrdinal: number;
  steps: readonly TeamMissionStepRecord[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

export type TeamIntegrityReport = Readonly<{
  sqlite: 'ok' | 'corrupt';
  inconsistencies: readonly string[];
}>;
export type TeamV2ActivityRecord = Readonly<{
  id: string;
  teamId: string;
  seq: number;
  type: TeamV2ActivityType;
  actorAgentId: string | null;
  subjectAgentId: string | null;
  executionId: string | null;
  attemptId: string | null;
  payload: unknown;
  recordedAt: string;
}>;
export type TeamExecutionDispatchRecord = Readonly<{
  messageId: string;
  messageSeq: number;
  teamTaskId: string;
  doneCriteria: readonly string[];
}>;
export type TeamSnapshot = Readonly<{
  team: TeamRecord;
  agents: readonly AgentRecord[];
  messages: readonly TeamMessageRecord[];
  deliveries: readonly TeamDeliveryRecord[];
}>;

export type NativeMutationSagaCoordinator = 'native-intent' | 'edit-saga-executor';

export interface PersistenceClient {
  setSkillCatalogContextProvider?(
    provider: (
      selections: readonly TurnSkillSelection[],
      includeBuiltinTeamSkill: boolean,
    ) => string,
  ): void;
  listProviderConnections(): readonly ProviderConnection[];
  getProviderConnection(connectionId: string): ProviderConnection;
  createProviderConnection(connection: ProviderConnection): ProviderConnection;
  setProviderConnectionAutomaticModelRelease(
    connectionId: string,
    automaticModelRelease: boolean,
  ): ProviderConnection;
  setProviderConnectionSecretReference(
    connectionId: string,
    secretReference: string | null,
  ): ProviderConnection;
  updateProviderConnectionVerification(
    connectionId: string,
    verification: ProviderConnection['verification'],
  ): ProviderConnection;
  lowerProviderConnectionRateLimits(
    connectionId: string,
    limits: Partial<
      Pick<
        ProviderConnection['rateLimit'],
        'maxConcurrentRequests' | 'requestsPerMinute' | 'tokensPerMinute'
      >
    >,
  ): ProviderConnection;
  listTasks(): TaskSummary[];
  getTask(taskId: string): TaskSummary;
  createTask(title?: string, localOnly?: boolean, projectId?: string): TaskSummary;
  listProjects(): ProjectSummary[];
  createProject(
    input: string | { name: string; folders?: readonly ProjectFolderBinding[] },
  ): ProjectSummary;
  listProjectFolders(projectId: string): ProjectFolder[];
  getProjectFolderRootIdentities(projectId: string): ReadonlyMap<string, string>;
  getEffectiveWorkspaceRootIdentities(taskId: string): ReadonlyMap<string, string>;
  getEffectiveWorkspaceMutationBindings(
    taskId: string,
  ): ReadonlyMap<string, Readonly<{ workspaceKey: string; rootIdentityDigest: string }>>;
  getTurnWorkspaceRootIdentities(turnId: string): ReadonlyMap<string, string>;
  getTurnWorkspaceMutationBindings(
    turnId: string,
  ): ReadonlyMap<string, Readonly<{ workspaceKey: string; rootIdentityDigest: string }>>;
  replaceProjectFolders(input: {
    projectId: string;
    expectedRevision: number;
    folders: readonly ProjectFolderBinding[];
  }): ProjectSummary;
  updateProject(input: {
    projectId: string;
    expectedRevision: number;
    name?: string | undefined;
    archived?: boolean | undefined;
  }): ProjectSummary;
  getProjectInstruction(projectId: string): {
    instruction: string;
    revision: number;
    contextEpoch: number;
  };
  setProjectInstruction(input: {
    projectId: string;
    expectedRevision: number;
    instruction: string;
  }): { instruction: string; revision: number; contextEpoch: number };
  listProjectReferences(projectId: string): ProjectReference[];
  addProjectReference(input: {
    projectId: string;
    sourceTaskId?: string;
    projectRootId?: string;
    relativePath: string;
    registeredRootIdentity: string;
  }): ProjectReference;
  updateProjectReference(input: {
    referenceId: string;
    expectedRevision: number;
    enabled: boolean;
  }): ProjectReference;
  removeProjectReference(referenceId: string, expectedRevision: number): void;
  getEffectiveWorkspaceSet(taskId: string): EffectiveWorkspaceSet;
  sealTurnWorkspaceSet(taskId: string, turnId: string): EffectiveWorkspaceSet;
  readTurnWorkspaceSet(turnId: string): EffectiveWorkspaceSet | null;
  readTurnWorkspaceSetForTask(taskId: string, turnId: string): EffectiveWorkspaceSet | null;
  listProjectMemories(projectId: string): ProjectMemory[];
  createProjectMemoryFromTurn(input: {
    projectId: string;
    sourceTurnId: string;
    content: string;
  }): ProjectMemory;
  createAgentProjectMemoryFromTurn(input: {
    projectId: string;
    sourceTurnId: string;
    content: string;
  }): ProjectMemory;
  updateProjectMemory(input: {
    memoryId: string;
    expectedRevision: number;
    content?: string | undefined;
    status?: 'active' | 'disabled' | undefined;
  }): ProjectMemory;
  listProjectContextManifests(taskId: string): ProjectContextManifestSummary[];
  getProjectContextManifest(taskId: string, turnId: string): PublicProjectContextManifest;
  assignTaskToProject(input: {
    projectId: string;
    taskId: string;
    expectedProjectId: string | null;
  }): TaskSummary;
  unassignTaskFromProject(input: { taskId: string; expectedProjectId: string | null }): TaskSummary;
  getTaskModelSelection(taskId: string): ModelSelection | null;
  getImageAttachmentAcceptanceSelection(taskId: string): ImageAttachmentAcceptanceSelection;
  setTaskModelSelection(taskId: string, selection: ModelSelection): ModelSelection | null;
  getTaskLeader(taskId: string): AgentRecord;
  setAgentModelSelection(agentId: string, selection: ModelSelection): AgentRecord;
  promoteTaskToTeam(taskId: string): TeamRecord;
  getTeam(teamId: string): TeamRecord;
  getTeamByTask(taskId: string): TeamRecord | null;
  getTeamSnapshot(teamId: string): TeamSnapshot;
  transitionTeamState(teamId: string, to: TeamState): TeamRecord;
  reformCompletedTeam(teamId: string): TeamRecord;
  updateTeamPolicy(teamId: string, policy: TeamPolicy, expectedRevision: number): TeamRecord;
  getTeamBlueprint(teamId: string): TeamBlueprintBindingRecord | null;
  bindTeamBlueprint(input: {
    teamId: string;
    selection: TurnSkillSelection;
    name: string;
    packagePath: string;
    blueprint: TeamBlueprint;
  }): TeamBlueprintBindingRecord;
  registerTeamWorker(input: {
    teamId: string;
    role: string;
    objective: string;
    parentCapabilityCeiling: CapabilityCeiling;
    contextInheritancePolicy: ContextInheritancePolicy;
    runtimeKind?: RuntimeKind;
    modelSelection?: ModelSelection;
    modelSelectionReason?: string;
    writeCapable?: boolean;
    parentAgentId?: string;
    canDelegate?: boolean;
    managerPolicy?: ManagerPolicy | null;
    blueprintRoleKey?: string;
  }): AgentRecord;
  transitionWorkerState(agentId: string, to: WorkerState): AgentRecord;
  createTeamExecution(input: {
    teamId: string;
    assigneeAgentId: string;
    createdByAgentId: string;
    instruction: string;
    accessMode?: TeamMissionAccess;
    now: string;
    contextOwner?: { type: ContextSealOwnerType; id: string };
  }): TeamExecutionRecord;
  getTeamExecution(executionId: string): TeamExecutionRecord;
  listTeamExecutions(teamId: string): readonly TeamExecutionRecord[];
  listQueuedTeamExecutions(teamId: string): readonly TeamExecutionRecord[];
  getTeamExecutionDispatch(executionId: string): TeamExecutionDispatchRecord;
  transitionTeamExecution(input: {
    executionId: string;
    to: TeamExecutionState;
    now: string;
    queueReason?: TeamQueueReason | null;
  }): TeamExecutionRecord;
  reviseQueuedTeamExecution(input: {
    executionId: string;
    createdByAgentId: string;
    instruction: string;
    now: string;
  }): TeamExecutionRecord;
  cancelQueuedTeamExecution(executionId: string, now: string): TeamExecutionRecord;
  createTeamAttempt(
    executionId: string,
    now: string,
    startReason?: TeamAttemptStartReason,
  ): TeamAttemptRecord;
  getTeamAttempt(attemptId: string): TeamAttemptRecord;
  listTeamAttempts(executionId: string): readonly TeamAttemptRecord[];
  transitionTeamAttempt(input: {
    attemptId: string;
    to: TeamAttemptState;
    now: string;
    terminalReason?: string | null;
  }): TeamAttemptRecord;
  recordTeamAttemptRateLimited(attemptId: string, now: string): TeamAttemptRecord;
  touchTeamAttemptProgress(attemptId: string, now: string): TeamAttemptRecord;
  createTeamMission(input: {
    teamId: string;
    createdByAgentId: string;
    objective: string;
    doneCriteria: readonly string[];
    steps: readonly {
      workerId: string;
      objective: string;
      doneCriteria: readonly string[];
      access: TeamMissionAccess;
    }[];
    now: string;
    contextOwner?: { type: ContextSealOwnerType; id: string };
  }): TeamMissionRecord;
  getTeamMission(missionId: string): TeamMissionRecord;
  listTeamMissions(teamId: string): readonly TeamMissionRecord[];
  getTeamMissionForExecution(executionId: string): TeamMissionRecord | null;
  recordTeamMissionWorktree(input: {
    executionId: string;
    agentId: string;
    repoPath: string;
    path: string;
    baseHead: string;
    now: string;
  }): TeamMissionWorktreeRecord;
  updateTeamMissionWorktree(input: {
    executionId: string;
    to: TeamMissionWorktreeState;
    workerHead?: string | null;
    integratedHead?: string | null;
    changedFiles?: readonly string[];
    reason?: string | null;
    now: string;
  }): TeamMissionWorktreeRecord;
  getTeamMissionWorktree(executionId: string): TeamMissionWorktreeRecord | null;
  createTeamExecutionIsolation(input: {
    executionId: string;
    repositories: TeamExecutionIsolation['repositories'];
    roots: TeamExecutionIsolation['roots'];
    now: string;
  }): TeamExecutionIsolationRecord;
  updateTeamExecutionIsolation(input: {
    executionId: string;
    phase: TeamExecutionIsolation['phase'];
    repositories?: TeamExecutionIsolation['repositories'];
    roots?: TeamExecutionIsolation['roots'];
    resumeKind?: TeamExecutionIsolation['resumeKind'];
    reason?: string | null;
    now: string;
  }): TeamExecutionIsolationRecord;
  getTeamExecutionIsolation(executionId: string): TeamExecutionIsolationRecord | null;
  listTeamExecutionIsolations(): readonly TeamExecutionIsolationRecord[];
  saveTeamExecutionIsolationCompletion(input: {
    executionId: string;
    attemptId: string;
    teamTaskId: string;
    agentId: string;
    report: WorkerReport;
    doneEvidence: readonly { criterion: string; evidence: string }[];
    now: string;
  }): TeamExecutionIsolationCompletionRecord;
  getTeamExecutionIsolationCompletion(
    executionId: string,
  ): TeamExecutionIsolationCompletionRecord | null;
  deleteTeamExecutionIsolationCompletion(executionId: string): void;
  acquireTeamIntegrationRootLeases(input: {
    executionId: string;
    roots: readonly Pick<
      TeamExecutionIsolation['roots'][number],
      'rootId' | 'mutationKey' | 'identity'
    >[];
    now: string;
  }): void;
  releaseTeamIntegrationRootLeases(executionId: string): void;
  transitionTeamMission(missionId: string, to: TeamMissionState, now: string): TeamMissionRecord;
  prepareTeamMissionResume(input: {
    missionId: string;
    executionId: string;
    now: string;
  }): TeamExecutionRecord;
  recordTeamMissionCheckpoint(input: {
    executionId: string;
    checkpoint: TeamMissionCheckpoint;
    now: string;
  }): { mission: TeamMissionRecord; nextExecutionId: string | null };
  completeTeamMissionStep(input: {
    executionId: string;
    attemptId: string;
    teamTaskId: string;
    agentId: string;
    report: unknown;
    doneEvidence: readonly { criterion: string; evidence: string }[];
    checkpoint: TeamMissionCheckpoint;
    now: string;
  }): { mission: TeamMissionRecord; nextExecutionId: string | null };
  recordTeamAttemptProviderResult(
    attemptId: string,
    resolution: ExecutionResolution | undefined,
    usage: NormalizedProviderUsage | undefined,
  ): TeamAttemptRecord;
  recoverInterruptedTeamExecutions(now: string): number;
  recordTeamV2Activity(input: {
    teamId: string;
    type: TeamV2ActivityType;
    actorAgentId?: string | null;
    subjectAgentId?: string | null;
    executionId?: string | null;
    attemptId?: string | null;
    payload: unknown;
    now: string;
  }): TeamV2ActivityRecord;
  listTeamV2Activity(
    teamId: string,
    afterSeq?: number,
    limit?: number,
  ): readonly TeamV2ActivityRecord[];
  listLatestTeamV2Activity(teamId: string, limit?: number): readonly TeamV2ActivityRecord[];
  setWorkerCurrentActivity(agentId: string, activity: string | null, now: string): AgentRecord;
  createTeamMessage(input: {
    teamId: string;
    sourceAgentId: string;
    targetAgentId: string;
    content: string;
    executionId?: string;
    attemptId?: string;
  }): TeamMessageRecord;
  transitionTeamMessageState(messageId: string, to: TeamMessageState): TeamMessageRecord;
  createTeamTask(input: {
    teamId: string;
    messageId: string;
    assigneeAgentId: string;
    createdByAgentId: string;
    description: string;
    doneCriteria: readonly string[];
    now: string;
  }): TeamTaskRecord;
  getTeamTask(taskId: string): TeamTaskRecord;
  transitionTeamTask(taskId: string, status: TeamTaskRecord['status'], now: string): TeamTaskRecord;
  recordTeamActivity(input: {
    teamTaskId: string;
    agentId: string;
    type: 'accepted' | 'activity' | 'fileChange' | 'blocked' | 'completed' | 'failed' | 'canceled';
    payload: unknown;
    now: string;
  }): void;
  completeTeamTaskWithReport(input: {
    teamTaskId: string;
    agentId: string;
    report: unknown;
    doneEvidence: readonly { criterion: string; evidence: string }[];
    now: string;
  }): TeamTaskRecord;
  reserveTeamBudget(input: {
    teamId: string;
    entries: readonly {
      scope: BudgetScope;
      kind: BudgetKind;
      amount: number;
      agentId?: string;
    }[];
    purpose: string;
    now: string;
  }): TeamBudgetReservationRecord[];
  settleTeamBudget(input: {
    reservationIds: readonly string[];
    actuals?: Readonly<Record<string, number>>;
    now: string;
  }): TeamBudgetReservationRecord[];
  releaseTeamBudget(input: {
    reservationIds: readonly string[];
    now: string;
  }): TeamBudgetReservationRecord[];
  getTeamBudgetStatus(teamId: string): TeamBudgetStatus[];
  getTeamUsageTotals(teamId: string): TeamUsageTotals;
  getWorkerUsageTotals(agentId: string): TeamUsageTotals;
  createTeamDelivery(input: { messageId: string; now: string }): TeamDeliveryRecord;
  transitionTeamDelivery(input: {
    messageId: string;
    to: TeamDeliveryState;
    now: string;
    error?: string;
  }): TeamDeliveryRecord;
  getTeamDelivery(messageId: string): TeamDeliveryRecord | null;
  countRecentTeamMessages(teamId: string, sinceIso: string): number;
  recordWorkerWorktree(input: {
    agentId: string;
    path: string;
    baseHead: string;
    now: string;
  }): WorkerWorktreeRecord;
  transitionWorkerWorktree(input: {
    agentId: string;
    to: WorkerWorktreeState;
    reason?: string;
    now: string;
  }): WorkerWorktreeRecord;
  getWorkerWorktree(agentId: string): WorkerWorktreeRecord | null;
  recoverTeamsOnStartup(now: string): {
    teams: number;
    workers: number;
    threads: number;
    deliveries: number;
  };
  checkTeamIntegrity(): TeamIntegrityReport;
  renameTask(taskId: string, title: string): TaskSummary;
  /** Replaces an automatic fallback title, but never a user-owned manual title. */
  applyGeneratedTaskTitle(taskId: string, title: string): TaskSummary | null;
  setPinned(taskId: string, pinned: boolean): TaskSummary;
  setArchived(taskId: string, archived: boolean): TaskSummary;
  setGoal(taskId: string, goal: string): TaskSummary;
  startGoal(taskId: string, objective: string): TaskSummary;
  pauseGoal(taskId: string): TaskSummary;
  resumeGoal(taskId: string): TaskSummary;
  clearGoal(taskId: string): TaskSummary;
  startGoalTurn(
    taskId: string,
    objective: string,
    skills?: readonly PersistedTurnSkill[],
    includeBuiltinTeamSkill?: boolean,
  ): StartedGoalTurn;
  resumeGoalTurn(
    taskId: string,
    skills?: readonly PersistedTurnSkill[],
    includeBuiltinTeamSkill?: boolean,
  ): StartedGoalTurn;
  pauseGoalAndCancelTurn(
    taskId: string,
    turnId: string | null,
    startNext?: boolean,
  ): {
    task: TaskSummary;
    canceledEvent: TurnEvent | null;
    next: QueueTransition;
  };
  clearGoalAndCancelTurn(
    taskId: string,
    turnId: string | null,
    startNext?: boolean,
  ): {
    task: TaskSummary;
    canceledEvent: TurnEvent | null;
    next: QueueTransition;
  };
  completeTurnAndFinishGoal(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
    finalText?: string,
  ): { event: TurnEvent; task: TaskSummary | null };
  recordRuntimeFailureDiagnostic(
    taskId: string,
    turnId: string,
    diagnostic: RuntimeFailureDiagnostic,
  ): PersistedRuntimeFailureDiagnostic;
  getRuntimeFailureDiagnostic(input: {
    taskId?: string | undefined;
    diagnosticId?: string | undefined;
  }): PersistedRuntimeFailureDiagnostic | null;
  cancelTurnAndFinishGoal(
    taskId: string,
    turnId: string,
  ): { event: TurnEvent | null; task: TaskSummary | null };
  getDraft(taskId: string): string;
  setDraft(taskId: string, draft: string): void;
  createDraftImageAttachment(input: DraftImageAttachmentInput): ImageAttachmentMetadata;
  listDraftImageAttachments(taskId: string): ImageAttachmentMetadata[];
  getAcceptedImageAttachments(taskId: string, turnId: string): AcceptedImageAttachment[];
  removeDraftImageAttachment(taskId: string, attachmentId: string): void;
  getDraftSkillSelections(taskId: string): TurnSkillSelection[];
  setDraftSkillSelections(taskId: string, skills: readonly TurnSkillSelection[]): void;
  getCanvasView(taskId: string): CanvasViewRecord | null;
  saveCanvasView(input: {
    taskId: string;
    camera: CanvasCameraRecord;
    nodePositions: Readonly<Record<string, { x: number; y: number }>>;
    revision: number;
  }): CanvasViewRecord;
  getWorkspace(taskId: string): string | null;
  getMutationWorkspacePath(taskId: string, turnId: string, rootId: string | null): string | null;
  setWorkspace(taskId: string, path: string): void;
  setWorkspaceBinding(
    taskId: string,
    binding: { path: string; workspaceKey: string; rootIdentityDigest: string },
  ): void;
  acquireMutationLease(input: {
    rootId?: string | null;
    workspaceKey: string;
    rootIdentityDigest: string;
    holderInstanceId: string;
    taskId: string;
    turnId: string;
    sagaId: string;
    purpose: MutationLeasePurpose;
    policyEpoch: number;
    intentDigest: string;
    now: string;
    expiresAt: string;
  }): MutationLeaseToken;
  renewMutationLease(token: MutationLeaseToken, now: string, expiresAt: string): MutationLeaseToken;
  assertMutationLease(token: MutationLeaseToken, now: string): void;
  releaseMutationLease(token: MutationLeaseToken, now: string): void;
  quarantineStartupMutations(holderInstanceId: string, now: string): readonly MutationQuarantine[];
  initializeMutationRecovery(holderInstanceId: string, now: string): readonly MutationQuarantine[];
  clearMutationQuarantine(workspaceKey: string, expectedFence: number, now: string): void;
  isNativeMutationAuthorityAvailable(): boolean;
  getRuntime(): RuntimeKind;
  getStoredRuntime(): RuntimeKind | null;
  setRuntime(kind: RuntimeKind): void;
  getModel(): string;
  setModel(model: string): void;
  reconcileBuiltinModelCatalog(
    kind: Extract<RuntimeKind, 'codex' | 'claude'>,
    availableModelIds: readonly string[],
  ): void;
  takeModelFallbackNotice(): ModelFallbackNotice | null;
  getUpdateHealth(): UpdateHealth;
  recordUpdateCheckSuccess(at: string): UpdateHealth;
  recordUpdateCheckFailure(at: string, category: UpdateErrorCategory): UpdateHealth;
  getEffort(): ClaudeEffort;
  setEffort(effort: ClaudeEffort): void;
  getCodexEffort(): string;
  setCodexEffort(effort: string): void;
  getCodexUserConfigEnabled(): boolean;
  setCodexUserConfigEnabled(enabled: boolean): void;
  hasAcknowledgedFullAccessRisk(): boolean;
  acknowledgeFullAccessRisk(): void;
  getTeamModelResearchBeforeHiring(): boolean;
  setTeamModelResearchBeforeHiring(enabled: boolean): void;
  getTeamModelSelectionGuidance(): string;
  setTeamModelSelectionGuidance(guidance: string): void;
  getSprintCoderPrePrompt(): string;
  setSprintCoderPrePrompt(prompt: string): void;
  getTeamModelRestriction(): TeamModelRestriction;
  setTeamModelRestriction(restriction: TeamModelRestriction): void;
  getDefaultTeamPolicy(): TeamPolicy;
  setDefaultTeamPolicy(policy: TeamPolicy): void;
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
  prepareEditSaga(request: EditSagaCreateRequest): EditSagaSnapshot;
  findEditSaga(taskId: string, turnId: string, operationId: string): EditSagaSnapshot | null;
  getEditSaga(id: string): EditSagaSnapshot;
  getTurnDiff(taskId: string, turnId: string): readonly TurnDiffEntry[];
  getAcceptanceContract(taskId: string, turnId: string): AcceptanceContract;
  listEvidenceRecords(taskId: string, turnId: string): readonly EvidenceRecord[];
  listAssuranceRounds(taskId: string, turnId: string, sagaId: string): readonly AssuranceRound[];
  recordAssuranceVerification(input: {
    taskId: string;
    turnId: string;
    sagaId: string;
    outcome: 'passed' | 'failed';
    failureClass: AssuranceFailureClass | null;
    createdAt: string;
  }): AssuranceRound;
  updateEditSaga(
    id: string,
    expectedRevision: number,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot;
  updateEditSagaUnderLease(
    id: string,
    expectedRevision: number,
    lease: unknown,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot;
  listRecoverableEditSagas(): readonly EditSagaSnapshot[];
  prepareNativeMutationIntent(
    seed: NativeMutationIntentSeed,
    lease: MutationLeaseToken,
    now: string,
    coordinator?: NativeMutationSagaCoordinator,
  ): NativeMutationIntentSnapshot;
  getNativeMutationIntent(id: string): NativeMutationIntentSnapshot;
  bindNativeMutationIntentRecovery(
    id: string,
    expectedRevision: number,
    lease: MutationLeaseToken,
    nativeSessionId: string,
    now: string,
  ): NativeMutationRecoveryBinding;
  updateNativeMutationIntent(
    id: string,
    expectedRevision: number,
    lease: MutationLeaseToken,
    now: string,
    nativeSessionId: string,
    transition: NativeMutationIntentTransition,
    coordinator?: NativeMutationSagaCoordinator,
  ): NativeMutationIntentSnapshot;
  listRecoverableNativeMutationIntents(): readonly NativeMutationIntentSnapshot[];
  listMessages(taskId: string): ChatMessage[];
  startTurn(
    taskId: string,
    text: string,
    skills?: readonly PersistedTurnSkill[],
    includeBuiltinTeamSkill?: boolean,
    attachmentIds?: readonly string[],
    attachmentCapability?: ImageAttachmentCapabilityValidator | undefined,
  ): StartedTurn;
  replaceActiveTurn(
    taskId: string,
    expectedActiveTurnId: string | null,
    text: string,
    skills?: readonly PersistedTurnSkill[],
    includeBuiltinTeamSkill?: boolean,
  ): StopAndSendTransition;
  getTurnSkills(taskId: string, turnId: string): PersistedTurnSkill[];
  recordSkillDraft(taskId: string, turnId: string, draft: SkillDraft): TurnEvent;
  getTurnModelIdentity(taskId: string, turnId: string): TurnModelIdentity;
  recordTurnResolution(
    taskId: string,
    turnId: string,
    resolution: ExecutionResolution,
  ): TurnModelIdentity;
  recordTurnProviderUsage(
    taskId: string,
    turnId: string,
    usage: NormalizedProviderUsage,
  ): NormalizedProviderUsage;
  getTurnProviderUsage(taskId: string, turnId: string): NormalizedProviderUsage | null;
  queueInput(
    taskId: string,
    text: string,
    operationId: string,
    skills?: readonly PersistedTurnSkill[],
    includeBuiltinTeamSkill?: boolean,
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
    finalText?: string,
  ): TurnEvent;
  cancelTurn(taskId: string, turnId: string): TurnEvent | null;
  snapshot(taskId: string): TurnSnapshot;
  prepareContext(taskId: string, turnId: string): PreparedContext;
  getContextSealManifest(ownerType: ContextSealOwnerType, ownerId: string): ContextSealManifest;
  sealTeamExecutionContext(input: {
    taskId: string;
    executionId: string;
    parentOwner?: { type: ContextSealOwnerType; id: string };
  }): ContextSealManifest;
  prepareTeamExecutionContext(taskId: string, executionId: string): PreparedContext;
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
  prepareUserFileSaveIntent(intent: Omit<UserFileSaveIntent, 'state'>): UserFileSaveIntent;
  listRecoverableUserFileSaveIntents(): readonly UserFileSaveIntent[];
  finalizeUserFileSaveIntent(
    intent: UserFileSaveIntent,
    result: SaveOutcome,
  ): { result: SaveOutcome; event: TurnEvent | null };
  requireUserFileSaveRecovery(intent: UserFileSaveIntent): void;
  interruptActiveTurns(): number;
  getStartupRecovery(): DatabaseRecovery;
  recordGeneratedImage(input: {
    taskId: string;
    turnId: string;
    bytes: Buffer;
  }): { event: TurnEvent; image: GeneratedImage } | null;
  recordFileChanges(input: {
    taskId: string;
    turnId: string;
    changes: FileChange[];
  }): TurnEvent | null;
  recordUserFileSave(input: {
    taskId: string;
    rootId: string;
    rootLabel: string;
    path: string;
    byteLength: number;
  }): TurnEvent;
  listGeneratedImages(taskId: string): GeneratedImage[];
  listFileChanges(taskId: string): FileChangeRecord[];
  readGeneratedImage(imageId: string): { image: GeneratedImage; bytes: Buffer } | null;
  close(): void;
}

// 'mock' has no model concept and is bucketed with Codex's key so pre-Claude installs keep
// reading/writing the exact same 'runtime.codex.model' row they always have.
function modelSettingsKey(kind: RuntimeKind): string {
  return kind === 'claude' ? 'runtime.claude.model' : 'runtime.codex.model';
}

/**
 * Built-in catalog ids that were retired, mapped to their replacement.
 *
 * `opus` used to be the id for the top Claude tier. It resolves to claude-opus-4-8 on CLI
 * 2.1.218, so the curated catalog now pins `claude-opus-5` explicitly (see the probe log in
 * runtime-host/claude-adapter.ts). A mapping is applied only by catalog reconciliation and only
 * when the replacement is present. Unknown ids become Auto in the same DB transaction, keeping
 * the picker and `startTurnInTransaction` on one canonical value.
 *
 * Keyed by Runtime kind because the settings row is shared between Codex and mock; an `opus` id
 * only ever means the Claude alias.
 */
const RETIRED_MODEL_IDS: Readonly<Partial<Record<RuntimeKind, Readonly<Record<string, string>>>>> =
  {
    codex: {
      'gpt-5.2-codex': 'gpt-5.4',
      'gpt-5.3-codex': 'gpt-5.4',
    },
    claude: { opus: 'claude-opus-5' },
  };

function modelFallbackNoticeKey(kind: Extract<RuntimeKind, 'codex' | 'claude'>): string {
  return `runtime.${kind}.model-fallback-notice`;
}

function defaultUpdateHealth(): UpdateHealth {
  return {
    successfulChecks: 0,
    failedChecks: 0,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCategory: null,
  };
}

function incrementBounded(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

const CLAUDE_EFFORT_VALUES: readonly ClaudeEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
];
function isClaudeEffort(value: string | undefined): value is ClaudeEffort {
  return value !== undefined && (CLAUDE_EFFORT_VALUES as readonly string[]).includes(value);
}

/** Outcome of the corruption probe that runs before the database is opened for real. */
export type DatabaseRecoveryReport = {
  corruptionDetected: boolean;
  restoredFromBackup: boolean;
  freshStart: boolean;
  corruptFileMovedTo: string | null;
  corruptBundlePath: string | null;
  possibleCommittedDataLoss: boolean;
  resumedRecovery: boolean;
  recoveryFailure: string | null;
};

export class DatabaseRecoveryError extends Error {
  readonly name = 'DatabaseRecoveryError';

  constructor(
    message: string,
    readonly recoveryReport: DatabaseRecoveryReport,
  ) {
    super(message);
  }
}

type RecoveryCrashCheckpoint =
  | 'after_main_retired_before_sidecar_cleanup'
  | 'after_corrupt_wal_bundled'
  | 'after_main_retired'
  | 'after_staging_validated'
  | 'before_publish';

type RecoveryMarker = {
  version: 1;
  phase: 'recovering';
  source: string;
  staging: string;
  retired: string;
};

type RecoveryMarkerRecord = { marker: RecoveryMarker; path: string };

type RecoveryBundleManifest = {
  version: 1;
  recoveryId: string;
  sourceDatabaseBasename: string;
  recoveredAt: string;
  automaticReplay: false;
  possibleCommittedDataLoss: boolean;
  files: Record<
    'main' | 'wal' | 'shm',
    { originalBasename: string; storedBasename: string; present: boolean; size: number | null }
  >;
};

let recoveryCrashCheckpointForTesting: ((checkpoint: RecoveryCrashCheckpoint) => void) | null =
  null;

function syncFile(path: string): void {
  // Windows requires a writable descriptor for FlushFileBuffers. Both callers pass a regular,
  // recovery-owned file that was just created and must be durably flushed before publication.
  const descriptor = openSync(path, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function supportsRecoveryDirectorySync(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function syncDirectory(path: string): void {
  // libuv implements fsync with FlushFileBuffers on Windows, which requires GENERIC_WRITE.
  // Node can open a directory for reading there but cannot portably provide that writable file
  // handle. Recovery files themselves are still mandatorily fsynced before every publication.
  if (!supportsRecoveryDirectorySync(process.platform)) return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function databasePassesQuickCheck(path: string): boolean {
  if (!isRegularFile(path)) return false;
  let handle: Database.Database | null = null;
  try {
    handle = new Database(path, { readonly: true, fileMustExist: true });
    const rows = handle.pragma('quick_check') as { quick_check?: string }[] | string[];
    const first = rows[0];
    return (typeof first === 'string' ? first : (first?.quick_check ?? '')) === 'ok';
  } catch {
    return false;
  } finally {
    handle?.close();
  }
}

function recoveryOwnedPath(databasePath: string, component: string, prefix: string): string {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedPrefix}${UUID_FILE_COMPONENT}$`, 'i');
  if (!pattern.test(component) || basename(component) !== component)
    throw new Error('Database recovery marker contains an invalid path');
  return `${dirname(databasePath)}${sep}${component}`;
}

function readRecoveryMarker(databasePath: string): RecoveryMarkerRecord | null {
  const prefix = `${basename(databasePath)}.recovery-`;
  const markerPattern = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${UUID_FILE_COMPONENT}\\.json$`,
    'i',
  );
  const matches = readdirSync(dirname(databasePath), { withFileTypes: true }).filter(
    (entry) => entry.name.startsWith(prefix) && markerPattern.test(entry.name),
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('Multiple database recovery markers found');
  const match = matches[0];
  if (match === undefined) throw new Error('Database recovery marker disappeared');
  const markerPath = `${dirname(databasePath)}${sep}${match.name}`;
  if (!isRegularFile(markerPath)) throw new Error('Database recovery marker is not a regular file');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error('Database recovery marker is malformed');
  }
  if (typeof value !== 'object' || value === null)
    throw new Error('Database recovery marker is malformed');
  const marker = value as Partial<RecoveryMarker>;
  if (
    marker.version !== 1 ||
    marker.phase !== 'recovering' ||
    typeof marker.source !== 'string' ||
    typeof marker.staging !== 'string' ||
    typeof marker.retired !== 'string'
  )
    throw new Error('Database recovery marker is malformed');
  return { marker: marker as RecoveryMarker, path: markerPath };
}

function writeRecoveryMarker(
  databasePath: string,
  markerPath: string,
  marker: RecoveryMarker,
): void {
  const temporaryPath = `${markerPath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', flag: 'wx' });
    syncFile(temporaryPath);
    renameSync(temporaryPath, markerPath);
    syncDirectory(dirname(databasePath));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function recoveryBundleManifestPath(bundlePath: string): string {
  return `${bundlePath}${sep}manifest.json`;
}

function readRecoveryBundleManifest(bundlePath: string): RecoveryBundleManifest | null {
  const manifestPath = recoveryBundleManifestPath(bundlePath);
  if (!existsSync(manifestPath)) return null;
  if (!isRegularFile(manifestPath)) throw new Error('Database recovery manifest is not a file');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('Database recovery manifest is malformed');
  }
  const manifest = value as Partial<RecoveryBundleManifest>;
  if (
    manifest.version !== 1 ||
    manifest.automaticReplay !== false ||
    typeof manifest.possibleCommittedDataLoss !== 'boolean' ||
    typeof manifest.files !== 'object' ||
    manifest.files === null
  )
    throw new Error('Database recovery manifest is malformed');
  return manifest as RecoveryBundleManifest;
}

function writeRecoveryBundleManifest(
  databasePath: string,
  bundlePath: string,
  recoveryId: string,
): RecoveryBundleManifest {
  const members = [
    { key: 'main', suffix: '' },
    { key: 'wal', suffix: '-wal' },
    { key: 'shm', suffix: '-shm' },
  ] as const;
  const files = Object.fromEntries(
    members.map(({ key, suffix }) => {
      const storedPath = `${bundlePath}${sep}${key}`;
      const present = isRegularFile(storedPath);
      return [
        key,
        {
          originalBasename: basename(`${databasePath}${suffix}`),
          storedBasename: key,
          present,
          size: present ? lstatSync(storedPath).size : null,
        },
      ];
    }),
  ) as RecoveryBundleManifest['files'];
  const manifest: RecoveryBundleManifest = {
    version: 1,
    recoveryId,
    sourceDatabaseBasename: basename(databasePath),
    recoveredAt: new Date().toISOString(),
    automaticReplay: false,
    possibleCommittedDataLoss: files.wal.present,
    files,
  };
  const manifestPath = recoveryBundleManifestPath(bundlePath);
  const temporaryPath = `${manifestPath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    syncFile(temporaryPath);
    renameSync(temporaryPath, manifestPath);
    syncDirectory(bundlePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return manifest;
}

function preserveCorruptDatabaseBundle(
  databasePath: string,
  bundlePath: string,
  recoveryId: string,
  onMoved?: (member: 'main' | 'wal' | 'shm') => void,
): RecoveryBundleManifest | null {
  const members = [
    { key: 'main', source: databasePath },
    { key: 'wal', source: `${databasePath}-wal` },
    { key: 'shm', source: `${databasePath}-shm` },
  ] as const;
  const hasSource = members.some(({ source }) => existsSync(source));
  if (!existsSync(bundlePath)) {
    if (!hasSource) return null;
    mkdirSync(bundlePath);
    syncDirectory(dirname(databasePath));
  } else if (!isDirectory(bundlePath)) {
    throw new Error('Database recovery bundle path is not a directory');
  }

  const publishedManifest = readRecoveryBundleManifest(bundlePath);
  if (publishedManifest !== null) {
    if (hasSource) throw new Error('Database recovery found files after bundle finalization');
    return publishedManifest;
  }

  for (const { key, source } of members) {
    const destination = `${bundlePath}${sep}${key}`;
    const sourceExists = existsSync(source);
    const destinationExists = existsSync(destination);
    if (sourceExists && !isRegularFile(source))
      throw new Error(`Database recovery ${key} source is not a regular file`);
    if (destinationExists && !isRegularFile(destination))
      throw new Error(`Database recovery ${key} bundle member is not a regular file`);
    if (sourceExists && destinationExists)
      throw new Error(`Database recovery found both source and bundled ${key}`);
    if (!sourceExists) continue;
    renameSync(source, destination);
    syncFile(destination);
    syncDirectory(bundlePath);
    syncDirectory(dirname(databasePath));
    onMoved?.(key);
  }
  return writeRecoveryBundleManifest(databasePath, bundlePath, recoveryId);
}

function applyRecoveryBundleReport(
  report: DatabaseRecoveryReport,
  bundlePath: string,
  manifest: RecoveryBundleManifest | null,
): void {
  if (manifest === null) return;
  report.corruptBundlePath = bundlePath;
  report.possibleCommittedDataLoss = manifest.possibleCommittedDataLoss;
  const corruptMainPath = `${bundlePath}${sep}main`;
  if (isRegularFile(corruptMainPath)) report.corruptFileMovedTo = corruptMainPath;
}

// Probe before real use. Recovery is journaled before the main file is retired, and a validated,
// synced staging database is atomically published. A restart with no main file must therefore
// resume the marker instead of letting better-sqlite3 silently create an empty database.
function recoverDatabaseIfCorrupt(databasePath: string): DatabaseRecoveryReport {
  const report: DatabaseRecoveryReport = {
    corruptionDetected: false,
    restoredFromBackup: false,
    freshStart: false,
    corruptFileMovedTo: null,
    corruptBundlePath: null,
    possibleCommittedDataLoss: false,
    resumedRecovery: false,
    recoveryFailure: null,
  };
  const backupPath = `${databasePath}.pre-migration.bak`;
  try {
    let markerRecord = readRecoveryMarker(databasePath);
    let createdMarker = false;
    if (markerRecord === null) {
      if (existsSync(databasePath) && databasePassesQuickCheck(databasePath)) return report;
      const existingCandidates = [backupPath, `${backupPath}.previous`].filter((candidate) =>
        existsSync(candidate),
      );
      report.resumedRecovery = !existsSync(databasePath) && existingCandidates.length > 0;
      if (report.resumedRecovery) report.corruptionDetected = true;
      const source = existingCandidates.find(databasePassesQuickCheck);
      if (source === undefined) {
        if (!existsSync(databasePath)) {
          if (existingCandidates.length === 0) return report;
          throw new Error('Database recovery failed: no valid backup candidate');
        }
        report.corruptionDetected = true;
        const recoveryId = randomUUID();
        const bundlePath = `${databasePath}.corrupt-${recoveryId}`;
        const manifest = preserveCorruptDatabaseBundle(databasePath, bundlePath, recoveryId);
        applyRecoveryBundleReport(report, bundlePath, manifest);
        report.freshStart = true;
        return report;
      }

      report.corruptionDetected = existsSync(databasePath);
      const recoveryId = randomUUID();
      const retired = `${basename(databasePath)}.corrupt-${recoveryId}`;
      const marker: RecoveryMarker = {
        version: 1,
        phase: 'recovering',
        source: basename(source),
        staging: `${basename(databasePath)}.recovery-stage-${recoveryId}`,
        retired,
      };
      const markerPath = `${databasePath}.recovery-${recoveryId}.json`;
      writeRecoveryMarker(databasePath, markerPath, marker);
      markerRecord = { marker, path: markerPath };
      createdMarker = true;
    } else {
      report.resumedRecovery = true;
      report.corruptionDetected = true;
    }

    const { marker, path: markerPath } = markerRecord;

    if (![basename(backupPath), basename(`${backupPath}.previous`)].includes(marker.source))
      throw new Error('Database recovery marker contains an invalid backup');
    const stagingPath = recoveryOwnedPath(
      databasePath,
      marker.staging,
      `${basename(databasePath)}.recovery-stage-`,
    );
    const bundlePath = recoveryOwnedPath(
      databasePath,
      marker.retired,
      `${basename(databasePath)}.corrupt-`,
    );
    const recoveryId = marker.retired.slice(`${basename(databasePath)}.corrupt-`.length);
    if (isDirectory(bundlePath))
      applyRecoveryBundleReport(report, bundlePath, readRecoveryBundleManifest(bundlePath));
    if (existsSync(databasePath)) {
      if (databasePassesQuickCheck(databasePath)) {
        for (const suffix of ['', '-wal', '-shm'])
          rmSync(`${stagingPath}${suffix}`, { force: true });
        rmSync(markerPath, { force: true });
        syncDirectory(dirname(databasePath));
        report.restoredFromBackup = true;
        return report;
      }
      report.corruptionDetected = true;
    }

    const manifest = preserveCorruptDatabaseBundle(
      databasePath,
      bundlePath,
      recoveryId,
      (member) => {
        if (member === 'main')
          recoveryCrashCheckpointForTesting?.('after_main_retired_before_sidecar_cleanup');
        if (member === 'wal') recoveryCrashCheckpointForTesting?.('after_corrupt_wal_bundled');
      },
    );
    applyRecoveryBundleReport(report, bundlePath, manifest);
    if (createdMarker) recoveryCrashCheckpointForTesting?.('after_main_retired');

    const sourcePath = `${dirname(databasePath)}${sep}${marker.source}`;
    if (!databasePassesQuickCheck(sourcePath))
      throw new Error('Database recovery failed: marker backup is invalid');
    if (!databasePassesQuickCheck(stagingPath)) {
      if (existsSync(stagingPath) && !isRegularFile(stagingPath))
        throw new Error('Database recovery staging path is not a regular file');
      rmSync(stagingPath, { force: true });
      if (!isRegularFile(sourcePath))
        throw new Error('Database recovery backup changed before staging');
      copyFileSync(sourcePath, stagingPath, COPYFILE_EXCL);
      if (!databasePassesQuickCheck(stagingPath))
        throw new Error('Database recovery failed: staging database is invalid');
      for (const suffix of ['-wal', '-shm']) rmSync(`${stagingPath}${suffix}`, { force: true });
      syncFile(stagingPath);
      syncDirectory(dirname(databasePath));
    }
    recoveryCrashCheckpointForTesting?.('after_staging_validated');
    const finalizedManifest = preserveCorruptDatabaseBundle(databasePath, bundlePath, recoveryId);
    applyRecoveryBundleReport(report, bundlePath, finalizedManifest);
    recoveryCrashCheckpointForTesting?.('before_publish');
    if (existsSync(databasePath))
      throw new Error('Database recovery refused to replace main database');
    renameSync(stagingPath, databasePath);
    for (const suffix of ['-wal', '-shm']) rmSync(`${stagingPath}${suffix}`, { force: true });
    syncDirectory(dirname(databasePath));
    rmSync(markerPath, { force: true });
    syncDirectory(dirname(databasePath));
    report.restoredFromBackup = true;
    return report;
  } catch (error) {
    report.recoveryFailure = error instanceof Error ? error.message : String(error);
    throw new DatabaseRecoveryError(report.recoveryFailure, report);
  }
}

export const __persistenceRecoveryTestables = {
  supportsDirectorySync: supportsRecoveryDirectorySync,
  setCrashCheckpointForTesting(callback: ((checkpoint: RecoveryCrashCheckpoint) => void) | null) {
    recoveryCrashCheckpointForTesting = callback;
  },
};

const UUID_FILE_COMPONENT = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function removeValidationSnapshotFiles(temporaryPath: string): void {
  let firstFailure: unknown;
  for (const candidate of [temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
    try {
      rmSync(candidate, { force: true });
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

/** Remove only abandoned validation databases owned by this database path. */
function removeOrphanedPreMigrationValidationFiles(databasePath: string): void {
  const directory = dirname(databasePath);
  const ownedPrefix = `${basename(databasePath)}.pre-migration.bak.tmp-`;
  const ownedSuffix = new RegExp(`^${UUID_FILE_COMPONENT}(?:-(?:wal|shm))?$`, 'i');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Dirent.isFile() deliberately excludes symlinks, directories, sockets, and other unknown
    // entries. A similar-looking file must never become an authority to traverse or remove it.
    if (
      !entry.isFile() ||
      !entry.name.startsWith(ownedPrefix) ||
      !ownedSuffix.test(entry.name.slice(ownedPrefix.length))
    )
      continue;
    const candidate = `${directory}${sep}${entry.name}`;
    // Re-check at deletion time so a symlink observed after readdir is still preserved.
    try {
      if (!lstatSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    rmSync(candidate, { force: true });
  }
}

export class SqlitePersistenceClient implements PersistenceClient {
  private readonly db: Database.Database;
  private readonly contextLedger: ContextLedger;
  private nativeMutationAuthorityDisabled = false;
  private skillCatalogContextProvider:
    | ((selections: readonly TurnSkillSelection[], includeBuiltinTeamSkill: boolean) => string)
    | null = null;
  readonly recoveryReport: DatabaseRecoveryReport;
  private startupInterruptedTurns = 0;

  constructor(
    databasePath: string,
    private readonly verifyNativeSession: (binding: {
      id: string;
      workspaceKey: string;
      fence: string;
    }) => void = () => {
      throw new MutationLeaseStaleError();
    },
    private readonly invalidateNativeWorkspace: (
      workspaceKey: string,
      minimumFence: string,
    ) => void = () => undefined,
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    removeOrphanedPreMigrationValidationFiles(databasePath);
    this.recoveryReport = recoverDatabaseIfCorrupt(databasePath);
    this.db = new Database(databasePath);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.runMigrations(databasePath);
      this.backfillLegacyMutationScopes();
      this.backfillLegacyEditSagaBindings();
      this.backfillLegacyNativeEditSagaRevisions();
      this.backfillLegacyEditSagaRootBindings();
      this.backfillAcceptanceContracts();
      this.interruptActiveCommands();
      this.contextLedger = new ContextLedger(this, (taskId, turnId) =>
        this.liveStateForReminder(taskId, turnId),
      );
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the initialization failure that explains why the client could not be created.
      }
      throw error;
    }
  }

  setSkillCatalogContextProvider(
    provider: (
      selections: readonly TurnSkillSelection[],
      includeBuiltinTeamSkill: boolean,
    ) => string,
  ): void {
    this.skillCatalogContextProvider = provider;
  }

  /**
   * The facts a compaction would otherwise erase, read fresh at context-assembly time.
   *
   * Best-effort by design: this feeds a reminder, and a Turn that cannot be prepared because the
   * reminder's own lookups threw would be a far worse failure than a Turn that proceeds without one.
   * A task with no Team, or with no contract yet, simply has less to restate.
   */
  private liveStateForReminder(taskId: string, turnId: string): LiveState {
    return deriveLiveState({
      agents: this.safely(() => {
        const team = this.getTeamByTask(taskId);
        return team === null ? [] : this.getTeamSnapshot(team.id).agents;
      }),
      // The Turn's own diff, not the Acceptance Contract's allowed scope. Allowed scope is what the
      // Turn was permitted to touch, and a reminder that lists a permitted-but-untouched file as
      // changed tells the model work is done that is not — which is the reminder causing the exact
      // skipped work it exists to prevent.
      diff: this.safely(() => this.getTurnDiff(taskId, turnId)),
    });
  }

  private safely<T>(read: () => readonly T[]): readonly T[] {
    try {
      return read();
    } catch {
      return [];
    }
  }

  listProviderConnections(): readonly ProviderConnection[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM provider_connections
         ORDER BY runtime_kind, provider_id, display_name, id`,
      )
      .all() as ProviderConnectionRow[];
    return rows.map(toProviderConnection);
  }

  getProviderConnection(connectionId: string): ProviderConnection {
    const row = this.db
      .prepare('SELECT * FROM provider_connections WHERE id = ?')
      .get(connectionId) as ProviderConnectionRow | undefined;
    if (row === undefined) throw new NotFoundError('Provider connection not found');
    return toProviderConnection(row);
  }

  createProviderConnection(connection: ProviderConnection): ProviderConnection {
    const parsed = providerConnectionSchema.parse(connection);
    if (parsed.runtimeKind === 'builtin_cli')
      throw new Error('Built-in Provider Connections are migration-owned');
    this.db
      .prepare(
        `INSERT INTO provider_connections(
           id, provider_id, runtime_kind, display_name, enabled, automatic_model_release,
           secret_reference,
           verification_status, verified_at, verification_expires_at, verification_message,
           rate_limit_mode, max_concurrent_requests, requests_per_minute, tokens_per_minute,
           last_observed_rate_limit_headers_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.providerId,
        parsed.runtimeKind,
        parsed.displayName,
        parsed.enabled ? 1 : 0,
        parsed.automaticModelRelease === true ? 1 : 0,
        parsed.secretReference,
        parsed.verification.status,
        parsed.verification.verifiedAt,
        parsed.verification.expiresAt,
        parsed.verification.message,
        parsed.rateLimit.mode,
        parsed.rateLimit.maxConcurrentRequests,
        parsed.rateLimit.requestsPerMinute,
        parsed.rateLimit.tokensPerMinute,
        parsed.rateLimit.lastObservedRateLimitHeaders === null
          ? null
          : JSON.stringify(parsed.rateLimit.lastObservedRateLimitHeaders),
        parsed.createdAt,
        parsed.updatedAt,
      );
    return this.getProviderConnection(parsed.id);
  }

  setProviderConnectionAutomaticModelRelease(
    connectionId: string,
    automaticModelRelease: boolean,
  ): ProviderConnection {
    const current = this.getProviderConnection(connectionId);
    if (current.providerId !== 'ollama' || current.runtimeKind !== 'openai_compatible')
      throw new Error('Automatic model release is only configurable for Ollama Connections');
    const result = this.db
      .prepare(
        `UPDATE provider_connections
         SET automatic_model_release = ?, updated_at = ?
         WHERE id = ? AND provider_id = 'ollama' AND runtime_kind = 'openai_compatible'`,
      )
      .run(automaticModelRelease ? 1 : 0, new Date().toISOString(), connectionId);
    if (result.changes !== 1) throw new NotFoundError('Provider connection not found');
    return this.getProviderConnection(connectionId);
  }

  setProviderConnectionSecretReference(
    connectionId: string,
    secretReference: string | null,
  ): ProviderConnection {
    if (
      secretReference !== null &&
      !/^provider-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        secretReference,
      )
    )
      throw new Error('Invalid Provider secret reference');
    const result = this.db
      .prepare(
        `UPDATE provider_connections
         SET secret_reference = ?,
             verification_status = CASE
               WHEN runtime_kind = 'builtin_cli' THEN 'not_required'
               ELSE 'unverified'
             END,
             verified_at = NULL, verification_expires_at = NULL, verification_message = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(secretReference, new Date().toISOString(), connectionId);
    if (result.changes !== 1) throw new NotFoundError('Provider connection not found');
    return this.getProviderConnection(connectionId);
  }

  updateProviderConnectionVerification(
    connectionId: string,
    verification: ProviderConnection['verification'],
  ): ProviderConnection {
    const result = this.db
      .prepare(
        `UPDATE provider_connections
         SET verification_status = ?, verified_at = ?, verification_expires_at = ?,
             verification_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        verification.status,
        verification.verifiedAt,
        verification.expiresAt,
        verification.message,
        new Date().toISOString(),
        connectionId,
      );
    if (result.changes !== 1) throw new NotFoundError('Provider connection not found');
    return this.getProviderConnection(connectionId);
  }

  lowerProviderConnectionRateLimits(
    connectionId: string,
    limits: Partial<
      Pick<
        ProviderConnection['rateLimit'],
        'maxConcurrentRequests' | 'requestsPerMinute' | 'tokensPerMinute'
      >
    >,
  ): ProviderConnection {
    const current = this.getProviderConnection(connectionId);
    if (current.runtimeKind === 'builtin_cli')
      throw new Error('Built-in CLI concurrency is controlled by Team Policy, not API rate limits');
    const lower = (name: keyof typeof limits, next: number | null | undefined): number | null => {
      const existing = current.rateLimit[name];
      if (next === undefined) return existing;
      if (next === null || !Number.isSafeInteger(next) || next < 1)
        throw new Error(`Provider ${name} must be a positive integer`);
      if (existing !== null && next > existing)
        throw new Error(`Provider ${name} can only be lowered from this screen`);
      return next;
    };
    const maxConcurrentRequests = lower('maxConcurrentRequests', limits.maxConcurrentRequests);
    const requestsPerMinute = lower('requestsPerMinute', limits.requestsPerMinute);
    const tokensPerMinute = lower('tokensPerMinute', limits.tokensPerMinute);
    const result = this.db
      .prepare(
        `UPDATE provider_connections
         SET rate_limit_mode = 'manual', max_concurrent_requests = ?,
             requests_per_minute = ?, tokens_per_minute = ?, updated_at = ?
         WHERE id = ? AND runtime_kind != 'builtin_cli'`,
      )
      .run(
        maxConcurrentRequests,
        requestsPerMinute,
        tokensPerMinute,
        new Date().toISOString(),
        connectionId,
      );
    if (result.changes !== 1) throw new NotFoundError('Provider connection not found');
    return this.getProviderConnection(connectionId);
  }

  private runMigrations(databasePath: string): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    let applied = this.readAppliedMigrations();
    const legacyLineage = this.isLegacyMigrationLineage(applied);
    const legacyImageAttachmentCollision = this.isLegacyImageAttachmentCollision(applied);
    const legacyRuntimeDiagnosticCollision = this.isLegacyRuntimeDiagnosticCollision(applied);
    const hadPendingMigrations = migrations.some((migration) => !applied.has(migration.version));
    if (
      (hadPendingMigrations ||
        legacyImageAttachmentCollision ||
        legacyRuntimeDiagnosticCollision) &&
      existsSync(databasePath) &&
      applied.size > 0
    )
      this.createPreMigrationBackup(databasePath);
    if (legacyLineage) {
      this.applyLegacyMigrationBridge();
      applied = this.readAppliedMigrations();
    }
    if (legacyImageAttachmentCollision) {
      this.applyLegacyImageAttachmentBridge();
      applied = this.readAppliedMigrations();
    }
    if (legacyRuntimeDiagnosticCollision) {
      this.applyLegacyRuntimeDiagnosticBridge();
      applied = this.readAppliedMigrations();
    }
    for (const migration of migrations) {
      const checksum = applied.get(migration.version);
      const isRecognizedLegacyChecksum =
        (legacyLineage && LEGACY_MIGRATION_LINEAGE.get(migration.version) === checksum) ||
        (legacyImageAttachmentCollision &&
          migration.version === 64 &&
          checksum === LEGACY_IMAGE_ATTACHMENT_CHECKSUM) ||
        (legacyRuntimeDiagnosticCollision &&
          migration.version === 66 &&
          checksum === LEGACY_RUNTIME_DIAGNOSTIC_CHECKSUM);
      if (checksum !== undefined && checksum !== migration.checksum && !isRecognizedLegacyChecksum)
        throw new Error('Migration checksum mismatch');
      if (checksum !== undefined) continue;
      const applyMigration = (): void => {
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.db
            .prepare(
              'INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)',
            )
            .run(migration.version, migration.checksum, new Date().toISOString());
        })();
      };
      // SQLite cannot change a CHECK constraint via ALTER TABLE, so widening one requires
      // recreating the table (see migration v30). That rebuild must run with FK enforcement off
      // (PRAGMA foreign_keys is a no-op inside an active transaction, so it must be toggled
      // outside applyMigration's transaction) or dropping a table other rows still reference
      // would cascade-delete them. foreign_key_check afterward guards against a migration
      // silently leaving the database inconsistent.
      if ('requiresForeignKeysOff' in migration && migration.requiresForeignKeysOff === true) {
        this.db.pragma('foreign_keys = OFF');
        try {
          applyMigration();
          const danglingForeignKeys = this.db.pragma('foreign_key_check');
          if (Array.isArray(danglingForeignKeys) && danglingForeignKeys.length > 0)
            throw new Error(`Migration ${migration.version} left dangling foreign keys`);
        } finally {
          this.db.pragma('foreign_keys = ON');
        }
      } else {
        applyMigration();
      }
    }
  }

  private createPreMigrationBackup(databasePath: string): void {
    const backupPath = `${databasePath}.pre-migration.bak`;
    const previousPath = `${backupPath}.previous`;
    const temporaryPath = `${backupPath}.tmp-${randomUUID()}`;
    // A byte copy of the main DB file is incomplete while committed pages still live in WAL.
    // Checkpoint first, validate the copied snapshot, then rotate it into place. The previous
    // snapshot remains recoverable until the new one is installed, including on Windows where a
    // rename cannot replace an existing destination atomically.
    const checkpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as {
      busy?: number;
      log?: number;
      checkpointed?: number;
    }[];
    const result = checkpoint[0];
    if (
      result === undefined ||
      result.busy !== 0 ||
      result.log !== result.checkpointed ||
      result.log !== 0
    )
      throw new Error('Could not checkpoint database before migration backup');
    let snapshot: Database.Database | null = null;
    const closeSnapshot = (): void => {
      const handle = snapshot;
      snapshot = null;
      handle?.close();
    };
    try {
      copyFileSync(databasePath, temporaryPath);
      snapshot = new Database(temporaryPath, { readonly: true, fileMustExist: true });
      const rows = snapshot.pragma('quick_check') as { quick_check?: string }[] | string[];
      const first = rows[0];
      const verdict = typeof first === 'string' ? first : (first?.quick_check ?? '');
      if (verdict !== 'ok') throw new Error('Pre-migration backup failed integrity check');
      // Windows cannot rotate an open SQLite file, so close before installing the snapshot while
      // retaining the outer finally as the failure-path owner.
      closeSnapshot();
      rmSync(previousPath, { force: true });
      if (existsSync(backupPath)) renameSync(backupPath, previousPath);
      try {
        renameSync(temporaryPath, backupPath);
      } catch (error) {
        if (!existsSync(backupPath) && existsSync(previousPath))
          renameSync(previousPath, backupPath);
        throw error;
      }
      rmSync(previousPath, { force: true });
    } finally {
      try {
        closeSnapshot();
      } finally {
        removeValidationSnapshotFiles(temporaryPath);
      }
    }
  }

  private readAppliedMigrations(): Map<number, string> {
    return new Map(
      (
        this.db.prepare('SELECT version, checksum FROM schema_migrations').all() as {
          version: number;
          checksum: string;
        }[]
      ).map((row) => [row.version, row.checksum]),
    );
  }

  private isLegacyMigrationLineage(applied: ReadonlyMap<number, string>): boolean {
    const hasLegacyChecksum = [...LEGACY_MIGRATION_LINEAGE.values()].some((checksum) =>
      [...applied.values()].includes(checksum),
    );
    if (!hasLegacyChecksum) return false;
    for (const [version, checksum] of LEGACY_MIGRATION_LINEAGE) {
      if (applied.get(version) !== checksum) throw new Error('Migration checksum mismatch');
    }
    return true;
  }

  private isLegacyRuntimeDiagnosticCollision(applied: ReadonlyMap<number, string>): boolean {
    return applied.get(66) === LEGACY_RUNTIME_DIAGNOSTIC_CHECKSUM;
  }

  private isLegacyImageAttachmentCollision(applied: ReadonlyMap<number, string>): boolean {
    return applied.get(64) === LEGACY_IMAGE_ATTACHMENT_CHECKSUM;
  }

  private migrationForVersion(version: number): (typeof migrations)[number] {
    const migration = migrations.find((candidate) => candidate.version === version);
    if (migration === undefined) throw new Error(`Missing migration ${version}`);
    return migration;
  }

  private tableExists(tableName: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .get(tableName) !== undefined
    );
  }

  private columnExists(tableName: string, columnName: string): boolean {
    const escapedTableName = tableName.replace(/'/g, "''");
    return (
      this.db.prepare(`PRAGMA table_info('${escapedTableName}')`).all() as { name: string }[]
    ).some((column) => column.name === columnName);
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    if (this.columnExists(tableName, columnName)) return;
    const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    this.db.exec(`ALTER TABLE ${quote(tableName)} ADD COLUMN ${quote(columnName)} ${definition}`);
  }

  private idempotentMigrationSql(sql: string): string {
    return sql
      .replace(/CREATE TABLE(?! IF NOT EXISTS)/g, 'CREATE TABLE IF NOT EXISTS')
      .replace(/CREATE UNIQUE INDEX(?! IF NOT EXISTS)/g, 'CREATE UNIQUE INDEX IF NOT EXISTS')
      .replace(/CREATE INDEX(?! IF NOT EXISTS)/g, 'CREATE INDEX IF NOT EXISTS');
  }

  /**
   * Repairs the one known branch collision without rewriting its historical rows. The bridge is
   * deliberately narrow: it only runs when all four old checksums are present, and it records a
   * marker in a separate table so a retry cannot run ALTER/CREATE statements twice.
   */
  private applyLegacyMigrationBridge(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migration_compatibility (
      lineage TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    )`);
    const alreadyApplied = this.db
      .prepare('SELECT 1 FROM schema_migration_compatibility WHERE lineage = ?')
      .get(LEGACY_MIGRATION_COMPATIBILITY_KEY);
    if (alreadyApplied !== undefined) return;

    this.db.transaction(() => {
      this.applyLegacyTeamMigrations();
      this.applyLegacyProjectMigrations();
      for (const version of [55, 56, 57, 58]) {
        const migration = this.migrationForVersion(version);
        const existing = this.db
          .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
          .get(version) as { checksum: string } | undefined;
        if (existing !== undefined) {
          if (existing.checksum !== migration.checksum)
            throw new Error('Migration checksum mismatch');
          continue;
        }
        this.db
          .prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(version, migration.checksum, new Date().toISOString());
      }
      this.db
        .prepare('INSERT INTO schema_migration_compatibility(lineage, applied_at) VALUES (?, ?)')
        .run(LEGACY_MIGRATION_COMPATIBILITY_KEY, new Date().toISOString());
    })();
  }

  /**
   * Repairs the development-only v66 collision where runtime diagnostics occupied the version
   * later assigned to automatic Ollama model release. The old diagnostics schema is identical to
   * the current v69 migration, so retain its historical v66 row, apply the missing provider change,
   * and record v69 without recreating the existing diagnostics table.
   */
  private applyLegacyRuntimeDiagnosticBridge(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migration_compatibility (
      lineage TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    )`);
    const alreadyApplied = this.db
      .prepare('SELECT 1 FROM schema_migration_compatibility WHERE lineage = ?')
      .get(LEGACY_RUNTIME_DIAGNOSTIC_COMPATIBILITY_KEY);
    if (alreadyApplied !== undefined) return;

    this.db.transaction(() => {
      if (!this.tableExists('runtime_failure_diagnostics'))
        throw new Error('Migration checksum mismatch');

      const providerMigration = this.migrationForVersion(66);
      if (!this.columnExists('provider_connections', 'automatic_model_release'))
        this.db.exec(providerMigration.sql);

      const relocatedDiagnosticMigration = this.migrationForVersion(69);
      const existing = this.db
        .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
        .get(69) as { checksum: string } | undefined;
      if (existing === undefined) {
        this.db
          .prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(
            relocatedDiagnosticMigration.version,
            relocatedDiagnosticMigration.checksum,
            new Date().toISOString(),
          );
      } else if (existing.checksum !== relocatedDiagnosticMigration.checksum) {
        throw new Error('Migration checksum mismatch');
      }

      this.db
        .prepare('INSERT INTO schema_migration_compatibility(lineage, applied_at) VALUES (?, ?)')
        .run(LEGACY_RUNTIME_DIAGNOSTIC_COMPATIBILITY_KEY, new Date().toISOString());
    })();
  }

  /**
   * Repairs the development-only v64 collision where image attachment drafts occupied the version
   * later assigned to Goal lifecycle state. The old attachment schema is identical to the current
   * v67 migration, so retain its historical v64 row, apply the missing Goal change, and record v67
   * without recreating the existing attachment table.
   */
  private applyLegacyImageAttachmentBridge(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migration_compatibility (
      lineage TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    )`);
    const alreadyApplied = this.db
      .prepare('SELECT 1 FROM schema_migration_compatibility WHERE lineage = ?')
      .get(LEGACY_IMAGE_ATTACHMENT_COMPATIBILITY_KEY);
    if (alreadyApplied !== undefined) return;

    this.db.transaction(() => {
      const attachmentColumns = [
        'id',
        'task_id',
        'message_id',
        'state',
        'file_name',
        'mime_type',
        'byte_length',
        'sha256',
        'bytes',
        'created_at',
      ];
      if (
        !this.tableExists('image_attachments') ||
        attachmentColumns.some((column) => !this.columnExists('image_attachments', column))
      )
        throw new Error('Migration checksum mismatch');

      const goalMigration = this.migrationForVersion(64);
      const goalColumns = [
        'goal_status',
        'goal_token_budget',
        'goal_tokens_used',
        'goal_time_used_seconds',
        'goal_started_at',
        'goal_updated_at',
      ];
      if (goalColumns.some((column) => this.columnExists('tasks', column)))
        throw new Error('Migration checksum mismatch');
      this.db.exec(goalMigration.sql);

      const relocatedAttachmentMigration = this.migrationForVersion(67);
      const existing = this.db
        .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
        .get(67) as { checksum: string } | undefined;
      if (existing === undefined) {
        this.db
          .prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(
            relocatedAttachmentMigration.version,
            relocatedAttachmentMigration.checksum,
            new Date().toISOString(),
          );
      } else if (existing.checksum !== relocatedAttachmentMigration.checksum) {
        throw new Error('Migration checksum mismatch');
      }

      this.db
        .prepare('INSERT INTO schema_migration_compatibility(lineage, applied_at) VALUES (?, ?)')
        .run(LEGACY_IMAGE_ATTACHMENT_COMPATIBILITY_KEY, new Date().toISOString());
    })();
  }

  private applyLegacyTeamMigrations(): void {
    const v35 = this.migrationForVersion(35);
    this.ensureColumn('turns', 'connection_id', 'TEXT');
    this.ensureColumn('turns', 'requested_provider', 'TEXT');
    this.ensureColumn('turns', 'requested_model', 'TEXT');
    this.ensureColumn('turns', 'resolved_provider', 'TEXT');
    this.ensureColumn('turns', 'resolved_model', 'TEXT');
    this.ensureColumn('agent_threads', 'connection_id', 'TEXT');
    this.ensureColumn('agent_threads', 'requested_provider', 'TEXT');
    this.ensureColumn('agent_threads', 'requested_model', 'TEXT');
    this.ensureColumn('agents', 'connection_id', 'TEXT');
    this.ensureColumn('agents', 'requested_provider', 'TEXT');
    this.ensureColumn('agents', 'requested_model', 'TEXT');
    // Referencing v35 above keeps this helper coupled to the migration definition: if that
    // migration is ever removed or renumbered, this bridge fails loudly during development.
    if (v35.version !== 35) throw new Error('Invalid legacy migration bridge');

    const v36 = this.migrationForVersion(36);
    this.ensureColumn('tasks', 'connection_id', 'TEXT');
    this.ensureColumn('tasks', 'requested_provider', 'TEXT');
    this.ensureColumn('tasks', 'requested_model', 'TEXT');
    if (v36.version !== 36) throw new Error('Invalid legacy migration bridge');

    const v37 = this.migrationForVersion(37);
    const v37NeedsWork =
      !this.columnExists('teams', 'policy_json') ||
      !this.columnExists('agents', 'parent_agent_id') ||
      !this.columnExists('agents', 'depth') ||
      !this.columnExists('agents', 'can_delegate') ||
      !this.columnExists('agents', 'manager_policy_json');
    if (v37NeedsWork) this.db.exec(this.idempotentMigrationSql(v37.sql));

    const v38 = this.migrationForVersion(38);
    if (!this.tableExists('team_executions')) this.db.exec(this.idempotentMigrationSql(v38.sql));
  }

  private applyLegacyProjectMigrations(): void {
    const v55 = this.migrationForVersion(55);
    const v55Sql = v55.sql.replace(
      /ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects\(id\) ON DELETE SET NULL;\s*/,
      '',
    );
    if (!this.tableExists('projects')) this.db.exec(this.idempotentMigrationSql(v55Sql));
    this.ensureColumn('tasks', 'project_id', 'TEXT REFERENCES projects(id) ON DELETE SET NULL');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS tasks_project_activity_idx ON tasks(project_id, pinned DESC, updated_at DESC, id)',
    );

    const v56 = this.migrationForVersion(56);
    this.ensureColumn('projects', 'instruction', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn(
      'projects',
      'context_epoch',
      'INTEGER NOT NULL DEFAULT 0 CHECK (context_epoch >= 0)',
    );
    this.ensureColumn('input_queue', 'payload_digest', "TEXT NOT NULL DEFAULT ''");
    const v56Sql = v56.sql
      .replace(/ALTER TABLE projects ADD COLUMN instruction TEXT NOT NULL DEFAULT '';\s*/, '')
      .replace(
        /ALTER TABLE projects ADD COLUMN context_epoch INTEGER NOT NULL DEFAULT 0\s+CHECK \(context_epoch >= 0\);\s*/,
        '',
      )
      .replace(
        /ALTER TABLE input_queue ADD COLUMN payload_digest TEXT NOT NULL DEFAULT '';\s*/,
        '',
      );
    this.db.exec(this.idempotentMigrationSql(v56Sql));

    const v57 = this.migrationForVersion(57);
    if (!this.tableExists('project_references')) this.db.exec(this.idempotentMigrationSql(v57.sql));
    if (this.tableExists('project_reference_files')) {
      this.db.exec(`
        INSERT INTO project_references(
          id, project_id, source_task_id, relative_path, registered_root_identity,
          enabled, revision, last_sealed_digest, created_at, updated_at
        )
        SELECT id, project_id, source_task_id, relative_path, workspace_binding_digest,
          enabled, CASE WHEN revision < 1 THEN 1 ELSE revision END,
          NULLIF(content_digest, ''), created_at, updated_at
        FROM project_reference_files;
      `);
      this.db.exec('DROP TABLE project_reference_files');
    }

    const v58 = this.migrationForVersion(58);
    if (!this.tableExists('project_memories')) this.db.exec(this.idempotentMigrationSql(v58.sql));
    else if (!this.columnExists('project_memories', 'local_only'))
      this.rebuildLegacyProjectMemories(v58.sql);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS project_memories_project_order_idx ON project_memories(project_id, status, updated_at DESC, id)',
    );
  }

  private rebuildLegacyProjectMemories(migrationSql: string): void {
    if (this.tableExists('project_memories_legacy_v1'))
      throw new Error('Legacy Project memory archive already exists');
    this.db.exec('DROP INDEX IF EXISTS project_memories_project_order_idx');
    this.db.exec('ALTER TABLE project_memories RENAME TO project_memories_legacy_v1');
    this.db.exec(this.idempotentMigrationSql(migrationSql));
    this.db.exec('ALTER TABLE project_memories_legacy_v1 ADD COLUMN migration_reason TEXT');
    const hasLocalOnly = this.columnExists('project_memories_legacy_v1', 'local_only');
    const rows = this.db
      .prepare(
        `SELECT id, project_id, content, status, source_task_id, source_turn_id,
                revision, created_at, updated_at, ${hasLocalOnly ? 'local_only' : '0'} AS local_only
         FROM project_memories_legacy_v1
         ORDER BY created_at, id`,
      )
      .all() as {
      id: string;
      project_id: string;
      content: string;
      status: 'draft' | 'active' | 'disabled';
      source_task_id: string | null;
      source_turn_id: string | null;
      revision: number;
      local_only: number;
      created_at: string;
      updated_at: string;
    }[];
    const fallbackTaskByProject = new Map<string, string>();
    const updateArchive = this.db.prepare(
      'UPDATE project_memories_legacy_v1 SET migration_reason = ? WHERE id = ?',
    );
    const insertCurrent = this.db.prepare(`
      INSERT INTO project_memories(
        id, project_id, source_task_id, source_turn_id, content, status,
        revision, local_only, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const turnSource = this.db.prepare('SELECT 1 FROM turns WHERE id = ? AND task_id = ? LIMIT 1');
    for (const row of rows) {
      const sourceIsValid =
        row.source_task_id !== null &&
        row.source_turn_id !== null &&
        turnSource.get(row.source_turn_id, row.source_task_id) !== undefined;
      let sourceTaskId = row.source_task_id;
      let sourceTurnId = row.source_turn_id;
      let migrationReason: string;
      if (!sourceIsValid) {
        const fallback = this.createLegacyProjectMemoryProvenance(
          row.project_id,
          row.content,
          fallbackTaskByProject,
          row.created_at,
        );
        sourceTaskId = fallback.taskId;
        sourceTurnId = fallback.turnId;
        migrationReason =
          row.source_task_id === null
            ? 'missing_source_task'
            : row.source_turn_id === null
              ? 'missing_source_turn'
              : 'invalid_source_provenance';
      } else if (row.status === 'draft') migrationReason = 'draft_status_mapped_to_disabled';
      else migrationReason = 'legacy_row_copied';
      insertCurrent.run(
        row.id,
        row.project_id,
        sourceTaskId,
        sourceTurnId,
        row.content,
        row.status === 'active' ? 'active' : 'disabled',
        Math.max(1, row.revision),
        row.local_only === 1 ? 1 : 0,
        row.created_at,
        row.updated_at,
      );
      updateArchive.run(migrationReason, row.id);
    }
  }

  private createLegacyProjectMemoryProvenance(
    projectId: string,
    content: string,
    fallbackTaskByProject: Map<string, string>,
    createdAt: string,
  ): { taskId: string; turnId: string } {
    let taskId = fallbackTaskByProject.get(projectId);
    if (taskId === undefined) {
      taskId = randomUUID();
      const threadId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO tasks(id, title, pinned, archived, created_at, updated_at, project_id)
           VALUES (?, ?, 0, 1, ?, ?, ?)`,
        )
        .run(taskId, 'Imported Project memory provenance', now, now, projectId);
      if (this.tableExists('agent_threads')) {
        this.db
          .prepare(
            `INSERT INTO agent_threads(
               id, task_id, runtime_kind, state, active_turn_id, revision, created_at, updated_at
             ) VALUES (?, ?, 'mock', 'completed', NULL, 0, ?, ?)`,
          )
          .run(threadId, taskId, now, now);
        if (this.columnExists('tasks', 'primary_thread_id'))
          this.db
            .prepare('UPDATE tasks SET primary_thread_id = ? WHERE id = ?')
            .run(threadId, taskId);
      }
      fallbackTaskByProject.set(projectId, taskId);
    }
    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messages(id, task_id, turn_id, author, content, created_at)
         VALUES (?, ?, ?, 'user', ?, ?)`,
      )
      .run(userMessageId, taskId, turnId, 'Imported legacy Project memory', createdAt);
    this.db
      .prepare(
        `INSERT INTO turns(
           id, task_id, user_message_id, state, seq, runtime_kind, model, created_at, updated_at
         ) VALUES (?, ?, ?, 'completed', 0, 'mock', 'auto', ?, ?)`,
      )
      .run(turnId, taskId, userMessageId, createdAt, now);
    this.db
      .prepare(
        `INSERT INTO messages(id, task_id, turn_id, author, content, created_at)
         VALUES (?, ?, ?, 'assistant', ?, ?)`,
      )
      .run(assistantMessageId, taskId, turnId, content, createdAt);
    this.db
      .prepare('UPDATE turns SET assistant_message_id = ? WHERE id = ?')
      .run(assistantMessageId, turnId);
    return { taskId, turnId };
  }

  private backfillLegacyMutationScopes(): void {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_path FROM tasks
         WHERE workspace_path IS NOT NULL AND mutation_scope_key IS NULL`,
      )
      .all() as { id: string; workspace_path: string }[];
    const update = this.db.prepare(
      `UPDATE tasks SET mutation_scope_key = ?, mutation_root_identity_digest = ? WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const legacyKey = legacyMutationWorkspaceKey(row.workspace_path);
        update.run(legacyKey, legacyKey, row.id);
      }
    })();
  }

  private backfillLegacyEditSagaBindings(): void {
    const rows = this.db
      .prepare(`SELECT id, snapshot_json FROM edit_sagas WHERE binding_version = 0`)
      .all() as {
      id: string;
      snapshot_json: string;
    }[];
    const update = this.db.prepare(
      `UPDATE edit_sagas SET workspace_key = NULL, root_identity_digest = NULL,
       snapshot_json = ?, binding_version = 1
       WHERE id = ? AND binding_version = 0`,
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const raw = JSON.parse(row.snapshot_json) as Record<string, unknown>;
        raw['workspaceKey'] = null;
        raw['rootIdentityDigest'] = null;
        const steps = raw['steps'];
        if (!Array.isArray(steps)) throw new Error('Invalid legacy Edit Saga steps');
        const operations = steps.map(
          (step) =>
            (step as { operation: EditSagaSnapshot['steps'][number]['operation'] }).operation,
        );
        const journalDigest =
          'rootId' in raw
            ? journaledPatchDigest({
                version: 3,
                policyEpoch: raw['policyEpoch'] as number,
                rootId: raw['rootId'] as string | null,
                workspaceKey: null,
                rootIdentityDigest: null,
                operations,
              })
            : journaledPatchDigest({
                version: 2,
                policyEpoch: raw['policyEpoch'] as number,
                workspaceKey: null,
                rootIdentityDigest: null,
                operations,
              });
        raw['journalDigest'] = journalDigest;
        update.run(JSON.stringify(raw), row.id);
      }
    })();
  }

  private backfillLegacyNativeEditSagaRevisions(): void {
    const rows = this.db
      .prepare(`SELECT id, snapshot_json FROM edit_sagas WHERE native_binding_version = 0`)
      .all() as { id: string; snapshot_json: string }[];
    const update = this.db.prepare(
      `UPDATE edit_sagas SET snapshot_json = ?, native_binding_version = 1
       WHERE id = ? AND native_binding_version = 0`,
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const raw = JSON.parse(row.snapshot_json) as Record<string, unknown>;
        const steps = raw['steps'];
        if (!Array.isArray(steps)) throw new Error('Invalid legacy Edit Saga steps');
        for (const [index, value] of steps.entries()) {
          if (typeof value !== 'object' || value === null)
            throw new Error('Invalid legacy Edit Saga step');
          const step = value as Record<string, unknown>;
          const operationValue = step['operation'];
          if (typeof operationValue !== 'object' || operationValue === null)
            throw new Error('Invalid legacy Edit Saga operation');
          const operation = operationValue as Record<string, unknown>;
          if ('preRevision' in operation) continue;
          if (operation['kind'] === 'add') {
            operation['preRevision'] = null;
            continue;
          }
          const artifactValue = operation['preArtifact'];
          if (typeof artifactValue !== 'object' || artifactValue === null)
            throw new Error('Invalid legacy Edit Saga pre-artifact');
          const artifact = artifactValue as Record<string, unknown>;
          operation['preRevision'] = {
            identityDigest: digestJson(['legacy-untracked-native-identity-v1', row.id, index + 1]),
            contentHash: artifact['contentHash'],
            size: artifact['size'],
            mode: 0o100000,
            nlink: 1,
          };
        }
        const operations = steps.map(
          (step) =>
            (step as { operation: EditSagaSnapshot['steps'][number]['operation'] }).operation,
        );
        raw['journalDigest'] =
          'rootId' in raw
            ? journaledPatchDigest({
                version: 3,
                policyEpoch: raw['policyEpoch'] as number,
                rootId: raw['rootId'] as string | null,
                workspaceKey: raw['workspaceKey'] as string | null,
                rootIdentityDigest: raw['rootIdentityDigest'] as string | null,
                operations,
              })
            : journaledPatchDigest({
                version: 2,
                policyEpoch: raw['policyEpoch'] as number,
                workspaceKey: raw['workspaceKey'] as string | null,
                rootIdentityDigest: raw['rootIdentityDigest'] as string | null,
                operations,
              });
        update.run(JSON.stringify(raw), row.id);
      }
    })();
  }

  private backfillLegacyEditSagaRootBindings(): void {
    const rows = this.db
      .prepare(`SELECT id, snapshot_json FROM edit_sagas WHERE root_binding_version = 0`)
      .all() as { id: string; snapshot_json: string }[];
    const update = this.db.prepare(
      `UPDATE edit_sagas SET root_id = NULL, snapshot_json = ?, root_binding_version = 1
       WHERE id = ? AND root_binding_version = 0`,
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const raw = JSON.parse(row.snapshot_json) as Record<string, unknown>;
        raw['rootId'] = null;
        const steps = raw['steps'];
        if (!Array.isArray(steps)) throw new Error('Invalid legacy Edit Saga steps');
        raw['journalDigest'] = journaledPatchDigest({
          version: 3,
          policyEpoch: raw['policyEpoch'] as number,
          rootId: null,
          workspaceKey: raw['workspaceKey'] as string | null,
          rootIdentityDigest: raw['rootIdentityDigest'] as string | null,
          operations: steps.map(
            (step) =>
              (step as { operation: EditSagaSnapshot['steps'][number]['operation'] }).operation,
          ),
        });
        update.run(JSON.stringify(raw), row.id);
      }
    })();
  }

  private backfillAcceptanceContracts(): void {
    const turns = this.db
      .prepare(
        `SELECT turns.id, turns.task_id, turns.created_at, messages.content
         FROM turns JOIN messages ON messages.id = turns.user_message_id
         ORDER BY turns.created_at, turns.id`,
      )
      .all() as { id: string; task_id: string; created_at: string; content: string }[];
    this.db.transaction(() => {
      for (const turn of turns) {
        const row = this.db
          .prepare(
            `SELECT 1 AS present FROM acceptance_contracts
             WHERE turn_id = ? ORDER BY revision DESC LIMIT 1`,
          )
          .get(turn.id) as { present: 1 } | undefined;
        let contract =
          row === undefined
            ? createInitialAcceptanceContract({
                taskId: turn.task_id,
                turnId: turn.id,
                objective: turn.content,
                createdAt: turn.created_at,
              })
            : this.getAcceptanceContract(turn.task_id, turn.id);
        if (row === undefined) this.insertAcceptanceContract(contract);
        const sagaRows = this.db
          .prepare('SELECT * FROM edit_sagas WHERE turn_id = ? ORDER BY created_at, id')
          .all(turn.id) as EditSagaRow[];
        const contractIsCurrent = sagaRows.every((saga) =>
          [`edit-saga:${saga.id}`, `verification:${saga.id}`].every((criterionId) =>
            contract.criteria.some(
              (criterion) =>
                criterion.id === criterionId && criterion.subjectDigest === saga.plan_digest,
            ),
          ),
        );
        if (contractIsCurrent) continue;
        const sagas = sagaRows.map(toEditSaga);
        for (const saga of sagas) {
          const next = appendEditSagaCriterion(contract, {
            sagaId: saga.id,
            planDigest: saga.planDigest,
            paths: saga.steps.flatMap((step) =>
              step.operation.destination === null
                ? [step.operation.path]
                : [step.operation.path, step.operation.destination],
            ),
          });
          if (next !== contract) {
            contract = next;
            this.insertAcceptanceContract(contract);
          }
        }
        for (const saga of sagas) if (saga.state === 'committed') this.recordEditSagaEvidence(saga);
      }
    })();
  }

  listTasks(): TaskSummary[] {
    return (
      this.db
        .prepare(
          `SELECT tasks.*,
             EXISTS(
               SELECT 1 FROM messages
               WHERE messages.task_id = tasks.id AND messages.author = 'user'
             ) AS has_conversation
           FROM tasks
           ORDER BY pinned DESC, updated_at DESC, id`,
        )
        .all() as (TaskRow & { has_conversation: number })[]
    ).map((row) => toTask(row, row.has_conversation === 1));
  }

  getTask(taskId: string): TaskSummary {
    return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
  }

  createTask(title?: string, localOnly = false, projectId?: string): TaskSummary {
    const now = new Date().toISOString();
    const primaryThreadId = randomUUID();
    const leaderAgentId = randomUUID();
    const runtimeKind = this.getRuntime();
    const modelSelection = modelSelectionForRuntime(runtimeKind, this.getModel());
    // An explicit title is the caller's choice and must survive the first message, so it is
    // recorded as 'manual'. Only the placeholder is eligible for auto-naming (issue #4).
    const titleSource = title === undefined ? 'default' : 'manual';
    const task = taskSummarySchema.parse({
      id: randomUUID(),
      projectId: projectId ?? null,
      title: title ?? DEFAULT_TASK_TITLE,
      pinned: false,
      archived: false,
      goal: null,
      goalState: null,
      workspacePath: null,
      localOnly,
      hasConversation: false,
      createdAt: now,
      updatedAt: now,
    });
    this.db.transaction(() => {
      let legacyProjectWorkspaceFallback = 0;
      if (projectId !== undefined) {
        this.assertProjectAcceptsTask(projectId);
        legacyProjectWorkspaceFallback =
          this.getProjectRow(projectId).workspace_roots_configured === 0 ? 1 : 0;
      }
      this.db
        .prepare(
          `INSERT INTO tasks(
             id, title, pinned, archived, goal, workspace_path, local_only, draft,
             primary_thread_id, title_source, created_at, updated_at, project_id,
             legacy_project_workspace_fallback
           ) VALUES (?, ?, 0, 0, NULL, NULL, ?, '', NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.title,
          localOnly ? 1 : 0,
          titleSource,
          now,
          now,
          projectId ?? null,
          legacyProjectWorkspaceFallback,
        );
      this.db
        .prepare(
          `INSERT INTO agent_threads(
             id, task_id, runtime_kind, state, active_turn_id, revision,
             connection_id, requested_provider, requested_model, created_at, updated_at
           ) VALUES (?, ?, ?, 'active', NULL, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          primaryThreadId,
          task.id,
          runtimeKind,
          modelSelection.connectionId,
          modelSelection.requestedProvider,
          modelSelection.requestedModel,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO agents(
             id, team_id, thread_id, task_id, kind, role, state, objective,
             parent_capability_ceiling_json, context_inheritance_policy,
             connection_id, requested_provider, requested_model,
             parent_agent_id, depth, can_delegate, manager_policy_json, created_at, updated_at
           ) VALUES (
             ?, NULL, ?, ?, 'leader', 'leader', 'ready', NULL, NULL, NULL, ?, ?, ?,
             NULL, 0, 1, ?, ?, ?
           )`,
        )
        .run(
          leaderAgentId,
          primaryThreadId,
          task.id,
          modelSelection.connectionId,
          modelSelection.requestedProvider,
          modelSelection.requestedModel,
          MANAGER_POLICY_SEED,
          now,
          now,
        );
      this.db
        .prepare('UPDATE tasks SET primary_thread_id = ? WHERE id = ?')
        .run(primaryThreadId, task.id);
    })();
    return task;
  }

  listProjects(): ProjectSummary[] {
    return (
      this.db
        .prepare(
          `SELECT p.*,
             (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.archived = 0) AS task_count,
             (SELECT COUNT(*) FROM project_workspace_roots r WHERE r.project_id = p.id) AS folder_count,
             (SELECT id FROM project_workspace_roots r WHERE r.project_id = p.id AND r.role = 'primary') AS primary_folder_id,
             (SELECT canonical_path FROM project_workspace_roots r WHERE r.project_id = p.id AND r.role = 'primary') AS primary_folder_path,
             (SELECT label FROM project_workspace_roots r WHERE r.project_id = p.id AND r.role = 'primary') AS primary_folder_label,
             MAX(p.updated_at, COALESCE((SELECT MAX(t.updated_at) FROM tasks t WHERE t.project_id = p.id), p.updated_at)) AS last_activity_at
           FROM projects p
           ORDER BY last_activity_at DESC, p.id`,
        )
        .all() as ProjectRow[]
    ).map(toProject);
  }

  createProject(
    input: string | { name: string; folders?: readonly ProjectFolderBinding[] },
  ): ProjectSummary {
    const parsedName = parseProjectName(typeof input === 'string' ? input : input.name);
    const folders = typeof input === 'string' ? [] : [...(input.folders ?? [])];
    const workspaceRootsConfigured = typeof input !== 'string' && input.folders !== undefined;
    validateProjectFolderBindings(folders);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects(
             id, name, archived, revision, workspace_roots_configured, created_at, updated_at
           ) VALUES (?, ?, 0, 1, ?, ?, ?)`,
        )
        .run(id, parsedName, workspaceRootsConfigured ? 1 : 0, now, now);
      this.insertProjectFolders(id, folders, now);
    })();
    return this.getProject(id);
  }

  listProjectFolders(projectId: string): ProjectFolder[] {
    this.getProjectRow(projectId);
    return this.getProjectRootRows(projectId).map(toProjectFolder);
  }

  getProjectFolderRootIdentities(projectId: string): ReadonlyMap<string, string> {
    this.getProjectRow(projectId);
    return new Map(
      this.getProjectRootRows(projectId).map(({ id, root_identity_digest }) => [
        id,
        root_identity_digest,
      ]),
    );
  }

  getEffectiveWorkspaceRootIdentities(taskId: string): ReadonlyMap<string, string> {
    const task = this.getTaskRow(taskId);
    const roots = task.project_id === null ? [] : this.getProjectRootRows(task.project_id);
    return new Map(
      effectiveWorkspaceBindings(task, roots).map(({ rootId, rootIdentityDigest }) => [
        rootId,
        rootIdentityDigest,
      ]),
    );
  }

  getEffectiveWorkspaceMutationBindings(
    taskId: string,
  ): ReadonlyMap<string, Readonly<{ workspaceKey: string; rootIdentityDigest: string }>> {
    const task = this.getTaskRow(taskId);
    const roots = task.project_id === null ? [] : this.getProjectRootRows(task.project_id);
    return new Map(
      effectiveWorkspaceBindings(task, roots).map(
        ({ rootId, workspaceKey, rootIdentityDigest }) => [
          rootId,
          Object.freeze({ workspaceKey, rootIdentityDigest }),
        ],
      ),
    );
  }

  getTurnWorkspaceRootIdentities(turnId: string): ReadonlyMap<string, string> {
    return new Map(
      (
        this.db
          .prepare(
            `SELECT root_id, root_identity_digest
             FROM turn_workspace_roots WHERE turn_id = ? ORDER BY ordinal`,
          )
          .all(turnId) as { root_id: string; root_identity_digest: string }[]
      ).map((root) => [root.root_id, root.root_identity_digest]),
    );
  }

  getTurnWorkspaceMutationBindings(
    turnId: string,
  ): ReadonlyMap<string, Readonly<{ workspaceKey: string; rootIdentityDigest: string }>> {
    return new Map(
      (
        this.db
          .prepare(
            `SELECT root_id, workspace_key, root_identity_digest
             FROM turn_workspace_roots WHERE turn_id = ? ORDER BY ordinal`,
          )
          .all(turnId) as {
          root_id: string;
          workspace_key: string;
          root_identity_digest: string;
        }[]
      ).map((root) => [
        root.root_id,
        Object.freeze({
          workspaceKey: root.workspace_key,
          rootIdentityDigest: root.root_identity_digest,
        }),
      ]),
    );
  }

  replaceProjectFolders(input: {
    projectId: string;
    expectedRevision: number;
    folders: readonly ProjectFolderBinding[];
  }): ProjectSummary {
    const folders = [...input.folders];
    validateProjectFolderBindings(folders);
    return this.db.transaction(() => {
      const project = this.getProjectRow(input.projectId);
      if (project.revision !== input.expectedRevision)
        throw new ProjectConflictError('Stale Project revision');
      const current = this.getProjectRootRows(input.projectId);
      const assignedIds = assignProjectFolderIds(current, folders);
      const next = folders.map((folder, ordinal) => ({
        ...folder,
        id: assignedIds[ordinal]!,
        ordinal,
      }));
      const unchanged =
        project.workspace_roots_configured === 1 &&
        current.length === next.length &&
        current.every((root, ordinal) => {
          const candidate = next[ordinal]!;
          return (
            root.id === candidate.id &&
            pathsEquivalent(root.canonical_path, candidate.canonicalPath) &&
            root.label === (candidate.label ?? folderLabel(candidate.canonicalPath)) &&
            root.role === candidate.role &&
            root.workspace_key === candidate.workspaceKey &&
            root.root_identity_digest === candidate.rootIdentityDigest
          );
        });
      if (unchanged) return this.getProject(input.projectId);
      this.assertProjectFolderMutationAllowed(input.projectId, current, folders);
      const retained = new Set(next.map(({ id }) => id));
      const removed = current.filter(({ id }) => !retained.has(id));
      if (
        removed.some(
          ({ id }) =>
            this.db
              .prepare('SELECT 1 FROM project_references WHERE project_root_id = ? LIMIT 1')
              .get(id) !== undefined,
        )
      )
        throw new ReferenceInUseError();
      const now = new Date().toISOString();
      const currentIds = new Set(current.map(({ id }) => id));
      const removeRoot = this.db.prepare('DELETE FROM project_workspace_roots WHERE id = ?');
      for (const root of removed) removeRoot.run(root.id);
      const updateSecondary = this.db.prepare(
        `UPDATE project_workspace_roots
         SET canonical_path = ?, label = ?, role = 'secondary', ordinal = ?,
             workspace_key = ?, root_identity_digest = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      );
      const insertSecondary = this.db.prepare(
        `INSERT INTO project_workspace_roots(
           id, project_id, canonical_path, label, role, ordinal,
           workspace_key, root_identity_digest, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'secondary', ?, ?, ?, ?, ?)`,
      );
      for (const folder of next.filter(({ role }) => role === 'secondary')) {
        if (currentIds.has(folder.id))
          updateSecondary.run(
            folder.canonicalPath,
            folder.label,
            folder.ordinal,
            folder.workspaceKey,
            folder.rootIdentityDigest,
            now,
            folder.id,
            input.projectId,
          );
        else
          insertSecondary.run(
            folder.id,
            input.projectId,
            folder.canonicalPath,
            folder.label,
            folder.ordinal,
            folder.workspaceKey,
            folder.rootIdentityDigest,
            now,
            now,
          );
      }
      const primary = next.find(({ role }) => role === 'primary');
      if (primary !== undefined) {
        if (currentIds.has(primary.id)) {
          updateSecondary.run(
            primary.canonicalPath,
            primary.label,
            primary.ordinal,
            primary.workspaceKey,
            primary.rootIdentityDigest,
            now,
            primary.id,
            input.projectId,
          );
          this.db
            .prepare("UPDATE project_workspace_roots SET role = 'primary' WHERE id = ?")
            .run(primary.id);
        } else {
          insertSecondary.run(
            primary.id,
            input.projectId,
            primary.canonicalPath,
            primary.label,
            primary.ordinal,
            primary.workspaceKey,
            primary.rootIdentityDigest,
            now,
            now,
          );
          this.db
            .prepare("UPDATE project_workspace_roots SET role = 'primary' WHERE id = ?")
            .run(primary.id);
        }
      }
      const updated = this.db
        .prepare(
          `UPDATE projects SET revision = revision + 1, context_epoch = context_epoch + 1,
             workspace_roots_configured = 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(now, input.projectId, input.expectedRevision);
      if (updated.changes !== 1) throw new ProjectConflictError('Stale Project revision');
      this.db
        .prepare(
          `UPDATE tasks SET context_epoch = context_epoch + 1,
             legacy_project_workspace_fallback = 0, updated_at = ? WHERE project_id = ?`,
        )
        .run(now, input.projectId);
      this.bumpProjectTaskPolicyEpochs(input.projectId, now);
      this.quarantineBackgroundForProjectContextInTransaction(input.projectId, now);
      return this.getProject(input.projectId);
    })();
  }

  private insertProjectFolders(
    projectId: string,
    folders: readonly ProjectFolderBinding[],
    now: string,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO project_workspace_roots(
         id, project_id, canonical_path, label, role, ordinal,
         workspace_key, root_identity_digest, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    folders.forEach((folder, ordinal) =>
      insert.run(
        folder.id ?? randomUUID(),
        projectId,
        folder.canonicalPath,
        folder.label ?? folderLabel(folder.canonicalPath),
        folder.role,
        ordinal,
        folder.workspaceKey,
        folder.rootIdentityDigest,
        now,
        now,
      ),
    );
  }

  private getProjectRootRows(projectId: string): ProjectWorkspaceRootRow[] {
    return this.db
      .prepare('SELECT * FROM project_workspace_roots WHERE project_id = ? ORDER BY ordinal, id')
      .all(projectId) as ProjectWorkspaceRootRow[];
  }

  private assertProjectFolderMutationAllowed(
    projectId: string,
    current: readonly ProjectWorkspaceRootRow[],
    next: readonly ProjectFolderBinding[],
  ): void {
    const busyTask = this.db
      .prepare(
        `SELECT 1 FROM tasks t WHERE t.project_id = ? AND (
           EXISTS (SELECT 1 FROM turns tr WHERE tr.task_id = t.id AND tr.state NOT IN ('completed', 'failed', 'canceled', 'interrupted'))
           OR EXISTS (SELECT 1 FROM input_queue q WHERE q.task_id = t.id AND q.state = 'queued')
           OR EXISTS (
             SELECT 1 FROM teams tm WHERE tm.task_id = t.id AND (
               EXISTS (SELECT 1 FROM team_executions e WHERE e.team_id = tm.id AND e.state NOT IN ('completed', 'failed', 'canceled'))
               OR EXISTS (SELECT 1 FROM team_missions m WHERE m.team_id = tm.id AND m.state NOT IN ('completed', 'failed', 'canceled'))
             )
           )
           OR EXISTS (SELECT 1 FROM edit_sagas s WHERE s.task_id = t.id AND s.state NOT IN ('committed', 'restored'))
         ) LIMIT 1`,
      )
      .get(projectId);
    if (busyTask !== undefined)
      throw new ProjectFolderMutationBlockedError('Project has active work');
    const keys = new Set([
      ...current.map(({ workspace_key }) => workspace_key),
      ...next.map(({ workspaceKey }) => workspaceKey),
    ]);
    const stateQuery = this.db.prepare(
      `SELECT state FROM workspace_mutation_state WHERE workspace_key = ? AND state <> 'idle'`,
    );
    const quarantineQuery = this.db.prepare(
      `SELECT 1 FROM task_mutation_quarantines WHERE workspace_key = ? AND cleared_at IS NULL LIMIT 1`,
    );
    for (const key of keys)
      if (stateQuery.get(key) !== undefined || quarantineQuery.get(key) !== undefined)
        throw new ProjectFolderMutationBlockedError('Project Workspace is leased or recovering');
  }

  private bumpProjectTaskPolicyEpochs(projectId: string, now: string): void {
    const rows = this.db
      .prepare(
        `SELECT s.task_id, s.policy_epoch FROM permission_policy_state s
         JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ?`,
      )
      .all(projectId) as { task_id: string; policy_epoch: number }[];
    for (const row of rows) {
      const nextEpoch = row.policy_epoch + 1;
      this.db
        .prepare(
          'UPDATE permission_policy_state SET policy_epoch = ?, updated_at = ? WHERE task_id = ?',
        )
        .run(nextEpoch, now, row.task_id);
      this.db
        .prepare(
          'UPDATE permission_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE task_id = ?',
        )
        .run(now, row.task_id);
      this.enqueuePermissionPolicyEpoch(row.task_id, nextEpoch, now);
    }
  }

  updateProject(input: {
    projectId: string;
    expectedRevision: number;
    name?: string | undefined;
    archived?: boolean | undefined;
  }): ProjectSummary {
    if (input.name === undefined && input.archived === undefined)
      throw new InvalidProjectError('No Project fields were supplied');
    const name = input.name === undefined ? undefined : parseProjectName(input.name);
    return this.db.transaction(() => {
      const current = this.getProjectRow(input.projectId);
      if (current.revision !== input.expectedRevision)
        throw new ProjectConflictError('Stale Project revision');
      const nextName = name ?? current.name;
      const nextArchived = input.archived === undefined ? current.archived : input.archived ? 1 : 0;
      if (nextName === current.name && nextArchived === current.archived)
        return this.getProject(input.projectId);
      const result = this.db
        .prepare(
          `UPDATE projects
           SET name = ?, archived = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          nextName,
          nextArchived,
          new Date().toISOString(),
          input.projectId,
          input.expectedRevision,
        );
      if (result.changes !== 1) throw new ProjectConflictError('Stale Project revision');
      return this.getProject(input.projectId);
    })();
  }

  getProjectInstruction(projectId: string): {
    instruction: string;
    revision: number;
    contextEpoch: number;
  } {
    const project = this.getProjectRow(projectId);
    return {
      instruction: project.instruction,
      revision: project.revision,
      contextEpoch: project.context_epoch,
    };
  }

  setProjectInstruction(input: {
    projectId: string;
    expectedRevision: number;
    instruction: string;
  }): { instruction: string; revision: number; contextEpoch: number } {
    if (
      typeof input.instruction !== 'string' ||
      Buffer.byteLength(input.instruction, 'utf8') > 16_384
    )
      throw new InvalidProjectError('Project instruction must not exceed 16 KiB');
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const current = this.getProjectRow(input.projectId);
      if (current.revision !== input.expectedRevision) throw new ProjectConflictError();
      if (current.instruction === input.instruction)
        return {
          instruction: current.instruction,
          revision: current.revision,
          contextEpoch: current.context_epoch,
        };
      const changes = this.db
        .prepare(
          `UPDATE projects
           SET instruction = ?, revision = revision + 1,
               context_epoch = context_epoch + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(input.instruction, now, input.projectId, input.expectedRevision).changes;
      if (changes !== 1) throw new ProjectConflictError();
      this.quarantineBackgroundForProjectContextInTransaction(input.projectId, now);
      const updated = this.getProjectRow(input.projectId);
      return {
        instruction: updated.instruction,
        revision: updated.revision,
        contextEpoch: updated.context_epoch,
      };
    })();
  }

  listProjectReferences(projectId: string): ProjectReference[] {
    this.getProjectRow(projectId);
    return (
      this.db
        .prepare('SELECT * FROM project_references WHERE project_id = ? ORDER BY created_at, id')
        .all(projectId) as ProjectReferenceRow[]
    ).map((row) => this.toProjectReference(row));
  }

  addProjectReference(input: {
    projectId: string;
    sourceTaskId?: string;
    projectRootId?: string;
    relativePath: string;
    registeredRootIdentity: string;
  }): ProjectReference {
    const relativePath = parseReferenceRelativePath(input.relativePath);
    return this.db.transaction(() => {
      const project = this.getProjectRow(input.projectId);
      if (project.archived === 1) throw new ProjectArchivedError();
      if ((input.sourceTaskId === undefined) === (input.projectRootId === undefined))
        throw new InvalidProjectError('Exactly one reference root must be supplied');
      let workspacePath: string | null;
      if (input.projectRootId !== undefined) {
        const root = this.getProjectRootRow(input.projectRootId);
        if (root.project_id !== input.projectId)
          throw new InvalidProjectError('Reference root must belong to the Project');
        workspacePath = root.canonical_path;
        if (root.root_identity_digest !== input.registeredRootIdentity)
          throw new InvalidProjectError('Reference root identity changed');
      } else {
        const task = this.getTaskRow(input.sourceTaskId!);
        if (task.project_id !== input.projectId)
          throw new InvalidProjectError('Reference source Task must belong to the Project');
        workspacePath = task.workspace_path;
        if (task.mutation_root_identity_digest !== input.registeredRootIdentity)
          throw new InvalidProjectError('Reference source Workspace changed');
      }
      if (workspacePath === null) throw new InvalidProjectError('Reference root is unavailable');
      const readable = readProjectReference({
        workspacePath,
        registeredRootIdentity: input.registeredRootIdentity,
        relativePath,
      });
      if (readable.status !== 'healthy')
        throw new InvalidProjectError(`Reference is not readable: ${readable.status}`);
      const count = this.db
        .prepare('SELECT COUNT(*) AS count FROM project_references WHERE project_id = ?')
        .get(input.projectId) as { count: number };
      if (count.count >= 64) throw new InvalidProjectError('Project reference limit reached');
      const now = new Date().toISOString();
      const id = randomUUID();
      try {
        this.db
          .prepare(
            `INSERT INTO project_references(
               id, project_id, source_task_id, project_root_id, relative_path, registered_root_identity,
               enabled, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
          )
          .run(
            id,
            input.projectId,
            input.sourceTaskId ?? null,
            input.projectRootId ?? null,
            relativePath,
            input.registeredRootIdentity,
            now,
            now,
          );
      } catch (error) {
        if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE')
          throw new InvalidProjectError('Reference is already registered');
        throw error;
      }
      this.bumpProjectContextInTransaction(input.projectId, now);
      return this.toProjectReference(this.getProjectReferenceRow(id));
    })();
  }

  updateProjectReference(input: {
    referenceId: string;
    expectedRevision: number;
    enabled: boolean;
  }): ProjectReference {
    return this.db.transaction(() => {
      const current = this.getProjectReferenceRow(input.referenceId);
      if (current.revision !== input.expectedRevision) throw new ProjectConflictError();
      if ((current.enabled === 1) === input.enabled) return this.toProjectReference(current);
      const now = new Date().toISOString();
      const changed = this.db
        .prepare(
          `UPDATE project_references SET enabled = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(input.enabled ? 1 : 0, now, input.referenceId, input.expectedRevision).changes;
      if (changed !== 1) throw new ProjectConflictError();
      this.bumpProjectContextInTransaction(current.project_id, now);
      return this.toProjectReference(this.getProjectReferenceRow(input.referenceId));
    })();
  }

  removeProjectReference(referenceId: string, expectedRevision: number): void {
    this.db.transaction(() => {
      const current = this.getProjectReferenceRow(referenceId);
      if (current.revision !== expectedRevision) throw new ProjectConflictError();
      const removed = this.db
        .prepare('DELETE FROM project_references WHERE id = ? AND revision = ?')
        .run(referenceId, expectedRevision).changes;
      if (removed !== 1) throw new ProjectConflictError();
      this.bumpProjectContextInTransaction(current.project_id, new Date().toISOString());
    })();
  }

  private getProjectReferenceRow(referenceId: string): ProjectReferenceRow {
    const row = this.db
      .prepare('SELECT * FROM project_references WHERE id = ?')
      .get(referenceId) as ProjectReferenceRow | undefined;
    if (row === undefined) throw new NotFoundError('Project reference not found');
    return row;
  }

  private toProjectReference(row: ProjectReferenceRow): ProjectReference {
    const workspace = this.projectReferenceWorkspace(row);
    const read = readProjectReference({
      workspacePath: workspace.path,
      registeredRootIdentity: row.registered_root_identity,
      relativePath: row.relative_path,
    });
    const status =
      read.status === 'healthy' &&
      row.last_sealed_digest !== null &&
      read.digest !== row.last_sealed_digest
        ? 'changed'
        : read.status;
    return {
      id: row.id,
      projectId: row.project_id,
      sourceTaskId: row.source_task_id,
      projectRootId: row.project_root_id,
      relativePath: row.relative_path,
      enabled: row.enabled === 1,
      revision: row.revision,
      lastSealedDigest: row.last_sealed_digest,
      status,
      currentDigest: read.digest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getProjectRootRow(rootId: string): ProjectWorkspaceRootRow {
    const row = this.db
      .prepare('SELECT * FROM project_workspace_roots WHERE id = ?')
      .get(rootId) as ProjectWorkspaceRootRow | undefined;
    if (row === undefined) throw new NotFoundError('Project folder not found');
    return row;
  }

  private projectReferenceWorkspace(row: ProjectReferenceRow): {
    path: string | null;
    localOnly: number;
  } {
    if (row.project_root_id !== null)
      return { path: this.getProjectRootRow(row.project_root_id).canonical_path, localOnly: 0 };
    if (row.source_task_id === null) throw new InvalidProjectError('Reference root is missing');
    const task = this.getTaskRow(row.source_task_id);
    return { path: task.workspace_path, localOnly: task.local_only };
  }

  private bumpProjectContextInTransaction(projectId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE projects SET revision = revision + 1, context_epoch = context_epoch + 1,
           updated_at = ? WHERE id = ?`,
      )
      .run(now, projectId);
    this.quarantineBackgroundForProjectContextInTransaction(projectId, now);
  }

  listProjectMemories(projectId: string): ProjectMemory[] {
    this.getProjectRow(projectId);
    return (
      this.db
        .prepare(
          `SELECT * FROM project_memories WHERE project_id = ?
           ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id`,
        )
        .all(projectId) as ProjectMemoryRow[]
    ).map(toProjectMemory);
  }

  createProjectMemoryFromTurn(input: {
    projectId: string;
    sourceTurnId: string;
    content: string;
  }): ProjectMemory {
    return this.createProjectMemoryFromTurnWithProvenance(input, 'user');
  }

  createAgentProjectMemoryFromTurn(input: {
    projectId: string;
    sourceTurnId: string;
    content: string;
  }): ProjectMemory {
    return this.createProjectMemoryFromTurnWithProvenance(input, 'assistant');
  }

  private createProjectMemoryFromTurnWithProvenance(
    input: { projectId: string; sourceTurnId: string; content: string },
    createdBy: 'user' | 'assistant',
  ): ProjectMemory {
    const content = parseProjectMemoryContent(input.content);
    return this.db.transaction(() => {
      this.getProjectRow(input.projectId);
      const source = this.db
        .prepare(
          `SELECT t.task_id, t.state, t.assistant_message_id, task.local_only,
                  seal.project_id AS sealed_project_id
           FROM turns t
           JOIN tasks task ON task.id = t.task_id
           JOIN context_seals seal ON seal.owner_type = 'turn' AND seal.owner_id = t.id
           WHERE t.id = ?`,
        )
        .get(input.sourceTurnId) as
        | {
            task_id: string;
            state: TurnState;
            assistant_message_id: string | null;
            local_only: number;
            sealed_project_id: string | null;
          }
        | undefined;
      if (source === undefined) throw new NotFoundError('Source Turn not found');
      if (source.state !== 'completed' || source.assistant_message_id === null)
        throw new InvalidProjectError('Memory source must be a completed assistant Turn');
      if (source.sealed_project_id !== input.projectId)
        throw new InvalidProjectError('Memory Project must match the source Turn seal');
      const active = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM project_memories WHERE project_id = ? AND status = 'active'",
        )
        .get(input.projectId) as { count: number };
      if (active.count >= 128) throw new InvalidProjectError('Active Project memory limit reached');
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO project_memories(
             id, project_id, source_task_id, source_turn_id, content, created_by, status,
             revision, local_only, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          source.task_id,
          input.sourceTurnId,
          content,
          createdBy,
          source.local_only,
          now,
          now,
        );
      this.bumpProjectContextInTransaction(input.projectId, now);
      return toProjectMemory(this.getProjectMemoryRow(id));
    })();
  }

  updateProjectMemory(input: {
    memoryId: string;
    expectedRevision: number;
    content?: string | undefined;
    status?: 'active' | 'disabled' | undefined;
  }): ProjectMemory {
    return this.db.transaction(() => {
      const current = this.getProjectMemoryRow(input.memoryId);
      if (current.revision !== input.expectedRevision) throw new ProjectConflictError();
      const content =
        input.content === undefined ? current.content : parseProjectMemoryContent(input.content);
      const status = input.status ?? current.status;
      if (content === current.content && status === current.status) return toProjectMemory(current);
      if (current.status === 'disabled' && status === 'active') {
        const active = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM project_memories WHERE project_id = ? AND status = 'active'",
          )
          .get(current.project_id) as { count: number };
        if (active.count >= 128)
          throw new InvalidProjectError('Active Project memory limit reached');
      }
      const now = new Date().toISOString();
      const changed = this.db
        .prepare(
          `UPDATE project_memories
           SET content = ?, status = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(content, status, now, input.memoryId, input.expectedRevision).changes;
      if (changed !== 1) throw new ProjectConflictError();
      this.bumpProjectContextInTransaction(current.project_id, now);
      return toProjectMemory(this.getProjectMemoryRow(input.memoryId));
    })();
  }

  private getProjectMemoryRow(memoryId: string): ProjectMemoryRow {
    const row = this.db.prepare('SELECT * FROM project_memories WHERE id = ?').get(memoryId) as
      ProjectMemoryRow | undefined;
    if (row === undefined) throw new NotFoundError('Project memory not found');
    return row;
  }

  assignTaskToProject(input: {
    projectId: string;
    taskId: string;
    expectedProjectId: string | null;
  }): TaskSummary {
    return this.changeTaskProject(input.taskId, input.expectedProjectId, input.projectId);
  }

  unassignTaskFromProject(input: {
    taskId: string;
    expectedProjectId: string | null;
  }): TaskSummary {
    return this.changeTaskProject(input.taskId, input.expectedProjectId, null);
  }

  private changeTaskProject(
    taskId: string,
    expectedProjectId: string | null,
    nextProjectId: string | null,
  ): TaskSummary {
    return this.db.transaction(() => {
      const task = this.getTaskRow(taskId);
      if (task.project_id !== expectedProjectId)
        throw new ProjectConflictError('Task Project membership changed');
      if (task.project_id === nextProjectId) return this.getTask(taskId);
      const reference = this.db
        .prepare('SELECT 1 FROM project_references WHERE source_task_id = ? LIMIT 1')
        .get(taskId);
      if (reference !== undefined) throw new ReferenceInUseError();
      if (nextProjectId !== null) this.assertProjectAcceptsTask(nextProjectId);
      if (this.getActiveTurnId(taskId) !== null) throw new TurnActiveError();
      if (this.hasNonTerminalTeamWork(taskId)) throw new TaskAssignmentBlockedError();
      const result = this.db
        .prepare(
          `UPDATE tasks
           SET project_id = ?, legacy_project_workspace_fallback = ?, updated_at = ?
           WHERE id = ? AND project_id IS ?`,
        )
        .run(
          nextProjectId,
          nextProjectId !== null &&
            this.getProjectRow(nextProjectId).workspace_roots_configured === 0
            ? 1
            : 0,
          new Date().toISOString(),
          taskId,
          expectedProjectId,
        );
      if (result.changes !== 1) throw new ProjectConflictError('Task Project membership changed');
      return this.getTask(taskId);
    })();
  }

  private hasNonTerminalTeamWork(taskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM teams t
         WHERE t.task_id = ? AND (
           EXISTS (
             SELECT 1 FROM team_executions e
             WHERE e.team_id = t.id
               AND e.state NOT IN ('completed', 'failed', 'canceled')
           ) OR EXISTS (
             SELECT 1 FROM team_missions m
             WHERE m.team_id = t.id
               AND m.state NOT IN ('completed', 'failed', 'canceled')
           )
         )
         LIMIT 1`,
      )
      .get(taskId);
    return row !== undefined;
  }

  private assertProjectAcceptsTask(projectId: string): void {
    const project = this.getProjectRow(projectId);
    if (project.archived === 1) throw new ProjectArchivedError();
  }

  private getProject(projectId: string): ProjectSummary {
    const row = this.db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.archived = 0) AS task_count,
           (SELECT COUNT(*) FROM project_workspace_roots r WHERE r.project_id = p.id) AS folder_count,
           (SELECT id FROM project_workspace_roots r WHERE r.project_id = p.id AND r.role = 'primary') AS primary_folder_id,
           (SELECT canonical_path FROM project_workspace_roots r WHERE r.project_id = p.id AND r.role = 'primary') AS primary_folder_path,
           (SELECT label FROM project_workspace_roots r WHERE r.project_id = p.id AND r.role = 'primary') AS primary_folder_label,
           MAX(p.updated_at, COALESCE((SELECT MAX(t.updated_at) FROM tasks t WHERE t.project_id = p.id), p.updated_at)) AS last_activity_at
         FROM projects p
         WHERE p.id = ?
        `,
      )
      .get(projectId) as ProjectRow | undefined;
    if (row === undefined) throw new NotFoundError('Project not found');
    return toProject(row);
  }

  private getProjectRow(
    projectId: string,
  ): Omit<
    ProjectRow,
    | 'task_count'
    | 'folder_count'
    | 'primary_folder_id'
    | 'primary_folder_path'
    | 'primary_folder_label'
    | 'last_activity_at'
  > {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | Omit<
          ProjectRow,
          | 'task_count'
          | 'folder_count'
          | 'primary_folder_id'
          | 'primary_folder_path'
          | 'primary_folder_label'
          | 'last_activity_at'
        >
      | undefined;
    if (row === undefined) throw new NotFoundError('Project not found');
    return row;
  }

  getTaskModelSelection(taskId: string): ModelSelection | null {
    const row = this.getTaskRow(taskId);
    return readCanonicalModelSelection({
      connectionId: row.connection_id,
      requestedProvider: row.requested_provider,
      requestedModel: row.requested_model,
    });
  }

  getImageAttachmentAcceptanceSelection(taskId: string): ImageAttachmentAcceptanceSelection {
    const taskSelection = this.getTaskModelSelection(taskId);
    const explicitRuntime =
      taskSelection === null ? null : builtinRuntimeForModelSelection(taskSelection);
    const runtimeKind = explicitRuntime?.runtimeKind ?? this.getRuntime();
    const model = explicitRuntime?.model ?? this.getModel();
    return {
      taskId,
      modelSelection: taskSelection ?? modelSelectionForRuntime(runtimeKind, model),
      runtimeKind,
      model,
    };
  }

  setTaskModelSelection(taskId: string, selection: ModelSelection): ModelSelection | null {
    const parsed = modelSelectionSchema.parse(selection);
    const runtime = builtinRuntimeForModelSelection(parsed);
    return this.db.transaction(() => {
      const task = this.getTaskRow(taskId);
      const now = new Date().toISOString();
      const updated = this.db
        .prepare(
          `UPDATE tasks
           SET connection_id = ?, requested_provider = ?, requested_model = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(parsed.connectionId, parsed.requestedProvider, parsed.requestedModel, now, task.id);
      if (updated.changes !== 1) throw new TeamConflictError();
      const leader = this.getTaskLeader(taskId);
      const effectiveRuntime =
        runtime ?? ({ runtimeKind: this.getRuntime(), model: this.getModel() } as const);
      this.updateAgentModelSelectionInTransaction(
        leader.id,
        runtime === null
          ? modelSelectionForRuntime(effectiveRuntime.runtimeKind, effectiveRuntime.model)
          : parsed,
        effectiveRuntime.runtimeKind,
        now,
      );
      return this.getTaskModelSelection(taskId);
    })();
  }

  getTaskLeader(taskId: string): AgentRecord {
    const task = this.getTaskRow(taskId);
    const row = this.db
      .prepare(
        `SELECT a.*, t.runtime_kind FROM agents a
         JOIN agent_threads t ON t.id = a.thread_id
         WHERE a.task_id = ? AND a.thread_id = ? AND a.kind = 'leader'`,
      )
      .get(taskId, task.primary_thread_id) as AgentRow | undefined;
    if (row === undefined) throw new NotFoundError('Task leader not found');
    return toAgent(row);
  }

  setAgentModelSelection(agentId: string, selection: ModelSelection): AgentRecord {
    const parsed = modelSelectionSchema.parse(selection);
    const runtime = builtinRuntimeForModelSelection(parsed);
    if (runtime === null) throw new Error('Agent model selection cannot be cleared');
    return this.db.transaction(() => {
      this.updateAgentModelSelectionInTransaction(
        agentId,
        parsed,
        runtime.runtimeKind,
        new Date().toISOString(),
      );
      return this.getAgent(agentId);
    })();
  }

  promoteTaskToTeam(taskId: string): TeamRecord {
    return this.db.transaction(() => {
      this.getTaskRow(taskId);
      const existing = this.getTeamByTask(taskId);
      if (existing !== null) return existing;
      const leader = this.getTaskLeader(taskId);
      if (leader.teamId !== null) throw new Error('Task leader already belongs to a team');
      const now = new Date().toISOString();
      const teamId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO teams(
             id, task_id, state, leader_agent_id, budget_json, policy_json,
             revision, created_at, updated_at
           ) VALUES (?, ?, 'draft', ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          teamId,
          taskId,
          leader.id,
          TEAM_BUDGET_STRUCTURED_SEED,
          JSON.stringify(this.getDefaultTeamPolicy()),
          now,
          now,
        );
      const assigned = this.db
        .prepare('UPDATE agents SET team_id = ?, updated_at = ? WHERE id = ? AND team_id IS NULL')
        .run(teamId, now, leader.id);
      if (assigned.changes !== 1) throw new Error('Task leader assignment conflict');
      this.db
        .prepare(
          `INSERT INTO team_memberships(team_id, agent_id, kind, joined_at, left_at)
           VALUES (?, ?, 'leader', ?, NULL)`,
        )
        .run(teamId, leader.id, now);
      return this.getTeam(teamId);
    })();
  }

  getTeam(teamId: string): TeamRecord {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as
      TeamRow | undefined;
    if (row === undefined) throw new NotFoundError('Team not found');
    return toTeam(row);
  }

  getTeamByTask(taskId: string): TeamRecord | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE task_id = ?').get(taskId) as
      TeamRow | undefined;
    return row === undefined ? null : toTeam(row);
  }

  getTeamSnapshot(teamId: string): TeamSnapshot {
    const team = this.getTeam(teamId);
    const agents = (
      this.db
        .prepare(
          `SELECT a.*, t.runtime_kind FROM agents a
           JOIN agent_threads t ON t.id = a.thread_id
           WHERE a.team_id = ? ORDER BY a.depth, a.created_at, a.id`,
        )
        .all(teamId) as AgentRow[]
    ).map(toAgent);
    const messages = (
      this.db
        .prepare('SELECT * FROM team_messages WHERE team_id = ? ORDER BY seq')
        .all(teamId) as TeamMessageRow[]
    ).map(toTeamMessage);
    const deliveries = (
      this.db
        .prepare(
          `SELECT d.* FROM team_message_deliveries d
           JOIN team_messages m ON m.id = d.message_id
           WHERE m.team_id = ? ORDER BY m.seq`,
        )
        .all(teamId) as TeamDeliveryRow[]
    ).map(toTeamDelivery);
    return { team, agents, messages, deliveries };
  }

  transitionTeamState(teamId: string, to: TeamState): TeamRecord {
    return this.db.transaction(() => {
      const current = this.getTeam(teamId);
      transitionTeam(current.state, to);
      const result = this.db
        .prepare(
          `UPDATE teams SET state = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND state = ? AND revision = ?`,
        )
        .run(to, new Date().toISOString(), teamId, current.state, current.revision);
      if (result.changes !== 1) throw new TeamConflictError();
      return this.getTeam(teamId);
    })();
  }

  reformCompletedTeam(teamId: string): TeamRecord {
    return this.db.transaction(() => {
      const current = this.getTeam(teamId);
      if (current.state !== 'completed') throw new Error('Only a completed Team can be re-formed');
      transitionTeam(current.state, 'forming');
      const now = new Date().toISOString();
      const historicalWorkers = this.getTeamSnapshot(teamId).agents.filter(
        ({ kind, state }) => kind === 'worker' && (state === 'done' || state === 'failed'),
      );
      for (const worker of historicalWorkers) {
        const archived = this.db
          .prepare(
            `UPDATE agents SET state = 'stopped', updated_at = ?
             WHERE id = ? AND state = ?`,
          )
          .run(now, worker.id, worker.state);
        if (archived.changes !== 1) throw new TeamConflictError();
        this.recordTeamV2Activity({
          teamId,
          type: 'worker_stopped',
          subjectAgentId: worker.id,
          payload: { from: worker.state, to: 'stopped', reason: 'team_reformed' },
          now,
        });
      }
      const reformed = this.db
        .prepare(
          `UPDATE teams SET state = 'forming', revision = revision + 1, updated_at = ?
           WHERE id = ? AND state = 'completed' AND revision = ?`,
        )
        .run(now, teamId, current.revision);
      if (reformed.changes !== 1) throw new TeamConflictError();
      return this.getTeam(teamId);
    })();
  }

  updateTeamPolicy(teamId: string, policy: TeamPolicy, expectedRevision: number): TeamRecord {
    const parsed = assertTeamPolicy(policy);
    return this.db.transaction(() => {
      const current = this.getTeam(teamId);
      if (current.revision !== expectedRevision) throw new TeamConflictError();
      const agents = this.getTeamSnapshot(teamId).agents;
      if (agents.some(({ depth }) => depth > parsed.maxAgentDepth))
        throw new Error('Team Policy cannot exclude an existing Agent depth');
      const now = new Date().toISOString();
      for (const agent of agents) {
        if (agent.managerPolicy === null) continue;
        const managerPolicy = {
          ...agent.managerPolicy,
          maxDelegationDepth: Math.min(
            agent.managerPolicy.maxDelegationDepth,
            parsed.maxAgentDepth,
          ),
        };
        assertManagerPolicy(managerPolicy, parsed);
        if (managerPolicy.maxDelegationDepth !== agent.managerPolicy.maxDelegationDepth)
          this.db
            .prepare('UPDATE agents SET manager_policy_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(managerPolicy), now, agent.id);
      }
      const updated = this.db
        .prepare(
          `UPDATE teams
           SET policy_json = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(JSON.stringify(parsed), now, teamId, expectedRevision);
      if (updated.changes !== 1) throw new TeamConflictError();
      return this.getTeam(teamId);
    })();
  }

  getTeamBlueprint(teamId: string): TeamBlueprintBindingRecord | null {
    this.getTeam(teamId);
    const row = this.db
      .prepare(
        `SELECT source, skill_id, digest, name, package_path, blueprint_json, bound_at
         FROM team_blueprint_bindings WHERE team_id = ?`,
      )
      .get(teamId) as
      | {
          source: TurnSkillSelection['ref']['source'];
          skill_id: string;
          digest: string;
          name: string;
          package_path: string;
          blueprint_json: string;
          bound_at: string;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      teamId,
      selection: turnSkillSelectionSchema.parse({
        kind: 'team',
        ref: { source: row.source, skillId: row.skill_id, digest: row.digest },
      }),
      name: row.name,
      packagePath: row.package_path,
      blueprint: teamBlueprintSchema.parse(JSON.parse(row.blueprint_json)),
      boundAt: row.bound_at,
    };
  }

  bindTeamBlueprint(input: {
    teamId: string;
    selection: TurnSkillSelection;
    name: string;
    packagePath: string;
    blueprint: TeamBlueprint;
  }): TeamBlueprintBindingRecord {
    if (input.selection.kind !== 'team') throw new Error('Team Blueprint requires a Team Skill');
    const blueprint = teamBlueprintSchema.parse(input.blueprint);
    return this.db.transaction(() => {
      const existing = this.getTeamBlueprint(input.teamId);
      if (existing !== null) {
        if (existing.selection.ref.digest !== input.selection.ref.digest)
          throw new Error('Team Blueprint revision is already pinned');
        return existing;
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO team_blueprint_bindings(
             team_id, source, skill_id, digest, name, package_path, blueprint_json, bound_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.teamId,
          input.selection.ref.source,
          input.selection.ref.skillId,
          input.selection.ref.digest,
          input.name,
          input.packagePath,
          JSON.stringify(blueprint),
          now,
        );
      this.db
        .prepare(
          `UPDATE teams SET policy_json = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(blueprint.policy), now, input.teamId);
      return this.getTeamBlueprint(input.teamId)!;
    })();
  }

  registerTeamWorker(input: {
    teamId: string;
    role: string;
    objective: string;
    parentCapabilityCeiling: CapabilityCeiling;
    contextInheritancePolicy: ContextInheritancePolicy;
    runtimeKind?: RuntimeKind;
    modelSelection?: ModelSelection;
    modelSelectionReason?: string;
    writeCapable?: boolean;
    parentAgentId?: string;
    canDelegate?: boolean;
    managerPolicy?: ManagerPolicy | null;
    blueprintRoleKey?: string;
  }): AgentRecord {
    assertWorkerPersistenceInput(input);
    return this.db.transaction(() => {
      const team = this.getTeam(input.teamId);
      if (!['draft', 'forming', 'active', 'paused', 'completed'].includes(team.state))
        throw new Error('Team does not accept new workers');
      const parent = this.getAgent(input.parentAgentId ?? team.leaderAgentId);
      if (parent.teamId !== team.id) throw new Error('Parent Agent must belong to the same Team');
      if (['done', 'failed', 'stopped'].includes(parent.state))
        throw new Error('A terminal Agent cannot hire child Agents');
      const directChildCount = (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM agents WHERE team_id = ? AND parent_agent_id = ?')
          .get(team.id, parent.id) as { count: number }
      ).count;
      const canDelegate = input.canDelegate === true;
      const managerPolicy = input.managerPolicy ?? null;
      if (canDelegate !== (managerPolicy !== null))
        throw new Error('A delegating Agent requires an explicit Manager Policy');
      if (managerPolicy !== null) assertManagerPolicy(managerPolicy, team.policy);
      const depth = assertDelegationAllowed({
        requester: parent,
        requestedChildCanDelegate: canDelegate,
        directChildCount,
        teamPolicy: team.policy,
      });
      const now = new Date().toISOString();
      const threadId = randomUUID();
      const agentId = randomUUID();
      const modelSelection = input.modelSelection ?? parent.modelSelection;
      const builtinRuntime = builtinRuntimeForModelSelection(modelSelection);
      const runtimeKind = input.runtimeKind ?? builtinRuntime?.runtimeKind ?? parent.runtimeKind;
      this.db
        .prepare(
          `INSERT INTO agent_threads(
             id, task_id, runtime_kind, state, active_turn_id, revision,
             connection_id, requested_provider, requested_model, created_at, updated_at
           ) VALUES (?, ?, ?, 'idle', NULL, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          team.taskId,
          runtimeKind,
          modelSelection.connectionId,
          modelSelection.requestedProvider,
          modelSelection.requestedModel,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO agents(
             id, team_id, thread_id, task_id, kind, role, state, objective,
             parent_capability_ceiling_json, context_inheritance_policy,
             write_capable, connection_id, requested_provider, requested_model,
             parent_agent_id, depth, can_delegate, manager_policy_json, blueprint_role_key,
             created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, 'worker', ?, 'invited', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )`,
        )
        .run(
          agentId,
          team.id,
          threadId,
          team.taskId,
          input.role.trim(),
          input.objective.trim(),
          JSON.stringify(input.parentCapabilityCeiling),
          input.contextInheritancePolicy,
          input.writeCapable === true ? 1 : 0,
          modelSelection.connectionId,
          modelSelection.requestedProvider,
          modelSelection.requestedModel,
          parent.id,
          depth,
          canDelegate ? 1 : 0,
          managerPolicy === null ? null : JSON.stringify(managerPolicy),
          input.blueprintRoleKey ?? null,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO team_memberships(team_id, agent_id, kind, joined_at, left_at)
           VALUES (?, ?, 'worker', ?, NULL)`,
        )
        .run(team.id, agentId, now);
      const blueprintBinding = this.getTeamBlueprint(team.id);
      this.recordTeamV2Activity({
        teamId: team.id,
        type: 'worker_hired',
        actorAgentId: parent.id,
        subjectAgentId: agentId,
        payload: {
          role: input.role.trim(),
          blueprintRoleKey: input.blueprintRoleKey ?? null,
          teamBlueprint:
            blueprintBinding === null
              ? null
              : {
                  name: blueprintBinding.name,
                  digest: blueprintBinding.selection.ref.digest,
                },
          depth,
          canDelegate,
          modelSelection,
          modelSelectionReason:
            input.modelSelectionReason ??
            (input.modelSelection === undefined
              ? '親Agentのmodel selectionを継承'
              : '呼び出し元がmodel selectionを明示'),
        },
        now,
      });
      return this.getAgent(agentId);
    })();
  }

  transitionWorkerState(agentId: string, to: WorkerState): AgentRecord {
    return this.db.transaction(() => {
      const current = this.getAgent(agentId);
      if (current.kind !== 'worker') throw new Error('Leader lifecycle is owned by the Team');
      transitionWorker(current.state, to);
      const now = new Date().toISOString();
      const result = this.db
        .prepare('UPDATE agents SET state = ?, updated_at = ? WHERE id = ? AND state = ?')
        .run(to, now, agentId, current.state);
      if (result.changes !== 1) throw new TeamConflictError();
      if (to === 'stopped' && current.teamId !== null)
        this.recordTeamV2Activity({
          teamId: current.teamId,
          type: 'worker_stopped',
          subjectAgentId: current.id,
          payload: { from: current.state, to },
          now,
        });
      return this.getAgent(agentId);
    })();
  }

  createTeamExecution(input: {
    teamId: string;
    assigneeAgentId: string;
    createdByAgentId: string;
    instruction: string;
    accessMode?: TeamMissionAccess;
    now: string;
    contextOwner?: { type: ContextSealOwnerType; id: string };
  }): TeamExecutionRecord {
    const instruction = createExecutionInstruction(input.instruction, input.now);
    return this.db.transaction(() => {
      const team = this.getTeam(input.teamId);
      if (!['forming', 'active', 'paused'].includes(team.state))
        throw new Error('Team does not accept executions');
      const assignee = this.getAgent(input.assigneeAgentId);
      const creator = this.getAgent(input.createdByAgentId);
      if (assignee.teamId !== team.id || creator.teamId !== team.id)
        throw new Error('Execution Agents must belong to the same Team');
      if (['done', 'failed', 'stopped'].includes(assignee.state))
        throw new Error('A terminal Agent cannot receive an execution');
      const accessMode = input.accessMode ?? 'read-only';
      if (accessMode === 'workspace-write' && assignee.writeCapable !== true)
        throw new Error('workspace-write execution requires a write-capable Worker');
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO team_executions(
             id, team_id, assignee_agent_id, created_by_agent_id, access_mode, state,
             instruction_revision, queue_ordinal, queue_reason,
             connection_id, requested_provider, requested_model,
             revision, assigned_at, queued_at, started_at, completed_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, 'assigned', 1, NULL, NULL, ?, ?, ?, 1, ?, NULL, NULL, NULL, ?
           )`,
        )
        .run(
          id,
          team.id,
          assignee.id,
          creator.id,
          accessMode,
          assignee.modelSelection.connectionId,
          assignee.modelSelection.requestedProvider,
          assignee.modelSelection.requestedModel,
          input.now,
          input.now,
        );
      this.db
        .prepare(
          `INSERT INTO team_execution_instructions(
             execution_id, revision, content, created_by_agent_id, reason, created_at
           ) VALUES (?, 1, ?, ?, 'initial', ?)`,
        )
        .run(id, instruction.content, creator.id, input.now);
      if (input.contextOwner !== undefined) {
        const parent = this.contextSealRow(input.contextOwner.type, input.contextOwner.id);
        if (parent === undefined) throw new NotFoundError('Parent context seal not found');
        if (parent.task_id !== team.taskId)
          throw new Error('Parent context seal belongs to another Task');
        this.cloneContextSealInTransaction(parent, id);
      }
      this.recordTeamV2Activity({
        teamId: team.id,
        type: 'task_assigned',
        actorAgentId: creator.id,
        subjectAgentId: assignee.id,
        executionId: id,
        payload: {
          instructionRevision: instruction.revision,
          accessMode,
          modelSelection: assignee.modelSelection,
        },
        now: input.now,
      });
      return this.getTeamExecution(id);
    })();
  }

  getTeamExecution(executionId: string): TeamExecutionRecord {
    const row = this.db.prepare('SELECT * FROM team_executions WHERE id = ?').get(executionId) as
      TeamExecutionRow | undefined;
    if (row === undefined) throw new NotFoundError('Team execution not found');
    return this.toTeamExecution(row);
  }

  listTeamExecutions(teamId: string): readonly TeamExecutionRecord[] {
    this.getTeam(teamId);
    return (
      this.db
        .prepare('SELECT * FROM team_executions WHERE team_id = ? ORDER BY assigned_at, id')
        .all(teamId) as TeamExecutionRow[]
    ).map((row) => this.toTeamExecution(row));
  }

  listQueuedTeamExecutions(teamId: string): readonly TeamExecutionRecord[] {
    this.getTeam(teamId);
    return (
      this.db
        .prepare(
          `SELECT * FROM team_executions
           WHERE team_id = ?
             AND state IN ('queued', 'waiting_verification', 'waiting_rate_limit')
           ORDER BY queue_ordinal, queued_at, id`,
        )
        .all(teamId) as TeamExecutionRow[]
    ).map((row) => this.toTeamExecution(row));
  }

  getTeamExecutionDispatch(executionId: string): TeamExecutionDispatchRecord {
    this.getTeamExecution(executionId);
    const row = this.db
      .prepare(
        `SELECT m.id AS message_id, m.seq AS message_seq,
                tt.id AS team_task_id, tt.done_criteria_json
         FROM team_messages m
         JOIN team_tasks tt ON tt.message_id = m.id
         WHERE m.execution_id = ?
         ORDER BY m.seq DESC
         LIMIT 1`,
      )
      .get(executionId) as
      | {
          message_id: string;
          message_seq: number;
          team_task_id: string;
          done_criteria_json: string;
        }
      | undefined;
    if (row === undefined) throw new NotFoundError('Team execution dispatch not found');
    return {
      messageId: row.message_id,
      messageSeq: row.message_seq,
      teamTaskId: row.team_task_id,
      doneCriteria: JSON.parse(row.done_criteria_json) as string[],
    };
  }

  transitionTeamExecution(input: {
    executionId: string;
    to: TeamExecutionState;
    now: string;
    queueReason?: TeamQueueReason | null;
  }): TeamExecutionRecord {
    return this.db.transaction(() => {
      const current = this.getTeamExecution(input.executionId);
      if (current.state === input.to) return current;
      transitionTeamExecution(current.state, input.to);
      const queueReason =
        input.to === 'waiting_verification'
          ? 'verification'
          : input.to === 'waiting_rate_limit'
            ? (input.queueReason ?? 'rate_limit')
            : (input.queueReason ?? null);
      if (input.to === 'queued' && queueReason === null)
        throw new Error('A queued execution requires a queue reason');
      if (
        !['queued', 'waiting_verification', 'waiting_rate_limit'].includes(input.to) &&
        queueReason !== null
      )
        throw new Error('A non-queued execution cannot retain a queue reason');
      let queueOrdinal = current.queueOrdinal;
      if (
        queueOrdinal === null &&
        ['queued', 'waiting_verification', 'waiting_rate_limit'].includes(input.to)
      )
        queueOrdinal = (
          this.db
            .prepare(
              `SELECT COALESCE(MAX(queue_ordinal), 0) + 1 AS ordinal
               FROM team_executions WHERE team_id = ?`,
            )
            .get(current.teamId) as { ordinal: number }
        ).ordinal;
      const terminal = ['completed', 'failed', 'canceled'].includes(input.to);
      const updated = this.db
        .prepare(
          `UPDATE team_executions
           SET state = ?, queue_ordinal = ?, queue_reason = ?,
               queued_at = CASE
                 WHEN ? IN ('queued', 'waiting_verification', 'waiting_rate_limit')
                   THEN COALESCE(queued_at, ?)
                 ELSE queued_at
               END,
               started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
               completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          input.to,
          queueOrdinal,
          queueReason,
          input.to,
          input.now,
          input.to,
          input.now,
          terminal ? 1 : 0,
          input.now,
          input.now,
          current.id,
          current.revision,
        );
      if (updated.changes !== 1) throw new TeamConflictError();
      const next = this.getTeamExecution(current.id);
      const type =
        input.to === 'queued'
          ? 'execution_queued'
          : ['waiting_verification', 'waiting_rate_limit', 'waiting_resume'].includes(input.to)
            ? 'execution_waiting'
            : input.to === 'running'
              ? 'execution_started'
              : 'execution_finished';
      this.recordTeamV2Activity({
        teamId: next.teamId,
        type,
        subjectAgentId: next.assigneeAgentId,
        executionId: next.id,
        payload: { from: current.state, to: next.state, queueReason: next.queueReason },
        now: input.now,
      });
      return next;
    })();
  }

  reviseQueuedTeamExecution(input: {
    executionId: string;
    createdByAgentId: string;
    instruction: string;
    now: string;
  }): TeamExecutionRecord {
    return this.db.transaction(() => {
      const current = this.getTeamExecution(input.executionId);
      const creator = this.getAgent(input.createdByAgentId);
      if (creator.teamId !== current.teamId)
        throw new Error('Instruction author must belong to the execution Team');
      const next = reviseQueuedExecutionInstruction({
        executionState: current.state,
        current: current.instruction,
        content: input.instruction,
        updatedAt: input.now,
      });
      this.db
        .prepare(
          `INSERT INTO team_execution_instructions(
             execution_id, revision, content, created_by_agent_id, reason, created_at
           ) VALUES (?, ?, ?, ?, 'steer', ?)`,
        )
        .run(current.id, next.revision, next.content, creator.id, input.now);
      const updated = this.db
        .prepare(
          `UPDATE team_executions
           SET instruction_revision = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(next.revision, input.now, current.id, current.revision);
      if (updated.changes !== 1) throw new TeamConflictError();
      const revised = this.getTeamExecution(current.id);
      this.recordTeamV2Activity({
        teamId: revised.teamId,
        type: 'steered',
        actorAgentId: creator.id,
        subjectAgentId: revised.assigneeAgentId,
        executionId: revised.id,
        payload: { instructionRevision: revised.instruction.revision },
        now: input.now,
      });
      return revised;
    })();
  }

  cancelQueuedTeamExecution(executionId: string, now: string): TeamExecutionRecord {
    return this.db.transaction(() => {
      const current = this.getTeamExecution(executionId);
      if (
        ![
          'assigned',
          'queued',
          'waiting_verification',
          'waiting_rate_limit',
          'waiting_resume',
        ].includes(current.state)
      )
        throw new Error('Only a queued Team execution can be canceled without interruption');
      const canceled = this.transitionTeamExecution({
        executionId: current.id,
        to: 'canceled',
        now,
      });
      const message = this.db
        .prepare(
          `SELECT id FROM team_messages
           WHERE execution_id = ? AND source_agent_id = ?
           ORDER BY seq LIMIT 1`,
        )
        .get(current.id, current.createdByAgentId) as { id: string } | undefined;
      if (message !== undefined) {
        const delivery = this.getTeamDelivery(message.id);
        if (delivery !== null && ['persisted', 'dispatched', 'timedOut'].includes(delivery.state))
          this.transitionTeamDelivery({
            messageId: message.id,
            to: 'failed',
            now,
            error: 'execution_canceled',
          });
        const task = this.db
          .prepare('SELECT id FROM team_tasks WHERE message_id = ?')
          .get(message.id) as { id: string } | undefined;
        if (task !== undefined) {
          const currentTask = this.getTeamTask(task.id);
          if (!['completed', 'failed', 'canceled'].includes(currentTask.status))
            this.transitionTeamTask(task.id, 'canceled', now);
        }
      }
      return canceled;
    })();
  }

  createTeamAttempt(
    executionId: string,
    now: string,
    startReason: TeamAttemptStartReason = 'initial',
  ): TeamAttemptRecord {
    return this.db.transaction(() => {
      const execution = this.getTeamExecution(executionId);
      if (execution.state !== 'running')
        throw new Error('A Team attempt requires a running execution');
      const existing = this.listTeamAttempts(execution.id);
      if (
        existing.some(
          ({ state }) => !['completed', 'failed', 'canceled', 'interrupted'].includes(state),
        )
      )
        throw new Error('Execution already has an active attempt');
      const ordinal = nextTeamAttemptOrdinal(existing.map((attempt) => attempt.ordinal));
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO team_attempts(
             id, execution_id, ordinal, state, instruction_revision,
             connection_id, requested_provider, requested_model,
             provider_call_ordinal, terminal_reason, start_reason, last_progress_at,
             created_at, started_at, finished_at, updated_at
           ) VALUES (?, ?, ?, 'created', ?, ?, ?, ?, 0, NULL, ?, NULL, ?, NULL, NULL, ?)`,
        )
        .run(
          id,
          execution.id,
          ordinal,
          execution.instruction.revision,
          execution.modelSelection.connectionId,
          execution.modelSelection.requestedProvider,
          execution.modelSelection.requestedModel,
          startReason,
          now,
          now,
        );
      return this.getTeamAttempt(id);
    })();
  }

  getTeamAttempt(attemptId: string): TeamAttemptRecord {
    const row = this.db.prepare('SELECT * FROM team_attempts WHERE id = ?').get(attemptId) as
      TeamAttemptRow | undefined;
    if (row === undefined) throw new NotFoundError('Team attempt not found');
    return toTeamAttempt(row);
  }

  listTeamAttempts(executionId: string): readonly TeamAttemptRecord[] {
    this.getTeamExecution(executionId);
    return (
      this.db
        .prepare('SELECT * FROM team_attempts WHERE execution_id = ? ORDER BY ordinal')
        .all(executionId) as TeamAttemptRow[]
    ).map(toTeamAttempt);
  }

  transitionTeamAttempt(input: {
    attemptId: string;
    to: TeamAttemptState;
    now: string;
    terminalReason?: string | null;
  }): TeamAttemptRecord {
    return this.db.transaction(() => {
      const current = this.getTeamAttempt(input.attemptId);
      if (current.state === input.to) return current;
      transitionTeamAttempt(current.state, input.to);
      const terminal = ['completed', 'failed', 'canceled', 'interrupted'].includes(input.to);
      const terminalReason = input.terminalReason ?? null;
      if (
        terminal &&
        input.to !== 'completed' &&
        (terminalReason === null || terminalReason.trim() === '')
      )
        throw new Error('A terminal Team attempt requires a reason');
      if (input.to === 'completed' && terminalReason !== null)
        throw new Error('A completed Team attempt cannot have a failure reason');
      if (!terminal && terminalReason !== null)
        throw new Error('An active Team attempt cannot have a terminal reason');
      const updated = this.db
        .prepare(
          `UPDATE team_attempts
           SET state = ?, terminal_reason = ?,
               started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
               finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END,
               updated_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(
          input.to,
          terminalReason,
          input.to,
          input.now,
          terminal ? 1 : 0,
          input.now,
          input.now,
          current.id,
          current.state,
        );
      if (updated.changes !== 1) throw new TeamConflictError();
      const next = this.getTeamAttempt(current.id);
      if (input.to === 'running' || terminal) {
        const execution = this.getTeamExecution(next.executionId);
        this.recordTeamV2Activity({
          teamId: execution.teamId,
          type: input.to === 'running' ? 'attempt_started' : 'attempt_finished',
          subjectAgentId: execution.assigneeAgentId,
          executionId: execution.id,
          attemptId: next.id,
          payload: {
            ordinal: next.ordinal,
            state: next.state,
            terminalReason: next.terminalReason,
          },
          now: input.now,
        });
      }
      return next;
    })();
  }

  recordTeamAttemptRateLimited(attemptId: string, now: string): TeamAttemptRecord {
    return this.db.transaction(() => {
      const current = this.getTeamAttempt(attemptId);
      if (current.state !== 'running')
        throw new Error('Only a running attempt can be rate limited');
      this.transitionTeamAttempt({ attemptId, to: 'waiting_rate_limit', now });
      const updated = this.db
        .prepare(
          `UPDATE team_attempts
           SET provider_call_ordinal = provider_call_ordinal + 1, updated_at = ?
           WHERE id = ? AND state = 'waiting_rate_limit'`,
        )
        .run(now, attemptId);
      if (updated.changes !== 1) throw new TeamConflictError();
      const execution = this.getTeamExecution(current.executionId);
      this.transitionTeamExecution({
        executionId: execution.id,
        to: 'waiting_rate_limit',
        now,
      });
      return this.getTeamAttempt(attemptId);
    })();
  }

  touchTeamAttemptProgress(attemptId: string, now: string): TeamAttemptRecord {
    const result = this.db
      .prepare(
        `UPDATE team_attempts
         SET last_progress_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(now, now, attemptId);
    if (result.changes !== 1) throw new TeamConflictError();
    return this.getTeamAttempt(attemptId);
  }

  createTeamMission(input: {
    teamId: string;
    createdByAgentId: string;
    objective: string;
    doneCriteria: readonly string[];
    steps: readonly {
      workerId: string;
      objective: string;
      doneCriteria: readonly string[];
      access: TeamMissionAccess;
    }[];
    now: string;
    contextOwner?: { type: ContextSealOwnerType; id: string };
  }): TeamMissionRecord {
    return this.db.transaction(() => {
      if (input.steps.length < 2 || input.steps.length > 12)
        throw new Error('A Team Mission requires 2 to 12 steps');
      const team = this.getTeam(input.teamId);
      const creator = this.getAgent(input.createdByAgentId);
      if (creator.teamId !== team.id) throw new Error('Mission creator must belong to Team');
      const missionId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO team_missions(
             id, team_id, created_by_agent_id, state, objective, done_criteria_json,
             current_step_ordinal, revision, created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, 'queued', ?, ?, 1, 1, ?, ?, NULL)`,
        )
        .run(
          missionId,
          team.id,
          creator.id,
          input.objective,
          JSON.stringify(input.doneCriteria),
          input.now,
          input.now,
        );
      for (const [index, step] of input.steps.entries()) {
        const worker = this.getAgent(step.workerId);
        if (worker.teamId !== team.id || worker.kind !== 'worker')
          throw new Error('Mission step Worker must belong to Team');
        const execution = this.createTeamExecution({
          teamId: team.id,
          assigneeAgentId: worker.id,
          createdByAgentId: creator.id,
          instruction: step.objective,
          accessMode: step.access,
          now: input.now,
          ...(input.contextOwner === undefined ? {} : { contextOwner: input.contextOwner }),
        });
        const message = this.createTeamMessage({
          teamId: team.id,
          sourceAgentId: creator.id,
          targetAgentId: worker.id,
          content: step.objective,
          executionId: execution.id,
        });
        this.createTeamTask({
          teamId: team.id,
          messageId: message.id,
          assigneeAgentId: worker.id,
          createdByAgentId: creator.id,
          description: step.objective,
          doneCriteria: step.doneCriteria,
          now: input.now,
        });
        this.createTeamDelivery({ messageId: message.id, now: input.now });
        this.db
          .prepare(
            `INSERT INTO team_mission_steps(
               mission_id, ordinal, execution_id, access_mode,
               checkpoint_json, checkpoint_digest, completed_at
             ) VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
          )
          .run(missionId, index + 1, execution.id, step.access);
      }
      return this.getTeamMission(missionId);
    })();
  }

  getTeamMission(missionId: string): TeamMissionRecord {
    const row = this.db.prepare('SELECT * FROM team_missions WHERE id = ?').get(missionId) as
      TeamMissionRow | undefined;
    if (row === undefined) throw new NotFoundError('Team Mission not found');
    const steps = this.db
      .prepare('SELECT * FROM team_mission_steps WHERE mission_id = ? ORDER BY ordinal')
      .all(missionId) as TeamMissionStepRow[];
    return toTeamMission(row, steps);
  }

  listTeamMissions(teamId: string): readonly TeamMissionRecord[] {
    this.getTeam(teamId);
    return (
      this.db
        .prepare('SELECT id FROM team_missions WHERE team_id = ? ORDER BY created_at, id')
        .all(teamId) as { id: string }[]
    ).map(({ id }) => this.getTeamMission(id));
  }

  getTeamMissionForExecution(executionId: string): TeamMissionRecord | null {
    const row = this.db
      .prepare('SELECT mission_id FROM team_mission_steps WHERE execution_id = ?')
      .get(executionId) as { mission_id: string } | undefined;
    return row === undefined ? null : this.getTeamMission(row.mission_id);
  }

  recordTeamMissionWorktree(input: {
    executionId: string;
    agentId: string;
    repoPath: string;
    path: string;
    baseHead: string;
    now: string;
  }): TeamMissionWorktreeRecord {
    return this.db.transaction(() => {
      const mission = this.getTeamMissionForExecution(input.executionId);
      if (mission === null) throw new NotFoundError('Team Mission step not found');
      const execution = this.getTeamExecution(input.executionId);
      if (execution.assigneeAgentId !== input.agentId)
        throw new Error('Mission worktree Agent does not match execution assignee');
      this.db
        .prepare(
          `INSERT INTO team_mission_step_worktrees(
             execution_id, agent_id, repo_path, path, base_head, state,
             worker_head, integrated_head, changed_files_json, reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'created', NULL, NULL, '[]', NULL, ?, ?)`,
        )
        .run(
          input.executionId,
          input.agentId,
          input.repoPath,
          input.path,
          input.baseHead,
          input.now,
          input.now,
        );
      return this.requireTeamMissionWorktree(input.executionId);
    })();
  }

  updateTeamMissionWorktree(input: {
    executionId: string;
    to: TeamMissionWorktreeState;
    workerHead?: string | null;
    integratedHead?: string | null;
    changedFiles?: readonly string[];
    reason?: string | null;
    now: string;
  }): TeamMissionWorktreeRecord {
    const transitions: Readonly<
      Record<TeamMissionWorktreeState, readonly TeamMissionWorktreeState[]>
    > = {
      created: ['active', 'quarantined'],
      active: ['ready', 'quarantined'],
      ready: ['active', 'integrated', 'quarantined'],
      integrated: ['active', 'cleaned', 'quarantined'],
      cleaned: [],
      quarantined: ['active', 'ready', 'integrated'],
    };
    return this.db.transaction(() => {
      const current = this.requireTeamMissionWorktree(input.executionId);
      if (current.state !== input.to && !transitions[current.state].includes(input.to))
        throw new Error(`Invalid Mission worktree transition: ${current.state} -> ${input.to}`);
      const workerHead = input.workerHead === undefined ? current.workerHead : input.workerHead;
      const integratedHead =
        input.integratedHead === undefined ? current.integratedHead : input.integratedHead;
      const changedFiles =
        input.changedFiles === undefined ? current.changedFiles : [...new Set(input.changedFiles)];
      const reason = input.reason === undefined ? current.reason : input.reason;
      if (input.to === 'ready' && workerHead === null)
        throw new Error('A ready Mission worktree requires workerHead');
      if (input.to === 'integrated' && integratedHead === null)
        throw new Error('An integrated Mission worktree requires integratedHead');
      const result = this.db
        .prepare(
          `UPDATE team_mission_step_worktrees
           SET state = ?, worker_head = ?, integrated_head = ?,
               changed_files_json = ?, reason = ?, updated_at = ?
           WHERE execution_id = ? AND state = ?`,
        )
        .run(
          input.to,
          workerHead,
          integratedHead,
          JSON.stringify(changedFiles.slice(0, 500)),
          reason,
          input.now,
          current.executionId,
          current.state,
        );
      if (result.changes !== 1) throw new TeamConflictError();
      return this.requireTeamMissionWorktree(current.executionId);
    })();
  }

  getTeamMissionWorktree(executionId: string): TeamMissionWorktreeRecord | null {
    const row = this.db
      .prepare('SELECT * FROM team_mission_step_worktrees WHERE execution_id = ?')
      .get(executionId) as TeamMissionWorktreeRow | undefined;
    return row === undefined ? null : toTeamMissionWorktree(row);
  }

  createTeamExecutionIsolation(input: {
    executionId: string;
    repositories: TeamExecutionIsolation['repositories'];
    roots: TeamExecutionIsolation['roots'];
    now: string;
  }): TeamExecutionIsolationRecord {
    const parsed = teamExecutionIsolationSchema.parse({
      phase: 'preparing',
      resumeKind: null,
      repositories: input.repositories,
      roots: input.roots,
      reason: null,
    });
    if (this.getTeamExecution(input.executionId).accessMode !== 'workspace-write')
      throw new Error('Team execution isolation requires workspace-write access');
    this.db
      .prepare(
        `INSERT INTO team_execution_isolations(
           execution_id, phase, resume_kind, repositories_json, roots_json,
           reason, revision, created_at, updated_at
         ) VALUES (?, ?, NULL, ?, ?, NULL, 1, ?, ?)`,
      )
      .run(
        input.executionId,
        parsed.phase,
        JSON.stringify(parsed.repositories),
        JSON.stringify(parsed.roots),
        input.now,
        input.now,
      );
    return this.requireTeamExecutionIsolation(input.executionId);
  }

  updateTeamExecutionIsolation(input: {
    executionId: string;
    phase: TeamExecutionIsolation['phase'];
    repositories?: TeamExecutionIsolation['repositories'];
    roots?: TeamExecutionIsolation['roots'];
    resumeKind?: TeamExecutionIsolation['resumeKind'];
    reason?: string | null;
    now: string;
  }): TeamExecutionIsolationRecord {
    const allowed: Readonly<
      Record<TeamExecutionIsolation['phase'], readonly TeamExecutionIsolation['phase'][]>
    > = {
      preparing: ['running', 'quarantined'],
      running: ['finalizing', 'quarantined'],
      finalizing: ['waiting_integration', 'integrating', 'waiting_resume', 'quarantined'],
      waiting_integration: ['integrating', 'waiting_resume', 'quarantined'],
      integrating: ['waiting_resume', 'completed', 'quarantined'],
      waiting_resume: ['finalizing', 'integrating', 'quarantined'],
      completed: ['waiting_resume', 'quarantined'],
      quarantined: [],
    };
    return this.db.transaction(() => {
      const current = this.requireTeamExecutionIsolation(input.executionId);
      if (current.phase !== input.phase && !allowed[current.phase].includes(input.phase))
        throw new Error(`Invalid Team isolation transition: ${current.phase} -> ${input.phase}`);
      const parsed = teamExecutionIsolationSchema.parse({
        phase: input.phase,
        resumeKind: input.resumeKind === undefined ? current.resumeKind : input.resumeKind,
        repositories: input.repositories ?? current.repositories,
        roots: input.roots ?? current.roots,
        reason: input.reason === undefined ? current.reason : input.reason,
      });
      const result = this.db
        .prepare(
          `UPDATE team_execution_isolations
           SET phase = ?, resume_kind = ?, repositories_json = ?, roots_json = ?, reason = ?,
               revision = revision + 1, updated_at = ?
           WHERE execution_id = ? AND revision = ?`,
        )
        .run(
          parsed.phase,
          parsed.resumeKind,
          JSON.stringify(parsed.repositories),
          JSON.stringify(parsed.roots),
          parsed.reason,
          input.now,
          current.executionId,
          current.revision,
        );
      if (result.changes !== 1) throw new TeamConflictError();
      return this.requireTeamExecutionIsolation(input.executionId);
    })();
  }

  getTeamExecutionIsolation(executionId: string): TeamExecutionIsolationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM team_execution_isolations WHERE execution_id = ?')
      .get(executionId) as TeamExecutionIsolationRow | undefined;
    return row === undefined ? null : toTeamExecutionIsolation(row);
  }

  listTeamExecutionIsolations(): readonly TeamExecutionIsolationRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM team_execution_isolations ORDER BY created_at, execution_id')
        .all() as TeamExecutionIsolationRow[]
    ).map(toTeamExecutionIsolation);
  }

  saveTeamExecutionIsolationCompletion(input: {
    executionId: string;
    attemptId: string;
    teamTaskId: string;
    agentId: string;
    report: WorkerReport;
    doneEvidence: readonly { criterion: string; evidence: string }[];
    now: string;
  }): TeamExecutionIsolationCompletionRecord {
    const report = workerReportSchema.parse(input.report);
    const attempt = this.getTeamAttempt(input.attemptId);
    const dispatch = this.getTeamExecutionDispatch(input.executionId);
    if (attempt.executionId !== input.executionId || dispatch.teamTaskId !== input.teamTaskId)
      throw new Error('Team isolation completion does not match its execution');
    if (this.getTeamTask(input.teamTaskId).assigneeAgentId !== input.agentId)
      throw new Error('Team isolation completion does not match its Worker');
    const existing = this.getTeamExecutionIsolationCompletion(input.executionId);
    if (
      existing !== null &&
      (existing.attemptId !== input.attemptId ||
        existing.teamTaskId !== input.teamTaskId ||
        existing.agentId !== input.agentId)
    )
      throw new Error('Team isolation completion is already sealed to another dispatch');
    if (existing !== null) {
      this.db
        .prepare(
          `UPDATE team_execution_isolation_completions
           SET report_json = ?, done_evidence_json = ?
           WHERE execution_id = ?`,
        )
        .run(JSON.stringify(report), JSON.stringify(input.doneEvidence), input.executionId);
      return this.requireTeamExecutionIsolationCompletion(input.executionId);
    }
    this.db
      .prepare(
        `INSERT INTO team_execution_isolation_completions(
           execution_id, attempt_id, team_task_id, agent_id, report_json,
           done_evidence_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.executionId,
        input.attemptId,
        input.teamTaskId,
        input.agentId,
        JSON.stringify(report),
        JSON.stringify(input.doneEvidence),
        input.now,
      );
    return this.requireTeamExecutionIsolationCompletion(input.executionId);
  }

  getTeamExecutionIsolationCompletion(
    executionId: string,
  ): TeamExecutionIsolationCompletionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM team_execution_isolation_completions WHERE execution_id = ?')
      .get(executionId) as TeamExecutionIsolationCompletionRow | undefined;
    return row === undefined ? null : toTeamExecutionIsolationCompletion(row);
  }

  deleteTeamExecutionIsolationCompletion(executionId: string): void {
    this.db
      .prepare('DELETE FROM team_execution_isolation_completions WHERE execution_id = ?')
      .run(executionId);
  }

  acquireTeamIntegrationRootLeases(input: {
    executionId: string;
    roots: readonly Pick<
      TeamExecutionIsolation['roots'][number],
      'rootId' | 'mutationKey' | 'identity'
    >[];
    now: string;
  }): void {
    this.db.transaction(() => {
      this.getTeamExecution(input.executionId);
      if (input.roots.length === 0) throw new Error('Team integration requires root leases');
      const insert = this.db.prepare(
        `INSERT INTO team_integration_root_leases(
           mutation_key, root_id, execution_id, root_identity, acquired_at
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const root of [...input.roots].sort((a, b) =>
        a.mutationKey.localeCompare(b.mutationKey),
      )) {
        const mutationState = this.db
          .prepare(
            `SELECT state, root_identity_digest
             FROM workspace_mutation_state WHERE workspace_key = ?`,
          )
          .get(root.mutationKey) as
          { state: 'idle' | 'held' | 'quarantined'; root_identity_digest: string } | undefined;
        if (
          mutationState !== undefined &&
          (mutationState.state !== 'idle' || mutationState.root_identity_digest !== root.identity)
        )
          throw new TeamConflictError('A workspace root is leased or quarantined');
        const existing = this.db
          .prepare(
            `SELECT execution_id, mutation_key, root_identity
             FROM team_integration_root_leases WHERE mutation_key = ?`,
          )
          .get(root.mutationKey) as
          { execution_id: string; mutation_key: string; root_identity: string } | undefined;
        if (existing !== undefined) {
          if (
            existing.execution_id === input.executionId &&
            existing.mutation_key === root.mutationKey &&
            existing.root_identity === root.identity
          )
            continue;
          throw new TeamConflictError('A workspace root is already leased for integration');
        }
        insert.run(root.mutationKey, root.rootId, input.executionId, root.identity, input.now);
      }
    })();
  }

  releaseTeamIntegrationRootLeases(executionId: string): void {
    this.db
      .prepare('DELETE FROM team_integration_root_leases WHERE execution_id = ?')
      .run(executionId);
  }

  transitionTeamMission(missionId: string, to: TeamMissionState, now: string): TeamMissionRecord {
    const allowed: Readonly<Record<TeamMissionState, readonly TeamMissionState[]>> = {
      queued: ['running', 'canceled', 'failed'],
      running: ['waiting_resume', 'completed', 'canceled', 'failed'],
      waiting_resume: ['running', 'canceled', 'failed'],
      completed: [],
      failed: [],
      canceled: [],
    };
    const current = this.getTeamMission(missionId);
    if (current.state === to) return current;
    if (!allowed[current.state].includes(to))
      throw new Error(`Invalid Team Mission transition: ${current.state} -> ${to}`);
    const terminal = ['completed', 'failed', 'canceled'].includes(to);
    const result = this.db
      .prepare(
        `UPDATE team_missions
         SET state = ?, revision = revision + 1, updated_at = ?,
             completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
         WHERE id = ? AND revision = ?`,
      )
      .run(to, now, terminal ? 1 : 0, now, current.id, current.revision);
    if (result.changes !== 1) throw new TeamConflictError();
    return this.getTeamMission(current.id);
  }

  prepareTeamMissionResume(input: {
    missionId: string;
    executionId: string;
    now: string;
  }): TeamExecutionRecord {
    return this.db.transaction(() => {
      const mission = this.getTeamMission(input.missionId);
      const step = mission.steps.find(({ executionId }) => executionId === input.executionId);
      if (mission.state !== 'waiting_resume' || step?.ordinal !== mission.currentStepOrdinal)
        throw new Error('Mission is not waiting on this execution');
      const execution = this.getTeamExecution(input.executionId);
      if (execution.state !== 'waiting_resume')
        throw new Error('Mission execution is not waiting to resume');
      const previousDispatch = this.getTeamExecutionDispatch(execution.id);
      this.transitionTeamMission(mission.id, 'running', input.now);
      const queued = this.transitionTeamExecution({
        executionId: execution.id,
        to: 'queued',
        now: input.now,
        queueReason: 'recovery',
      });
      const message = this.createTeamMessage({
        teamId: execution.teamId,
        sourceAgentId: execution.createdByAgentId,
        targetAgentId: execution.assigneeAgentId,
        content: execution.instruction.content,
        executionId: execution.id,
      });
      this.createTeamTask({
        teamId: execution.teamId,
        messageId: message.id,
        assigneeAgentId: execution.assigneeAgentId,
        createdByAgentId: execution.createdByAgentId,
        description: execution.instruction.content,
        doneCriteria: previousDispatch.doneCriteria,
        now: input.now,
      });
      this.createTeamDelivery({ messageId: message.id, now: input.now });
      return queued;
    })();
  }

  recordTeamMissionCheckpoint(input: {
    executionId: string;
    checkpoint: TeamMissionCheckpoint;
    now: string;
  }): { mission: TeamMissionRecord; nextExecutionId: string | null } {
    return this.db.transaction(() => {
      const step = this.db
        .prepare('SELECT * FROM team_mission_steps WHERE execution_id = ?')
        .get(input.executionId) as TeamMissionStepRow | undefined;
      if (step === undefined) throw new NotFoundError('Team Mission step not found');
      if (step.checkpoint_json !== null) {
        const mission = this.getTeamMission(step.mission_id);
        const next = mission.steps.find(({ ordinal }) => ordinal === step.ordinal + 1);
        return { mission, nextExecutionId: next?.executionId ?? null };
      }
      if (this.getTeamExecution(input.executionId).state !== 'completed')
        throw new Error('Only a completed Mission step can be checkpointed');
      const serialized = JSON.stringify(input.checkpoint);
      const digest = createHash('sha256').update(serialized).digest('hex');
      const updated = this.db
        .prepare(
          `UPDATE team_mission_steps
           SET checkpoint_json = ?, checkpoint_digest = ?, completed_at = ?
           WHERE execution_id = ? AND checkpoint_json IS NULL`,
        )
        .run(serialized, digest, input.now, input.executionId);
      if (updated.changes !== 1) throw new TeamConflictError();
      const mission = this.getTeamMission(step.mission_id);
      const next = mission.steps.find(({ ordinal }) => ordinal === step.ordinal + 1) ?? null;
      if (next === null) {
        return {
          mission: this.transitionTeamMission(mission.id, 'completed', input.now),
          nextExecutionId: null,
        };
      }
      this.db
        .prepare(
          `UPDATE team_missions
           SET state = 'running', current_step_ordinal = ?,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(next.ordinal, input.now, mission.id, mission.revision);
      this.transitionTeamExecution({
        executionId: next.executionId,
        to: 'queued',
        now: input.now,
        queueReason: 'global_concurrency',
      });
      return { mission: this.getTeamMission(mission.id), nextExecutionId: next.executionId };
    })();
  }

  completeTeamMissionStep(input: {
    executionId: string;
    attemptId: string;
    teamTaskId: string;
    agentId: string;
    report: unknown;
    doneEvidence: readonly { criterion: string; evidence: string }[];
    checkpoint: TeamMissionCheckpoint;
    now: string;
  }): { mission: TeamMissionRecord; nextExecutionId: string | null } {
    return this.db.transaction(() => {
      const attempt = this.getTeamAttempt(input.attemptId);
      if (attempt.executionId !== input.executionId)
        throw new Error('Mission Attempt does not belong to execution');
      const task = this.getTeamTask(input.teamTaskId);
      const dispatch = this.getTeamExecutionDispatch(input.executionId);
      if (dispatch.teamTaskId !== task.id)
        throw new Error('Mission task is not the current execution dispatch');
      this.completeTeamTaskWithReport({
        teamTaskId: task.id,
        agentId: input.agentId,
        report: input.report,
        doneEvidence: input.doneEvidence,
        now: input.now,
      });
      this.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'completed',
        now: input.now,
      });
      this.transitionTeamExecution({
        executionId: input.executionId,
        to: 'completed',
        now: input.now,
      });
      return this.recordTeamMissionCheckpoint({
        executionId: input.executionId,
        checkpoint: input.checkpoint,
        now: input.now,
      });
    })();
  }

  recordTeamAttemptProviderResult(
    attemptId: string,
    resolution: ExecutionResolution | undefined,
    usage: NormalizedProviderUsage | undefined,
  ): TeamAttemptRecord {
    const parsedResolution =
      resolution === undefined ? undefined : executionResolutionSchema.parse(resolution);
    const parsedUsage =
      usage === undefined ? undefined : normalizedProviderUsageSchema.parse(usage);
    const result = this.db
      .prepare(
        `UPDATE team_attempts
         SET resolved_provider = COALESCE(?, resolved_provider),
             resolved_model = COALESCE(?, resolved_model),
             resolution_json = COALESCE(?, resolution_json),
             provider_usage_json = COALESCE(?, provider_usage_json),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        parsedResolution?.resolvedProvider ?? null,
        parsedResolution?.resolvedModel ?? null,
        parsedResolution === undefined ? null : JSON.stringify(parsedResolution),
        parsedUsage === undefined ? null : JSON.stringify(parsedUsage),
        new Date().toISOString(),
        attemptId,
      );
    if (result.changes !== 1) throw new NotFoundError('Team attempt not found');
    return this.getTeamAttempt(attemptId);
  }

  recoverInterruptedTeamExecutions(now: string): number {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM team_integration_root_leases').run();
      this.db
        .prepare(
          `UPDATE team_execution_isolations
           SET phase = 'waiting_resume', resume_kind = 'integration',
               reason = COALESCE(reason, 'Application restarted before repository integration completed'),
               revision = revision + 1, updated_at = ?
           WHERE phase IN ('finalizing', 'integrating')
              OR (
                phase = 'running'
                AND EXISTS (
                  SELECT 1 FROM team_execution_isolation_completions c
                  WHERE c.execution_id = team_execution_isolations.execution_id
                )
              )`,
        )
        .run(now);
      const running = this.db
        .prepare("SELECT id, execution_id, start_reason FROM team_attempts WHERE state = 'running'")
        .all() as {
        id: string;
        execution_id: string;
        start_reason: TeamAttemptStartReason;
      }[];
      for (const attempt of running) {
        const isolation = this.getTeamExecutionIsolation(attempt.execution_id);
        const completion = this.getTeamExecutionIsolationCompletion(attempt.execution_id);
        const workerFinishedBeforeRestart =
          isolation !== null &&
          completion !== null &&
          ['waiting_integration', 'waiting_resume'].includes(isolation.phase) &&
          (isolation.phase === 'waiting_integration' || isolation.resumeKind === 'integration');
        if (workerFinishedBeforeRestart) {
          const execution = this.getTeamExecution(attempt.execution_id);
          if (execution.state === 'running')
            this.transitionTeamExecution({
              executionId: execution.id,
              to: 'waiting_resume',
              now,
            });
          const mission = this.getTeamMissionForExecution(execution.id);
          if (mission !== null && mission.state === 'running')
            this.transitionTeamMission(mission.id, 'waiting_resume', now);
          const teamTask = this.getTeamTask(completion.teamTaskId);
          if (teamTask.status === 'running') this.transitionTeamTask(teamTask.id, 'blocked', now);
          continue;
        }
        this.transitionTeamAttempt({
          attemptId: attempt.id,
          to: 'interrupted',
          now,
          terminalReason: 'app_restart',
        });
        const execution = this.getTeamExecution(attempt.execution_id);
        if (execution.state !== 'running') continue;
        const mission = this.getTeamMissionForExecution(execution.id);
        const writable = execution.accessMode === 'workspace-write';
        const automaticRestartExhausted = attempt.start_reason === 'app_restart';
        if (writable || (automaticRestartExhausted && mission !== null)) {
          this.transitionTeamExecution({
            executionId: execution.id,
            to: 'waiting_resume',
            now,
          });
          if (mission !== null && mission !== undefined && mission.state === 'running')
            this.transitionTeamMission(mission.id, 'waiting_resume', now);
        } else if (automaticRestartExhausted)
          this.transitionTeamExecution({
            executionId: execution.id,
            to: 'failed',
            now,
          });
        else
          this.transitionTeamExecution({
            executionId: execution.id,
            to: 'queued',
            now,
            queueReason: 'recovery',
          });
      }
      return running.length;
    })();
  }

  recordTeamV2Activity(input: {
    teamId: string;
    type: TeamV2ActivityType;
    actorAgentId?: string | null;
    subjectAgentId?: string | null;
    executionId?: string | null;
    attemptId?: string | null;
    payload: unknown;
    now: string;
  }): TeamV2ActivityRecord {
    return this.db.transaction(() => this.recordTeamV2ActivityInTransaction(input))();
  }

  private recordTeamV2ActivityInTransaction(input: {
    teamId: string;
    type: TeamV2ActivityType;
    actorAgentId?: string | null;
    subjectAgentId?: string | null;
    executionId?: string | null;
    attemptId?: string | null;
    payload: unknown;
    now: string;
  }): TeamV2ActivityRecord {
    this.getTeam(input.teamId);
    if (!teamV2ActivityTypes.includes(input.type)) throw new Error('Invalid Team activity type');
    for (const agentId of [input.actorAgentId, input.subjectAgentId]) {
      if (agentId === undefined || agentId === null) continue;
      if (this.getAgent(agentId).teamId !== input.teamId)
        throw new Error('Team activity Agent must belong to the same Team');
    }
    const execution =
      input.executionId === undefined || input.executionId === null
        ? null
        : this.getTeamExecution(input.executionId);
    if (execution !== null && execution.teamId !== input.teamId)
      throw new Error('Team activity execution must belong to the same Team');
    const attempt =
      input.attemptId === undefined || input.attemptId === null
        ? null
        : this.getTeamAttempt(input.attemptId);
    if (attempt !== null && (execution === null || attempt.executionId !== execution.id))
      throw new Error('Team activity attempt requires its execution');
    const payloadJson = JSON.stringify(input.payload);
    if (payloadJson === undefined)
      throw new Error('Team activity payload must be JSON serializable');
    const seq = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM team_v2_activity_events WHERE team_id = ?',
        )
        .get(input.teamId) as { seq: number }
    ).seq;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO team_v2_activity_events(
           id, team_id, seq, type, actor_agent_id, subject_agent_id,
           execution_id, attempt_id, payload_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.teamId,
        seq,
        input.type,
        input.actorAgentId ?? null,
        input.subjectAgentId ?? null,
        execution?.id ?? null,
        attempt?.id ?? null,
        payloadJson,
        input.now,
      );
    return this.getTeamV2Activity(id);
  }

  listTeamV2Activity(teamId: string, afterSeq = 0, limit = 100): readonly TeamV2ActivityRecord[] {
    this.getTeam(teamId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new Error('Invalid Team activity cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid Team activity page size');
    return (
      this.db
        .prepare(
          `SELECT * FROM team_v2_activity_events
           WHERE team_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
        )
        .all(teamId, afterSeq, limit) as TeamV2ActivityRow[]
    ).map(toTeamV2Activity);
  }

  listLatestTeamV2Activity(teamId: string, limit = 100): readonly TeamV2ActivityRecord[] {
    this.getTeam(teamId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid Team activity page size');
    return (
      this.db
        .prepare(
          `SELECT * FROM (
             SELECT * FROM team_v2_activity_events
             WHERE team_id = ? ORDER BY seq DESC LIMIT ?
           ) ORDER BY seq`,
        )
        .all(teamId, limit) as TeamV2ActivityRow[]
    ).map(toTeamV2Activity);
  }

  createTeamMessage(input: {
    teamId: string;
    sourceAgentId: string;
    targetAgentId: string;
    content: string;
    executionId?: string;
    attemptId?: string;
  }): TeamMessageRecord {
    if (input.content.length < 1 || input.content.length > 100_000)
      throw new Error('Invalid team message content');
    return this.db.transaction(() => {
      const team = this.getTeam(input.teamId);
      if (team.state !== 'active') throw new Error('Team must be active to send messages');
      const source = this.getAgent(input.sourceAgentId);
      const target = this.getAgent(input.targetAgentId);
      if (source.teamId !== team.id || target.teamId !== team.id)
        throw new Error('Team message agent is not an active member');
      assertTeamMessageAllowed({
        source,
        target,
        allowWorkerDirectMessages: team.policy.allowWorkerDirectMessages,
      });
      const execution =
        input.executionId === undefined ? null : this.getTeamExecution(input.executionId);
      if (execution !== null && execution.teamId !== team.id)
        throw new Error('Message execution must belong to the same Team');
      const attempt = input.attemptId === undefined ? null : this.getTeamAttempt(input.attemptId);
      if (attempt !== null && execution === null)
        throw new Error('Message attempt requires an execution');
      if (attempt !== null && attempt.executionId !== execution?.id)
        throw new Error('Message attempt must belong to the linked execution');
      const now = new Date().toISOString();
      const id = randomUUID();
      const nextSeq = (
        this.db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM team_messages WHERE team_id = ?')
          .get(team.id) as { seq: number }
      ).seq;
      transitionTeamMessage('created', 'persisted');
      this.db
        .prepare(
          `INSERT INTO team_messages(
             id, team_id, source_agent_id, target_agent_id, seq, state, content,
             execution_id, attempt_id, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'persisted', ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          team.id,
          source.id,
          target.id,
          nextSeq,
          input.content,
          execution?.id ?? null,
          attempt?.id ?? null,
          now,
          now,
        );
      const insertEvent = this.db.prepare(
        `INSERT INTO team_message_events(
           id, message_id, revision, from_state, to_state, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertEvent.run(randomUUID(), id, 0, null, 'created', now);
      insertEvent.run(randomUUID(), id, 1, 'created', 'persisted', now);
      return this.getTeamMessage(id);
    })();
  }

  transitionTeamMessageState(messageId: string, to: TeamMessageState): TeamMessageRecord {
    return this.db.transaction(() => {
      const current = this.getTeamMessage(messageId);
      transitionTeamMessage(current.state, to);
      const now = new Date().toISOString();
      const nextRevision = current.revision + 1;
      const result = this.db
        .prepare(
          `UPDATE team_messages SET state = ?, revision = ?, updated_at = ?
           WHERE id = ? AND state = ? AND revision = ?`,
        )
        .run(to, nextRevision, now, messageId, current.state, current.revision);
      if (result.changes !== 1) throw new TeamConflictError();
      this.db
        .prepare(
          `INSERT INTO team_message_events(
             id, message_id, revision, from_state, to_state, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), messageId, nextRevision, current.state, to, now);
      return this.getTeamMessage(messageId);
    })();
  }

  createTeamTask(input: {
    teamId: string;
    messageId: string;
    assigneeAgentId: string;
    createdByAgentId: string;
    description: string;
    doneCriteria: readonly string[];
    now: string;
  }): TeamTaskRecord {
    if (input.doneCriteria.length === 0 || input.doneCriteria.some((item) => item.trim() === ''))
      throw new Error('Team task requires done criteria');
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO team_tasks(
           id, team_id, message_id, assignee_agent_id, created_by_agent_id, description,
           status, done_criteria_json, done_evidence_json, blocked_reason, started_at,
           completed_at, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'assigned', ?, '[]', NULL, NULL, NULL, 1, ?, ?)`,
      )
      .run(
        id,
        input.teamId,
        input.messageId,
        input.assigneeAgentId,
        input.createdByAgentId,
        input.description,
        JSON.stringify(input.doneCriteria),
        input.now,
        input.now,
      );
    return this.getTeamTask(id);
  }

  transitionTeamTask(
    taskId: string,
    status: TeamTaskRecord['status'],
    now: string,
  ): TeamTaskRecord {
    const current = this.getTeamTask(taskId);
    if (current.status === status) return current;
    if (!teamTaskTransitions[current.status].includes(status))
      throw new Error(`Invalid team task transition: ${current.status} -> ${status}`);
    const result = this.db
      .prepare(
        `UPDATE team_tasks SET status = ?, started_at = COALESCE(started_at, ?),
           revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
      )
      .run(status, status === 'running' ? now : null, now, taskId, current.revision);
    if (result.changes !== 1) throw new TeamConflictError();
    return this.getTeamTask(taskId);
  }

  recordTeamActivity(input: {
    teamTaskId: string;
    agentId: string;
    type: 'accepted' | 'activity' | 'fileChange' | 'blocked' | 'completed' | 'failed' | 'canceled';
    payload: unknown;
    now: string;
  }): void {
    const task = this.getTeamTask(input.teamTaskId);
    if (task.assigneeAgentId !== input.agentId)
      throw new Error('Team activity agent does not match task assignee');
    this.db
      .prepare(
        `INSERT INTO team_activity_events(
           id, team_task_id, agent_id, type, payload_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.teamTaskId,
        input.agentId,
        input.type,
        JSON.stringify(input.payload),
        input.now,
      );
  }

  completeTeamTaskWithReport(input: {
    teamTaskId: string;
    agentId: string;
    report: unknown;
    doneEvidence: readonly { criterion: string; evidence: string }[];
    now: string;
  }): TeamTaskRecord {
    return this.db.transaction(() => {
      const task = this.getTeamTask(input.teamTaskId);
      if (task.assigneeAgentId !== input.agentId)
        throw new Error('Worker report agent does not match task assignee');
      const report = workerReportSchema.parse(input.report);
      const terminalStatus =
        report.status === 'completed'
          ? 'completed'
          : report.status === 'failed'
            ? 'failed'
            : 'blocked';
      if (!teamTaskTransitions[task.status].includes(terminalStatus))
        throw new Error(`Invalid team task transition: ${task.status} -> ${terminalStatus}`);
      const evidence = new Map(input.doneEvidence.map((item) => [item.criterion, item.evidence]));
      if (
        terminalStatus === 'completed' &&
        task.doneCriteria.some((criterion) => (evidence.get(criterion)?.trim().length ?? 0) === 0)
      )
        throw new Error('Completed team task requires evidence for every done criterion');
      this.db
        .prepare(
          `INSERT INTO team_reports(
             id, team_task_id, agent_id, status, report_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          task.id,
          input.agentId,
          report.status,
          JSON.stringify(report),
          input.now,
        );
      this.db
        .prepare(
          `UPDATE team_tasks SET status = ?, done_evidence_json = ?,
             completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(terminalStatus, JSON.stringify(input.doneEvidence), input.now, input.now, task.id);
      return this.getTeamTask(task.id);
    })();
  }

  setWorkerCurrentActivity(agentId: string, activity: string | null, now: string): AgentRecord {
    return this.db.transaction(() => {
      this.getAgent(agentId);
      const result = this.db
        .prepare('UPDATE agents SET current_activity = ?, updated_at = ? WHERE id = ?')
        .run(activity, now, agentId);
      if (result.changes !== 1) throw new NotFoundError('Agent not found');
      return this.getAgent(agentId);
    })();
  }

  reserveTeamBudget(input: {
    teamId: string;
    entries: readonly {
      scope: BudgetScope;
      kind: BudgetKind;
      amount: number;
      agentId?: string;
    }[];
    purpose: string;
    now: string;
  }): TeamBudgetReservationRecord[] {
    if (input.entries.length < 1) throw new Error('Budget reservation requires at least one entry');
    if (input.purpose.trim().length < 1) throw new Error('Budget reservation requires a purpose');
    return this.db.transaction(() => {
      const team = this.getTeam(input.teamId);
      const globalLimits = this.getGlobalLimits();
      const created: TeamBudgetReservationRecord[] = [];
      const insert = this.db.prepare(
        `INSERT INTO team_budget_reservations(
           id, team_id, agent_id, scope, kind, amount, settled_amount, state, purpose,
           created_at, updated_at, revision
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?, ?, 1)`,
      );
      for (const entry of input.entries) {
        const agentId = entry.scope === 'worker' ? (entry.agentId ?? null) : null;
        if (team.policy.budgetMode !== 'unlimited') {
          const cap = this.budgetCap(team, globalLimits, entry.scope, entry.kind);
          const totals = this.budgetTotals(entry.scope, entry.kind, team.id, agentId);
          assertReservationWithinCap({
            scope: entry.scope,
            kind: entry.kind,
            cap,
            committed: totals.committed,
            reserved: totals.reserved,
            requested: entry.amount,
          });
        }
        const id = randomUUID();
        insert.run(
          id,
          team.id,
          agentId,
          entry.scope,
          entry.kind,
          entry.amount,
          input.purpose,
          input.now,
          input.now,
        );
        created.push(this.getBudgetReservation(id));
      }
      return created;
    })();
  }

  settleTeamBudget(input: {
    reservationIds: readonly string[];
    actuals?: Readonly<Record<string, number>>;
    now: string;
  }): TeamBudgetReservationRecord[] {
    return this.db.transaction(() => {
      const settled: TeamBudgetReservationRecord[] = [];
      for (const id of input.reservationIds) {
        const current = this.getBudgetReservation(id);
        transitionBudgetReservation(current.state, 'settled');
        const settledAmount = input.actuals?.[id] ?? current.amount;
        if (!Number.isSafeInteger(settledAmount) || settledAmount < 0)
          throw new Error('Invalid settled amount');
        const result = this.db
          .prepare(
            `UPDATE team_budget_reservations
             SET state = 'settled', settled_amount = ?, revision = revision + 1, updated_at = ?
             WHERE id = ? AND state = 'reserved' AND revision = ?`,
          )
          .run(settledAmount, input.now, id, current.revision);
        if (result.changes !== 1) throw new TeamConflictError();
        settled.push(this.getBudgetReservation(id));
      }
      return settled;
    })();
  }

  releaseTeamBudget(input: {
    reservationIds: readonly string[];
    now: string;
  }): TeamBudgetReservationRecord[] {
    return this.db.transaction(() => {
      const released: TeamBudgetReservationRecord[] = [];
      for (const id of input.reservationIds) {
        const current = this.getBudgetReservation(id);
        transitionBudgetReservation(current.state, 'released');
        const result = this.db
          .prepare(
            `UPDATE team_budget_reservations
             SET state = 'released', revision = revision + 1, updated_at = ?
             WHERE id = ? AND state = 'reserved' AND revision = ?`,
          )
          .run(input.now, id, current.revision);
        if (result.changes !== 1) throw new TeamConflictError();
        released.push(this.getBudgetReservation(id));
      }
      return released;
    })();
  }

  getTeamBudgetStatus(teamId: string): TeamBudgetStatus[] {
    const team = this.getTeam(teamId);
    const globalLimits = this.getGlobalLimits();
    const statuses: TeamBudgetStatus[] = [];
    for (const kind of budgetKinds) {
      const totals = this.budgetTotals('global', kind, team.id, null);
      statuses.push({
        scope: 'global',
        kind,
        cap: this.budgetCap(team, globalLimits, 'global', kind),
        committed: totals.committed,
        reserved: totals.reserved,
      });
    }
    for (const kind of budgetKinds) {
      const totals = this.budgetTotals('team', kind, team.id, null);
      statuses.push({
        scope: 'team',
        kind,
        cap: this.budgetCap(team, globalLimits, 'team', kind),
        committed: totals.committed,
        reserved: totals.reserved,
      });
    }
    const workers = this.db
      .prepare(
        `SELECT id FROM agents WHERE team_id = ? AND kind = 'worker' ORDER BY created_at, id`,
      )
      .all(team.id) as { id: string }[];
    for (const worker of workers) {
      for (const kind of budgetKinds) {
        if (kind === 'spawnSlots') continue;
        const totals = this.budgetTotals('worker', kind, team.id, worker.id);
        statuses.push({
          scope: 'worker',
          kind,
          cap: this.budgetCap(team, globalLimits, 'worker', kind),
          committed: totals.committed,
          reserved: totals.reserved,
        });
      }
    }
    return statuses;
  }

  getTeamUsageTotals(teamId: string): TeamUsageTotals {
    this.getTeam(teamId);
    return this.usageTotals('team_id', teamId);
  }

  getWorkerUsageTotals(agentId: string): TeamUsageTotals {
    this.getAgent(agentId);
    return this.usageTotals('agent_id', agentId);
  }

  createTeamDelivery(input: { messageId: string; now: string }): TeamDeliveryRecord {
    return this.db.transaction(() => {
      const message = this.getTeamMessage(input.messageId);
      if (this.getTeamDelivery(message.id) !== null)
        throw new Error('Delivery already exists for message');
      const deliveryId = teamDeliveryId({
        teamId: message.teamId,
        messageId: message.id,
        targetAgentId: message.targetAgentId,
      });
      this.db
        .prepare(
          `INSERT INTO team_message_deliveries(
             message_id, delivery_id, state, attempt, last_error,
             dispatched_at, acked_at, created_at, updated_at, revision
           ) VALUES (?, ?, 'persisted', 0, NULL, NULL, NULL, ?, ?, 1)`,
        )
        .run(message.id, deliveryId, input.now, input.now);
      this.insertDeliveryEvent(message.id, 1, null, 'persisted', 0, null, input.now);
      return this.requireTeamDelivery(message.id);
    })();
  }

  transitionTeamDelivery(input: {
    messageId: string;
    to: TeamDeliveryState;
    now: string;
    error?: string;
  }): TeamDeliveryRecord {
    return this.db.transaction(() => {
      const current = this.requireTeamDelivery(input.messageId);
      transitionTeamDeliveryState(current.state, input.to);
      let attempt = current.attempt;
      if (
        input.to === 'dispatched' &&
        (current.state === 'persisted' || current.state === 'timedOut')
      ) {
        if (current.state === 'timedOut')
          assertDeliveryRetryAllowed({
            attempt: current.attempt,
            maxAttempts: TEAM_DELIVERY_MAX_ATTEMPTS,
          });
        attempt = current.attempt + 1;
      }
      const dispatchedAt = input.to === 'dispatched' ? input.now : current.dispatchedAt;
      const ackedAt = input.to === 'acked' ? input.now : current.ackedAt;
      const lastError =
        input.to === 'failed' || input.to === 'timedOut'
          ? (input.error ?? current.lastError)
          : current.lastError;
      const nextRevision = current.revision + 1;
      const result = this.db
        .prepare(
          `UPDATE team_message_deliveries
           SET state = ?, attempt = ?, last_error = ?, dispatched_at = ?, acked_at = ?,
             revision = ?, updated_at = ?
           WHERE message_id = ? AND state = ? AND revision = ?`,
        )
        .run(
          input.to,
          attempt,
          lastError,
          dispatchedAt,
          ackedAt,
          nextRevision,
          input.now,
          input.messageId,
          current.state,
          current.revision,
        );
      if (result.changes !== 1) throw new TeamConflictError();
      this.insertDeliveryEvent(
        input.messageId,
        nextRevision,
        current.state,
        input.to,
        attempt,
        input.error ?? null,
        input.now,
      );
      return this.requireTeamDelivery(input.messageId);
    })();
  }

  getTeamDelivery(messageId: string): TeamDeliveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM team_message_deliveries WHERE message_id = ?')
      .get(messageId) as TeamDeliveryRow | undefined;
    return row === undefined ? null : toTeamDelivery(row);
  }

  countRecentTeamMessages(teamId: string, sinceIso: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM team_messages WHERE team_id = ? AND created_at >= ?`)
      .get(teamId, sinceIso) as { n: number };
    return row.n;
  }

  recordWorkerWorktree(input: {
    agentId: string;
    path: string;
    baseHead: string;
    now: string;
  }): WorkerWorktreeRecord {
    return this.db.transaction(() => {
      this.getAgent(input.agentId);
      this.db
        .prepare(
          `INSERT INTO worker_worktrees(
             agent_id, path, base_head, state, reason, created_at, updated_at
           ) VALUES (?, ?, ?, 'created', NULL, ?, ?)`,
        )
        .run(input.agentId, input.path, input.baseHead, input.now, input.now);
      return this.requireWorkerWorktree(input.agentId);
    })();
  }

  transitionWorkerWorktree(input: {
    agentId: string;
    to: WorkerWorktreeState;
    reason?: string;
    now: string;
  }): WorkerWorktreeRecord {
    return this.db.transaction(() => {
      const current = this.requireWorkerWorktree(input.agentId);
      if (!workerWorktreeTransitions[current.state].includes(input.to))
        throw new Error(`Invalid worker worktree transition: ${current.state} -> ${input.to}`);
      const reason = input.reason ?? current.reason;
      const result = this.db
        .prepare(
          `UPDATE worker_worktrees SET state = ?, reason = ?, updated_at = ?
           WHERE agent_id = ? AND state = ?`,
        )
        .run(input.to, reason, input.now, input.agentId, current.state);
      if (result.changes !== 1) throw new TeamConflictError();
      return this.requireWorkerWorktree(input.agentId);
    })();
  }

  getWorkerWorktree(agentId: string): WorkerWorktreeRecord | null {
    const row = this.db
      .prepare('SELECT * FROM worker_worktrees WHERE agent_id = ?')
      .get(agentId) as WorkerWorktreeRow | undefined;
    return row === undefined ? null : toWorkerWorktree(row);
  }

  recoverTeamsOnStartup(now: string): {
    teams: number;
    workers: number;
    threads: number;
    deliveries: number;
  } {
    return this.db.transaction(() => {
      const recoverableTeamIds = new Set(
        (
          this.db
            .prepare(
              `SELECT DISTINCT team_id FROM team_executions
               WHERE state IN (
                 'assigned', 'queued', 'waiting_verification', 'waiting_rate_limit',
                 'waiting_resume'
               )`,
            )
            .all() as { team_id: string }[]
        ).map(({ team_id }) => team_id),
      );
      const recoverableAssigneeIds = new Set(
        (
          this.db
            .prepare(
              `SELECT DISTINCT assignee_agent_id FROM team_executions
               WHERE state IN (
                 'assigned', 'queued', 'waiting_verification', 'waiting_rate_limit',
                 'waiting_resume'
               )`,
            )
            .all() as { assignee_agent_id: string }[]
        ).map(({ assignee_agent_id }) => assignee_agent_id),
      );
      let teams = 0;
      const teamRows = this.db
        .prepare(
          `SELECT id, state, revision FROM teams
           WHERE state IN ('active', 'forming', 'winding_down')`,
        )
        .all() as { id: string; state: TeamState; revision: number }[];
      for (const team of teamRows) {
        if (recoverableTeamIds.has(team.id)) continue;
        const to: TeamState = team.state === 'active' ? 'paused' : 'failed';
        transitionTeam(team.state, to);
        const result = this.db
          .prepare(
            `UPDATE teams SET state = ?, revision = revision + 1, updated_at = ?
             WHERE id = ? AND state = ? AND revision = ?`,
          )
          .run(to, now, team.id, team.state, team.revision);
        if (result.changes === 1) teams += 1;
      }

      let workers = 0;
      const workerRows = this.db
        .prepare(
          `SELECT id, state FROM agents
           WHERE kind = 'worker'
             AND state IN ('invited', 'spawning', 'ready', 'busy', 'waiting')`,
        )
        .all() as { id: string; state: WorkerState }[];
      for (const worker of workerRows) {
        if (recoverableAssigneeIds.has(worker.id)) {
          if (worker.state === 'busy')
            this.db
              .prepare(`UPDATE agents SET state = 'waiting', updated_at = ? WHERE id = ?`)
              .run(now, worker.id);
          continue;
        }
        transitionWorker(worker.state, 'stopped');
        const result = this.db
          .prepare(`UPDATE agents SET state = 'stopped', updated_at = ? WHERE id = ? AND state = ?`)
          .run(now, worker.id, worker.state);
        if (result.changes === 1) workers += 1;
      }

      const threadResult = this.db
        .prepare(
          `UPDATE agent_threads SET state = 'interrupted', revision = revision + 1, updated_at = ?
           WHERE state = 'active'`,
        )
        .run(now);
      const threads = threadResult.changes;

      this.db
        .prepare(
          `UPDATE team_tasks
           SET status = 'failed', revision = revision + 1, updated_at = ?
           WHERE status IN ('created', 'assigned', 'running', 'waiting', 'blocked')
             AND NOT EXISTS (
               SELECT 1
               FROM team_messages m
               JOIN team_executions e ON e.id = m.execution_id
               WHERE m.id = team_tasks.message_id
                 AND e.state IN (
                   'assigned', 'queued', 'waiting_verification', 'waiting_rate_limit',
                   'waiting_resume'
                 )
             )`,
        )
        .run(now);

      let deliveries = 0;
      const deliveryRows = this.db
        .prepare(
          `SELECT message_id, state, attempt, revision FROM team_message_deliveries
           WHERE state = 'dispatched'`,
        )
        .all() as {
        message_id: string;
        state: TeamDeliveryState;
        attempt: number;
        revision: number;
      }[];
      for (const delivery of deliveryRows) {
        transitionTeamDeliveryState(delivery.state, 'timedOut');
        const nextRevision = delivery.revision + 1;
        const result = this.db
          .prepare(
            `UPDATE team_message_deliveries
             SET state = 'timedOut', revision = ?, updated_at = ?
             WHERE message_id = ? AND state = 'dispatched' AND revision = ?`,
          )
          .run(nextRevision, now, delivery.message_id, delivery.revision);
        if (result.changes === 1) {
          this.insertDeliveryEvent(
            delivery.message_id,
            nextRevision,
            'dispatched',
            'timedOut',
            delivery.attempt,
            'startup recovery',
            now,
          );
          deliveries += 1;
        }
      }

      this.db
        .prepare(
          `UPDATE team_budget_reservations
           SET state = 'released', revision = revision + 1, updated_at = ?
           WHERE state = 'reserved'`,
        )
        .run(now);
      return { teams, workers, threads, deliveries };
    })();
  }

  checkTeamIntegrity(): TeamIntegrityReport {
    const integrityRows = this.db.pragma('integrity_check') as {
      integrity_check: string;
    }[];
    const inconsistencies: string[] = [];
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check.toLowerCase() !== 'ok')
      inconsistencies.push(
        `sqlite_integrity:${integrityRows.map(({ integrity_check }) => integrity_check).join(',')}`,
      );
    const foreignKeys = this.db.pragma('foreign_key_check') as unknown[];
    if (foreignKeys.length > 0) inconsistencies.push(`foreign_keys:${foreignKeys.length}`);
    const checks = [
      {
        name: 'checkpoint_without_completed_execution',
        sql: `SELECT COUNT(*) AS count
              FROM team_mission_steps s
              JOIN team_executions e ON e.id = s.execution_id
              WHERE s.checkpoint_json IS NOT NULL AND e.state <> 'completed'`,
      },
      {
        name: 'completed_execution_without_checkpoint',
        sql: `SELECT COUNT(*) AS count
              FROM team_mission_steps s
              JOIN team_executions e ON e.id = s.execution_id
              WHERE e.state = 'completed' AND s.checkpoint_json IS NULL`,
      },
      {
        name: 'completed_mission_with_incomplete_step',
        sql: `SELECT COUNT(*) AS count
              FROM team_missions m
              WHERE m.state = 'completed'
                AND EXISTS (
                  SELECT 1 FROM team_mission_steps s
                  WHERE s.mission_id = m.id AND s.checkpoint_json IS NULL
                )`,
      },
      {
        name: 'waiting_mission_without_waiting_execution',
        sql: `SELECT COUNT(*) AS count
              FROM team_missions m
              WHERE m.state = 'waiting_resume'
                AND NOT EXISTS (
                  SELECT 1 FROM team_mission_steps s
                  JOIN team_executions e ON e.id = s.execution_id
                  WHERE s.mission_id = m.id
                    AND s.ordinal = m.current_step_ordinal
                    AND e.state = 'waiting_resume'
                )`,
      },
      {
        name: 'mission_missing_current_step',
        sql: `SELECT COUNT(*) AS count
              FROM team_missions m
              WHERE NOT EXISTS (
                SELECT 1 FROM team_mission_steps s
                WHERE s.mission_id = m.id AND s.ordinal = m.current_step_ordinal
              )`,
      },
      {
        name: 'mission_previous_step_without_checkpoint',
        sql: `SELECT COUNT(*) AS count
              FROM team_missions m
              JOIN team_mission_steps s ON s.mission_id = m.id
              WHERE s.ordinal < m.current_step_ordinal AND s.checkpoint_json IS NULL`,
      },
      {
        name: 'completed_write_without_integrated_head',
        sql: `SELECT COUNT(*) AS count
              FROM team_mission_step_worktrees w
              JOIN team_executions e ON e.id = w.execution_id
              WHERE e.state = 'completed' AND w.integrated_head IS NULL`,
      },
      {
        name: 'cleaned_worktree_without_completed_execution',
        sql: `SELECT COUNT(*) AS count
              FROM team_mission_step_worktrees w
              JOIN team_executions e ON e.id = w.execution_id
              WHERE w.state = 'cleaned' AND e.state <> 'completed'`,
      },
    ] as const;
    for (const check of checks) {
      const row = this.db.prepare(check.sql).get() as { count: number };
      if (row.count > 0) inconsistencies.push(`${check.name}:${row.count}`);
    }
    return {
      sqlite: inconsistencies.some((issue) => issue.startsWith('sqlite_integrity:'))
        ? 'corrupt'
        : 'ok',
      inconsistencies,
    };
  }

  renameTask(taskId: string, title: string): TaskSummary {
    // An explicit rename takes the Task out of auto-naming for good, so a later first-message
    // derivation can never overwrite it (issue #4's "手動でリネームした Task は…名前が勝手に変わらない").
    this.db.prepare("UPDATE tasks SET title_source = 'manual' WHERE id = ?").run(taskId);
    return this.updateTask(taskId, 'title', title);
  }
  applyGeneratedTaskTitle(taskId: string, title: string): TaskSummary | null {
    const parsedTitle = taskSummarySchema.shape.title.parse(title.trim());
    const result = this.db
      .prepare(
        `UPDATE tasks SET title = ?, updated_at = ?
         WHERE id = ? AND title_source = 'auto' AND title <> ?`,
      )
      .run(parsedTitle, new Date().toISOString(), taskId, parsedTitle);
    // A zero-row update is the important race outcome: the user may have renamed the Task while
    // the model was working. In that case the generated title is discarded, not retried.
    if (result.changes !== 1) return null;
    return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
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
      return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
    })();
  }
  setGoal(taskId: string, goal: string): TaskSummary {
    if (goal.trim() === '') return this.clearGoal(taskId);
    return this.db.transaction(() => {
      const current = this.getTaskRow(taskId);
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE tasks
              SET goal = ?, goal_status = 'paused', goal_token_budget = NULL,
                  goal_tokens_used = 0, goal_time_used_seconds = 0,
                  goal_started_at = ?, goal_updated_at = ?,
                  context_epoch = context_epoch + ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(goal, now, now, current.goal === goal ? 0 : 1, now, taskId);
      if (result.changes !== 1) throw new NotFoundError('Task not found');
      this.quarantineStaleBackgroundInTransaction(taskId);
      return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
    })();
  }

  startGoal(taskId: string, objective: string): TaskSummary {
    return this.db.transaction(() => {
      const current = this.getTaskRow(taskId);
      const parsedObjective = objective.trim();
      if (parsedObjective.length === 0 || parsedObjective.length > 4000)
        throw new Error('Goal must be between 1 and 4000 characters');
      const now = new Date().toISOString();
      const preservingUsage = current.goal === parsedObjective && current.goal_status !== null;
      const activeSeconds =
        preservingUsage && current.goal_status === 'active' && current.goal_updated_at !== null
          ? Math.max(
              0,
              Math.floor(
                (new Date(now).getTime() - new Date(current.goal_updated_at).getTime()) / 1000,
              ),
            )
          : 0;
      const result = this.db
        .prepare(
          `UPDATE tasks
              SET goal = ?, goal_status = 'active', goal_token_budget = ?,
                  goal_tokens_used = ?, goal_time_used_seconds = ?,
                  goal_started_at = ?, goal_updated_at = ?,
                  context_epoch = context_epoch + ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          parsedObjective,
          null,
          preservingUsage ? current.goal_tokens_used : 0,
          preservingUsage ? current.goal_time_used_seconds + activeSeconds : 0,
          preservingUsage ? current.goal_started_at : now,
          now,
          current.goal === parsedObjective ? 0 : 1,
          now,
          taskId,
        );
      if (result.changes !== 1) throw new NotFoundError('Task not found');
      this.quarantineStaleBackgroundInTransaction(taskId);
      return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
    })();
  }

  pauseGoal(taskId: string): TaskSummary {
    return this.transitionGoal(taskId, 'paused');
  }

  resumeGoal(taskId: string): TaskSummary {
    return this.transitionGoal(taskId, 'active');
  }

  clearGoal(taskId: string): TaskSummary {
    return this.db.transaction(() => {
      const current = this.getTaskRow(taskId);
      const result = this.db
        .prepare(
          `UPDATE tasks
              SET goal = NULL, goal_status = NULL, goal_token_budget = NULL,
                  goal_tokens_used = 0, goal_time_used_seconds = 0,
                  goal_started_at = NULL, goal_updated_at = NULL,
                  context_epoch = context_epoch + ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(current.goal === null ? 0 : 1, new Date().toISOString(), taskId);
      if (result.changes !== 1) throw new NotFoundError('Task not found');
      this.quarantineStaleBackgroundInTransaction(taskId);
      return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
    })();
  }

  startGoalTurn(
    taskId: string,
    objective: string,
    skills: readonly PersistedTurnSkill[] = [],
    includeBuiltinTeamSkill = false,
  ): StartedGoalTurn {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      this.assertTaskNotMutationQuarantined(taskId);
      if (this.getActiveTurnId(taskId) !== null) throw new TurnActiveError();
      this.startGoal(taskId, objective);
      const started = this.startTurnInTransaction(
        taskId,
        objective,
        skills,
        includeBuiltinTeamSkill,
      );
      return { task: this.getTask(taskId), started };
    })();
  }

  resumeGoalTurn(
    taskId: string,
    skills: readonly PersistedTurnSkill[] = [],
    includeBuiltinTeamSkill = false,
  ): StartedGoalTurn {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      this.assertTaskNotMutationQuarantined(taskId);
      if (this.getActiveTurnId(taskId) !== null) throw new TurnActiveError();
      const current = this.getTaskRow(taskId);
      if (current.goal === null || current.goal_status === null)
        throw new Error('Task does not have a Goal');
      this.transitionGoal(taskId, 'active');
      const text = `Goalを続けてください: ${current.goal}`;
      const started = this.startTurnInTransaction(taskId, text, skills, includeBuiltinTeamSkill);
      return { task: this.getTask(taskId), started };
    })();
  }

  pauseGoalAndCancelTurn(
    taskId: string,
    turnId: string | null,
    startNext = true,
  ): { task: TaskSummary; canceledEvent: TurnEvent | null; next: QueueTransition } {
    return this.db.transaction(() => {
      const canceledEvent = turnId === null ? null : this.cancelTurn(taskId, turnId);
      this.pauseGoal(taskId);
      const next = !startNext || canceledEvent === null ? null : this.startNextQueued(taskId);
      return { canceledEvent, next, task: this.getTask(taskId) };
    })();
  }

  clearGoalAndCancelTurn(
    taskId: string,
    turnId: string | null,
    startNext = true,
  ): { task: TaskSummary; canceledEvent: TurnEvent | null; next: QueueTransition } {
    return this.db.transaction(() => {
      const canceledEvent = turnId === null ? null : this.cancelTurn(taskId, turnId);
      this.clearGoal(taskId);
      const next = !startNext || canceledEvent === null ? null : this.startNextQueued(taskId);
      return { canceledEvent, next, task: this.getTask(taskId) };
    })();
  }

  completeTurnAndFinishGoal(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
    finalText?: string,
  ): { event: TurnEvent; task: TaskSummary | null } {
    return this.db.transaction(() => {
      const event = this.completeTurnInTransaction(taskId, turnId, state, finalText);
      const current = this.getTaskRow(taskId);
      if (current.goal === null || current.goal_status !== 'active') return { event, task: null };
      const now = new Date();
      const activeSeconds =
        current.goal_updated_at === null
          ? 0
          : Math.max(
              0,
              Math.floor((now.getTime() - new Date(current.goal_updated_at).getTime()) / 1000),
            );
      const goalStatus =
        state === 'completed' ? 'completed' : state === 'failed' ? 'blocked' : 'paused';
      const usage = this.getTurnProviderUsage(taskId, turnId);
      const turnTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      this.db
        .prepare(
          `UPDATE tasks
              SET goal_status = ?, goal_tokens_used = ?, goal_time_used_seconds = ?,
                  goal_updated_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          goalStatus,
          current.goal_tokens_used + turnTokens,
          current.goal_time_used_seconds + activeSeconds,
          now.toISOString(),
          now.toISOString(),
          taskId,
        );
      return { event, task: this.getTask(taskId) };
    })();
  }

  cancelTurnAndFinishGoal(
    taskId: string,
    turnId: string,
  ): { event: TurnEvent | null; task: TaskSummary | null } {
    return this.db.transaction(() => {
      const turn = this.getTurn(taskId, turnId);
      if (isTerminal(turn.state)) return { event: null, task: null };
      transitionTurn(turn.state, 'canceling');
      this.updateTurn(turnId, 'canceling');
      return this.completeTurnAndFinishGoal(taskId, turnId, 'canceled');
    })();
  }

  private transitionGoal(taskId: string, status: 'active' | 'paused'): TaskSummary {
    return this.db.transaction(() => {
      const current = this.getTaskRow(taskId);
      if (current.goal === null || current.goal_status === null)
        throw new Error('Task does not have a Goal');
      const now = new Date();
      const activeSeconds =
        current.goal_status === 'active' && current.goal_updated_at !== null
          ? Math.max(
              0,
              Math.floor((now.getTime() - new Date(current.goal_updated_at).getTime()) / 1000),
            )
          : 0;
      const result = this.db
        .prepare(
          `UPDATE tasks
              SET goal_status = ?, goal_time_used_seconds = ?, goal_updated_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          status,
          current.goal_time_used_seconds + activeSeconds,
          now.toISOString(),
          now.toISOString(),
          taskId,
        );
      if (result.changes !== 1) throw new NotFoundError('Task not found');
      return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
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

  createDraftImageAttachment(input: DraftImageAttachmentInput): ImageAttachmentMetadata {
    return this.db.transaction(() => {
      this.assertTask(input.taskId);
      const aggregate = this.db
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS byte_length
           FROM image_attachments WHERE task_id = ? AND state = 'draft'`,
        )
        .get(input.taskId) as { count: number; byte_length: number };
      if (aggregate.count >= IMAGE_ATTACHMENT_MAX_COUNT)
        throw new ImageAttachmentLimitError('A draft cannot contain more than four images');
      const id = randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const metadata = imageAttachmentMetadataSchema.parse({
        id,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteLength: input.bytes.byteLength,
        createdAt,
      });
      if (aggregate.byte_length + metadata.byteLength > IMAGE_ATTACHMENT_MAX_TOTAL_BYTES)
        throw new ImageAttachmentLimitError('Draft image bytes exceed the aggregate limit');
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      this.db
        .prepare(
          `INSERT INTO image_attachments(
             id, task_id, message_id, state, file_name, mime_type,
             byte_length, sha256, bytes, created_at
           ) VALUES (?, ?, NULL, 'draft', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.taskId,
          metadata.fileName,
          metadata.mimeType,
          metadata.byteLength,
          sha256,
          input.bytes,
          metadata.createdAt,
        );
      return metadata;
    })();
  }

  listDraftImageAttachments(taskId: string): ImageAttachmentMetadata[] {
    this.assertTask(taskId);
    const rows = this.db
      .prepare(
        `SELECT * FROM image_attachments
         WHERE task_id = ? AND state = 'draft'
         ORDER BY created_at, rowid`,
      )
      .all(taskId) as ImageAttachmentRow[];
    return imageAttachmentMetadataListSchema.parse(rows.map(toImageAttachmentMetadata));
  }

  getAcceptedImageAttachments(taskId: string, turnId: string): AcceptedImageAttachment[] {
    this.assertTask(taskId);
    const rows = this.db
      .prepare(
        `SELECT attachment.*
         FROM image_attachments attachment
         JOIN messages message
           ON message.id = attachment.message_id AND message.task_id = attachment.task_id
         JOIN turns turn
           ON turn.id = message.turn_id AND turn.task_id = message.task_id
          AND turn.user_message_id = message.id
         WHERE attachment.task_id = ? AND turn.id = ? AND message.author = 'user'
           AND attachment.state = 'message' AND attachment.message_ordinal IS NOT NULL
         ORDER BY attachment.message_ordinal`,
      )
      .all(taskId, turnId) as ImageAttachmentRow[];
    const metadata = imageAttachmentMetadataListSchema.parse(rows.map(toImageAttachmentMetadata));
    let expectedMetadata: readonly ImageAttachmentMetadata[];
    try {
      const eventRow = this.db
        .prepare(
          `SELECT payload_json FROM turn_events
           WHERE task_id = ? AND turn_id = ? AND type = 'turn.accepted'
           ORDER BY seq LIMIT 1`,
        )
        .get(taskId, turnId) as { payload_json: string } | undefined;
      if (eventRow === undefined) throw new Error('missing acceptance event');
      const event = turnEventSchema.parse(JSON.parse(eventRow.payload_json));
      if (event.type !== 'turn.accepted' || event.turnId !== turnId)
        throw new Error('mismatched acceptance event');
      expectedMetadata = event.userMessage.attachments;
    } catch {
      throw new ImageAttachmentAcceptanceError('stale');
    }
    if (
      expectedMetadata.length !== metadata.length ||
      expectedMetadata.some((expected, index) =>
        ['id', 'fileName', 'mimeType', 'byteLength', 'createdAt'].some(
          (key) =>
            expected[key as keyof ImageAttachmentMetadata] !==
            metadata[index]![key as keyof ImageAttachmentMetadata],
        ),
      )
    )
      throw new ImageAttachmentAcceptanceError('stale');
    return rows.map((row, index) => {
      if (
        row.bytes.byteLength !== row.byte_length ||
        createHash('sha256').update(row.bytes).digest('hex') !== row.sha256
      )
        throw new ImageAttachmentAcceptanceError('stale');
      return Object.freeze({
        ...metadata[index]!,
        sha256: row.sha256,
        bytes: Buffer.from(row.bytes),
      });
    });
  }

  removeDraftImageAttachment(taskId: string, attachmentId: string): void {
    this.assertTask(taskId);
    const result = this.db
      .prepare(
        `DELETE FROM image_attachments
         WHERE id = ? AND task_id = ? AND state = 'draft' AND message_id IS NULL`,
      )
      .run(attachmentId, taskId);
    if (result.changes !== 1) throw new NotFoundError('Draft image attachment not found');
  }

  getDraftSkillSelections(taskId: string): TurnSkillSelection[] {
    this.assertTask(taskId);
    const rows = this.db
      .prepare(
        `SELECT source, skill_id, digest, kind
         FROM task_draft_skill_bindings
         WHERE task_id = ?
         ORDER BY ordinal`,
      )
      .all(taskId) as SkillBindingIdentityRow[];
    return turnSkillSelectionsSchema.parse(rows.map(toTurnSkillSelection));
  }

  setDraftSkillSelections(taskId: string, skills: readonly TurnSkillSelection[]): void {
    const parsed = turnSkillSelectionsSchema.parse(skills);
    this.db.transaction(() => {
      this.assertTask(taskId);
      this.db.prepare('DELETE FROM task_draft_skill_bindings WHERE task_id = ?').run(taskId);
      const insert = this.db.prepare(
        `INSERT INTO task_draft_skill_bindings(
           task_id, ordinal, source, skill_id, digest, kind
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      parsed.forEach((selection, index) =>
        insert.run(
          taskId,
          index + 1,
          selection.ref.source,
          selection.ref.skillId,
          selection.ref.digest,
          selection.kind,
        ),
      );
      this.db
        .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), taskId);
    })();
  }

  getCanvasView(taskId: string): CanvasViewRecord | null {
    this.getTaskRow(taskId); // throws NotFoundError for an unknown Task
    const row = this.db
      .prepare(
        `SELECT camera_x, camera_y, camera_scale, node_positions_json, revision, updated_at
         FROM canvas_views WHERE task_id = ?`,
      )
      .get(taskId) as
      | {
          camera_x: number;
          camera_y: number;
          camera_scale: number;
          node_positions_json: string;
          revision: number;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) return null;
    // Drop node positions for agents that no longer exist for this Task (e.g. a Worker that was
    // stopped and never rehired under the same id — ids are never reused) — a stale entry would
    // otherwise persist forever without ever mapping back onto a visible node.
    const allowedAgentIds = new Set(
      (
        this.db.prepare('SELECT id FROM agents WHERE task_id = ?').all(taskId) as { id: string }[]
      ).map((agent) => agent.id),
    );
    const rawPositions = JSON.parse(row.node_positions_json) as Record<
      string,
      { x: number; y: number }
    >;
    const nodePositions: Record<string, { x: number; y: number }> = {};
    for (const [agentId, position] of Object.entries(rawPositions)) {
      if (allowedAgentIds.has(agentId)) nodePositions[agentId] = position;
    }
    return {
      taskId,
      camera: { x: row.camera_x, y: row.camera_y, scale: row.camera_scale },
      nodePositions,
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  }

  saveCanvasView(input: {
    taskId: string;
    camera: CanvasCameraRecord;
    nodePositions: Readonly<Record<string, { x: number; y: number }>>;
    revision: number;
  }): CanvasViewRecord {
    validateCanvasCamera(input.camera);
    validateCanvasNodePositions(input.nodePositions);
    const nodePositionsJson = JSON.stringify(input.nodePositions);
    if (Buffer.byteLength(nodePositionsJson, 'utf8') > CANVAS_VIEW_MAX_SERIALIZED_BYTES)
      throw new InvalidCanvasViewError(
        `nodePositions serialized payload exceeds ${CANVAS_VIEW_MAX_SERIALIZED_BYTES} bytes`,
      );
    return this.db.transaction(() => {
      this.getTaskRow(input.taskId); // throws NotFoundError for an unknown Task
      const now = new Date().toISOString();
      const current = this.db
        .prepare('SELECT revision FROM canvas_views WHERE task_id = ?')
        .get(input.taskId) as { revision: number } | undefined;
      if (current === undefined) {
        // Optimistic concurrency: creating a fresh row is only valid if the caller believed there
        // was nothing saved yet (revision 0).
        if (input.revision !== 0) throw new CanvasViewConflictError();
        this.db
          .prepare(
            `INSERT INTO canvas_views(
               task_id, camera_x, camera_y, camera_scale, node_positions_json, revision,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            input.taskId,
            input.camera.x,
            input.camera.y,
            input.camera.scale,
            nodePositionsJson,
            now,
            now,
          );
      } else {
        if (current.revision !== input.revision) throw new CanvasViewConflictError();
        this.db
          .prepare(
            `UPDATE canvas_views
             SET camera_x = ?, camera_y = ?, camera_scale = ?, node_positions_json = ?,
                 revision = revision + 1, updated_at = ?
             WHERE task_id = ? AND revision = ?`,
          )
          .run(
            input.camera.x,
            input.camera.y,
            input.camera.scale,
            nodePositionsJson,
            now,
            input.taskId,
            input.revision,
          );
      }
      // Re-read rather than hand-assembling the result: keeps the unknown-agent-id filtering
      // (getCanvasView) as the single source of truth for what a caller ever sees.
      const saved = this.getCanvasView(input.taskId);
      if (saved === null) throw new Error('Canvas view vanished within its own write transaction');
      return saved;
    })();
  }

  getWorkspace(taskId: string): string | null {
    const task = this.getTaskRow(taskId);
    if (task.project_id === null) return task.workspace_path;
    const project = this.getProjectRow(task.project_id);
    return project.workspace_roots_configured === 0 && task.legacy_project_workspace_fallback === 1
      ? task.workspace_path
      : null;
  }

  getMutationWorkspacePath(taskId: string, turnId: string, rootId: string | null): string | null {
    if (rootId === null) return this.getWorkspace(taskId);
    this.getTurn(taskId, turnId);
    const row = this.db
      .prepare(`SELECT canonical_path FROM turn_workspace_roots WHERE turn_id = ? AND root_id = ?`)
      .get(turnId, rootId) as { canonical_path: string } | undefined;
    return row?.canonical_path ?? null;
  }

  getEffectiveWorkspaceSet(taskId: string): EffectiveWorkspaceSet {
    const task = this.getTaskRow(taskId);
    if (task.project_id !== null) {
      const project = this.getProjectRow(task.project_id);
      const roots = this.getProjectRootRows(task.project_id);
      if (roots.length > 0) return effectiveWorkspaceSetFromRows('project', task.project_id, roots);
      if (
        project.workspace_roots_configured === 0 &&
        task.legacy_project_workspace_fallback === 1 &&
        task.workspace_path !== null &&
        task.mutation_scope_key !== null &&
        task.mutation_root_identity_digest !== null
      )
        return effectiveWorkspaceSetFromLegacyTask(task, task.project_id);
      return emptyEffectiveWorkspaceSet(task.project_id);
    }
    if (
      task.workspace_path !== null &&
      task.mutation_scope_key !== null &&
      task.mutation_root_identity_digest !== null
    )
      return effectiveWorkspaceSetFromLegacyTask(task, null);
    return emptyEffectiveWorkspaceSet(null);
  }

  sealTurnWorkspaceSet(taskId: string, turnId: string): EffectiveWorkspaceSet {
    return this.db.transaction(() => {
      const existing = this.readTurnWorkspaceSet(turnId);
      if (existing !== null) return existing;
      const turn = this.db.prepare('SELECT task_id FROM turns WHERE id = ?').get(turnId) as
        { task_id: string } | undefined;
      if (turn === undefined || turn.task_id !== taskId) throw new NotFoundError('Turn not found');
      const effective = this.getEffectiveWorkspaceSet(taskId);
      const task = this.getTaskRow(taskId);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO turn_workspace_sets(
             turn_id, task_id, source, project_id, primary_root_id, root_set_digest, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turnId,
          taskId,
          effective.source,
          effective.projectId,
          effective.primaryRootId,
          effective.digest,
          now,
        );
      const bindings = effectiveWorkspaceBindings(
        task,
        this.getProjectRootRows(task.project_id ?? ''),
      );
      const insert = this.db.prepare(
        `INSERT INTO turn_workspace_roots(
           turn_id, ordinal, root_id, canonical_path, label, role,
           workspace_key, root_identity_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      bindings.forEach((root, ordinal) =>
        insert.run(
          turnId,
          ordinal,
          root.rootId,
          root.path,
          root.label,
          root.role,
          root.workspaceKey,
          root.rootIdentityDigest,
        ),
      );
      return effective;
    })();
  }

  readTurnWorkspaceSet(turnId: string): EffectiveWorkspaceSet | null {
    const set = this.db
      .prepare('SELECT * FROM turn_workspace_sets WHERE turn_id = ?')
      .get(turnId) as
      | {
          source: 'project' | 'task' | 'none';
          project_id: string | null;
          primary_root_id: string | null;
          root_set_digest: string;
        }
      | undefined;
    if (set === undefined) return null;
    const roots = this.db
      .prepare('SELECT * FROM turn_workspace_roots WHERE turn_id = ? ORDER BY ordinal')
      .all(turnId) as {
      root_id: string;
      canonical_path: string;
      label: string;
      role: 'primary' | 'secondary';
    }[];
    return {
      source: set.source,
      projectId: set.project_id,
      primaryRootId: set.primary_root_id,
      roots: roots.map((root) => ({
        rootId: root.root_id,
        path: root.canonical_path,
        label: root.label,
        role: root.role,
        status: 'available',
      })),
      digest: set.root_set_digest,
    };
  }

  readTurnWorkspaceSetForTask(taskId: string, turnId: string): EffectiveWorkspaceSet | null {
    this.getTurn(taskId, turnId);
    return this.readTurnWorkspaceSet(turnId);
  }

  setWorkspace(taskId: string, path: string): void {
    const legacyKey = legacyMutationWorkspaceKey(path);
    this.setWorkspaceBinding(taskId, {
      path,
      workspaceKey: legacyKey,
      rootIdentityDigest: legacyKey,
    });
  }

  setWorkspaceBinding(
    taskId: string,
    binding: { path: string; workspaceKey: string; rootIdentityDigest: string },
  ): void {
    validateMutationDigest(binding.workspaceKey, 'workspace mutation key');
    validateMutationDigest(binding.rootIdentityDigest, 'workspace root identity digest');
    this.db.transaction(() => {
      this.assertTaskNotMutationQuarantined(taskId);
      const current = this.getTaskRow(taskId);
      if (current.project_id !== null) {
        const project = this.getProjectRow(current.project_id);
        if (
          project.workspace_roots_configured === 1 ||
          current.legacy_project_workspace_fallback !== 1
        )
          throw new InvalidProjectError('Project Tasks use the Project Workspace');
      }
      if (current.mutation_scope_key !== null) {
        const active = this.db
          .prepare(
            `SELECT 1 FROM workspace_mutation_state
             WHERE workspace_key = ? AND state = 'held' LIMIT 1`,
          )
          .get(current.mutation_scope_key);
        if (active !== undefined) throw new MutationLeaseBusyError();
      }
      const destination = this.db
        .prepare('SELECT state FROM workspace_mutation_state WHERE workspace_key = ?')
        .get(binding.workspaceKey) as { state: WorkspaceMutationRow['state'] } | undefined;
      if (destination?.state === 'held') throw new MutationLeaseBusyError();
      if (destination?.state === 'quarantined') throw new MutationQuarantinedError();
      const destinationQuarantine = this.db
        .prepare(
          `SELECT 1 FROM task_mutation_quarantines
           WHERE workspace_key = ? AND cleared_at IS NULL LIMIT 1`,
        )
        .get(binding.workspaceKey);
      if (destinationQuarantine !== undefined) throw new MutationQuarantinedError();
      const changed =
        !pathsEquivalent(current.workspace_path ?? '', binding.path) ||
        current.mutation_scope_key !== binding.workspaceKey ||
        current.mutation_root_identity_digest !== binding.rootIdentityDigest;
      const result = this.db
        .prepare(
          `UPDATE tasks SET workspace_path = ?, mutation_scope_key = ?,
           mutation_root_identity_digest = ?, context_epoch = context_epoch + ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          binding.path,
          binding.workspaceKey,
          binding.rootIdentityDigest,
          changed ? 1 : 0,
          new Date().toISOString(),
          taskId,
        );
      if (result.changes !== 1) throw new NotFoundError('Task not found');
      this.quarantineStaleBackgroundInTransaction(taskId);
    })();
  }

  getRuntime(): RuntimeKind {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'runtime.kind'").get() as
      { value: string } | undefined;
    if (row?.value === 'codex') return 'codex';
    if (row?.value === 'claude') return 'claude';
    return 'mock';
  }

  recordRuntimeFailureDiagnostic(
    taskId: string,
    turnId: string,
    diagnostic: RuntimeFailureDiagnostic,
  ): PersistedRuntimeFailureDiagnostic {
    this.getTurn(taskId, turnId);
    if (!isRuntimeFailureDiagnostic(diagnostic)) throw new Error('Invalid Runtime diagnostic');
    const safeDiagnostic: RuntimeFailureDiagnostic = {
      version: 1,
      diagnosticId: diagnostic.diagnosticId,
      runtimeKind: diagnostic.runtimeKind,
      failureStage: diagnostic.failureStage,
      elapsedMs: diagnostic.elapsedMs,
      appVersion: diagnostic.appVersion,
      cliVersion: diagnostic.cliVersion,
      ...(diagnostic.capabilityMismatch === undefined
        ? {}
        : { capabilityMismatch: diagnostic.capabilityMismatch }),
      ...(diagnostic.cliResolution === undefined
        ? {}
        : { cliResolution: diagnostic.cliResolution }),
      teamMcp: diagnostic.teamMcp,
      lastRecognizedNotification: diagnostic.lastRecognizedNotification,
      lastReceivedNotification: diagnostic.lastReceivedNotification,
      unsupportedNotificationCount: diagnostic.unsupportedNotificationCount,
      stderrObserved: diagnostic.stderrObserved,
      stderrTruncated: diagnostic.stderrTruncated,
      ...(diagnostic.codexIsolation === undefined
        ? {}
        : { codexIsolation: diagnostic.codexIsolation }),
      recordedAt: new Date().toISOString(),
      ...(diagnostic.reasonCode === undefined ? {} : { reasonCode: diagnostic.reasonCode }),
    };
    const serialized = JSON.stringify(safeDiagnostic);
    if (Buffer.byteLength(serialized, 'utf8') > RUNTIME_DIAGNOSTIC_MAX_BYTES)
      throw new Error('Runtime diagnostic exceeds byte limit');
    this.db
      .prepare(
        `INSERT INTO runtime_failure_diagnostics(
           id, task_id, turn_id, runtime_kind, failure_stage, diagnostic_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(turn_id) DO NOTHING`,
      )
      .run(
        safeDiagnostic.diagnosticId,
        taskId,
        turnId,
        safeDiagnostic.runtimeKind,
        safeDiagnostic.failureStage,
        serialized,
        safeDiagnostic.recordedAt,
      );
    const persisted = this.getRuntimeFailureDiagnostic({
      diagnosticId: safeDiagnostic.diagnosticId,
    });
    if (persisted !== null) return persisted;
    const existing = this.db
      .prepare(
        `SELECT task_id, turn_id, diagnostic_json FROM runtime_failure_diagnostics
         WHERE turn_id = ?`,
      )
      .get(turnId) as { task_id: string; turn_id: string; diagnostic_json: string } | undefined;
    if (existing === undefined) throw new Error('Runtime diagnostic was not persisted');
    const existingDiagnostic = JSON.parse(existing.diagnostic_json) as unknown;
    if (!isRuntimeFailureDiagnostic(existingDiagnostic))
      throw new Error('Persisted Runtime diagnostic is invalid');
    return Object.freeze({
      ...existingDiagnostic,
      taskId: existing.task_id,
      turnId: existing.turn_id,
    });
  }

  getRuntimeFailureDiagnostic(input: {
    taskId?: string | undefined;
    diagnosticId?: string | undefined;
  }): PersistedRuntimeFailureDiagnostic | null {
    if (input.taskId === undefined && input.diagnosticId === undefined)
      throw new Error('Task id or diagnostic id is required');
    const row = (
      input.diagnosticId !== undefined
        ? this.db
            .prepare(
              `SELECT task_id, turn_id, diagnostic_json FROM runtime_failure_diagnostics
               WHERE id = ? AND length(CAST(diagnostic_json AS BLOB)) <= ?`,
            )
            .get(input.diagnosticId, RUNTIME_DIAGNOSTIC_MAX_BYTES)
        : this.db
            .prepare(
              `SELECT task_id, turn_id, diagnostic_json FROM runtime_failure_diagnostics
               WHERE task_id = ? AND length(CAST(diagnostic_json AS BLOB)) <= ?
               ORDER BY created_at DESC, id DESC LIMIT 1`,
            )
            .get(input.taskId, RUNTIME_DIAGNOSTIC_MAX_BYTES)
    ) as { task_id: string; turn_id: string; diagnostic_json: string } | undefined;
    if (row === undefined) return null;
    let diagnostic: unknown;
    try {
      diagnostic = JSON.parse(row.diagnostic_json) as unknown;
    } catch {
      return null;
    }
    if (!isRuntimeFailureDiagnostic(diagnostic)) return null;
    return Object.freeze({ ...diagnostic, taskId: row.task_id, turnId: row.turn_id });
  }

  /**
   * The Runtime the user actually chose, or null if they never have (issue #50).
   *
   * `getRuntime()` cannot tell those apart, and the difference matters: "no preference yet" should
   * resolve to whichever real CLI is installed, while an explicit choice of Mock must be left alone.
   * Only Main can decide the first case, because only Main has probed.
   *
   * A separate marker key rather than the presence of `runtime.kind`, because the schema seeds that
   * row with 'mock' when the database is created — so its presence says nothing about whether anyone
   * chose it. The marker is written only by `setRuntime`, which is only ever called by a user
   * action or by the one-time adoption itself.
   */
  getStoredRuntime(): RuntimeKind | null {
    const chosen = this.db
      .prepare("SELECT value FROM settings WHERE key = 'runtime.kind.chosen'")
      .get() as { value: string } | undefined;
    if (chosen?.value !== '1') return null;
    return this.getRuntime();
  }

  setRuntime(kind: RuntimeKind): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES ('runtime.kind', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(kind, now);
      // Marks the preference as decided rather than seeded (issue #50). Written here because every
      // caller of setRuntime is either the user picking one or the one-time adoption of an installed
      // CLI — both of which are decisions, unlike the 'mock' row the schema creates.
      this.db
        .prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES ('runtime.kind.chosen', '1', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(now);
    })();
  }

  // The selected model is scoped per Runtime kind (its settings key), so switching between
  // Codex and Claude does not clobber the other's remembered preference. 'mock' has no model
  // concept and shares Codex's key, matching pre-Claude behavior exactly.
  getModel(): string {
    const kind = this.getRuntime();
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(modelSettingsKey(kind)) as { value: string } | undefined;
    return row?.value ?? 'auto';
  }

  setModel(model: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(modelSettingsKey(this.getRuntime()), model, new Date().toISOString());
  }

  reconcileBuiltinModelCatalog(
    kind: Extract<RuntimeKind, 'codex' | 'claude'>,
    availableModelIds: readonly string[],
  ): void {
    const available = new Set(availableModelIds);
    // A successful catalog always contains Auto plus at least one executable model. Treat a
    // smaller result as a retrieval failure and preserve every saved preference unchanged.
    if (!available.has('auto') || available.size < 2) return;
    const connectionId =
      kind === 'claude' ? BUILTIN_CLAUDE_CONNECTION_ID : BUILTIN_CODEX_CONNECTION_ID;
    const provider = kind === 'claude' ? 'anthropic' : 'openai';
    const normalize = (stored: string): { model: string; migrated: boolean } => {
      if (available.has(stored)) return { model: stored, migrated: false };
      const replacement = RETIRED_MODEL_IDS[kind]?.[stored];
      return replacement !== undefined && available.has(replacement)
        ? { model: replacement, migrated: true }
        : { model: 'auto', migrated: false };
    };
    this.db.transaction(() => {
      let migratedCount = 0;
      let resetCount = 0;
      const now = new Date().toISOString();
      const globalRow = this.db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(modelSettingsKey(kind)) as { value: string } | undefined;
      if (globalRow !== undefined) {
        const normalized = normalize(globalRow.value);
        if (normalized.model !== globalRow.value) {
          this.db
            .prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?')
            .run(normalized.model, now, modelSettingsKey(kind));
          if (normalized.migrated) migratedCount += 1;
          else resetCount += 1;
        }
      }
      const tasks = this.db
        .prepare(
          `SELECT id, requested_model FROM tasks
           WHERE connection_id = ? AND requested_provider = ? AND requested_model IS NOT NULL`,
        )
        .all(connectionId, provider) as Array<{ id: string; requested_model: string }>;
      for (const task of tasks) {
        const normalized = normalize(task.requested_model);
        if (normalized.model === task.requested_model) continue;
        this.setTaskModelSelection(task.id, modelSelectionForRuntime(kind, normalized.model));
        if (normalized.migrated) migratedCount += 1;
        else resetCount += 1;
      }
      if (migratedCount === 0 && resetCount === 0) return;
      const noticeKey = modelFallbackNoticeKey(kind);
      const pending = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(noticeKey) as
        { value: string } | undefined;
      let previous = { migratedCount: 0, resetCount: 0 };
      try {
        const parsed = JSON.parse(pending?.value ?? '') as Record<string, unknown>;
        if (
          Number.isSafeInteger(parsed['migratedCount']) &&
          Number(parsed['migratedCount']) >= 0 &&
          Number(parsed['migratedCount']) <= 1_000_000 &&
          Number.isSafeInteger(parsed['resetCount']) &&
          Number(parsed['resetCount']) >= 0 &&
          Number(parsed['resetCount']) <= 1_000_000
        )
          previous = {
            migratedCount: Number(parsed['migratedCount']),
            resetCount: Number(parsed['resetCount']),
          };
      } catch {
        // A malformed notice never blocks model repair; it is replaced with bounded safe counts.
      }
      this.db
        .prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(
          noticeKey,
          JSON.stringify({
            migratedCount: Math.min(1_000_000, previous.migratedCount + migratedCount),
            resetCount: Math.min(1_000_000, previous.resetCount + resetCount),
          }),
          now,
        );
    })();
  }

  takeModelFallbackNotice(): ModelFallbackNotice | null {
    return this.db.transaction(() => {
      const changes: ModelFallbackNotice['changes'] = [];
      for (const runtimeKind of ['codex', 'claude'] as const) {
        const key = modelFallbackNoticeKey(runtimeKind);
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
          { value: string } | undefined;
        if (row === undefined) continue;
        try {
          const parsed = JSON.parse(row.value) as Record<string, unknown>;
          const migratedCount = Number(parsed['migratedCount']);
          const resetCount = Number(parsed['resetCount']);
          if (
            Number.isSafeInteger(migratedCount) &&
            migratedCount >= 0 &&
            migratedCount <= 1_000_000 &&
            Number.isSafeInteger(resetCount) &&
            resetCount >= 0 &&
            resetCount <= 1_000_000 &&
            migratedCount + resetCount > 0
          )
            changes.push({ runtimeKind, migratedCount, resetCount });
        } catch {
          // Delete malformed internal notices without exposing their contents.
        }
        this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      }
      return changes.length === 0 ? null : modelFallbackNoticeSchema.parse({ changes });
    })();
  }

  getUpdateHealth(): UpdateHealth {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'update.health'").get() as
      { value: string } | undefined;
    if (row === undefined) return defaultUpdateHealth();
    try {
      const parsed = updateHealthSchema.safeParse(JSON.parse(row.value) as unknown);
      return parsed.success ? parsed.data : defaultUpdateHealth();
    } catch {
      return defaultUpdateHealth();
    }
  }

  recordUpdateCheckSuccess(at: string): UpdateHealth {
    return this.updateHealth((current) => ({
      ...current,
      successfulChecks: incrementBounded(current.successfulChecks),
      consecutiveFailures: 0,
      lastSuccessAt: at,
      lastErrorCategory: null,
    }));
  }

  recordUpdateCheckFailure(at: string, category: UpdateErrorCategory): UpdateHealth {
    return this.updateHealth((current) => ({
      ...current,
      failedChecks: incrementBounded(current.failedChecks),
      consecutiveFailures: incrementBounded(current.consecutiveFailures),
      lastFailureAt: at,
      lastErrorCategory: category,
    }));
  }

  private updateHealth(change: (current: UpdateHealth) => UpdateHealth): UpdateHealth {
    return this.db.transaction(() => {
      const next = updateHealthSchema.parse(change(this.getUpdateHealth()));
      this.db
        .prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES ('update.health', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify(next), new Date().toISOString());
      return next;
    })();
  }

  // Claude-only reasoning effort (see the ADR amendment). Unlike `model`, this is a single global
  // key ('runtime.claude.effort') rather than scoped per active Runtime kind: it only ever takes
  // effect on a Claude turn regardless of which Runtime is currently selected, and the Composer's
  // effort selector is disabled unless Claude is active.
  getEffort(): ClaudeEffort {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'runtime.claude.effort'")
      .get() as { value: string } | undefined;
    return isClaudeEffort(row?.value) ? row.value : 'medium';
  }

  setEffort(effort: ClaudeEffort): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('runtime.claude.effort', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(effort, new Date().toISOString());
  }

  // Codex reasoning level, under its own key so switching Runtime does not clobber the Claude
  // preference (issue #6). Deliberately NOT validated against a fixed enum here: the valid set is
  // per-model and published by the CLI in models_cache.json, so this layer stores whatever was
  // chosen and the settings read clamps it to the currently selected model's advertised set. An
  // empty string means "no override" — the correct state for the `auto` model sentinel.
  getCodexEffort(): string {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'runtime.codex.effort'")
      .get() as { value: string } | undefined;
    const stored = row?.value ?? '';
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(stored) ? stored : '';
  }

  setCodexEffort(effort: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('runtime.codex.effort', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(effort, new Date().toISOString());
  }

  getCodexUserConfigEnabled(): boolean {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'runtime.codex.user-config-enabled'")
      .get() as { value: string } | undefined;
    return row?.value === '1';
  }

  setCodexUserConfigEnabled(enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('runtime.codex.user-config-enabled', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(enabled ? '1' : '0', new Date().toISOString());
  }

  hasAcknowledgedFullAccessRisk(): boolean {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'permissions.full-access-risk-acknowledged'")
      .get() as { value: string } | undefined;
    return row?.value === '1';
  }

  acknowledgeFullAccessRisk(): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at)
         VALUES ('permissions.full-access-risk-acknowledged', '1', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(new Date().toISOString());
  }

  getTeamModelResearchBeforeHiring(): boolean {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'team.model-research-before-hiring'")
      .get() as { value: string } | undefined;
    return row?.value === '1';
  }

  setTeamModelResearchBeforeHiring(enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('team.model-research-before-hiring', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(enabled ? '1' : '0', new Date().toISOString());
  }

  getTeamModelSelectionGuidance(): string {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'team.model-selection-guidance'")
      .get() as { value: string } | undefined;
    return row?.value ?? '';
  }

  setTeamModelSelectionGuidance(guidance: string): void {
    const normalized = guidance.trim();
    if (normalized.length > 4000) throw new Error('Team model selection guidance is too long');
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('team.model-selection-guidance', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(normalized, new Date().toISOString());
  }

  getSprintCoderPrePrompt(): string {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'prompt.sprint-coder-pre-prompt'")
      .get() as { value: string } | undefined;
    return row?.value ?? '';
  }

  setSprintCoderPrePrompt(prompt: string): void {
    const normalized = prompt.trim();
    if (normalized.length > 8000) throw new Error('Sprint Coder pre-prompt is too long');
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('prompt.sprint-coder-pre-prompt', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(normalized, new Date().toISOString());
  }

  getTeamModelRestriction(): TeamModelRestriction {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'team.model-restriction'")
      .get() as { value: string } | undefined;
    if (row === undefined) return { mode: 'all', allowedModels: [] };
    try {
      return teamModelRestrictionSchema.parse(JSON.parse(row.value));
    } catch {
      return { mode: 'all', allowedModels: [] };
    }
  }

  setTeamModelRestriction(restriction: TeamModelRestriction): void {
    const parsed = teamModelRestrictionSchema.parse(restriction);
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('team.model-restriction', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(parsed), new Date().toISOString());
  }

  getDefaultTeamPolicy(): TeamPolicy {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'team.default-policy'")
      .get() as { value: string } | undefined;
    if (row === undefined) return { ...DEFAULT_TEAM_POLICY };
    try {
      const parsed = JSON.parse(row.value) as TeamPolicy;
      assertTeamPolicy(parsed);
      return { ...parsed };
    } catch {
      return { ...DEFAULT_TEAM_POLICY };
    }
  }

  setDefaultTeamPolicy(policy: TeamPolicy): void {
    assertTeamPolicy(policy);
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES ('team.default-policy', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(policy), new Date().toISOString());
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
      this.quarantineHeldMutationForTask(taskId, 'policy_epoch_changed', now);
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
      this.quarantineHeldMutationForTask(taskId, 'policy_epoch_changed', canonicalNow);
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

  acquireMutationLease(input: {
    rootId?: string | null;
    workspaceKey: string;
    rootIdentityDigest: string;
    holderInstanceId: string;
    taskId: string;
    turnId: string;
    sagaId: string;
    purpose: MutationLeasePurpose;
    policyEpoch: number;
    intentDigest: string;
    now: string;
    expiresAt: string;
  }): MutationLeaseToken {
    const rootId = input.rootId ?? null;
    validateMutationLeaseInput({ ...input, rootId });
    const outcome = this.db.transaction(() => {
      const task = this.getTaskRow(input.taskId);
      const sealedRoot =
        rootId === null
          ? null
          : (this.db
              .prepare(
                `SELECT workspace_key, root_identity_digest FROM turn_workspace_roots
                 WHERE turn_id = ? AND root_id = ?`,
              )
              .get(input.turnId, rootId) as
              { workspace_key: string; root_identity_digest: string } | undefined);
      const bindingMatches =
        rootId === null
          ? task.mutation_scope_key === input.workspaceKey &&
            task.mutation_root_identity_digest === input.rootIdentityDigest
          : sealedRoot?.workspace_key === input.workspaceKey &&
            sealedRoot.root_identity_digest === input.rootIdentityDigest;
      if (!bindingMatches) throw new MutationQuarantinedError();
      this.getTurn(input.taskId, input.turnId);
      const saga = this.getEditSaga(input.sagaId);
      if (
        saga.taskId !== input.taskId ||
        saga.turnId !== input.turnId ||
        saga.policyEpoch !== input.policyEpoch ||
        saga.rootId !== rootId ||
        saga.workspaceKey !== input.workspaceKey ||
        saga.rootIdentityDigest !== input.rootIdentityDigest ||
        saga.planDigest !== input.intentDigest ||
        saga.state === 'committed' ||
        saga.state === 'restored'
      )
        throw new MutationLeaseStaleError();
      this.ensureMutationRow(input.workspaceKey, input.rootIdentityDigest, input.now);
      const row = this.getMutationRow(input.workspaceKey);
      if (input.workspaceKey === input.rootIdentityDigest) {
        this.quarantineWorkspaceInTransaction(
          row,
          'legacy_workspace_identity',
          input.now,
          input.sagaId,
        );
        return { error: 'quarantined' } as const;
      }
      if (this.getPermissionPolicy(input.taskId).policyEpoch !== input.policyEpoch) {
        this.quarantineWorkspaceInTransaction(row, 'policy_epoch_changed', input.now, input.sagaId);
        return { error: 'quarantined' } as const;
      }
      const clockFailure = Date.parse(input.now) < Date.parse(row.last_observed_at);
      const rootFailure = row.root_identity_digest !== input.rootIdentityDigest;
      const expired =
        row.expires_at !== null && Date.parse(input.now) >= Date.parse(row.expires_at);
      if (clockFailure || rootFailure || (row.state === 'held' && expired)) {
        this.quarantineWorkspaceInTransaction(
          row,
          clockFailure ? 'clock_rollback' : rootFailure ? 'root_identity_changed' : 'lease_expired',
          input.now,
          row.saga_id,
        );
        return { error: clockFailure ? 'clock' : 'quarantined' } as const;
      }
      if (row.state === 'held') return { error: 'busy' } as const;
      if (
        this.db
          .prepare('SELECT 1 FROM team_integration_root_leases WHERE mutation_key = ? LIMIT 1')
          .get(input.workspaceKey) !== undefined
      )
        return { error: 'busy' } as const;
      const activeQuarantine = this.db
        .prepare(
          `SELECT 1 FROM task_mutation_quarantines
           WHERE workspace_key = ? AND cleared_at IS NULL LIMIT 1`,
        )
        .get(input.workspaceKey);
      if (activeQuarantine !== undefined && input.purpose !== 'recovery')
        return { error: 'quarantined' } as const;
      if (
        input.purpose === 'recovery' &&
        activeQuarantine === undefined &&
        row.state !== 'quarantined'
      )
        return { error: 'quarantined' } as const;
      if (row.state === 'quarantined' && input.purpose !== 'recovery')
        return { error: 'quarantined' } as const;
      if (input.purpose === 'recovery') {
        const source = this.db
          .prepare(
            `SELECT 1 FROM task_mutation_quarantines
             WHERE task_id = ? AND workspace_key = ? AND cleared_at IS NULL LIMIT 1`,
          )
          .get(input.taskId, input.workspaceKey);
        if (source === undefined) return { error: 'quarantined' } as const;
      }
      if (row.fence >= Number.MAX_SAFE_INTEGER) {
        this.quarantineWorkspaceInTransaction(row, 'fence_exhausted', input.now, input.sagaId);
        return { error: 'quarantined' } as const;
      }
      const leaseId = randomUUID();
      const fence = row.fence + 1;
      const revision = row.revision + 1;
      const result = this.db
        .prepare(
          `UPDATE workspace_mutation_state SET state = 'held', fence = ?, revision = ?,
           root_id = ?, lease_id = ?, holder_instance_id = ?, task_id = ?, turn_id = ?, saga_id = ?,
           purpose = ?, policy_epoch = ?, intent_digest = ?, acquired_at = ?, renewed_at = ?,
           expires_at = ?, last_observed_at = ?, quarantine_reason = NULL
           WHERE workspace_key = ? AND revision = ?`,
        )
        .run(
          fence,
          revision,
          rootId,
          leaseId,
          input.holderInstanceId,
          input.taskId,
          input.turnId,
          input.sagaId,
          input.purpose,
          input.policyEpoch,
          input.intentDigest,
          input.now,
          input.now,
          input.expiresAt,
          input.now,
          input.workspaceKey,
          row.revision,
        );
      if (result.changes !== 1) return { error: 'busy' } as const;
      return {
        token: mutationLeaseToken({
          ...input,
          rootId,
          leaseId,
          fence,
          revision,
          acquiredAt: input.now,
          renewedAt: input.now,
        }),
      } as const;
    })();
    if ('token' in outcome) return outcome.token;
    if (outcome.error === 'busy') throw new MutationLeaseBusyError();
    if (outcome.error === 'clock') throw new MutationClockRollbackError();
    throw new MutationQuarantinedError();
  }

  renewMutationLease(
    token: MutationLeaseToken,
    now: string,
    expiresAt: string,
  ): MutationLeaseToken {
    validateMutationToken(token);
    const nowMs = validateMutationTimestamp(now, 'mutation lease renewal time');
    const expiresMs = validateMutationTimestamp(expiresAt, 'mutation lease expiry');
    if (expiresMs <= nowMs) throw new Error('Mutation lease expiry must be in the future');
    const outcome = this.db.transaction(() => {
      const row = this.getMutationRow(token.workspaceKey);
      if (!mutationTokenMatchesRow(token, row)) return 'stale' as const;
      if (nowMs < Date.parse(row.last_observed_at)) {
        this.quarantineWorkspaceInTransaction(row, 'clock_rollback', now, token.sagaId);
        return 'clock' as const;
      }
      if (this.getPermissionPolicy(token.taskId).policyEpoch !== token.policyEpoch) {
        this.quarantineWorkspaceInTransaction(row, 'policy_epoch_changed', now, token.sagaId);
        return 'quarantined' as const;
      }
      if (Date.parse(row.expires_at!) <= nowMs) {
        this.quarantineWorkspaceInTransaction(row, 'lease_expired', now, token.sagaId);
        return 'quarantined' as const;
      }
      const revision = row.revision + 1;
      const result = this.db
        .prepare(
          `UPDATE workspace_mutation_state SET revision = ?, renewed_at = ?, expires_at = ?,
           last_observed_at = ? WHERE workspace_key = ? AND revision = ? AND state = 'held'`,
        )
        .run(revision, now, expiresAt, now, token.workspaceKey, row.revision);
      if (result.changes !== 1) return 'stale' as const;
      return mutationLeaseToken({ ...token, revision, renewedAt: now, expiresAt });
    })();
    if (outcome === 'clock') throw new MutationClockRollbackError();
    if (outcome === 'quarantined') throw new MutationQuarantinedError();
    if (outcome === 'stale') throw new MutationLeaseStaleError();
    return outcome;
  }

  assertMutationLease(token: MutationLeaseToken, now: string): void {
    validateMutationToken(token);
    const nowMs = validateMutationTimestamp(now, 'mutation lease assertion time');
    const outcome = this.db.transaction(() => {
      const row = this.getMutationRow(token.workspaceKey);
      if (!mutationTokenMatchesRow(token, row)) return 'stale' as const;
      if (nowMs < Date.parse(row.last_observed_at)) {
        this.quarantineWorkspaceInTransaction(row, 'clock_rollback', now, token.sagaId);
        return 'clock' as const;
      }
      if (this.getPermissionPolicy(token.taskId).policyEpoch !== token.policyEpoch) {
        this.quarantineWorkspaceInTransaction(row, 'policy_epoch_changed', now, token.sagaId);
        return 'quarantined' as const;
      }
      if (Date.parse(row.expires_at!) <= nowMs) {
        this.quarantineWorkspaceInTransaction(row, 'lease_expired', now, token.sagaId);
        return 'quarantined' as const;
      }
      return 'ok' as const;
    })();
    if (outcome === 'clock') throw new MutationClockRollbackError();
    if (outcome === 'quarantined') throw new MutationQuarantinedError();
    if (outcome === 'stale') throw new MutationLeaseStaleError();
  }

  releaseMutationLease(token: MutationLeaseToken, now: string): void {
    validateMutationToken(token);
    const nowMs = validateMutationTimestamp(now, 'mutation lease release time');
    const outcome = this.db.transaction(() => {
      const row = this.getMutationRow(token.workspaceKey);
      if (!mutationTokenMatchesRow(token, row)) return 'stale' as const;
      if (nowMs < Date.parse(row.last_observed_at)) {
        this.quarantineWorkspaceInTransaction(row, 'clock_rollback', now, token.sagaId);
        return 'clock' as const;
      }
      if (this.getPermissionPolicy(token.taskId).policyEpoch !== token.policyEpoch) {
        this.quarantineWorkspaceInTransaction(row, 'policy_epoch_changed', now, token.sagaId);
        return 'quarantined' as const;
      }
      if (Date.parse(row.expires_at!) <= nowMs) {
        this.quarantineWorkspaceInTransaction(row, 'lease_expired', now, token.sagaId);
        return 'quarantined' as const;
      }
      const changes = this.db
        .prepare(
          `UPDATE workspace_mutation_state SET state = 'idle', revision = revision + 1,
           root_id = NULL, lease_id = NULL, holder_instance_id = NULL, task_id = NULL, turn_id = NULL,
           saga_id = NULL, purpose = NULL, policy_epoch = NULL, intent_digest = NULL,
           acquired_at = NULL, renewed_at = NULL, expires_at = NULL, last_observed_at = ?,
           quarantine_reason = NULL WHERE workspace_key = ? AND revision = ? AND state = 'held'`,
        )
        .run(now, token.workspaceKey, row.revision).changes;
      return changes === 1 ? ('released' as const) : ('stale' as const);
    })();
    if (outcome === 'clock') throw new MutationClockRollbackError();
    if (outcome === 'quarantined') throw new MutationQuarantinedError();
    if (outcome === 'stale') throw new MutationLeaseStaleError();
  }

  quarantineStartupMutations(holderInstanceId: string, now: string): readonly MutationQuarantine[] {
    validateMutationIdentifier(holderInstanceId, 'holder instance id');
    validateMutationTimestamp(now, 'startup quarantine time');
    return this.db.transaction(() => {
      const held = this.db
        .prepare(
          `SELECT * FROM workspace_mutation_state
           WHERE state = 'held' AND holder_instance_id IS NOT ?`,
        )
        .all(holderInstanceId) as WorkspaceMutationRow[];
      for (const row of held)
        this.quarantineWorkspaceInTransaction(row, 'unclean_shutdown', now, row.saga_id);
      const unresolved = this.db
        .prepare(
          `SELECT DISTINCT e.workspace_key, e.root_identity_digest, e.id AS saga_id
           FROM edit_sagas e
           WHERE e.state IN ('prepared', 'applying', 'compensating', 'recovery_required')
             AND e.workspace_key IS NOT NULL AND e.root_identity_digest IS NOT NULL`,
        )
        .all() as { workspace_key: string; root_identity_digest: string; saga_id: string }[];
      for (const item of unresolved) {
        this.ensureMutationRow(item.workspace_key, item.root_identity_digest, now);
        const row = this.getMutationRow(item.workspace_key);
        if (row.state !== 'quarantined')
          this.quarantineWorkspaceInTransaction(row, 'unresolved_edit_saga', now, item.saga_id);
        this.quarantineSagaOwnerInTransaction(
          item.workspace_key,
          item.saga_id,
          'unresolved_edit_saga',
          this.getMutationRow(item.workspace_key).fence,
          now,
        );
      }
      (
        this.db
          .prepare('SELECT * FROM native_mutation_recovery_bindings')
          .all() as NativeMutationRecoveryBindingRow[]
      ).map(toNativeMutationRecoveryBinding);
      const unresolvedIntents = (
        this.db.prepare('SELECT * FROM native_mutation_intents').all() as NativeMutationIntentRow[]
      )
        .map(toNativeMutationIntent)
        .filter((intent) => intent.state !== 'completed');
      for (const item of unresolvedIntents) {
        this.ensureMutationRow(item.workspaceKey, item.rootIdentityDigest, now);
        const row = this.getMutationRow(item.workspaceKey);
        if (row.state !== 'quarantined')
          this.quarantineWorkspaceInTransaction(
            row,
            'unresolved_native_mutation_intent',
            now,
            item.sagaId,
          );
        this.quarantineSagaOwnerInTransaction(
          item.workspaceKey,
          item.sagaId,
          'unresolved_native_mutation_intent',
          this.getMutationRow(item.workspaceKey).fence,
          now,
        );
      }
      const legacy = this.db
        .prepare(
          `SELECT e.id AS saga_id, t.mutation_scope_key AS workspace_key,
                  t.mutation_root_identity_digest AS root_identity_digest
           FROM edit_sagas e JOIN tasks t ON t.id = e.task_id
           WHERE e.state IN ('prepared', 'applying', 'compensating', 'recovery_required')
             AND e.workspace_key IS NULL
             AND t.mutation_scope_key IS NOT NULL
             AND t.mutation_root_identity_digest IS NOT NULL`,
        )
        .all() as { workspace_key: string; root_identity_digest: string; saga_id: string }[];
      for (const item of legacy) {
        this.ensureMutationRow(item.workspace_key, item.root_identity_digest, now);
        const row = this.getMutationRow(item.workspace_key);
        if (row.state !== 'quarantined')
          this.quarantineWorkspaceInTransaction(row, 'legacy_unbound_edit_saga', now, item.saga_id);
        this.quarantineSagaOwnerInTransaction(
          item.workspace_key,
          item.saga_id,
          'legacy_unbound_edit_saga',
          this.getMutationRow(item.workspace_key).fence,
          now,
        );
      }
      return this.listMutationQuarantines();
    })();
  }

  initializeMutationRecovery(holderInstanceId: string, now: string): readonly MutationQuarantine[] {
    return this.db.transaction(() => {
      const quarantines = this.quarantineStartupMutations(holderInstanceId, now);
      // Retained rather than discarded: the count is the only evidence a user has that a Turn they
      // left running was reaped by a crash, and the SurfaceFooter reports it (issue #9).
      this.startupInterruptedTurns = this.interruptActiveTurns();
      this.recoverInterruptedTeamExecutions(now);
      return quarantines;
    })();
  }

  /**
   * What this launch's recovery pass did. Combines the pre-open corruption probe with the
   * interrupted-turn sweep, which run at different points and were previously both unreported.
   *
   * Zero/false across the board is the normal case; the footer stays quiet for it.
   */
  getStartupRecovery(): DatabaseRecovery {
    return {
      corruptionDetected: this.recoveryReport.corruptionDetected,
      restoredFromBackup: this.recoveryReport.restoredFromBackup,
      freshStart: this.recoveryReport.freshStart,
      corruptBundlePath: this.recoveryReport.corruptBundlePath,
      possibleCommittedDataLoss: this.recoveryReport.possibleCommittedDataLoss,
      interruptedTurns: this.startupInterruptedTurns,
    };
  }

  clearMutationQuarantine(workspaceKey: string, expectedFence: number, now: string): void {
    validateMutationDigest(workspaceKey, 'workspace mutation key');
    validateMutationTimestamp(now, 'quarantine clear time');
    this.db.transaction(() => {
      const row = this.getMutationRow(workspaceKey);
      if (row.state !== 'idle' || row.fence !== expectedFence) throw new MutationQuarantinedError();
      const unresolved = this.db
        .prepare(
          `SELECT 1 FROM edit_sagas e JOIN tasks t ON t.id = e.task_id
           WHERE (e.workspace_key = ? OR (e.workspace_key IS NULL AND t.mutation_scope_key = ?))
             AND e.state IN ('prepared', 'applying', 'compensating', 'recovery_required') LIMIT 1`,
        )
        .get(workspaceKey, workspaceKey);
      if (unresolved !== undefined) throw new MutationQuarantinedError();
      const intents = (
        this.db
          .prepare('SELECT * FROM native_mutation_intents WHERE workspace_key = ?')
          .all(workspaceKey) as NativeMutationIntentRow[]
      ).map(toNativeMutationIntent);
      if (intents.some((intent) => intent.state !== 'completed'))
        throw new MutationQuarantinedError();
      (
        this.db
          .prepare(
            `SELECT b.* FROM native_mutation_recovery_bindings b
             JOIN native_mutation_intents i ON i.id = b.intent_id
             WHERE i.workspace_key = ?`,
          )
          .all(workspaceKey) as NativeMutationRecoveryBindingRow[]
      ).map(toNativeMutationRecoveryBinding);
      this.db
        .prepare(
          `UPDATE task_mutation_quarantines SET cleared_at = ?, revision = revision + 1
           WHERE workspace_key = ? AND cleared_at IS NULL`,
        )
        .run(now, workspaceKey);
    })();
  }

  isNativeMutationAuthorityAvailable(): boolean {
    return !this.nativeMutationAuthorityDisabled;
  }

  private ensureMutationRow(workspaceKey: string, rootIdentityDigest: string, now: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_mutation_state(
          workspace_key, root_identity_digest, state, fence, revision, last_observed_at
        ) VALUES (?, ?, 'idle', 0, 0, ?)`,
      )
      .run(workspaceKey, rootIdentityDigest, now);
  }

  private getMutationRow(workspaceKey: string): WorkspaceMutationRow {
    const row = this.db
      .prepare('SELECT * FROM workspace_mutation_state WHERE workspace_key = ?')
      .get(workspaceKey) as WorkspaceMutationRow | undefined;
    if (row === undefined) throw new MutationLeaseStaleError();
    return row;
  }

  private quarantineWorkspaceInTransaction(
    row: WorkspaceMutationRow,
    reason: string,
    now: string,
    sourceSagaId: string | null,
  ): void {
    if (row.fence >= Number.MAX_SAFE_INTEGER) reason = 'fence_exhausted';
    const fence = row.fence >= Number.MAX_SAFE_INTEGER ? row.fence : row.fence + 1;
    const lastObservedAt =
      Date.parse(now) < Date.parse(row.last_observed_at) ? row.last_observed_at : now;
    const result = this.db
      .prepare(
        `UPDATE workspace_mutation_state SET state = 'quarantined', fence = ?,
         revision = revision + 1, lease_id = NULL, holder_instance_id = NULL,
         task_id = NULL, turn_id = NULL, saga_id = NULL, purpose = NULL,
         policy_epoch = NULL, intent_digest = NULL, acquired_at = NULL, renewed_at = NULL,
         expires_at = NULL, last_observed_at = ?, quarantine_reason = ?
         WHERE workspace_key = ? AND revision = ?`,
      )
      .run(fence, lastObservedAt, reason, row.workspace_key, row.revision);
    if (result.changes !== 1) throw new MutationLeaseStaleError();
    this.db
      .prepare(
        `INSERT INTO task_mutation_quarantines(
           task_id, workspace_key, reason, source_saga_id, fence, created_at, cleared_at, revision
         )
         SELECT id, ?, ?, ?, ?, ?, NULL, 0 FROM tasks WHERE mutation_scope_key = ?
         ON CONFLICT(task_id, workspace_key) DO UPDATE SET
           reason = excluded.reason, source_saga_id = excluded.source_saga_id,
           fence = excluded.fence, created_at = excluded.created_at, cleared_at = NULL,
           revision = task_mutation_quarantines.revision + 1`,
      )
      .run(row.workspace_key, reason, sourceSagaId, fence, now, row.workspace_key);
    try {
      this.invalidateNativeWorkspace(row.workspace_key, String(fence));
    } catch {
      // Preserve the durable quarantine and disable later native mutations because the
      // external session's revocation is now unknown.
      this.nativeMutationAuthorityDisabled = true;
    }
  }

  private quarantineHeldMutationForTask(taskId: string, reason: string, now: string): void {
    const row = this.db
      .prepare("SELECT * FROM workspace_mutation_state WHERE task_id = ? AND state = 'held'")
      .get(taskId) as WorkspaceMutationRow | undefined;
    if (row !== undefined) this.quarantineWorkspaceInTransaction(row, reason, now, row.saga_id);
  }

  private quarantineSagaOwnerInTransaction(
    workspaceKey: string,
    sagaId: string,
    reason: string,
    fence: number,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_mutation_quarantines(
           task_id, workspace_key, reason, source_saga_id, fence, created_at, cleared_at, revision
         ) SELECT task_id, ?, ?, id, ?, ?, NULL, 0 FROM edit_sagas WHERE id = ?
         ON CONFLICT(task_id, workspace_key) DO UPDATE SET
           reason = excluded.reason, source_saga_id = excluded.source_saga_id,
           fence = excluded.fence, created_at = excluded.created_at, cleared_at = NULL,
           revision = task_mutation_quarantines.revision + 1
         WHERE task_mutation_quarantines.cleared_at IS NOT NULL`,
      )
      .run(workspaceKey, reason, fence, now, sagaId);
  }

  private listMutationQuarantines(): readonly MutationQuarantine[] {
    return (
      this.db
        .prepare(
          `SELECT task_id, workspace_key, reason, source_saga_id, fence, created_at
           FROM task_mutation_quarantines WHERE cleared_at IS NULL ORDER BY task_id, workspace_key`,
        )
        .all() as {
        task_id: string;
        workspace_key: string;
        reason: string;
        source_saga_id: string | null;
        fence: number;
        created_at: string;
      }[]
    ).map((row) =>
      Object.freeze({
        taskId: row.task_id,
        workspaceKey: row.workspace_key,
        reason: row.reason,
        sourceSagaId: row.source_saga_id,
        fence: row.fence,
        createdAt: row.created_at,
      }),
    );
  }

  prepareEditSaga(request: EditSagaCreateRequest): EditSagaSnapshot {
    return this.db.transaction(() => {
      this.getTurn(request.taskId, request.turnId);
      const task = this.getTaskRow(request.taskId);
      if (this.getPermissionPolicy(request.taskId).policyEpoch !== request.policyEpoch)
        throw new OperationConflictError('Edit Saga policy epoch changed');
      const sealedRoot =
        request.rootId === null
          ? null
          : (this.db
              .prepare(
                `SELECT workspace_key, root_identity_digest FROM turn_workspace_roots
                 WHERE turn_id = ? AND root_id = ?`,
              )
              .get(request.turnId, request.rootId) as
              { workspace_key: string; root_identity_digest: string } | undefined);
      if (request.rootId !== null && sealedRoot === undefined)
        throw new OperationConflictError('Edit Saga root is not in the Turn Workspace snapshot');
      const boundWorkspaceKey = sealedRoot?.workspace_key ?? task.mutation_scope_key;
      const boundRootIdentityDigest =
        sealedRoot?.root_identity_digest ?? task.mutation_root_identity_digest;
      if (
        (request.workspaceKey !== null && request.workspaceKey !== boundWorkspaceKey) ||
        (request.rootIdentityDigest !== null &&
          request.rootIdentityDigest !== boundRootIdentityDigest)
      )
        throw new OperationConflictError('Edit Saga workspace binding changed');
      const boundRequest: EditSagaCreateRequest = {
        ...request,
        rootId: request.rootId,
        workspaceKey: boundWorkspaceKey,
        rootIdentityDigest: boundRootIdentityDigest,
        journalDigest: journaledPatchDigest({
          version: 3,
          policyEpoch: request.policyEpoch,
          rootId: request.rootId,
          workspaceKey: boundWorkspaceKey,
          rootIdentityDigest: boundRootIdentityDigest,
          operations: request.operations,
        }),
      };
      const existing = this.db
        .prepare('SELECT * FROM edit_sagas WHERE task_id = ? AND turn_id = ? AND operation_id = ?')
        .get(request.taskId, request.turnId, request.operationId) as EditSagaRow | undefined;
      if (existing !== undefined) {
        const snapshot = toEditSaga(existing);
        if (
          snapshot.planDigest !== request.planDigest ||
          snapshot.rootId !== boundRequest.rootId ||
          snapshot.workspaceKey !== boundRequest.workspaceKey ||
          snapshot.rootIdentityDigest !== boundRequest.rootIdentityDigest
        )
          throw new OperationConflictError('Edit operation id was reused with another patch');
        return snapshot;
      }
      const currentContract = this.getAcceptanceContract(request.taskId, request.turnId);
      const nextContract = appendEditSagaCriterion(currentContract, {
        sagaId: request.id,
        planDigest: request.planDigest,
        paths: request.operations.flatMap((operation) =>
          operation.destination === null
            ? [operation.path]
            : [operation.path, operation.destination],
        ),
      });
      if (nextContract !== currentContract) this.insertAcceptanceContract(nextContract);
      const snapshot = createEditSagaSnapshot(boundRequest);
      this.db
        .prepare(
          `INSERT INTO edit_sagas(
            id, task_id, turn_id, operation_id, plan_digest, policy_epoch,
            root_id, workspace_key, root_identity_digest,
            binding_version, native_binding_version, root_binding_version, state, revision,
            artifact_cleanup_pending, snapshot_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.id,
          snapshot.taskId,
          snapshot.turnId,
          snapshot.operationId,
          snapshot.planDigest,
          snapshot.policyEpoch,
          snapshot.rootId,
          snapshot.workspaceKey,
          snapshot.rootIdentityDigest,
          snapshot.state,
          snapshot.revision,
          snapshot.artifactCleanupPending ? 1 : 0,
          JSON.stringify(snapshot),
          snapshot.createdAt,
          snapshot.updatedAt,
        );
      return snapshot;
    })();
  }

  findEditSaga(taskId: string, turnId: string, operationId: string): EditSagaSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM edit_sagas WHERE task_id = ? AND turn_id = ? AND operation_id = ?')
      .get(taskId, turnId, operationId) as EditSagaRow | undefined;
    return row === undefined ? null : toEditSaga(row);
  }

  getEditSaga(id: string): EditSagaSnapshot {
    const row = this.db.prepare('SELECT * FROM edit_sagas WHERE id = ?').get(id) as
      EditSagaRow | undefined;
    if (row === undefined) throw new NotFoundError('Edit Saga not found');
    return toEditSaga(row);
  }

  getTurnDiff(taskId: string, turnId: string): readonly TurnDiffEntry[] {
    const turn = this.getTurn(taskId, turnId);
    if (turn.task_id !== taskId) throw new NotFoundError('Turn not found');
    const sagas = (
      this.db
        .prepare(
          `SELECT * FROM edit_sagas
           WHERE task_id = ? AND turn_id = ?
           ORDER BY created_at, id`,
        )
        .all(taskId, turnId) as EditSagaRow[]
    ).map(toEditSaga);
    return aggregateTurnDiff(sagas.map((saga) => saga.diff));
  }

  getAcceptanceContract(taskId: string, turnId: string): AcceptanceContract {
    const turn = this.getTurn(taskId, turnId);
    if (turn.task_id !== taskId) throw new NotFoundError('Turn not found');
    const row = this.db
      .prepare(
        `SELECT digest, snapshot_json FROM acceptance_contracts
         WHERE task_id = ? AND turn_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(taskId, turnId) as { digest: string; snapshot_json: string } | undefined;
    if (row === undefined) throw new NotFoundError('Acceptance Contract not found');
    const contract = parseAcceptanceContract(JSON.parse(row.snapshot_json));
    if (contract.taskId !== taskId || contract.turnId !== turnId || contract.digest !== row.digest)
      throw new OperationConflictError('Acceptance Contract subject mismatch');
    return contract;
  }

  listEvidenceRecords(taskId: string, turnId: string): readonly EvidenceRecord[] {
    const turn = this.getTurn(taskId, turnId);
    if (turn.task_id !== taskId) throw new NotFoundError('Turn not found');
    return (
      this.db
        .prepare(
          `SELECT record_digest, snapshot_json FROM evidence_records
           WHERE task_id = ? AND turn_id = ? ORDER BY created_at, id`,
        )
        .all(taskId, turnId) as { record_digest: string; snapshot_json: string }[]
    ).map((row) => {
      const record = parseEvidenceRecord(JSON.parse(row.snapshot_json));
      if (
        record.taskId !== taskId ||
        record.turnId !== turnId ||
        record.recordDigest !== row.record_digest
      )
        throw new OperationConflictError('Evidence Record subject mismatch');
      return record;
    });
  }

  listAssuranceRounds(taskId: string, turnId: string, sagaId: string): readonly AssuranceRound[] {
    const saga = this.getEditSaga(sagaId);
    if (saga.taskId !== taskId || saga.turnId !== turnId)
      throw new OperationConflictError('Assurance round subject mismatch');
    return (
      this.db
        .prepare(
          `SELECT digest, snapshot_json FROM assurance_rounds
           WHERE task_id = ? AND turn_id = ? AND saga_id = ? ORDER BY ordinal`,
        )
        .all(taskId, turnId, sagaId) as { digest: string; snapshot_json: string }[]
    ).map((row) => {
      const round = parseAssuranceRound(JSON.parse(row.snapshot_json));
      if (
        round.taskId !== taskId ||
        round.turnId !== turnId ||
        round.sagaId !== sagaId ||
        round.digest !== row.digest
      )
        throw new OperationConflictError('Assurance round subject mismatch');
      return round;
    });
  }

  recordAssuranceVerification(input: {
    taskId: string;
    turnId: string;
    sagaId: string;
    outcome: 'passed' | 'failed';
    failureClass: AssuranceFailureClass | null;
    createdAt: string;
  }): AssuranceRound {
    return this.db.transaction(() => {
      const saga = this.getEditSaga(input.sagaId);
      if (
        saga.taskId !== input.taskId ||
        saga.turnId !== input.turnId ||
        saga.state !== 'committed'
      )
        throw new OperationConflictError('Only a committed Edit Saga can be verified');
      const round = advanceStandardAssurance({
        ...input,
        previousRounds: this.listAssuranceRounds(input.taskId, input.turnId, input.sagaId),
      });
      this.db
        .prepare(
          `INSERT INTO assurance_rounds(
             id, task_id, turn_id, saga_id, ordinal, decision,
             repair_rounds_used, digest, snapshot_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          round.id,
          round.taskId,
          round.turnId,
          round.sagaId,
          round.ordinal,
          round.decision,
          round.repairRoundsUsed,
          round.digest,
          JSON.stringify(round),
          round.createdAt,
        );
      if (round.decision === 'complete') {
        const contract = this.getAcceptanceContract(input.taskId, input.turnId);
        this.insertEvidence(
          createVerificationEvidence({
            contract,
            sagaId: saga.id,
            planDigest: saga.planDigest,
            createdAt: input.createdAt,
          }),
        );
      }
      return round;
    })();
  }

  private insertAcceptanceContract(contract: AcceptanceContract): void {
    this.db
      .prepare(
        `INSERT INTO acceptance_contracts(
           turn_id, revision, id, task_id, digest, snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        contract.turnId,
        contract.revision,
        contract.id,
        contract.taskId,
        contract.digest,
        JSON.stringify(contract),
        contract.createdAt,
      );
  }

  private recordEditSagaEvidence(saga: EditSagaSnapshot): void {
    const contract = this.getAcceptanceContract(saga.taskId, saga.turnId);
    const evidence = createEditSagaEvidence({
      contract,
      sagaId: saga.id,
      planDigest: saga.planDigest,
      createdAt: saga.updatedAt,
    });
    this.insertEvidence(evidence);
  }

  private insertEvidence(evidence: EvidenceRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO evidence_records(
           id, task_id, turn_id, criterion_id, kind, subject_digest,
           record_digest, snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidence.id,
        evidence.taskId,
        evidence.turnId,
        evidence.criterionId,
        evidence.kind,
        evidence.subjectDigest,
        evidence.recordDigest,
        JSON.stringify(evidence),
        evidence.createdAt,
      );
  }

  updateEditSaga(
    id: string,
    expectedRevision: number,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot {
    return this.db.transaction(() => {
      const current = this.getEditSaga(id);
      if (current.revision !== expectedRevision)
        throw new OperationConflictError('Stale Edit Saga revision');
      const next = transitionEditSagaSnapshot(current, mutate);
      const result = this.db
        .prepare(
          `UPDATE edit_sagas SET state = ?, revision = ?, artifact_cleanup_pending = ?, snapshot_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          next.state,
          next.revision,
          next.artifactCleanupPending ? 1 : 0,
          JSON.stringify(next),
          next.updatedAt,
          id,
          expectedRevision,
        );
      if (result.changes !== 1) throw new OperationConflictError('Stale Edit Saga revision');
      if (current.state !== 'committed' && next.state === 'committed')
        this.recordEditSagaEvidence(next);
      return next;
    })();
  }

  updateEditSagaUnderLease(
    id: string,
    expectedRevision: number,
    lease: unknown,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot {
    const token = lease as MutationLeaseToken;
    validateMutationToken(token);
    const transaction = this.db.transaction(() => {
      const row = this.getMutationRow(token.workspaceKey);
      if (!mutationTokenMatchesRow(token, row) || token.sagaId !== id)
        throw new MutationLeaseStaleError();
      if (this.getPermissionPolicy(token.taskId).policyEpoch !== token.policyEpoch)
        throw new MutationLeaseStaleError();
      const saga = this.getEditSaga(id);
      if (
        saga.workspaceKey !== token.workspaceKey ||
        saga.rootIdentityDigest !== token.rootIdentityDigest ||
        saga.policyEpoch !== token.policyEpoch ||
        saga.planDigest !== token.intentDigest
      )
        throw new MutationLeaseStaleError();
      return this.updateEditSaga(id, expectedRevision, mutate);
    });
    return transaction.immediate();
  }

  listRecoverableEditSagas(): readonly EditSagaSnapshot[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM edit_sagas
           WHERE state IN ('prepared', 'applying', 'compensating') OR artifact_cleanup_pending = 1
           ORDER BY created_at, id`,
        )
        .all() as EditSagaRow[]
    ).map(toEditSaga);
  }

  prepareNativeMutationIntent(
    seed: NativeMutationIntentSeed,
    lease: MutationLeaseToken,
    now: string,
    coordinator: NativeMutationSagaCoordinator = 'native-intent',
  ): NativeMutationIntentSnapshot {
    validateNativeMutationSagaCoordinator(coordinator);
    validateMutationToken(lease);
    validateMutationTimestamp(now, 'Native mutation intent preparation time');
    const parsedSeed = parseNativeMutationIntentSeed(seed);
    this.assertNativeMutationSession({
      id: parsedSeed.nativeSessionId,
      workspaceKey: parsedSeed.workspaceKey,
      fence: parsedSeed.leaseFence,
    });
    this.assertMutationLease(lease, now);
    return this.db
      .transaction(() => {
        this.assertNativeMutationLeaseSubject(parsedSeed, lease);
        this.assertNativeMutationLeaseCurrentInTransaction(lease, now);
        validateNativeSessionId(parsedSeed.nativeSessionId);
        if (parsedSeed.leaseFence !== String(lease.fence)) throw new MutationLeaseStaleError();
        const saga = this.getEditSaga(parsedSeed.sagaId);
        const step = saga.steps[parsedSeed.ordinal - 1];
        const workspacePath = this.getMutationWorkspacePath(saga.taskId, saga.turnId, saga.rootId);
        const expected =
          step === undefined || workspacePath === null
            ? null
            : expectedNativeMutationBinding(
                step.operation,
                parsedSeed.direction,
                workspacePath,
                step.postObservation,
              );
        if (
          step === undefined ||
          expected === null ||
          expected.kind !== parsedSeed.kind ||
          JSON.stringify(expected.artifact) !== JSON.stringify(parsedSeed.artifact) ||
          JSON.stringify(expected.sourceSegments) !== JSON.stringify(parsedSeed.sourceSegments) ||
          JSON.stringify(expected.destinationSegments) !==
            JSON.stringify(parsedSeed.destinationSegments) ||
          !nativeExpectationMatchesBinding(parsedSeed.expectedSource, expected.expectedSource) ||
          parsedSeed.expectedDestination.state !== 'absent' ||
          nativeMutationOperationDigest(step.operation) !== parsedSeed.operationDigest ||
          saga.workspaceKey !== parsedSeed.workspaceKey ||
          saga.rootIdentityDigest !== parsedSeed.rootIdentityDigest
        )
          throw new MutationLeaseStaleError();
        const existing = this.db
          .prepare(
            `SELECT * FROM native_mutation_intents
           WHERE saga_id = ? AND ordinal = ? AND direction = ?`,
          )
          .get(parsedSeed.sagaId, parsedSeed.ordinal, parsedSeed.direction) as
          NativeMutationIntentRow | undefined;
        if (existing !== undefined) {
          const snapshot = toNativeMutationIntent(existing);
          if (snapshot.seedDigest !== parsedSeed.seedDigest)
            throw new OperationConflictError('Native mutation intent key was reused');
          return snapshot;
        }
        const readyForNewIntent = nativeMutationStepIsNext(
          saga,
          parsedSeed.ordinal,
          parsedSeed.direction,
          coordinator,
        );
        if (!readyForNewIntent) throw new MutationLeaseStaleError();
        const snapshot = createNativeMutationIntentSnapshot(parsedSeed);
        this.db
          .prepare(
            `INSERT INTO native_mutation_intents(
            id, saga_id, ordinal, direction, operation_digest, workspace_key,
            root_identity_digest, policy_epoch, lease_fence, native_session_id,
            seed_digest, intent_digest, record_digest, auxiliary_key, state, revision,
            snapshot_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshot.id,
            snapshot.sagaId,
            snapshot.ordinal,
            snapshot.direction,
            snapshot.operationDigest,
            snapshot.workspaceKey,
            snapshot.rootIdentityDigest,
            snapshot.policyEpoch,
            snapshot.leaseFence,
            snapshot.nativeSessionId,
            snapshot.seedDigest,
            snapshot.intentDigest,
            snapshot.recordDigest,
            nativeMutationAuxiliaryKey(snapshot),
            snapshot.state,
            snapshot.revision,
            JSON.stringify(snapshot),
            snapshot.createdAt,
            snapshot.updatedAt,
          );
        return snapshot;
      })
      .immediate();
  }

  getNativeMutationIntent(id: string): NativeMutationIntentSnapshot {
    const row = this.db.prepare('SELECT * FROM native_mutation_intents WHERE id = ?').get(id) as
      NativeMutationIntentRow | undefined;
    if (row === undefined) throw new NotFoundError('Native mutation intent not found');
    return toNativeMutationIntent(row);
  }

  bindNativeMutationIntentRecovery(
    id: string,
    expectedRevision: number,
    lease: MutationLeaseToken,
    nativeSessionId: string,
    now: string,
  ): NativeMutationRecoveryBinding {
    validateMutationToken(lease);
    validateMutationTimestamp(now, 'Native mutation recovery binding time');
    validateNativeSessionId(nativeSessionId);
    if (lease.purpose !== 'recovery') throw new MutationLeaseStaleError();
    this.assertMutationLease(lease, now);
    this.assertNativeMutationSession({
      id: nativeSessionId,
      workspaceKey: lease.workspaceKey,
      fence: String(lease.fence),
    });
    return this.db
      .transaction(() => {
        const intent = this.getNativeMutationIntent(id);
        if (intent.revision !== expectedRevision || intent.state === 'completed')
          throw new OperationConflictError('Native mutation intent cannot be rebound');
        this.assertNativeMutationLeaseSubject(intent, lease);
        this.assertNativeMutationLeaseCurrentInTransaction(lease, now);
        const existing = this.db
          .prepare(
            `SELECT * FROM native_mutation_recovery_bindings
             WHERE intent_id = ? AND lease_id = ? AND native_session_id = ?`,
          )
          .get(id, lease.leaseId, nativeSessionId) as NativeMutationRecoveryBindingRow | undefined;
        if (existing !== undefined) return toNativeMutationRecoveryBinding(existing);
        const attempt = this.db
          .prepare(
            'SELECT COALESCE(MAX(attempt), 0) + 1 FROM native_mutation_recovery_bindings WHERE intent_id = ?',
          )
          .pluck()
          .get(id) as number;
        const facts = {
          version: 1 as const,
          intentId: id,
          attempt,
          intentDigest: intent.intentDigest,
          leaseId: lease.leaseId,
          leaseFence: String(lease.fence),
          nativeSessionId,
          createdAt: now,
        };
        const binding = Object.freeze({
          ...facts,
          bindingDigest: digestJson(facts),
        });
        this.db
          .prepare(
            `INSERT INTO native_mutation_recovery_bindings(
               intent_id, attempt, intent_digest, lease_id, lease_fence,
               native_session_id, binding_digest, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            binding.intentId,
            binding.attempt,
            binding.intentDigest,
            binding.leaseId,
            binding.leaseFence,
            binding.nativeSessionId,
            binding.bindingDigest,
            binding.createdAt,
          );
        return binding;
      })
      .immediate();
  }

  updateNativeMutationIntent(
    id: string,
    expectedRevision: number,
    lease: MutationLeaseToken,
    now: string,
    nativeSessionId: string,
    transition: NativeMutationIntentTransition,
    coordinator: NativeMutationSagaCoordinator = 'native-intent',
  ): NativeMutationIntentSnapshot {
    validateNativeMutationSagaCoordinator(coordinator);
    validateMutationToken(lease);
    validateMutationTimestamp(now, 'Native mutation intent update time');
    validateNativeSessionId(nativeSessionId);
    this.assertNativeMutationSession({
      id: nativeSessionId,
      workspaceKey: lease.workspaceKey,
      fence: String(lease.fence),
    });
    this.assertMutationLease(lease, now);
    return this.db
      .transaction(() => {
        const current = this.getNativeMutationIntent(id);
        this.assertNativeMutationLeaseBinding(current, lease, nativeSessionId);
        if (
          current.revision === expectedRevision + 1 &&
          nativeMutationTransitionAlreadyApplied(current, transition)
        )
          return current;
        if (current.revision !== expectedRevision)
          throw new OperationConflictError('Stale Native mutation intent revision');
        const next = transitionNativeMutationIntent(current, transition, now);
        if (next.state === 'effect_pending' && coordinator === 'native-intent')
          this.markEditSagaStepEffectPending(
            current.sagaId,
            current.ordinal,
            current.direction,
            lease,
          );
        if (
          next.state === 'effect_observed' &&
          next.effectObservation !== null &&
          coordinator === 'native-intent'
        )
          this.markEditSagaStepEffectObserved(
            current.sagaId,
            current.ordinal,
            current.direction,
            nativeIntentSagaObservation(current, next.effectObservation),
            lease,
          );
        const changes = this.db
          .prepare(
            `UPDATE native_mutation_intents SET state = ?, revision = ?, record_digest = ?,
             snapshot_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
          )
          .run(
            next.state,
            next.revision,
            next.recordDigest,
            JSON.stringify(next),
            next.updatedAt,
            id,
            expectedRevision,
          ).changes;
        if (changes !== 1)
          throw new OperationConflictError('Stale Native mutation intent revision');
        return next;
      })
      .immediate();
  }

  listRecoverableNativeMutationIntents(): readonly NativeMutationIntentSnapshot[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM native_mutation_intents
           WHERE state != 'completed'
           ORDER BY created_at, id`,
        )
        .all() as NativeMutationIntentRow[]
    ).map(toNativeMutationIntent);
  }

  private assertNativeMutationLeaseSubject(
    intent: Pick<
      NativeMutationIntentSeed,
      'sagaId' | 'workspaceKey' | 'rootIdentityDigest' | 'policyEpoch'
    >,
    lease: MutationLeaseToken,
  ): void {
    if (
      intent.sagaId !== lease.sagaId ||
      intent.workspaceKey !== lease.workspaceKey ||
      intent.rootIdentityDigest !== lease.rootIdentityDigest ||
      intent.policyEpoch !== lease.policyEpoch ||
      this.getPermissionPolicy(lease.taskId).policyEpoch !== lease.policyEpoch
    )
      throw new MutationLeaseStaleError();
  }

  private assertNativeMutationSession(binding: {
    id: string;
    workspaceKey: string;
    fence: string;
  }): void {
    if (this.nativeMutationAuthorityDisabled) throw new MutationLeaseStaleError();
    this.verifyNativeSession(binding);
  }

  private assertNativeMutationLeaseBinding(
    intent: NativeMutationIntentSnapshot,
    lease: MutationLeaseToken,
    nativeSessionId = intent.nativeSessionId,
  ): void {
    const row = this.getMutationRow(lease.workspaceKey);
    if (!mutationTokenMatchesRow(lease, row)) throw new MutationLeaseStaleError();
    this.assertNativeMutationLeaseSubject(intent, lease);
    if (intent.leaseFence === String(lease.fence) && intent.nativeSessionId === nativeSessionId)
      return;
    const recovery = this.db
      .prepare(
        `SELECT * FROM native_mutation_recovery_bindings
         WHERE intent_id = ? AND lease_id = ? AND lease_fence = ? AND native_session_id = ?
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(intent.id, lease.leaseId, String(lease.fence), nativeSessionId) as
      NativeMutationRecoveryBindingRow | undefined;
    if (
      recovery === undefined ||
      toNativeMutationRecoveryBinding(recovery).intentDigest !== intent.intentDigest
    )
      throw new MutationLeaseStaleError();
  }

  private assertNativeMutationLeaseCurrentInTransaction(
    lease: MutationLeaseToken,
    now: string,
  ): void {
    const row = this.getMutationRow(lease.workspaceKey);
    const nowMs = Date.parse(now);
    if (
      !mutationTokenMatchesRow(lease, row) ||
      row.expires_at === null ||
      nowMs < Date.parse(row.last_observed_at) ||
      nowMs >= Date.parse(row.expires_at) ||
      this.getPermissionPolicy(lease.taskId).policyEpoch !== lease.policyEpoch
    )
      throw new MutationLeaseStaleError();
  }

  private markEditSagaStepEffectPending(
    sagaId: string,
    ordinal: number,
    direction: NativeMutationIntentSnapshot['direction'],
    lease: MutationLeaseToken,
  ): void {
    const current = this.getEditSaga(sagaId);
    const step = current.steps[ordinal - 1];
    const expectedState = direction === 'forward' ? 'pending' : 'effect_observed';
    if (step === undefined || step.state !== expectedState) throw new MutationLeaseStaleError();
    const next = transitionEditSagaSnapshot(current, (snapshot) => ({
      ...withoutEditSagaRevision(snapshot),
      state: direction === 'forward' ? 'applying' : 'compensating',
      steps: snapshot.steps.map((candidate) =>
        candidate.ordinal === ordinal
          ? {
              ...candidate,
              state:
                direction === 'forward'
                  ? ('effect_pending' as const)
                  : ('compensation_pending' as const),
            }
          : candidate,
      ),
      updatedAt: nextPersistenceTimestamp(snapshot.updatedAt),
    }));
    const changes = this.db
      .prepare(
        `UPDATE edit_sagas SET state = ?, revision = ?, snapshot_json = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND workspace_key = ? AND root_identity_digest = ?`,
      )
      .run(
        next.state,
        next.revision,
        JSON.stringify(next),
        next.updatedAt,
        sagaId,
        current.revision,
        lease.workspaceKey,
        lease.rootIdentityDigest,
      ).changes;
    if (changes !== 1) throw new MutationLeaseStaleError();
  }

  private markEditSagaStepEffectObserved(
    sagaId: string,
    ordinal: number,
    direction: NativeMutationIntentSnapshot['direction'],
    observation: OperationObservation,
    lease: MutationLeaseToken,
  ): void {
    const current = this.getEditSaga(sagaId);
    const step = current.steps[ordinal - 1];
    const expectedState = direction === 'forward' ? 'effect_pending' : 'compensation_pending';
    if (step === undefined || step.state !== expectedState) throw new MutationLeaseStaleError();
    const next = transitionEditSagaSnapshot(current, (snapshot) => ({
      ...withoutEditSagaRevision(snapshot),
      state: direction === 'forward' ? 'applying' : 'compensating',
      steps: snapshot.steps.map((candidate) =>
        candidate.ordinal === ordinal
          ? direction === 'forward'
            ? { ...candidate, state: 'effect_observed' as const, postObservation: observation }
            : { ...candidate, state: 'restored' as const, restoredObservation: observation }
          : candidate,
      ),
      updatedAt: nextPersistenceTimestamp(snapshot.updatedAt),
    }));
    const changes = this.db
      .prepare(
        `UPDATE edit_sagas SET state = ?, revision = ?, snapshot_json = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND workspace_key = ? AND root_identity_digest = ?`,
      )
      .run(
        next.state,
        next.revision,
        JSON.stringify(next),
        next.updatedAt,
        sagaId,
        current.revision,
        lease.workspaceKey,
        lease.rootIdentityDigest,
      ).changes;
    if (changes !== 1) throw new MutationLeaseStaleError();
  }

  listMessages(taskId: string): ChatMessage[] {
    this.assertTask(taskId);
    const messages = this.db
      .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as MessageRow[];
    const attachmentRows = this.db
      .prepare(
        `SELECT id, message_id, file_name, mime_type, byte_length, created_at
         FROM image_attachments
         WHERE task_id = ? AND message_id IS NOT NULL AND state = 'message'
         ORDER BY message_id, message_ordinal`,
      )
      .all(taskId) as ImageAttachmentMetadataRow[];
    const attachmentsByMessage = new Map<string, ImageAttachmentMetadata[]>();
    for (const row of attachmentRows) {
      if (row.message_id === null) continue;
      const attachments = attachmentsByMessage.get(row.message_id) ?? [];
      attachments.push(toImageAttachmentMetadata(row));
      attachmentsByMessage.set(row.message_id, attachments);
    }
    return messages.map((row) =>
      toMessage(
        row,
        imageAttachmentMetadataListSchema.parse(attachmentsByMessage.get(row.id) ?? []),
      ),
    );
  }

  startTurn(
    taskId: string,
    text: string,
    skills: readonly PersistedTurnSkill[] = [],
    includeBuiltinTeamSkill = false,
    attachmentIds: readonly string[] = [],
    attachmentCapability?: ImageAttachmentCapabilityValidator | undefined,
  ): StartedTurn {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      this.assertTaskNotMutationQuarantined(taskId);
      if (this.getActiveTurnId(taskId) !== null) throw new TurnActiveError();
      return this.startTurnInTransaction(
        taskId,
        text,
        skills,
        includeBuiltinTeamSkill,
        attachmentIds,
        attachmentCapability,
      );
    })();
  }

  replaceActiveTurn(
    taskId: string,
    expectedActiveTurnId: string | null,
    text: string,
    skills: readonly PersistedTurnSkill[] = [],
    includeBuiltinTeamSkill = false,
  ): StopAndSendTransition {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      this.assertTaskNotMutationQuarantined(taskId);
      const activeTurnId = this.getActiveTurnId(taskId);
      if (activeTurnId !== expectedActiveTurnId)
        throw new Error('Active Turn changed before stop-and-send commit');
      const canceledEvent = activeTurnId === null ? null : this.cancelTurn(taskId, activeTurnId);
      const started = this.startTurnInTransaction(taskId, text, skills, includeBuiltinTeamSkill);
      return { canceledEvent, started };
    })();
  }

  getTurnModelIdentity(taskId: string, turnId: string): TurnModelIdentity {
    return toTurnModelIdentity(this.getTurn(taskId, turnId));
  }

  getTurnSkills(taskId: string, turnId: string): PersistedTurnSkill[] {
    this.getTurn(taskId, turnId);
    const rows = this.db
      .prepare(
        `SELECT source, skill_id, digest, kind, name, description, content, package_path
         FROM turn_skill_bindings
         WHERE turn_id = ?
         ORDER BY ordinal`,
      )
      .all(turnId) as TurnSkillBindingRow[];
    return rows.map((row) => ({
      selection: toTurnSkillSelection(row),
      name: row.name,
      description: row.description,
      content: row.content,
      packagePath: row.package_path,
    }));
  }

  recordSkillDraft(taskId: string, turnId: string, draft: SkillDraft): TurnEvent {
    this.getTurn(taskId, turnId);
    return this.appendEvent({ type: 'skill.draft.created', taskId, turnId, draft });
  }

  recordTurnResolution(
    taskId: string,
    turnId: string,
    resolution: ExecutionResolution,
  ): TurnModelIdentity {
    const parsed = executionResolutionSchema.parse(resolution);
    const result = this.db
      .prepare(
        `UPDATE turns
         SET resolved_provider = ?, resolved_model = ?, resolution_json = ?, updated_at = ?
         WHERE id = ? AND task_id = ?`,
      )
      .run(
        parsed.resolvedProvider,
        parsed.resolvedModel,
        JSON.stringify(parsed),
        new Date().toISOString(),
        turnId,
        taskId,
      );
    if (result.changes !== 1) throw new NotFoundError('Turn not found');
    return this.getTurnModelIdentity(taskId, turnId);
  }

  recordTurnProviderUsage(
    taskId: string,
    turnId: string,
    usage: NormalizedProviderUsage,
  ): NormalizedProviderUsage {
    const parsed = normalizedProviderUsageSchema.parse(usage);
    const result = this.db
      .prepare(
        `UPDATE turns SET provider_usage_json = ?, updated_at = ?
         WHERE id = ? AND task_id = ?`,
      )
      .run(JSON.stringify(parsed), new Date().toISOString(), turnId, taskId);
    if (result.changes !== 1) throw new NotFoundError('Turn not found');
    return parsed;
  }

  getTurnProviderUsage(taskId: string, turnId: string): NormalizedProviderUsage | null {
    const row = this.getTurn(taskId, turnId);
    return row.provider_usage_json === null
      ? null
      : normalizedProviderUsageSchema.parse(JSON.parse(row.provider_usage_json));
  }

  queueInput(
    taskId: string,
    text: string,
    operationId: string,
    skills: readonly PersistedTurnSkill[] = [],
    includeBuiltinTeamSkill = false,
  ): { ordinal: number; event: TurnEvent } {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      if (typeof text !== 'string' || text.trim() === '' || text.length > 100_000)
        throw new Error('Queued input text is invalid');
      const parsedSkills = validatePersistedTurnSkills(skills);
      const payloadJson = JSON.stringify({ text, skills: parsedSkills, includeBuiltinTeamSkill });
      const payloadDigest = sha256(payloadJson);
      const row = this.db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM input_queue WHERE task_id = ?',
        )
        .get(taskId) as { ordinal: number };
      this.db
        .prepare(
          `INSERT INTO input_queue(
            task_id, ordinal, operation_id, mode, payload_json, state, created_at, payload_digest
          ) VALUES (?, ?, ?, 'queue', ?, 'queued', ?, ?)`,
        )
        .run(
          taskId,
          row.ordinal,
          operationId,
          payloadJson,
          new Date().toISOString(),
          payloadDigest,
        );
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
      this.assertTaskNotMutationQuarantined(taskId);
      if (this.getActiveTurnId(taskId) !== null) return null;
      const row = this.db
        .prepare(
          `SELECT ordinal, operation_id, payload_json, payload_digest FROM input_queue
        WHERE task_id = ? AND state = 'queued' ORDER BY ordinal LIMIT 1`,
        )
        .get(taskId) as QueueRow | undefined;
      if (row === undefined) return null;
      const payloadDigest = sha256(row.payload_json);
      if (row.payload_digest !== '' && !timingSafeDigestEqual(row.payload_digest, payloadDigest))
        throw new Error('Queued input payload integrity check failed');
      const parsed = parseQueuedPayload(row.payload_json);
      const started = this.startTurnInTransaction(
        taskId,
        parsed.text,
        parsed.skills,
        parsed.includeBuiltinTeamSkill,
      );
      const dequeued = this.db
        .prepare(
          `UPDATE input_queue SET state = 'dequeued', payload_digest = ?
           WHERE task_id = ? AND ordinal = ? AND operation_id = ? AND state = 'queued'
             AND (payload_digest = ? OR payload_digest = '')`,
        )
        .run(payloadDigest, taskId, row.ordinal, row.operation_id, row.payload_digest);
      if (dequeued.changes !== 1)
        throw new Error('Queued input changed before conditional dequeue');
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
    finalText?: string,
  ): TurnEvent {
    return this.db.transaction(() =>
      this.completeTurnInTransaction(taskId, turnId, state, finalText),
    )();
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
    const latestCompletedTurn = this.db
      .prepare(
        `SELECT id FROM turns
         WHERE task_id = ? AND state IN ('completed', 'canceled', 'failed', 'interrupted')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId) as { id: string } | undefined;
    return turnSnapshotSchema.parse({
      lastSeq,
      activeTurn,
      queued: this.listQueued(taskId),
      contextUsage,
      pendingApprovals: this.listPendingApprovals(taskId).map(toApprovalSummary),
      latestTurnDiff:
        latestCompletedTurn === undefined
          ? null
          : {
              turnId: latestCompletedTurn.id,
              entries: this.getTurnDiff(taskId, latestCompletedTurn.id),
            },
    });
  }

  prepareContext(taskId: string, turnId: string): PreparedContext {
    return this.db.transaction(() => {
      this.getTurn(taskId, turnId);
      const existing = this.contextSealRow('turn', turnId);
      if (existing !== undefined) return this.preparedContextFromSeal(existing);
      // Compatibility for a Turn that was already active while a v55 database upgraded. New Turns
      // are sealed inside startTurnInTransaction; this one-time path cannot recreate that past
      // transaction boundary, but it still freezes the first post-upgrade observation permanently.
      const prepared = this.assembleContextInTransaction(taskId, turnId);
      this.createContextSealInTransaction('turn', turnId, taskId, prepared);
      return { ...prepared, usageEvents: [] };
    })();
  }

  getContextSealManifest(ownerType: ContextSealOwnerType, ownerId: string): ContextSealManifest {
    const row = this.contextSealRow(ownerType, ownerId);
    if (row === undefined) throw new NotFoundError('Context seal not found');
    return this.contextSealManifestFromRow(row);
  }

  listProjectContextManifests(taskId: string): ProjectContextManifestSummary[] {
    this.assertTask(taskId);
    const rows = this.db
      .prepare(
        `SELECT * FROM context_seals
         WHERE owner_type = 'turn' AND task_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(taskId) as ContextSealRow[];
    return rows.map((row) => ({
      turnId: row.owner_id,
      projectId: row.project_id,
      projectContextEpoch: row.project_context_epoch,
      candidateSnapshotDigest: row.candidate_snapshot_digest,
      sealedDigest: row.sealed_digest,
      createdAt: row.created_at,
    }));
  }

  getProjectContextManifest(taskId: string, turnId: string): PublicProjectContextManifest {
    this.getTurn(taskId, turnId);
    const row = this.contextSealRow('turn', turnId);
    if (row === undefined || row.task_id !== taskId)
      throw new NotFoundError('Context seal not found');
    const manifest = this.contextSealManifestFromRow(row);
    return {
      sealId: manifest.sealId,
      turnId,
      taskId,
      projectId: manifest.projectId,
      projectRevision: manifest.projectRevision,
      projectContextEpoch: manifest.projectContextEpoch,
      candidateSnapshotDigest: manifest.candidateSnapshotDigest,
      sealedDigest: manifest.sealedDigest,
      compacted: manifest.compacted,
      createdAt: manifest.createdAt,
      items: [...manifest.items],
    };
  }

  sealTeamExecutionContext(input: {
    taskId: string;
    executionId: string;
    parentOwner?: { type: ContextSealOwnerType; id: string };
  }): ContextSealManifest {
    return this.db.transaction(() => {
      const existing = this.contextSealRow('team_execution', input.executionId);
      if (existing !== undefined) return this.contextSealManifestFromRow(existing);
      const executionTask = this.db
        .prepare(
          `SELECT t.task_id FROM team_executions e
           JOIN teams t ON t.id = e.team_id
           WHERE e.id = ?`,
        )
        .get(input.executionId) as { task_id: string } | undefined;
      if (executionTask === undefined) throw new NotFoundError('Team execution not found');
      if (executionTask.task_id !== input.taskId)
        throw new Error('Team execution does not belong to Task');
      if (input.parentOwner !== undefined) {
        const parent = this.contextSealRow(input.parentOwner.type, input.parentOwner.id);
        if (parent === undefined) throw new NotFoundError('Parent context seal not found');
        if (parent.task_id !== input.taskId)
          throw new Error('Parent context seal belongs to another Task');
        return this.cloneContextSealInTransaction(parent, input.executionId);
      }
      return this.createContextSealInTransaction(
        'team_execution',
        input.executionId,
        input.taskId,
        this.assembleManualTeamContextSnapshot(input.taskId, input.executionId),
      );
    })();
  }

  prepareTeamExecutionContext(taskId: string, executionId: string): PreparedContext {
    const manifest = this.sealTeamExecutionContext({ taskId, executionId });
    const seal = this.contextSealRow('team_execution', manifest.ownerId);
    if (seal === undefined) throw new NotFoundError('Team execution context seal not found');
    return this.preparedContextFromSeal(seal);
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

  prepareUserFileSaveIntent(intent: Omit<UserFileSaveIntent, 'state'>): UserFileSaveIntent {
    return this.db
      .transaction(() => {
        this.assertTask(intent.taskId);
        const existing = this.db
          .prepare(
            `SELECT * FROM user_file_save_intents
             WHERE principal = ? AND task_id = ? AND kind = ? AND operation_id = ?`,
          )
          .get(intent.principal, intent.taskId, intent.kind, intent.operationId) as
          UserFileSaveIntentRow | undefined;
        if (existing !== undefined) {
          const snapshot = toUserFileSaveIntent(existing);
          if (JSON.stringify(withoutUserFileSaveState(snapshot)) !== JSON.stringify(intent))
            throw new OperationConflictError('User file save operation was reused');
          return snapshot;
        }
        const matchingFacts = this.db
          .prepare(
            `SELECT * FROM user_file_save_intents
             WHERE principal = ? AND task_id = ? AND kind = ? AND request_hash = ?
               AND root_id = ? AND path = ? AND base_digest = ? AND replacement_digest = ?`,
          )
          .get(
            intent.principal,
            intent.taskId,
            intent.kind,
            intent.requestHash,
            intent.rootId,
            intent.path,
            intent.baseDigest,
            intent.replacementDigest,
          ) as UserFileSaveIntentRow | undefined;
        if (matchingFacts !== undefined) return toUserFileSaveIntent(matchingFacts);
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO user_file_save_intents(
               principal, task_id, kind, operation_id, request_hash, root_id, root_label, path,
               base_digest, replacement_digest, byte_length, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
          )
          .run(
            intent.principal,
            intent.taskId,
            intent.kind,
            intent.operationId,
            intent.requestHash,
            intent.rootId,
            intent.rootLabel,
            intent.path,
            intent.baseDigest,
            intent.replacementDigest,
            intent.byteLength,
            now,
            now,
          );
        return { ...intent, state: 'prepared' as const };
      })
      .immediate();
  }

  listRecoverableUserFileSaveIntents(): readonly UserFileSaveIntent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM user_file_save_intents
           WHERE state IN ('prepared', 'recovery_required') ORDER BY created_at, operation_id`,
        )
        .all() as UserFileSaveIntentRow[]
    ).map(toUserFileSaveIntent);
  }

  finalizeUserFileSaveIntent(
    intent: UserFileSaveIntent,
    result: SaveOutcome,
  ): { result: SaveOutcome; event: TurnEvent | null } {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            `SELECT * FROM user_file_save_intents
             WHERE principal = ? AND task_id = ? AND kind = ? AND operation_id = ?`,
          )
          .get(intent.principal, intent.taskId, intent.kind, intent.operationId) as
          UserFileSaveIntentRow | undefined;
        if (row === undefined) throw new NotFoundError('User file save intent not found');
        const current = toUserFileSaveIntent(row);
        if (
          JSON.stringify(withoutUserFileSaveState(current)) !==
          JSON.stringify(withoutUserFileSaveState(intent))
        )
          throw new OperationConflictError('User file save intent changed');
        if (current.state === 'completed') {
          const cached = this.getOperationResult<SaveOutcome>(
            current.principal,
            current.taskId,
            current.kind,
            current.operationId,
            current.requestHash,
          );
          return { result: cached.value as SaveOutcome, event: null };
        }
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO operations(
               principal, task_id, kind, operation_id, request_hash, state, result_json,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
          )
          .run(
            current.principal,
            current.taskId,
            current.kind,
            current.operationId,
            current.requestHash,
            JSON.stringify({ value: result }),
            now,
            now,
          );
        const event =
          result.outcome === 'saved'
            ? this.recordUserFileSave({
                taskId: current.taskId,
                rootId: current.rootId,
                rootLabel: current.rootLabel,
                path: current.path,
                byteLength: current.byteLength,
              })
            : null;
        this.db
          .prepare(
            `UPDATE user_file_save_intents SET state = 'completed', updated_at = ?
             WHERE principal = ? AND task_id = ? AND kind = ? AND operation_id = ?`,
          )
          .run(now, current.principal, current.taskId, current.kind, current.operationId);
        return { result, event };
      })
      .immediate();
  }

  requireUserFileSaveRecovery(intent: UserFileSaveIntent): void {
    this.db
      .prepare(
        `UPDATE user_file_save_intents SET state = 'recovery_required', updated_at = ?
         WHERE principal = ? AND task_id = ? AND kind = ? AND operation_id = ?
           AND state != 'completed'`,
      )
      .run(
        new Date().toISOString(),
        intent.principal,
        intent.taskId,
        intent.kind,
        intent.operationId,
      );
  }

  /**
   * Takes custody of a generated image, in the same transaction as the Turn event that announces it.
   *
   * Rejects anything that is not a PNG by magic bytes — the file came from a directory the CLI owns,
   * not from a path this app chose, so its contents are the only thing worth trusting. Returns null
   * for a duplicate (same content digest already stored), so re-running a Turn cannot pile up copies
   * or emit a second event for the same image.
   */
  recordGeneratedImage(input: {
    taskId: string;
    turnId: string;
    bytes: Buffer;
  }): { event: TurnEvent; image: GeneratedImage } | null {
    if (!isPngBuffer(input.bytes)) return null;
    if (input.bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) return null;
    const id = createHash('sha256').update(input.bytes).digest('hex');
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT 1 FROM generated_images WHERE id = ?')
        .get(id) as unknown;
      if (existing !== undefined) return null;
      const now = new Date().toISOString();
      const image = generatedImageSchema.parse({
        id,
        taskId: input.taskId,
        turnId: input.turnId,
        mimeType: 'image/png',
        byteLength: input.bytes.byteLength,
        createdAt: now,
      });
      this.db
        .prepare(
          `INSERT INTO generated_images(id, task_id, turn_id, mime_type, byte_length, bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          image.id,
          image.taskId,
          image.turnId,
          image.mimeType,
          image.byteLength,
          input.bytes,
          now,
        );
      const event = this.appendEvent({
        type: 'image.generated',
        taskId: input.taskId,
        turnId: input.turnId,
        image,
      });
      return { event, image };
    })();
  }

  /**
   * Appends one `files.changed` event for a Runtime tool call that wrote files (issue #37).
   *
   * No side table: unlike a generated image there are no bytes to take custody of, and the event
   * stream already is the durable record. Keeping it there means a reopened Task replays the edits
   * in the order they happened for free, and there is no second store to keep consistent with it.
   *
   * Paths are expected to be workspace-relative and already validated by the caller — this is the
   * persistence boundary, not the place that decides what is inside the Workspace.
   */
  recordFileChanges(input: {
    taskId: string;
    turnId: string;
    changes: FileChange[];
  }): TurnEvent | null {
    const changes = input.changes.slice(0, 200);
    if (changes.length === 0) return null;
    return this.appendEvent({
      type: 'files.changed',
      taskId: input.taskId,
      turnId: input.turnId,
      changes,
    });
  }

  /**
   * Appends the audit record for a save the user made themselves (issue #43).
   *
   * A separate event type from `files.changed`, which is the record of what a Runtime did. Folding a
   * human's edit into it would make the timeline assert that the model wrote something it did not,
   * and the timeline is read as a record of fact.
   */
  recordUserFileSave(input: {
    taskId: string;
    rootId: string;
    rootLabel: string;
    path: string;
    byteLength: number;
  }): TurnEvent {
    return this.appendEvent({
      type: 'file.saved',
      taskId: input.taskId,
      rootId: input.rootId,
      rootLabel: input.rootLabel,
      path: input.path,
      byteLength: input.byteLength,
    });
  }

  /**
   * Every `files.changed` event recorded for this Task, oldest first.
   *
   * Read back out of `turn_events` rather than from a side table: the event stream is already the
   * record, and a second store would be one more thing that can disagree with it. The payload was
   * validated on the way in, so a row that no longer parses means the database was edited outside
   * the app — dropped rather than thrown on, so one bad row cannot make a Task unopenable.
   */
  listFileChanges(taskId: string): FileChangeRecord[] {
    this.assertTask(taskId);
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM turn_events WHERE task_id = ? AND type = 'files.changed' ORDER BY seq",
      )
      .all(taskId) as { payload_json: string }[];
    const records: FileChangeRecord[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const event = turnEventSchema.safeParse(parsed);
      if (!event.success || event.data.type !== 'files.changed') continue;
      records.push({ seq: event.data.seq, turnId: event.data.turnId, changes: event.data.changes });
    }
    return records;
  }

  listGeneratedImages(taskId: string): GeneratedImage[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, turn_id, mime_type, byte_length, created_at FROM generated_images
         WHERE task_id = ? ORDER BY created_at, id`,
      )
      .all(taskId) as GeneratedImageRow[];
    return rows.map(toGeneratedImage);
  }

  readGeneratedImage(imageId: string): { image: GeneratedImage; bytes: Buffer } | null {
    const row = this.db.prepare('SELECT * FROM generated_images WHERE id = ?').get(imageId) as
      (GeneratedImageRow & { bytes: Buffer }) | undefined;
    if (row === undefined) return null;
    return { image: toGeneratedImage(row), bytes: row.bytes };
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
        this.completeTurnAndFinishGoal(turn.task_id, turn.id, 'interrupted');
      return turns.length;
    })();
  }

  close(): void {
    this.db.close();
  }

  private assembleContextInTransaction(
    taskId: string,
    turnId: string,
    includeBuiltinTeamSkill = false,
    reservedTokens = 0,
  ): PreparedContext {
    const prePrompt = this.getSprintCoderPrePrompt();
    const prePromptContent = sprintCoderPrePromptContent(prePrompt);
    const prePromptFragment: ContextFragment | null =
      prePrompt === ''
        ? null
        : {
            id: `settings:sprint-coder-pre-prompt:${sha256(prePrompt)}`,
            taskId,
            source: 'system',
            trust: 'system',
            tokenEstimate: estimateTokens(prePromptContent),
            content: prePromptContent,
            createdAt: new Date().toISOString(),
            messageId: null,
          };
    const skillFragments: ContextFragment[] = this.getTurnSkills(taskId, turnId).map((skill) => {
      const trust = skill.selection.ref.source === 'builtin' ? 'system' : 'user';
      const id = `skill:${sha256(
        `${skill.selection.ref.source}:${skill.selection.ref.skillId}:${skill.selection.ref.digest}`,
      )}`;
      return {
        id,
        taskId,
        source: 'skill',
        trust,
        tokenEstimate: estimateTokens(skill.content),
        content: skill.content,
        createdAt: new Date().toISOString(),
        messageId: null,
      };
    });
    if (includeBuiltinTeamSkill) {
      skillFragments.push({
        id: BUILTIN_TEAM_SKILL_FRAGMENT_ID,
        taskId,
        source: 'system',
        trust: 'system',
        tokenEstimate: estimateTokens(BUILTIN_TEAM_SKILL_CONTENT),
        content: BUILTIN_TEAM_SKILL_CONTENT,
        createdAt: new Date().toISOString(),
        messageId: null,
      });
    }
    const prepared = this.contextLedger.prepare(
      taskId,
      turnId,
      reservedTokens +
        (prePromptFragment?.tokenEstimate ?? 0) +
        skillFragments.reduce((total, fragment) => total + fragment.tokenEstimate, 0),
    );
    if (skillFragments.length === 0 && prePromptFragment === null) return prepared;
    const [systemFragment, ...remainingFragments] = prepared.fragments;
    const fragments = [
      ...(systemFragment === undefined ? [] : [systemFragment]),
      ...(prePromptFragment === null ? [] : [prePromptFragment]),
      ...remainingFragments,
      ...skillFragments,
    ];
    return {
      ...prepared,
      fragments,
      usageEvents: [
        ...prepared.usageEvents,
        this.recordContextUsage(taskId, turnId, aggregateContextUsage(fragments)),
      ],
    };
  }

  private assembleManualTeamContextSnapshot(taskId: string, executionId: string): PreparedContext {
    const task = this.getTaskRow(taskId);
    const createdAt = new Date().toISOString();
    const prePrompt = this.getSprintCoderPrePrompt();
    const prePromptContent = sprintCoderPrePromptContent(prePrompt);
    const rows = this.db
      .prepare(
        `SELECT id, author, content, created_at
         FROM messages
         WHERE task_id = ? AND author IN ('user', 'assistant')
         ORDER BY created_at DESC, rowid DESC
         LIMIT 128`,
      )
      .all(taskId) as Pick<MessageRow, 'id' | 'author' | 'content' | 'created_at'>[];
    const fragments: ContextFragment[] = [
      {
        id: `team-execution:${executionId}:system`,
        taskId,
        source: 'system',
        trust: 'system',
        tokenEstimate: estimateTokens(CONTEXT_SYSTEM_PROMPT),
        content: CONTEXT_SYSTEM_PROMPT,
        createdAt,
        messageId: null,
      },
      ...(prePrompt === ''
        ? []
        : [
            {
              id: `team-execution:${executionId}:pre-prompt`,
              taskId,
              source: 'system' as const,
              trust: 'system' as const,
              tokenEstimate: estimateTokens(prePromptContent),
              content: prePromptContent,
              createdAt,
              messageId: null,
            },
          ]),
      ...(task.goal === null || task.goal === ''
        ? []
        : [
            {
              id: `team-execution:${executionId}:goal`,
              taskId,
              source: 'goal' as const,
              trust: 'user' as const,
              tokenEstimate: estimateTokens(task.goal),
              content: task.goal,
              createdAt,
              messageId: null,
            },
          ]),
      ...rows.reverse().map((message) => ({
        id: `team-execution:${executionId}:message:${message.id}`,
        taskId,
        source: 'history' as const,
        trust: message.author,
        tokenEstimate: estimateTokens(message.content),
        content: message.content,
        createdAt: message.created_at,
        messageId: message.id,
      })),
    ];
    return {
      fragments,
      projectItems: [],
      projectSnapshotDigest: null,
      usageEvents: [],
      compacted: false,
    };
  }

  private createContextSealInTransaction(
    ownerType: ContextSealOwnerType,
    ownerId: string,
    taskId: string,
    prepared: PreparedContext,
  ): ContextSealManifest {
    const existing = this.contextSealRow(ownerType, ownerId);
    if (existing !== undefined) return this.contextSealManifestFromRow(existing);

    const task = this.getTaskRow(taskId);
    const project = task.project_id === null ? null : this.getProjectRow(task.project_id);
    const createdAt = new Date().toISOString();
    const items: ProjectContextManifestItem[] = [];
    let contextTokens = prepared.fragments.reduce(
      (total, fragment) => total + fragment.tokenEstimate,
      0,
    );
    if (project !== null && project.instruction !== '') {
      const digest = sha256(project.instruction);
      const included =
        contextTokens <= CONTEXT_HARD_CAP_TOKENS &&
        contextTokens + estimateTokens(project.instruction) <= CONTEXT_HARD_CAP_TOKENS;
      items.push({
        itemId: `project:${project.id}:instruction`,
        kind: 'instruction',
        sourceTaskId: null,
        sourceTurnId: null,
        sourceReferenceId: null,
        candidateDigest: digest,
        sealedDigest: included ? digest : null,
        included,
        exclusionReason: included
          ? null
          : contextTokens > CONTEXT_HARD_CAP_TOKENS
            ? 'existing_context_over_budget'
            : 'project_context_over_budget',
        authority: 'user',
        localOnly: false,
        content: included ? project.instruction : null,
        capturedAt: createdAt,
      });
      if (included) contextTokens += estimateTokens(project.instruction);
    }
    if (project !== null) {
      const memories = this.db
        .prepare(
          "SELECT * FROM project_memories WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC, id",
        )
        .all(project.id) as ProjectMemoryRow[];
      for (const memory of memories) {
        const digest = sha256(memory.content);
        const memoryTokens = estimateTokens(memory.content);
        const included =
          contextTokens <= CONTEXT_HARD_CAP_TOKENS &&
          contextTokens + memoryTokens <= CONTEXT_HARD_CAP_TOKENS;
        items.push({
          itemId: `project:${project.id}:memory:${memory.id}`,
          kind: 'memory',
          sourceTaskId: memory.source_task_id,
          sourceTurnId: memory.source_turn_id,
          sourceReferenceId: null,
          candidateDigest: digest,
          sealedDigest: included ? digest : null,
          included,
          exclusionReason: included
            ? null
            : contextTokens > CONTEXT_HARD_CAP_TOKENS
              ? 'existing_context_over_budget'
              : 'project_context_over_budget',
          authority: memory.created_by === 'user' ? 'user' : 'none',
          localOnly: memory.local_only === 1,
          content: included ? memory.content : null,
          capturedAt: createdAt,
        });
        if (included) contextTokens += memoryTokens;
      }
    }
    if (project !== null) {
      const references = this.db
        .prepare(
          'SELECT * FROM project_references WHERE project_id = ? AND enabled = 1 ORDER BY created_at, id',
        )
        .all(project.id) as ProjectReferenceRow[];
      for (const reference of references) {
        const referenceWorkspace = this.projectReferenceWorkspace(reference);
        const read = readProjectReference({
          workspacePath: referenceWorkspace.path,
          registeredRootIdentity: reference.registered_root_identity,
          relativePath: reference.relative_path,
        });
        const candidateDigest =
          read.digest ??
          sha256(
            JSON.stringify([
              reference.id,
              reference.relative_path,
              reference.registered_root_identity,
              read.status,
            ]),
          );
        const itemTokens = read.content === null ? 0 : estimateTokens(read.content);
        const readable = read.status === 'healthy' && read.content !== null && read.digest !== null;
        const included =
          readable &&
          contextTokens <= CONTEXT_HARD_CAP_TOKENS &&
          contextTokens + itemTokens <= CONTEXT_HARD_CAP_TOKENS;
        items.push({
          itemId: `project:${project.id}:reference:${reference.id}`,
          kind: 'reference',
          sourceTaskId: reference.source_task_id,
          sourceTurnId: null,
          sourceReferenceId: reference.id,
          candidateDigest,
          sealedDigest: included ? read.digest : null,
          included,
          exclusionReason: included
            ? null
            : !readable
              ? `reference_${read.status}`
              : contextTokens > CONTEXT_HARD_CAP_TOKENS
                ? 'existing_context_over_budget'
                : 'project_context_over_budget',
          authority: 'none',
          localOnly: referenceWorkspace.localOnly === 1,
          content: included ? read.content : null,
          capturedAt: createdAt,
        });
        if (included) contextTokens += itemTokens;
      }
    }
    if (ownerType === 'turn') {
      const projectTokens = items.reduce(
        (total, item) =>
          total + (item.included && item.content !== null ? estimateTokens(item.content) : 0),
        0,
      );
      const usageIndex = prepared.usageEvents.length - 1;
      const currentUsageEvent = prepared.usageEvents[usageIndex];
      if (currentUsageEvent?.type !== 'context.usage')
        throw new Error('Turn context assembly did not publish final usage');
      const finalUsageEvent = turnEventSchema.parse({
        ...currentUsageEvent,
        usage: aggregateContextUsage(prepared.fragments, projectTokens),
      });
      const updated = this.db
        .prepare(
          `UPDATE turn_events SET payload_json = ?
           WHERE task_id = ? AND seq = ? AND type = 'context.usage'`,
        )
        .run(JSON.stringify(finalUsageEvent), taskId, currentUsageEvent.seq);
      if (updated.changes !== 1) throw new Error('Final context usage event changed before seal');
      prepared.usageEvents[usageIndex] = finalUsageEvent;
    }
    const candidateSnapshotDigest = projectCandidateSnapshotDigest(project, items);
    const sealedDigest = sha256(
      JSON.stringify({
        fragments: prepared.fragments.map((fragment) => ({
          id: fragment.id,
          source: fragment.source,
          trust: fragment.trust,
          tokenEstimate: fragment.tokenEstimate,
          contentDigest: sha256(fragment.content),
        })),
        projectItems: items
          .filter((item) => item.included)
          .map((item) => ({
            itemId: item.itemId,
            sealedDigest: item.sealedDigest,
          })),
      }),
    );
    const sealId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO context_seals(
          id, owner_type, owner_id, task_id, project_id, project_revision,
          project_context_epoch, candidate_snapshot_digest, sealed_digest, compacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sealId,
        ownerType,
        ownerId,
        taskId,
        project?.id ?? null,
        project?.revision ?? null,
        project?.context_epoch ?? null,
        candidateSnapshotDigest,
        sealedDigest,
        prepared.compacted ? 1 : 0,
        createdAt,
      );
    const insertFragment = this.db.prepare(
      `INSERT INTO context_seal_fragments(
        seal_id, ordinal, fragment_id, source, trust, token_estimate, content, created_at, message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    prepared.fragments.forEach((fragment, index) =>
      insertFragment.run(
        sealId,
        index + 1,
        fragment.id,
        fragment.source,
        fragment.trust,
        fragment.tokenEstimate,
        fragment.content,
        fragment.createdAt,
        fragment.messageId,
      ),
    );
    const insertItem = this.db.prepare(
      `INSERT INTO project_context_manifest_items(
        seal_id, ordinal, item_id, kind, source_task_id, source_turn_id,
        source_reference_id, candidate_digest, sealed_digest, included, exclusion_reason,
        authority, local_only, content, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item, index) =>
      insertItem.run(
        sealId,
        index + 1,
        item.itemId,
        item.kind,
        item.sourceTaskId,
        item.sourceTurnId,
        item.sourceReferenceId,
        item.candidateDigest,
        item.sealedDigest,
        item.included ? 1 : 0,
        item.exclusionReason,
        item.authority,
        item.localOnly ? 1 : 0,
        item.content,
        item.capturedAt,
      ),
    );
    for (const item of items) {
      if (!item.included || item.kind !== 'reference' || item.sourceReferenceId === null) continue;
      this.db
        .prepare('UPDATE project_references SET last_sealed_digest = ? WHERE id = ?')
        .run(item.sealedDigest, item.sourceReferenceId);
    }
    return this.contextSealManifestFromRow(this.contextSealRow(ownerType, ownerId)!);
  }

  private contextSealRow(
    ownerType: ContextSealOwnerType,
    ownerId: string,
  ): ContextSealRow | undefined {
    return this.db
      .prepare('SELECT * FROM context_seals WHERE owner_type = ? AND owner_id = ?')
      .get(ownerType, ownerId) as ContextSealRow | undefined;
  }

  private cloneContextSealInTransaction(
    parent: ContextSealRow,
    executionId: string,
  ): ContextSealManifest {
    const sealId = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO context_seals(
          id, owner_type, owner_id, task_id, project_id, project_revision,
          project_context_epoch, candidate_snapshot_digest, sealed_digest, compacted, created_at
        ) VALUES (?, 'team_execution', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sealId,
        executionId,
        parent.task_id,
        parent.project_id,
        parent.project_revision,
        parent.project_context_epoch,
        parent.candidate_snapshot_digest,
        parent.sealed_digest,
        parent.compacted,
        createdAt,
      );
    this.db
      .prepare(
        `INSERT INTO context_seal_fragments(
          seal_id, ordinal, fragment_id, source, trust, token_estimate, content, created_at,
          message_id
        )
        SELECT ?, ordinal, fragment_id, source, trust, token_estimate, content, created_at,
               message_id
        FROM context_seal_fragments WHERE seal_id = ? ORDER BY ordinal`,
      )
      .run(sealId, parent.id);
    this.db
      .prepare(
        `INSERT INTO project_context_manifest_items(
          seal_id, ordinal, item_id, kind, source_task_id, source_turn_id, source_reference_id,
          candidate_digest, sealed_digest, included, exclusion_reason, authority, local_only,
          content, captured_at
        )
        SELECT ?, ordinal, item_id, kind, source_task_id, source_turn_id, source_reference_id,
               candidate_digest, sealed_digest, included, exclusion_reason, authority, local_only,
               content, captured_at
        FROM project_context_manifest_items WHERE seal_id = ? ORDER BY ordinal`,
      )
      .run(sealId, parent.id);
    return this.contextSealManifestFromRow(this.contextSealRow('team_execution', executionId)!);
  }

  private preparedContextFromSeal(seal: ContextSealRow): PreparedContext {
    const rows = this.db
      .prepare('SELECT * FROM context_seal_fragments WHERE seal_id = ? ORDER BY ordinal')
      .all(seal.id) as ContextSealFragmentRow[];
    const itemRows = this.db
      .prepare(
        'SELECT * FROM project_context_manifest_items WHERE seal_id = ? AND included = 1 ORDER BY ordinal',
      )
      .all(seal.id) as ProjectContextManifestItemRow[];
    const projectItems: ProjectContextItem[] = itemRows.map((row) => {
      if (row.sealed_digest === null || row.content === null)
        throw new Error('Included Project context item is incomplete');
      return {
        id: row.item_id,
        kind: row.kind,
        authority: row.authority,
        localOnly: row.local_only === 1,
        content: row.content,
        sealedDigest: row.sealed_digest,
        sourceTaskId: row.source_task_id,
        sourceTurnId: row.source_turn_id,
        sourceReferenceId: row.source_reference_id,
        capturedAt: row.captured_at,
      };
    });
    return {
      fragments: rows.map((row) => ({
        id: row.fragment_id,
        taskId: seal.task_id,
        source: row.source,
        trust: row.trust,
        tokenEstimate: row.token_estimate,
        content: row.content,
        createdAt: row.created_at,
        messageId: row.message_id,
      })),
      projectItems,
      projectSnapshotDigest: seal.candidate_snapshot_digest,
      usageEvents: [],
      compacted: seal.compacted === 1,
    };
  }

  private contextSealManifestFromRow(seal: ContextSealRow): ContextSealManifest {
    const rows = this.db
      .prepare('SELECT * FROM project_context_manifest_items WHERE seal_id = ? ORDER BY ordinal')
      .all(seal.id) as ProjectContextManifestItemRow[];
    return {
      sealId: seal.id,
      ownerType: seal.owner_type,
      ownerId: seal.owner_id,
      taskId: seal.task_id,
      projectId: seal.project_id,
      projectRevision: seal.project_revision,
      projectContextEpoch: seal.project_context_epoch,
      candidateSnapshotDigest: seal.candidate_snapshot_digest,
      sealedDigest: seal.sealed_digest,
      compacted: seal.compacted === 1,
      createdAt: seal.created_at,
      items: rows.map((row) => ({
        itemId: row.item_id,
        kind: row.kind,
        sourceTaskId: row.source_task_id,
        sourceTurnId: row.source_turn_id,
        sourceReferenceId: row.source_reference_id,
        candidateDigest: row.candidate_digest,
        sealedDigest: row.sealed_digest,
        included: row.included === 1,
        exclusionReason: row.exclusion_reason,
        authority: row.authority,
        localOnly: row.local_only === 1,
        content: row.content,
        capturedAt: row.captured_at,
      })),
    };
  }

  private startTurnInTransaction(
    taskId: string,
    text: string,
    skills: readonly PersistedTurnSkill[] = [],
    includeBuiltinTeamSkill = false,
    attachmentIds: readonly string[] = [],
    attachmentCapability?: ImageAttachmentCapabilityValidator | undefined,
  ): StartedTurn {
    const now = new Date().toISOString();
    const turnId = randomUUID();
    const parsedSkills = validatePersistedTurnSkills(skills);
    const selection = this.getImageAttachmentAcceptanceSelection(taskId);
    const { runtimeKind, model, modelSelection } = selection;
    const acceptedAttachments = this.prepareAcceptedImageAttachments(
      taskId,
      attachmentIds,
      attachmentCapability,
      selection,
    );
    const shouldSealBuiltinTeamSkill =
      includeBuiltinTeamSkill ||
      isTeamScenarioInput(text) ||
      parsedSkills.some(({ selection }) => selection.kind === 'team') ||
      (isTeamContinuationInput(text) && this.latestTurnIncludedBuiltinTeamSkill(taskId)) ||
      (isExistingTeamFollowupInput(text) &&
        (this.latestTurnIncludedBuiltinTeamSkill(taskId) || this.getTeamByTask(taskId) !== null));
    const skillCatalogContent = this.skillCatalogContextProvider?.(
      parsedSkills.map(({ selection }) => selection),
      shouldSealBuiltinTeamSkill,
    );
    const userMessage = chatMessageSchema.parse({
      id: randomUUID(),
      taskId,
      turnId,
      author: 'user',
      content: text,
      attachments: acceptedAttachments.map(toImageAttachmentMetadata),
      createdAt: now,
    });
    this.db
      .prepare(
        'INSERT INTO messages(id, task_id, turn_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(userMessage.id, taskId, turnId, userMessage.author, userMessage.content, now);
    const bindAttachment = this.db.prepare(
      `UPDATE image_attachments
       SET state = 'message', message_id = ?, message_ordinal = ?
       WHERE id = ? AND task_id = ? AND state = 'draft'
         AND message_id IS NULL AND message_ordinal IS NULL`,
    );
    acceptedAttachments.forEach((attachment, ordinal) => {
      if (bindAttachment.run(userMessage.id, ordinal, attachment.id, taskId).changes !== 1)
        throw new ImageAttachmentAcceptanceError('stale');
    });
    this.db
      .prepare(
        `INSERT INTO turns(
          id, task_id, user_message_id, state, seq, runtime_kind, model,
          connection_id, requested_provider, requested_model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turnId,
        taskId,
        userMessage.id,
        'queued',
        runtimeKind,
        model,
        modelSelection.connectionId,
        modelSelection.requestedProvider,
        modelSelection.requestedModel,
        now,
        now,
      );
    const insertSkill = this.db.prepare(
      `INSERT INTO turn_skill_bindings(
         turn_id, ordinal, source, skill_id, digest, kind,
         name, description, content, package_path
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    parsedSkills.forEach((skill, index) =>
      insertSkill.run(
        turnId,
        index + 1,
        skill.selection.ref.source,
        skill.selection.ref.skillId,
        skill.selection.ref.digest,
        skill.selection.kind,
        skill.name,
        skill.description,
        skill.content,
        skill.packagePath,
      ),
    );
    this.insertAcceptanceContract(
      createInitialAcceptanceContract({
        taskId,
        turnId,
        objective: text,
        createdAt: now,
      }),
    );
    this.attachBackgroundCompletionsInTransaction(taskId, turnId, now);
    const event = this.appendEvent({ type: 'turn.accepted', taskId, turnId, userMessage });
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
    const renamedTask = this.autoNameTaskInTransaction(taskId, text, now);
    const catalogTokenEstimate =
      skillCatalogContent === undefined ? 0 : estimateTokens(skillCatalogContent);
    const prepared = this.assembleContextInTransaction(
      taskId,
      turnId,
      shouldSealBuiltinTeamSkill,
      catalogTokenEstimate,
    );
    if (skillCatalogContent !== undefined) {
      const existingTokens = prepared.fragments.reduce(
        (total, fragment) => total + fragment.tokenEstimate,
        0,
      );
      if (existingTokens + catalogTokenEstimate > CONTEXT_HARD_CAP_TOKENS)
        throw new Error('Skill catalog does not fit within the Turn context limit');
      prepared.fragments.push({
        id: `turn:${turnId}:skill-catalog`,
        taskId,
        source: 'background',
        trust: 'assistant',
        tokenEstimate: catalogTokenEstimate,
        content: skillCatalogContent,
        createdAt: now,
        messageId: null,
      });
    }
    const seal = this.createContextSealInTransaction('turn', turnId, taskId, prepared);
    const workspaceSet = this.sealTurnWorkspaceSet(taskId, turnId);
    return {
      turnId,
      text,
      runtimeKind,
      model,
      modelSelection,
      skills: parsedSkills,
      teamTurn: shouldSealBuiltinTeamSkill,
      event,
      sealId: seal.sealId,
      contextUsageEvents: prepared.usageEvents,
      workspaceSet,
      ...(renamedTask === null ? {} : { renamedTask }),
    };
  }

  private prepareAcceptedImageAttachments(
    taskId: string,
    attachmentIds: readonly string[],
    attachmentCapability: ImageAttachmentCapabilityValidator | undefined,
    selection: ImageAttachmentAcceptanceSelection,
  ): ImageAttachmentRow[] {
    const parsedIds = imageAttachmentIdsSchema.parse(attachmentIds);
    if (parsedIds.length === 0) return [];
    if (attachmentCapability?.(selection) !== true)
      throw new ImageAttachmentAcceptanceError('unsupported');
    const placeholders = parsedIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM image_attachments
         WHERE task_id = ? AND state = 'draft' AND message_id IS NULL
           AND id IN (${placeholders})`,
      )
      .all(taskId, ...parsedIds) as ImageAttachmentRow[];
    if (rows.length !== parsedIds.length) throw new ImageAttachmentAcceptanceError('stale');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = parsedIds.map((id) => byId.get(id)!);
    for (const row of ordered) {
      if (
        row.bytes.byteLength !== row.byte_length ||
        createHash('sha256').update(row.bytes).digest('hex') !== row.sha256
      )
        throw new ImageAttachmentAcceptanceError('stale');
    }
    imageAttachmentMetadataListSchema.parse(ordered.map(toImageAttachmentMetadata));
    return ordered;
  }

  private latestTurnIncludedBuiltinTeamSkill(taskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present
         FROM context_seals seal
         JOIN context_seal_fragments fragment ON fragment.seal_id = seal.id
         WHERE seal.id = (
           SELECT latest.id
           FROM context_seals latest
           WHERE latest.owner_type = 'turn' AND latest.task_id = ?
           ORDER BY latest.created_at DESC, latest.rowid DESC
           LIMIT 1
         )
           AND fragment.fragment_id = ?
         LIMIT 1`,
      )
      .get(taskId, BUILTIN_TEAM_SKILL_FRAGMENT_ID) as { present: number } | undefined;
    return row !== undefined;
  }

  /**
   * Names a still-unnamed Task from the message that just started its first Turn (issue #4).
   *
   * Runs inside `startTurnInTransaction` on purpose: the rename and the user message commit or roll
   * back together, so there is no window where the sidebar shows a name for a message that was
   * never stored. Returns the updated summary only when a rename actually happened, which is what
   * lets `turns.start` hand it straight back to the renderer instead of needing a new TurnEvent
   * variant (a new variant would land in `turn_events` and be replayed on every re-subscribe).
   *
   * Guarded by `title_source`, not by comparing against the placeholder string: a user who renames
   * a Task to literally "新しいタスク" still owns that name.
   */
  private autoNameTaskInTransaction(taskId: string, text: string, now: string): TaskSummary | null {
    const row = this.db.prepare('SELECT title_source FROM tasks WHERE id = ?').get(taskId) as
      { title_source: string } | undefined;
    if (row?.title_source !== 'default') return null;
    const derived = deriveTaskTitle(text);
    // No usable title (a message that is only whitespace, a code fence, or punctuation) leaves the
    // placeholder and `title_source` alone, so the *next* message gets another chance to name it.
    if (derived === null) return null;
    this.db
      .prepare("UPDATE tasks SET title = ?, title_source = 'auto', updated_at = ? WHERE id = ?")
      .run(derived, now, taskId);
    return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
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
      const projectMismatch = this.backgroundProjectSnapshotMismatch(taskId, row.owner_turn_id);
      if (projectMismatch !== null) {
        this.db
          .prepare(
            `UPDATE background_completions SET state = 'quarantined', quarantine_reason = ?
             WHERE completion_id = ? AND state IN ('persisted', 'attached')`,
          )
          .run(projectMismatch, row.completion_id);
        continue;
      }
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

  private backgroundProjectSnapshotMismatch(
    taskId: string,
    ownerTurnId: string,
  ): 'project_changed' | 'project_context_epoch_changed' | 'project_snapshot_changed' | null {
    const ownerSeal = this.contextSealRow('turn', ownerTurnId);
    if (ownerSeal === undefined || ownerSeal.task_id !== taskId) return 'project_changed';
    const task = this.getTaskRow(taskId);
    const project = task.project_id === null ? null : this.getProjectRow(task.project_id);
    if (ownerSeal.project_id !== (project?.id ?? null)) return 'project_changed';
    if (ownerSeal.project_context_epoch !== (project?.context_epoch ?? null))
      return 'project_context_epoch_changed';
    const candidates = this.projectContextCandidatesWithReferences(project);
    if (ownerSeal.candidate_snapshot_digest !== projectCandidateSnapshotDigest(project, candidates))
      return 'project_snapshot_changed';
    return null;
  }

  private projectContextCandidatesWithReferences(
    project: ProjectContextRow | null,
  ): readonly ProjectCandidateIdentity[] {
    const candidates = [...projectContextCandidates(project)];
    if (project === null) return candidates;
    const memories = this.db
      .prepare(
        "SELECT * FROM project_memories WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC, id",
      )
      .all(project.id) as ProjectMemoryRow[];
    for (const memory of memories) {
      candidates.push({
        itemId: `project:${project.id}:memory:${memory.id}`,
        kind: 'memory',
        sourceTaskId: memory.source_task_id,
        sourceTurnId: memory.source_turn_id,
        sourceReferenceId: null,
        candidateDigest: sha256(memory.content),
        authority: 'user',
        localOnly: memory.local_only === 1,
      });
    }
    const references = this.db
      .prepare(
        'SELECT * FROM project_references WHERE project_id = ? AND enabled = 1 ORDER BY created_at, id',
      )
      .all(project.id) as ProjectReferenceRow[];
    for (const reference of references) {
      const referenceWorkspace = this.projectReferenceWorkspace(reference);
      const read = readProjectReference({
        workspacePath: referenceWorkspace.path,
        registeredRootIdentity: reference.registered_root_identity,
        relativePath: reference.relative_path,
      });
      candidates.push({
        itemId: `project:${project.id}:reference:${reference.id}`,
        kind: 'reference',
        sourceTaskId: reference.source_task_id,
        sourceTurnId: null,
        sourceReferenceId: reference.id,
        candidateDigest:
          read.digest ??
          sha256(
            JSON.stringify([
              reference.id,
              reference.relative_path,
              reference.registered_root_identity,
              read.status,
            ]),
          ),
        authority: 'none',
        localOnly: referenceWorkspace.localOnly === 1,
      });
    }
    return candidates;
  }

  private quarantineBackgroundForProjectContextInTransaction(projectId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE background_activities SET state = 'canceled', finished_at = ?
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
           AND state IN ('registered', 'running')`,
      )
      .run(now, projectId);
    this.db
      .prepare(
        `UPDATE background_completions
         SET state = 'quarantined', quarantine_reason = 'project_context_epoch_changed'
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
           AND state IN ('persisted', 'attached')`,
      )
      .run(projectId);
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
    finalText?: string,
  ): TurnEvent {
    const turn = this.getTurn(taskId, turnId);
    if (state === 'completed') {
      const decision = decideCompletion(
        this.getAcceptanceContract(taskId, turnId),
        this.listEvidenceRecords(taskId, turnId),
      );
      if (!decision.allowed) throw new AcceptanceEvidenceMissingError(decision.openCriterionIds);
    }
    this.cancelPendingApprovals(taskId, turnId, new Date().toISOString());
    transitionTurn(turn.state, state);
    this.updateTurn(turnId, state);
    this.requeueUnacknowledgedBackgroundInTransaction(taskId, turnId);
    if (state === 'completed' && turn.assistant_message_id !== null && finalText !== undefined) {
      const message = this.db
        .prepare('SELECT content FROM messages WHERE id = ?')
        .get(turn.assistant_message_id) as { content: string } | undefined;
      const split =
        message === undefined ? null : splitAssistantConclusion(message.content, finalText);
      if (split !== null)
        this.db
          .prepare('UPDATE messages SET content = ?, work_content = ? WHERE id = ?')
          .run(split.content, split.workContent, turn.assistant_message_id);
    }
    const row =
      turn.assistant_message_id === null
        ? undefined
        : (this.db.prepare('SELECT * FROM messages WHERE id = ?').get(turn.assistant_message_id) as
            MessageRow | undefined);
    const diff = this.getTurnDiff(taskId, turnId);
    return this.appendEvent(
      row === undefined
        ? { type: 'turn.completed', taskId, turnId, state, diff: [...diff] }
        : {
            type: 'turn.completed',
            taskId,
            turnId,
            state,
            message: toMessage(row),
            diff: [...diff],
          },
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
      ...(() => {
        const payload = parseQueuedPayload(row.payload_json);
        return {
          text: payload.text,
          ...(payload.skills.length === 0
            ? {}
            : { skills: payload.skills.map((skill) => skill.selection) }),
        };
      })(),
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
    return toTask(this.getTaskRow(taskId), this.hasConversation(taskId));
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

  private hasConversation(taskId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS present FROM messages WHERE task_id = ? AND author = 'user' LIMIT 1")
        .get(taskId) !== undefined
    );
  }

  private updateAgentModelSelectionInTransaction(
    agentId: string,
    selection: ModelSelection,
    runtimeKind: RuntimeKind,
    now: string,
  ): void {
    const current = this.getAgent(agentId);
    const agentUpdate = this.db
      .prepare(
        `UPDATE agents
         SET connection_id = ?, requested_provider = ?, requested_model = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        selection.connectionId,
        selection.requestedProvider,
        selection.requestedModel,
        now,
        current.id,
      );
    const threadUpdate = this.db
      .prepare(
        `UPDATE agent_threads
         SET runtime_kind = ?, connection_id = ?, requested_provider = ?, requested_model = ?,
             revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        runtimeKind,
        selection.connectionId,
        selection.requestedProvider,
        selection.requestedModel,
        now,
        current.threadId,
      );
    if (agentUpdate.changes !== 1 || threadUpdate.changes !== 1) throw new TeamConflictError();
  }

  private getAgent(agentId: string): AgentRecord {
    const row = this.db
      .prepare(
        `SELECT a.*, t.runtime_kind FROM agents a
         JOIN agent_threads t ON t.id = a.thread_id WHERE a.id = ?`,
      )
      .get(agentId) as AgentRow | undefined;
    if (row === undefined) throw new NotFoundError('Agent not found');
    return toAgent(row);
  }

  private getTeamMessage(messageId: string): TeamMessageRecord {
    const row = this.db.prepare('SELECT * FROM team_messages WHERE id = ?').get(messageId) as
      TeamMessageRow | undefined;
    if (row === undefined) throw new NotFoundError('Team message not found');
    return toTeamMessage(row);
  }

  getTeamTask(taskId: string): TeamTaskRecord {
    const row = this.db.prepare('SELECT * FROM team_tasks WHERE id = ?').get(taskId) as
      TeamTaskRow | undefined;
    if (row === undefined) throw new NotFoundError('Team task not found');
    return toTeamTask(row);
  }

  private getTeamV2Activity(activityId: string): TeamV2ActivityRecord {
    const row = this.db
      .prepare('SELECT * FROM team_v2_activity_events WHERE id = ?')
      .get(activityId) as TeamV2ActivityRow | undefined;
    if (row === undefined) throw new NotFoundError('Team activity not found');
    return toTeamV2Activity(row);
  }

  private toTeamExecution(row: TeamExecutionRow): TeamExecutionRecord {
    const instruction = this.db
      .prepare(
        `SELECT * FROM team_execution_instructions
         WHERE execution_id = ? AND revision = ?`,
      )
      .get(row.id, row.instruction_revision) as TeamInstructionRow | undefined;
    if (instruction === undefined)
      throw new Error('Team execution instruction revision is missing');
    return {
      id: row.id,
      teamId: row.team_id,
      assigneeAgentId: row.assignee_agent_id,
      createdByAgentId: row.created_by_agent_id,
      accessMode: row.access_mode,
      state: row.state,
      instruction: {
        revision: instruction.revision,
        content: instruction.content,
        updatedAt: instruction.created_at,
      },
      queueOrdinal: row.queue_ordinal,
      queueReason: row.queue_reason,
      modelSelection: {
        connectionId: row.connection_id,
        requestedProvider: row.requested_provider,
        requestedModel: row.requested_model,
      },
      revision: row.revision,
      assignedAt: row.assigned_at,
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    };
  }

  private getBudgetReservation(id: string): TeamBudgetReservationRecord {
    const row = this.db.prepare('SELECT * FROM team_budget_reservations WHERE id = ?').get(id) as
      TeamBudgetReservationRow | undefined;
    if (row === undefined) throw new NotFoundError('Budget reservation not found');
    return toTeamBudgetReservation(row);
  }

  private requireTeamDelivery(messageId: string): TeamDeliveryRecord {
    const delivery = this.getTeamDelivery(messageId);
    if (delivery === null) throw new NotFoundError('Team delivery not found');
    return delivery;
  }

  private requireWorkerWorktree(agentId: string): WorkerWorktreeRecord {
    const worktree = this.getWorkerWorktree(agentId);
    if (worktree === null) throw new NotFoundError('Worker worktree not found');
    return worktree;
  }

  private requireTeamMissionWorktree(executionId: string): TeamMissionWorktreeRecord {
    const worktree = this.getTeamMissionWorktree(executionId);
    if (worktree === null) throw new NotFoundError('Team Mission worktree not found');
    return worktree;
  }

  private requireTeamExecutionIsolation(executionId: string): TeamExecutionIsolationRecord {
    const isolation = this.getTeamExecutionIsolation(executionId);
    if (isolation === null) throw new NotFoundError('Team execution isolation not found');
    return isolation;
  }

  private requireTeamExecutionIsolationCompletion(
    executionId: string,
  ): TeamExecutionIsolationCompletionRecord {
    const completion = this.getTeamExecutionIsolationCompletion(executionId);
    if (completion === null)
      throw new NotFoundError('Team execution isolation completion not found');
    return completion;
  }

  private getGlobalLimits(): Partial<Record<BudgetKind, number>> {
    const row = this.db.prepare('SELECT limits_json FROM team_global_limits WHERE id = 1').get() as
      { limits_json: string } | undefined;
    if (row === undefined) return DEFAULT_TEAM_BUDGET_LIMITS.global;
    return JSON.parse(row.limits_json) as Partial<Record<BudgetKind, number>>;
  }

  private budgetCap(
    team: TeamRecord,
    globalLimits: Partial<Record<BudgetKind, number>>,
    scope: BudgetScope,
    kind: BudgetKind,
  ): number {
    if (scope === 'global') {
      const value = globalLimits[kind];
      return typeof value === 'number' ? value : DEFAULT_TEAM_BUDGET_LIMITS.global[kind];
    }
    const budget = team.budget as Record<string, Partial<Record<BudgetKind, number>> | undefined>;
    const value = budget[scope]?.[kind];
    return typeof value === 'number' ? value : DEFAULT_TEAM_BUDGET_LIMITS[scope][kind];
  }

  private budgetTotals(
    scope: BudgetScope,
    kind: BudgetKind,
    teamId: string,
    agentId: string | null,
  ): { committed: number; reserved: number } {
    const selection = `SELECT
         COALESCE(SUM(CASE WHEN state = 'settled'
           THEN COALESCE(settled_amount, amount) ELSE 0 END), 0) AS committed,
         COALESCE(SUM(CASE WHEN state = 'reserved' THEN amount ELSE 0 END), 0) AS reserved
       FROM team_budget_reservations WHERE scope = ? AND kind = ?`;
    let row: { committed: number; reserved: number };
    if (scope === 'global') {
      row = this.db.prepare(selection).get(scope, kind) as {
        committed: number;
        reserved: number;
      };
    } else if (scope === 'team') {
      row = this.db.prepare(`${selection} AND team_id = ?`).get(scope, kind, teamId) as {
        committed: number;
        reserved: number;
      };
    } else {
      row = this.db.prepare(`${selection} AND agent_id = ?`).get(scope, kind, agentId) as {
        committed: number;
        reserved: number;
      };
    }
    return { committed: row.committed, reserved: row.reserved };
  }

  private usageTotals(column: 'team_id' | 'agent_id', value: string): TeamUsageTotals {
    const rows = this.db
      .prepare(
        `SELECT kind, COALESCE(SUM(COALESCE(settled_amount, amount)), 0) AS total
         FROM team_budget_reservations
         WHERE ${column} = ? AND state = 'settled'
           AND kind IN ('costCents', 'tokens', 'timeMs', 'toolCalls')
         GROUP BY kind`,
      )
      .all(value) as { kind: BudgetKind; total: number }[];
    const totals: TeamUsageTotals = { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 };
    const mutable = totals as {
      costCents: number;
      tokens: number;
      timeMs: number;
      toolCalls: number;
    };
    for (const row of rows) {
      if (row.kind === 'spawnSlots') continue;
      mutable[row.kind] = row.total;
    }
    return totals;
  }

  private insertDeliveryEvent(
    messageId: string,
    revision: number,
    fromState: TeamDeliveryState | null,
    toState: TeamDeliveryState,
    attempt: number,
    error: string | null,
    recordedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO team_delivery_events(
           id, message_id, revision, from_state, to_state, attempt, error, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), messageId, revision, fromState, toState, attempt, error, recordedAt);
  }

  private assertTask(taskId: string): void {
    this.getTaskRow(taskId);
  }

  private assertTaskNotMutationQuarantined(taskId: string): void {
    const active = this.db
      .prepare(
        `SELECT 1 FROM task_mutation_quarantines
         WHERE task_id = ? AND cleared_at IS NULL LIMIT 1`,
      )
      .get(taskId);
    if (active !== undefined) throw new MutationQuarantinedError();
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
export class ImageAttachmentLimitError extends Error {}
export type ImageAttachmentAcceptanceSelection = Readonly<{
  taskId: string;
  modelSelection: ModelSelection;
  runtimeKind: RuntimeKind;
  model: string;
}>;
export type AcceptedImageAttachment = Readonly<
  ImageAttachmentMetadata & { sha256: string; bytes: Buffer }
>;
export type ImageAttachmentCapabilityValidator = (
  selection: ImageAttachmentAcceptanceSelection,
) => boolean;
export class ImageAttachmentAcceptanceError extends Error {
  constructor(readonly reason: 'unsupported' | 'stale') {
    super(reason);
  }
}
export class TurnActiveError extends Error {}
export class SteerStaleError extends Error {}
export class OperationConflictError extends Error {}
export class OperationInProgressError extends Error {}
export class TeamConflictError extends Error {}
export class ProjectConflictError extends Error {}
export class ProjectArchivedError extends Error {}
export class TaskAssignmentBlockedError extends Error {}
export class ReferenceInUseError extends Error {}
export class InvalidProjectError extends Error {}
export class ProjectFolderMutationBlockedError extends Error {}
export class InvalidCanvasViewError extends Error {}
export class CanvasViewConflictError extends Error {}
export class AcceptanceEvidenceMissingError extends Error {
  constructor(readonly openCriterionIds: readonly string[]) {
    super(`Acceptance evidence is missing: ${openCriterionIds.join(', ')}`);
  }
}

function toTurnSkillSelection(row: SkillBindingIdentityRow): TurnSkillSelection {
  return {
    kind: row.kind,
    ref: {
      source: row.source,
      skillId: row.skill_id,
      digest: row.digest,
    },
  };
}

function validatePersistedTurnSkills(skills: readonly PersistedTurnSkill[]): PersistedTurnSkill[] {
  const selections = turnSkillSelectionsSchema.parse(skills.map((skill) => skill.selection));
  return skills.map((skill, index) => {
    if (
      typeof skill.name !== 'string' ||
      skill.name.length < 1 ||
      skill.name.length > 200 ||
      typeof skill.description !== 'string' ||
      skill.description.length < 1 ||
      skill.description.length > 2_000 ||
      typeof skill.content !== 'string' ||
      skill.content.length < 1 ||
      skill.content.length > 40_000 ||
      typeof skill.packagePath !== 'string' ||
      !isAbsolute(skill.packagePath) ||
      skill.packagePath.length > 4_096
    )
      throw new Error('Resolved Skill payload is invalid');
    return {
      selection: selections[index]!,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      packagePath: skill.packagePath,
    };
  });
}

function parseQueuedPayload(payloadJson: string): {
  text: string;
  skills: PersistedTurnSkill[];
  includeBuiltinTeamSkill: boolean;
} {
  const parsed: unknown = JSON.parse(payloadJson);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Queued input is invalid');
  const value = parsed as {
    text?: unknown;
    skills?: unknown;
    includeBuiltinTeamSkill?: unknown;
  };
  if (typeof value.text !== 'string' || value.text.trim() === '' || value.text.length > 100_000)
    throw new Error('Queued input text is invalid');
  if (
    value.includeBuiltinTeamSkill !== undefined &&
    typeof value.includeBuiltinTeamSkill !== 'boolean'
  )
    throw new Error('Queued Team Skill payload is invalid');
  const includeBuiltinTeamSkill = value.includeBuiltinTeamSkill ?? false;
  if (value.skills === undefined) return { text: value.text, skills: [], includeBuiltinTeamSkill };
  if (!Array.isArray(value.skills)) throw new Error('Queued Skill payload is invalid');
  return {
    text: value.text,
    skills: validatePersistedTurnSkills(value.skills as PersistedTurnSkill[]),
    includeBuiltinTeamSkill,
  };
}

function toTask(row: TaskRow, hasConversation: boolean): TaskSummary {
  return taskSummarySchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    goal: row.goal,
    goalState:
      row.goal === null ||
      row.goal_status === null ||
      row.goal_started_at === null ||
      row.goal_updated_at === null
        ? null
        : {
            objective: row.goal,
            status: row.goal_status,
            tokenBudget: row.goal_token_budget,
            tokensUsed: row.goal_tokens_used,
            timeUsedSeconds: row.goal_time_used_seconds,
            startedAt: row.goal_started_at,
            updatedAt: row.goal_updated_at,
          },
    workspacePath: row.workspace_path,
    localOnly: row.local_only === 1,
    hasConversation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toProject(row: ProjectRow): ProjectSummary {
  return projectSummarySchema.parse({
    id: row.id,
    name: row.name,
    archived: row.archived === 1,
    revision: row.revision,
    taskCount: row.task_count,
    folderCount: row.folder_count,
    primaryFolder:
      row.primary_folder_id === null ||
      row.primary_folder_path === null ||
      row.primary_folder_label === null
        ? null
        : {
            id: row.primary_folder_id,
            path: row.primary_folder_path,
            label: row.primary_folder_label,
          },
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toProjectFolder(row: ProjectWorkspaceRootRow): ProjectFolder {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.canonical_path,
    label: row.label,
    role: row.role,
    ordinal: row.ordinal,
    status: 'available',
  };
}

function folderLabel(path: string): string {
  return basename(path) || path;
}

function validateProjectFolderBindings(folders: readonly ProjectFolderBinding[]): void {
  if (folders.length > 16) throw new InvalidProjectError('Project folder limit reached');
  const primaryCount = folders.filter(({ role }) => role === 'primary').length;
  if ((folders.length === 0 && primaryCount !== 0) || (folders.length > 0 && primaryCount !== 1))
    throw new InvalidProjectError('A non-empty Project must have exactly one Primary folder');
  const paths = new Set<string>();
  const identities = new Set<string>();
  folders.forEach((folder, index) => {
    if (!isAbsolute(folder.canonicalPath) || dirname(folder.canonicalPath) === folder.canonicalPath)
      throw new InvalidProjectError('Project folder must be an absolute non-filesystem-root path');
    validateMutationDigest(folder.workspaceKey, 'workspace mutation key');
    validateMutationDigest(folder.rootIdentityDigest, 'workspace root identity digest');
    const pathKey = pathComparisonKey(folder.canonicalPath);
    if (paths.has(pathKey) || identities.has(folder.rootIdentityDigest))
      throw new InvalidProjectError('Project folders must resolve to distinct directories');
    for (const previous of folders.slice(0, index)) {
      const fromPrevious = relative(previous.canonicalPath, folder.canonicalPath);
      const fromFolder = relative(folder.canonicalPath, previous.canonicalPath);
      if (
        (fromPrevious !== '' && !fromPrevious.startsWith(`..${sep}`) && fromPrevious !== '..') ||
        (fromFolder !== '' && !fromFolder.startsWith(`..${sep}`) && fromFolder !== '..')
      )
        throw new InvalidProjectError('Nested Project folders are not allowed');
    }
    paths.add(pathKey);
    identities.add(folder.rootIdentityDigest);
  });
}

function assignProjectFolderIds(
  current: readonly ProjectWorkspaceRootRow[],
  folders: readonly ProjectFolderBinding[],
): string[] {
  const currentById = new Map(current.map((root) => [root.id, root]));
  const currentByIdentity = new Map(current.map((root) => [root.root_identity_digest, root]));
  const used = new Set<string>();
  return folders.map((folder) => {
    const requested = folder.id === undefined ? undefined : currentById.get(folder.id);
    const identityMatch = currentByIdentity.get(folder.rootIdentityDigest);
    const match =
      requested?.root_identity_digest === folder.rootIdentityDigest ? requested : identityMatch;
    const id = match?.id ?? randomUUID();
    if (used.has(id)) throw new InvalidProjectError('Project folder ID is duplicated');
    used.add(id);
    return id;
  });
}

type EffectiveWorkspaceBinding = {
  rootId: string;
  path: string;
  label: string;
  role: 'primary' | 'secondary';
  workspaceKey: string;
  rootIdentityDigest: string;
};

function effectiveWorkspaceBindings(
  task: TaskRow,
  projectRoots: readonly ProjectWorkspaceRootRow[],
): EffectiveWorkspaceBinding[] {
  if (projectRoots.length > 0)
    return projectRoots.map((root) => ({
      rootId: root.id,
      path: root.canonical_path,
      label: root.label,
      role: root.role,
      workspaceKey: root.workspace_key,
      rootIdentityDigest: root.root_identity_digest,
    }));
  if (
    task.workspace_path !== null &&
    task.mutation_scope_key !== null &&
    task.mutation_root_identity_digest !== null &&
    (task.project_id === null || task.legacy_project_workspace_fallback === 1)
  )
    return [
      {
        rootId: task.id,
        path: task.workspace_path,
        label: folderLabel(task.workspace_path),
        role: 'primary',
        workspaceKey: task.mutation_scope_key,
        rootIdentityDigest: task.mutation_root_identity_digest,
      },
    ];
  return [];
}

function effectiveWorkspaceDigest(
  source: 'project' | 'task' | 'none',
  projectId: string | null,
  roots: readonly EffectiveWorkspaceBinding[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'effective-workspace-set-v1',
        source,
        projectId,
        roots.map((root) => [
          root.rootId,
          root.path,
          root.role,
          root.workspaceKey,
          root.rootIdentityDigest,
        ]),
      ]),
    )
    .digest('hex');
}

function effectiveWorkspaceSetFromRows(
  source: 'project',
  projectId: string,
  rows: readonly ProjectWorkspaceRootRow[],
): EffectiveWorkspaceSet {
  const bindings = rows.map((root) => ({
    rootId: root.id,
    path: root.canonical_path,
    label: root.label,
    role: root.role,
    workspaceKey: root.workspace_key,
    rootIdentityDigest: root.root_identity_digest,
  }));
  return {
    source,
    projectId,
    primaryRootId: bindings.find(({ role }) => role === 'primary')?.rootId ?? null,
    roots: bindings.map(
      ({ workspaceKey: _workspaceKey, rootIdentityDigest: _identity, ...root }) => ({
        ...root,
        status: 'available',
      }),
    ),
    digest: effectiveWorkspaceDigest(source, projectId, bindings),
  };
}

function effectiveWorkspaceSetFromLegacyTask(
  task: TaskRow,
  projectId: string | null,
): EffectiveWorkspaceSet {
  const bindings = effectiveWorkspaceBindings(task, []);
  return {
    source: 'task',
    projectId,
    primaryRootId: task.id,
    roots: bindings.map(
      ({ workspaceKey: _workspaceKey, rootIdentityDigest: _identity, ...root }) => ({
        ...root,
        status: 'available',
      }),
    ),
    digest: effectiveWorkspaceDigest('task', projectId, bindings),
  };
}

function emptyEffectiveWorkspaceSet(projectId: string | null): EffectiveWorkspaceSet {
  return {
    source: 'none',
    projectId,
    primaryRootId: null,
    roots: [],
    digest: effectiveWorkspaceDigest('none', projectId, []),
  };
}

function parseProjectName(name: string): string {
  const parsed = name.trim();
  if (parsed.length < 1 || parsed.length > 120) throw new InvalidProjectError();
  return parsed;
}

function parseReferenceRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length < 1 ||
    normalized.length > 1024 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new InvalidProjectError('Reference path must be Workspace-relative');
  return normalized;
}

function parseProjectMemoryContent(value: string): string {
  const content = value.trim();
  if (content.length < 1 || content.length > 4000)
    throw new InvalidProjectError('Project memory must be 1 to 4000 characters');
  return content;
}

function toProjectMemory(row: ProjectMemoryRow): ProjectMemory {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceTaskId: row.source_task_id,
    sourceTurnId: row.source_turn_id,
    content: row.content,
    createdBy: row.created_by,
    status: row.status,
    revision: row.revision,
    localOnly: row.local_only === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProviderConnection(row: ProviderConnectionRow): ProviderConnection {
  return providerConnectionSchema.parse({
    id: row.id,
    providerId: row.provider_id,
    runtimeKind: row.runtime_kind satisfies ProviderRuntimeKind,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    automaticModelRelease: row.automatic_model_release === 1,
    secretReference: row.secret_reference,
    verification: {
      status: row.verification_status,
      verifiedAt: row.verified_at,
      expiresAt: row.verification_expires_at,
      message: row.verification_message,
    },
    rateLimit: {
      mode: row.rate_limit_mode,
      maxConcurrentRequests: row.max_concurrent_requests,
      requestsPerMinute: row.requests_per_minute,
      tokensPerMinute: row.tokens_per_minute,
      lastObservedRateLimitHeaders:
        row.last_observed_rate_limit_headers_json === null
          ? null
          : (JSON.parse(row.last_observed_rate_limit_headers_json) as Record<string, string>),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toTeam(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    state: row.state,
    leaderAgentId: row.leader_agent_id,
    budget: JSON.parse(row.budget_json) as Record<string, PersistedJsonValue>,
    policy: assertTeamPolicy(JSON.parse(row.policy_json) as TeamPolicy),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    threadId: row.thread_id,
    taskId: row.task_id,
    kind: row.kind,
    role: row.role,
    state: row.state,
    objective: row.objective,
    parentCapabilityCeiling:
      row.parent_capability_ceiling_json === null
        ? null
        : (JSON.parse(row.parent_capability_ceiling_json) as CapabilityCeiling),
    contextInheritancePolicy: row.context_inheritance_policy,
    writeCapable: row.write_capable === 1,
    currentActivity: row.current_activity,
    runtimeKind: row.runtime_kind,
    modelSelection:
      readCanonicalModelSelection({
        connectionId: row.connection_id,
        requestedProvider: row.requested_provider,
        requestedModel: row.requested_model,
      }) ?? modelSelectionForRuntime(row.runtime_kind, row.requested_model ?? 'auto'),
    parentAgentId: row.parent_agent_id,
    depth: row.depth,
    canDelegate: row.can_delegate === 1,
    managerPolicy:
      row.manager_policy_json === null
        ? null
        : (JSON.parse(row.manager_policy_json) as ManagerPolicy),
    blueprintRoleKey: row.blueprint_role_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTurnModelIdentity(row: TurnRow): TurnModelIdentity {
  return {
    selection:
      readCanonicalModelSelection({
        connectionId: row.connection_id,
        requestedProvider: row.requested_provider,
        requestedModel: row.requested_model,
      }) ?? modelSelectionForRuntime(row.runtime_kind, row.model),
    resolution:
      row.resolution_json === null
        ? {
            resolvedProvider: row.resolved_provider,
            resolvedModel: row.resolved_model,
          }
        : executionResolutionSchema.parse(JSON.parse(row.resolution_json)),
  };
}

function readCanonicalModelSelection(input: {
  connectionId: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
}): ModelSelection | null {
  if (
    input.connectionId === null ||
    input.requestedProvider === null ||
    input.requestedModel === null
  )
    return null;
  return modelSelectionSchema.parse(input);
}

function toTeamBudgetReservation(row: TeamBudgetReservationRow): TeamBudgetReservationRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    agentId: row.agent_id,
    scope: row.scope,
    kind: row.kind,
    amount: row.amount,
    settledAmount: row.settled_amount,
    state: row.state,
    purpose: row.purpose,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTeamDelivery(row: TeamDeliveryRow): TeamDeliveryRecord {
  return {
    messageId: row.message_id,
    deliveryId: row.delivery_id,
    state: row.state,
    attempt: row.attempt,
    lastError: row.last_error,
    dispatchedAt: row.dispatched_at,
    ackedAt: row.acked_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorkerWorktree(row: WorkerWorktreeRow): WorkerWorktreeRecord {
  return {
    agentId: row.agent_id,
    path: row.path,
    baseHead: row.base_head,
    state: row.state,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTeamMissionWorktree(row: TeamMissionWorktreeRow): TeamMissionWorktreeRecord {
  return {
    executionId: row.execution_id,
    agentId: row.agent_id,
    repoPath: row.repo_path,
    path: row.path,
    baseHead: row.base_head,
    state: row.state,
    workerHead: row.worker_head,
    integratedHead: row.integrated_head,
    changedFiles: JSON.parse(row.changed_files_json) as string[],
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTeamExecutionIsolation(row: TeamExecutionIsolationRow): TeamExecutionIsolationRecord {
  const parsed = teamExecutionIsolationSchema.parse({
    phase: row.phase,
    resumeKind: row.resume_kind,
    repositories: JSON.parse(row.repositories_json),
    roots: JSON.parse(row.roots_json),
    reason: row.reason,
  });
  return {
    executionId: row.execution_id,
    ...parsed,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTeamExecutionIsolationCompletion(
  row: TeamExecutionIsolationCompletionRow,
): TeamExecutionIsolationCompletionRecord {
  const doneEvidence = JSON.parse(row.done_evidence_json) as unknown;
  if (
    !Array.isArray(doneEvidence) ||
    doneEvidence.some(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        typeof (item as { criterion?: unknown }).criterion !== 'string' ||
        typeof (item as { evidence?: unknown }).evidence !== 'string',
    )
  )
    throw new Error('Invalid Team isolation completion evidence');
  return {
    executionId: row.execution_id,
    attemptId: row.attempt_id,
    teamTaskId: row.team_task_id,
    agentId: row.agent_id,
    report: workerReportSchema.parse(JSON.parse(row.report_json)),
    doneEvidence: doneEvidence as { criterion: string; evidence: string }[],
    createdAt: row.created_at,
  };
}

function toTeamMessage(row: TeamMessageRow): TeamMessageRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    sourceAgentId: row.source_agent_id,
    targetAgentId: row.target_agent_id,
    seq: row.seq,
    state: row.state,
    content: row.content,
    executionId: row.execution_id,
    attemptId: row.attempt_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTeamTask(row: TeamTaskRow): TeamTaskRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    messageId: row.message_id,
    assigneeAgentId: row.assignee_agent_id,
    createdByAgentId: row.created_by_agent_id,
    description: row.description,
    status: row.status,
    doneCriteria: JSON.parse(row.done_criteria_json) as string[],
    doneEvidence: JSON.parse(row.done_evidence_json) as {
      criterion: string;
      evidence: string;
    }[],
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTeamAttempt(row: TeamAttemptRow): TeamAttemptRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    ordinal: row.ordinal,
    state: row.state,
    instructionRevision: row.instruction_revision,
    modelSelection: {
      connectionId: row.connection_id,
      requestedProvider: row.requested_provider,
      requestedModel: row.requested_model,
    },
    providerCallOrdinal: row.provider_call_ordinal,
    terminalReason: row.terminal_reason,
    startReason: row.start_reason,
    lastProgressAt: row.last_progress_at,
    resolution:
      row.resolution_json === null
        ? {
            resolvedProvider: row.resolved_provider,
            resolvedModel: row.resolved_model,
          }
        : executionResolutionSchema.parse(JSON.parse(row.resolution_json)),
    providerUsage:
      row.provider_usage_json === null
        ? null
        : normalizedProviderUsageSchema.parse(JSON.parse(row.provider_usage_json)),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function toTeamMission(
  row: TeamMissionRow,
  steps: readonly TeamMissionStepRow[],
): TeamMissionRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    createdByAgentId: row.created_by_agent_id,
    state: row.state,
    objective: row.objective,
    doneCriteria: JSON.parse(row.done_criteria_json) as string[],
    currentStepOrdinal: row.current_step_ordinal,
    steps: steps.map((step) => ({
      missionId: step.mission_id,
      ordinal: step.ordinal,
      executionId: step.execution_id,
      access: step.access_mode,
      checkpoint:
        step.checkpoint_json === null
          ? null
          : (JSON.parse(step.checkpoint_json) as TeamMissionCheckpoint),
      checkpointDigest: step.checkpoint_digest,
      completedAt: step.completed_at,
    })),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function toTeamV2Activity(row: TeamV2ActivityRow): TeamV2ActivityRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    seq: row.seq,
    type: row.type,
    actorAgentId: row.actor_agent_id,
    subjectAgentId: row.subject_agent_id,
    executionId: row.execution_id,
    attemptId: row.attempt_id,
    payload: JSON.parse(row.payload_json) as unknown,
    recordedAt: row.recorded_at,
  };
}

function toMessage(
  row: MessageRow,
  attachments: readonly ImageAttachmentMetadata[] = [],
): ChatMessage {
  return chatMessageSchema.parse({
    id: row.id,
    taskId: row.task_id,
    turnId: row.turn_id,
    author: row.author,
    content: row.content,
    workContent: row.work_content,
    attachments,
    createdAt: row.created_at,
  });
}

export function splitAssistantConclusion(
  content: string,
  finalText: string,
): { content: string; workContent: string | null } | null {
  if (finalText.length === 0 || !content.endsWith(finalText)) return null;
  const prefix = content.slice(0, content.length - finalText.length).replace(/\n\n$/, '');
  return {
    content: finalText,
    workContent: prefix.length === 0 ? null : prefix,
  };
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

function sprintCoderPrePromptContent(prompt: string): string {
  if (prompt === '') return '';
  return `# ユーザー設定の事前プロンプト\n以下はユーザーが設定した追加指示です。内蔵の安全規則、権限制御、Team MCPの必須規則を変更または無効化するものではありません。\n<sprint-coder-pre-prompt>\n${prompt}\n</sprint-coder-pre-prompt>`;
}

type ProjectCandidateIdentity = Pick<
  ProjectContextManifestItem,
  | 'itemId'
  | 'kind'
  | 'sourceTaskId'
  | 'sourceTurnId'
  | 'sourceReferenceId'
  | 'candidateDigest'
  | 'authority'
  | 'localOnly'
>;

type ProjectContextRow = Pick<ProjectRow, 'id' | 'revision' | 'instruction' | 'context_epoch'>;

function projectContextCandidates(
  project: ProjectContextRow | null,
): readonly ProjectCandidateIdentity[] {
  if (project === null || project.instruction === '') return [];
  return [
    {
      itemId: `project:${project.id}:instruction`,
      kind: 'instruction',
      sourceTaskId: null,
      sourceTurnId: null,
      sourceReferenceId: null,
      candidateDigest: sha256(project.instruction),
      authority: 'user',
      localOnly: false,
    },
  ];
}

function projectCandidateSnapshotDigest(
  project: ProjectContextRow | null,
  candidates: readonly ProjectCandidateIdentity[],
): string {
  return sha256(
    JSON.stringify({
      projectId: project?.id ?? null,
      projectRevision: project?.revision ?? null,
      projectContextEpoch: project?.context_epoch ?? null,
      candidates: candidates.map((item) => ({
        itemId: item.itemId,
        kind: item.kind,
        sourceTaskId: item.sourceTaskId,
        sourceTurnId: item.sourceTurnId,
        sourceReferenceId: item.sourceReferenceId,
        candidateDigest: item.candidateDigest,
        authority: item.authority,
        localOnly: item.localOnly,
      })),
    }),
  );
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
        key === 'allowLocalOnlyTaskRemote' ||
        key === 'attachmentManifestDigest' ||
        key === 'attachmentByteCount',
    ) &&
    typeof record['maxBytes'] === 'number' &&
    Number.isSafeInteger(record['maxBytes']) &&
    record['maxBytes'] >= 0 &&
    typeof record['requireSecretScanClean'] === 'boolean' &&
    typeof record['allowLocalOnlyTaskRemote'] === 'boolean' &&
    ((record['attachmentManifestDigest'] === undefined ||
      record['attachmentManifestDigest'] === null) &&
    (record['attachmentByteCount'] === undefined || record['attachmentByteCount'] === 0)
      ? true
      : typeof record['attachmentManifestDigest'] === 'string' &&
        /^[a-f0-9]{64}$/.test(record['attachmentManifestDigest']) &&
        typeof record['attachmentByteCount'] === 'number' &&
        Number.isSafeInteger(record['attachmentByteCount']) &&
        record['attachmentByteCount'] > 0)
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
      attachmentManifestDigest:
        record['attachmentManifestDigest'] === undefined
          ? null
          : (record['attachmentManifestDigest'] as string | null),
      attachmentByteCount:
        record['attachmentByteCount'] === undefined ? 0 : (record['attachmentByteCount'] as number),
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

function toEditSaga(row: EditSagaRow): EditSagaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshot_json);
  } catch {
    throw new Error('Invalid persisted Edit Saga JSON');
  }
  const snapshot = parseEditSagaSnapshot(parsed);
  if (
    snapshot.id !== row.id ||
    snapshot.taskId !== row.task_id ||
    snapshot.turnId !== row.turn_id ||
    snapshot.operationId !== row.operation_id ||
    snapshot.planDigest !== row.plan_digest ||
    snapshot.policyEpoch !== row.policy_epoch ||
    snapshot.rootId !== row.root_id ||
    snapshot.workspaceKey !== row.workspace_key ||
    snapshot.rootIdentityDigest !== row.root_identity_digest ||
    row.binding_version !== 1 ||
    row.native_binding_version !== 1 ||
    row.root_binding_version !== 1 ||
    snapshot.state !== row.state ||
    snapshot.revision !== row.revision ||
    snapshot.artifactCleanupPending !== (row.artifact_cleanup_pending === 1) ||
    snapshot.createdAt !== row.created_at ||
    snapshot.updatedAt !== row.updated_at
  )
    throw new Error('Persisted Edit Saga columns do not match its sealed snapshot');
  return snapshot;
}

function toNativeMutationIntent(row: NativeMutationIntentRow): NativeMutationIntentSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshot_json);
  } catch {
    throw new Error('Invalid persisted Native mutation intent JSON');
  }
  const snapshot = parseNativeMutationIntentSnapshot(parsed);
  if (
    snapshot.id !== row.id ||
    snapshot.sagaId !== row.saga_id ||
    snapshot.ordinal !== row.ordinal ||
    snapshot.direction !== row.direction ||
    snapshot.operationDigest !== row.operation_digest ||
    snapshot.workspaceKey !== row.workspace_key ||
    snapshot.rootIdentityDigest !== row.root_identity_digest ||
    snapshot.policyEpoch !== row.policy_epoch ||
    snapshot.leaseFence !== row.lease_fence ||
    snapshot.nativeSessionId !== row.native_session_id ||
    snapshot.seedDigest !== row.seed_digest ||
    snapshot.intentDigest !== row.intent_digest ||
    snapshot.recordDigest !== row.record_digest ||
    nativeMutationAuxiliaryKey(snapshot) !== row.auxiliary_key ||
    snapshot.state !== row.state ||
    snapshot.revision !== row.revision ||
    snapshot.createdAt !== row.created_at ||
    snapshot.updatedAt !== row.updated_at
  )
    throw new Error('Persisted Native mutation columns do not match its sealed snapshot');
  return snapshot;
}

function toNativeMutationRecoveryBinding(
  row: NativeMutationRecoveryBindingRow,
): NativeMutationRecoveryBinding {
  const facts = {
    version: 1 as const,
    intentId: row.intent_id,
    attempt: row.attempt,
    intentDigest: row.intent_digest,
    leaseId: row.lease_id,
    leaseFence: row.lease_fence,
    nativeSessionId: row.native_session_id,
    createdAt: row.created_at,
  };
  const binding = Object.freeze({ ...facts, bindingDigest: row.binding_digest });
  if (
    !Number.isSafeInteger(binding.attempt) ||
    binding.attempt < 1 ||
    binding.intentId.length < 1 ||
    binding.intentId.length > 200 ||
    binding.leaseId.length < 1 ||
    binding.leaseId.length > 200 ||
    !/^[1-9][0-9]{0,19}$/.test(binding.leaseFence) ||
    !/^[a-f0-9]{64}$/.test(binding.intentDigest) ||
    !/^[a-f0-9]{64}$/.test(binding.bindingDigest) ||
    digestJson(facts) !== binding.bindingDigest
  )
    throw new Error('Invalid persisted Native mutation recovery binding');
  validateNativeSessionId(binding.nativeSessionId);
  validateMutationTimestamp(binding.createdAt, 'Native mutation recovery binding timestamp');
  return binding;
}

export function nativeMutationOperationDigest(operation: JournaledPatchOperation): string {
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}

function nativeMutationAuxiliaryKey(snapshot: NativeMutationIntentSnapshot): string | null {
  const auxiliary = snapshot.temp ?? snapshot.tombstone;
  return auxiliary === null
    ? null
    : digestJson([snapshot.workspaceKey, auxiliary.parentSegments, auxiliary.leafName]);
}

function nativeMutationTransitionAlreadyApplied(
  current: NativeMutationIntentSnapshot,
  transition: NativeMutationIntentTransition,
): boolean {
  if (current.state !== transition.state) return false;
  if (transition.state === 'aux_observed')
    return JSON.stringify(current.auxObservation) === JSON.stringify(transition.auxObservation);
  if (transition.state === 'effect_observed')
    return (
      JSON.stringify(current.effectObservation) === JSON.stringify(transition.effectObservation)
    );
  if (transition.state === 'completed')
    return (
      JSON.stringify(current.cleanupObservation) === JSON.stringify(transition.cleanupObservation)
    );
  return true;
}

function expectedNativeMutationArtifact(
  operation: JournaledPatchOperation,
  direction: NativeMutationIntentSnapshot['direction'],
): NativeMutationIntentSnapshot['artifact'] {
  const reference =
    direction === 'forward'
      ? operation.kind === 'add' || operation.kind === 'update'
        ? operation.postArtifact
        : null
      : operation.kind === 'update' || operation.kind === 'delete'
        ? operation.preArtifact
        : null;
  return reference === null
    ? null
    : {
        artifactId: reference.artifactId,
        contentHash: reference.contentHash,
        size: reference.size,
        expectedMode:
          operation.kind === 'add' && direction === 'forward'
            ? 0o100600
            : (operation.preRevision?.mode ?? failNativeMutationBinding()),
      };
}

export function expectedNativeMutationBinding(
  operation: JournaledPatchOperation,
  direction: NativeMutationIntentSnapshot['direction'],
  workspacePath: string,
  postObservation: OperationObservation | null,
): Readonly<{
  kind: NativeMutationIntentSnapshot['kind'];
  artifact: NativeMutationIntentSnapshot['artifact'];
  sourceSegments: readonly string[];
  destinationSegments: readonly string[] | null;
  expectedSource: NativeMutationIntentSnapshot['expectedSource'];
}> {
  const kind = deriveNativeMutationEffectKind(operation.kind, direction);
  const forwardSource = nativeRelativeSegments(workspacePath, operation.canonicalPath);
  const forwardDestination =
    operation.canonicalDestination === null
      ? null
      : nativeRelativeSegments(workspacePath, operation.canonicalDestination);
  const sourceSegments =
    direction === 'compensation' && operation.kind === 'rename'
      ? (forwardDestination ?? failNativeMutationBinding())
      : forwardSource;
  const destinationSegments =
    kind === 'rename'
      ? direction === 'compensation'
        ? forwardSource
        : (forwardDestination ?? failNativeMutationBinding())
      : null;
  const compensationSource =
    postObservation === null
      ? null
      : operation.kind === 'rename'
        ? postObservation.destination
        : postObservation.source;
  const expectedSource =
    kind === 'add'
      ? ({ state: 'absent' } as const)
      : kind === 'mkdir'
        ? direction === 'forward'
          ? ({ state: 'absent' } as const)
          : compensationSource?.state !== 'present' ||
              compensationSource.revision.entryKind !== 'directory'
            ? failNativeMutationBinding()
            : ({
                state: 'present' as const,
                entryKind: 'directory' as const,
                identityDigest: compensationSource.revision.identityDigest,
              } as const)
        : direction === 'forward'
          ? operation.preRevision === null
            ? failNativeMutationBinding()
            : ({ state: 'present' as const, ...operation.preRevision } as const)
          : compensationSource?.state !== 'present' ||
              compensationSource.revision.entryKind === 'directory'
            ? failNativeMutationBinding()
            : ({
                state: 'present' as const,
                identityDigest: compensationSource.revision.identityDigest,
                contentHash: compensationSource.revision.contentHash,
                size: compensationSource.revision.size,
                mode: operation.preRevision?.mode ?? 0o100600,
                nlink: 1 as const,
              } as const);
  return {
    kind,
    artifact: expectedNativeMutationArtifact(operation, direction),
    sourceSegments,
    destinationSegments,
    expectedSource,
  };
}

function nativeIntentSagaObservation(
  intent: NativeMutationIntentSnapshot,
  observation: NonNullable<NativeMutationIntentSnapshot['effectObservation']>,
): OperationObservation {
  const endpoint = (
    value: NativeMutationIntentSnapshot['expectedSource'],
  ): OperationObservation['source'] =>
    value.state === 'absent'
      ? { state: 'absent' }
      : value.entryKind === 'directory'
        ? {
            state: 'present',
            revision: { entryKind: 'directory', identityDigest: value.identityDigest },
          }
        : {
            state: 'present',
            revision: {
              identityDigest: value.identityDigest,
              contentHash: value.contentHash,
              size: value.size,
            },
          };
  return intent.direction === 'compensation' && intent.kind === 'rename'
    ? { source: endpoint(observation.destination), destination: endpoint(observation.source) }
    : { source: endpoint(observation.source), destination: endpoint(observation.destination) };
}

function nativeRelativeSegments(workspacePath: string, canonicalPath: string): readonly string[] {
  const value = relative(workspacePath, canonicalPath);
  if (value.length === 0 || isAbsolute(value)) return failNativeMutationBinding();
  const segments = value.split(sep);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return failNativeMutationBinding();
  return segments;
}

function nativeExpectationMatchesBinding(
  actual: NativeMutationIntentSnapshot['expectedSource'],
  expected: ReturnType<typeof expectedNativeMutationBinding>['expectedSource'],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function failNativeMutationBinding(): never {
  throw new MutationLeaseStaleError();
}

function nativeMutationStepIsNext(
  saga: EditSagaSnapshot,
  ordinal: number,
  direction: NativeMutationIntentSnapshot['direction'],
  coordinator: NativeMutationSagaCoordinator,
): boolean {
  const index = ordinal - 1;
  const step = saga.steps[index];
  if (step === undefined) return false;
  if (direction === 'forward')
    return (
      (saga.state === 'prepared' || saga.state === 'applying') &&
      (coordinator === 'edit-saga-executor'
        ? step.state === 'effect_pending'
        : step.state === 'pending') &&
      saga.steps.slice(0, index).every((candidate) => candidate.state === 'effect_observed') &&
      saga.steps.slice(index + 1).every((candidate) => candidate.state === 'pending')
    );
  return (
    (saga.state === 'applying' || saga.state === 'compensating') &&
    (coordinator === 'edit-saga-executor'
      ? step.state === 'compensation_pending'
      : step.state === 'effect_observed') &&
    saga.steps
      .slice(index + 1)
      .every((candidate) => candidate.state === 'pending' || candidate.state === 'restored') &&
    !saga.steps.slice(0, index).some((candidate) => candidate.state === 'restored')
  );
}

function withoutEditSagaRevision(snapshot: EditSagaSnapshot): Omit<EditSagaSnapshot, 'revision'> {
  const { revision: _revision, ...rest } = snapshot;
  return rest;
}

function toUserFileSaveIntent(row: UserFileSaveIntentRow): UserFileSaveIntent {
  return Object.freeze({
    principal: row.principal,
    taskId: row.task_id,
    kind: row.kind,
    operationId: row.operation_id,
    requestHash: row.request_hash,
    rootId: row.root_id,
    rootLabel: row.root_label,
    path: row.path,
    baseDigest: row.base_digest,
    replacementDigest: row.replacement_digest,
    byteLength: row.byte_length,
    state: row.state,
  });
}

function withoutUserFileSaveState(intent: UserFileSaveIntent): Omit<UserFileSaveIntent, 'state'> {
  const { state: _state, ...facts } = intent;
  return facts;
}

function nextPersistenceTimestamp(previous: string): string {
  return new Date(Date.parse(previous) + 1).toISOString();
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateNativeSessionId(value: string): void {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new MutationLeaseStaleError();
}

function validateNativeMutationSagaCoordinator(value: string): void {
  if (value !== 'native-intent' && value !== 'edit-saga-executor')
    throw new MutationLeaseStaleError();
}

function validateMutationLeaseInput(input: {
  rootId: string | null;
  workspaceKey: string;
  rootIdentityDigest: string;
  holderInstanceId: string;
  taskId: string;
  turnId: string;
  sagaId: string;
  purpose: MutationLeasePurpose;
  policyEpoch: number;
  intentDigest: string;
  now: string;
  expiresAt: string;
}): void {
  if (input.rootId !== null) validateMutationIdentifier(input.rootId, 'root id');
  validateMutationDigest(input.workspaceKey, 'workspace mutation key');
  validateMutationDigest(input.rootIdentityDigest, 'workspace root identity digest');
  validateMutationDigest(input.intentDigest, 'mutation intent digest');
  validateMutationIdentifier(input.holderInstanceId, 'holder instance id');
  validateMutationIdentifier(input.taskId, 'task id');
  validateMutationIdentifier(input.turnId, 'turn id');
  validateMutationIdentifier(input.sagaId, 'saga id');
  if (!['forward', 'recovery'].includes(input.purpose)) throw new Error('Invalid lease purpose');
  if (!Number.isSafeInteger(input.policyEpoch) || input.policyEpoch < 0)
    throw new Error('Invalid mutation policy epoch');
  const now = validateMutationTimestamp(input.now, 'mutation lease acquisition time');
  const expiresAt = validateMutationTimestamp(input.expiresAt, 'mutation lease expiry');
  if (expiresAt <= now) throw new Error('Mutation lease expiry must be in the future');
}

function validateMutationToken(token: MutationLeaseToken): void {
  if (token.version !== 1) throw new MutationLeaseStaleError();
  validateMutationLeaseInput({ ...token, now: token.acquiredAt });
  validateMutationIdentifier(token.leaseId, 'mutation lease id');
  if (
    !Number.isSafeInteger(token.fence) ||
    token.fence < 1 ||
    !Number.isSafeInteger(token.revision) ||
    token.revision < 1
  )
    throw new MutationLeaseStaleError();
  validateMutationTimestamp(token.renewedAt, 'mutation lease renewal time');
}

function mutationLeaseToken(input: Omit<MutationLeaseToken, 'version'>): MutationLeaseToken {
  return Object.freeze({ version: 1, ...input });
}

function mutationTokenMatchesRow(token: MutationLeaseToken, row: WorkspaceMutationRow): boolean {
  return (
    row.state === 'held' &&
    row.workspace_key === token.workspaceKey &&
    row.root_identity_digest === token.rootIdentityDigest &&
    row.root_id === token.rootId &&
    row.lease_id === token.leaseId &&
    row.holder_instance_id === token.holderInstanceId &&
    row.task_id === token.taskId &&
    row.turn_id === token.turnId &&
    row.saga_id === token.sagaId &&
    row.purpose === token.purpose &&
    row.policy_epoch === token.policyEpoch &&
    row.intent_digest === token.intentDigest &&
    row.fence === token.fence &&
    row.revision === token.revision &&
    row.acquired_at === token.acquiredAt &&
    row.renewed_at === token.renewedAt &&
    row.expires_at === token.expiresAt
  );
}

function validateMutationIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200)
    throw new Error(`Invalid ${name}`);
}
