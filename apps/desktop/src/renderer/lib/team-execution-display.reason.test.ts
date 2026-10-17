import { describe, expect, it } from 'vitest';
import { stoppedExecutionReason } from './team-execution-display';

const waiting = (terminalReason: string) =>
  stoppedExecutionReason({ state: 'waiting_resume', terminalReason });

describe('stoppedExecutionReason path masking (issue #842)', () => {
  it('hides a Windows path that contains a space, not only its first word', () => {
    const reason = waiting("ENOENT: open 'C:\\Users\\Jane Doe\\repo\\secret.txt'");
    expect(reason).toBe("ENOENT: open '…");
    expect(reason).not.toContain('Doe');
    expect(reason).not.toContain('secret');
  });

  it('hides a Windows path that contains brackets or an apostrophe', () => {
    const program = waiting('spawn C:\\Program Files (x86)\\Tools\\jane\\run.exe failed');
    expect(program).toBe('spawn …');
    expect(program).not.toContain('jane');
    const apostrophe = waiting("ENOENT: C:\\Users\\O'Brien\\repo\\secret.txt");
    expect(apostrophe).toBe('ENOENT: …');
    expect(apostrophe).not.toContain('Brien');
  });

  it('hides a POSIX path that contains a space up to the end of the line', () => {
    expect(waiting('failed at /Users/John Smith/work/app.ts')).toBe('failed at …');
    expect(waiting('write /home/jane (old)/secret')).toBe('write …');
  });

  it('keeps the words before a path and hides a UNC path', () => {
    expect(waiting('worktree \\\\server\\share\\Jane Doe\\repo is locked')).toBe('worktree …');
  });

  it('leaves a reason without a path as it is', () => {
    expect(waiting('the review did not pass')).toBe('the review did not pass');
  });
});
