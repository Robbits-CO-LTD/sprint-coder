// ContextBar: workspace / branch / permission preset / usage (§4.2). The current preload
// contract (types/vibe.d.ts) does not expose workspace, git, or context-usage data yet, so this
// renders an honest placeholder rather than fabricated values. Wire real chips once
// `window.vibe.workspace`/usage APIs exist (see report's unresolved items).
export function ContextBar() {
  return (
    <div className="context-bar">
      <span className="ctx-chip">
        <span className="dot" style={{ background: 'var(--text-secondary)' }} />
        Workspace未選択
      </span>
      <span className="ctx-chip">確認して実行</span>
    </div>
  );
}
