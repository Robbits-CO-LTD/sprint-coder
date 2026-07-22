import { describe, expect, it } from 'vitest';
import { createExecutionSpec, executionSpecDigest, validateExecutionSpec } from './execution-spec';

const base = {
  absoluteExecutable: '/usr/bin/printf',
  argv: ['%s', 'hello'],
  cwdIdentity: {
    canonicalPath: '/workspace',
    identityDigest: 'a'.repeat(64),
  },
  envDelta: {},
  stdinMode: 'closed' as const,
  shell: 'none' as const,
};

describe('immutable ExecutionSpec', () => {
  it('derives a deterministic command hash and deeply freezes the approved value', () => {
    const first = createExecutionSpec(base);
    const second = createExecutionSpec({ ...base, argv: [...base.argv] });

    expect(first.commandBytesHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.commandBytesHash).toBe(second.commandBytesHash);
    expect(executionSpecDigest(first)).toBe(executionSpecDigest(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.argv)).toBe(true);
    expect(Object.isFrozen(first.cwdIdentity)).toBe(true);
    expect(Object.isFrozen(first.envDelta)).toBe(true);
  });

  it('rejects relative executables, NUL bytes, shell mode, and malformed identities', () => {
    expect(() => createExecutionSpec({ ...base, absoluteExecutable: 'printf' })).toThrow(
      'absolute executable',
    );
    expect(() => createExecutionSpec({ ...base, argv: ['bad\0arg'] })).toThrow('NUL');
    expect(() => createExecutionSpec({ ...base, shell: 'system' as never })).toThrow('shell');
    expect(() =>
      createExecutionSpec({
        ...base,
        cwdIdentity: { ...base.cwdIdentity, identityDigest: 'not-a-digest' },
      }),
    ).toThrow('identity');
  });

  it('detects post-approval mutation or digest substitution', () => {
    const approved = createExecutionSpec(base);
    const substituted = {
      ...approved,
      argv: ['%s', 'substituted'],
    };

    expect(validateExecutionSpec(approved)).toBe(true);
    expect(validateExecutionSpec(substituted)).toBe(false);
  });

  it('canonicalizes environment key order while binding every execution field', () => {
    const first = createExecutionSpec({ ...base, envDelta: { SAFE_B: '2', SAFE_A: '1' } });
    const reordered = createExecutionSpec({ ...base, envDelta: { SAFE_A: '1', SAFE_B: '2' } });
    const changed = createExecutionSpec({ ...base, envDelta: { SAFE_A: 'changed', SAFE_B: '2' } });

    expect(executionSpecDigest(first)).toBe(executionSpecDigest(reordered));
    expect(executionSpecDigest(first)).not.toBe(executionSpecDigest(changed));
  });
});
