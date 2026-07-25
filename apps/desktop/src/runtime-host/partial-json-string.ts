// Reads a string value out of JSON that is still arriving (issue #39).
//
// Claude streams a tool call's arguments as `input_json_delta` fragments that concatenate into one
// JSON object. To show the file body as the model writes it, the value of `content` (Write) or
// `new_string` (Edit) has to be readable while the object is still open — `JSON.parse` cannot help,
// because the text is not valid JSON until the last fragment lands.
//
// So this decodes the one string value directly. The subtlety is where a fragment ends: mid-escape
// (`...\` or `...\u00`) the next characters change what the previous ones mean, so anything that
// could still be part of an escape is withheld until the following fragment arrives. Emitting a
// literal backslash and then correcting it would make the view flicker between wrong and right.

export type PartialString = {
  /** Decoded text that is certain — safe to append to what was already shown. */
  value: string;
  /** True once the closing quote was seen; the value will not change again. */
  complete: boolean;
};

/**
 * Extracts `"<key>": "..."` from a possibly-incomplete JSON object.
 *
 * Returns null when the key has not appeared yet, which is the normal state for the first few
 * fragments — `file_path` arrives before `content` does.
 */
export function readPartialJsonString(buffer: string, key: string): PartialString | null {
  const start = findValueStart(buffer, key);
  if (start === null) return null;

  let out = '';
  let index = start;
  while (index < buffer.length) {
    const char = buffer[index];
    if (char === undefined) break;
    if (char === '"') return { value: out, complete: true };
    if (char !== '\\') {
      out += char;
      index += 1;
      continue;
    }
    const escape = buffer[index + 1];
    // The fragment ended on the backslash itself: whether this is `\n` or `\\` is not yet known.
    if (escape === undefined) break;
    if (escape === 'u') {
      // \uXXXX needs four more characters. A surrogate pair spans two escapes, but each half is a
      // valid code unit on its own and JS strings hold lone surrogates, so pairs reassemble by
      // concatenation with no special handling.
      const hex = buffer.slice(index + 2, index + 6);
      if (hex.length < 4) break;
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, complete: false };
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    const decoded = SIMPLE_ESCAPES[escape];
    // An escape JSON does not define means the producer is not emitting JSON; stop rather than
    // invent a character.
    if (decoded === undefined) return { value: out, complete: false };
    out += decoded;
    index += 2;
  }
  return { value: out, complete: false };
}

const SIMPLE_ESCAPES: Record<string, string | undefined> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Finds the index just past the opening quote of `key`'s value.
 *
 * Scans as a tokeniser rather than with a regex so that a *value* containing the literal text
 * `"content":` cannot be mistaken for the key — with a file body as the payload, that is not a
 * hypothetical: any file that contains this very source would trip a naive search.
 */
function findValueStart(buffer: string, key: string): number | null {
  let index = 0;
  let depth = 0;
  while (index < buffer.length) {
    const char = buffer[index];
    if (char === '{' || char === '[') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      depth -= 1;
      index += 1;
      continue;
    }
    if (char !== '"') {
      index += 1;
      continue;
    }
    const stringEnd = skipString(buffer, index);
    if (stringEnd === null) return null;
    const isKeyAtTopLevel =
      depth === 1 && buffer.slice(index + 1, stringEnd - 1) === key && buffer[stringEnd] === ':';
    if (!isKeyAtTopLevel) {
      index = stringEnd;
      continue;
    }
    let after = stringEnd + 1;
    while (after < buffer.length && /\s/.test(buffer[after] ?? '')) after += 1;
    if (buffer[after] !== '"') return null;
    return after + 1;
  }
  return null;
}

/** Index just past the closing quote of the string starting at `start`, or null if it is unclosed. */
function skipString(buffer: string, start: number): number | null {
  let index = start + 1;
  while (index < buffer.length) {
    const char = buffer[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return null;
}
