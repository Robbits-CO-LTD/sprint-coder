import { describe, expect, it } from 'vitest';
import { readPartialJsonString } from './partial-json-string';

// Feeding a string one character at a time is the honest model of what `input_json_delta` does: the
// fragment boundary can land anywhere, including inside an escape.
function decodeIncrementally(json: string, key: string): { value: string; complete: boolean } {
  let last = { value: '', complete: false };
  for (let i = 1; i <= json.length; i += 1) {
    const read = readPartialJsonString(json.slice(0, i), key);
    if (read !== null) {
      // The decoded value must never shrink or contradict itself: the UI appends what it is told.
      expect(read.value.startsWith(last.value) || last.value.startsWith(read.value)).toBe(true);
      last = read;
    }
  }
  return last;
}

describe('readPartialJsonString (issue #39)', () => {
  it('returns null until the key appears', () => {
    expect(readPartialJsonString('{"file_path": "/a/b.ts', 'content')).toBeNull();
    expect(readPartialJsonString('{"file_path": "/a/b.ts", "cont', 'content')).toBeNull();
  });

  it('reads a value that is still open, and marks it complete at the closing quote', () => {
    expect(readPartialJsonString('{"content": "hel', 'content')).toEqual({
      value: 'hel',
      complete: false,
    });
    expect(readPartialJsonString('{"content": "hello"}', 'content')).toEqual({
      value: 'hello',
      complete: true,
    });
  });

  it('decodes escapes, and withholds a fragment that ends mid-escape', () => {
    // Emitting a bare backslash and correcting it on the next fragment would make the live view
    // flicker between wrong and right.
    expect(readPartialJsonString('{"content": "a\\', 'content')).toEqual({
      value: 'a',
      complete: false,
    });
    expect(readPartialJsonString('{"content": "a\\n', 'content')).toEqual({
      value: 'a\n',
      complete: false,
    });
    expect(readPartialJsonString('{"content": "a\\u00', 'content')).toEqual({
      value: 'a',
      complete: false,
    });
    expect(readPartialJsonString('{"content": "a\\u0041', 'content')).toEqual({
      value: 'aA',
      complete: false,
    });
  });

  it('decodes a real file body arriving one character at a time', () => {
    const body = 'const a = "x";\n\tif (a) {\n  return `${a}`;\n}\n// 日本語 \\ backslash\n';
    const json = JSON.stringify({ file_path: '/ws/a.ts', content: body, extra: 1 });
    expect(decodeIncrementally(json, 'content')).toEqual({ value: body, complete: true });
  });

  it('is not fooled by the key name appearing inside the value', () => {
    // A file body that quotes JSON — including this project's own source — would defeat a naive
    // search for the key text.
    const body = 'const s = \'{"content": "not this"}\';\n';
    const json = JSON.stringify({ content: body });
    expect(readPartialJsonString(json, 'content')).toEqual({ value: body, complete: true });
  });

  it('is not fooled by a key of the same name nested in another object', () => {
    const json = JSON.stringify({ meta: { content: 'inner' }, content: 'outer' });
    expect(readPartialJsonString(json, 'content')).toEqual({ value: 'outer', complete: true });
  });

  it('reads new_string for Edit calls, which stream the same way', () => {
    const json = '{"file_path": "/ws/a.ts", "old_string": "41", "new_string": "42"}';
    expect(readPartialJsonString(json, 'new_string')).toEqual({ value: '42', complete: true });
  });

  it('stops instead of inventing characters when the escape is not JSON', () => {
    expect(readPartialJsonString('{"content": "a\\qb"}', 'content')).toEqual({
      value: 'a',
      complete: false,
    });
    expect(readPartialJsonString('{"content": "a\\uZZZZ"}', 'content')).toEqual({
      value: 'a',
      complete: false,
    });
  });

  it('returns null for a non-string value rather than guessing', () => {
    expect(readPartialJsonString('{"content": 42}', 'content')).toBeNull();
    expect(readPartialJsonString('{"content": null}', 'content')).toBeNull();
  });
});
