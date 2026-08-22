import { randomUUID } from 'node:crypto';
import type {
  EffectiveWorkspaceSet,
  FileChange,
  TurnEvent,
  TurnStage,
} from '@sprint-coder/contracts';
import type { PersistenceClient } from './persistence';
import type { PreparedContext } from './context-ledger';
import { digestCanonical } from './context-compiler';
import {
  createDeterministicMockSampler,
  runIntelligenceLoop,
  type IntelligenceStepRecorder,
} from './intelligence-loop';
import { createDefaultToolBroker, startMockTurnCatalog } from './default-tools';
import { ToolAuthorizationDeniedError, type ToolAuthorizer } from './tool-broker';
import type { ToolBroker } from './tool-broker';
import type { ManagedCodingHarness } from './provider-workspace-tools';
import type { TeamCoordinator } from './team-coordinator';
import { createTeamScenarioSampler, isTeamScenarioFixtureInput } from './team-tools';

type Publish = (event: TurnEvent) => void;
type Serialize = <T>(taskId: string, action: () => T) => Promise<T>;
type Terminal = (taskId: string, turnId: string, state: 'completed' | 'failed') => void;
type PrepareContext = (taskId: string, turnId: string) => PreparedContext | void;
type ContextAccepted = (
  taskId: string,
  turnId: string,
  fragmentIds: readonly string[],
  projectItemIds: readonly string[],
  projectSnapshotDigest: string | null,
) => void;
type ActiveTurn = {
  canceled: boolean;
  steering: string[];
  context: PreparedContext | undefined;
  abortController: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
};
type RuntimePersistence = Pick<PersistenceClient, 'changeStage' | 'appendDelta' | 'completeTurn'> &
  Partial<
    Pick<
      PersistenceClient,
      | 'getWorkspace'
      | 'getTask'
      | 'getTurnSkills'
      | 'getEffectiveWorkspaceSet'
      | 'readTurnWorkspaceSet'
      | 'getTurnWorkspaceRootIdentities'
      | 'getPermissionPolicy'
      | 'getAcceptanceContract'
      | 'createIntelligenceStep'
      | 'transitionIntelligenceStep'
      | 'listIntelligenceSteps'
      | 'prepareCommand'
      | 'beginCommand'
      | 'startCommand'
      | 'appendCommandOutput'
      | 'appendCommandOutputBatch'
      | 'completeCommand'
      | 'getCommand'
      | 'createBackgroundActivity'
      | 'transitionBackgroundActivity'
      | 'completeBackgroundActivity'
      | 'recordCommandVerification'
      | 'getTeamByTask'
      | 'recordFileChanges'
    >
  >;

const executionStages: TurnStage[] = ['understanding', 'planning', 'executing'];

export class MockRuntimeAdapter {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly toolBroker: ToolBroker;
  private readonly ownsToolBroker: boolean;

