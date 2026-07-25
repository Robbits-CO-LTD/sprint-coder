import { randomUUID } from 'node:crypto';
import type { TurnEvent, TurnStage } from '@sprint-coder/contracts';
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
import type { TeamCoordinator } from './team-coordinator';
import { createTeamScenarioSampler, isTeamScenarioInput } from './team-tools';

type Publish = (event: TurnEvent) => void;
type Serialize = <T>(taskId: string, action: () => T) => Promise<T>;
type Terminal = (taskId: string, turnId: string, state: 'completed' | 'failed') => void;
type PrepareContext = (taskId: string, turnId: string) => PreparedContext | void;
type ContextAccepted = (taskId: string, turnId: string, fragmentIds: readonly string[]) => void;
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
      | 'getTeamByTask'
    >
  >;

const executionStages: TurnStage[] = ['understanding', 'planning', 'executing'];

export class MockRuntimeAdapter {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly toolBroker;

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
  ) {
    this.toolBroker = createDefaultToolBroker(
      (taskId) => this.persistence.getPermissionPolicy?.(taskId).policyEpoch ?? 0,
      authorizer,
      {
        persistence: this.persistence as Pick<
          PersistenceClient,
          | 'getWorkspace'
          | 'prepareCommand'
          | 'beginCommand'
          | 'startCommand'
          | 'appendCommandOutput'
          | 'appendCommandOutputBatch'
          | 'completeCommand'
          | 'getCommand'
        >,
        publish: this.publish,
      },
      this.teamCoordinator === undefined ? undefined : { coordinator: this.teamCoordinator },
    );
  }

  start(taskId: string, turnId: string, input: string): void {
    const context = this.prepareContext?.(taskId, turnId);
    if (context !== undefined)
      this.contextAccepted?.(
        taskId,
        turnId,
        context.fragments.map((fragment) => fragment.id),
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
    void this.run(taskId, turnId, input, control);
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
    await Promise.all([this.toolBroker.dispose(), ...settlements]);
  }

  private async run(
    taskId: string,
    turnId: string,
    input: string,
    control: ActiveTurn,
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

      const workspacePath = this.persistence.getWorkspace?.(taskId) ?? null;
      const policyEpoch = this.persistence.getPermissionPolicy?.(taskId).policyEpoch ?? 0;
      const workspaceId = workspacePath === null ? null : digestCanonical({ workspacePath });
      const contractRevision =
        this.persistence.getAcceptanceContract?.(taskId, turnId).revision ?? null;
      const toolContext = { taskId, turnId, workspaceId, policyEpoch } as const;
      const toolCatalogSnapshot = startMockTurnCatalog(this.toolBroker, toolContext);
      const recorder = intelligenceRecorder(this.persistence, this.serialize, taskId);
      // Team mode is active when a Team already exists for this Task (created via teams.promote
      // or a prior hire) or the input carries the fixture trigger — only meaningful when a
      // TeamCoordinator was actually wired in, since otherwise the team_* tools aren't registered.
      const teamScenarioActive =
        this.teamCoordinator !== undefined &&
        ((this.persistence.getTeamByTask?.(taskId) ?? null) !== null || isTeamScenarioInput(input));
      const loop = await runIntelligenceLoop({
        taskId,
        turnId,
        fragments: control.context?.fragments ?? [],
        model: 'mock-v1',
        effort: 'low',
        policyEpoch,
        workspaceRevision: `untracked:${digestCanonical({ workspacePath })}`,
        contractRevision,
        toolCatalogSnapshot,
        sample: teamScenarioActive
          ? createTeamScenarioSampler(input)
          : createDeterministicMockSampler(input, buildReply(input)),
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
      this.toolBroker.finishTurn(taskId, turnId);
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
