// SurfaceHeader: agent identity / role / status / goal / overflow (§4.2).
// Hidden in the normal Chat layout (see .surface-header in index.css) and shown for the
// Canvas/Team Leader node presentation (demo/index.html #surfaceHeader), where the same
// ChatSurface instance is reused as the Leader card. `variant==='node'` swaps the role-sub
// copy for the Leader framing and appends the amber "Leader" chip (mock line 172).
export function SurfaceHeader({
  title,
  variant = 'main',
}: {
  title: string;
  variant?: 'main' | 'node';
}) {
  const isNode = variant === 'node';
  return (
    <div className="surface-header">
      <div className="avatar" aria-hidden="true">
        V
      </div>
      <div className="role-line">
        <span className="role-name">Assistant</span>
        <span className="role-sub">{isNode ? `Team Leader · ${title}` : title}</span>
      </div>
      {isNode && <span className="leader-chip">Leader</span>}
    </div>
  );
}
