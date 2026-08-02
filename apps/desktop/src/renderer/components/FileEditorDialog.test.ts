import { describe, expect, it } from 'vitest';
import { diskText, extractLineEndings } from './FileEditorDialog';

describe('FileEditorDialog line endings', () => {
  it('preserves CRLF while allowing the textarea to use LF', () => {
    expect(diskText('日本語\n二行目\n', 'crlf')).toBe('日本語\r\n二行目\r\n');
  });

  it('preserves LF and a UTF-8 BOM character', () => {
    expect(diskText('\uFEFF日本語\n', 'lf')).toBe('\uFEFF日本語\n');
  });

  it('preserves each original ending in a mixed-line-ending file', () => {
    const original = 'a\r\nb\nc\r\n';
    const endings = extractLineEndings(original);
    expect(endings).toEqual(['crlf', 'lf', 'crlf']);
    expect(diskText('a\nb\nc\n', endings, 'lf')).toBe(original);
    expect(diskText('edited\nb\nc\nnew\n', endings, 'lf')).toBe('edited\r\nb\nc\r\nnew\n');
  });
});
