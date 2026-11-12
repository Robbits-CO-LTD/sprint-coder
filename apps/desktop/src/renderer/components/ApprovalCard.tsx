import { useEffect, useId, useRef, useState } from 'react';
import { Monitor, TriangleAlert } from './icons';
import type { ApprovalDecision, ApprovalSummary } from '../types/sprint-coder';
import { desktopModeLabel, desktopTargetText, desktopTextLabel } from '../lib/desktop-action';

type ApprovalCardProps = {
  approval: ApprovalSummary;
  busy: boolean;
  onDecision: (decision: ApprovalDecision, userInputSelection?: number, grantScope?: 'app') => void;
};

export function ApprovalCard(props: ApprovalCardProps) {
  // A desktop-control run gets its own card, described by Main; any other approval, and a
  // desktop-control approval recorded before that description existed, keeps the command card.
  return props.approval.desktopAction === undefined ? (
    <CommandApprovalCard {...props} />
  ) : (
    <DesktopControlApprovalCard {...props} action={props.approval.desktopAction} />
  );
}

function CommandApprovalCard({ approval, busy, onDecision }: ApprovalCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const [executionExpanded, setExecutionExpanded] = useState(false);
  const ids = useId();
  const headingId = `${ids}-heading`;
  const targetId = `${ids}-target`;
  // A stdin write is approved on its exact characters, and those characters are live-only: they
  // are never stored, so a card rebuilt from a snapshot or from the durable event does not have
  // them (Issue #473). Approving without them would approve bytes nobody read, so the card fails
  // closed — deny stays available, allow does not.
  const stdinApproval = approval.toolName === 'write_stdin';
  const liveDetailMissing = stdinApproval && approval.ephemeralExecution === undefined;
  // Project memory and Skill Drafts are approved one call at a time (Issue #546): the card says what
  // is being kept and where, offers no Task-wide allow, and cannot be allowed when it cannot show
  // the content.
  const perCall = perCallApproval(approval);
  const perCallContentMissing = perCall !== null && perCall.content === null;
  const execution =
    perCall !== null
      ? (perCall.content ?? approval.execution)
      : liveDetailMissing
        ? describeWithheldStdin(approval.execution)
        : (approval.ephemeralExecution ?? approval.execution);
  // Never collapsed for stdin: an allow must not be reachable over a partially rendered value.
  const executionIsLong = !stdinApproval && execution.length > 512;
  const userInput =
    approval.toolName === 'request_user_input' ? parseUserInput(approval.execution) : null;
  const stdinNote = standardInputNote(approval);
  // A per-call approval covers everything it keeps, so it cannot be allowed while part of the
  // content is folded away: the rest of a long memory, or a later file of a draft, is exactly where
  // something unread would sit. Deny stays available throughout.
  const perCallContentCollapsed = perCall !== null && executionIsLong && !executionExpanded;
  const allowDisabled =
    busy || liveDetailMissing || perCallContentMissing || perCallContentCollapsed;
  const labelledBy = userInput === null ? `${headingId} ${targetId}` : headingId;

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [approval.id]);

  return (
    <section
      ref={cardRef}
      className="approval-card"
      aria-label={userInput === null ? 'ツール実行の承認' : 'AIからの確認'}
      aria-busy={busy}
      data-testid="approval-card"
      tabIndex={-1}
    >
      <div className="approval-card__head">
        <span className="approval-card__icon">
          <TriangleAlert size={16} />
        </span>
        <div>
          <strong id={headingId}>
            {perCall !== null
              ? perCall.title
              : userInput === null
                ? '実行の承認が必要です'
                : userInput.question}
          </strong>
          <div className="approval-card__tool">
            {approval.toolName} · {approval.capability}
          </div>
        </div>
        <span className={`approval-card__risk risk-${approval.risk}`}>{approval.risk}</span>
      </div>
      {userInput === null && perCall === null ? <p>{approval.reason}</p> : null}
      {approval.capability === 'shell.execute' ? (
        <p className="approval-card__warning" role="note">
          コマンドの実行または実行中プロセスへの入力を許可します。対象と実行内容を確認してください。
        </p>
      ) : null}
      {stdinNote === null ? null : (
        <p className="approval-card__warning" role="note">
          {stdinNote}
        </p>
      )}
      {liveDetailMissing ? (
        <p className="approval-card__warning" role="alert" data-testid="approval-stdin-withheld">
          入力内容を再取得できないため承認できません。拒否して、送り直してもらってください。
        </p>
      ) : null}
      {perCallContentMissing ? (
        <p className="approval-card__warning" role="alert" data-testid="approval-content-withheld">
          内容を表示できないため許可できません。拒否してください。
        </p>
      ) : null}
      {perCallContentCollapsed ? (
        <p className="approval-card__warning" role="note" data-testid="approval-expand-to-allow">
          内容をすべて表示すると、許可できるようになります。
        </p>
      ) : null}
      <dl className="approval-card__facts">
        <div>
          <dt>対象</dt>
          <dd id={targetId}>{approval.target}</dd>
        </div>
        <div>
          <dt>影響</dt>
          <dd>{perCall?.impact ?? approval.impact}</dd>
        </div>
        <div>
          <dt>{perCall?.contentLabel ?? '実行内容'}</dt>
          <dd>
            <code className={executionIsLong && !executionExpanded ? 'is-collapsed' : undefined}>
              {executionIsLong && !executionExpanded ? `${execution.slice(0, 512)}…` : execution}
            </code>
            {executionIsLong ? (
              <button
                type="button"
                className="approval-card__disclosure"
                aria-expanded={executionExpanded}
                onClick={() => setExecutionExpanded((value) => !value)}
              >
                {executionExpanded ? '実行内容を折り畳む' : '実行内容をすべて表示'}
              </button>
            ) : null}
          </dd>
        </div>
      </dl>
      <div className="approval-card__actions">
        {/* Each button is named with the card's heading (and target), so two cards side by side
            read apart to a screen reader. */}
        <button
          type="button"
          className="primary"
          data-testid="approval-allow-once"
          id={`${ids}-once`}
          aria-labelledby={`${ids}-once ${labelledBy}`}
          disabled={allowDisabled}
          onClick={() => onDecision('allow_once', userInput === null ? undefined : 0)}
        >
          {userInput?.choices[0] ?? '今回のみ許可'}
        </button>
        {perCall === null ? (
          <button
            data-testid="approval-allow-task"
            type="button"
            id={`${ids}-task`}
            aria-labelledby={`${ids}-task ${labelledBy}`}
            disabled={allowDisabled}
            onClick={() => onDecision('allow_task', userInput === null ? undefined : 1)}
          >
            {userInput?.choices[1] ?? 'Task中許可'}
          </button>
        ) : null}
        {userInput === null || userInput.choices.length === 3 ? (
          <button
            className={userInput === null ? 'danger' : undefined}
            data-testid="approval-deny"
            type="button"
            id={`${ids}-deny`}
            aria-labelledby={`${ids}-deny ${labelledBy}`}
            disabled={busy}
            onClick={() => onDecision('deny', userInput === null ? undefined : 2)}
          >
            {userInput?.choices[2] ?? '拒否'}
          </button>
        ) : null}
      </div>
      {busy ? (
        <span className="sr-only" role="status">
          承認結果を保存しています
        </span>
      ) : null}
    </section>
  );
}

