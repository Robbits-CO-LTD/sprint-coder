import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';

// Before/after diff for a file a Runtime finished writing (issue #41).
//
// Unified (inline) rather than side-by-side: the Inspector is 380px by default and 560px at its
// widest, and two columns of 190px cannot show code. Deletions appear inline above the lines that
// replaced them, the same shape as a GitHub unified diff.
//
// Read-only, but built on a real editor rather than a bespoke renderer, because the agreed direction
// is to add in-place editing later. `EditorState.readOnly` plus a non-editable view is what makes
// that a configuration change rather than a rewrite.
//
// CodeMirror rather than Monaco for a reason that is specific to this app: the renderer's CSP is
// `script-src 'self' http://localhost:*` with no `worker-src` and no `blob:`. Monaco starts its
// workers from blob URLs by default, so it would need either self-hosted workers wired through
// `MonacoEnvironment` or a loosened CSP. CodeMirror uses no workers and no eval at all.
//
// No syntax highlighting. The content is provider output, and a language parser is one more thing
// consuming attacker-influenceable text; the value here is the diff, not the colours. `lineNumbers`
// is included because a diff without them is hard to talk about.

export function FileDiffView({ baseline, text }: { baseline: string; text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          unifiedMergeView({
            original: baseline,
            // The accept/reject affordances belong to the editing feature, not to a viewer: offering
            // them here would imply the panel can write, which it cannot.
            mergeControls: false,
            gutter: false,
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Rebuilt rather than reconfigured when either side changes. A diff view is shown only for a
    // settled file, so this runs once per completed write — not per frame — and a full rebuild is
    // both simpler and free of the stale-decoration bugs that partial reconfiguration invites.
  }, [baseline, text]);

  return <div className="filediff" data-testid="file-diff-view" ref={host} dir="ltr" />;
}
