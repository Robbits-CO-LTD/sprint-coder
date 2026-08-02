import { describe, expect, it } from 'vitest';
import { diskText, EditorRequestGeneration, extractLineEndings } from './FileEditorDialog';

describe('FileEditorDialog async request generation', () => {
  it('invalidates a save/reload response captured before the editor closes', () => {
    const generation = new EditorRequestGeneration();
    const inFlight = generation.capture();

    expect(generation.isCurrent(inFlight)).toBe(true);
    generation.invalidate();
    expect(generation.isCurrent(inFlight)).toBe(false);
    expect(generation.isCurrent(generation.capture())).toBe(true);
  });
});

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
    expect(diskText('a\nb\nc\n', { text: original }, 'lf')).toBe(original);
    expect(diskText('edited\nb\nc\n', { text: original }, 'lf')).toBe('edited\nb\nc\r\n');
  });

  it('does not shift mixed endings onto unrelated lines after an insertion', () => {
    const original = 'a\r\nb\nc\r\n';
    expect(diskText('new\na\nb\nc\n', { text: original }, 'lf')).toBe('new\na\nb\nc\n');
  });
});
