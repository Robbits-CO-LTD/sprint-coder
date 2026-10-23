import { describe, expect, it } from 'vitest';
import { maskTeamHiringMarkdown } from './team-hiring-markdown';
import { isTeamScenarioInput, requiresTeamWorkersInput } from './team-tools';

describe('HTML examples in Team hiring intent', () => {
  it.each([
    'code',
    'pre',
    'blockquote',
    'q',
    'samp',
    'kbd',
    'script',
    'style',
    'textarea',
    'template',
  ])('does not treat the contents of inline %s elements as hiring instructions', (tag) => {
    const input = `次のHTML例を説明して: <${tag}>担当を雇ってください。</${tag}>`;
    expect(isTeamScenarioInput(input)).toBe(false);
    expect(requiresTeamWorkersInput(input)).toBe(false);
  });

  it.each([
    '例: <code>担当を雇ってください。',
    '例: <q><code>担当を雇ってください。</code></q>',
    '例: <code data-example="</code>">担当を雇ってください。</code>',
  ])('keeps nested, unclosed and attribute-bearing examples inert: %s', (input) => {
    expect(isTeamScenarioInput(input)).toBe(false);
    expect(requiresTeamWorkersInput(input)).toBe(false);
  });

  it.each([
    '例: <code>担当を雇ってはいけません。</code>\n\n担当を雇ってください。',
    '例: <span title="<code>">参考</span>。担当を雇ってください。',
    '<https://example.com>。担当を雇ってください。',
    '```html\n<code>担当を雇ってはいけません。\n```\n担当を雇ってください。',
    '`<code>` はタグ名です。担当を雇ってください。',
  ])('preserves independent hiring after HTML and Markdown examples: %s', (input) => {
    expect(isTeamScenarioInput(input)).toBe(true);
    expect(requiresTeamWorkersInput(input)).toBe(true);
  });

  it('preserves UTF-16 offsets and line boundaries when HTML and Markdown spans overlap', () => {
    const input = '🌊 例: <code>担当を雇って\r\nください。</code>\n\n実際の指示。';
    const masked = maskTeamHiringMarkdown(input);
    expect(masked.length).toBe(input.length);
    expect(masked.match(/[\r\n]/g)).toEqual(input.match(/[\r\n]/g));
    expect(masked).not.toContain('担当を雇って');
    expect(masked.slice(input.indexOf('実際の指示。'))).toBe('実際の指示。');
  });
});
