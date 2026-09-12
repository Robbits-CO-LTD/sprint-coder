// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GraphMissionPlan, GraphView } from '@sprint-coder/contracts';
import type { TeamDetail } from '../types/sprint-coder';
import { useAppStore } from '../store/appStore';
import { GraphMissionPlanPanel } from './GraphMissionPlanPanel';

const view = {
  id: '11111111-1111-4111-8111-111111111111',
  taskId: 'task-1',
  revision: 4,
  renderRevision: 7,
  instanceId: '22222222-2222-4222-8222-222222222222',
} as unknown as GraphView;

const plan: GraphMissionPlan = {
  mode: 'graph',
  objective: 'Review',
  doneCriteria: ['Both reviewed'],
  steps: [
    {
      key: 'a',
      nodeId: 'a',
      workerId: 'worker-a',
      objective: 'first',
      doneCriteria: ['Reviewed'],
      access: 'read-only',
      dependsOn: [],
      writeClaims: [],
      resourceClaims: [],
    },
  ],
};

function seed(graph: {
  stepResumeAvailable: boolean;
  integrationResumeAvailable: boolean;
  stepResumePending?: boolean;
  waitReason?: 'dependencies' | 'resources' | 'write-conflicts' | 'owner-active';
}) {
  useAppStore.setState({
    teamByTask: {
      'task-1': {
        team: { state: 'active' },
        workers: [{ id: 'worker-a', role: 'reviewer', state: 'waiting', writeCapable: false }],
        executions: [],
        missions: [
          {
            id: 'mission-1',
            state: 'waiting_resume',
            graph: { id: view.id, semanticRevision: view.revision },
            steps: [
              {
                executionId: 'execution-a',
                state: 'waiting_resume',
                graph: {
                  key: 'a',
                  nodeId: 'a',
                  generation: 2,
                  resourceState: null,
                  waitReason: null,
                  stepResumePending: false,
                  ...graph,
                },
              },
            ],
          },
        ],
      } as unknown as TeamDetail,
    },
  });
}

afterEach(() => {
  useAppStore.setState({ teamByTask: {} });
  vi.unstubAllGlobals();
});

it('offers a step resume that dispatches only the requested step', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const resumeStep = vi.fn(async () => undefined);
  const resumeIntegration = vi.fn(async () => undefined);
  vi.stubGlobal('sprintCoder', { graphs: { resumeStep, resumeIntegration } });
  seed({ stepResumeAvailable: true, integrationResumeAvailable: false });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('この工程を再開');
    expect(button.dataset['computerUseActivation']).toBe('graph-resume-step');
    expect(JSON.parse(button.dataset['computerUseIntent']!)).toMatchObject({
      operation: 'graph-resume-step',
      missionId: 'mission-1',
      stepKey: 'a',
      generation: 2,
    });
    await act(async () => button.click());
    expect(resumeStep).toHaveBeenCalledWith({
      taskId: 'task-1',
      instanceId: view.instanceId,
      renderRevision: view.renderRevision,
      missionId: 'mission-1',
      stepKey: 'a',
      generation: 2,
    });
    // Re-running a finished Worker is a different operation and must not be reachable from here.
    expect(resumeIntegration).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps a sealed step on the integration resume instead of a new Worker run', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const resumeStep = vi.fn(async () => undefined);
  const resumeIntegration = vi.fn(async () => undefined);
  vi.stubGlobal('sprintCoder', { graphs: { resumeStep, resumeIntegration } });
  seed({ stepResumeAvailable: false, integrationResumeAvailable: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('完了した変更の統合を再開');
    expect(button.dataset['computerUseActivation']).toBe('graph-resume');
    expect(JSON.parse(button.dataset['computerUseIntent']!).operation).toBe(
      'graph-resume-integration',
    );
    await act(async () => button.click());
    expect(resumeIntegration).toHaveBeenCalledTimes(1);
    expect(resumeStep).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it('says a resumed step is waiting on its dependency and offers no second resume', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('sprintCoder', { graphs: {} });
  seed({ stepResumeAvailable: false, integrationResumeAvailable: false, stepResumePending: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    expect(container.querySelector('[data-testid="graph-step-state"]')?.textContent).toBe(
      '再開済み · 依存の完了待ち',
    );
    // The resume already happened; a second button would only invite a duplicate Worker run.
    expect(container.querySelector('button')).toBeNull();
    // A known wait reason keeps its existing wording.
    await act(async () => root.unmount());
    seed({
      stepResumeAvailable: false,
      integrationResumeAvailable: false,
      stepResumePending: true,
      waitReason: 'dependencies',
    });
    const next = createRoot(container);
    await act(async () =>
      next.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    expect(container.querySelector('[data-testid="graph-step-state"]')?.textContent).toBe(
      '前提工程待ち',
    );
    await act(async () => next.unmount());
  } finally {
    container.remove();
  }
});

it('offers nothing while the step is not parked for a manual decision', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('sprintCoder', { graphs: {} });
  seed({ stepResumeAvailable: false, integrationResumeAvailable: false });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-testid="graph-step-state"]')?.textContent).toBe(
      '再開待ち',
    );
  } finally {
    await act(async () => root.unmount());
  }
});
