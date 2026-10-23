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

describe('Markdown emphasis in Team hiring intent', () => {
  it.each([
    ['**担当を雇ってください。**という文を添削してください。', false],
    ['*担当を雇ってください。*という文を添削してください。', false],
    ['__担当を雇ってください。__ という文を添削してください。', false],
    ['_担当を雇ってください。_ という文を添削してください。', false],
    ['***担当を雇ってください。***という文を添削してください。', false],
    ['**担当を*雇ってください。***という文を添削してください。', false],
    ['**担当を雇ってください**。という文を添削してください。', false],
    ['**担当を雇ってもらえますか？**なんて聞かれました。', false],
    ['**担当を雇ってください。**', true],
    ['*担当を雇ってください*。', true],
    ['担当を**雇って**ください。', true],
    ['***担当を雇ってください。***', true],
    ['例: <code>**担当を雇ってください。**</code>', false],
    ['**`担当を雇ってください。`**というコードです。', false],
    ['> **担当を雇ってください。**', false],
    ['[担当を雇ってください。](https://example.test)という文を添削してください。', false],
    [
      '[担当を雇ってください。][example]という文を添削してください。\n\n[example]: https://example.test',
      false,
    ],
    ['[`担当を雇ってください。`](https://example.test)というコードです。', false],
    ['<strong>担当を雇ってください。</strong>という文を添削してください。', false],
    ['<strong>担当を雇ってください。 </strong>という文を添削してください。', false],
    ['<strong>担当を雇ってください。\n</strong>という文を添削してください。', false],
    ['[参照](<code>) <span>参考</span>。担当を雇ってください。', true],
    ['[参照](https://example.test "<code>") <span>参考</span>。担当を雇ってください。', true],
    ['[参照][ref] <span>参考</span>。\n\n[ref]: <code>\n\n担当を雇ってください。', true],
    ['[担当を雇ってください。](https://example.test)', true],
    ['担当を雇ってください。「こんにちは」と挨拶させてください。', true],
    ['担当を雇ってください。`hi`と挨拶させてください。', true],
    ['担当を雇ってください。\n* と書かれた行は無視してください。', true],
    ['担当を雇ってください。<strong>とても助かります。</strong>', true],
    ['担当を雇ってください。<strong>とても助かります</strong>。', true],
    ['担当を雇ってください。<strong>とても助かります。</strong>って言われました。', false],
    ['担当を雇って<b>資料</b>を作成してください。', true],
    ['<q><a href="x">担当を雇ってください。</a></q>', false],
    ['<code><strong>担当を雇ってください。</strong></code>', false],
    ['[`担当`](https://example.test)を雇ってください。', false],
    ['[担当](https://example.test)を雇ってください。', true],
  ])('uses parsed emphasis without detaching quotation continuations: %s', (input, expected) => {
    expect(isTeamScenarioInput(input)).toBe(expected);
    expect(requiresTeamWorkersInput(input)).toBe(expected);
  });

  it('preserves literal barriers, UTF-16 offsets and newlines while softening emphasis markers', () => {
    const input =
      '🌊 例: <code>**担当を雇ってください。**</code>\r\n\r\n[***実際の指示。***](https://example.test "<code>")';
    const masked = maskTeamHiringMarkdown(input);
    expect(masked.length).toBe(input.length);
    expect([...masked.matchAll(/[\r\n]/g)].map((match) => match.index)).toEqual(
      [...input.matchAll(/[\r\n]/g)].map((match) => match.index),
    );
    const literalMarker = input.indexOf('**');
    expect(masked.slice(literalMarker, literalMarker + 2)).toBe('\uFFFC\uFFFC');
    const emphasisMarker = input.indexOf('***実際');
    expect(masked.slice(emphasisMarker, emphasisMarker + '***実際の指示。***'.length)).toBe(
      '   実際の指示。   ',
    );
    expect(masked).not.toContain('https://example.test');
    expect(masked).not.toContain('<code>');
  });

  it('preserves a real request after bounded repeated link formatting', () => {
    const link = '[**例**](https://example.test) ';
    const request = '担当を雇ってください。';
    const input = link.repeat(Math.floor((100_000 - request.length) / link.length)) + request;
    expect(input.length).toBeLessThanOrEqual(100_000);
    expect(isTeamScenarioInput(input)).toBe(true);
    expect(requiresTeamWorkersInput(input)).toBe(true);
  });
});
