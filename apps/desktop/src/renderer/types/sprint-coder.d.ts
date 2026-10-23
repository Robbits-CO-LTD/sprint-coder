import type { ApprovalSummary, SprintCoderApi, TurnSnapshot } from '@sprint-coder/contracts';

// Main and Preload own the IPC contract. Re-export it so Renderer consumers see schema changes.
export type {
  GoalSummary,
  TaskSummary,
  ProjectSummary,
  ProjectFolder,
  ProjectFolderInput,
  EffectiveWorkspaceSet,
  ProjectReference,
  ProjectMemory,
  ChatMessage,
  ImageAttachmentMetadata,
  ImageAttachmentCapability,
  ImageAttachmentPreview,
  ApprovalDecision,
  ApprovalSummary,
  AutoPermissionDecision,
  QueuedInput,
  CommandSummary,
  CommandOutputRecord,
  CommandOutputPage,
  ContextUsage,
  ProjectInstruction,
  ProjectContextManifestSummary,
  ProjectContextManifest,
  TurnDiffEntry,
  TurnDiff,
  GeneratedImage,
  FileChange,
  FileChangeRecord,
  FileOpenResult,
  FileSaveResult,
  FileEditFrame,
  TurnEvent,
  TurnSnapshot,
  RuntimeKind,
  ReasoningBatch,
  DatabaseRecovery,
  CommandSandboxCapability,
  RuntimeConnectionState,
  RuntimeStatus,
  UpdateHealth,
  UpdateCheckResult,
  EffortOption,
  CodexModelOption,
  ClaudeEffort,
  AccessPreset,
  PermissionSettings,
  TeamPolicy,
  TeamSummary,
  TeamUsageTotals,
  ManagerPolicy,
  WorkerSummary,
  WorkerActivityEntry,
  TeamMessageSummary,
  TeamExecutionSummary,
  TeamActivitySummary,
  TeamMissionCheckpoint,
  TeamMissionWorktreeSummary,
  TeamExecutionIsolation,
  TeamMissionSummary,
  TeamRetainedWorktree,
  TeamRetainedWorktreeList,
  TeamRetainedWorktreeInspection,
  TeamRetainedWorktreeRef,
  TeamDetail,
  CanvasCamera,
  CanvasNodePosition,
  CanvasView,
  CanvasViewSaveInput,
  CanvasViewSaveResult,
  SprintCoderApi,
} from '@sprint-coder/contracts';

export type Capability = ApprovalSummary['capability'];

// Display state includes the synthetic approval wait carried by snapshots, unlike stage events.
export type TurnStage = NonNullable<TurnSnapshot['activeTurn']>['stage'];

// Rejected IPC promises can carry unknown codes; keep accepting them for compatibility.
export type SprintCoderErrorCode = import('@sprint-coder/contracts').PublicErrorCode | string;

declare global {
  interface Window {
    sprintCoder?: SprintCoderApi;
  }
}
