import { describe, expect, it } from 'vitest';
import { AUTO_TITLE_MAX_LENGTH, deriveTaskTitle } from './task-title';

// Issue #4: a new Task stayed "新しいタスク" forever, so the sidebar filled up with identical rows.
// The title is now derived locally from the first user message — deterministically, so these cases
// pin down exactly what the sidebar will read.

describe('deriveTaskTitle', () => {
  it('uses a short single-line message verbatim', () => {
    expect(deriveTaskTitle('ログイン画面のバグを直して')).toBe('ログイン画面のバグを直して');
  });

  it('collapses internal whitespace instead of carrying a tab-indented paste into the label', () => {
    expect(deriveTaskTitle('  npm test  が\t\t落ちる  ')).toBe('npm test が 落ちる');
  });

  it('takes the first line of a multi-line message', () => {
    expect(
      deriveTaskTitle('認証まわりを直したい\n\n詳細:\n- トークンが切れる\n- 再ログインできない'),
    ).toBe('認証まわりを直したい');
  });

  it('truncates with an ellipsis so a cut title does not read as the whole ask', () => {
    const long = 'あ'.repeat(AUTO_TITLE_MAX_LENGTH + 20);
    const title = deriveTaskTitle(long);
    expect(title).toBe(`${'あ'.repeat(AUTO_TITLE_MAX_LENGTH)}…`);
    expect(Array.from(title ?? '')).toHaveLength(AUTO_TITLE_MAX_LENGTH + 1);
  });

  it('keeps a message exactly at the limit intact', () => {
    const exact = 'あ'.repeat(AUTO_TITLE_MAX_LENGTH);
    expect(deriveTaskTitle(exact)).toBe(exact);
  });

  it('slices on code points so an emoji is never cut in half', () => {
    // Astral-plane characters are two UTF-16 units each; a naive slice would leave a lone
    // surrogate, and taskSummarySchema would happily store the mojibake.
    const title = deriveTaskTitle('🚀'.repeat(AUTO_TITLE_MAX_LENGTH + 5));
    expect(title).toBe(`${'🚀'.repeat(AUTO_TITLE_MAX_LENGTH)}…`);
    // No lone surrogate survived the slice: a high surrogate must be followed by a low one, and a
    // low surrogate must be preceded by a high one.
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(title).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  describe('markdown decoration', () => {
    it('strips leading headings, quotes, bullets, ordered numbers, and checkboxes', () => {
      expect(deriveTaskTitle('## 認証の設計を見直す')).toBe('認証の設計を見直す');
      expect(deriveTaskTitle('> 引用された依頼')).toBe('引用された依頼');
      expect(deriveTaskTitle('- リストの依頼')).toBe('リストの依頼');
      expect(deriveTaskTitle('1. 番号付きの依頼')).toBe('番号付きの依頼');
      expect(deriveTaskTitle('- [ ] チェックボックスの依頼')).toBe('チェックボックスの依頼');
    });

    it('strips inline emphasis and code markers', () => {
      expect(deriveTaskTitle('**バグ**を直して')).toBe('バグを直して');
      expect(deriveTaskTitle('`npm test` が落ちる')).toBe('npm test が落ちる');
    });

    it('keeps a hyphen that is part of a word rather than a bullet', () => {
      expect(deriveTaskTitle('e2e-test を安定させたい')).toBe('e2e-test を安定させたい');
    });
  });

  describe('skipping openers', () => {
    it('skips a leading code fence and names the Task from the prose after it', () => {
      expect(deriveTaskTitle('```ts\nconst x = 1;\n```\nこのコードをリファクタして')).toBe(
        'このコードをリファクタして',
      );
    });

    it('skips a standalone greeting', () => {
      expect(deriveTaskTitle('こんにちは\nテストを書いてほしい')).toBe('テストを書いてほしい');
      expect(deriveTaskTitle('Hello!\nfix the build')).toBe('fix the build');
    });

    it('keeps a greeting that has the actual request attached to it', () => {
      expect(deriveTaskTitle('こんにちは、テストを書いてほしい')).toBe(
        'こんにちは、テストを書いてほしい',
      );
    });

    it('falls back to the boilerplate when the message is nothing else', () => {
      // Better a title of "こんにちは" than leaving every such Task indistinguishable.
      expect(deriveTaskTitle('こんにちは')).toBe('こんにちは');
    });
  });

  describe('nothing usable', () => {
    it('returns null so the caller keeps the placeholder', () => {
      // Returning a degenerate title would be worse than "新しいタスク" — and returning null also
      // leaves title_source untouched, so the *next* message gets another chance to name the Task.
      expect(deriveTaskTitle('')).toBeNull();
      expect(deriveTaskTitle('   \n\t\n  ')).toBeNull();
      expect(deriveTaskTitle('```\ncode only\n```')).toBeNull();
      expect(deriveTaskTitle('...')).toBeNull();
      expect(deriveTaskTitle('!?!?')).toBeNull();
      expect(deriveTaskTitle('***')).toBeNull();
    });
  });

  it('never returns a value taskSummarySchema would reject', () => {
    // The schema bound is 1..200; every branch above has to land inside it.
    for (const input of [
      'a',
      'あ'.repeat(500),
      '#'.repeat(3) + ' ' + 'x'.repeat(500),
      '🚀'.repeat(300),
    ]) {
      const title = deriveTaskTitle(input);
      expect(title).not.toBeNull();
      expect((title ?? '').length).toBeGreaterThanOrEqual(1);
      expect((title ?? '').length).toBeLessThanOrEqual(200);
    }
  });

  it('is deterministic', () => {
    const input = '同じ入力\nには同じ出力';
    expect(deriveTaskTitle(input)).toBe(deriveTaskTitle(input));
  });
});
