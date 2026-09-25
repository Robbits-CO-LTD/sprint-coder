import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamExecutionStatus } from './TeamExecutionStatus';
import { retainedWorktreeStateLabel } from './TeamRetainedWorktrees';
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
import type { TeamExecutionIsolation, TeamExecutionSummary } from '../types/sprint-coder';

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
  it('keeps running work visible above a newer waiter and pending work above completed history', () => {
    const running = execution({
      id: 'active',
      updatedAt: '2026-07-28T01:00:00.000Z',
      workerQueueDepth: 1,
    });
    const queued = execution({
      id: 'next',
      state: 'queued',
      waitingForWorker: true,
      updatedAt: '2026-07-28T02:00:00.000Z',
    });
    const completed = execution({
      id: 'past',
      state: 'completed',
      updatedAt: '2026-07-28T03:00:00.000Z',
    });
    expect(latestExecutionForWorker([queued, completed, running], 'worker-1')?.id).toBe('active');
    expect(latestExecutionForWorker([completed, queued], 'worker-1')?.id).toBe('next');
    expect(describeExecution(queued).waitReasonLabel).toContain('同じWorker');
    for (const variant of ['canvas', 'list'] as const)
      expect(
        renderToStaticMarkup(<TeamExecutionStatus execution={running} variant={variant} />),
      ).toContain('後続1件が待機中');
  });
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

  it('labels the write scope from accessMode (issue #551)', () => {
    expect(describeExecution(execution({ accessMode: 'read-only' })).writeScopeLabel).toBe(
      '読み取り専用（依頼どおり）',
    );
    expect(describeExecution(execution({ accessMode: 'workspace-write' })).writeScopeLabel).toBe(
      'Workspaceへ書き込み（隔離worktreeで変更し、完了後に統合）',
    );
  });

  it('translates a known terminalReason code into Japanese (issue #551)', () => {
    expect(
      describeExecution(execution({ terminalReason: 'heartbeat_timeout' })).terminalReasonLabel,
    ).toBe('Workerの応答が途絶えたため停止');
    expect(
      describeExecution(execution({ terminalReason: 'worker_reported_failure' }))
        .terminalReasonLabel,
    ).toBe('Workerが失敗を報告');
    // Main's own write check (requireWorkspaceWrite) overriding a reported success is a distinct
    // reason from a Worker reporting failure itself (issue #584).
    expect(
      describeExecution(execution({ terminalReason: 'workspace_write_unverified' }))
        .terminalReasonLabel,
    ).toBe('書き込みを確認できず失敗');
    // Existing translation kept as-is (see the module comment on why this one is not renamed).
    expect(
      describeExecution(execution({ terminalReason: 'stop_unconfirmed' })).terminalReasonLabel,
    ).toBe('強制停止');
  });

  it('falls back to the raw code for an unknown terminalReason (e.g. a Graph Mission free-text reason)', () => {
    expect(
      describeExecution(execution({ terminalReason: 'some future runtime error message' }))
        .terminalReasonLabel,
    ).toBe('some future runtime error message');
  });
});

