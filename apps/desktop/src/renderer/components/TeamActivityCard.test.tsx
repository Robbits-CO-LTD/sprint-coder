import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamActivityCard } from './TeamActivityCard';
import {
  EMPTY_ACTIVITY_GROUPS,
  MODEL_SELECTION_REASON_MAX_LENGTH,
  UNKNOWN_ACTIVITY_HEADLINE,
  UNKNOWN_MODEL_SELECTION_LABEL,
  activityHeadline,
  describeActivity,
  describeWorkerModel,
  groupActivitiesByMessage,
  orderedActivities,
} from '../lib/team-activity-display';
import { BUILTIN_CONNECTION_LABELS, QUEUE_REASON_LABELS } from '../lib/team-execution-display';
import type { ChatMessage, TeamActivitySummary, WorkerSummary } from '../types/sprint-coder';

let nextSeq = 0;

function activity(overrides: Partial<TeamActivitySummary> = {}): TeamActivitySummary {
  nextSeq += 1;
  return {
    id: `act-${nextSeq}`,
    teamId: 'team-1',
    seq: nextSeq,
    type: 'worker_hired',
    actorAgentId: 'leader-1',
    actorRole: 'Leader',
    subjectAgentId: 'worker-1',
    subjectRole: 'Reviewer',
    executionId: null,
    attemptId: null,
    status: null,
    queueReason: null,
    attemptOrdinal: null,
    terminalReason: null,
    connectionId: null,
    requestedProvider: null,
    requestedModel: null,
    modelSelectionReason: null,
    recordedAt: '2026-07-28T01:00:00.000Z',
    ...overrides,
  };
}

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: 'worker-1',
    teamId: 'team-1',
    threadId: 'thread-1',
    taskId: 'task-1',
    kind: 'worker',
    role: 'Reviewer',
    state: 'ready',
    objective: 'レビューする',
    writeCapable: false,
    currentActivity: null,
    engine: 'mock',
    connectionId: null,
    requestedProvider: null,
    requestedModel: null,
    parentAgentId: 'leader-1',
    depth: 1,
    canDelegate: false,
    managerPolicy: null,
    liveOutput: '',
    reasoningActive: false,
    usage: { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 },
    createdAt: '2026-07-28T01:00:00.000Z',
    updatedAt: '2026-07-28T01:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    author: 'user',
    content: 'こんにちは',
    createdAt: '2026-07-28T01:00:00.000Z',
    ...overrides,
  };
}

const ALL_TYPES: TeamActivitySummary['type'][] = [
  'worker_hired',
  'task_assigned',
  'execution_queued',
  'execution_waiting',
  'execution_started',
  'execution_finished',
  'steered',
  'attempt_started',
  'attempt_finished',
  'worker_reported',
  'worker_stopped',
];

describe('activity headlines', () => {
  it('names the hire and the assignment exactly as the Team log describes them', () => {
    expect(
      activityHeadline(
        activity({ type: 'worker_hired', actorRole: 'Leader', subjectRole: 'Reviewer' }),
      ),
    ).toBe('Leaderが「Reviewer」を雇いました');
    expect(
      activityHeadline(
        activity({ type: 'task_assigned', actorRole: 'Leader', subjectRole: 'Reviewer' }),
      ),
    ).toBe('LeaderがReviewerへ作業を任せました');
  });

  it('gives every persisted type a distinct Japanese sentence', () => {
    const headlines = ALL_TYPES.map((type) => activityHeadline(activity({ type })));
    for (const headline of headlines) {
      expect(headline).not.toBe('');
      expect(headline).not.toBe(UNKNOWN_ACTIVITY_HEADLINE);
      expect(headline).toMatch(/ました$/);
    }
    expect(new Set(headlines).size).toBe(ALL_TYPES.length);
  });

  it('never claims an outcome the backend did not record', () => {
    for (const type of ALL_TYPES) {
      const display = describeActivity(activity({ type, status: null, terminalReason: null }));
      expect(display.headline).not.toMatch(/成功|失敗/);
      expect(display.detailLabel).toBeNull();
    }
  });

  it('falls back to Leader / Agent for unnamed roles, never to a blank', () => {
    expect(
      activityHeadline(activity({ type: 'worker_hired', actorRole: null, subjectRole: null })),
    ).toBe('Leaderが「Agent」を雇いました');
    expect(
      activityHeadline(activity({ type: 'task_assigned', actorRole: '  ', subjectRole: '' })),
    ).toBe('LeaderがAgentへ作業を任せました');
    for (const type of ALL_TYPES) {
      const headline = activityHeadline(activity({ type, actorRole: null, subjectRole: null }));
      expect(headline).toMatch(/Leader|Agent/);
    }
  });

  it('keeps an unknown future type readable instead of blank', () => {
    const display = describeActivity(
      activity({ type: 'moon_landed' as TeamActivitySummary['type'] }),
    );
    expect(display.headline).toBe(UNKNOWN_ACTIVITY_HEADLINE);
    expect(display.details).toContain('種別 moon_landed');
  });
});

