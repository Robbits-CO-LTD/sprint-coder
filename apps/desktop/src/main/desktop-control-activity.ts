/**
 * Whether a desktop-control run that may move the pointer is in progress. While it is, Sprint
 * Coder's windows refuse every drop from outside (the renderer's drop guard), so when a physical
 * drag is refused over Sprint Coder and the binary lets the button go back at its origin, nothing
 * the drag carries lands in Sprint Coder even if the origin is covered by one of its windows.
 *
 * Runs are counted, so overlapping runs (a Leader and its Workers, several Tasks) keep it raised
 * until the last one ends. It is lowered a short while after that one ends, so a drop the release
 * caused reaches the renderer while it still refuses.
 */
import { desktopControlActivitySchema, IPC_CHANNELS } from '@sprint-coder/contracts';

export type DesktopControlActivityListener = (active: boolean) => void;

/** A window's contents, as `sendDesktopControlActivity` uses them. */
export type DesktopControlActivityTarget = Readonly<{
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}>;

/** Tells each of these windows whether the activity is raised; one that cannot be told is skipped. */
export function sendDesktopControlActivity(
  targets: Iterable<DesktopControlActivityTarget>,
  active: boolean,
): void {
  const payload = desktopControlActivitySchema.parse({ active });
  for (const target of targets) {
    try {
      if (!target.isDestroyed()) target.send(IPC_CHANNELS.desktopControlActivityEvent, payload);
    } catch {
      // A window closing while it is told; the others are still told.
    }
  }
}

type Timers = Readonly<{
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

/** How long the windows keep refusing drops after the last run ended. */
export const DESKTOP_CONTROL_ACTIVITY_GRACE_MS = 1_000;

export class DesktopControlActivity {
  private running = 0;
  private lowering: unknown;
  private raised = false;
  private readonly listeners = new Set<DesktopControlActivityListener>();

  constructor(
    private readonly graceMs = DESKTOP_CONTROL_ACTIVITY_GRACE_MS,
    private readonly timers: Timers = {
      setTimeout: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}

  get active(): boolean {
    return this.raised;
  }

  /**
   * Raises it for one run, telling every listener before this returns, and gives the call that
   * ends that run. The returned call does something only the first time. Never throws.
   */
  begin(): () => void {
    this.running += 1;
    if (this.lowering !== undefined) {
      this.timers.clearTimeout(this.lowering);
      this.lowering = undefined;
    }
    if (!this.raised) {
      this.raised = true;
      this.publish(true);
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.running -= 1;
      if (this.running > 0 || this.lowering !== undefined) return;
      this.lowering = this.timers.setTimeout(() => {
        this.lowering = undefined;
        if (this.running > 0 || !this.raised) return;
        this.raised = false;
        this.publish(false);
      }, this.graceMs);
    };
  }

  subscribe(listener: DesktopControlActivityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(active: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(active);
      } catch {
        // A window that cannot be told must not stop the run or the other windows.
      }
    }
  }
}

/** The one Main keeps for every CommandRunner. */
export const desktopControlActivity = new DesktopControlActivity();
