/**
 * Keeps the exact side-effect closure after a failed attempt so operation replay can retry the
 * same authority boundary instead of reconstructing it from already-detached runtime state.
 */
export class RetryableActionRegistry {
  private readonly actions = new Map<string, () => Promise<void>>();

  async run(key: string, create: () => () => Promise<void>): Promise<void> {
    const action = this.actions.get(key) ?? create();
    this.actions.set(key, action);
    await action();
    this.actions.delete(key);
  }
}
