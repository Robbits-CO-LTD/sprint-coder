export class TeamSubscriptionRegistry {
  private readonly subscriptionsByTask = new Map<string, Set<string>>();
  private readonly sequenceByTask = new Map<string, number>();

  subscribe(taskId: string, subscriptionId: string): number {
    const subscriptions = this.subscriptionsByTask.get(taskId) ?? new Set<string>();
    subscriptions.add(subscriptionId);
    this.subscriptionsByTask.set(taskId, subscriptions);
    return this.currentSequence(taskId);
  }

  unsubscribe(taskId: string, subscriptionId: string): void {
    const subscriptions = this.subscriptionsByTask.get(taskId);
    if (subscriptions === undefined) return;
    subscriptions.delete(subscriptionId);
    if (subscriptions.size === 0) this.subscriptionsByTask.delete(taskId);
  }

  hasSubscribers(taskId: string): boolean {
    return (this.subscriptionsByTask.get(taskId)?.size ?? 0) > 0;
  }

  nextSequence(taskId: string): number {
    const next = this.currentSequence(taskId) + 1;
    this.sequenceByTask.set(taskId, next);
    return next;
  }

  currentSequence(taskId: string): number {
    return this.sequenceByTask.get(taskId) ?? 0;
  }

  clear(): void {
    this.subscriptionsByTask.clear();
    this.sequenceByTask.clear();
  }
}
