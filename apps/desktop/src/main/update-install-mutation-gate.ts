export class UpdateInstallMutationGate {
  private accepting = true;
  private active = 0;
  private readonly drainWaiters = new Set<() => void>();

  isAccepting(): boolean {
    return this.accepting;
  }

  assertAccepting(): void {
    if (!this.accepting) throw new Error('Update installation is pending');
  }

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    this.assertAccepting();
    this.active += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    }
  }

  async closeWhenIdle(verifyIdle: () => boolean): Promise<boolean> {
    if (!this.accepting) return false;
    this.accepting = false;
    if (this.active > 0) await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
    try {
      if (verifyIdle()) return true;
      this.accepting = true;
      return false;
    } catch (error) {
      this.accepting = true;
      throw error;
    }
  }
}
