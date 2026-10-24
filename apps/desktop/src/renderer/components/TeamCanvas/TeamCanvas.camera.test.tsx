// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CanvasView,
  SprintCoderApi,
  TaskSummary,
  TeamDetail,
  WorkerSummary,
} from '../../types/sprint-coder';
import { useAppStore } from '../../store/appStore';
import { TeamCanvas, type TeamCanvasHandle } from './TeamCanvas';

const task: TaskSummary = {
  id: 'camera-task',
  projectId: null,
  title: 'Camera',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: true,
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
};
const worker = (id: string): WorkerSummary => ({
  id,
  teamId: 'camera-team',
  threadId: `thread-${id}`,
  taskId: task.id,
  kind: 'worker',
  role: id,
  state: 'ready',
  objective: 'Camera fixture',
  writeCapable: false,
  currentActivity: null,
  engine: 'mock',
  connectionId: null,
  requestedProvider: null,
  requestedModel: null,
  parentAgentId: 'leader',
  depth: 1,
  canDelegate: false,
  managerPolicy: null,
  liveOutput: '',
  reasoningActive: false,
  usage: { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 },
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});
const detail = (workers: WorkerSummary[]): TeamDetail => ({
  team: {
    id: 'camera-team',
    taskId: task.id,
    leaderAgentId: 'leader',
    state: 'active',
    budget: {},
    policy: {
      maxAgentDepth: 4,
      maxConcurrentExecutions: 8,
      allowWorkerDirectMessages: true,
      budgetMode: 'bounded',
    },
    revision: 1,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  },
  workers,
  messages: [],
  executions: [],
  missions: [],
  activities: [],
  budgets: [],
});

let container: HTMLDivElement;
let root: Root;
let canvas: HTMLElement;
let world: HTMLElement;
let workers: WorkerSummary[];
const handle = createRef<TeamCanvasHandle>();
const getCanvasView = vi.fn<SprintCoderApi['teams']['getCanvasView']>();
const saveCanvasView = vi.fn<SprintCoderApi['teams']['saveCanvasView']>();

async function mount() {
  await act(async () =>
    root.render(
      <TeamCanvas
        task={task}
        leaderRef={createRef()}
        leaderAnchorRef={createRef()}
        onRequestExit={vi.fn()}
        onSwitchToListView={vi.fn()}
        ref={handle}
      />,
    ),
  );
  canvas = container.querySelector<HTMLElement>('.team-canvas')!;
  world = container.querySelector<HTMLElement>('.team-world')!;
}
function key(key: string) {
  act(() =>
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  );
}
function click(testId: string) {
  act(() => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
}
function fit(command: 'button' | 'F') {
  if (command === 'button') click('team-canvas-fit');
  else key('F');
}
function hire() {
  workers = [...workers, worker(`worker-${workers.length + 1}`)];
  act(() => useAppStore.setState({ teamByTask: { [task.id]: detail(workers) } }));
  expect(container.querySelectorAll('.worker')).toHaveLength(workers.length);
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  // jsdom has no layout. Supply only the geometry read by the real camera and placement code.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1180);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return parseFloat(this.style.left) || 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return parseFloat(this.style.top) || 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(420);
  getCanvasView.mockReset().mockResolvedValue(null);
  saveCanvasView.mockReset().mockResolvedValue({ revision: 1 });
  vi.stubGlobal('sprintCoder', { teams: { getCanvasView, saveCanvasView } });
  workers = [worker('worker-1')];
  useAppStore.setState({
    teamByTask: { [task.id]: detail(workers) },
    teamLoadFailedByTask: {},
    teamBusy: false,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['button', 'F'] as const)('explicit Fit via %s', (command) => {
  it('keeps the requested fit when a previously scheduled hire-follow fires', async () => {
    await mount();
    hire();
    await advance(60);
    fit(command);
    const fitted = world.style.transform;
    expect(canvas.dataset.cameraOwner).toBe('user');
    for (const ms of [60, 480, 360, 600]) {
      await advance(ms);
      expect(world.style.transform).toBe(fitted);
    }
    expect(container.querySelectorAll('.worker')).toHaveLength(2);
    expect(saveCanvasView).toHaveBeenCalled();
  });

  it('does not follow a later hire or automatically expand the explicit fit', async () => {
    await mount();
    fit(command);
    await advance(600);
    const fitted = world.style.transform;
    hire();
    for (const ms of [120, 480, 300, 600]) {
      await advance(ms);
      expect(world.style.transform).toBe(fitted);
    }
    expect(canvas.dataset.cameraOwner).toBe('user');
  });

  it('keeps the explicit camera when delayed restore lands, but still restores positions and saves', async () => {
    let resolve!: (saved: CanvasView) => void;
    getCanvasView.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount();
    fit(command);
    const fitted = world.style.transform;
    await act(async () =>
      resolve({
        taskId: task.id,
        camera: { x: -500, y: -600, scale: 0.2 },
        nodePositions: { 'worker-1': { x: 2500, y: 1200 } },
        revision: 7,
        updatedAt: task.updatedAt,
      }),
    );
    expect(world.style.transform).toBe(fitted);
    expect(container.querySelector<HTMLElement>('.worker')!.style.left).toBe('2500px');
    await advance(800);
    expect(saveCanvasView).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 7, nodePositions: { 'worker-1': { x: 2500, y: 1200 } } }),
    );
    const camera = saveCanvasView.mock.calls[0]![0].camera;
    expect(fitted).toBe(`translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`);
  });
});

describe('automatic and explicit focus controls', () => {
  it.each(['Leader', 'L', 'Enter', 'resettle'] as const)(
    '%s still restores system ownership and hire-follow',
    async (command) => {
      await mount();
      fit('button');
      if (command === 'Leader') click('team-canvas-focus-leader');
      else if (command === 'resettle') act(() => handle.current!.resettle());
      else if (command === 'Enter') {
        key('ArrowRight');
        key('ArrowRight');
        key('Enter');
        expect(document.activeElement?.classList.contains('w-stop-btn')).toBe(true);
      } else key('L');
      expect(canvas.dataset.cameraOwner).toBe('system');
      const before = world.style.transform;
      hire();
      await advance(120);
      expect(world.style.transform).not.toBe(before);
    },
  );

  it('starts with automatic fit/follow and preserves manual-pan ownership', async () => {
    await mount();
    expect(canvas.dataset.cameraOwner).toBe('system');
    const initial = world.style.transform;
    hire();
    await advance(120);
    expect(world.style.transform).not.toBe(initial);
    canvas.setPointerCapture = vi.fn();
    act(() => {
      canvas.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }),
      );
      canvas.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 80 }),
      );
      canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    const panned = world.style.transform;
    hire();
    await advance(1500);
    expect(canvas.dataset.cameraOwner).toBe('user');
    expect(world.style.transform).toBe(panned);
  });
});
