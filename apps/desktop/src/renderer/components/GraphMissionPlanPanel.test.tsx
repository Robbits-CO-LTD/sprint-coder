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
  workspaceReviewRequired?: boolean;
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

it('requires workspace review before exposing the digest-bound continuation gesture', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const reviewWorkspace = vi.fn(async () => ({
    digest: 'a'.repeat(64),
    files: [{ repository: 1, path: 'retained.ts' }],
  }));
  const resumeStep = vi.fn(async () => undefined);
  vi.stubGlobal('sprintCoder', { graphs: { resumeStep, reviewWorkspace } });
  seed({
    stepResumeAvailable: true,
    integrationResumeAvailable: false,
    workspaceReviewRequired: true,
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    const resume = container.querySelector<HTMLButtonElement>('[data-computer-use-activation]')!;
    expect(resume.disabled).toBe(true);
    await act(async () => container.querySelector('button')!.click());
    expect(
      container.querySelector('[data-testid="graph-workspace-review"]')?.textContent,
    ).toContain('retained.ts');
    expect(resume.disabled).toBe(false);
    expect(JSON.parse(resume.dataset['computerUseIntent']!)).toMatchObject({
      workspaceReviewDigest: 'a'.repeat(64),
    });
    expect(resumeStep).not.toHaveBeenCalled();
    await act(async () => resume.click());
    expect(resumeStep).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceReviewDigest: 'a'.repeat(64) }),
    );
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

// issue #842: a finished plan no longer offers to start, and write scopes name the Workspace
// folder rather than the root's UUID.
it('drops the start hint once the plan has run and names roots by their Workspace label', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const rootId = 'd3a61295-0000-4000-8000-000000000001';
  const getEffective = vi.fn(async () => ({
    source: 'project',
    projectId: 'project-1',
    primaryRootId: rootId,
    roots: [{ rootId, path: '/work/client-app', label: 'client-app', role: 'primary' }],
    digest: 'd'.repeat(64),
  }));
  vi.stubGlobal('sprintCoder', { graphs: {}, workspace: { getEffective } });
  seed({ stepResumeAvailable: false, integrationResumeAvailable: false });
  const team = useAppStore.getState().teamByTask['task-1']!;
  useAppStore.setState({
    teamByTask: {
      'task-1': {
        ...team,
        missions: team.missions.map((mission) => ({
          ...mission,
          state: 'completed',
          steps: mission.steps.map((step) => ({ ...step, state: 'completed' })),
        })),
      } as TeamDetail,
    },
  });
  const writePlan: GraphMissionPlan = {
    ...plan,
    steps: [
      {
        ...plan.steps[0]!,
        access: 'workspace-write',
        writeClaims: [{ rootId, path: 'src/client.ts', semanticKeys: [] }],
        resourceClaims: [{ scope: 'workspace', key: 'dev.server', rootId: 'legacy-primary' }],
      },
    ],
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<GraphMissionPlanPanel view={view} plan={writePlan} sourceStamp={null} />),
    );
    const text = container.textContent ?? '';
    expect(container.querySelector('[data-testid="graph-mission-state"]')?.textContent).toBe(
      'すべての工程が完了しました。',
    );
    expect(text).not.toContain('この計画で開始できます');
    expect(getEffective).toHaveBeenCalledWith('task-1');
    expect(text).toContain('client-app: src/client.ts');
    expect(text).toContain('Workspace: client-app');
    expect(text).not.toContain(rootId);
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps the start hint on a plan that has not started yet', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('sprintCoder', { graphs: {} });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    expect(container.textContent).toContain('この計画で開始できます');
  } finally {
    await act(async () => root.unmount());
  }
});

// issue #842: a step parked after a failure says why, short and without local paths.
it('shows the recorded reason beside a step that waits for a resume', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('sprintCoder', { graphs: {} });
  seed({ stepResumeAvailable: false, integrationResumeAvailable: false });
  const team = useAppStore.getState().teamByTask['task-1']!;
  const withReason = (terminalReason: string) =>
    useAppStore.setState({
      teamByTask: {
        'task-1': {
          ...team,
          executions: [{ id: 'execution-a', state: 'waiting_resume', terminalReason }],
        } as unknown as TeamDetail,
      },
    });
  withReason(
    'Graph step interrupted: worktree C:\\Users\\someone\\repo\\.git is locked while the integration was still waiting',
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    const state = container.querySelector('[data-testid="graph-step-state"]')?.textContent ?? '';
    // The path is hidden to the end of the line (a path may contain spaces), so the words after it go
    // too; nothing of the path is shown.
    expect(state).toBe('再開待ち · 理由: Graph step interrupted: worktree …');
    expect(state).not.toContain('Users');
    expect(state).not.toContain('repo');
    expect(Array.from(state.slice(state.indexOf('理由: ') + 4)).length).toBeLessThanOrEqual(60);

    await act(async () => root.unmount());
    withReason('runtime_failure');
    const next = createRoot(container);
    await act(async () =>
      next.render(<GraphMissionPlanPanel view={view} plan={plan} sourceStamp={null} />),
    );
    expect(container.querySelector('[data-testid="graph-step-state"]')?.textContent).toBe(
      '再開待ち · 理由: 実行時エラー',
    );
    await act(async () => next.unmount());
  } finally {
    container.remove();
  }
});
