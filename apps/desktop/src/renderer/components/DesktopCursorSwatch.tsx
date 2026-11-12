import {
  DESKTOP_CONTROL_LEADER_ACCENT,
  desktopControlWorkerAccent,
  type DesktopControlMark,
} from '@sprint-coder/contracts';

/**
 * The color of an agent's desktop-control cursor (the hidden team-cursors opt-in), from the same
 * palette Main draws the cursors with: the Leader's blue, or the Worker's place in the palette.
 */
export function desktopCursorColor(mark: DesktopControlMark | { leader: true }): string {
  return 'leader' in mark
    ? DESKTOP_CONTROL_LEADER_ACCENT
    : desktopControlWorkerAccent(mark.colorIndex);
}

/**
 * A small dot in the cursor's color. Decorative only: it is always placed beside the words that
 * name the same agent (its role, or Leader), so nothing is told apart by color alone. The ring
 * around it keeps the darker cursor colors visible on the app's dark surfaces.
 */
export function DesktopCursorSwatch({ color }: { color: string }) {
  return (
    <span
      className="desktop-cursor-swatch"
      aria-hidden="true"
      data-cursor-color={color}
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * The Team view's mark for a Worker that holds desktop control: its cursor's color and the words
 * 「デスクトップ操作」, with the cursor's label in the tooltip. Nothing for any other Worker.
 */
export function WorkerDesktopMark({ mark }: { mark: DesktopControlMark | undefined }) {
  if (mark === undefined) return null;
  return (
    <span
      className="worker-desktop-mark"
      data-testid="team-worker-desktop"
      data-cursor-color-index={mark.colorIndex}
      title={`デスクトップ操作のカーソル: ${mark.label}`}
    >
      <DesktopCursorSwatch color={desktopCursorColor(mark)} />
      デスクトップ操作
    </span>
  );
}
