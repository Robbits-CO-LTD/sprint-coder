import { describe, expect, it } from 'vitest';
import { providerProfileSchema } from '@sprint-coder/contracts';
import {
  BUNDLED_PROVIDER_PROFILES,
  PACK_A_PROVIDER_PROFILES,
  PACK_B_PROVIDER_PROFILES,
} from './bundled-provider-profiles';

describe('bundled Provider Profiles', () => {
  it('keeps Pack A and Pack B independent and every id unique', () => {
    expect(PACK_A_PROVIDER_PROFILES).toHaveLength(3);
    expect(PACK_B_PROVIDER_PROFILES).toHaveLength(5);
    expect(BUNDLED_PROVIDER_PROFILES).toHaveLength(8);
    expect(new Set(BUNDLED_PROVIDER_PROFILES.map(({ id }) => id)).size).toBe(8);
    for (const profile of BUNDLED_PROVIDER_PROFILES)
      expect(() => providerProfileSchema.parse(profile)).not.toThrow();
  });

  it('uses curated catalogs only with an explicit minimal-probe model', () => {
    for (const profile of BUNDLED_PROVIDER_PROFILES) {
      if (profile.modelsPath !== null) {
        expect(profile.curatedModels).toEqual([]);
        expect(profile.verificationModel).toBeNull();
      } else {
        expect(profile.curatedModels.length).toBeGreaterThan(0);
        expect(
          profile.curatedModels.some(({ id }) => id === profile.verificationModel),
        ).toBe(true);
      }
    }
  });

  it('records an official HTTPS source for every curated configuration', () => {
    for (const profile of BUNDLED_PROVIDER_PROFILES) {
      expect(profile.sourceReference).toMatch(/^https:\/\//);
      expect(profile.reviewedAt).toBe('2026-07-28T00:00:00.000Z');
    }
  });
});
