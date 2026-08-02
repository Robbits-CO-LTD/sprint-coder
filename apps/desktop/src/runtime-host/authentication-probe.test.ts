import { describe, expect, it } from 'vitest';
import { classifyAuthenticationResult } from './authentication-probe';

describe('CLI authentication result classification', () => {
  it('accepts a successful probe as authenticated', () => {
    expect(classifyAuthenticationResult('codex', 0, '')).toBe('authenticated');
    expect(classifyAuthenticationResult('claude', 0, '{"loggedIn":true}')).toBe('authenticated');
  });

  it('requires explicit Codex unauthenticated output', () => {
    expect(classifyAuthenticationResult('codex', 1, 'Not logged in')).toBe('unauthenticated');
    expect(classifyAuthenticationResult('codex', 1, 'unknown command: login')).toBe('unknown');
    expect(classifyAuthenticationResult('codex', 1, 'temporary network failure')).toBe('unknown');
  });

  it('requires an explicit Claude JSON authentication flag', () => {
    expect(classifyAuthenticationResult('claude', 1, '{"loggedIn":false}')).toBe('unauthenticated');
    expect(classifyAuthenticationResult('claude', 1, '{"authenticated":false}')).toBe(
      'unauthenticated',
    );
    expect(classifyAuthenticationResult('claude', 1, 'unknown command: auth')).toBe('unknown');
    expect(classifyAuthenticationResult('claude', 1, 'configuration read failed')).toBe('unknown');
  });

  it('does not treat unsupported exit codes or signals as missing authentication', () => {
    expect(classifyAuthenticationResult('codex', 2, 'Not logged in')).toBe('unknown');
    expect(classifyAuthenticationResult('claude', null, '{"loggedIn":false}')).toBe('unknown');
  });
});
