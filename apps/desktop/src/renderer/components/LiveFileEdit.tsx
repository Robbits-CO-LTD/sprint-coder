import { useEffect, useRef, useState } from 'react';
import type { LiveFileEdit } from '../lib/file-edit-buffer';
import { useLiveFileEdits } from '../lib/useLiveFileEdits';
import { lineCount, lineDelta } from '../lib/line-delta';
import { FileDiffView } from './FileDiffView';
import { FileEditor } from './FileEditor';

// The file bodies a Runtime is writing, as it writes them (issues #39, #41, #43, #45).
//
// Reads from the module-level buffer through one rAF loop rather than from the store, for the same
// reason ReasoningPanel does: this arrives at the model's typing speed, and a store update per frame
// would re-render every subscriber in the app to repaint one panel.
//
// The body is provider output and is treated as untrusted data — plain text in a <pre>, no Markdown
// pipeline, no syntax highlighter. A highlighter would have to parse attacker-influenceable text and
// build DOM from it; the value of coloured keywords does not pay for that. Secret redaction already
// happened in Main, before the text left the process.
//
// Lines that changed since the previous frame are highlighted briefly. That is not decoration: a
// disk-sourced update replaces the whole file at once — Codex applies a patch rather than typing —
// so without it the reader has to diff two screens of monospace by eye.
//
// Issue #45 merged what used to be three separate renderings of the same filenames — a tab strip, a
// path row, and a summary list underneath — into one list where each row carries its own state.
// Three copies of two filenames in a 380px panel was the worst thing about it.
//
// Explicitly NOT role="log" and no aria-live: that role's implicit politeness would make a screen
// reader announce every frame of a file being typed, which is the same mistake NFR-A11Y-03 forbids
// for reasoning. Motion is never the only carrier of state either — every pulsing dot has a word
// next to it, so `prefers-reduced-motion` can stop the animation without removing information.

