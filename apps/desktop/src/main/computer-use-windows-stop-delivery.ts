import { randomUUID } from 'node:crypto';
import type {
  WindowsGenerationOwner,
  WindowsStopDecision,
  WindowsStopEntry,
  WindowsStopState,
} from './computer-use-windows-stop-outcome';

export type WindowsStopOwner = WindowsGenerationOwner & Readonly<{ lifetimeId: string }>;
export type WindowsStopPhase = 'termination_pending' | 'exit_confirmed' | 'cleanup_completed';
export type WindowsOwnerStopNotification = Readonly<{
  owner: WindowsStopOwner;
  phase: WindowsStopPhase;
  result: 'termination_requested' | 'terminated_clean' | 'terminated_target_suspect';
  late: boolean;
  reason: 'requested_reason' | 'native_unavailable';
  internalReason: 'requested_stop' | 'shared_helper_stop' | 'crash' | 'abortTransport';
}>;
export type WindowsStopDeliveryEvent =
  | Readonly<{ kind: 'registered'; owner: WindowsStopOwner }>
  | Readonly<{ kind: 'retired'; owner: WindowsStopOwner }>
  | Readonly<{ kind: 'notification'; notification: WindowsOwnerStopNotification }>;
export type WindowsStopListener = (event: WindowsStopDeliveryEvent) => void;

const ownerKey = (owner: WindowsGenerationOwner): string =>
  JSON.stringify([owner.helperGeneration, owner.kind, owner.id]);
export const sameWindowsStopOwner = (a: WindowsStopOwner, b: WindowsStopOwner): boolean =>
  ownerKey(a) === ownerKey(b) && a.lifetimeId === b.lifetimeId;
export const windowsStopPhaseOrder: Readonly<Record<WindowsStopPhase, number>> = {
  termination_pending: 1,
  exit_confirmed: 2,
  cleanup_completed: 3,
};

/** Main-only ownership and delivery. Nothing here grants input authority or updates UI. */
export class WindowsStopDelivery {
  private readonly owners = new Map<string, WindowsStopOwner>();
  private readonly stopping = new Map<
    string,
    Readonly<{ owner: WindowsStopOwner; entry: WindowsStopEntry; initiator?: WindowsStopOwner }>
  >();
  private readonly phases = new Map<string, number>();
  private readonly exits = new Map<number, WindowsStopDecision>();
  private readonly listeners = new Set<WindowsStopListener>();

  subscribe = (listener: WindowsStopListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(event: WindowsStopDeliveryEvent): void {
    for (const listener of [...this.listeners]) {
      // A consumer must not prevent native cleanup or another consumer's delivery.
      try {
        listener(event);
      } catch {
        /* No payloads in diagnostics. */
      }
    }
  }

  register(generation: number, kind: WindowsStopOwner['kind'], id: string): WindowsStopOwner {
    const key = ownerKey({ helperGeneration: generation, kind, id });
    let owner = this.owners.get(key);
    if (owner === undefined) {
      owner = { helperGeneration: generation, kind, id, lifetimeId: randomUUID() };
      this.owners.set(key, owner);
      this.emit({ kind: 'registered', owner });
    }
    return owner;
  }

  find(
    generation: number,
    kind: WindowsStopOwner['kind'],
    id: string,
  ): WindowsStopOwner | undefined {
    return this.owners.get(ownerKey({ helperGeneration: generation, kind, id }));
  }

  stop(
    generation: number,
    kind: WindowsStopOwner['kind'],
    id: string,
    entry: WindowsStopEntry,
    initiator?: WindowsStopOwner,
  ): void {
    const owner = this.owners.get(ownerKey({ helperGeneration: generation, kind, id }));
    if (owner === undefined) return;
    const key = ownerKey(owner);
    if (!this.stopping.has(key))
      this.stopping.set(key, { owner, entry, ...(initiator === undefined ? {} : { initiator }) });
  }

  complete(
    generation: number,
    kind: WindowsStopOwner['kind'],
    id: string,
    lifetimeId: string,
  ): void {
    const key = ownerKey({ helperGeneration: generation, kind, id });
    const owner = this.owners.get(key);
    if (owner === undefined || owner.lifetimeId !== lifetimeId) return;
    this.stopping.delete(key);
    this.owners.delete(key);
    this.phases.delete(owner.lifetimeId);
    this.emit({ kind: 'retired', owner });
  }

  project(state: WindowsStopState): WindowsStopState {
    const stops = [...this.stopping.values()].filter(
      ({ owner }) => owner.helperGeneration === state.helperGeneration,
    );
    return {
      ...state,
      entry: stops[0]?.entry ?? null,
      stopOwnerId: stops[0]?.owner.id ?? '',
      owners: [...this.owners.values()].filter(
        (owner) => owner.helperGeneration === state.helperGeneration,
      ),
    };
  }

  receiptEntry(generation: number, id: string): WindowsStopEntry | null {
    return (
      this.stopping.get(ownerKey({ helperGeneration: generation, kind: 'session', id }))?.entry ??
      null
    );
  }

  deliver(decision: WindowsStopDecision): void {
    const generation = decision.state.helperGeneration;
    if (decision.kind === 'termination_pending') this.phase(decision, 'termination_pending');
    if (decision.kind === 'exit_confirmed') {
      this.exits.set(generation, decision);
      this.phase(decision, 'exit_confirmed');
    }
  }

  cleanup(generation: number): void {
    const exit = this.exits.get(generation);
    if (exit === undefined) return;
    this.phase(exit, 'cleanup_completed');
    this.exits.delete(generation);
    for (const owner of [...this.owners.values()])
      if (owner.helperGeneration === generation)
        this.complete(generation, owner.kind, owner.id, owner.lifetimeId);
  }

  private phase(decision: WindowsStopDecision, phase: WindowsStopPhase): void {
    const state = decision.state;
    const result = phase === 'termination_pending' ? 'termination_requested' : state.result;
    if (
      result !== 'termination_requested' &&
      result !== 'terminated_clean' &&
      result !== 'terminated_target_suspect'
    )
      return;
    const hasStops = [...this.stopping.values()].some(
      ({ owner }) => owner.helperGeneration === state.helperGeneration,
    );
    const cause =
      decision.notification.kind === 'generation_exit' ? decision.notification.cause : 'stop';
    for (const owner of [...this.owners.values()]) {
      if (
        owner.helperGeneration !== state.helperGeneration ||
        (this.phases.get(owner.lifetimeId) ?? 0) >= windowsStopPhaseOrder[phase]
      )
        continue;
      this.phases.set(owner.lifetimeId, windowsStopPhaseOrder[phase]);
      const requested =
        this.stopping.has(ownerKey(owner)) ||
        [...this.stopping.values()].some(
          (stop) => stop.initiator !== undefined && sameWindowsStopOwner(stop.initiator, owner),
        );
      this.emit({
        kind: 'notification',
        notification: {
          owner,
          phase,
          result,
          late: state.exitWaitExceeded,
          reason: requested ? 'requested_reason' : 'native_unavailable',
          internalReason: requested
            ? 'requested_stop'
            : hasStops || cause === 'stop'
              ? 'shared_helper_stop'
              : cause === 'crash'
                ? 'crash'
                : 'abortTransport',
        },
      });
    }
  }
}
