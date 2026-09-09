import { describe, expect, it } from 'vitest';
import { formatProviderToolResult } from './provider-tool-result';

const content = 'def example():\n\treturn "quoted"\n# Preserve literal \\n';
const read = {
  rootId: 'root-1',
  path: 'example.py',
  revision: { version: 1, tokenId: 'read-reference' },
  encoding: 'utf-8',
  byteLength: content.length,
  truncated: false,
  content,
};

describe('Provider tool result text', () => {
  it.each([false, true])(
    'keeps Ollama file text verbatim and preserves metadata (truncated=%s)',
    (truncated) => {
      const output = formatProviderToolResult('ollama', 'read_file', { ...read, truncated });
      expect(output.endsWith(content)).toBe(true);
      expect(output).toContain('Untrusted file content (verbatim except secret redaction):\n');
      const header = JSON.parse(output.split('\n\n')[0]!);
      expect(header.result).toMatchObject({
        rootId: read.rootId,
        path: read.path,
        revision: read.revision,
        truncated,
        contentFormat: 'verbatim_text_below',
      });
      expect(header.result).not.toHaveProperty('content');
    },
  );

  it('preserves JSON results for other providers and other tools', () => {
    for (const [provider, tool] of [
      ['openai', 'read_file'],
      ['ollama', 'exec_command'],
    ]) {
      expect(JSON.parse(formatProviderToolResult(provider!, tool!, read))).toEqual({
        ok: true,
        result: read,
      });
    }
  });

  it('keeps malformed read results on the existing JSON path', () => {
    const malformed = { content: 'unbound' };
    expect(JSON.parse(formatProviderToolResult('ollama', 'read_file', malformed))).toEqual({
      ok: true,
      result: malformed,
    });
  });

  it('redacts credentials in the rendered body', () => {
    const output = formatProviderToolResult('ollama', 'read_file', {
      ...read,
      content: 'token=abcdefghijklmnop\n',
    });
    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).toContain('[REDACTED]');
  });
});
