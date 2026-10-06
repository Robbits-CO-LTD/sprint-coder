import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from './icons';
import type { ApprovalDecision, ApprovalSummary } from '../types/sprint-coder';

export function ApprovalCard({
  approval,
  busy,
  onDecision,
}: {
  approval: ApprovalSummary;
  busy: boolean;
  onDecision: (decision: ApprovalDecision, userInputSelection?: number) => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [executionExpanded, setExecutionExpanded] = useState(false);
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
          <strong>
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
          <dd>{approval.target}</dd>
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
        <button
          type="button"
          className="primary"
          data-testid="approval-allow-once"
          disabled={allowDisabled}
          onClick={() => onDecision('allow_once', userInput === null ? undefined : 0)}
        >
          {userInput?.choices[0] ?? '今回のみ許可'}
        </button>
        {perCall === null ? (
          <button
            data-testid="approval-allow-task"
            type="button"
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
