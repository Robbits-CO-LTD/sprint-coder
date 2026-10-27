// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { useAppStore } from '../../store/appStore';

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.unstubAllGlobals();
});

async function keyCase(
  draft: string,
  key: string,
  options: KeyboardEventInit = {},
  goalSupported = true,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  const start = vi.fn();
  const createTask = vi.fn();
  const toggleTeamView = vi.fn();
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      tasks: {},
      turns: { start },
      ...(goalSupported ? { goals: { start } } : {}),
      teams: {},
    },
  });
  useAppStore.setState(
    {
      ...useAppStore.getInitialState(),
      selectedTaskId: 'keyboard',
      draftByTask: { keyboard: draft },
      createTask,
      toggleTeamView,
    },
    true,
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Composer taskId="keyboard" />));
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    await act(async () => container.querySelector('textarea')!.dispatchEvent(event));
    return {
      prevented: event.defaultPrevented,
      draft: useAppStore.getState().draftByTask.keyboard,
      goalArmed: container.querySelector('[data-testid="composer-goal-armed"]') !== null,
      imageArmed: container.querySelector('[data-testid="composer-imagegen-armed"]') !== null,
      requests:
        start.mock.calls.length + createTask.mock.calls.length + toggleTeamView.mock.calls.length,
    };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

it.each(['/goal', '/new', '/team', '/image', '/unknown', 'plain text'])(
  'leaves Shift+Enter and Shift+Tab to native editing with %s',
  async (draft) => {
    for (const key of ['Enter', 'Tab']) {
      expect(await keyCase(draft, key, { shiftKey: true })).toEqual({
        prevented: false,
        draft,
        goalArmed: false,
        imageArmed: false,
        requests: 0,
      });
    }
  },
);

it.each(['Enter', 'Tab'])('selects an available Goal once with plain %s', async (key) => {
  expect(await keyCase('/goal', key)).toEqual({
    prevented: true,
    draft: '',
    goalArmed: true,
    imageArmed: false,
    requests: 0,
  });
});

it('does not intercept an IME confirmation', async () => {
  expect(await keyCase('/goal', 'Enter', { isComposing: true })).toEqual({
    prevented: false,
    draft: '/goal',
    goalArmed: false,
    imageArmed: false,
    requests: 0,
  });
});

it.each(['Enter', 'Tab'])(
  'does not submit through an unavailable candidate with %s',
  async (key) => {
    expect(await keyCase('/goal', key, {}, false)).toEqual({
      prevented: true,
      draft: '/goal',
      goalArmed: false,
      imageArmed: false,
      requests: 0,
    });
  },
);
