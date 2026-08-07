import { describe, expect, it, vi } from 'vitest';
import { UpdateInstallMutationGate } from './update-install-mutation-gate';

describe('UpdateInstallMutationGate', () => {
  it('drains a mutation that entered before the final idle check', async () => {
    const gate = new UpdateInstallMutationGate();
    let release!: () => void;
    const action = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const verifyIdle = vi.fn(() => true);
    const closing = gate.closeWhenIdle(verifyIdle);

    await Promise.resolve();
    expect(verifyIdle).not.toHaveBeenCalled();
    release();

    await expect(action).resolves.toBeUndefined();
    await expect(closing).resolves.toBe(true);
    expect(verifyIdle).toHaveBeenCalledOnce();
  });

  it('rejects a mutation that arrives after update preparation starts', async () => {
    const gate = new UpdateInstallMutationGate();
    await expect(gate.closeWhenIdle(() => true)).resolves.toBe(true);

    await expect(gate.run(() => undefined)).rejects.toThrow('Update installation is pending');
  });

  it('reopens mutations when the final idle check finds concurrent work', async () => {
    const gate = new UpdateInstallMutationGate();
    await expect(gate.closeWhenIdle(() => false)).resolves.toBe(false);

    await expect(gate.run(() => 'accepted')).resolves.toBe('accepted');
  });
});
