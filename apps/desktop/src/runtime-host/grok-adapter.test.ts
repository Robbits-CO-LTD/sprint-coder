import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  GrokRuntimeAdapter,
  assertGrokToolInventory,
  buildGrokArgs,
  grokAuthenticationMethod,
  grokMcpInventoryReady,
  grokModelsFromInitialize,
} from './grok-adapter';
import type { RuntimeCanonicalEvent } from './protocol';
import type { PublicError } from '@sprint-coder/contracts';

const fixture = fileURLToPath(new URL('./fixtures/grok-acp.cjs', import.meta.url));
function run(model: string, timeout = 5_000) {
  const adapter = new GrokRuntimeAdapter(timeout, [fixture]);
  adapter.setCliResolution({
    executable: process.execPath,
    source: 'explicit',
    version: 'grok 1.0.40',
    compatibility: 'compatible',
    capabilities: ['acp'],
  });
  const events: RuntimeCanonicalEvent[] = [];
  const errors: PublicError[] = [];
  const accepted = vi.fn();
  let finish!: (value: { code: number; canceled: boolean }) => void;
  const exit = new Promise<{ code: number; canceled: boolean }>((resolve) => {
    finish = resolve;
  });
  adapter.start(
    'turn',
    'Synthetic test',
    [],
    accepted,
    null,
    model,
    (event) => events.push(event),
    (error) => errors.push(error),
    (code, canceled) => finish({ code, canceled }),
  );
  return { adapter, events, errors, accepted, exit };
}

describe('Grok ACP adapter process lifecycle', () => {
  it('streams a real subprocess response and completes exactly once after a checked profile', async () => {
    const test = run('normal');
    await test.exit;
    expect(test.errors).toEqual([]);
    expect(test.accepted).toHaveBeenCalledTimes(1);
    expect(test.events.filter((e) => e.type === 'delta')).toEqual([
      { type: 'delta', messageId: expect.any(String), delta: 'こんにちは' },
    ]);
    expect(test.events.filter((e) => e.type === 'completed')).toEqual([
      { type: 'completed', resolvedModel: 'grok-fixture' },
    ]);
  });
  it.each([
    'rogue-tools',
    'rogue-mcp',
    'wrong-session',
    'malformed',
    'early-exit',
    'rpc-error',
    'no-auth',
    'max-tokens',
    'empty',
  ])('refuses %s without reporting success', async (mode) => {
    const test = run(mode);
    await test.exit;
    expect(test.errors).toHaveLength(1);
    expect(test.events.some((e) => e.type === 'completed')).toBe(false);
    expect(JSON.stringify(test.errors)).not.toContain('FAKE_SECRET');
  });
  it('keeps tool waits in executing until the terminal reply', async () => {
    const test = run('tool-wait');
    await test.exit;
    expect(test.errors).toEqual([]);
    expect(test.events.at(-1)?.type).toBe('completed');
  });
  it('cancels a silent child and confirms its exit without a completion', async () => {
    const test = run('hang');
    await vi.waitFor(() => expect(test.accepted).toHaveBeenCalled());
    expect(await test.adapter.cancel('turn')).toBe(false);
    expect((await test.exit).canceled).toBe(true);
    expect(test.events.some((e) => e.type === 'completed')).toBe(false);
    expect(test.errors).toEqual([]);
  });
  it('bounds a silent turn and emits one timeout', async () => {
    const test = run('hang', 100);
    await test.exit;
    expect(test.errors).toHaveLength(1);
    expect(test.errors[0]?.code).toBe('RUNTIME_TIMEOUT');
  });
  it('classifies quota failures without disclosing raw provider text', async () => {
    const test = run('rate-limit');
    await test.exit;
    expect(test.errors).toHaveLength(1);
    expect(test.errors[0]?.code).toBe('RUNTIME_RATE_LIMIT');
    expect(JSON.stringify(test.errors)).not.toContain('FAKE_SECRET');
  });
  it('settles missing executables', async () => {
    const adapter = new GrokRuntimeAdapter();
    adapter.setCliResolution({
      executable: '/missing/sprint-coder-grok',
      source: 'explicit',
      version: 'grok 1.0.40',
      compatibility: 'compatible',
      capabilities: ['acp'],
    });
    const failed = vi.fn();
    const exit = new Promise<void>((resolve) =>
      adapter.start('missing', 'test', [], vi.fn(), null, 'auto', vi.fn(), failed, () => resolve()),
    );
    await exit;
    expect(failed).toHaveBeenCalledTimes(1);
  });
});

describe('Grok catalog and capability gates', () => {
  it('uses the CLI catalog instead of hardcoded current model IDs', () => {
    const models = grokModelsFromInitialize({
      _meta: {
        grokShell: true,
        modelState: {
          availableModels: [
            { modelId: 'grok-new', name: 'Grok new' },
            { modelId: 'other-provider', name: 'Other' },
          ],
        },
      },
    });
    expect(models.map((m) => m.id)).toEqual(['auto', 'grok-new']);
    expect(() => grokModelsFromInitialize({})).toThrow();
  });
  it('never chooses interactive authentication in a background probe', () => {
    expect(grokAuthenticationMethod({ authMethods: [{ id: 'grok.com' }] })).toBeNull();
    expect(
      grokAuthenticationMethod({ authMethods: [{ id: 'xai.api_key' }, { id: 'cached_token' }] }),
    ).toBe('cached_token');
  });
  it('pins CLI isolation arguments without forwarding effort or prompts in argv', () => {
    expect(buildGrokArgs('grok-new')).toEqual([
      '--no-auto-update',
      'agent',
      '--no-leader',
      '--model',
      'grok-new',
      'stdio',
    ]);
  });
  it('requires an exact native and MCP inventory', () => {
    expect(() => assertGrokToolInventory(['search_tool', 'use_tool', 'bash'])).toThrow();
    expect(
      grokMcpInventoryReady(
        { result: { servers: [{ name: 'team' }], sessionMcpResolved: false } },
        ['read_file'],
      ),
    ).toBe(false);
    expect(
      grokMcpInventoryReady(
        {
          result: {
            servers: [
              {
                name: 'team',
                session: { enabled: true, status: 'ready', tools: [{ name: 'read_file' }] },
              },
            ],
            sessionMcpResolved: true,
          },
        },
        ['read_file'],
      ),
    ).toBe(true);
  });
});
