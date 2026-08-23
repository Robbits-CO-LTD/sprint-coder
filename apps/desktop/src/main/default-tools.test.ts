import { describe, expect, it } from 'vitest';
import { MANAGED_EXEC_COMMAND_TOOL } from './default-tools';

describe('managed exec command guidance', () => {
  it('explains the Windows sealed-executable and Node test constraints', () => {
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('absolute .exe path');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('Set-Content');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('--test-isolation=none');
  });
});
