import { EventEmitter } from 'node:events';
import type * as CliCommandResolution from './cli-command-resolution';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  messages: [] as Record<string, unknown>[],
  respond: (_message: Record<string, unknown>): unknown[] => [],
  stopped: true,
  spawnThrows: false,
  failure: '' as string,
}));

vi.mock('./owned-cli-process', () => ({
  WINDOWS_CLI_JOB_STOP_TIMEOUT_MS: 2000,
  stopOwnedCliProcess: vi.fn(async () => fixture.stopped),
  spawnOwnedCliProcess: vi.fn(() => {
    if (fixture.spawnThrows) throw new Error('spawn failed');
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.stdin.on('data', (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as Record<string, unknown>;
      fixture.messages.push(message);
      queueMicrotask(() => {
        if (fixture.failure === 'exit') {
          child.emit('exit', 1);
          return;
        }
        if (fixture.failure === 'spawn') {
          child.emit('error', new Error('failed'));
          return;
        }
        if (fixture.failure === 'stdin') {
          child.stdin.emit('error', new Error('EPIPE'));
          return;
        }
        if (fixture.failure === 'json') {
          child.stdout.write('invalid json\n');
          return;
        }
        if (fixture.failure === 'oversize') {
          child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
          return;
        }
        if (fixture.failure === 'stderr') {
          child.stderr.write(Buffer.alloc(1024 * 1024 + 1));
          return;
        }
        for (const response of fixture.respond(message)) {
          const line = Buffer.from(`${JSON.stringify(response)}\n`);
          // Split even multibyte model names across data events.
          for (const byte of line) child.stdout.write(Buffer.from([byte]));
        }
      });
    });
    return child;
  }),
}));
vi.mock('./authentication-probe', () => ({
  probeCliAuthentication: vi.fn(async () => 'authenticated'),
}));
vi.mock('./cli-command-resolution', async (original) => ({
  ...(await original<typeof CliCommandResolution>()),
  probeCliCommandCandidates: vi.fn(async () => ({
    executable: 'fixture-cli',
    version: 'test',
    source: 'explicit',
    compatibility: 'verified',
    capabilities: [],
  })),
}));

import { modelRecord, probeCliModels } from './cli-model-probe';
import { spawnOwnedCliProcess, stopOwnedCliProcess } from './owned-cli-process';
import { parseClaudeModels, probeClaude } from './claude-adapter';
import { parseCodexModels, probeCodex } from './codex-adapter';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  fixture.messages = [];
  fixture.respond = () => [];
  fixture.stopped = true;
  fixture.spawnThrows = false;
  fixture.failure = '';
});

const claudeResponse = (models: unknown[]) => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: 'models', response: { models } },
});
const claudeModel = {
  value: 'future',
  resolvedModel: 'claude-future-99',
  displayName: '未来モデル',
  description: 'Fresh',
};
const codexModel = {
  model: 'gpt-future',
  displayName: 'Future',
  description: '',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'future_effort', description: 'Future effort' }],
  defaultReasoningEffort: 'future_effort',
  inputModalities: ['text', 'image'],
};

