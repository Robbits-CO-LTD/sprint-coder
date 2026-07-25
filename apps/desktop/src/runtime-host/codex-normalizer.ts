import { randomUUID } from 'node:crypto';
import type { TurnStage } from '@sprint-coder/contracts';
import type { RuntimeCanonicalEvent } from './protocol';

const stages: TurnStage[] = ['understanding', 'planning', 'executing', 'synthesizing'];

/**
 * Codex thread ids are UUIDs (verified against codex-cli 0.144.4, where the id matches the
 * `generated_images/<id>` directory name exactly).
 *
 * Validated here, at the source, rather than only in `isRuntimeCanonicalEvent`: Main interpolates
 * this value into a filesystem path, and a normalizer that can emit something the protocol then
 * rejects is a latent bug — the event would be dropped silently and images would stop appearing for
 * no visible reason.
 */
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ApprovalRequestedError extends Error {}
export class CodexOutputError extends Error {}

export class CodexJsonlNormalizer {
  private stageIndex = -1;
  private readonly messageId = randomUUID();
  private completed = false;

  push(line: string): RuntimeCanonicalEvent[] {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CodexOutputError('Codex emitted unparsable JSONL output');
    }
    if (!isRecord(value) || typeof value['type'] !== 'string')
      throw new CodexOutputError('Codex emitted an invalid JSONL event');

    const type = value['type'];
    if (type.includes('approval') || type.includes('human_input'))
      throw new ApprovalRequestedError('Codex requested approval in non-interactive mode');
    if (type === 'error' || type === 'turn.failed')
      throw new CodexOutputError(readString(value, 'message') ?? 'Codex reported a failed turn');
    // Codex's own thread id, the bounded handle Main uses to find generated images (issue #11).
    // Emitted from this structured event and never scraped out of an agent message.
    if (type === 'thread.started') {
      const threadId = readString(value, 'thread_id');
      return threadId === null || !THREAD_ID_PATTERN.test(threadId)
        ? []
        : [{ type: 'thread', threadId }];
    }
    if (type === 'turn.started') return this.advanceTo('understanding');
    if (type === 'turn.completed') {
      if (this.completed) return [];
      this.completed = true;
      return [...this.advanceTo('synthesizing'), { type: 'completed' }];
    }

    const item = isRecord(value['item']) ? value['item'] : value;
    const itemType = readString(item, 'type') ?? type;
    if (isApprovalItem(itemType))
      throw new ApprovalRequestedError('Codex requested approval in non-interactive mode');
    if (isPlanningItem(itemType)) {
      // Codex's reasoning text, which was being discarded along with the stage transition
      // (issue #17). Same canonical event as Claude's thinking_delta, so the renderer sees one
      // stream regardless of provider — the granularity and register differ between the two, and
      // that difference is shown rather than smoothed over: hiding it would leave the user unable to
      // tell which model's reasoning they are reading.
      const text = extractText(value, item);
      const stageEvents = this.advanceTo('planning');
      return text === null || text.length === 0
        ? stageEvents
        : [...stageEvents, { type: 'reasoning', text }];
    }
    if (isExecutingItem(itemType)) return this.advanceTo('executing');
    if (isAssistantItem(itemType, type)) {
      const delta = extractText(value, item);
      if (delta === null || delta.length === 0) return [];
      return [
        ...this.advanceTo('synthesizing'),
        { type: 'delta', messageId: this.messageId, delta },
      ];
    }
    return [];
  }

  private advanceTo(target: TurnStage): RuntimeCanonicalEvent[] {
    const targetIndex = stages.indexOf(target);
    const events: RuntimeCanonicalEvent[] = [];
    while (this.stageIndex < targetIndex) {
      this.stageIndex += 1;
      const stage = stages[this.stageIndex];
      if (stage !== undefined) events.push({ type: 'stage', stage });
    }
    return events;
  }
}

function isPlanningItem(type: string): boolean {
  return type.includes('reasoning') || type.includes('thinking') || type.includes('plan');
}

function isExecutingItem(type: string): boolean {
  return (
    type.includes('command') ||
    type.includes('tool') ||
    type.includes('web_search') ||
    type.includes('file_')
  );
}

function isAssistantItem(itemType: string, eventType: string): boolean {
  return (
    itemType === 'agent_message' ||
    itemType === 'assistant_message' ||
    eventType.includes('output_text.delta') ||
    eventType.includes('agent_message.delta')
  );
}

function isApprovalItem(type: string): boolean {
  return type.includes('approval') || type.includes('human_input');
}

function extractText(event: Record<string, unknown>, item: Record<string, unknown>): string | null {
  return (
    readString(event, 'delta') ??
    readString(item, 'delta') ??
    readString(item, 'text') ??
    readString(event, 'text')
  );
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === 'string' ? item : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
