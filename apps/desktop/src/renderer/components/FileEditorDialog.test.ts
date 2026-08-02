import { describe, expect, it } from 'vitest';
import { diskText } from './FileEditorDialog';

describe('FileEditorDialog line endings', () => {
  it('preserves CRLF while allowing the textarea to use LF', () => {
    expect(diskText('日本語\n二行目\n', 'crlf')).toBe('日本語\r\n二行目\r\n');
  });

  it('preserves LF and a UTF-8 BOM character', () => {
    expect(diskText('\uFEFF日本語\n', 'lf')).toBe('\uFEFF日本語\n');
  });
});
