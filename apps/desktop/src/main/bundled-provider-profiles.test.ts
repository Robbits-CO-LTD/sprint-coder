import { describe, expect, it } from 'vitest';
import { providerProfileSchema } from '@sprint-coder/contracts';
import {
  BUNDLED_PROVIDER_PROFILES,
  LOCAL_PROVIDER_PROFILES,
  PACK_A_PROVIDER_PROFILES,
  PACK_B_PROVIDER_PROFILES,
} from './bundled-provider-profiles';

describe('bundled Provider Profiles', () => {
  it('keeps cloud Packs and local Profiles independent and every id unique', () => {
    expect(PACK_A_PROVIDER_PROFILES).toHaveLength(3);
    expect(PACK_B_PROVIDER_PROFILES).toHaveLength(5);
    expect(LOCAL_PROVIDER_PROFILES).toHaveLength(3);
    expect(BUNDLED_PROVIDER_PROFILES).toHaveLength(11);
    expect(new Set(BUNDLED_PROVIDER_PROFILES.map(({ id }) => id)).size).toBe(11);
    for (const profile of BUNDLED_PROVIDER_PROFILES)
      expect(() => providerProfileSchema.parse(profile)).not.toThrow();
  });

  it('requires API keys for cloud Profiles and keeps local authentication optional', () => {
    for (const profile of [...PACK_A_PROVIDER_PROFILES, ...PACK_B_PROVIDER_PROFILES])
      expect(profile.requiredCredentialFields).toContain('api_key');
    expect(
      LOCAL_PROVIDER_PROFILES.map(({ requiredCredentialFields }) => requiredCredentialFields),
    ).toEqual([[], [], []]);
  });

  it('declares the documented loopback defaults for local OpenAI-compatible servers', () => {
    expect(
      LOCAL_PROVIDER_PROFILES.map(({ id, baseUrl, protocol, modelsPath }) => ({
        id,
        baseUrl,
        protocol,
        modelsPath,
      })),
    ).toEqual([
      {
        id: 'localai',
        baseUrl: 'http://localhost:8080/v1',
        protocol: 'chat_completions',
        modelsPath: '/models',
      },
      {
        id: 'lm-studio',
        baseUrl: 'http://localhost:1234/v1',
        protocol: 'chat_completions',
        modelsPath: '/models',
      },
      {
        id: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        protocol: 'chat_completions',
        modelsPath: '/models',
      },
    ]);
    for (const profile of LOCAL_PROVIDER_PROFILES) expect(profile.baseUrlConfigurable).toBe(true);
  });

  it('uses curated catalogs only with an explicit minimal-probe model', () => {
    for (const profile of BUNDLED_PROVIDER_PROFILES) {
      if (profile.modelsPath !== null) {
        expect(profile.curatedModels).toEqual([]);
        expect(profile.verificationModel).toBeNull();
      } else {
        expect(profile.curatedModels.length).toBeGreaterThan(0);
        expect(profile.curatedModels.some(({ id }) => id === profile.verificationModel)).toBe(true);
      }
    }
  });

  it('records an official HTTPS source for every curated configuration', () => {
    for (const profile of BUNDLED_PROVIDER_PROFILES) {
      expect(profile.sourceReference).toMatch(/^https:\/\//);
      expect(Date.parse(profile.reviewedAt)).not.toBeNaN();
    }
  });
});
