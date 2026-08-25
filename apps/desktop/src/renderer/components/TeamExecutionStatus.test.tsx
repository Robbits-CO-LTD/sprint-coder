import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamExecutionStatus } from './TeamExecutionStatus';
import {
  EXECUTION_STATE_LABELS,
  QUEUE_REASON_LABELS,
  UNKNOWN_CONNECTION_LABEL,
  UNKNOWN_QUEUE_REASON_LABEL,
  EMPTY_INSTRUCTION_LABEL,
  connectionLabel,
  describeExecution,
  formatClockTime,
  latestExecutionForWorker,
} from '../lib/team-execution-display';
import type { TeamExecutionSummary } from '../types/sprint-coder';

function execution(overrides: Partial<TeamExecutionSummary> = {}): TeamExecutionSummary {
  return {
    id: 'exec-1',
    teamId: 'team-1',
    assigneeAgentId: 'worker-1',
    createdByAgentId: 'leader-1',
    accessMode: 'read-only',
    state: 'running',
    instructionPreview: 'テストを追加する',
    instructionRevision: 1,
    queueOrdinal: null,
    queueReason: null,
    connectionId: 'builtin:claude-cli',
    requestedModel: null,
    attemptStartReason: 'initial',
    lastProgressAt: '2026-07-28T01:00:05.000Z',
    terminalReason: null,
    missionId: null,
    missionStepOrdinal: null,
    missionStepCount: null,
    worktree: null,
    isolation: null,
    assignedAt: '2026-07-28T01:00:00.000Z',
    queuedAt: null,
    startedAt: '2026-07-28T01:00:05.000Z',
    completedAt: null,
    updatedAt: '2026-07-28T01:00:05.000Z',
    ...overrides,
  };
}

describe('latestExecutionForWorker', () => {
  it('picks the assignee row with the newest updatedAt', () => {
    const older = execution({ id: 'old', updatedAt: '2026-07-28T01:00:00.000Z' });
    const newer = execution({ id: 'new', updatedAt: '2026-07-28T03:00:00.000Z' });
    const other = execution({
      id: 'other',
      assigneeAgentId: 'worker-2',
      updatedAt: '2026-07-28T09:00:00.000Z',
    });

    expect(latestExecutionForWorker([older, newer, other], 'worker-1')?.id).toBe('new');
    expect(latestExecutionForWorker([newer, older, other], 'worker-1')?.id).toBe('new');
  });

  it('returns null when the worker has no execution, or the list is missing entirely', () => {
    expect(latestExecutionForWorker([execution()], 'worker-9')).toBeNull();
    expect(latestExecutionForWorker([], 'worker-1')).toBeNull();
    expect(latestExecutionForWorker(null, 'worker-1')).toBeNull();
    expect(latestExecutionForWorker(undefined, 'worker-1')).toBeNull();
  });
});

describe('connection labels', () => {
  it('names the built-in runtimes', () => {
    expect(connectionLabel('builtin:claude-cli')).toBe('Claude CLI');
    expect(connectionLabel('builtin:codex-cli')).toBe('Codex CLI');
  });

  it('shows any other id verbatim and never renders an empty unknown', () => {
    expect(connectionLabel('conn-custom-42')).toBe('conn-custom-42');
    expect(connectionLabel(null)).toBe(UNKNOWN_CONNECTION_LABEL);
    expect(connectionLabel('')).toBe(UNKNOWN_CONNECTION_LABEL);
  });
});

describe('describeExecution', () => {
  it('falls back to assignedAt when queuedAt is not recorded', () => {
    const display = describeExecution(
      execution({ state: 'queued', queuedAt: null, assignedAt: '2026-07-28T01:00:00.000Z' }),
    );
    expect(display.waitingSinceIso).toBe('2026-07-28T01:00:00.000Z');
    expect(display.waitingSinceLabel).toBe(formatClockTime('2026-07-28T01:00:00.000Z'));
  });

  it('prefers queuedAt when present', () => {
    const display = describeExecution(
      execution({ state: 'queued', queuedAt: '2026-07-28T02:30:00.000Z' }),
    );
    expect(display.waitingSinceIso).toBe('2026-07-28T02:30:00.000Z');
  });

  it('renders queue ordinal 0 as a position rather than as unknown', () => {
    expect(
      describeExecution(execution({ state: 'queued', queueOrdinal: 0 })).queueOrdinalLabel,
    ).toBe('待機順 0');
    expect(
      describeExecution(execution({ state: 'queued', queueOrdinal: null })).queueOrdinalLabel,
    ).toBeNull();
  });

  it('omits waiting-only facts for non-waiting states', () => {
    const display = describeExecution(execution({ state: 'running', queueReason: 'budget' }));
    expect(display.isWaiting).toBe(false);
    expect(display.waitReasonLabel).toBeNull();
    expect(display.waitingSinceLabel).toBeNull();
    expect(display.queueOrdinalLabel).toBeNull();
  });

  it('marks terminal states', () => {
    expect(describeExecution(execution({ state: 'completed' })).isTerminal).toBe(true);
    expect(describeExecution(execution({ state: 'failed' })).isTerminal).toBe(true);
    expect(describeExecution(execution({ state: 'canceled' })).isTerminal).toBe(true);
    expect(describeExecution(execution({ state: 'running' })).isTerminal).toBe(false);
  });

  it('echoes an unparseable timestamp instead of rendering nothing', () => {
    expect(formatClockTime('not-a-date')).toBe('not-a-date');
  });
});

