import { describe, expect, it } from 'vitest';
import { runtimeKindSchema, runtimeSettingsSchema, skillCompatibilityReportSchema } from './index';

describe('Grok additive contracts', () => {
  it('accepts Grok and defaults older runtime settings to unavailable', () => {
    expect(runtimeKindSchema.parse('grok')).toBe('grok');
    const legacy = {
      kind: 'codex',
      codexAvailable: true,
      codexReadiness: 'ready',
      claudeAvailable: false,
      claudeReadiness: 'unavailable',
      model: 'auto',
      models: [],
      effort: 'medium',
      codexEffort: '',
      modelFallbackNotice: null,
    };
    expect(runtimeSettingsSchema.parse(legacy)).toMatchObject({
      grokAvailable: false,
      grokReadiness: 'unavailable',
      grokCli: null,
    });
    expect(
      runtimeSettingsSchema.parse({
        ...legacy,
        kind: 'grok',
        grokAvailable: true,
        grokReadiness: 'ready',
        grokCli: {
          source: 'path',
          executable: '/usr/bin/grok',
          version: 'test',
          compatibility: 'untested',
          capabilities: ['mcp'],
        },
        modelFallbackNotice: {
          changes: [{ runtimeKind: 'grok', migratedCount: 0, resetCount: 1 }],
        },
      }),
    ).toMatchObject({ kind: 'grok', grokAvailable: true });
  });

  it('does not infer native Grok compatibility from a legacy report', () => {
    expect(
      skillCompatibilityReportSchema.parse({
        profile: 'claude-native',
        runtimeSupport: { codex: 'blocked', claude: 'full', provider: 'blocked' },
        features: [],
        requestedTools: [],
        warnings: [],
        blockers: [],
        requiresConversion: true,
        nativeModeConsentRequired: true,
      }).runtimeSupport.grok,
    ).toBe('blocked');
  });
});
