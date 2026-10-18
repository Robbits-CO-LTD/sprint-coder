import {
  diffTeamDetail,
  isEmptyTeamDetailPatch,
  type TeamDetail,
  type TeamEvent,
  type TeamSubscriptionSnapshot,
} from '@sprint-coder/contracts';
import type { TeamSubscriptionRegistry } from './team-subscription-registry';

/**
 * Sends each Task's Team detail to its subscribers as patches against the detail sent before
 * (issue #863). Every subscriber of a Task holds the detail of the last event it was sent, so a
 * patch made against that same detail rebuilds the new one exactly. A Task's first event, and any
 * change a patch cannot express, goes out as a whole detail.
 */
export class TeamDetailStream {
  /** The detail every subscriber of a Task holds: the one its latest event carried. */
  private readonly sent = new Map<string, TeamDetail>();

  constructor(
    private readonly subscriptions: TeamSubscriptionRegistry,
    private readonly send: (taskId: string, event: TeamEvent) => void,
  ) {}

  publish(taskId: string, detail: TeamDetail): void {
    if (!this.subscriptions.hasSubscribers(taskId)) {
      this.sent.delete(taskId);
      return;
    }
    const base = this.sent.get(taskId);
    const patch = base === undefined ? null : diffTeamDetail(base, detail);
    if (patch !== null && isEmptyTeamDetailPatch(patch)) return;
    this.sent.set(taskId, detail);
    const seq = this.subscriptions.nextSequence(taskId);
    this.send(
      taskId,
      patch === null
        ? { type: 'updated', seq, detail }
        : { type: 'patched', seq, teamId: detail.team.id, patch },
    );
  }

  /**
   * Registers a subscriber and returns its starting snapshot. Subscribers already listening are
   * first brought to the same detail, so every subscriber holds one detail at one sequence and the
   * next patch fits them all.
   */
  subscribe(
    taskId: string,
    subscriptionId: string,
    detail: TeamDetail | null,
  ): TeamSubscriptionSnapshot {
    if (detail !== null) this.publish(taskId, detail);
    const seq = this.subscriptions.subscribe(taskId, subscriptionId);
    if (detail === null) this.sent.delete(taskId);
    else this.sent.set(taskId, detail);
    return { type: 'snapshot', seq, detail };
  }

  unsubscribe(taskId: string, subscriptionId: string): void {
    this.subscriptions.unsubscribe(taskId, subscriptionId);
    if (!this.subscriptions.hasSubscribers(taskId)) this.sent.delete(taskId);
  }

  clear(): void {
    this.sent.clear();
    this.subscriptions.clear();
  }
}
