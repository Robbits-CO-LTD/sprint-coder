import { describe, expect, it } from 'vitest';
import {
  applyTeamDetailPatch,
  teamEventSchema,
  type TeamDetail,
  type TeamEvent,
} from '@sprint-coder/contracts';
import {
  fixtureMessage,
  fixtureWorker,
  largeTeamDetail,
} from '../../../../packages/contracts/src/team-detail-fixture';
import { TeamDetailStream } from './team-detail-stream';
import { TeamSubscriptionRegistry } from './team-subscription-registry';

const taskId = 'task-0000';

/** A Renderer-side reader: holds what the events built, like the store does. */
function reader() {
  let detail: TeamDetail | null = null;
  let seq = 0;
  return {
    start(snapshot: { seq: number; detail: TeamDetail | null }) {
      detail = snapshot.detail;
      seq = snapshot.seq;
    },
    receive(event: TeamEvent) {
      if (event.type === 'snapshot' || event.seq <= seq) return;
      expect(event.seq).toBe(seq + 1);
      seq = event.seq;
      detail = event.type === 'updated' ? event.detail : applyTeamDetailPatch(detail!, event.patch);
    },
    get detail() {
      return detail;
    },
  };
}

function streamWithLog() {
  const sent: TeamEvent[] = [];
  const stream = new TeamDetailStream(new TeamSubscriptionRegistry(), (_taskId, event) => {
    // What ipc.ts sends: validated, then copied across the process boundary.
    sent.push(structuredClone(teamEventSchema.parse(event)));
  });
  return { stream, sent };
}

describe('TeamDetailStream (issue #863)', () => {
  it('keeps the IPC of 32 streaming Workers within a bounded number of bytes per second', () => {
    const { stream, sent } = streamWithLog();
    let detail = largeTeamDetail(32, 20_000);
    const subscriber = reader();
    subscriber.start(stream.subscribe(taskId, 'subscription-1', detail));
    const fullBytes = Buffer.byteLength(JSON.stringify(detail));
    // Ten seconds of the coalesced progress publishes (4 per second), every Worker writing about
    // 100 characters and changing its stage each time, plus a state change every second.
    const seconds = 10;
    for (let tick = 1; tick <= seconds * 4; tick += 1) {
      detail = structuredClone(detail);
      for (const worker of detail.workers.slice(1)) {
        worker.liveOutput = `${worker.liveOutput}${`line ${tick} `.repeat(10)}`.slice(-20_000);
        worker.currentActivity = `step ${tick}`;
        worker.updatedAt = new Date(Date.UTC(2026, 9, 18, 0, 0, tick)).toISOString();
      }
      if (tick % 4 === 0) {
        detail.messages.push(fixtureMessage(detail.messages.length + 1, tick % 32 || 1, false));
        detail.executions[tick % 32]!.state = 'completed';
      }
      stream.publish(taskId, detail);
    }
    const bytes = sent.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    const bytesPerSecond = bytes / seconds;
    // A whole detail per publish was about 1 MB, so 4 MB per second; the patches stay far below.
    expect(fullBytes).toBeGreaterThan(900_000);
    expect(bytesPerSecond).toBeLessThan(160_000);
    expect(sent.every(({ type }) => type === 'patched')).toBe(true);
    for (const event of sent) subscriber.receive(event);
    expect(subscriber.detail).toEqual(detail);
  });

  it('sends the first event as a whole detail and nothing for an unchanged detail', () => {
    const { stream, sent } = streamWithLog();
    const subscriber = reader();
    subscriber.start(stream.subscribe(taskId, 'subscription-1', null));
    const detail = largeTeamDetail(2, 10);
    stream.publish(taskId, detail);
    stream.publish(taskId, structuredClone(detail));
    expect(sent.map(({ type }) => type)).toEqual(['updated']);
    subscriber.receive(sent[0]!);
    expect(subscriber.detail).toEqual(detail);
  });

  it('brings earlier subscribers to the detail a new subscriber starts from', () => {
    const { stream, sent } = streamWithLog();
    let detail = largeTeamDetail(3, 10);
    const first = reader();
    first.start(stream.subscribe(taskId, 'subscription-1', detail));
    // The Team changes without a publish (only the later read sees it), then a second view opens.
    detail = structuredClone(detail);
    detail.workers.push(fixtureWorker(9, 'hired'));
    const second = reader();
    second.start(stream.subscribe(taskId, 'subscription-2', detail));
    for (const event of sent) first.receive(event);
    expect(first.detail).toEqual(detail);
    // A change and its reversal must reach both: the base is the same for every subscriber.
    const changed = structuredClone(detail);
    changed.workers[1]!.state = 'done';
    stream.publish(taskId, changed);
    stream.publish(taskId, detail);
    for (const event of sent) {
      first.receive(event);
      second.receive(event);
    }
    expect(first.detail).toEqual(detail);
    expect(second.detail).toEqual(detail);
  });

  it('starts over with a whole detail once every subscriber has left', () => {
    const { stream, sent } = streamWithLog();
    const detail = largeTeamDetail(2, 10);
    stream.subscribe(taskId, 'subscription-1', detail);
    stream.unsubscribe(taskId, 'subscription-1');
    stream.publish(taskId, detail);
    expect(sent).toEqual([]);
    const subscriber = reader();
    subscriber.start(stream.subscribe(taskId, 'subscription-2', null));
    stream.publish(taskId, detail);
    expect(sent.map(({ type }) => type)).toEqual(['updated']);
  });
});
