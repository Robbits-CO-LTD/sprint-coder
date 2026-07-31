import { describe, expect, it } from 'vitest';
import { projectRefreshState } from './appStore';

describe('Project fetch states', () => {
  it('does not represent an initial failure as a successful empty result', () => {
    expect(projectRefreshState('loading', 'failure')).toBe('error');
    expect(projectRefreshState('error', 'start')).toBe('loading');
  });

  it('keeps the last successful result stale when a refresh fails', () => {
    expect(projectRefreshState('ready', 'start')).toBe('refreshing');
    expect(projectRefreshState('ready', 'failure')).toBe('stale');
    expect(projectRefreshState('stale', 'start')).toBe('refreshing');
    expect(projectRefreshState('refreshing', 'failure')).toBe('stale');
  });

  it('returns to ready after any successful request', () => {
    expect(projectRefreshState('error', 'success')).toBe('ready');
    expect(projectRefreshState('stale', 'success')).toBe('ready');
  });
});
