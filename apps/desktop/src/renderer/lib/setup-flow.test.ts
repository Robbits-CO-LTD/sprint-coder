import { describe, expect, it } from 'vitest';
import { setupSteps } from './setup-flow';
import { setupPreviewReply } from './setup-preview';

describe('setup steps', () => {
  it('first run shows every step in order', () => {
    expect(setupSteps({ mode: 'first-run', assistant: true, team: true })).toEqual([
      'welcome',
      'ai',
      'reply',
      'team',
      'details',
      'workspace',
      'done',
    ]);
  });

  it('replay has no Workspace step', () => {
    expect(setupSteps({ mode: 'replay', assistant: true, team: true })).not.toContain('workspace');
  });

  it('a preference the bridge cannot store is not offered', () => {
    expect(setupSteps({ mode: 'first-run', assistant: false, team: false })).toEqual([
      'welcome',
      'ai',
      'details',
      'workspace',
      'done',
    ]);
  });
});

describe('sample reply', () => {
  const tones = ['polite', 'casual', 'crisp'] as const;
  const lengths = ['short', 'balanced', 'detailed'] as const;
  const depths = ['conclusion', 'reasoned', 'beginner'] as const;

  it('every one of the 27 combinations reads differently', () => {
    const all = new Set<string>();
    for (const tone of tones)
      for (const length of lengths)
        for (const depth of depths) all.add(setupPreviewReply({ tone, length, depth }));
    expect(all.size).toBe(27);
  });

  it('longer settings give longer answers, and an explanation adds to the conclusion', () => {
    for (const tone of tones) {
      const short = setupPreviewReply({ tone, length: 'short', depth: 'conclusion' });
      const detailed = setupPreviewReply({ tone, length: 'detailed', depth: 'conclusion' });
      const reasoned = setupPreviewReply({ tone, length: 'short', depth: 'reasoned' });
      expect(detailed.length).toBeGreaterThan(short.length);
      expect(reasoned.length).toBeGreaterThan(short.length);
    }
  });
});
