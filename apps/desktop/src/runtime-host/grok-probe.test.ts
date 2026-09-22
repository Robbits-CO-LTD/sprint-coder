import { afterEach, describe, expect, it, vi } from 'vitest';
import * as isolation from './grok-isolation';
import { probeGrok } from './grok-adapter';
import type * as resolution from './cli-command-resolution';
const cli = vi.hoisted(() => ({
  executable: '/fixture/grok',
  source: 'explicit' as const,
  version: 'grok 1.0.40',
  compatibility: 'compatible' as const,
  capabilities: ['acp'],
}));
vi.mock('./cli-command-resolution', async (original) => ({
  ...(await original<typeof resolution>()),
  probeCliCommandCandidates: vi.fn(async () => cli),
}));
afterEach(() => vi.restoreAllMocks());
describe('Grok capability failure containment', () => {
  it('returns installed/unavailable for a relative auth configuration rather than rejecting hello', async () => {
    await expect(
      probeGrok('/fixture/grok', { GROK_AUTH_PATH: 'relative/auth.json' }),
    ).resolves.toMatchObject({ available: true, readiness: 'unavailable', cli });
  });
  it('returns installed/unavailable when isolation staging fails before spawn', async () => {
    vi.spyOn(isolation, 'prepareGrokIsolation').mockImplementation(() => {
      throw new Error('Synthetic staging failure');
    });
    await expect(probeGrok('/fixture/grok', {})).resolves.toMatchObject({
      available: true,
      readiness: 'unavailable',
      cli,
    });
  });
});