  constructor(
    private readonly persistence: RuntimePersistence,
    private readonly publish: Publish,
    private readonly delayMs = 240,
    private readonly serialize: Serialize = async (_taskId, action) => action(),
    private readonly terminal?: Terminal,
    private readonly prepareContext?: PrepareContext,
    authorizer?: ToolAuthorizer,
    private readonly contextAccepted?: ContextAccepted,
    // Leader team tools (Slice 5.2): only wired when the caller supplies a TeamCoordinator (see
    // IpcRouter) — real Codex/Claude adapters never construct MockRuntimeAdapter, so this stays
    // isolated to the mock/intelligence-loop path.
    private readonly teamCoordinator?: TeamCoordinator,
    // Pseudo-reasoning sink (issue #17). Mock is the ONLY runtime under
    // SPRINT_CODER_E2E_MODE=dev, so without this the reasoning panel is permanently empty in every
    // E2E run and the feature would be untestable end to end.
    private readonly emitReasoning?: (taskId: string, turnId: string, text: string) => void,
    // Pseudo live file bodies (issue #39), for the same reason as emitReasoning: mock is the only
    // runtime under SPRINT_CODER_E2E_MODE=dev, so the live edit view would be untestable without it.
    private readonly emitFileEdit?: (
      taskId: string,
      turnId: string,
      path: string,
      text: string,
      complete: boolean,
    ) => void,
    private readonly managedHarness?: ManagedCodingHarness,
  ) {
    this.ownsToolBroker = managedHarness === undefined;
    this.toolBroker =
      managedHarness?.broker ??
      createDefaultToolBroker(
        (taskId) => this.persistence.getPermissionPolicy?.(taskId).policyEpoch ?? 0,
        authorizer,
        {
          persistence: this.persistence as Pick<
            PersistenceClient,
            | 'readTurnWorkspaceSet'
            | 'getTurnWorkspaceRootIdentities'
            | 'prepareCommand'
            | 'beginCommand'
            | 'startCommand'
            | 'appendCommandOutput'
            | 'appendCommandOutputBatch'
            | 'completeCommand'
            | 'getCommand'
            | 'createBackgroundActivity'
            | 'transitionBackgroundActivity'
            | 'completeBackgroundActivity'
            | 'recordCommandVerification'
          >,
          publish: this.publish,
        },
        this.teamCoordinator === undefined ? undefined : { coordinator: this.teamCoordinator },
      );
  }

  start(taskId: string, turnId: string, input: string, teamTurn = false): void {
    const context = this.prepareContext?.(taskId, turnId);
    if (context !== undefined)
      this.contextAccepted?.(
        taskId,
        turnId,
        context.fragments.map((fragment) => fragment.id),
        context.projectItems.map((item) => item.id),
        context.projectSnapshotDigest,
      );
    let resolveSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const control: ActiveTurn = {
      canceled: false,
      steering: [],
      context: context === undefined ? undefined : context,
      abortController: new AbortController(),
      settled,
      resolveSettled,
    };
    this.active.set(turnId, control);
    void this.run(taskId, turnId, input, control, teamTurn);
  }

  steer(turnId: string, text: string): void {
    const control = this.active.get(turnId);
    if (control !== undefined) control.steering.push(text);
  }

  async cancel(turnId: string): Promise<void> {
    const control = this.active.get(turnId);
    if (control !== undefined) {
      control.canceled = true;
      control.abortController.abort();
      await control.settled;
    }
  }

  async dispose(): Promise<void> {
    const settlements = [...this.active.values()].map((control) => control.settled);
    for (const control of this.active.values()) {
      control.canceled = true;
      control.abortController.abort();
    }
    await Promise.all([
      ...(this.ownsToolBroker ? [this.toolBroker.dispose()] : []),
      ...settlements,
    ]);
  }