describe('TeamExecutionStatus', () => {
  it('renders nothing when the worker has no persisted execution', () => {
    expect(renderToStaticMarkup(<TeamExecutionStatus execution={null} variant="canvas" />)).toBe(
      '',
    );
    expect(renderToStaticMarkup(<TeamExecutionStatus execution={null} variant="list" />)).toBe('');
  });

  it('shows isolated worktree integration and quarantine state in both views', () => {
    const row = execution({
      state: 'waiting_resume',
      worktree: {
        path: '/tmp/worktree-exec-1',
        baseHead: 'a'.repeat(40),
        state: 'quarantined',
        workerHead: 'b'.repeat(40),
        integratedHead: null,
        changedFiles: ['src/change.ts'],
        reason: 'Workspace changed before integration',
      },
    });
    for (const variant of ['canvas', 'list'] as const) {
      const html = renderToStaticMarkup(<TeamExecutionStatus execution={row} variant={variant} />);
      expect(html).toContain('変更を保持して再開待ち');
      expect(html).toContain('変更1件');
      expect(html).toContain('Workspace changed before integration');
    }
  });

  it('shows repository integration progress, reason, and the same resume action in both views', () => {
    const row = execution({
      accessMode: 'workspace-write',
      state: 'waiting_resume',
      missionId: 'mission-1',
      isolation: {
        phase: 'waiting_resume',
        resumeKind: 'integration',
        repositories: [
          {
            ordinal: 1,
            repoPath: '/workspace/primary',
            worktreePath: '/tmp/primary',
            baseHead: 'a'.repeat(40),
            workerHead: 'b'.repeat(40),
            integratedHead: null,
            state: 'ready',
            changedFiles: ['primary.txt'],
          },
          {
            ordinal: 2,
            repoPath: '/workspace/secondary',
            worktreePath: '/tmp/secondary',
            baseHead: 'c'.repeat(40),
            workerHead: 'd'.repeat(40),
            integratedHead: 'e'.repeat(40),
            state: 'integrated',
            changedFiles: ['secondary.txt'],
          },
        ],
        roots: [
          {
            rootId: 'root-1',
            rootLabel: 'primary',
            role: 'primary',
            repositoryOrdinal: 1,
            sourcePath: '/workspace/primary',
            isolatedPath: '/tmp/primary',
            identity: '1'.repeat(64),
            mutationKey: '2'.repeat(64),
            isolatedIdentity: '3'.repeat(64),
            isolatedMutationKey: '4'.repeat(64),
          },
        ],
        reason: 'Primary integration failed',
      },
    });
    for (const variant of ['canvas', 'list'] as const) {
      const html = renderToStaticMarkup(
        <TeamExecutionStatus execution={row} variant={variant} onResume={() => undefined} />,
      );
      expect(html).toContain('1/2 repository統合済み');
      expect(html).toContain('Primary integration failed');
      expect(html).toContain('data-testid="team-integration-resume"');
      expect(html).toContain('統合を再開');
    }
  });

  it('routes standalone integration and Worker resumes to distinct labeled actions', () => {
    const integration = execution({
      state: 'waiting_resume',
      isolation: {
        phase: 'waiting_resume',
        resumeKind: 'integration',
        repositories: [],
        roots: [],
        reason: 'resume',
      },
    });
    expect(
      renderToStaticMarkup(
        <TeamExecutionStatus
          execution={integration}
          variant="list"
          onResumeIntegration={() => undefined}
        />,
      ),
    ).toContain('data-testid="team-integration-resume"');

    const worker = execution({ state: 'waiting_resume', missionId: 'mission-1' });
    const html = renderToStaticMarkup(
      <TeamExecutionStatus execution={worker} variant="canvas" onResume={() => undefined} />,
    );
    expect(html).toContain('data-testid="team-worker-resume"');
    expect(html).toContain('Workerを再開');
  });

  it.each(Object.entries(EXECUTION_STATE_LABELS))(
    'states %s in Japanese as "%s"',
    (state, label) => {
      const html = renderToStaticMarkup(
        <TeamExecutionStatus
          execution={execution({ state: state as TeamExecutionSummary['state'] })}
          variant="canvas"
        />,
      );
      expect(html).toContain('data-testid="team-execution-state"');
      expect(html).toContain(label);
      expect(html).toContain(`data-execution-state="${state}"`);
    },
  );

  it.each(Object.entries(QUEUE_REASON_LABELS))(
    'explains queue reason %s as "%s"',
    (reason, label) => {
      const html = renderToStaticMarkup(
        <TeamExecutionStatus
          execution={execution({
            state: 'queued',
            queueReason: reason as NonNullable<TeamExecutionSummary['queueReason']>,
            queuedAt: '2026-07-28T02:30:00.000Z',
          })}
          variant="canvas"
        />,
      );
      expect(html).toContain('data-testid="team-execution-wait"');
      expect(html).toContain(label);
      expect(html).toContain('待機開始');
      expect(html).toContain(formatClockTime('2026-07-28T02:30:00.000Z'));
      expect(html).toContain('Claude CLI');
    },
  );

  it('uses explicit wording when the queue reason is null', () => {
    const html = renderToStaticMarkup(
      <TeamExecutionStatus
        execution={execution({ state: 'queued', queueReason: null })}
        variant="list"
      />,
    );
    expect(html).toContain(UNKNOWN_QUEUE_REASON_LABEL);
  });

  it('shows the same Worker resume control for a waiting Mission in either view', () => {
    const row = execution({
      state: 'waiting_resume',
      missionId: 'mission-1',
      missionStepOrdinal: 1,
      missionStepCount: 2,
    });
    for (const variant of ['canvas', 'list'] as const) {
      const html = renderToStaticMarkup(
        <TeamExecutionStatus execution={row} variant={variant} onResume={() => undefined} />,
      );
      expect(html).toContain('data-testid="team-worker-resume"');
      expect(html).toContain('Workerを再開');
      expect(html).toContain('再開待ち');
    }
  });

  it.each(['queued', 'waiting_verification', 'waiting_rate_limit'] as const)(
    'shows reason, wait start and connection for %s',
    (state) => {
      const html = renderToStaticMarkup(
        <TeamExecutionStatus
          execution={execution({
            state,
            queueReason: 'connection_concurrency',
            queuedAt: '2026-07-28T02:30:00.000Z',
            connectionId: 'builtin:codex-cli',
          })}
          variant="list"
        />,
      );
      expect(html).toContain('Connectionの同時実行上限');
      expect(html).toContain(formatClockTime('2026-07-28T02:30:00.000Z'));
      expect(html).toContain('Codex CLI');
    },
  );

  it('has no waiting row for assigned/running/terminal states', () => {
    for (const state of ['assigned', 'running', 'completed', 'failed', 'canceled'] as const) {
      const html = renderToStaticMarkup(
        <TeamExecutionStatus execution={execution({ state })} variant="canvas" />,
      );
      expect(html).not.toContain('data-testid="team-execution-wait"');
    }
  });

  it('keeps state, connection and instruction visible while running and after finishing', () => {
    for (const state of ['running', 'completed', 'failed', 'canceled'] as const) {
      const html = renderToStaticMarkup(
        <TeamExecutionStatus
          execution={execution({ state, instructionPreview: 'リグレッションを直す' })}
          variant="list"
        />,
      );
      expect(html).toContain(EXECUTION_STATE_LABELS[state]);
      expect(html).toContain('Claude CLI');
      expect(html).toContain('リグレッションを直す');
    }
  });

  it('never lets an empty instruction preview stand in for unknown', () => {
    const html = renderToStaticMarkup(
      <TeamExecutionStatus
        execution={execution({ instructionPreview: '   ', connectionId: null })}
        variant="canvas"
      />,
    );
    expect(html).toContain(EMPTY_INSTRUCTION_LABEL);
    expect(html).toContain(UNKNOWN_CONNECTION_LABEL);
  });

  it('announces politely and adds no focusable elements or colour-only signals', () => {
    const html = renderToStaticMarkup(
      <TeamExecutionStatus
        execution={execution({ state: 'waiting_rate_limit', queueReason: 'rate_limit' })}
        variant="canvas"
      />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('aria-live="assertive"');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('<button');
    // The summary carries the same facts as the visible rows, in words.
    expect(html).toContain('実行状態 レート制限待ち');
    expect(html).toContain('Provider rate limit');
  });

  it('renders the same execution facts on Canvas and List', () => {
    const row = execution({
      state: 'queued',
      queueReason: 'global_concurrency',
      queueOrdinal: 2,
      queuedAt: '2026-07-28T02:30:00.000Z',
      connectionId: 'conn-custom-42',
      instructionPreview: 'ビルドを直す',
    });
    const canvas = renderToStaticMarkup(<TeamExecutionStatus execution={row} variant="canvas" />);
    const list = renderToStaticMarkup(<TeamExecutionStatus execution={row} variant="list" />);
    const facts = [
      '順番待ち',
      'Team全体の同時実行上限',
      '待機順 2',
      'conn-custom-42',
      'ビルドを直す',
      formatClockTime('2026-07-28T02:30:00.000Z'),
    ];
    for (const fact of facts) {
      expect(canvas).toContain(fact);
      expect(list).toContain(fact);
    }
    // Only the variant class differs between the two surfaces.
    expect(canvas.replace('team-exec-canvas', 'team-exec-list')).toBe(list);
  });
});
