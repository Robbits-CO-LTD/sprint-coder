import { randomUUID } from 'node:crypto';
import type { TurnEvent, TurnStage } from '@vibe/contracts';
import type { PersistenceClient } from './persistence';
import type { PreparedContext } from './context-ledger';
import { digestCanonical } from './context-compiler';
import {
  createDeterministicMockSampler,
  deterministicMockToolExecutor,
  runIntelligenceLoop,
  type IntelligenceStepRecorder,
} from './intelligence-loop';

type Publish = (event: TurnEvent) => void;
type Serialize = <T>(taskId: string, action: () => T) => Promise<T>;
type Terminal = (taskId: string, turnId: string, state: 'completed' | 'failed') => void;
type PrepareContext = (taskId: string, turnId: string) => PreparedContext | void;
type ActiveTurn = { canceled: boolean; steering: string[]; context: PreparedContext | undefined };
type RuntimePersistence = Pick<PersistenceClient, 'changeStage' | 'appendDelta' | 'completeTurn'> &
  Partial<
    Pick<
      PersistenceClient,
      | 'getWorkspace'
      | 'getPermissionPolicy'
      | 'createIntelligenceStep'
      | 'transitionIntelligenceStep'
      | 'listIntelligenceSteps'
    >
  >;

const stages: TurnStage[] = ['understanding', 'planning', 'executing', 'synthesizing'];

export class MockRuntimeAdapter {
  private readonly active = new Map<string, ActiveTurn>();

  constructor(
    private readonly persistence: RuntimePersistence,
    private readonly publish: Publish,
    private readonly delayMs = 240,
    private readonly serialize: Serialize = async (_taskId, action) => action(),
    private readonly terminal?: Terminal,
    private readonly prepareContext?: PrepareContext,
  ) {}

  start(taskId: string, turnId: string, input: string): void {
    const context = this.prepareContext?.(taskId, turnId);
    const control: ActiveTurn = {
      canceled: false,
      steering: [],
      context: context === undefined ? undefined : context,
    };
    this.active.set(turnId, control);
    void this.run(taskId, turnId, input, control);
  }

  steer(turnId: string, text: string): void {
    const control = this.active.get(turnId);
    if (control !== undefined) control.steering.push(text);
  }

  cancel(turnId: string): void {
    const control = this.active.get(turnId);
    if (control !== undefined) control.canceled = true;
  }

  private async run(
    taskId: string,
    turnId: string,
    input: string,
    control: ActiveTurn,
  ): Promise<void> {
    try {
      for (const stage of stages) {
        await pause(this.delayMs);
        if (control.canceled) return;
        await this.serialize(taskId, () =>
          this.publish(this.persistence.changeStage(taskId, turnId, stage)),
        );
      }

      const workspacePath = this.persistence.getWorkspace?.(taskId) ?? null;
      const policyEpoch = this.persistence.getPermissionPolicy?.(taskId).policyEpoch ?? 0;
      const recorder = intelligenceRecorder(this.persistence, this.serialize, taskId);
      const loop = await runIntelligenceLoop({
        taskId,
        turnId,
        fragments: control.context?.fragments ?? [],
        model: 'mock-v1',
        effort: 'low',
        policyEpoch,
        workspaceRevision: `untracked:${digestCanonical({ workspacePath })}`,
        contractRevision: null,
        sample: createDeterministicMockSampler(input, buildReply(input)),
        executeTool: deterministicMockToolExecutor,
        ...(recorder === undefined ? {} : { recorder }),
      });
      const messageId = randomUUID();
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
      this.active.delete(turnId);
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
