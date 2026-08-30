export type ComputerUseUiActivationKind = 'application' | 'start' | 'approval';

export function createTrustedComputerUseUiActivationGate(now: () => number = Date.now) {
  let pending: { kind: ComputerUseUiActivationKind; intent: string | null; at: number } | null =
    null;
  return Object.freeze({
    observe(
      event: Pick<Event, 'isTrusted' | 'target'>,
      onAccepted?: (kind: ComputerUseUiActivationKind, intent: string | null) => void,
    ): boolean {
      if (!event.isTrusted || !(event.target instanceof Element)) return false;
      const control = event.target.closest<HTMLElement>('[data-computer-use-activation]');
      const kind = control?.dataset['computerUseActivation'];
      if (kind !== 'application' && kind !== 'start' && kind !== 'approval') return false;
      const rawIntent = control?.dataset['computerUseIntent'];
      const intent =
        typeof rawIntent === 'string' && rawIntent.length > 0 && rawIntent.length <= 2_048
          ? rawIntent
          : null;
      pending = { kind, intent, at: now() };
      onAccepted?.(kind, intent);
      return true;
    },
    consume(kind: ComputerUseUiActivationKind): Readonly<{ intent: string | null }> | null {
      const candidate = pending;
      pending = null;
      return candidate !== null && candidate.kind === kind && now() - candidate.at <= 2_000
        ? { intent: candidate.intent }
        : null;
    },
    clear(): void {
      pending = null;
    },
  });
}
