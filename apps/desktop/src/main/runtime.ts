import { randomUUID } from 'node:crypto';
import type { TurnEvent, TurnStage } from '@vibe/contracts';
import type { PersistenceClient } from './persistence';

type Publish = (event: TurnEvent) => void;
type ActiveTurn = { canceled: boolean };

const stages: TurnStage[] = ['understanding', 'planning', 'executing', 'synthesizing'];

export class MockRuntimeAdapter {
  private readonly active = new Map<string, ActiveTurn>();

  constructor(
    private readonly persistence: PersistenceClient,
    private readonly publish: Publish,
    private readonly delayMs = 240,
  ) {}

  start(taskId: string, turnId: string, input: string): void {
    const control: ActiveTurn = { canceled: false };
    this.active.set(turnId, control);
    void this.run(taskId, turnId, input, control);
  }

  cancel(taskId: string, turnId: string): void {
    const control = this.active.get(turnId);
    if (control !== undefined) control.canceled = true;
    const event = this.persistence.cancelTurn(taskId, turnId);
    if (event !== null) this.publish(event);
    this.active.delete(turnId);
  }

  private async run(taskId: string, turnId: string, input: string, control: ActiveTurn): Promise<void> {
    try {
      for (const stage of stages) {
        await pause(this.delayMs);
        if (control.canceled) return;
        this.publish(this.persistence.changeStage(taskId, turnId, stage));
      }

      const messageId = randomUUID();
      for (const delta of chunkReply(buildReply(input))) {
        await pause(Math.max(12, Math.floor(this.delayMs / 4)));
        if (control.canceled) return;
        this.publish(this.persistence.appendDelta(taskId, turnId, messageId, delta));
      }
      if (!control.canceled) this.publish(this.persistence.completeTurn(taskId, turnId, 'completed'));
    } catch {
      if (!control.canceled) {
        try { this.publish(this.persistence.completeTurn(taskId, turnId, 'failed')); } catch { /* already terminal */ }
      }
    } finally {
      this.active.delete(turnId);
    }
  }
}

function buildReply(input: string): string {
  const excerpt = input.replace(/\s+/g, ' ').trim().slice(0, 160);
  return `「${excerpt}」について受け取りました。これはChat Alphaの決定論的なモック応答です。` +
    '依頼内容を理解し、方針を整理し、実行段階を確認したうえで回答をまとめました。' +
    '現在は外部AIやツールを呼び出しておらず、同じ入力には常に同じ本文を返します。' +
    'ストリーミング、中止、永続化、再起動後の復元を安全に確認できます。';
}

function chunkReply(reply: string): string[] {
  const characters = Array.from(reply);
  const chunkSize = Math.max(1, Math.ceil(characters.length / 32));
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += chunkSize) {
    chunks.push(characters.slice(index, index + chunkSize).join(''));
  }
  return chunks;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