  private async run(
    taskId: string,
    turnId: string,
    input: string,
    control: ActiveTurn,
    teamTurn: boolean,
  ): Promise<void> {
    try {
      for (const stage of executionStages) {
        await pause(this.delayMs);
        if (control.canceled) return;
        await this.serialize(taskId, () =>
          this.publish(this.persistence.changeStage(taskId, turnId, stage)),
        );
        // Reasoning during understanding/planning only, matching where a real model produces it —
        // Claude's thinking blocks arrive before the answer, never interleaved with it.
        if (stage === 'understanding' || stage === 'planning')
          for (const fragment of mockReasoning(stage, input)) {
            await pause(Math.max(12, Math.floor(this.delayMs / 8)));
            if (control.canceled) return;
            this.emitReasoning?.(taskId, turnId, fragment);
          }
      }

      const effectiveWorkspace = this.persistence.getEffectiveWorkspaceSet?.(taskId);
      const workspaceBinding = mockWorkspaceBinding(
        this.persistence.getWorkspace?.(taskId) ?? null,
        effectiveWorkspace,
      );
      const policyEpoch = this.persistence.getPermissionPolicy?.(taskId).policyEpoch ?? 0;
      // Pseudo file changes (issue #37). Mock is the ONLY runtime under SPRINT_CODER_E2E_MODE=dev,
      // so without this the timeline and replay-after-restart edit path has no producer in any E2E
      // run. Gated on exactly the two conditions Main uses for a real
      // Runtime (see write-scope.ts), so the mock cannot report an edit in a configuration where a
      // real Runtime would have been refused one.
      if (
        workspaceBinding.workspaceId !== null &&
        (this.persistence.getPermissionPolicy?.(taskId).preset ?? 'ask') !== 'ask'
      ) {
        const primaryRoot = effectiveWorkspace?.roots.find(
          ({ rootId }) => rootId === effectiveWorkspace.primaryRootId,
        );
        const changes = mockFileChanges(
          input,
          primaryRoot === undefined
            ? undefined
            : { rootId: primaryRoot.rootId, rootLabel: primaryRoot.label },
        );
        // Stream each body before recording the change, in that order, because that is the order a
        // real Runtime produces them in: the file is written, then reported (issue #39). An E2E
        // that saw the summary first would be asserting on a sequence the real thing never emits.
        for (const change of changes) {
          const body = mockFileBody(change.path);
          for (const upto of streamingPrefixes(body)) {
            await pause(Math.max(8, Math.floor(this.delayMs / 12)));
            if (control.canceled) return;
            this.emitFileEdit?.(taskId, turnId, change.path, upto, upto.length === body.length);
          }
        }
        await this.serialize(taskId, () => {
          const event = this.persistence.recordFileChanges?.({ taskId, turnId, changes });
          if (event !== undefined && event !== null) this.publish(event);
        });
      }
      const workspaceId = workspaceBinding.workspaceId;
      const contractRevision =
        this.persistence.getAcceptanceContract?.(taskId, turnId).revision ?? null;
      const toolContext = { taskId, turnId, workspaceId, policyEpoch } as const;
      const turnSkills = this.persistence.getTurnSkills?.(taskId, turnId) ?? [];
      const skillCreatorTurn = turnSkills.some(
        ({ selection }) =>
          selection.ref.source === 'builtin' && selection.ref.skillId === 'skill-creator',
      );
      const teamFixtureActive =
        this.teamCoordinator !== undefined && isTeamScenarioFixtureInput(input);
      const toolCatalogSnapshot =
        this.managedHarness?.startTurn(toolContext, 'mock', {
          projectMemory: (this.persistence.getTask?.(taskId)?.projectId ?? null) !== null,
          skillDrafts: skillCreatorTurn,
          ...(input.includes('承認テスト')
            ? { mockFixture: 'approval' as const }
            : input.includes('コマンドテスト')
              ? { mockFixture: 'command' as const }
              : {}),
          ...(teamFixtureActive ? { mockTeamFixture: true } : {}),
        }) ?? startMockTurnCatalog(this.toolBroker, toolContext);
      const recorder = intelligenceRecorder(this.persistence, this.serialize, taskId);
      // The fixed three-Worker orchestration is an E2E fixture, never a fallback for a natural
      // Team request. Mock cannot interpret arbitrary Team operations such as reading a
      // conversation or changing a member, so those requests fail closed with a truthful reply.
      const mockReply = teamTurn
        ? 'この実行環境では組み込みTeam Skillを利用できないため、Team操作を開始できません。架空のメンバーや別のsubagentには置き換えていません。CodexまたはClaude Runtimeで再試行してください。'
        : buildReply(input);
      const mockMode =
        this.managedHarness !== undefined &&
        !input.includes('承認テスト') &&
        !input.includes('コマンドテスト')
          ? ('answer-only' as const)
          : ('mock-tool' as const);
      const loop = await runIntelligenceLoop({
        taskId,
        turnId,
        fragments: control.context?.fragments ?? [],
        projectItems: control.context?.projectItems ?? [],
        model: 'mock-v1',
        effort: 'low',
        policyEpoch,
        workspaceRevision: workspaceBinding.workspaceRevision,
        contractRevision,
        toolCatalogSnapshot,
        sample: teamFixtureActive
          ? createTeamScenarioSampler(input)
          : createDeterministicMockSampler(input, mockReply, mockMode),
        executeTool: async (call) => {
          let result: unknown;
          try {
            result = await this.toolBroker.dispatch({
              taskId,
              turnId,
              callId: call.callId,
              providerName: call.toolName,
              input: call.arguments,
              signal: control.abortController.signal,
            });
          } catch (error) {
            if (error instanceof ToolAuthorizationDeniedError)
              return {
                ok: false,
                code: 'PERMISSION_DENIED',
                content: `ツール実行は拒否されました: ${error.authorization.reason}`,
              };
            throw error;
          }
          return typeof result === 'string' ? result : JSON.stringify(result);
        },
        ...(recorder === undefined ? {} : { recorder }),
      });
      const messageId = randomUUID();
      await this.serialize(taskId, () =>
        this.publish(this.persistence.changeStage(taskId, turnId, 'synthesizing')),
      );
      const chunks = chunkReply(loop.text);
      while (chunks.length > 0 || control.steering.length > 0) {
        if (chunks.length === 0) {
          const instruction = control.steering.shift();
          if (instruction !== undefined)
            chunks.push(...chunkReply(`\n\n追加指示を反映しました: ${instruction}`));
        }
        const delta = chunks.shift();
        if (delta === undefined) continue;
        await pause(Math.max(12, Math.floor(this.delayMs / 4)));
        if (control.canceled) return;
        await this.serialize(taskId, () =>
          this.publish(this.persistence.appendDelta(taskId, turnId, messageId, delta)),
        );
      }
      if (!control.canceled) await this.finish(taskId, turnId, 'completed');
    } catch {
      if (!control.canceled) {
        try {
          await this.finish(taskId, turnId, 'failed');
        } catch {
          /* already terminal */
        }
      }
    } finally {
      if (this.managedHarness !== undefined) this.managedHarness.finishTurn(taskId, turnId);
      else this.toolBroker.finishTurn(taskId, turnId);
      this.active.delete(turnId);
      control.resolveSettled();
    }
  }

