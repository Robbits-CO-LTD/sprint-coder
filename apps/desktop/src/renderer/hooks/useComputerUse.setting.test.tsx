// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerUseAvailability } from '@sprint-coder/contracts';
import { TaskHeader } from '../components/TaskHeader';
import { announceComputerUseSettingChanged } from '../lib/computer-use-setting-event';
import type { TaskSummary } from '../types/sprint-coder';
import { useComputerUse } from './useComputerUse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task: TaskSummary = {
  id: 'task-1',
  projectId: null,
  title: 'UIを整える',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: true,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

const ready: ComputerUseAvailability = {
  platform: 'win32',
  state: 'ready',
  acceptanceMode: null,
  featureEnabled: true,
  packageReady: true,
  handshakeReady: true,
  observe: true,
  control: true,
  available: true,
  reasonCode: null,
  manifestDigest: 'a'.repeat(64),
  missingPermissions: [],
};
const disabled: ComputerUseAvailability = {
  ...ready,
  state: 'feature_disabled',
  featureEnabled: false,
  observe: false,
  control: false,
  available: false,
  reasonCode: 'feature_disabled',
};

/** The TaskHeader wiring App uses: the button exists only while the hook says the entry is on. */
function Harness() {
  const computerUse = useComputerUse(null);
  return (
    <TaskHeader
      task={task}
      onToggleTeam={() => {}}
      {...(computerUse.enabled ? { onOpenComputerUse: computerUse.open } : {})}
    />
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  delete (window as { sprintCoder?: unknown }).sprintCoder;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the Computer Use (beta) setting and the TaskHeader entry', () => {
  it('reads availability again when the setting changes, so the button follows without a restart', async () => {
    let current = disabled;
    const availability = vi.fn(async () => current);
    window.sprintCoder = { computerUse: { availability } } as unknown as NonNullable<
      Window['sprintCoder']
    >;

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    await flush();
    const launch = () => host!.querySelector('[data-testid="computer-use-launch"]');
    expect(availability).toHaveBeenCalledTimes(1);
    expect(launch()).toBeNull();

    current = ready;
    announceComputerUseSettingChanged();
    await flush();
    expect(availability).toHaveBeenCalledTimes(2);
    expect(launch()).not.toBeNull();

    current = disabled;
    announceComputerUseSettingChanged();
    await flush();
    expect(availability).toHaveBeenCalledTimes(3);
    expect(launch()).toBeNull();
  });

  it('lets a newer read win over a slower one from before the change', async () => {
    const pending: Array<(value: ComputerUseAvailability) => void> = [];
    const availability = vi.fn(
      () => new Promise<ComputerUseAvailability>((resolve) => pending.push(resolve)),
    );
    window.sprintCoder = { computerUse: { availability } } as unknown as NonNullable<
      Window['sprintCoder']
    >;

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    announceComputerUseSettingChanged();
    expect(pending).toHaveLength(2);
    // The answer to the newer read (the setting turned off) lands first; the stale one must not
    // bring the button back when it arrives afterwards.
    await act(async () => pending[1]!(disabled));
    await act(async () => pending[0]!(ready));
    await flush();
    expect(host.querySelector('[data-testid="computer-use-launch"]')).toBeNull();
  });
});
