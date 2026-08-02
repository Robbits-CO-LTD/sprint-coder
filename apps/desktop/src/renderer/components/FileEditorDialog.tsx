import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileOpenResult } from '../types/sprint-coder';

type LineEnding = 'crlf' | 'lf';

const REFUSAL_MESSAGE: Record<NonNullable<FileOpenResult['reason']>, string> = {
  too_large: 'このファイルは大きすぎるため編集できません（上限2 MiB）。',
  binary: 'バイナリファイルは編集できません。',
  not_a_file: '通常のファイルではないか、ファイルが見つかりません。',
  outside_workspace: 'Workspace外または安全でないリンク先のファイルは開けません。',
  recovery_required:
    '前回の保存が途中で終了しました。別のアプリによる変更か判別できないため、確認して元データを復元してください。',
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
  const [savedDraft, setSavedDraft] = useState('');
  const [lineEnding, setLineEnding] = useState<LineEnding>('lf');
  const [savedLineEnding, setSavedLineEnding] = useState<LineEnding>('lf');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<'close' | 'reload' | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const filesApi = typeof window !== 'undefined' ? window.sprintCoder?.files : undefined;
  const supported = typeof filesApi?.pick === 'function';
  const dirty =
    opened?.editable === true && (draft !== savedDraft || lineEnding !== savedLineEnding);

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
        setOpened(result.reason === 'recovery_required' ? result : null);
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
    const endings = extractLineEndings(result.text);
    const normalized = result.text.replaceAll('\r\n', '\n');
    const dominant = dominantLineEnding(endings);
    setOpened(result);
    setLineEnding(dominant);
    setSavedLineEnding(dominant);
    setDraft(normalized);
    setSavedDraft(normalized);
    setMessage('読み込みました');
    setPendingDiscard(null);
  }

  async function reload(): Promise<void> {
    if (!opened || !filesApi) return;
    setBusy(true);
    try {
      const result = await filesApi.open(taskId, opened.rootId, opened.path);
      if (result.editable) loadResult(result);
      else {
        setOpened(result.reason === 'recovery_required' ? result : null);
        setMessage(REFUSAL_MESSAGE[result.reason ?? 'not_a_file']);
      }
    } catch {
      setMessage('再読み込みに失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  async function recover(): Promise<void> {
    if (!opened || opened.reason !== 'recovery_required' || !filesApi) return;
    setBusy(true);
    try {
      const result = await filesApi.recover(taskId, opened.rootId, opened.path);
      if (result.editable) {
        loadResult(result);
        setMessage('保存前の元データを復元しました');
      } else setMessage(REFUSAL_MESSAGE[result.reason ?? 'not_a_file']);
    } catch {
      setMessage('元データを復元できませんでした。回復用ファイルは保持されています。');
    } finally {
      setBusy(false);
    }
  }

  function requestReload(): void {
    if (dirty) setPendingDiscard('reload');
    else void reload();
  }

  async function save(): Promise<void> {
    if (!opened?.editable || busy || !filesApi) return;
    setBusy(true);
    try {
      const text = diskText(draft, { text: opened.text }, lineEnding);
      const result = await filesApi.save({
        taskId,
        rootId: opened.rootId,
        path: opened.path,
        text,
        baseDigest: opened.digest,
      });
      if (result.outcome === 'saved' && result.digest) {
        setOpened({ ...opened, text, digest: result.digest });
        setSavedDraft(draft);
        setSavedLineEnding(lineEnding);
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
    if (dirty) setPendingDiscard('close');
    else close();
  }

  function close(): void {
    setOpened(null);
    setDraft('');
    setSavedDraft('');
    setPendingDiscard(null);
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
      {message && opened?.editable !== true && (
        <span className="file-editor-inline-status" role="status">
          {message}
        </span>
      )}
      {opened?.reason === 'recovery_required' && (
        <button
          type="button"
          className="ctx-chip chip-btn danger"
          disabled={busy}
          onClick={() => void recover()}
        >
          元データを復元
        </button>
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
                <button type="button" onClick={requestReload} disabled={busy}>
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
              {pendingDiscard !== null && (
                <div className="file-editor-discard" role="alert">
                  <span>
                    未保存の変更を破棄して
                    {pendingDiscard === 'reload' ? '再読み込みしますか？' : '閉じますか？'}
                  </span>
                  <button type="button" onClick={() => setPendingDiscard(null)}>
                    編集に戻る
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      if (pendingDiscard === 'reload') void reload();
                      else close();
                    }}
                  >
                    破棄して{pendingDiscard === 'reload' ? '再読み込み' : '閉じる'}
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

export function diskText(
  editorText: string,
  original: LineEnding | readonly LineEnding[] | Readonly<{ text: string }>,
  fallback: LineEnding = 'lf',
): string {
  const normalized = editorText.replaceAll('\r\n', '\n');
  const originalText = typeof original === 'object' && 'text' in original ? original.text : null;
  const endings: readonly LineEnding[] | null =
    originalText === null
      ? typeof original === 'string'
        ? null
        : (original as readonly LineEnding[])
      : extractLineEndings(originalText);
  const originalLines = originalText?.replaceAll('\r\n', '\n').split('\n') ?? null;
  const editedLines = normalized.split('\n');
  const newLineEnding = typeof original === 'string' ? original : fallback;
  let newlineIndex = 0;
  return normalized.replaceAll('\n', () => {
    const lineIndex = newlineIndex++;
    // Positional line-ending reuse is safe only when the line at that position is unchanged.
    // Inserted/deleted lines otherwise shift every following ending onto unrelated content.
    const unchangedLine =
      originalLines === null || originalLines[lineIndex] === editedLines[lineIndex];
    const ending = unchangedLine ? (endings?.[lineIndex] ?? newLineEnding) : newLineEnding;
    return ending === 'crlf' ? '\r\n' : '\n';
  });
}

export function extractLineEndings(text: string): LineEnding[] {
  return [...text.matchAll(/\r\n|\n/g)].map(([ending]) => (ending === '\r\n' ? 'crlf' : 'lf'));
}

function dominantLineEnding(endings: readonly LineEnding[]): LineEnding {
  const crlf = endings.filter((ending) => ending === 'crlf').length;
  return crlf > endings.length / 2 ? 'crlf' : 'lf';
}
