import { describe, expect, it } from 'vitest';
import {
  appendCommandOutput,
  COMMAND_VISUAL_ROW_CHAR_LIMIT,
  commandDurationMs,
  exactArgvDisplay,
  projectCommandLines,
} from './command-projection';
import type { CommandTailProjection } from './command-projection';

describe('Command Card projection', () => {
  it('keeps the latest eight logical lines across chunk and stream boundaries', () => {
    let projection: CommandTailProjection = { lines: [], lastOutputSeq: 0 };
    projection = appendCommandOutput(projection, {
      seq: 1,
      stream: 'stdout',
      text: 'one\ntwo\nthree\nfour\nfive\nsix\nsev',
      byteLength: 37,
    });
    projection = appendCommandOutput(projection, {
      seq: 2,
      stream: 'stdout',
      text: 'en\neight\nnine\n',
      byteLength: 15,
    });
    projection = appendCommandOutput(projection, {
      seq: 3,
      stream: 'stderr',
      text: 'ten',
      byteLength: 3,
    });

    expect(projection.lines.map(({ text }) => text)).toEqual([
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ]);
    expect(projection.lines.at(-1)).toMatchObject({ stream: 'stderr', complete: false });
    expect(projection.lastOutputSeq).toBe(3);
  });

  it('deduplicates replayed output and ignores stale sequence values', () => {
    const first = appendCommandOutput(
      { lines: [], lastOutputSeq: 0 },
      { seq: 1, stream: 'stdout', text: 'once\n', byteLength: 5 },
    );
    expect(
      appendCommandOutput(first, {
        seq: 1,
        stream: 'stdout',
        text: 'duplicate\n',
        byteLength: 10,
      }),
    ).toBe(first);
  });

  it('renders Windows CRLF as one logical line break without changing stored output', () => {
    const output = {
      seq: 1,
      stream: 'stdout' as const,
      text: '一行目\r\n二行目\r\n',
      byteLength: 20,
    };
    const collapsed = appendCommandOutput({ lines: [], lastOutputSeq: 0 }, output);
    expect(collapsed.lines.map(({ text }) => text)).toEqual(['一行目', '二行目']);
    expect(projectCommandLines([output])[0]?.text).toBe('一行目↵ 二行目↵ ');
    expect(output.text).toBe('一行目\r\n二行目\r\n');
  });

  it('renders exact argv as an unambiguous JSON array and computes bounded duration', () => {
    expect(exactArgvDisplay('/bin/tool', ['', 'a b', '"quoted"', 'line\nbreak'])).toBe(
      '["/bin/tool","","a b","\\"quoted\\"","line\\nbreak"]',
    );
    expect(
      commandDurationMs({
        createdAt: '2026-07-23T00:00:00.000Z',
        startedAt: '2026-07-23T00:00:01.000Z',
        finishedAt: '2026-07-23T00:00:03.250Z',
      }),
    ).toBe(2_250);
  });

  it('splits newline-free output into bounded virtual rows and caps the collapsed tail', () => {
    const text = 'x'.repeat(COMMAND_VISUAL_ROW_CHAR_LIMIT * 20 + 1);
    const output = { seq: 1, stream: 'stdout' as const, text, byteLength: text.length };
    const collapsed = appendCommandOutput({ lines: [], lastOutputSeq: 0 }, output);
    const expanded = projectCommandLines([output]);
    expect(collapsed.lines).toHaveLength(8);
    expect(expanded).toHaveLength(21);
    expect(expanded.every((line) => line.text.length <= COMMAND_VISUAL_ROW_CHAR_LIMIT)).toBe(true);
  });

  it('projects a 10 MiB newline-free stream into bounded virtual rows without a giant DOM node', () => {
    const chunk = 'z'.repeat(65_536);
    const outputs = Array.from({ length: 160 }, (_, index) => ({
      seq: index + 1,
      stream: 'stdout' as const,
      text: chunk,
      byteLength: chunk.length,
    }));
    const startedAt = performance.now();
    const rows = projectCommandLines(outputs);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(rows).toHaveLength((10 * 1_024 * 1_024) / COMMAND_VISUAL_ROW_CHAR_LIMIT);
    expect(rows.every((line) => line.text.length <= COMMAND_VISUAL_ROW_CHAR_LIMIT)).toBe(true);
  });

  it('packs a 10 MiB dense-newline stream without allocating one object per logical line', () => {
    const chunk = 'x\n'.repeat(32_768);
    const outputs = Array.from({ length: 160 }, (_, index) => ({
      seq: index + 1,
      stream: 'stdout' as const,
      text: chunk,
      byteLength: chunk.length,
    }));
    const startedAt = performance.now();
    const rows = projectCommandLines(outputs);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(rows.length).toBeLessThanOrEqual(3_840);
    expect(rows.every((line) => line.text.length <= COMMAND_VISUAL_ROW_CHAR_LIMIT)).toBe(true);
    expect(rows[0]?.text).toContain('↵');
  });
});