describe('activity supplements', () => {
  it('uses the C1b wording for all six queue reasons', () => {
    for (const reason of Object.keys(QUEUE_REASON_LABELS) as (keyof typeof QUEUE_REASON_LABELS)[]) {
      const display = describeActivity(activity({ type: 'execution_queued', queueReason: reason }));
      expect(display.details).toContain(`待機理由 ${QUEUE_REASON_LABELS[reason]}`);
    }
    expect(Object.keys(QUEUE_REASON_LABELS)).toHaveLength(6);
  });

  it('adds status, terminal reason and attempt ordinal only when recorded', () => {
    const full = describeActivity(
      activity({
        type: 'attempt_finished',
        status: 'failed',
        terminalReason: 'tool_error',
        attemptOrdinal: 2,
      }),
    );
    expect(full.detailLabel).toBe('試行 2回目 · 状態 failed · 終了理由 tool_error');

    const bare = describeActivity(
      activity({
        type: 'attempt_finished',
        status: null,
        terminalReason: null,
        attemptOrdinal: null,
      }),
    );
    expect(bare.details).toEqual([]);
    expect(bare.detailLabel).toBeNull();
  });

  it('treats attempt ordinal 0 as a real ordinal and empty strings as absent', () => {
    expect(describeActivity(activity({ attemptOrdinal: 0 })).details).toContain('試行 0回目');
    expect(describeActivity(activity({ status: '', terminalReason: '' })).details).toEqual([]);
  });
});

describe('worker model selection', () => {
  it('shows the model and Connection a Worker actually got', () => {
    const display = describeWorkerModel(
      worker({ connectionId: 'conn-openai-prod', requestedModel: 'gpt-5' }),
    );
    expect(display.modelLabel).toBe('gpt-5');
    expect(display.connectionLabel).toBe('conn-openai-prod');
    expect(display.ariaSummary).toBe('モデル gpt-5、Connection conn-openai-prod');
  });

  it('names built-in Connections with the same map the execution card uses', () => {
    expect(
      describeWorkerModel(worker({ connectionId: 'builtin:claude-cli' })).connectionLabel,
    ).toBe(BUILTIN_CONNECTION_LABELS['builtin:claude-cli']);
  });

  it('says 不明 rather than going blank when a value was not recorded', () => {
    const none = describeWorkerModel(worker({ connectionId: null, requestedModel: null }));
    expect(none.modelLabel).toBe(UNKNOWN_MODEL_SELECTION_LABEL);
    expect(none.connectionLabel).toBe(UNKNOWN_MODEL_SELECTION_LABEL);

    const blank = describeWorkerModel(worker({ connectionId: '  ', requestedModel: '' }));
    expect(blank.modelLabel).toBe(UNKNOWN_MODEL_SELECTION_LABEL);
    expect(blank.connectionLabel).toBe(UNKNOWN_MODEL_SELECTION_LABEL);
  });

  it('never derives a model or provider name from the engine', () => {
    for (const engine of ['mock', 'codex', 'claude'] as WorkerSummary['engine'][]) {
      const display = describeWorkerModel(worker({ engine, requestedModel: null }));
      expect(display.modelLabel).toBe(UNKNOWN_MODEL_SELECTION_LABEL);
    }
  });
});

