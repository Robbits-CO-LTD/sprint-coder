import { describe, expect, it } from 'vitest';
import { WINDOWS_JOB_WRAPPER } from './windows-process-job';

describe('Windows command wrapper', () => {
  it('fails closed unless the DLL search policy is installed before target spawn', () => {
    const policy = WINDOWS_JOB_WRAPPER.indexOf('enableSafeDllSearchPolicy');
    const spawn = WINDOWS_JOB_WRAPPER.indexOf("require('node:child_process')");
    expect(policy).toBeGreaterThanOrEqual(0);
    expect(spawn).toBeGreaterThan(policy);
    expect(WINDOWS_JOB_WRAPPER).toContain('process.exitCode = 125');
  });
});
