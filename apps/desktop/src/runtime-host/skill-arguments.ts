export function expandSkillArguments(content: string, argumentsText: string | undefined): string {
  if (argumentsText === undefined) return content;
  const bounded = argumentsText.slice(0, 8_000);
  const positional = splitArguments(bounded);
  return content
    .replace(/\$ARGUMENTS\[(\d+)\]/gu, (_match, index: string) => positional[Number(index)] ?? '')
    .replace(/\$(\d+)\b/gu, (_match, index: string) => positional[Number(index)] ?? '')
    .replace(/\$ARGUMENTS\b/gu, () => bounded);
}

function splitArguments(input: string): string[] {
  const values: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current !== '') {
        values.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (escaped) current += '\\';
  if (current !== '') values.push(current);
  return values.slice(0, 128);
}
