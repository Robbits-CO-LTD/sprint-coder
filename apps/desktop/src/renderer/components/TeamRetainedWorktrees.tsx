import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Folder, RefreshCw, Trash, X } from './icons';
import { EXECUTION_STATE_LABELS } from '../lib/team-execution-display';
import { retainedWorktreesKey } from '../lib/team-retained-worktrees';
import type {
  TeamDetail,
  TeamRetainedWorktree,
  TeamRetainedWorktreeInspection,
  TeamRetainedWorktreeList,
} from '../types/sprint-coder';

// Retained Worker worktrees (issue #544). A Team Worker's isolated worktree stays on disk when it
// failed or was stopped with changes, when its stop could not be confirmed, when its record predates
// automatic reclaim, when it belongs to a Graph Mission step, or when removing it failed after its
// change was integrated. Before this there was no way to find one short of `git worktree list`.
//
// ONE trigger and ONE dialog, mounted by BOTH Team views (TeamCanvas and TeamListView) for the same
// reason TeamPolicyDialog is: the views are alternate projections of the same Team, and a second
// copy of a control that deletes work is exactly what must never drift. The list itself lives in a
// native modal <dialog>, so it sits above the Canvas's clipped world and inherits the focus trap,
// Escape and inert backdrop, and discarding asks again in a second modal before anything is sent.

/** Header button that opens the list. Nothing is shown while no worktree is left, unless the list
 * is open (its opener must survive until focus goes back to it). */
export function TeamRetainedWorktreesTrigger({
  count,
  open = false,
  onOpen,
}: {
  count: number;
  open?: boolean;
  onOpen: () => void;
}) {
  if (count === 0 && !open) return null;
  return (
    <button
      type="button"
      className="team-policy-btn team-retained-btn"
      data-testid="team-retained-worktrees-open"
      onClick={onOpen}
    >
      {`残っているworktree（${count}件）`}
    </button>
  );
}

const UNINTEGRATED_DISCARD_BODY =
  'このworktreeの変更はWorkspaceに統合されていません。破棄すると元に戻せません。';
export const SUBMODULE_DISCARD_WARNING =
  'このworktreeにはsubmoduleがあります。submoduleの中のコミットはこのworktreeにしか無い可能性があり、Workspaceのsubmoduleがそれを参照していることがあります。破棄すると元に戻せません。';

/**
 * What the discard confirmation says. A worktree whose change is not in the Workspace may hold the
 * only copy of that work, so that case says so first and plainly. Only an integration Main found in
 * the repository's current history counts: one it merely recorded is warned about as unintegrated.
 * A submodule voids the reassurance of an integration too: the integrated gitlink may point at a
 * commit only this worktree's submodule store holds (issue #544). `submodule` is a second warning
 * shown beside `body`, or null.
 */
export function retainedWorktreeDiscardWarning(
  worktree: Pick<TeamRetainedWorktree, 'integration' | 'submodules'>,
): { title: string; body: string; submodule: string | null; note: string } {
  const submodule = worktree.submodules ? SUBMODULE_DISCARD_WARNING : null;
  switch (worktree.integration) {
    case 'confirmed':
      return submodule === null
        ? {
            title: '残っているworktreeを削除しますか？',
            body: '変更はWorkspaceに統合済みです。残っている隔離worktreeを削除します。',
            submodule: null,
            note: '統合の後でこのworktreeに残ったファイルがあれば、それも削除され元に戻せません。',
          }
        : {
            title: 'submoduleのあるworktreeを破棄しますか？',
            body: SUBMODULE_DISCARD_WARNING,
            submodule: null,
            note: '記録上の変更はWorkspaceに入っていますが、submoduleの中のコミットまでは確かめられません。',
          };
    case 'unconfirmed':
      return {
        title: '統合を確認できない変更を破棄しますか？',
        body: UNINTEGRATED_DISCARD_BODY,
        submodule,
        note: '統合したと記録されていますが、今のWorkspaceの履歴には見つかりません。このworktreeにしか残っていない可能性があります。',
      };
    case 'none':
      return {
        title: '統合されていない変更を破棄しますか？',
        body: UNINTEGRATED_DISCARD_BODY,
        submodule,
        note: 'Workerが作ったコミットも、未コミットのファイルも、すべて削除されます。',
      };
  }
}

