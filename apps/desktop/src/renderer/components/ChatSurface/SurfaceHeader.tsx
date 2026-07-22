// SurfaceHeader: agent identity / role / status / goal / overflow (§4.2).
// Hidden in the normal Chat layout (see .surface-header in index.css) and reserved for the
// future Canvas/Team node presentation, where the same ChatSurface instance is reused as a
// Leader/Worker card. Out of scope for Chat Alpha but kept so the ChatSurface contract matches
// the design doc's component breakdown.
export function SurfaceHeader({ title }: { title: string }) {
  return (
    <div className="surface-header">
      <div className="avatar" aria-hidden="true">
        V
      </div>
      <div className="role-line">
        <span className="role-name">Assistant</span>
        <span className="role-sub">{title}</span>
      </div>
    </div>
  );
}
