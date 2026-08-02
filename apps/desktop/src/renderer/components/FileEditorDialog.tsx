import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileOpenResult } from '../types/sprint-coder';

type LineEnding = 'crlf' | 'lf';

const REFUSAL_MESSAGE: Record<NonNullable<FileOpenResult['reason']>, string> = {
  too_large: 'このファイルは大きすぎるため編集できません（上限2 MiB）。',
  binary: 'バイナリファイルは編集できません。',
  not_a_file: '通常のファイルではないか、ファイルが見つかりません。',
  outside_workspace: 'Workspace外または安全でないリンク先のファイルは開けません。',
};

export function FileEditorDialog({
  taskId,
  hasWorkspace,
}: {
  taskId: string;
  hasWorkspace: boolean;
}) {
  const [opened, setOpened] = useState<FileOpenResult | null>(null);
  const [draft, setDraft] = useState('');
  const [lineEnding, setLineEnding] = useState<LineEnding>('lf');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const filesApi = typeof window !== 'undefined' ? window.sprintCoder?.files : undefined;
  const supported = typeof filesApi?.pick === 'function';
  const dirty = useMemo(
    () => opened?.editable === true && diskText(draft, lineEnding) !== opened.text,
    [draft, lineEnding, opened],
  );

  useEffect(() => {
    if (opened?.editable) editorRef.current?.focus();
  }, [opened]);

  async function pick(): Promise<void> {
    if (!filesApi) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await filesApi.pick(taskId);
      if (result === null) return;
      if (!result.editable) {
        setMessage(REFUSAL_MESSAGE[result.reason ?? 'not_a_file']);
        return;
      }
      loadResult(result);
    } catch {
      setMessage('ファイル選択に失敗しました。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  function loadResult(result: FileOpenResult): void {
    setOpened(result);
    setLineEnding(result.text.includes('\r\n') ? 'crlf' : 'lf');
    setDraft(result.text.replaceAll('\r\n', '\n'));
    setMessage('読み込みました');
    setConfirmDiscard(false);
  }

  async function reload(): Promise<void> {
    if (!opened || !filesApi) return;
    setBusy(true);
    try {
      const result = await filesApi.open(taskId, opened.rootId, opened.path);
      if (result.editable) loadResult(result);
      else setMessage(REFUSAL_MESSAGE[result.reason ?? 'not_a_file']);
    } catch {
      setMessage('再読み込みに失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!opened?.editable || busy || !filesApi) return;
    setBusy(true);
    try {
      const text = diskText(draft, lineEnding);
      const result = await filesApi.save({
        taskId,
        rootId: opened.rootId,
        path: opened.path,
        text,
        baseDigest: opened.digest,
      });
      if (result.outcome === 'saved' && result.digest) {
        setOpened({ ...opened, text, digest: result.digest });
        setMessage('保存しました');
      } else if (result.outcome === 'conflict') {
        setMessage('他の処理で変更されました。上書きせず、再読み込みできます。');
      } else {
        setMessage(
          result.reason === 'too_large'
            ? REFUSAL_MESSAGE.too_large
            : '保存できませんでした。ファイルとWorkspaceの状態を確認してください。',
        );
      }
    } catch {
      setMessage('保存に失敗しました。内容は画面に残っています。');
    } finally {
      setBusy(false);
    }
  }

  function requestClose(): void {
    if (dirty) setConfirmDiscard(true);
    else close();
  }

  function close(): void {
    setOpened(null);
    setDraft('');
    setConfirmDiscard(false);
    setMessage('');
  }

  return (
    <>
      <button
        type="button"
        className="ctx-chip chip-btn"
        data-testid="open-file-button"
        disabled={!supported || !hasWorkspace || busy}
        title={
          hasWorkspace ? 'Workspace内のファイルを開いて編集' : '先にWorkspaceを選択してください'
        }
        onClick={() => void pick()}
      >
        ファイルを開く
      </button>
      {message && !opened && (
        <span className="file-editor-inline-status" role="status">
          {message}
        </span>
      )}
      {opened?.editable &&
        createPortal(
          <div
            className="file-editor-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-editor-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                requestClose();
              }
            }}
          >
            <section className="file-editor-dialog">
              <header className="file-editor-header">
                <div>
                  <h2 id="file-editor-title">ファイルを編集</h2>
                  <code title={opened.path}>{opened.path}</code>
                </div>
                <button type="button" onClick={requestClose} aria-label="ファイル編集を閉じる">
                  閉じる
                </button>
              </header>
              <textarea
                ref={editorRef}
                className="file-editor-textarea"
                aria-label={`${opened.path}の内容`}
                spellCheck={false}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setMessage('未保存の変更があります');
                }}
                onKeyDown={(event) => {
                  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 's') {
                    event.preventDefault();
                    void save();
                  }
                }}
              />
              <footer className="file-editor-footer">
                <span role="status" aria-live="polite">
                  {message || (dirty ? '未保存' : '保存済み')}
                </span>
                <button type="button" onClick={() => void reload()} disabled={busy}>
                  再読み込み
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void save()}
                  disabled={busy || !dirty}
                >
                  保存
                </button>
              </footer>
              {confirmDiscard && (
                <div className="file-editor-discard" role="alert">
                  <span>未保存の変更を破棄しますか？</span>
                  <button type="button" onClick={() => setConfirmDiscard(false)}>
                    編集に戻る
                  </button>
                  <button type="button" className="danger" onClick={close}>
                    破棄して閉じる
                  </button>
                </div>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

export function diskText(editorText: string, lineEnding: LineEnding): string {
  const normalized = editorText.replaceAll('\r\n', '\n');
  return lineEnding === 'crlf' ? normalized.replaceAll('\n', '\r\n') : normalized;
}