describe('worker_hired model supplements', () => {
  it('shows the model, the Connection and the selection reason on the hire', () => {
    const display = describeActivity(
      activity({
        type: 'worker_hired',
        connectionId: 'builtin:codex-cli',
        requestedProvider: 'openai',
        requestedModel: 'gpt-5-codex',
        modelSelectionReason: 'コードレビュー向けに推論の強いモデルを選定',
      }),
    );
    expect(display.detailLabel).toBe(
      `モデル gpt-5-codex · Connection ${BUILTIN_CONNECTION_LABELS['builtin:codex-cli']} · 選定理由 コードレビュー向けに推論の強いモデルを選定`,
    );
    expect(display.ariaSummary).toContain('選定理由');
  });

  it('shows only the values that exist, and invents no 不明 placeholder', () => {
    const modelOnly = describeActivity(
      activity({ type: 'worker_hired', requestedModel: 'gpt-5', modelSelectionReason: null }),
    );
    expect(modelOnly.detailLabel).toBe('モデル gpt-5');

    const reasonOnly = describeActivity(
      activity({ type: 'worker_hired', modelSelectionReason: 'Leaderの既定' }),
    );
    expect(reasonOnly.detailLabel).toBe('選定理由 Leaderの既定');

    const nothing = describeActivity(activity({ type: 'worker_hired' }));
    expect(nothing.details).toEqual([]);
    expect(nothing.detailLabel).toBeNull();
    expect(nothing.ariaSummary).not.toContain(UNKNOWN_MODEL_SELECTION_LABEL);
  });

  it('collapses and clamps a long reason so one card stays one line of annotation', () => {
    const display = describeActivity(
      activity({
        type: 'worker_hired',
        modelSelectionReason: `理由\n\n続き   ${'あ'.repeat(400)}`,
      }),
    );
    const detail = display.details.find((d) => d.startsWith('選定理由')) ?? '';
    expect(detail).toContain('理由 続き');
    expect(detail).not.toContain('\n');
    expect(detail.endsWith('…')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(
      '選定理由 '.length + MODEL_SELECTION_REASON_MAX_LENGTH + 1,
    );
  });

  it('leaves every other activity type exactly as it was', () => {
    for (const type of ALL_TYPES) {
      if (type === 'worker_hired') continue;
      const display = describeActivity(
        activity({
          type,
          connectionId: 'builtin:claude-cli',
          requestedModel: 'claude-opus-5',
          modelSelectionReason: 'ここには出さない',
        }),
      );
      expect(display.detailLabel).toBeNull();
    }
  });

  it('renders the hire supplements in the card itself', () => {
    const html = renderToStaticMarkup(
      <TeamActivityCard
        activity={describeActivity(
          activity({
            type: 'worker_hired',
            requestedModel: 'gpt-5',
            connectionId: 'conn-1',
            modelSelectionReason: '短時間で終わる作業のため',
          }),
        )}
      />,
    );
    expect(html).toContain('data-testid="team-activity-detail"');
    expect(html).toContain('モデル gpt-5');
    expect(html).toContain('Connection conn-1');
    expect(html).toContain('選定理由 短時間で終わる作業のため');
    // Still inert: the supplement added no control and no new live-region urgency.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-live="assertive"');
  });
});

describe('orderedActivities', () => {
  it('sorts by seq and drops repeated ids', () => {
    const first = activity({ id: 'a', seq: 5 });
    const second = activity({ id: 'b', seq: 1 });
    const repeat = activity({ id: 'a', seq: 99 });
    expect(orderedActivities([first, second, repeat]).map((a) => a.id)).toEqual(['b', 'a']);
    expect(orderedActivities([])).toEqual([]);
    expect(orderedActivities(null)).toEqual([]);
    expect(orderedActivities(undefined)).toEqual([]);
  });
});

describe('groupActivitiesByMessage', () => {
  const bucketIds = (
    groups: ReturnType<typeof groupActivitiesByMessage>,
    messageId: string,
  ): string[] => (groups.byMessageId[messageId] ?? []).map((a) => a.id);

  const messages = [
    message({ id: 'm1', createdAt: '2026-07-28T01:00:00.000Z' }),
    message({ id: 'm2', createdAt: '2026-07-28T03:00:00.000Z' }),
  ];

  it('slots each activity into the gap its recordedAt falls in', () => {
    const before = activity({ id: 'before', seq: 1, recordedAt: '2026-07-28T00:30:00.000Z' });
    const between = activity({ id: 'between', seq: 2, recordedAt: '2026-07-28T02:00:00.000Z' });
    const after = activity({ id: 'after', seq: 3, recordedAt: '2026-07-28T09:00:00.000Z' });

    const groups = groupActivitiesByMessage(messages, [after, before, between]);
    expect(groups.leading.map((a) => a.id)).toEqual(['before']);
    expect(bucketIds(groups, 'm1')).toEqual(['between']);
    expect(bucketIds(groups, 'm2')).toEqual(['after']);
  });

  it('keeps seq order inside a bucket and drops nothing', () => {
    const list = [
      activity({ id: 'c', seq: 3, recordedAt: '2026-07-28T02:30:00.000Z' }),
      activity({ id: 'a', seq: 1, recordedAt: '2026-07-28T02:10:00.000Z' }),
      activity({ id: 'b', seq: 2, recordedAt: '2026-07-28T02:20:00.000Z' }),
    ];
    const groups = groupActivitiesByMessage(messages, list);
    expect(bucketIds(groups, 'm1')).toEqual(['a', 'b', 'c']);
    const total = groups.leading.length + Object.values(groups.byMessageId).flat().length;
    expect(total).toBe(3);
  });

  it('puts an activity recorded exactly at a message time after that message', () => {
    const groups = groupActivitiesByMessage(messages, [
      activity({ id: 'tie', recordedAt: '2026-07-28T03:00:00.000Z' }),
    ]);
    expect(groups.leading).toEqual([]);
    expect(bucketIds(groups, 'm2')).toEqual(['tie']);
  });

  it('renders nothing extra when there are no activities, and keeps everything with no messages', () => {
    expect(groupActivitiesByMessage(messages, [])).toBe(EMPTY_ACTIVITY_GROUPS);
    expect(groupActivitiesByMessage(messages, null).leading).toEqual([]);
    expect(
      groupActivitiesByMessage([], [activity({ id: 'lone' })]).leading.map((a) => a.id),
    ).toEqual(['lone']);
  });

  it('never renders the same activity id twice across buckets', () => {
    const dup = activity({ id: 'same', seq: 4, recordedAt: '2026-07-28T09:00:00.000Z' });
    const groups = groupActivitiesByMessage(messages, [
      dup,
      { ...dup, seq: 5, recordedAt: '2026-07-28T00:00:00.000Z' },
    ]);
    const ids = [...groups.leading, ...Object.values(groups.byMessageId).flat()].map((a) => a.id);
    expect(ids).toEqual(['same']);
  });
});

describe('<TeamActivityCard />', () => {
  it('shows the time, the sentence and the recorded supplements', () => {
    const display = describeActivity(
      activity({
        type: 'execution_queued',
        actorRole: 'Leader',
        subjectRole: 'Reviewer',
        queueReason: 'rate_limit',
        status: 'queued',
      }),
    );
    const html = renderToStaticMarkup(<TeamActivityCard activity={display} />);

    expect(html).toContain('data-testid="team-activity-card"');
    expect(html).toContain('data-activity-type="execution_queued"');
    expect(html).toContain('Reviewerの実行が順番待ちに入りました');
    expect(html).toContain(QUEUE_REASON_LABELS.rate_limit);
    expect(html).toContain('状態 queued');
    // Machine-readable timestamp on the <time> element (React emits the attribute name as authored;
    // HTML attribute names are case-insensitive).
    expect(html).toMatch(
      /dateTime="2026-07-28T01:00:00\.000Z"|datetime="2026-07-28T01:00:00\.000Z"/,
    );
    expect(html).toContain(display.timeLabel);
  });

  it('announces politely without adding anything focusable or animated', () => {
    const html = renderToStaticMarkup(
      <TeamActivityCard activity={describeActivity(activity({ type: 'worker_hired' }))} />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('aria-live="assertive"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('href');
    expect(html).not.toContain('<details');
  });

  it('omits the supplement line entirely when nothing was recorded', () => {
    const html = renderToStaticMarkup(
      <TeamActivityCard activity={describeActivity(activity({ type: 'worker_hired' }))} />,
    );
    expect(html).not.toContain('data-testid="team-activity-detail"');
  });

  it('renders a card for every persisted type with a non-empty sentence', () => {
    for (const type of ALL_TYPES) {
      const html = renderToStaticMarkup(
        <TeamActivityCard activity={describeActivity(activity({ type }))} />,
      );
      expect(html).toContain(`data-activity-type="${type}"`);
      expect(html).toContain('data-testid="team-activity-headline"');
    }
  });
});
