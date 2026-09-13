import { describe, expect, it } from 'vitest';
import {
  MANAGED_EXEC_COMMAND_TOOL,
  POLL_COMMAND_TOOL,
  TERMINATE_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
} from './default-tools';
import { MANAGED_STDIN_MAX_CHARACTERS } from './managed-command-stdin';

describe('managed exec command guidance', () => {
  it('explains the Windows sealed-executable and Node test constraints', () => {
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('absolute .exe path');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('direct file I/O');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('--test-isolation=none');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('must not repeat executable');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('never creates Edit Saga assurance');
    expect(
      (MANAGED_EXEC_COMMAND_TOOL.inputSchema as { properties?: Record<string, unknown> })
        .properties,
    ).not.toHaveProperty('verification');
  });
});

describe('managed command session control authority', () => {
  it('gives a stdin write the same authority as the command it feeds', () => {
    // Whatever reaches stdin becomes what the approved command does, so the write is authorized
    // like the command itself rather than by session ownership alone (Issue #473).
    expect(WRITE_STDIN_TOOL.requiredCapabilities).toEqual(
      MANAGED_EXEC_COMMAND_TOOL.requiredCapabilities,
    );
    expect(WRITE_STDIN_TOOL.requiredCapabilities).toEqual(['shell.execute']);
    expect(WRITE_STDIN_TOOL.sideEffect).toBe(MANAGED_EXEC_COMMAND_TOOL.sideEffect);
    expect(WRITE_STDIN_TOOL.kind).toBe('shell');
    expect(WRITE_STDIN_TOOL.risk).toBe('high');
  });

  it('advertises the per-call stdin limit that keeps the approval card complete', () => {
    // The pinned schema does not enforce string bounds, so this is what tells the provider the
    // limit; `prepare` is what refuses a call that exceeds it (Issue #473).
    expect(
      (WRITE_STDIN_TOOL.inputSchema as { properties: { chars: { maxLength?: number } } }).properties
        .chars.maxLength,
    ).toBe(MANAGED_STDIN_MAX_CHARACTERS);
  });

  it('leaves polling and termination free of new authority', () => {
    for (const definition of [POLL_COMMAND_TOOL, TERMINATE_COMMAND_TOOL]) {
      expect(definition.requiredCapabilities).toEqual([]);
      expect(definition.sideEffect).toBe('none');
      expect(definition.risk).toBe('low');
    }
  });
});
