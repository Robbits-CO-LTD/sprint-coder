import { desktopControlWorkerAccent } from '@sprint-coder/contracts';

/**
 * Whether dark ink reads better than white on the color (the higher WCAG contrast of the two), so
 * the initial stays readable on every color of the palette.
 */
export function darkInkReadsOn(hex: string): boolean {
  const [red, green, blue] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  // Against the app's near-black (luminance about 0.007) and against white.
  return (luminance + 0.05) / 0.057 >= 1.05 / (luminance + 0.05);
}

/**
 * A Team Worker's face, the same wherever the Worker is shown (the Team canvas, the Team list and
 * the approval cards of its calls): the first character of its name on its color. The color is its
 * desktop-control cursor's (`colorIndex`, the place in the palette Main draws the cursor with), so
 * a color on screen always means the cursor of that color on the desktop; a Worker with no cursor
 * has no color and is drawn neutral. Decorative: it always sits beside the Worker's name in words.
 */
export function WorkerAvatar({
  name,
  colorIndex,
  small = false,
}: {
  name: string;
  colorIndex?: number | undefined;
  small?: boolean;
}) {
  const color = colorIndex === undefined ? undefined : desktopControlWorkerAccent(colorIndex);
  return (
    <span
      className="w-avatar"
      aria-hidden="true"
      data-worker-color={color ?? 'none'}
      data-ink={color === undefined ? undefined : darkInkReadsOn(color) ? 'dark' : 'light'}
      data-size={small ? 'small' : undefined}
      style={color === undefined ? undefined : { backgroundColor: color }}
    >
      {Array.from(name.trim())[0] ?? '?'}
    </span>
  );
}