type DesktopAction = NonNullable<ApprovalSummary['desktopAction']>;

/**
 * A desktop-control run's card: what it does, to which app and part, and what it enters, as Main
 * described it from the sealed argv. The command itself stays one click away under 「詳細」, open
 * from the start when Main could not confirm the target. 「Task中許可」 is offered only when Main
 * says the run may be covered by one (it refuses one anyway for a run that uses the foreground).
 */
function DesktopControlApprovalCard({
  approval,
  busy,
  onDecision,
  action,
}: ApprovalCardProps & { action: DesktopAction }) {
  const cardRef = useRef<HTMLElement>(null);
  const ids = useId();
  const headingId = `${ids}-heading`;
  const targetId = `${ids}-target`;
  const labelledBy = action.target === undefined ? headingId : `${headingId} ${targetId}`;
  const badge = desktopModeLabel(action);
  // Offered by Main beside 「Task中許可」 only; Main refuses it for a card that did not offer it.
  const appGrant = action.allowTaskGrant ? action.appGrant : undefined;

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [approval.id]);

  return (
    <section
      ref={cardRef}
      className={`approval-card approval-card--desktop approval-card--${action.mode}`}
      aria-labelledby={labelledBy}
      aria-busy={busy}
      data-testid="approval-card"
      data-desktop-mode={action.mode}
      tabIndex={-1}
    >
      <div className="approval-card__head">
        <span className="approval-card__icon">
          <Monitor size={16} />
        </span>
        <div>
          <strong id={headingId}>{action.title}</strong>
          <div className="approval-card__tool">デスクトップ操作</div>
          {action.requester === undefined ? null : (
            // The Team Worker that asked, named as its cursor is.
            <div
              className="approval-card__tool"
              data-testid="desktop-approval-requester"
              data-requester-color={action.requester.colorIndex}
            >
              依頼した Worker: {action.requester.label}
            </div>
          )}
        </div>
        {badge === null ? null : (
          <span
            className={`approval-card__mode is-${action.mode}`}
            data-testid="desktop-approval-mode"
          >
            {badge}
          </span>
        )}
      </div>
      <DesktopStepFacts step={action} targetId={targetId} />
      {action.steps === undefined || action.steps.length === 0 ? null : (
        <ol className="approval-card__steps" data-testid="desktop-approval-steps">
          {action.steps.map((step, index) => (
            <li key={index}>
              <strong>{step.title}</strong>
              {step.mode === 'foreground' && action.mode === 'foreground' ? null : badgeFor(step)}
              <DesktopStepFacts step={step} />
            </li>
          ))}
        </ol>
      )}
      {action.notes.map((note) => (
        <p key={note} className="approval-card__warning" role="note">
          {note}
        </p>
      ))}
      <details
        className="approval-card__details"
        open={action.openDetails}
        data-testid="desktop-approval-details"
      >
        {/* Named with the card's heading and target, so each card's details read apart. */}
        <summary id={`${ids}-details`} aria-labelledby={`${ids}-details ${labelledBy}`}>
          詳細（実行内容）
        </summary>
        <dl className="approval-card__facts">
          <div>
            <dt>実行ファイル</dt>
            <dd>{approval.target}</dd>
          </div>
          <div>
            <dt>影響</dt>
            <dd>{approval.impact}</dd>
          </div>
          <div>
            <dt>実行内容</dt>
            <dd>
              <code>{approval.execution}</code>
            </dd>
          </div>
          <div>
            <dt>道具</dt>
            <dd>
              {approval.toolName} · {approval.capability}
            </dd>
          </div>
          <div>
            <dt>危険度</dt>
            <dd>{approval.risk}</dd>
          </div>
        </dl>
      </details>
      {appGrant === undefined ? null : (
        <p
          id={`${ids}-app-note`}
          className="approval-card__note"
          data-testid="desktop-approval-app-grant-note"
        >
          {desktopAppGrantNote(appGrant.app)}
        </p>
      )}
      <div className="approval-card__actions">
        <button
          type="button"
          className="primary"
          data-testid="approval-allow-once"
          id={`${ids}-once`}
          aria-labelledby={`${ids}-once ${labelledBy}`}
          disabled={busy}
          onClick={() => onDecision('allow_once')}
        >
          今回のみ許可
        </button>
        {action.allowTaskGrant ? (
          <button
            data-testid="approval-allow-task"
            type="button"
            id={`${ids}-task`}
            aria-labelledby={`${ids}-task ${labelledBy}`}
            disabled={busy}
            onClick={() => onDecision('allow_task')}
          >
            Task中許可
          </button>
        ) : null}
        {appGrant === undefined ? null : (
          <button
            data-testid="approval-allow-app-task"
            type="button"
            id={`${ids}-app`}
            aria-labelledby={`${ids}-app ${labelledBy}`}
            aria-describedby={`${ids}-app-note`}
            disabled={busy}
            onClick={() => onDecision('allow_task', undefined, 'app')}
          >
            このアプリは Task 中許可
          </button>
        )}
        <button
          className="danger"
          data-testid="approval-deny"
          type="button"
          id={`${ids}-deny`}
          aria-labelledby={`${ids}-deny ${labelledBy}`}
          disabled={busy}
          onClick={() => onDecision('deny')}
        >
          拒否
        </button>
      </div>
      {busy ? (
        <span className="sr-only" role="status">
          承認結果を保存しています
        </span>
      ) : null}
    </section>
  );
}