export function LiveFileEditView({
  taskId,
  editable,
  onDirtyChange,
}: {
  taskId: string | null;
  /** Only at the Inspector's widest step: code cannot be edited in 380px, and offering it there
   * would be an invitation to make a mistake in a box too small to see it (issue #43). */
  editable: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const edits = useLiveFileEdits();
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit'>('view');

  if (edits.length === 0) return null;

  // Follows the newest write until the user picks a file, and keeps their pick afterwards — having
  // the view jump away mid-read because the model moved to another file would make it unreadable.
  const active = edits.find((edit) => edit.path === selected) ?? edits[0];
  if (active === undefined) return null;
  const writing = isWriting(active);

  return (
    <div className="liveedit" data-testid="live-file-edit">
      <ul className="liveedit-files" data-testid="live-edit-files">
        {edits.map((edit) => (
          <FileRow
            key={edit.path}
            edit={edit}
            current={edit.path === active.path}
            onSelect={() => setSelected(edit.path)}
          />
        ))}
      </ul>

      <div className="liveedit-head">
        <bdi className="liveedit-path" dir="ltr" title={active.path} data-testid="live-edit-path">
          {active.path}
        </bdi>
        {/* Names which of the two things the user is looking at. A disk-sourced body updates the
            moment the file changes, but in whole-file jumps — calling that "typing" would describe
            a tool behaviour that does not exist. */}
        <span className="liveedit-state" data-testid="live-edit-state">
          {active.complete && active.baseline !== null
            ? '変更前との差分'
            : active.source === 'disk'
              ? 'ファイルの現在の内容'
              : active.complete
                ? '書き込み完了'
                : '書き込み中'}
        </span>
      </div>

      {editable && active.complete && taskId !== null && (
        <div className="liveedit-modes" role="group" aria-label="表示の切り替え">
          <button
            type="button"
            className={`liveedit-mode${mode === 'view' ? ' current' : ''}`}
            data-testid="live-edit-mode-view"
            aria-pressed={mode === 'view'}
            onClick={() => setMode('view')}
          >
            差分
          </button>
          <button
            type="button"
            className={`liveedit-mode${mode === 'edit' ? ' current' : ''}`}
            data-testid="live-edit-mode-edit"
            aria-pressed={mode === 'edit'}
            onClick={() => setMode('edit')}
          >
            編集
          </button>
        </div>
      )}

      {editable && active.complete && taskId !== null && mode === 'edit' ? (
        // Keyed by path so switching files gets a fresh editor rather than a reused buffer holding
        // the previous file's text.
        <FileEditor
          key={`${taskId}:${active.path}`}
          taskId={taskId}
          path={active.path}
          onDirtyChange={onDirtyChange}
        />
      ) : /* The diff replaces the plain body only once the file has settled AND there is something
             honest to compare against. Diffing a half-written file would mark every unfinished line
             as a change, and inventing a baseline would attribute the user's own work to the
             model. */
      active.complete && active.baseline !== null ? (
        <FileDiffView baseline={active.baseline} text={active.text} />
      ) : (
        <>
          <LiveBody text={active.text} changed={active.changed} writing={writing} />
          {active.complete && (
            <p className="liveedit-nodiff" data-testid="live-edit-no-diff">
              変更前の内容を特定できないため、差分ではなく全文を表示しています。
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Whether this file is being typed right now.
 *
 * A disk-sourced body is never `complete` — on disk there is only current — so `!complete` alone
 * would leave a watched file pulsing forever after the Turn ended.
 */
function isWriting(edit: LiveFileEdit): boolean {
  return !edit.complete && edit.source === 'stream';
}

function FileRow({
  edit,
  current,
  onSelect,
}: {
  edit: LiveFileEdit;
  current: boolean;
  onSelect: () => void;
}) {
  const delta = lineDelta(edit.baseline, edit.text);
  const writing = isWriting(edit);
  return (
    <li>
      <button
        type="button"
        className={`liveedit-file${current ? ' current' : ''}`}
        aria-current={current ? 'true' : undefined}
        data-writing={writing ? 'true' : undefined}
        data-testid="live-edit-file-row"
        onClick={onSelect}
      >
        {/* Pulses only while this file is being written, and never as the only signal — the row
            carries the state in words too, so reduced motion loses nothing. */}
        <span className={`liveedit-dot${writing ? ' writing' : ''}`} aria-hidden="true" />
        <bdi className="liveedit-file-name" dir="ltr" title={edit.path}>
          {basename(edit.path)}
        </bdi>
        {delta === null ? (
          <span className="liveedit-file-meta">{lineCount(edit.text)}行</span>
        ) : (
          <span className="liveedit-file-meta">
            <span className="liveedit-added">+{delta.added}</span>
            <span className="liveedit-removed">−{delta.removed}</span>
          </span>
        )}
        <span className="liveedit-file-state">{writing ? '書き込み中' : '完了'}</span>
      </button>
    </li>
  );
}

function LiveBody({
  text,
  changed,
  writing,
}: {
  text: string;
  changed: Set<number>;
  writing: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // Only while the file is still being written, and only inside this element — the issue that
    // introduced the Inspector is explicit that its content must never move the conversation's own
    // scroll position.
    const node = ref.current;
    if (node !== null && writing) node.scrollTop = node.scrollHeight;
  }, [text, writing]);

  const lines = text.split('\n');
  return (
    <pre
      className={`liveedit-body${writing ? ' writing' : ''}`}
      data-testid="live-edit-body"
      ref={ref}
      dir="ltr"
    >
      {lines.map((line, index) => (
        <span
          // Index-keyed on purpose: a content key would remount every line below an insertion, which
          // would restart the highlight animation on lines that did not change.
          key={index}
          className={`liveedit-line${changed.has(index) ? ' changed' : ''}`}
          data-changed={changed.has(index) ? 'true' : undefined}
        >
          {line === '' ? '​' : line}
          {index < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
      {/* Sits exactly where the next character will land — the strongest "being typed right now"
          signal available. An element rather than a ::after so it is not part of the text a user
          copies out of the panel. */}
      {writing && (
        <span className="liveedit-caret" data-testid="live-edit-caret" aria-hidden="true" />
      )}
    </pre>
  );
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}