describe('CLI model metadata discovery', () => {
  it('queries Claude initialization without sending a prompt and preserves aliases and pinned IDs', async () => {
    fixture.respond = () => [claudeResponse([claudeModel])];
    const result = await probeClaude('fixture-cli', { CLAUDE_CONFIG_DIR: '/custom-config' });
    expect(result.models.map(({ id }) => id)).toEqual(['auto', 'future', 'claude-future-99']);
    expect(result.models[1]?.displayName).toBe('未来モデル');
    expect(fixture.messages).toEqual([
      {
        type: 'control_request',
        request_id: 'models',
        request: { subtype: 'initialize', hooks: {} },
      },
    ]);
    expect(spawnOwnedCliProcess).toHaveBeenCalledWith(
      'fixture-cli',
      expect.arrayContaining(['--safe-mode', '--tools', '', '--no-session-persistence']),
      expect.objectContaining({ env: { CLAUDE_CONFIG_DIR: '/custom-config' }, windowsHide: true }),
      expect.any(Function),
    );
    expect(stopOwnedCliProcess).toHaveBeenCalledOnce();
  });

  it('initializes Codex, follows all pages, and uses the selected CLI environment', async () => {
    fixture.respond = (message) => {
      if (message['method'] === 'initialize') return [{ id: message['id'], result: {} }];
      if (message['method'] !== 'model/list') return [];
      const cursor = modelRecord(message['params'])['cursor'];
      return [
        {
          id: message['id'],
          result: {
            data: [cursor ? { ...codexModel, model: 'gpt-next' } : codexModel],
            nextCursor: cursor ? null : 'next',
          },
        },
      ];
    };
    const result = await probeCodex('fixture-cli', { CODEX_HOME: '/custom-codex' });
    expect(result.models.map(({ id }) => id)).toEqual(['auto', 'gpt-future', 'gpt-next']);
    expect(result.models[1]).toMatchObject({
      defaultEffort: 'future_effort',
      efforts: [{ id: 'future_effort' }],
      capabilities: {
        multimodalInput: { value: true, sourceReference: 'Codex CLI app-server model/list' },
      },
    });
    expect(fixture.messages.map((message) => message['method'])).toEqual([
      'initialize',
      'initialized',
      'model/list',
      'model/list',
    ]);
    expect(spawnOwnedCliProcess).toHaveBeenCalledWith(
      'fixture-cli',
      ['app-server'],
      expect.objectContaining({ env: { CODEX_HOME: '/custom-codex' } }),
      expect.any(Function),
    );
  });

  it('reflects a changed CLI catalog on the next probe', async () => {
    fixture.respond = () => [claudeResponse([claudeModel])];
    expect((await probeClaude('fixture-cli')).models.some(({ id }) => id === 'future')).toBe(true);
    fixture.respond = () => [
      claudeResponse([{ ...claudeModel, value: 'new', resolvedModel: 'claude-new' }]),
    ];
    const result = await probeClaude('fixture-cli');
    expect(result.models.map(({ id }) => id)).toEqual(['auto', 'new', 'claude-new']);
  });

  it.each(['claude', 'codex'] as const)(
    'falls back to Auto after %s catalog failure',
    async (kind) => {
      fixture.respond = (message) =>
        kind === 'claude'
          ? [{ type: 'control_response', response: { request_id: 'models', subtype: 'error' } }]
          : [{ id: message['id'], error: { code: -1 } }];
      const result = await (kind === 'claude' ? probeClaude : probeCodex)('fixture-cli');
      expect(result).toMatchObject({
        available: true,
        readiness: 'ready',
        models: [expect.objectContaining({ id: 'auto' })],
      });
      expect(result.models).toHaveLength(1);
      expect(stopOwnedCliProcess).toHaveBeenCalledOnce();
    },
  );

  it('does not publish a partial catalog when a later page fails or repeats its cursor', async () => {
    fixture.respond = (message) =>
      message['method'] === 'initialize'
        ? [{ id: message['id'], result: {} }]
        : message['method'] === 'model/list'
          ? [{ id: message['id'], result: { data: [codexModel], nextCursor: 'loop' } }]
          : [];
    expect(await probeCliModels('codex', 'fixture', {})).toEqual([]);
    expect(fixture.messages.filter((message) => message['method'] === 'model/list')).toHaveLength(
      2,
    );
  });

  it('bounds a silent process and awaits stop confirmation', async () => {
    vi.useFakeTimers();
    let confirm!: (stopped: boolean) => void;
    vi.mocked(stopOwnedCliProcess).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const result = probeCliModels('claude', 'fixture', {}, 50);
    let done = false;
    void result.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(stopOwnedCliProcess).toHaveBeenCalledOnce();
    expect(done).toBe(false);
    confirm(true);
    expect(await result).toEqual([]);
  });

  it('does not publish after an unconfirmed stop', async () => {
    fixture.respond = () => [claudeResponse([claudeModel])];
    fixture.stopped = false;
    expect(await probeCliModels('claude', 'fixture', {})).toEqual([]);
  });

  it.each(['exit', 'spawn', 'stdin', 'json', 'oversize', 'stderr'])(
    'stops on %s failure',
    async (failure) => {
      fixture.failure = failure;
      expect(await probeCliModels('claude', 'fixture', {})).toEqual([]);
      expect(stopOwnedCliProcess).toHaveBeenCalledOnce();
    },
  );

  it('ignores unrelated response IDs until the matching response arrives', async () => {
    const unrelated = claudeResponse([{ ...claudeModel, value: 'wrong' }]);
    unrelated.response.request_id = 'other';
    fixture.respond = () => [unrelated, claudeResponse([claudeModel])];
    expect(await probeCliModels('claude', 'fixture', {})).toEqual([claudeModel]);
  });

  it('handles a synchronous spawn failure without hiding an installed CLI', async () => {
    fixture.spawnThrows = true;
    expect((await probeClaude('fixture-cli')).models.map(({ id }) => id)).toEqual(['auto']);
  });

  it('validates and deduplicates future model IDs, clips descriptions, and reserves Auto', () => {
    const models = parseClaudeModels([
      claudeModel,
      claudeModel,
      { ...claudeModel, value: 'bad id', resolvedModel: null },
      { ...claudeModel, value: 'auto', resolvedModel: null },
      { ...claudeModel, value: 'long', resolvedModel: null, description: 'x'.repeat(301) },
    ]);
    expect(models.map(({ id }) => id)).toEqual(['auto', 'future', 'claude-future-99', 'long']);
    expect(models.at(-1)?.description).toHaveLength(300);
    expect(
      parseCodexModels({
        data: [
          codexModel,
          codexModel,
          { ...codexModel, model: 'hidden', hidden: true },
          { ...codexModel, model: 'auto' },
        ],
      }).map(({ id }) => id),
    ).toEqual(['gpt-future']);
  });

  it('keeps saved selections intact instead of publishing a truncated authoritative catalog', () => {
    expect(
      parseClaudeModels(
        Array.from({ length: 33 }, (_, i) => ({
          ...claudeModel,
          value: `alias-${i}`,
          resolvedModel: `claude-${i}`,
        })),
      ),
    ).toHaveLength(1);
    expect(
      parseCodexModels({
        data: Array.from({ length: 33 }, (_, i) => ({ ...codexModel, model: `gpt-${i}` })),
      }),
    ).toEqual([]);
  });
});