describe('TeamExecutionStatus', () => {
  it('renders nothing when the worker has no persisted execution', () => {
    expect(renderToStaticMarkup(<TeamExecutionStatus execution={null} variant="canvas" />)).toBe(
      '',
    );
    expect(renderToStaticMarkup(<TeamExecutionStatus execution={null} variant="list" />)).toBe('');
  });

  it('shows the write scope row for both accessMode values (issue #551)', () => {
    for (const [accessMode, expectedText] of [
      ['read-only', '読み取り専用（依頼どおり）'],
      ['workspace-write', 'Workspaceへ書き込み（隔離worktreeで変更し、完了後に統合）'],
    ] as const) {
      const row = execution({ accessMode });
      for (const variant of ['canvas', 'list'] as const) {
        const html = renderToStaticMarkup(
          <TeamExecutionStatus execution={row} variant={variant} />,
        );
        expect(html).toContain('team-execution-write-scope');
        expect(html).toContain(expectedText);
      }
    }
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

  it('does not count a failed Worker worktree that was only cleaned up as integrated (issue #529)', () => {
    const repository = {
      ordinal: 1,
      repoPath: '/workspace/primary',
      worktreePath: '/tmp/primary',
      baseHead: 'a'.repeat(40),
      workerHead: null,
      changedFiles: [],
    };
    const isolation = (
      repositories: NonNullable<TeamExecutionSummary['isolation']>['repositories'],
    ) =>
      execution({
        accessMode: 'workspace-write',
        state: 'failed',
        isolation: {
          phase: 'quarantined',
          resumeKind: null,
          repositories,
          roots: [],
          reason: 'Worker failed',
        },
      });
    const reclaimed = isolation([{ ...repository, integratedHead: null, state: 'cleaned' }]);
    for (const variant of ['canvas', 'list'] as const) {
      const html = renderToStaticMarkup(
        <TeamExecutionStatus execution={reclaimed} variant={variant} />,
      );
      expect(html).toContain('0/1 repository統合済み');
      expect(html).toContain('片付け済み（統合なし）');
      expect(html).not.toContain('統合・片付け済み');
      expect(html).not.toContain('隔離して要確認');
    }

    // A repository that did integrate keeps its wording, and a kept worktree still needs review.
    const mixed = renderToStaticMarkup(
      <TeamExecutionStatus
        execution={isolation([
          { ...repository, integratedHead: 'e'.repeat(40), state: 'cleaned' },
          { ...repository, ordinal: 2, integratedHead: null, state: 'quarantined' },
        ])}
        variant="list"
      />,
    );
    expect(mixed).toContain('1/2 repository統合済み');
    expect(mixed).toContain('統合・片付け済み');
    expect(mixed).toContain('隔離して要確認');
    expect(mixed).not.toContain('片付け済み（統合なし）');

    // Every worktree is gone, but one repository did integrate before the isolation was
    // quarantined, so the heading must not claim that nothing was integrated.
    const partlyIntegrated = renderToStaticMarkup(
      <TeamExecutionStatus
        execution={isolation([
          { ...repository, integratedHead: 'e'.repeat(40), state: 'cleaned' },
          { ...repository, ordinal: 2, integratedHead: null, state: 'cleaned' },
        ])}
        variant="list"
      />,
    );
    expect(partlyIntegrated).toContain('1/2 repository統合済み · 隔離して要確認');
    expect(partlyIntegrated).toContain('統合・片付け済み');
    expect(partlyIntegrated).toContain('片付け済み（統合なし）');
  });

  describe('integrated worktrees kept on disk', () => {
    const repository = {
      ordinal: 1,
      repoPath: '/workspace/primary',
      worktreePath: '/tmp/primary',
      baseHead: 'a'.repeat(40),
      workerHead: 'b'.repeat(40),
      changedFiles: ['primary.txt'],
    };
    // Main checked every kept worktree and found its integrated commit in the Workspace unless
    // `retainedWorktreeIntegrations` says otherwise.
    const row = (
      repositories: NonNullable<TeamExecutionSummary['isolation']>['repositories'],
      retainedWorktreeIntegrations: NonNullable<
        TeamExecutionSummary['retainedWorktreeIntegrations']
      > = repositories
        .filter(({ state, integratedHead }) => state === 'quarantined' && integratedHead !== null)
        .map(({ ordinal }) => ({ repositoryOrdinal: ordinal, integration: 'confirmed' as const })),
    ): TeamExecutionSummary =>
      execution({
        accessMode: 'workspace-write',
        state: 'completed',
        isolation: {
          phase: 'quarantined',
          resumeKind: null,
          repositories,
          roots: [],
          reason: 'Integrated repository worktree remained dirty during cleanup',
        },
        retainedWorktreeIntegrations,
      });

    it('counts an integrated worktree whose cleanup failed as integrated and says the cleanup failed (issue #544)', () => {
      const cleanupFailed = row([
        { ...repository, integratedHead: 'e'.repeat(40), state: 'quarantined' },
        { ...repository, ordinal: 2, integratedHead: 'f'.repeat(40), state: 'cleaned' },
      ]);
      for (const variant of ['canvas', 'list'] as const) {
        const html = renderToStaticMarkup(
          <TeamExecutionStatus execution={cleanupFailed} variant={variant} />,
        );
        expect(html).toContain('2/2 repository統合済み · 統合後の片付けに失敗');
        expect(html).toContain('統合済み（片付けに失敗）');
        expect(html).not.toContain('隔離して要確認');
        expect(html).not.toContain('隔離済み');
      }

      // Once the user discards what was left, nothing is waiting on a cleanup any more.
      const discarded = renderToStaticMarkup(
        <TeamExecutionStatus
          execution={row([{ ...repository, integratedHead: 'e'.repeat(40), state: 'cleaned' }])}
          variant="list"
        />,
      );
      expect(discarded).toContain('1/1 repository統合済み · 統合・片付け済み');
      expect(discarded).not.toContain('片付けに失敗');

      // A kept worktree that never integrated still needs review, next to one that did.
      const mixed = renderToStaticMarkup(
        <TeamExecutionStatus
          execution={row([
            { ...repository, integratedHead: 'e'.repeat(40), state: 'quarantined' },
            { ...repository, ordinal: 2, integratedHead: null, state: 'quarantined' },
          ])}
          variant="list"
        />,
      );
      expect(mixed).toContain('1/2 repository統合済み · 隔離して要確認');
      expect(mixed).toContain('統合済み（片付けに失敗）');
      expect(mixed).toContain('隔離済み');
    });

    it('does not call a kept worktree integrated until Main found its commit in the Workspace, as the list says (issue #579)', () => {
      const kept = { ...repository, integratedHead: 'e'.repeat(40), state: 'quarantined' as const };
      // What the retained worktree list says about the same repository, past its execution state.
      const listed = (integration: 'confirmed' | 'unconfirmed') =>
        retainedWorktreeStateLabel({
          executionState: 'completed',
          integration,
          submodules: false,
        }).replace(`${EXECUTION_STATE_LABELS.completed} · `, '');
      expect(listed('confirmed')).toBe('統合済み（片付けに失敗）');
      expect(listed('unconfirmed')).toBe('統合を確認できません（Workspaceの履歴に見つかりません）');
      // The record keeps the integrated HEAD, but the Workspace history no longer has it (e.g. a
      // failed revalidation quarantined it): the card says what the retained worktree list says.
      const unconfirmed = row([kept], [{ repositoryOrdinal: 1, integration: 'unconfirmed' }]);
      for (const variant of ['canvas', 'list'] as const) {
        const html = renderToStaticMarkup(
          <TeamExecutionStatus execution={unconfirmed} variant={variant} />,
        );
        expect(html).toContain('0/1 repository統合済み · 統合を確認できません');
        expect(html).toContain(listed('unconfirmed'));
        expect(html).not.toContain('統合済み（片付けに失敗）');
        expect(html).not.toContain('統合後の片付けに失敗');
      }
      // A confirmed one is named exactly as the list names it.
      const confirmed = renderToStaticMarkup(
        <TeamExecutionStatus execution={row([kept])} variant="list" />,
      );
      expect(confirmed).toContain('1/1 repository統合済み · 統合後の片付けに失敗');
      expect(confirmed).toContain(listed('confirmed'));

      // Main has not checked it yet: neither integrated nor missing, only being checked.
      const { retainedWorktreeIntegrations: _unchecked, ...withoutChecks } = row([kept]);
      for (const checking of [row([kept], []), withoutChecks]) {
        const html = renderToStaticMarkup(
          <TeamExecutionStatus execution={checking} variant="list" />,
        );
        expect(html).toContain('0/1 repository統合済み · 統合を確認中');
        expect(html).not.toContain('統合済み（片付けに失敗）');
        expect(html).not.toContain('統合を確認できません');
      }

      // One kept worktree confirmed and one not: only the confirmed one counts, and the heading
      // does not claim the cleanup was all that failed.
      const mixed = renderToStaticMarkup(
        <TeamExecutionStatus
          execution={row(
            [kept, { ...kept, ordinal: 2, integratedHead: 'f'.repeat(40) }],
            [
              { repositoryOrdinal: 1, integration: 'confirmed' },
              { repositoryOrdinal: 2, integration: 'unconfirmed' },
            ],
          )}
          variant="list"
        />,
      );
      expect(mixed).toContain('1/2 repository統合済み · 統合を確認できません');
      expect(mixed).toContain('統合済み（片付けに失敗）');
      expect(mixed).toContain('統合を確認できません（Workspaceの履歴に見つかりません）');
    });
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

  // issue #571: a hand-written renderer type omitted `waiting_integration` from `TeamExecutionIsolation`,
  // so `isolationPhaseLabel`'s switch compiled clean while dropping this real value — the Repository
  // row went blank instead of naming the wait. These tests pin the label and the resume gating that
  // depend on it now that the type is aliased to the canonical contracts schema.
  describe('isolation phase waiting_integration (issue #571)', () => {
    function isolationWith(
      overrides: Partial<TeamExecutionIsolation> = {},
    ): TeamExecutionIsolation {
      return {
        phase: 'waiting_integration',
        resumeKind: null,
        repositories: [],
        roots: [],
        reason: null,
        ...overrides,
      };
    }

    it('names the wait instead of leaving the Repository row blank, in both views', () => {
      const row = execution({
        accessMode: 'workspace-write',
        isolation: isolationWith({
          repositories: [
            {
              ordinal: 1,
              repoPath: '/workspace/primary',
              worktreePath: '/tmp/primary',
              baseHead: 'a'.repeat(40),
              workerHead: 'b'.repeat(40),
              integratedHead: null,
              state: 'ready',
              changedFiles: ['a.txt'],
            },
          ],
        }),
      });
      for (const variant of ['canvas', 'list'] as const) {
        const html = renderToStaticMarkup(
          <TeamExecutionStatus execution={row} variant={variant} />,
        );
        expect(html).toContain('data-testid="team-execution-isolation"');
        expect(html).toContain('0/1 repository統合済み · 統合の順番待ち');
        // The bug rendered this row's value as nothing at all — assert against that shape directly,
        // not just for the presence of the label above.
        expect(html).not.toMatch(/repository統合済み\s*·\s*<\/span>/);
      }
    });

    it('shows every canonical contracts isolation phase as a non-blank label (regression net for future phases)', () => {
      const phases: TeamExecutionIsolation['phase'][] = [
        'preparing',
        'running',
        'finalizing',
        'waiting_integration',
        'integrating',
        'waiting_resume',
        'completed',
        'quarantined',
      ];
      for (const phase of phases) {
        const row = execution({
          accessMode: 'workspace-write',
          isolation: isolationWith({
            phase,
            resumeKind: phase === 'waiting_resume' ? 'worker' : null,
          }),
        });
        const html = renderToStaticMarkup(<TeamExecutionStatus execution={row} variant="list" />);
        expect(html).not.toMatch(/repository統合済み\s*·\s*<\/span>/);
      }
    });

    it('does not offer an integration resume while the execution is still running', () => {
      const row = execution({ state: 'running', isolation: isolationWith() });
      const html = renderToStaticMarkup(
        <TeamExecutionStatus
          execution={row}
          variant="list"
          onResume={() => undefined}
          onResumeIntegration={() => undefined}
        />,
      );
      expect(html).not.toContain('data-testid="team-integration-resume"');
      expect(html).not.toContain('data-testid="team-worker-resume"');
    });

    it('offers the standalone integration resume once the execution itself is waiting to resume', () => {
      const standalone = execution({
        state: 'waiting_resume',
        missionId: null,
        isolation: isolationWith(),
      });
      for (const variant of ['canvas', 'list'] as const) {
        const html = renderToStaticMarkup(
          <TeamExecutionStatus
            execution={standalone}
            variant={variant}
            onResumeIntegration={() => undefined}
          />,
        );
        expect(html).toContain('data-testid="team-integration-resume"');
        expect(html).toContain('統合を再開');
      }
      // No callback wired: no orphan button.
      expect(
        renderToStaticMarkup(<TeamExecutionStatus execution={standalone} variant="list" />),
      ).not.toContain('data-testid="team-integration-resume"');
    });

    it('routes the resume to the Mission callback, not the standalone one, once a Mission owns the execution', () => {
      const missionRow = execution({
        state: 'waiting_resume',
        missionId: 'mission-1',
        isolation: isolationWith(),
      });
      // Only the standalone callback wired: a Mission-owned execution must not use it.
      expect(
        renderToStaticMarkup(
          <TeamExecutionStatus
            execution={missionRow}
            variant="list"
            onResumeIntegration={() => undefined}
          />,
        ),
      ).not.toContain('data-testid="team-integration-resume"');
      // Only the Mission callback wired: the same action appears through it.
      const html = renderToStaticMarkup(
        <TeamExecutionStatus execution={missionRow} variant="list" onResume={() => undefined} />,
      );
      expect(html).toContain('data-testid="team-integration-resume"');
      expect(html).toContain('統合を再開');
    });
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
