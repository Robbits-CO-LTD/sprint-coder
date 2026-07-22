import type { CommandOutputRecord } from '../types/vibe';

export type CommandTailLine = Readonly<{
  stream: 'stdout' | 'stderr';
  text: string;
  complete: boolean;
  outputSeq: number;
}>;

export type CommandTailProjection = Readonly<{
  lines: readonly CommandTailLine[];
  lastOutputSeq: number;
}>;

const COLLAPSED_LINE_LIMIT = 8;
export const COMMAND_VISUAL_ROW_CHAR_LIMIT = 4_096;

export function appendCommandOutput(
  current: CommandTailProjection,
  output: CommandOutputRecord,
): CommandTailProjection {
  if (output.seq <= current.lastOutputSeq) return current;
  const extracted = trailingSegments(output.text, COLLAPSED_LINE_LIMIT + 1);
  const lines = extracted.truncated ? [] : [...current.lines];
  const segments = extracted.segments;
  let segmentIndex = 0;
  const previous = lines.at(-1);
  if (
    !extracted.truncated &&
    previous !== undefined &&
    !previous.complete &&
    previous.stream === output.stream
  ) {
    lines[lines.length - 1] = {
      ...previous,
      text: previous.text + segments[0]!,
      complete: segments.length > 1,
      outputSeq: output.seq,
    };
    segmentIndex = 1;
  }
  for (; segmentIndex < segments.length; segmentIndex += 1) {
    const text = segments[segmentIndex]!;
    const complete = segmentIndex < segments.length - 1;
    if (text.length === 0 && complete && segmentIndex === segments.length - 1) continue;
    if (text.length === 0 && segmentIndex === segments.length - 1) continue;
    lines.push({ stream: output.stream, text, complete, outputSeq: output.seq });
  }
  const visualRows = lines.flatMap(splitVisualLine);
  return Object.freeze({
    lines: Object.freeze(visualRows.slice(-COLLAPSED_LINE_LIMIT)),
    lastOutputSeq: output.seq,
  });
}

function trailingSegments(text: string, limit: number): { segments: string[]; truncated: boolean } {
  const segments: string[] = [];
  let end = text.length;
  while (segments.length < limit) {
    const newline = text.lastIndexOf('\n', end - 1);
    if (newline < 0) {
      segments.unshift(text.slice(0, end));
      return { segments, truncated: false };
    }
    segments.unshift(text.slice(newline + 1, end));
    end = newline;
  }
  return { segments, truncated: end > 0 || text.startsWith('\n') };
}

function splitVisualLine(line: CommandTailLine): CommandTailLine[] {
  if (line.text.length <= COMMAND_VISUAL_ROW_CHAR_LIMIT) return [line];
  const rows: CommandTailLine[] = [];
  for (let offset = 0; offset < line.text.length; offset += COMMAND_VISUAL_ROW_CHAR_LIMIT) {
    const end = Math.min(line.text.length, offset + COMMAND_VISUAL_ROW_CHAR_LIMIT);
    rows.push({
      ...line,
      text: line.text.slice(offset, end),
      complete: end < line.text.length || line.complete,
    });
  }
  return rows;
}

export function projectCommandLines(
  outputs: readonly CommandOutputRecord[],
): readonly CommandTailLine[] {
  const rows: CommandTailLine[] = [];
  let lastSeq = 0;
  for (const output of outputs) {
    if (output.seq <= lastSeq) continue;
    lastSeq = output.seq;
    const display = output.text.replaceAll('\n', '↵ ');
    for (let offset = 0; offset < display.length; offset += COMMAND_VISUAL_ROW_CHAR_LIMIT)
      rows.push({
        stream: output.stream,
        text: display.slice(offset, offset + COMMAND_VISUAL_ROW_CHAR_LIMIT),
        complete: true,
        outputSeq: output.seq,
      });
  }
  return Object.freeze(rows);
}

export function projectCommandTail(outputs: readonly CommandOutputRecord[]): CommandTailProjection {
  return outputs.reduce<CommandTailProjection>(appendCommandOutput, {
    lines: Object.freeze([]),
    lastOutputSeq: 0,
  });
}

export function exactArgvDisplay(executable: string, argv: readonly string[]): string {
  return JSON.stringify([executable, ...argv]);
}

export function commandDurationMs(
  input: {
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  },
  now = Date.now(),
): number {
  const start = Date.parse(input.startedAt ?? input.createdAt);
  const finish = input.finishedAt === null ? now : Date.parse(input.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, finish - start);
}
