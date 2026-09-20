export type ComputerUseUiActivationKind =
  | 'application'
  | 'start'
  | 'approval'
  | 'permission-settings'
  | 'app-grant-revoke'
  | 'graph-start'
  | 'graph-resume'
  | 'graph-resume-step';

/**
 * Every activation kind, as one list.
 *
 * Three places have to agree about this set: the Renderer gate below, which records a click; Main's
 * intent channel, which binds the recorded kind; and the Main-side handler, which consumes it. A
 * kind present in some of them and not others does not fail loudly — the control simply never works,
 * because `consume` compares against a kind that was never bound. One exported list, with the
 * exhaustiveness check below, removes the possibility.
 */
export const COMPUTER_USE_UI_ACTIVATION_KINDS = [
  'application',
  'start',
  'approval',
  'permission-settings',
  'app-grant-revoke',
  'graph-start',
  'graph-resume',
  'graph-resume-step',
] as const satisfies readonly ComputerUseUiActivationKind[];

// A kind added to the type but not to the list above fails to compile here.
const ACTIVATION_KINDS_ARE_EXHAUSTIVE: Exclude<
  ComputerUseUiActivationKind,
  (typeof COMPUTER_USE_UI_ACTIVATION_KINDS)[number]
> extends never
  ? true
  : never = true;
void ACTIVATION_KINDS_ARE_EXHAUSTIVE;

export function isComputerUseUiActivationKind(
  value: unknown,
): value is ComputerUseUiActivationKind {
  return (COMPUTER_USE_UI_ACTIVATION_KINDS as readonly unknown[]).includes(value);
}

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
      if (!isComputerUseUiActivationKind(kind)) return false;
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