/** The state column: how far the execution got, whether its change is in the Workspace, and
 * whether a submodule may hold more than that. */
export function retainedWorktreeStateLabel(
  worktree: Pick<TeamRetainedWorktree, 'executionState' | 'integration' | 'submodules'>,
): string {
  const integration = {
    none: '未統合（変更を保持）',
    confirmed: '統合済み（片付けに失敗）',
    unconfirmed: '統合を確認できません（Workspaceの履歴に見つかりません）',
  }[worktree.integration];
  return `${EXECUTION_STATE_LABELS[worktree.executionState]} · ${integration}${
    worktree.submodules ? ' · submoduleあり' : ''
  }`;
}

type InspectionState =
  | { status: 'loading' }
  | { status: 'ready'; value: TeamRetainedWorktreeInspection }
  | { status: 'error'; message: string };

export function TeamRetainedWorktreesDialog({
  taskId,
  detail,
  onClose,
}: {
  taskId: string;
  /** Current canonical Team detail. The list is fetched again whenever what Main's discard rule
   * reads from it changes. */
  detail: TeamDetail;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);
  const requestRef = useRef(0);
  const baseId = useId();
  const [list, setList] = useState<TeamRetainedWorktreeList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspections, setInspections] = useState<Readonly<Record<string, InspectionState>>>({});
  const [confirming, setConfirming] = useState<TeamRetainedWorktree | null>(null);
  const retainedKey = retainedWorktreesKey(detail);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
  }, []);

  const load = useCallback(async () => {
    const api = window.sprintCoder?.teams;
    if (typeof api?.listRetainedWorktrees !== 'function') {
      setError('この環境では残っているworktreeを確認できません。');
      return;
    }
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const next = await api.listRetainedWorktrees(taskId);
      if (request !== requestRef.current) return;
      setList(next);
      setError(null);
    } catch (err) {
      if (request === requestRef.current)
        setError(`一覧を読み込めませんでした: ${describeError(err)}`);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [taskId]);

  // `retainedKey` is what makes this refetch: an execution finishing, an isolation changing phase,
  // or a repository being cleaned elsewhere. Streamed Worker output leaves it unchanged.
  useEffect(() => {
    void load();
  }, [load, retainedKey]);

  function closeAndRestoreFocus(): void {
    if (closingRef.current || busy) return;
    closingRef.current = true;
    const opener = openerRef.current;
    const openerTestId = opener?.dataset.testid;
    openerRef.current = null;
    dialogRef.current?.close();
    onClose();
    // Same restoration as TeamPolicyDialog: the parent unmounts this dialog, and a Team update can
    // replace the header button, so the trigger is looked up again after the commit.
    const restore = (): void => {
      const currentTrigger = openerTestId
        ? document.querySelector<HTMLElement>(`[data-testid="${openerTestId}"]`)
        : null;
      const target = currentTrigger ?? (opener && document.contains(opener) ? opener : null);
      target?.focus({ preventScroll: true });
    };
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(restore);
    });
  }

  async function toggleInspection(worktree: TeamRetainedWorktree): Promise<void> {
    const key = worktreeKey(worktree);
    if (inspections[key] !== undefined) {
      setInspections(({ [key]: _closed, ...rest }) => rest);
      return;
    }
    const api = window.sprintCoder?.teams;
    if (typeof api?.inspectRetainedWorktree !== 'function') return;
    setInspections((current) => ({ ...current, [key]: { status: 'loading' } }));
    try {
      const value = await api.inspectRetainedWorktree(worktreeRef(taskId, worktree));
      setInspections((current) =>
        current[key] === undefined ? current : { ...current, [key]: { status: 'ready', value } },
      );
    } catch (err) {
      setInspections((current) =>
        current[key] === undefined
          ? current
          : { ...current, [key]: { status: 'error', message: describeError(err) } },
      );
    }
  }

  async function openFolder(worktree: TeamRetainedWorktree): Promise<void> {
    const api = window.sprintCoder?.teams;
    if (typeof api?.openRetainedWorktree !== 'function') return;
    setError(null);
    try {
      await api.openRetainedWorktree(worktreeRef(taskId, worktree));
    } catch (err) {
      setError(`フォルダを開けませんでした: ${describeError(err)}`);
    }
  }

  async function discard(worktree: TeamRetainedWorktree): Promise<string | null> {
    const api = window.sprintCoder?.teams;
    if (typeof api?.discardRetainedWorktree !== 'function')
      return 'この環境ではworktreeを破棄できません。';
    setBusy(true);
    try {
      const next = await api.discardRetainedWorktree(worktreeRef(taskId, worktree));
      // Any list still in flight was read before this discard.
      requestRef.current += 1;
      setLoading(false);
      setList(next);
      setError(null);
      setInspections(({ [worktreeKey(worktree)]: _gone, ...rest }) => rest);
      setNotice(`${worktree.role}のRepo ${worktree.repositoryOrdinal}のworktreeを破棄しました。`);
      return null;
    } catch (err) {
      return describeError(err);
    } finally {
      setBusy(false);
    }
  }

  const worktrees = list?.worktrees ?? [];
  const hidden = list === null ? 0 : list.total - list.worktrees.length;

  return (
    <dialog
      ref={dialogRef}
      className="team-policy-dialog team-retained-dialog"
      data-testid="team-retained-worktrees-dialog"
      aria-labelledby={`${baseId}-title`}
      aria-describedby={`${baseId}-note`}
      // Only this dialog's own events: the confirmation's reach here through the React tree.
      onCancel={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        closeAndRestoreFocus();
      }}
      onClose={(e) => {
        if (e.target === e.currentTarget) closeAndRestoreFocus();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) closeAndRestoreFocus();
      }}
    >
      <div className="team-policy-body">
        <header className="team-policy-header">
          <h2 id={`${baseId}-title`}>{`残っているworktree（${list?.total ?? 0}件）`}</h2>
          <button
            ref={refreshRef}
            type="button"
            className="settings-secondary-button team-retained-refresh"
            data-testid="team-retained-refresh"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            <RefreshCw size={13} /> 一覧を更新
          </button>
          <button
            type="button"
            className="settings-close"
            data-testid="team-retained-close"
            aria-label="残っているworktreeの一覧を閉じる"
            disabled={busy}
            onClick={closeAndRestoreFocus}
          >
            <X size={16} />
          </button>
        </header>

        <p className="settings-note" id={`${baseId}-note`}>
          Workerの作業用に作った隔離worktreeのうち、自動では片付けなかったものです。中身を確認してから、不要なものを破棄できます。
        </p>

        {error !== null && (
          <p className="team-policy-error" data-testid="team-retained-error" role="alert">
            <span aria-hidden="true">!</span> {error}
          </p>
        )}
        <p className="team-retained-notice" role="status" data-testid="team-retained-notice">
          {notice ?? ''}
        </p>

        {list === null ? (
          <p className="settings-hint">{loading ? '読み込み中…' : ''}</p>
        ) : worktrees.length === 0 ? (
          <p className="settings-hint" data-testid="team-retained-empty">
            残っているworktreeはありません。
          </p>
        ) : (
          <ul className="team-retained-list" aria-label="残っているworktree">
            {worktrees.map((worktree) => {
              const key = worktreeKey(worktree);
              const itemId = `${baseId}-${worktree.executionId}-${worktree.repositoryOrdinal}`;
              const inspection = inspections[key];
              return (
                <li
                  key={key}
                  className="team-retained-item"
                  data-testid="team-retained-worktree"
                  aria-labelledby={`${itemId}-heading`}
                >
                  <h3 id={`${itemId}-heading`} className="team-retained-heading">
                    {`${worktree.role} · Repo ${worktree.repositoryOrdinal}`}
                  </h3>
                  <dl className="team-retained-facts">
                    <div>
                      <dt>repository</dt>
                      <dd>{worktree.repoPath}</dd>
                    </div>
                    <div>
                      <dt>状態</dt>
                      <dd data-testid="team-retained-state">
                        {retainedWorktreeStateLabel(worktree)}
                      </dd>
                    </div>
                    {worktree.reason !== null && (
                      <div>
                        <dt>理由</dt>
                        <dd data-testid="team-retained-reason">{worktree.reason}</dd>
                      </div>
                    )}
                    <div>
                      <dt>記録上の変更</dt>
                      <dd data-testid="team-retained-changed-count">{`${worktree.changedFileCount}件`}</dd>
                    </div>
                    <div>
                      <dt>worktree</dt>
                      <dd>
                        {worktree.worktreePath}
                        {!worktree.existsOnDisk &&
                          '（フォルダはもうありません。破棄すると記録だけを片付けます）'}
                      </dd>
                    </div>
                  </dl>
                  {worktree.blockedReason !== null && (
                    <p
                      className="team-retained-blocked"
                      id={`${itemId}-blocked`}
                      data-testid="team-retained-blocked-reason"
                    >
                      {`破棄できない理由: ${worktree.blockedReason}`}
                    </p>
                  )}
                  <div className="team-retained-actions">
                    <button
                      type="button"
                      className="settings-secondary-button"
                      data-testid="team-retained-inspect"
                      aria-expanded={inspection !== undefined}
                      aria-controls={`${itemId}-inspection`}
                      disabled={!worktree.existsOnDisk || busy}
                      onClick={() => void toggleInspection(worktree)}
                    >
                      {inspection === undefined ? '中身を確認' : '中身を閉じる'}
                    </button>
                    <button
                      type="button"
                      className="settings-secondary-button"
                      data-testid="team-retained-open-folder"
                      disabled={!worktree.existsOnDisk || busy}
                      onClick={() => void openFolder(worktree)}
                    >
                      <Folder size={13} /> フォルダを開く
                    </button>
                    <button
                      type="button"
                      className="settings-danger-button"
                      data-testid="team-retained-discard"
                      disabled={!worktree.discardable || busy}
                      aria-describedby={
                        worktree.blockedReason === null ? undefined : `${itemId}-blocked`
                      }
                      onClick={() => setConfirming(worktree)}
                    >
                      <Trash size={13} /> 破棄
                    </button>
                  </div>
                  {inspection !== undefined && (
                    <InspectionPanel id={`${itemId}-inspection`} state={inspection} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 && (
          <p className="settings-hint">{`ほかに${hidden}件あります。破棄すると続きが表示されます。`}</p>
        )}
      </div>
      {confirming !== null && (
        <DiscardConfirmDialog
          worktree={confirming}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => discard(confirming)}
          onDiscarded={() => {
            setConfirming(null);
            // The discarded row, which held focus before the confirmation, is gone.
            requestAnimationFrame(() => refreshRef.current?.focus({ preventScroll: true }));
          }}
        />
      )}
    </dialog>
  );
}

function InspectionPanel({ id, state }: { id: string; state: InspectionState }) {
  if (state.status === 'loading')
    return (
      <div className="team-retained-inspection" id={id} data-testid="team-retained-inspection">
        <p className="settings-hint">読み込み中…</p>
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="team-retained-inspection" id={id} data-testid="team-retained-inspection">
        <p className="team-policy-error" role="alert">
          <span aria-hidden="true">!</span> {state.message}
        </p>
      </div>
    );
  const { value } = state;
  return (
    <div className="team-retained-inspection" id={id} data-testid="team-retained-inspection">
      <p className="settings-hint">
        {`HEAD ${value.head.slice(0, 12)} · ${
          value.commitsSinceBase === 0
            ? '基準から新しいコミットはありません'
            : `基準から${value.commitsSinceBase}件のコミット`
        }`}
      </p>
      <h4>作業中の変更（git status）</h4>
      <ChangeList
        entries={value.status.map(({ code, path }) => ({
          label: statusLabel(code),
          code,
          path,
        }))}
        truncated={value.statusTruncated}
        testId="team-retained-status"
      />
      <h4>基準のコミットからの変更（追跡中のファイル）</h4>
      <ChangeList
        entries={value.changesFromBase.map(({ status, path }) => ({
          label: changeLabel(status),
          code: status,
          path,
        }))}
        truncated={value.changesFromBaseTruncated}
        testId="team-retained-changes"
      />
    </div>
  );
}

function ChangeList({
  entries,
  truncated,
  testId,
}: {
  entries: readonly { label: string; code: string; path: string }[];
  truncated: boolean;
  testId: string;
}) {
  if (entries.length === 0) return <p className="settings-hint">ありません。</p>;
  return (
    <>
      <ul className="team-retained-files" data-testid={testId}>
        {entries.map(({ label, code, path }, index) => (
          <li key={`${index}:${path}`}>
            <span className="team-retained-file-label">{label}</span>
            <code title={code}>{path}</code>
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="settings-hint">{`多すぎるため、最初の${entries.length}件だけを表示しています。`}</p>
      )}
    </>
  );
}

function DiscardConfirmDialog({
  worktree,
  busy,
  onCancel,
  onConfirm,
  onDiscarded,
}: {
  worktree: TeamRetainedWorktree;
  busy: boolean;
  onCancel: () => void;
  /** Resolves to the failure to show, or null once the worktree is gone. */
  onConfirm: () => Promise<string | null>;
  onDiscarded: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const baseId = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const warning = retainedWorktreeDiscardWarning(worktree);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  function cancel(): void {
    if (busy) return;
    // Close the top-layer entry before the parent unmounts it (see TeamPolicyDialog).
    dialogRef.current?.close();
    onCancel();
  }

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      className="team-policy-dialog team-retained-confirm"
      data-testid="team-retained-confirm"
      aria-labelledby={`${baseId}-title`}
      aria-describedby={`${baseId}-body`}
      // React passes a nested dialog's cancel and close up to the list dialog, which would close
      // the whole list; they end here.
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }}
      onClose={(e) => e.stopPropagation()}
    >
      <div className="team-policy-body">
        <header className="team-policy-header">
          <h2 id={`${baseId}-title`}>{warning.title}</h2>
        </header>
        <div id={`${baseId}-body`}>
          <p className="team-retained-warning" data-testid="team-retained-confirm-warning">
            {warning.body}
          </p>
          {warning.submodule !== null && (
            <p className="team-retained-warning" data-testid="team-retained-confirm-submodule">
              {warning.submodule}
            </p>
          )}
          <p className="settings-note">{warning.note}</p>
        </div>
        <dl className="team-retained-facts">
          <div>
            <dt>Worker</dt>
            <dd>{`${worktree.role} · Repo ${worktree.repositoryOrdinal}`}</dd>
          </div>
          <div>
            <dt>repository</dt>
            <dd>{worktree.repoPath}</dd>
          </div>
          <div>
            <dt>worktree</dt>
            <dd>{worktree.worktreePath}</dd>
          </div>
        </dl>
        {failure !== null && (
          <p className="team-policy-error" data-testid="team-retained-confirm-error" role="alert">
            <span aria-hidden="true">!</span> {failure}
          </p>
        )}
        <div className="team-policy-actions">
          <button
            type="button"
            className="settings-secondary-button"
            data-testid="team-retained-confirm-cancel"
            // The safe choice holds focus first, so Enter alone never deletes work.
            autoFocus
            disabled={busy}
            onClick={cancel}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="settings-danger-button"
            data-testid="team-retained-confirm-discard"
            disabled={busy}
            onClick={() => {
              setFailure(null);
              void onConfirm().then((message) => {
                if (message !== null) {
                  setFailure(message);
                  return;
                }
                dialogRef.current?.close();
                onDiscarded();
              });
            }}
          >
            {busy ? '破棄しています…' : '破棄する'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function worktreeKey(worktree: Pick<TeamRetainedWorktree, 'executionId' | 'repositoryOrdinal'>) {
  return `${worktree.executionId}:${worktree.repositoryOrdinal}`;
}

function worktreeRef(
  taskId: string,
  worktree: Pick<TeamRetainedWorktree, 'executionId' | 'repositoryOrdinal'>,
) {
  return {
    taskId,
    executionId: worktree.executionId,
    repositoryOrdinal: worktree.repositoryOrdinal,
  };
}

const CHANGE_LABELS: Readonly<Record<string, string>> = {
  A: '追加',
  C: 'コピー',
  D: '削除',
  M: '変更',
  R: '名前変更',
  T: '種類変更',
  U: '競合',
};

/** `git diff --name-status` letter in words; an unknown one is shown as it is. */
function changeLabel(status: string): string {
  return CHANGE_LABELS[status.charAt(0)] ?? status;
}

/** `git status --porcelain` two-letter code in words, preferring the working-tree side. */
function statusLabel(code: string): string {
  if (code === '??') return '未追跡';
  if (code === '!!') return '無視';
  const letter = code.charAt(1) !== ' ' ? code.charAt(1) : code.charAt(0);
  return CHANGE_LABELS[letter] ?? code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