/** What 「このアプリは Task 中許可」 allows, and what it leaves on its own card. */
function desktopAppGrantNote(app: string): string {
  return `この Task の間、「${app}」のすべての窓（前から開いていた窓も含む）で、読み取りと、裏での操作（押す・値を入れる・選ぶ・窓の移動や大きさの変更など）を確認なしで進めます。キー入力、窓を前に出す操作、アプリの起動と終了、画面全体を読む操作は、毎回確認します。`;
}

function badgeFor(step: Pick<DesktopAction, 'mode' | 'kind'>) {
  const label = desktopModeLabel(step);
  return label === null ? null : (
    <span className={`approval-card__mode is-${step.mode}`}>{label}</span>
  );
}

function DesktopStepFacts({
  step,
  targetId,
}: {
  step: Pick<DesktopAction, 'target' | 'destination' | 'text' | 'textRole'>;
  targetId?: string;
}) {
  if (step.target === undefined && step.destination === undefined && step.text === undefined)
    return null;
  return (
    <dl className="approval-card__facts">
      {step.target === undefined ? null : (
        <div>
          <dt>対象</dt>
          <dd id={targetId}>{desktopTargetText(step.target)}</dd>
        </div>
      )}
      {step.destination === undefined ? null : (
        <div>
          <dt>移動先</dt>
          <dd>{desktopTargetText(step.destination)}</dd>
        </div>
      )}
      {step.text === undefined ? null : (
        <div>
          <dt>{desktopTextLabel(step)}</dt>
          <dd>
            <code>「{step.text}」</code>
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * Says out loud what the approved command's stdin does. A command spawns with stdin open, so the
 * approved argv is not the whole story; anything written afterwards is approved on its own card
 * (Issue #473), and that card is the one that carries the characters being sent.
 */
function standardInputNote(approval: ApprovalSummary): string | null {
  if (approval.capability !== 'shell.execute') return null;
  if (approval.toolName === 'write_stdin')
    return '実行中のコマンドの標準入力へ送信されます。コマンドの動作は、ここで送る内容によって変わります。';
  let stdinMode: unknown;
  try {
    stdinMode = (JSON.parse(approval.execution) as { stdinMode?: unknown }).stdinMode;
  } catch {
    return null;
  }
  return stdinMode === 'approved-writes'
    ? '標準入力は開いたままです。実行開始後に送られる入力は、write_stdin として別途承認します。'
    : null;
}

/**
 * What a stdin approval shows once its characters are gone.
 *
 * The durable record keeps only how many bytes were offered and their digest — no excerpt, because
 * a bare password typed for `sudo -S` reads as ordinary text and no scanner would have caught it.
 */
function describeWithheldStdin(execution: string): string {
  try {
    const value = JSON.parse(execution) as { charsBytes?: unknown; charsMac?: unknown };
    if (typeof value.charsBytes !== 'number' || typeof value.charsMac !== 'string')
      return execution;
    return `stdin ${value.charsBytes} bytes, mac=${value.charsMac}\n（送信内容は保存していないため表示できません）`;
  } catch {
    return execution;
  }
}

/**
 * The wording of a per-call approval card (Issue #546), keyed on the capability the approval was
 * recorded under. `content` is null when the approved content cannot be read back from the card's
 * execution text, and the card then refuses to be allowed.
 */
function perCallApproval(approval: ApprovalSummary): {
  title: string;
  impact: string;
  contentLabel: string;
  content: string | null;
} | null {
  if (approval.capability === 'project.memory.write')
    return {
      title: 'Project メモリに追加',
      impact: 'この Turn が成功すると追加され、以後の Turn の文脈に入ります',
      contentLabel: '保存する内容',
      content: projectMemoryContent(approval.execution),
    };
  if (approval.capability === 'skill.draft.write')
    return {
      title: 'Skill の下書きを作成',
      impact:
        'レビュー用の下書きとして保存します。インストールはされず、使うには内容を確認してインストールする必要があります',
      contentLabel: '作成する下書き',
      content: skillDraftContent(approval.execution),
    };
  return null;
}

/** Returns the memory text, or null when the execution is not `{ content: string }`. */
function projectMemoryContent(execution: string): string | null {
  try {
    const value = JSON.parse(execution) as { content?: unknown };
    return typeof value.content === 'string' ? value.content : null;
  } catch {
    return null;
  }
}

/** Every file of the draft in full, or null when the execution is not a complete Skill Draft. */
function skillDraftContent(execution: string): string | null {
  try {
    const value = JSON.parse(execution) as { kind?: unknown; skillId?: unknown; files?: unknown };
    const files = value.files;
    if (
      typeof value.kind !== 'string' ||
      typeof value.skillId !== 'string' ||
      !Array.isArray(files) ||
      files.length === 0 ||
      !files.every(
        (file: unknown) =>
          typeof file === 'object' &&
          file !== null &&
          typeof (file as { path?: unknown }).path === 'string' &&
          typeof (file as { content?: unknown }).content === 'string',
      )
    )
      return null;
    return [
      `Skill: ${value.skillId}（${value.kind}）`,
      ...(files as { path: string; content: string }[]).map(
        ({ path, content }) => `--- ${path} ---\n${content}`,
      ),
    ].join('\n\n');
  } catch {
    return null;
  }
}

function parseUserInput(execution: string): { question: string; choices: string[] } | null {
  try {
    const value = JSON.parse(execution) as {
      question?: unknown;
      choices?: unknown;
      raw?: { question?: unknown; choices?: unknown };
    };
    const question = value.question ?? value.raw?.question;
    const choices = value.choices ?? value.raw?.choices;
    if (
      typeof question !== 'string' ||
      !Array.isArray(choices) ||
      choices.length < 2 ||
      choices.length > 3 ||
      !choices.every((choice) => typeof choice === 'string')
    )
      return null;
    return { question, choices: choices as string[] };
  } catch {
    return null;
  }
}
