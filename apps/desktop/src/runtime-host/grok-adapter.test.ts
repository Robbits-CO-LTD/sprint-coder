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
import type { RuntimeCanonicalEvent, RuntimeTeamMcpOption } from './protocol';
import type { PublicError } from '@sprint-coder/contracts';

const fixture = fileURLToPath(new URL('./fixtures/grok-acp.cjs', import.meta.url));
function run(model: string, timeout = 5_000, teamMcp?: RuntimeTeamMcpOption) {
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
    teamMcp,
  );
  return { adapter, events, errors, accepted, exit };
}

describe('Grok ACP adapter process lifecycle', () => {
  const teamMcp: RuntimeTeamMcpOption = {
    socketPath: 'synthetic-unused-socket',
    token: 'synthetic-unused-token',
    guidance: '',
    toolNames: [],
    managedTools: ['search_tool', 'use_tool'].map((name) => ({
      name,
      description: 'Synthetic host tool',
      inputSchema: { type: 'object', properties: {} },
    })),
  };
  it.each(['mcp-ready-update', 'mcp-prompt-update'])(
    'accepts authorized MCP aliases in a later inventory notification: %s',
    async (mode) => {
      const test = run(mode, 5_000, teamMcp);
      await test.exit;
      expect(test.errors).toEqual([]);
      expect(test.events.filter((e) => e.type === 'delta')).toHaveLength(1);
      expect(test.events.filter((e) => e.type === 'completed')).toHaveLength(1);
    },
  );
  it.each(['mcp-rogue-native', 'mcp-rogue-alias', 'mcp-rogue-server'])(
    'still rejects an unauthorized tool in a later MCP inventory: %s',
    async (mode) => {
      const test = run(mode, 5_000, teamMcp);
      await test.exit;
      expect(test.errors).toHaveLength(1);
      expect(test.errors[0]?.code).toBe('RUNTIME_PROTOCOL_ERROR');
      expect(test.events.some((e) => e.type === 'completed')).toBe(false);
    },
  );
  it('rejects Team aliases when no Team MCP is configured', async () => {
    const test = run('mcp-prompt-update');
    await test.exit;
    expect(test.errors[0]?.code).toBe('RUNTIME_PROTOCOL_ERROR');
    expect(test.events.some((e) => e.type === 'completed')).toBe(false);
  });
  it('streams a real subprocess response and completes exactly once after a checked profile', async () => {
    const test = run('normal');
    await test.exit;
    expect(test.errors).toEqual([]);
    expect(test.accepted).toHaveBeenCalledTimes(1);
    expect(test.events.filter((e) => e.type === 'delta')).toEqual([
      { type: 'delta', messageId: expect.any(String), delta: 'こんにちは' },
    ]);
    // The scenario name is not a Grok model id, so no resolved model is reported for it.
    expect(test.events.filter((e) => e.type === 'completed')).toEqual([{ type: 'completed' }]);
  });
  it('binds an explicit model after the CLI applies its session default (issue #515)', async () => {
    const test = run('grok-4.6');
    await test.exit;
    expect(test.errors).toEqual([]);
    expect(test.events.filter((e) => e.type === 'completed')).toEqual([
      { type: 'completed', resolvedModel: 'grok-4.6' },
    ]);
  });
  it('binds an explicit model for a Team MCP turn through the same path', async () => {
    const test = run('grok-4.7-build-fast', 5_000, teamMcp);
    await test.exit;
    expect(test.errors).toEqual([]);
    expect(test.events.filter((e) => e.type === 'completed')).toEqual([
      { type: 'completed', resolvedModel: 'grok-4.7-build-fast' },
    ]);
  });
  it('leaves auto on the CLI selection without binding a model', async () => {
    const test = run('auto');
    await test.exit;
    expect(test.errors).toEqual([]);
    expect(test.events.filter((e) => e.type === 'completed')).toEqual([
      { type: 'completed', resolvedModel: 'grok-fixture' },
    ]);
  });
  it('reports the acknowledged model when the prompt result names none', async () => {
    const test = run('grok-no-prompt-meta');
    await test.exit;
    expect(test.errors).toEqual([]);
    expect(test.events.filter((e) => e.type === 'completed')).toEqual([
      { type: 'completed', resolvedModel: 'grok-no-prompt-meta' },
    ]);
  });
  it.each(['set-model-error', 'set-model-malformed', 'set-model-mismatch'])(
    'fails before prompting when the explicit model is not bound: %s',
    async (mode) => {
      const test = run(mode);
      await test.exit;
      expect(test.errors[0]?.code).toBe('RUNTIME_PROTOCOL_ERROR');
      expect(test.events.some((e) => e.type === 'delta')).toBe(false);
      expect(test.events.some((e) => e.type === 'completed')).toBe(false);
    },
  );
  it('does not report success when a different model answered', async () => {
    const test = run('prompt-model-mismatch');
    await test.exit;
    expect(test.errors[0]?.code).toBe('RUNTIME_PROTOCOL_ERROR');
    expect(test.events.some((e) => e.type === 'completed')).toBe(false);
  });
  it('continues from thought to answer after an unmatched string response with MCP enabled', async () => {
    const test = run('string-response', 5_000, teamMcp);
    await test.exit;
    expect(test.errors).toEqual([]);
    expect(test.events.filter((e) => e.type === 'reasoning')).toHaveLength(1);
    expect(test.events.filter((e) => e.type === 'delta')).toEqual([
      { type: 'delta', messageId: expect.any(String), delta: 'こんにちは' },
    ]);
    expect(test.events.filter((e) => e.type === 'completed')).toHaveLength(1);
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
  it.each([
    ['search_tool', 'use_tool'],
    ['search_tool', 'use_tool', 'team__search_tool'],
    ['team__use_tool', 'use_tool', 'team__search_tool', 'search_tool'],
  ])('allows only registered aliases while MCP discovery progresses: %j', (...tools) => {
    expect(() => assertGrokToolInventory(tools, ['search_tool', 'use_tool'])).not.toThrow();
  });
  it.each(
    [
      null,
      {},
      [],
      ['search_tool'],
      ['team__search_tool', 'team__use_tool'],
      ['search_tool', 'use_tool', 'use_tool'],
      ['search_tool', 'use_tool', 'team__search_tool', 'team__search_tool'],
      ['search_tool', 'use_tool', 'bash'],
      ['search_tool', 'use_tool', 'team__unregistered'],
      ['search_tool', 'use_tool', 'rogue__use_tool'],
      ['search_tool', 'use_tool', 1],
    ].map((tools) => ({ tools })),
  )('rejects malformed, missing, duplicate or unregistered inventory: $tools', ({ tools }) => {
    expect(() => assertGrokToolInventory(tools, ['search_tool', 'use_tool'])).toThrow();
  });
});
