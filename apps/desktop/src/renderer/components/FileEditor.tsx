import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import type { FileOpenResult, FileSaveResult } from '../types/sprint-coder';

// Editing a file the Runtime wrote, in place (issue #43).
//
// Why this is a separate component from FileDiffView rather than a mode of it: `unifiedMergeView`
// renders deleted lines as widgets, and a widget is not editable. Typing "inside" a unified diff is
// not a thing the view can do, so 差分 and 編集 are two views over the same file.
//
// The text here does NOT come from the live edit frames. Those carry a 262KB *tail* — enough to
// watch, not enough to save, because writing a tail back would overwrite the file with its own end
// and drop everything before it. `files.open` re-reads the whole file and hands back the digest it
// hashed, which is what makes the save safe.

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'conflict' }
  | { status: 'refused'; reason: string };

const REFUSAL_TEXT: Record<string, string> = {
  too_large: 'このファイルは大きすぎるため編集できません。',
  binary: 'テキストファイルではないため編集できません。',
  not_a_file: 'ファイルを開けませんでした。',
  outside_workspace: 'Workspaceの外にあるため編集できません。',
  io_error: '保存に失敗しました。ファイルは変更されていません。',
};

export function FileEditor({
  taskId,
  path,
  onDirtyChange,
}: {
  taskId: string;
  path: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const digest = useRef<string | null>(null);
  const [opened, setOpened] = useState<FileOpenResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    // No state reset here: the parent keys this component by `${taskId}:${path}`, so a different
    // file is a different instance rather than a reused one. Resetting in the effect would also be a
    // synchronous setState during mount, which `react-hooks/set-state-in-effect` correctly rejects.
    const open = window.sprintCoder?.files?.open;
    if (typeof open !== 'function') return;
    void open(taskId, path)
      .then((result) => {
        if (cancelled) return;
        digest.current = result.digest;
        setOpened(result);
      })
      .catch(() => {
        if (!cancelled)
          setOpened({ path, text: '', digest: '', editable: false, reason: 'not_a_file' });
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, path]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // Built once per opened file. `opened.text` is the whole file, so this is not a hot path — unlike
  // the live view, which is rebuilt per frame and therefore stays a plain <pre>.
  useEffect(() => {
    const parent = host.current;
    if (parent === null || opened === null || !opened.editable) return;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: opened.text,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              setDirty(true);
              // A previous outcome describes a document that no longer exists.
              setSave({ status: 'idle' });
            }
          }),
        ],
      }),
    });
    view.current = editor;
    editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [opened]);

  const commit = useCallback(async () => {
    const editor = view.current;
    const base = digest.current;
    const saveFile = window.sprintCoder?.files?.save;
    if (editor === null || base === null || typeof saveFile !== 'function') return;
    setSave({ status: 'saving' });
    let result: FileSaveResult;
    try {
      result = await saveFile({
        taskId,
        path,
        text: editor.state.doc.toString(),
        baseDigest: base,
      });
    } catch {
      setSave({ status: 'refused', reason: 'io_error' });
      return;
    }
    if (result.outcome === 'saved') {
      // Keep editing from the new digest rather than forcing a re-open: the buffer on screen is now
      // what is on disk.
      digest.current = result.digest;
      setDirty(false);
      setSave({ status: 'saved' });
      return;
    }
    setSave(
      result.outcome === 'conflict'
        ? { status: 'conflict' }
        : { status: 'refused', reason: result.reason ?? 'io_error' },
    );
  }, [taskId, path]);

  // Re-reads the file and discards the buffer. Offered on a conflict alongside overwrite, because
  // silently doing either would lose someone's work.
  const reload = useCallback(async () => {
    const open = window.sprintCoder?.files?.open;
    if (typeof open !== 'function') return;
    const result = await open(taskId, path).catch(() => null);
    if (result === null) return;
    digest.current = result.digest;
    setDirty(false);
    setSave({ status: 'idle' });
    setOpened(result);
  }, [taskId, path]);

  // Takes the digest that is on disk now and saves over it. Only reachable from the conflict notice,
  // never automatic.
  const overwrite = useCallback(async () => {
    const open = window.sprintCoder?.files?.open;
    if (typeof open !== 'function') return;
    const current = await open(taskId, path).catch(() => null);
    if (current === null || !current.editable) return;
    digest.current = current.digest;
    await commit();
  }, [taskId, path, commit]);

  if (opened === null) return <p className="fileedit-note">読み込んでいます…</p>;
  if (!opened.editable)
    return (
      <p className="fileedit-note" data-testid="file-editor-refused">
        {REFUSAL_TEXT[opened.reason ?? 'not_a_file'] ?? REFUSAL_TEXT['not_a_file']}
      </p>
    );

  return (
    <div className="fileedit" data-testid="file-editor">
      <div className="fileedit-host" ref={host} dir="ltr" />
      <div className="fileedit-bar">
        <button
          type="button"
          className="fileedit-save"
          data-testid="file-editor-save"
          disabled={!dirty || save.status === 'saving'}
          onClick={() => void commit()}
        >
          {save.status === 'saving' ? '保存中…' : '保存'}
        </button>
        <span className="fileedit-state" data-testid="file-editor-state" role="status">
          {save.status === 'saved'
            ? '保存しました'
            : save.status === 'refused'
              ? (REFUSAL_TEXT[save.reason] ?? '保存できませんでした。')
              : dirty
                ? '未保存の変更があります'
                : ''}
        </span>
      </div>
      {save.status === 'conflict' && (
        <div className="fileedit-conflict" data-testid="file-editor-conflict" role="alert">
          <p>編集中に、このファイルがほかから変更されました。どちらを残すか選んでください。</p>
          <div className="fileedit-conflict-actions">
            <button
              type="button"
              data-testid="file-editor-overwrite"
              onClick={() => void overwrite()}
            >
              自分の変更で上書き
            </button>
            <button type="button" data-testid="file-editor-reload" onClick={() => void reload()}>
              自分の変更を破棄して読み直す
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
