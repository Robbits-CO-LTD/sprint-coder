import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ManagedLocalRuntimeError,
  ManagedLocalRuntimeSupervisor,
  managedLocalEnvironment,
} from './managed-local-runtime-supervisor';
import {
  managedLocalTargetKey,
  verifyManagedLocalSidecarBundle,
  type ManagedLocalSidecarPin,
  type VerifiedManagedLocalSidecarBundle,
} from './managed-local-sidecar-bundle';

const roots: string[] = [];
const TOKEN = 'managed_local_test_token_0123456789abcdef';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directories(): Promise<{ modelRoot: string; scratchRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sprint-coder-local-supervisor-')));
  roots.push(root);
  const modelRoot = join(root, 'models');
  const scratchRoot = join(root, 'scratch');
  await mkdir(modelRoot);
  await mkdir(scratchRoot);
  return { modelRoot, scratchRoot };
}

function bundle(): VerifiedManagedLocalSidecarBundle {
  return {
    target: 'darwin-arm64',
    rootPath: '/fixture/managed-local',
    manifest: {
      schemaVersion: 1,
      runtime: 'llama.cpp',
      runtimeVersion: 'b10516',
      upstreamRepository: 'https://github.com/ggml-org/llama.cpp',
      upstreamRevision: 'a'.repeat(40),
      platform: 'darwin',
      architecture: 'arm64',
      candidateBackends: ['cpu'],
      artifacts: [],
    },
    manifestSha256: 'b'.repeat(64),
    serverPath: '/fixture/managed-local/bin/llama-server',
    licensePath: '/fixture/managed-local/licenses/LICENSE',
    artifactPaths: {},
  };
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: NodeJS.Signals[] = [];

  constructor(private readonly ignoreTerm = false) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    if (signal === 'SIGTERM' && this.ignoreTerm) return true;
    if (this.exitCode === null) {
      this.exitCode = 0;
      this.signalCode = signal;
      this.emit('exit', this.exitCode, signal);
    }
    return true;
  }

  crash(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

function harness(
  input: {
    emitListening?: boolean;
    fetch?: typeof globalThis.fetch;
    startupTimeoutMs?: number;
    ignoreTerm?: boolean;
  } = {},
) {
  const child = new FakeChild(input.ignoreTerm);
  let spawnArgs: readonly string[] = [];
  let spawnOptions: SpawnOptions | null = null;
  const requests: { url: string; authorization: string | null }[] = [];
  const fetcher: typeof globalThis.fetch =
    input.fetch ??
    (async (url, init) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      requests.push({ url: String(url), authorization });
      if (String(url).endsWith('/props'))
        return new Response('{}', { status: authorization === null ? 401 : 200 });
      if (String(url).endsWith('/v1/models')) return new Response('{}', { status: 200 });
      if (String(url).endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
      return new Response('{}', { status: 404 });
    });
  const supervisor = new ManagedLocalRuntimeSupervisor({
    loadBundle: async () => bundle(),
    spawnProcess: (_command, args, options) => {
      spawnArgs = [...args];
      spawnOptions = options;
      if (input.emitListening !== false)
        queueMicrotask(() => child.stdout.write('listening on http://127.0.0.1:43210\n'));
      return child as unknown as ChildProcess;
    },
    fetch: fetcher,
    randomToken: () => TOKEN,
    delay: async () => new Promise((resolve) => setTimeout(resolve, 1)),
    startupTimeoutMs: input.startupTimeoutMs ?? 100,
    requestTimeoutMs: 100,
    stopTimeoutMs: 100,
  });
  return {
    child,
    supervisor,
    requests,
    spawnArgs: () => spawnArgs,
    spawnOptions: () => spawnOptions,
  };
}

describe('ManagedLocalRuntimeSupervisor', () => {
  it('uses OS-assigned loopback, keeps the token out of argv, verifies auth, and redacts diagnostics', async () => {
    const paths = await directories();
    const env = harness();

    const session = await env.supervisor.start({ kind: 'router_probe', ...paths });

    expect(session.baseUrl).toBe('http://127.0.0.1:43210/v1');
    expect(env.spawnArgs()).toEqual(
      expect.arrayContaining(['--host', '127.0.0.1', '--port', '0', '--no-webui', '--models-dir']),
    );
    expect(env.spawnArgs()).not.toContain(TOKEN);
    expect(env.spawnOptions()?.shell).toBe(false);
    expect(env.spawnOptions()?.env).toMatchObject({
      LLAMA_API_KEY: TOKEN,
      LLAMA_CACHE: paths.scratchRoot,
      TMP: paths.scratchRoot,
      TEMP: paths.scratchRoot,
      TMPDIR: paths.scratchRoot,
    });
    expect(env.spawnOptions()?.env?.PATH).toBeUndefined();
    expect(env.requests.slice(0, 3)).toEqual([
      { url: 'http://127.0.0.1:43210/props', authorization: null },
      { url: 'http://127.0.0.1:43210/props', authorization: `Bearer ${TOKEN}` },
      { url: 'http://127.0.0.1:43210/health', authorization: `Bearer ${TOKEN}` },
    ]);
    env.child.stderr.write(`secret=${TOKEN} model=${paths.modelRoot}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.diagnostics()).toContain('secret=[REDACTED] model=[REDACTED]');
    expect(session.diagnostics()).not.toContain(TOKEN);
    expect(session.diagnostics()).not.toContain(paths.modelRoot);

    const response = await session.authenticatedFetch('/v1/models');
    expect(response.status).toBe(200);
    expect(env.requests.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    await expect(session.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(env.child.kills).toEqual(['SIGTERM']);
  });

  it('rejects a server that does not enforce authentication and owns cleanup', async () => {
    const paths = await directories();
    const env = harness({
      fetch: async () => new Response('{}', { status: 200 }),
    });

    await expect(env.supervisor.start({ kind: 'router_probe', ...paths })).rejects.toMatchObject({
      code: 'authentication_failed',
    });
    expect(env.child.kills).toEqual(['SIGTERM']);
  });

  it('times out a process that never reports its OS-assigned port', async () => {
    const paths = await directories();
    const env = harness({ emitListening: false, startupTimeoutMs: 5 });

    await expect(env.supervisor.start({ kind: 'router_probe', ...paths })).rejects.toMatchObject({
      code: 'startup_timeout',
    });
    expect(env.child.kills).toEqual(['SIGTERM']);
  });

  it('prevents concurrent runtimes and records an unexpected exit as crashed', async () => {
    const paths = await directories();
    const env = harness();
    const session = await env.supervisor.start({ kind: 'router_probe', ...paths });

    await expect(env.supervisor.start({ kind: 'router_probe', ...paths })).rejects.toMatchObject({
      code: 'already_running',
    });
    env.child.crash(17);
    expect(session.snapshot()).toMatchObject({ state: 'crashed', exitCode: 17 });
    await expect(session.authenticatedFetch('/v1/models')).rejects.toMatchObject({
      code: 'runtime_stopped',
    });
  });

  it('escalates only its owned child when graceful stop exceeds the deadline', async () => {
    const paths = await directories();
    const env = harness({ ignoreTerm: true });
    const session = await env.supervisor.start({ kind: 'router_probe', ...paths });

    await expect(session.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(env.child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('accepts only a single-link GGUF inside the model root with disjoint scratch', async () => {
    const paths = await directories();
    const outside = join(dirname(paths.modelRoot), 'outside.gguf');
    await writeFile(outside, 'not a model');
    const env = harness();

    await expect(
      env.supervisor.start({
        kind: 'model',
        ...paths,
        modelPath: outside,
        modelAlias: 'a'.repeat(64),
        contextTokens: 4096,
        batchSize: 512,
        gpuLayers: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      env.supervisor.start({
        kind: 'router_probe',
        modelRoot: paths.modelRoot,
        scratchRoot: paths.modelRoot,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('builds a minimal child environment without loader injection or inherited secrets', () => {
    const environment = managedLocalEnvironment(
      {
        LANG: 'ja_JP.UTF-8',
        PATH: '/untrusted',
        LD_PRELOAD: '/attack.so',
        DYLD_INSERT_LIBRARIES: '/attack.dylib',
        SECRET_VALUE: 'secret',
        SYSTEMROOT: 'C:\\Windows',
      },
      TOKEN,
      '/private/scratch',
    );

    expect(environment).toEqual({
      LANG: 'ja_JP.UTF-8',
      SYSTEMROOT: 'C:\\Windows',
      LLAMA_API_KEY: TOKEN,
      LLAMA_CACHE: '/private/scratch',
      TMP: '/private/scratch',
      TEMP: '/private/scratch',
      TMPDIR: '/private/scratch',
    });
  });

  it('rejects escaped request paths without touching fetch', async () => {
    const paths = await directories();
    const env = harness();
    const session = await env.supervisor.start({ kind: 'router_probe', ...paths });
    const count = env.requests.length;

    for (const path of ['https://example.com', '//example.com/path', '/../escape'])
      await expect(session.authenticatedFetch(path)).rejects.toBeInstanceOf(
        ManagedLocalRuntimeError,
      );
    expect(env.requests).toHaveLength(count);
    await session.stop();
  });

  it.runIf(process.env['SPRINT_CODER_MANAGED_LOCAL_LIVE'] === '1')(
    'starts the pinned real sidecar on an OS-assigned port and enforces the internal token',
    async () => {
      const target = managedLocalTargetKey();
      if (target === null) throw new Error('Unsupported live Managed Local target');
      const buildRoot = resolve(process.cwd(), 'managed-local', 'build');
      const pins = JSON.parse(
        await readFile(join(buildRoot, 'managed-local-sidecar-pins.json'), 'utf8'),
      ) as Record<string, ManagedLocalSidecarPin>;
      const pin = pins[target];
      if (pin === undefined) throw new Error('Live Managed Local pin is unavailable');
      const liveBundle = await verifyManagedLocalSidecarBundle(
        join(buildRoot, 'managed-local', target),
        pin,
      );
      const paths = await directories();
      const supervisor = new ManagedLocalRuntimeSupervisor({
        loadBundle: async () => liveBundle,
      });

      const session = await supervisor.start({ kind: 'router_probe', ...paths });
      expect(session.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      await expect(session.authenticatedFetch('/v1/models')).resolves.toMatchObject({
        status: 200,
      });
      await expect(session.stop()).resolves.toMatchObject({ state: 'stopped' });
    },
    30_000,
  );
});
