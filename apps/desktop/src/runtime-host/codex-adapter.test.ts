import { describe, expect, it } from 'vitest';
import { probeCodex } from './codex-adapter';

describe('Codex runtime probe', () => {
  it('degrades to unavailable when the CLI cannot be spawned', async () => {
    await expect(probeCodex('__vibe_codex_cli_does_not_exist__')).resolves.toEqual({
      available: false,
    });
  });
});
