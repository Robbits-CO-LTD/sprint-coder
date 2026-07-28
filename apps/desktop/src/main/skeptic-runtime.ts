import type { PreparedContext } from './context-ledger';
import type { SkepticRunner } from './adversarial-panel-runner';

// Running a skeptic on a real provider.
//
// `adversarial-panel-runner.ts` decides what to do with whatever a skeptic says; this is what
// actually asks one. It is deliberately the thinnest possible turn: one prompt in, the final text
// out, no tools of its own beyond what the runtime already offers, and no memory between rounds.
//
// Two properties matter more than anything else here.
//
// **A skeptic never writes.** It exists to judge work, and a judge that can edit the thing it is
// judging can make its own verdict true. The turn is started with `read-only` write scope
// explicitly rather than by omission, so the restriction survives a change to whatever the default
// happens to be.
//
// **A skeptic is subject to the same egress policy as any other turn.** Verification sends the
// objective, the claim and file paths to a provider; that it is the harness asking rather than the
// user does not make it exempt. A denial ends the turn rather than downgrading it, and the panel
// records the missing verdict as a refute — the fail-closed direction, since work nobody was
// allowed to check has not been checked.
//
// The runtime client arrives through a factory so the whole thing can be exercised without a
// provider, an Electron process, or a network.

/** The slice of a runtime client a skeptic turn uses. */
export type SkepticRuntimeClient = Readonly<{
  probe: () => Promise<{ available: boolean }>;
  start: (
    taskId: string,
    turnId: string,
    input: string,
    workspacePath: string | null,
    model: string,
    toolCatalogSnapshot: unknown,
    preparedContext: PreparedContext | undefined,
    teamMcp: undefined,
    effort: undefined,
    writeScope: 'read-only',
  ) => void;
  cancel: (taskId: string, turnId: string) => void;
}>;

/** Streaming callbacks, shaped like the runtime host's own constructor arguments. */
export type SkepticClientEvents = Readonly<{
  onEvent: (taskId: string, turnId: string, event: { type: string; delta?: string }) => void;
  onFailure: (taskId: string, turnId: string, error: { userMessage: string }) => void;
}>;

export type SkepticRuntimeChoice = Readonly<{ kind: 'claude' | 'codex'; model: string }>;

export type SkepticRuntimeDeps = Readonly<{
  clientFor: (kind: 'claude' | 'codex', events: SkepticClientEvents) => SkepticRuntimeClient;
  /** Which real runtime verification should use, or null when none is configured. */
  selectRuntime: () => SkepticRuntimeChoice | null;
  workspaceFor: (taskId: string) => string | null;
  catalogFor: (kind: 'claude' | 'codex', workspacePath: string | null) => unknown;
  contextFor: (taskId: string) => PreparedContext;
  authorizeEgress: (
    kind: 'claude' | 'codex',
    taskId: string,
    turnId: string,
    prompt: string,
    context: PreparedContext,
  ) => boolean;
  newTurnId: () => string;
}>;

/**
 * A [`SkepticRunner`](./adversarial-panel-runner.ts) backed by a real provider.
 *
 * Every rejection here becomes a refute rather than an error, because that is what the panel does
 * with a skeptic that produced nothing. That is the right default for all of them: an unconfigured
 * runtime, a denied egress and a dead provider are all states in which the work has not been
 * checked, and none of them are grounds to call it done.
 */
export function createSkepticRunner(deps: SkepticRuntimeDeps): SkepticRunner {
  return async ({ taskId: sourceTaskId, skepticIndex, prompt, signal }) => {
    const choice = deps.selectRuntime();
    if (choice === null) throw new Error('No runtime is configured to verify with');

    // Each skeptic is its own turn, so one failing or being cancelled cannot disturb another, and
    // the runtime never sees two skeptics as the same conversation. Policy, workspace and context
    // still come from the source Task: the synthetic runtime id is only transcript isolation.
    const runtimeTaskId = verificationTaskId(sourceTaskId, skepticIndex);
    const turnId = deps.newTurnId();
    const workspacePath = deps.workspaceFor(sourceTaskId);
    const context = deps.contextFor(sourceTaskId);
    if (!deps.authorizeEgress(choice.kind, sourceTaskId, turnId, prompt, context))
      throw new Error(`Verification egress was denied for ${choice.kind}`);

    const buffer: string[] = [];
    let settle: ((outcome: { text: string } | { error: Error }) => void) | null = null;
    const client = deps.clientFor(choice.kind, {
      onEvent: (_taskId, eventTurnId, event) => {
        if (eventTurnId !== turnId) return;
        if (event.type === 'delta' && event.delta !== undefined) buffer.push(event.delta);
        if (event.type === 'completed') settle?.({ text: buffer.join('') });
      },
      onFailure: (_taskId, eventTurnId, error) => {
        if (eventTurnId !== turnId) return;
        settle?.({ error: new Error(error.userMessage) });
      },
    });

    const capability = await client.probe();
    if (!capability.available) throw new Error(`${choice.kind} is unavailable for verification`);
    // Checked after the probe too: an abort during it should not start a turn nobody will read.
    if (signal.aborted) throw new Error('Verification was cancelled before it started');

    const outcome = await new Promise<{ text: string } | { error: Error }>((resolve) => {
      settle = resolve;
      const onAbort = () => {
        // Tell the provider to stop. The panel has already stopped waiting, so a turn left running
        // would be spent with no reader.
        client.cancel(runtimeTaskId, turnId);
        resolve({ error: new Error('Verification exceeded its deadline') });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      client.start(
        runtimeTaskId,
        turnId,
        prompt,
        workspacePath,
        choice.model,
        deps.catalogFor(choice.kind, workspacePath),
        context,
        undefined,
        undefined,
        'read-only',
      );
    }).finally(() => {
      settle = null;
    });

    if ('error' in outcome) throw outcome.error;
    return outcome.text;
  };
}

/**
 * The task a skeptic's turn is attributed to.
 *
 * Verification is harness work, not the user's conversation, so it is kept out of the Task whose
 * completion it is judging: a skeptic's turn must never land in the transcript the implementer
 * reads, or the next round would see the panel's own reasoning as prior context.
 */
function verificationTaskId(sourceTaskId: string, skepticIndex: number): string {
  return `verification:${sourceTaskId}:skeptic-${skepticIndex}`;
}
