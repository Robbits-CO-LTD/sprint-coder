// Keep these ranges identical to IsWhitespace / IsDefaultIgnorable in the native classifier.
export const nativeDisplayWhitespaceRanges: readonly (readonly [number, number])[] = [
  [0x09, 0x09],
  [0x0a, 0x0a],
  [0x0b, 0x0b],
  [0x0c, 0x0c],
  [0x0d, 0x0d],
  [0x20, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2028],
  [0x2029, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];
export const nativeDisplayIgnorableRanges: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x115f],
  [0x1160, 0x1160],
  [0x17b4, 0x17b4],
  [0x17b5, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

const inRanges = (character: string, ranges: readonly (readonly [number, number])[]): boolean => {
  const code = character.codePointAt(0)!;
  return ranges.some(([first, last]) => code >= first && code <= last);
};
const collapseSpaces = (value: string): string => value.replace(/ +/gu, ' ').replace(/^ | $/gu, '');

export type NativeDisplayLabel =
  | Readonly<{ kind: 'verified'; label: string }>
  | Readonly<{ kind: 'unverified' }>
  | Readonly<{ kind: 'rejected' }>;

export function sanitizeNativeDisplayLabel(value: string): NativeDisplayLabel {
  const spaced = [...value]
    .map((character) => (inRanges(character, nativeDisplayWhitespaceRanges) ? ' ' : character))
    .join('')
    .replace(/ +/gu, ' ');
  const visible = collapseSpaces(
    [...spaced]
      .filter(
        (character) =>
          !/[\p{Cc}\p{Cf}]/u.test(character) && !inRanges(character, nativeDisplayIgnorableRanges),
      )
      .join(''),
  );
  let hasBase = false;
  let marks = 0;
  let label = '';
  for (const character of visible) {
    if (/[\p{Mn}\p{Me}]/u.test(character)) {
      if (hasBase && marks++ < 4) label += character;
    } else {
      hasBase = character !== ' ';
      marks = 0;
      label += character;
    }
  }
  label = collapseSpaces(label);
  if (label.length === 0) return { kind: 'unverified' };
  if (Buffer.byteLength(label, 'utf8') > 512) return { kind: 'rejected' };
  return { kind: 'verified', label };
}
