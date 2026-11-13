// Issue #1211: a Leader's own (ordinary) Turn that fails on a lost connection after a desktop
// operation is ended as failed and never started again by Main, so the operation cannot reach the
// desktop twice. (A Team Worker's request has its own guard: `recordManagedSideEffect`.)
import { describe, expect, it, vi } from 'vitest';
import { IpcRouter } from './ipc';
import { secureLogger } from './secure-logger';

type Kind = 'codex' | 'claude' | 'grok';

function createLeaderTurn(kind: Kind) {
  const turnRuntimes = new Map<string, string>([['turn-leader', kind]]);
  let activeTurnId: string | null = 'turn-leader';
  const finishAndAdvance = vi.fn((_taskId: string, turnId: string) => {
    turnRuntimes.delete(turnId);
    activeTurnId = null;
  });
  const runtime = () => ({ start: vi.fn(), cancel: vi.fn(async () => undefined) });
  const runtimes = { codex: runtime(), claude: runtime(), grok: runtime() };
  const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
  Object.assign(router, {
    mailbox: { run: vi.fn((_taskId: string, action: () => unknown) => Promise.resolve(action())) },
    canceledRuntimeTurns: new Set<string>(),
    quarantinedRuntimeKinds: new Set<string>(),
    turnRuntimes,
    turnLogCategoryByTurn: new Map([['turn-leader', 'chat']]),
    runtimeDiagnosticContextByTurn: new Map([
      ['turn-leader', { startedAtMs: Date.now() - 10, runtimeKind: kind, teamMcpEnabled: false }],
    ]),
    attachmentCustodyByTurn: new Map(),
    persistence: {
      getActiveTurnId: vi.fn(() => activeTurnId),
      recordRuntimeFailureDiagnostic: vi.fn(() => ({ diagnosticId: 'diagnostic-leader' })),
    },
    pushRuntimeStatus: vi.fn(),
    finishAndAdvance,
    codexRuntime: runtimes.codex,
    claudeRuntime: runtimes.claude,
    grokRuntime: runtimes.grok,
  });
  const probe = router as unknown as {
    handleRuntimeFailure(
      kind: Kind,
      taskId: string,
      turnId: string,
      error: { code: string; userMessage: string; retryable: boolean },
    ): void;
  };
  return { probe, finishAndAdvance, runtimes };
}

describe('a Leader Turn that fails after a desktop operation', () => {
  it.each(
    (['codex', 'claude', 'grok'] as const).flatMap((kind) =>
      [
        // Codex's endpoint failure, a host that exited, and a quota failure: the ones a retry
        // would be tempting for.
        { code: 'RUNTIME_UNAVAILABLE', userMessage: '接続先で一時的な障害', retryable: true },
        { code: 'RUNTIME_FAILED', userMessage: 'Runtime Hostが終了しました。', retryable: true },
        { code: 'RUNTIME_RATE_LIMIT', userMessage: '利用上限', retryable: false },
      ].map((error) => [kind, error] as const),
    ),
  )('ends a %s Turn as failed and does not start it again (%o)', async (kind, error) => {
    const { probe, finishAndAdvance, runtimes } = createLeaderTurn(kind);
    const log = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined);

    probe.handleRuntimeFailure(kind, 'task-leader', 'turn-leader', error);
    await vi.waitFor(() => expect(finishAndAdvance).toHaveBeenCalledOnce());
    // A late duplicate of the failure changes nothing.
    probe.handleRuntimeFailure(kind, 'task-leader', 'turn-leader', error);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(finishAndAdvance).toHaveBeenCalledOnce();
    expect(finishAndAdvance).toHaveBeenCalledWith('task-leader', 'turn-leader', 'failed');
    for (const client of Object.values(runtimes)) expect(client.start).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
