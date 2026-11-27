import { describe, expect, it, vi } from 'vitest';
import { createRendererCrashRecovery } from './renderer-crash-recovery';

function setup() {
  const canRecover = vi.fn(() => true);
  const reload = vi.fn();
  const confirmRetry = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  const reportFailure = vi.fn();
  const now = vi.fn(() => 0);
  const onExit = createRendererCrashRecovery({
    canRecover,
    reload,
    confirmRetry,
    reportFailure,
    now,
  });
  return { canRecover, reload, confirmRetry, reportFailure, now, onExit };
}

describe('main-window renderer recovery', () => {
  it('reloads once automatically and asks before repeating a quick failure', async () => {
    const { onExit, reload, confirmRetry } = setup();
    await onExit('crashed');
    await onExit('crashed');
    expect(reload).toHaveBeenCalledOnce();
    expect(confirmRetry).toHaveBeenCalledOnce();
  });

  it('honors one explicit retry and avoids overlapping prompts', async () => {
    const { onExit, reload, confirmRetry } = setup();
    let choose: (value: boolean) => void = () => undefined;
    confirmRetry.mockImplementationOnce(() => new Promise((resolve) => (choose = resolve)));
    await onExit('crashed');
    const decision = onExit('crashed');
    await onExit('crashed');
    expect(confirmRetry).toHaveBeenCalledOnce();
    choose(true);
    await decision;
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload during shutdown, even if the user already opened the prompt', async () => {
    const { onExit, reload, confirmRetry, canRecover } = setup();
    await onExit('crashed');
    confirmRetry.mockImplementationOnce(async () => {
      canRecover.mockReturnValue(false);
      return true;
    });
    await onExit('crashed');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('ignores deliberate exits and lets an isolated later crash recover again', async () => {
    const { onExit, reload, now, confirmRetry } = setup();
    await onExit('clean-exit');
    await onExit('killed');
    expect(reload).not.toHaveBeenCalled();
    await onExit('crashed');
    now.mockReturnValue(60_000);
    await onExit('oom');
    expect(reload).toHaveBeenCalledTimes(2);
    expect(confirmRetry).not.toHaveBeenCalled();
  });

  it('reports a reload exception without starting a loop', async () => {
    const { onExit, reload, reportFailure, confirmRetry } = setup();
    const error = new Error('reload failed');
    reload.mockImplementationOnce(() => {
      throw error;
    });
    await onExit('crashed');
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(error);
    await onExit('crashed');
    expect(confirmRetry).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
});
