import type { ZodError } from 'zod';

const MAX_PUBLIC_MESSAGE_LENGTH = 500;
const MAX_PUBLIC_ISSUES = 5;

export function clipPublicMessage(
  value: string,
  fallback = '入力内容を確認してください。',
): string {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('');
  const normalized = withoutControls.replace(/\s+/g, ' ').trim();
  const safe = normalized.length === 0 ? fallback : normalized;
  return safe.length <= MAX_PUBLIC_MESSAGE_LENGTH
    ? safe
    : `${safe.slice(0, MAX_PUBLIC_MESSAGE_LENGTH - 1)}…`;
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path
    .map((part, index) => {
      if (typeof part === 'number') return `[${part}]`;
      const text = String(part);
      if (/^[a-zA-Z_$][a-zA-Z0-9_$-]*$/.test(text)) return `${index === 0 ? '' : '.'}${text}`;
      return `[${JSON.stringify(text)}]`;
    })
    .join('');
}

export function formatZodIssues(error: ZodError): string {
  const shown = error.issues
    .slice(0, MAX_PUBLIC_ISSUES)
    .map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
  if (error.issues.length > MAX_PUBLIC_ISSUES)
    shown.push(`他${error.issues.length - MAX_PUBLIC_ISSUES}件`);
  return clipPublicMessage(shown.join('; '));
}

export function formatBlueprintJsonSyntaxError(error: SyntaxError): string {
  const position = /\bposition\s+(\d+)\b/i.exec(error.message)?.[1];
  const lineColumn = /\bline\s+(\d+)\s+column\s+(\d+)\b/i.exec(error.message);
  const location =
    lineColumn === null
      ? position === undefined
        ? ''
        : `（位置 ${position}）`
      : `（行 ${lineColumn[1]}、列 ${lineColumn[2]}）`;
  return `team/blueprint.json がJSONとして不正です${location}`;
}