  private async finish(
    taskId: string,
    turnId: string,
    state: 'completed' | 'failed',
  ): Promise<void> {
    await this.serialize(taskId, () => {
      if (this.terminal !== undefined) this.terminal(taskId, turnId, state);
      else this.publish(this.persistence.completeTurn(taskId, turnId, state));
    });
  }
}

function intelligenceRecorder(
  persistence: RuntimePersistence,
  serialize: Serialize,
  taskId: string,
): IntelligenceStepRecorder | undefined {
  const create = persistence.createIntelligenceStep;
  const transition = persistence.transitionIntelligenceStep;
  if (create === undefined || transition === undefined) return undefined;
  return {
    createIntelligenceStep: (input) => serialize(taskId, () => create.call(persistence, input)),
    transitionIntelligenceStep: (stepId, state) =>
      serialize(taskId, () => transition.call(persistence, stepId, state)),
  };
}

/**
 * Deterministic stand-in for a file body, keyed by its path so a given path always yields the same
 * content — an E2E asserting on a line needs that to be stable.
 */
export function mockFileBody(path: string): string {
  const name = path.replace(/^.*\//, '').replace(/\.[^.]*$/, '');
  return [
    // Says what it is on the first line (issue #50). The previous body was plausible TypeScript with
    // nothing marking it as a stand-in, so a live edit view full of it read as the app working
    // rather than as a placeholder — which is exactly how it was misread.
    `// Mock Runtimeが生成した内容です。実際のAIは動いていません。`,
    `// Runtimeを Codex か Claude に切り替えると本物の出力になります。`,
    `// ${path}`,
    `export function ${name.replace(/[^A-Za-z0-9]/g, '_')}(value: string): string {`,
    '  const trimmed = value.trim();',
    '  if (trimmed.length === 0) return "";',
    '  return trimmed.toUpperCase();',
    '}',
    '',
  ].join('\n');
}

/** The prefixes a body is revealed through, mimicking a model emitting it a chunk at a time. */
function streamingPrefixes(body: string): string[] {
  const step = Math.max(8, Math.ceil(body.length / 6));
  const prefixes: string[] = [];
  for (let end = step; end < body.length; end += step) prefixes.push(body.slice(0, end));
  prefixes.push(body);
  return prefixes;
}

/**
 * Deterministic stand-in for the files a model would have edited.
 *
 * Derived from the input so a given prompt always yields the same paths — an E2E that asserts on a
 * filename needs that to be stable, and a random path would make the assertion flaky rather than the
 * feature. Always relative and always inside the Workspace, exactly like the real path Main lets
 * through.
 */
export function mockFileChanges(
  input: string,
  root: { rootId: string; rootLabel: string } = {
    rootId: 'legacy-primary',
    rootLabel: 'Workspace',
  },
): FileChange[] {
  const slug = (input.match(/[A-Za-z0-9_-]{3,24}/)?.[0] ?? 'note').toLowerCase();
  return [
    {
      rootId: root.rootId,
      rootLabel: root.rootLabel,
      path: `src/${slug}.ts`,
      kind: 'update',
    },
    {
      rootId: root.rootId,
      rootLabel: root.rootLabel,
      path: `src/${slug}.test.ts`,
      kind: 'add',
    },
  ];
}

export function mockWorkspaceBinding(
  legacyWorkspacePath: string | null,
  effective?: EffectiveWorkspaceSet,
): { workspaceId: string | null; workspaceRevision: string } {
  if (effective !== undefined && effective.roots.length > 0) {
    const workspaceId = digestCanonical({ effectiveWorkspaceDigest: effective.digest });
    return { workspaceId, workspaceRevision: `effective:${effective.digest}` };
  }
  const workspaceId =
    legacyWorkspacePath === null ? null : digestCanonical({ workspacePath: legacyWorkspacePath });
  return {
    workspaceId,
    workspaceRevision: `untracked:${digestCanonical({ workspacePath: legacyWorkspacePath })}`,
  };
}

/**
 * Deterministic stand-in for a model's reasoning.
 *
 * Two paragraphs per stage, emitted as several fragments each, so the renderer's paragraph-boundary
 * animation and its coalescing both get exercised — a single blob would make the panel look right
 * while proving nothing about the streaming path.
 */
function mockReasoning(stage: 'understanding' | 'planning', input: string): string[] {
  const excerpt = input.replace(/\s+/g, ' ').trim().slice(0, 40);
  const paragraphs =
    stage === 'understanding'
      ? [`「${excerpt}」という依頼として読み取りました。`, '前提と制約を洗い出しています。\n\n']
      : [
          '手順を組み立てています。まず確認、次に変更、最後に検証。',
          '想定される失敗も見ています。\n\n',
        ];
  // Split each paragraph into a few fragments, the way a real delta stream arrives.
  return paragraphs.flatMap((paragraph) => {
    const size = Math.max(4, Math.ceil(Array.from(paragraph).length / 4));
    const characters = Array.from(paragraph);
    const fragments: string[] = [];
    for (let index = 0; index < characters.length; index += size)
      fragments.push(characters.slice(index, index + size).join(''));
    return fragments;
  });
}

function buildReply(input: string): string {
  const excerpt = input.replace(/\s+/g, ' ').trim().slice(0, 160);
  return (
    `「${excerpt}」について受け取りました。これはChat Alphaの決定論的なモック応答です。` +
    '依頼内容を理解し、方針を整理し、実行段階を確認したうえで回答をまとめました。' +
    '現在は外部AIやツールを呼び出しておらず、同じ入力には常に同じ本文を返します。' +
    'ストリーミング、中止、永続化、再起動後の復元を安全に確認できます。'
  );
}

function chunkReply(reply: string): string[] {
  const characters = Array.from(reply);
  const chunkSize = Math.max(1, Math.ceil(characters.length / 32));
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += chunkSize)
    chunks.push(characters.slice(index, index + chunkSize).join(''));
  return chunks;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
