import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import type { Readable } from 'node:stream';
import {
  loadBundledManagedLocalSidecar,
  type ManagedLocalBackend,
  type VerifiedManagedLocalSidecarBundle,
} from './managed-local-sidecar-bundle';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const LISTENING = /listening on http:\/\/127\.0\.0\.1:(\d{1,5})/u;
const MODEL_ALIAS = /^[a-f0-9]{64}$/u;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ManagedLocalRuntimeStartInput =
  | Readonly<{
      kind: 'model';
      modelRoot: string;
      modelPath: string;
      /** Optional multimodal projector, validated inside the same model store. */
      mmprojPath?: string;
      modelAlias: string;
      scratchRoot: string;
      backend: ManagedLocalBackend;
      contextTokens: number;
      batchSize: number;
      gpuLayers: number;
    }>
  | Readonly<{
      /** Used for the bounded transport/auth probe before model lifecycle integration. */
      kind: 'router_probe';
      modelRoot: string;
      scratchRoot: string;
    }>;

export type ManagedLocalRuntimeState = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

export type ManagedLocalRuntimeSnapshot = Readonly<{
  state: ManagedLocalRuntimeState;
  target: string;
  runtimeVersion: string;
  baseUrl: string | null;
  backend: ManagedLocalBackend | null;
  gpuLayers: number | null;
  contextTokens: number | null;
  batchSize: number | null;
  startedAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

export class ManagedLocalRuntimeError extends Error {
  constructor(
    readonly code:
      | 'already_running'
      | 'invalid_input'
      | 'spawn_failed'
      | 'startup_timeout'
      | 'authentication_failed'
      | 'health_failed'
      | 'runtime_stopped',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedLocalRuntimeError';
  }
}

export type ManagedLocalRuntimeSession = Readonly<{
  baseUrl: string;
  snapshot(): ManagedLocalRuntimeSnapshot;
  diagnostics(): string;
  authenticatedFetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<ManagedLocalRuntimeSnapshot>;
}>;

type SupervisorDependencies = Readonly<{
  loadBundle?: () => Promise<VerifiedManagedLocalSidecarBundle>;
  spawnProcess?: SpawnProcess;
  fetch?: typeof globalThis.fetch;
  randomToken?: () => string;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
}>;

type ActiveRuntime = {
  child: ChildProcess;
  token: string;
  modelRoot: string;
  modelPath: string | null;
  diagnostic: BoundedDiagnostic;
  snapshot: ManagedLocalRuntimeSnapshot;
  session: ManagedLocalRuntimeSession | null;
  stopPromise: Promise<ManagedLocalRuntimeSnapshot> | null;
};

type EffectiveModelSettings = Readonly<{
  backend: ManagedLocalBackend;
  gpuLayers: number;
  contextTokens: number;
  batchSize: number;
  runtimeVersion: string;
}>;

export class ManagedLocalRuntimeSupervisor {
  private readonly loadBundle: () => Promise<VerifiedManagedLocalSidecarBundle>;
  private readonly spawnProcess: SpawnProcess;
  private readonly fetch: typeof globalThis.fetch;
  private readonly randomToken: () => string;
  private readonly now: () => Date;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private active: ActiveRuntime | null = null;

  constructor(dependencies: SupervisorDependencies = {}) {
    this.loadBundle = dependencies.loadBundle ?? loadBundledManagedLocalSidecar;
    this.spawnProcess =
      dependencies.spawnProcess ?? ((command, args, options) => spawn(command, args, options));
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.randomToken = dependencies.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.now = dependencies.now ?? (() => new Date());
    this.delay =
      dependencies.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.startupTimeoutMs = positiveTimeout(
      dependencies.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
    );
    this.requestTimeoutMs = positiveTimeout(
      dependencies.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.stopTimeoutMs = positiveTimeout(dependencies.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
  }

  snapshot(): ManagedLocalRuntimeSnapshot | null {
    return this.active?.snapshot ?? null;
  }

  async start(input: ManagedLocalRuntimeStartInput): Promise<ManagedLocalRuntimeSession> {
    if (this.active !== null && !['stopped', 'crashed'].includes(this.active.snapshot.state))
      throw new ManagedLocalRuntimeError('already_running', 'A Managed Local runtime is active');
    const bundle = await this.loadBundle();
    const settings = input.kind === 'model' ? validateModelSettings(input, bundle) : null;
    const prepared = await prepareStartInput(input);
    const token = this.randomToken();
    if (!/^[a-zA-Z0-9_-]{32,128}$/u.test(token))
      throw new ManagedLocalRuntimeError('invalid_input', 'Managed Local token generator failed');
    const diagnostic = new BoundedDiagnostic([
      token,
      prepared.modelRoot,
      ...(prepared.modelPath === null ? [] : [prepared.modelPath]),
      ...(prepared.mmprojPath === null ? [] : [prepared.mmprojPath]),
    ]);
    const args = runtimeArguments(input, prepared, settings);
    let child: ChildProcess;
    try {
      child = this.spawnProcess(bundle.serverPath, args, {
        cwd: dirname(bundle.serverPath),
        env: managedLocalEnvironment(process.env, token, prepared.scratchRoot),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new ManagedLocalRuntimeError('spawn_failed', 'Managed Local process could not start');
    }
    const startedAt = this.now().toISOString();
    const active: ActiveRuntime = {
      child,
      token,
      modelRoot: prepared.modelRoot,
      modelPath: prepared.modelPath,
      diagnostic,
      snapshot: {
        state: 'starting',
        target: bundle.target,
        runtimeVersion: settings?.runtimeVersion ?? bundle.manifest.runtimeVersion,
        baseUrl: null,
        backend: settings?.backend ?? null,
        gpuLayers: settings?.gpuLayers ?? null,
        contextTokens: settings?.contextTokens ?? null,
        batchSize: settings?.batchSize ?? null,
        startedAt,
        stoppedAt: null,
        exitCode: null,
        signal: null,
      },
      session: null,
      stopPromise: null,
    };
    this.active = active;
    attachDiagnostics(child.stdout, diagnostic);
    attachDiagnostics(child.stderr, diagnostic);
    child.once('exit', (code, signal) => this.recordExit(active, code, signal));
    child.once('error', () => this.recordSpawnError(active));

    try {
      const port = await waitForListeningPort(active, this.startupTimeoutMs, this.delay);
      const origin = `http://${LOOPBACK_HOST}:${port}`;
      await this.verifyAuthentication(origin, token);
      await this.waitForHealth(origin, token, input.kind === 'model');
      if (active.snapshot.state === 'crashed')
        throw new ManagedLocalRuntimeError(
          'runtime_stopped',
          'Managed Local exited during startup',
        );
      active.snapshot = { ...active.snapshot, state: 'running', baseUrl: `${origin}/v1` };
      const session = this.createSession(active, origin);
      active.session = session;
      return session;
    } catch (error) {
      await this.stopActive(active);
      if (error instanceof ManagedLocalRuntimeError) throw error;
      throw new ManagedLocalRuntimeError('spawn_failed', 'Managed Local startup failed');
    }
  }

  async stop(): Promise<ManagedLocalRuntimeSnapshot | null> {
    if (this.active === null) return null;
    return this.stopActive(this.active);
  }

  private createSession(active: ActiveRuntime, origin: string): ManagedLocalRuntimeSession {
    const session: ManagedLocalRuntimeSession = Object.freeze({
      baseUrl: `${origin}/v1`,
      snapshot: () => active.snapshot,
      diagnostics: () => active.diagnostic.value(),
      authenticatedFetch: (path, init) => this.authenticatedFetch(active, origin, path, init),
      stop: () => this.stopActive(active),
    });
    return session;
  }

  private async authenticatedFetch(
    active: ActiveRuntime,
    origin: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (active.snapshot.state !== 'running')
      throw new ManagedLocalRuntimeError('runtime_stopped', 'Managed Local is not running');
    if (!/^\/[a-zA-Z0-9/_-]{1,256}$/u.test(path) || path.includes('//'))
      throw new ManagedLocalRuntimeError('invalid_input', 'Invalid Managed Local request path');
    const url = new URL(path, `${origin}/`);
    if (url.origin !== origin)
      throw new ManagedLocalRuntimeError('invalid_input', 'Managed Local request escaped loopback');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${active.token}`);
    return this.fetch(url, {
      ...init,
      headers,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
    });
  }

  private async verifyAuthentication(origin: string, token: string): Promise<void> {
    const unauthenticated = await this.fetch(`${origin}/props`, {
      redirect: 'error',
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }).catch(() => null);
    const unauthenticatedStatus = unauthenticated?.status ?? null;
    await unauthenticated?.body?.cancel().catch(() => undefined);
    if (unauthenticatedStatus !== 401)
      throw new ManagedLocalRuntimeError(
        'authentication_failed',
        'Managed Local did not reject an unauthenticated request',
      );
    const authenticated = await this.fetch(`${origin}/props`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }).catch(() => null);
    if (authenticated?.ok !== true)
      throw new ManagedLocalRuntimeError(
        'authentication_failed',
        'Managed Local authentication probe failed',
      );
    await authenticated.body?.cancel().catch(() => undefined);
  }

  private async waitForHealth(
    origin: string,
    token: string,
    requireLoaded: boolean,
  ): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    do {
      const response = await this.fetch(`${origin}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }).catch(() => null);
      if (response?.status === 200) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const status = response?.status ?? null;
      await response?.body?.cancel().catch(() => undefined);
      if (!requireLoaded && status === 503) return;
      if (status !== null && status !== 503)
        throw new ManagedLocalRuntimeError('health_failed', 'Managed Local health probe failed');
      await this.delay(100);
    } while (Date.now() < deadline);
    throw new ManagedLocalRuntimeError('startup_timeout', 'Managed Local health timed out');
  }

  private stopActive(active: ActiveRuntime): Promise<ManagedLocalRuntimeSnapshot> {
    if (active.stopPromise !== null) return active.stopPromise;
    active.stopPromise = (async () => {
      if (active.snapshot.state === 'stopped') return active.snapshot;
      if (active.snapshot.state !== 'crashed')
        active.snapshot = { ...active.snapshot, state: 'stopping' };
      if (active.child.exitCode === null) {
        active.child.kill('SIGTERM');
        const exited = await waitForExit(active.child, this.stopTimeoutMs);
        if (!exited && active.child.exitCode === null) {
          active.child.kill('SIGKILL');
          if (!(await waitForExit(active.child, this.stopTimeoutMs))) {
            active.snapshot = {
              ...active.snapshot,
              state: 'crashed',
              stoppedAt: this.now().toISOString(),
            };
            throw new ManagedLocalRuntimeError(
              'runtime_stopped',
              'Managed Local did not stop before the deadline',
            );
          }
        }
      }
      if (active.snapshot.state !== 'crashed')
        active.snapshot = {
          ...active.snapshot,
          state: 'stopped',
          stoppedAt: this.now().toISOString(),
          exitCode: active.child.exitCode,
        };
      return active.snapshot;
    })();
    return active.stopPromise;
  }

  private recordExit(
    active: ActiveRuntime,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (active.snapshot.state === 'stopping' || active.snapshot.state === 'stopped') return;
    active.snapshot = {
      ...active.snapshot,
      state: 'crashed',
      stoppedAt: this.now().toISOString(),
      exitCode: code,
      signal,
    };
  }

  private recordSpawnError(active: ActiveRuntime): void {
    if (active.snapshot.state !== 'starting') return;
    active.snapshot = {
      ...active.snapshot,
      state: 'crashed',
      stoppedAt: this.now().toISOString(),
    };
  }
}

async function prepareStartInput(input: ManagedLocalRuntimeStartInput): Promise<
  Readonly<{
    modelRoot: string;
    modelPath: string | null;
    mmprojPath: string | null;
    scratchRoot: string;
  }>
> {
  const modelRoot = await canonicalDirectory(input.modelRoot, 'model root');
  const scratchRoot = await canonicalDirectory(input.scratchRoot, 'scratch root');
  if (pathsOverlap(modelRoot, scratchRoot))
    throw new ManagedLocalRuntimeError('invalid_input', 'Model and scratch roots must be disjoint');
  if (input.kind === 'router_probe')
    return { modelRoot, modelPath: null, mmprojPath: null, scratchRoot };
  if (!MODEL_ALIAS.test(input.modelAlias))
    throw new ManagedLocalRuntimeError('invalid_input', 'Invalid Managed Local model settings');
  const modelPath = await validateModelArtifactPath(input.modelPath, modelRoot, 'model');
  const mmprojPath =
    input.mmprojPath === undefined
      ? null
      : await validateModelArtifactPath(input.mmprojPath, modelRoot, 'mmproj');
  if (mmprojPath === modelPath)
    throw new ManagedLocalRuntimeError(
      'invalid_input',
      'Managed Local model and mmproj must differ',
    );
  return { modelRoot, modelPath, mmprojPath, scratchRoot };
}

async function validateModelArtifactPath(
  inputPath: string,
  modelRoot: string,
  label: 'model' | 'mmproj',
): Promise<string> {
  const lexicalInfo = await lstat(inputPath, { bigint: true }).catch(() => null);
  if (
    lexicalInfo === null ||
    !lexicalInfo.isFile() ||
    lexicalInfo.isSymbolicLink() ||
    lexicalInfo.nlink !== 1n
  )
    throw new ManagedLocalRuntimeError('invalid_input', `Managed Local ${label} is unsafe`);
  const artifactPath = await realpath(inputPath).catch(() => null);
  if (artifactPath === null || extname(artifactPath).toLowerCase() !== '.gguf')
    throw new ManagedLocalRuntimeError(
      'invalid_input',
      `Managed Local ${label} must be a GGUF file`,
    );
  const child = relative(modelRoot, artifactPath);
  if (child === '' || child.startsWith('..') || isAbsolute(child))
    throw new ManagedLocalRuntimeError('invalid_input', `Managed Local ${label} escaped its store`);
  const info = await lstat(artifactPath, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    lexicalInfo.dev !== info.dev ||
    lexicalInfo.ino !== info.ino
  )
    throw new ManagedLocalRuntimeError('invalid_input', `Managed Local ${label} is unsafe`);
  return artifactPath;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const lexical = await lstat(path, { bigint: true });
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error('unsafe');
    const canonical = await realpath(path);
    const resolved = await lstat(canonical, { bigint: true });
    if (
      !resolved.isDirectory() ||
      resolved.isSymbolicLink() ||
      lexical.dev !== resolved.dev ||
      lexical.ino !== resolved.ino
    )
      throw new Error('unsafe');
    return canonical;
  } catch {
    throw new ManagedLocalRuntimeError('invalid_input', `Managed Local ${label} is unsafe`);
  }
}

function runtimeArguments(
  input: ManagedLocalRuntimeStartInput,
  prepared: Readonly<{
    modelRoot: string;
    modelPath: string | null;
    mmprojPath: string | null;
    scratchRoot: string;
  }>,
  settings: EffectiveModelSettings | null,
): readonly string[] {
  const common = [
    '--host',
    LOOPBACK_HOST,
    '--port',
    '0',
    '--no-webui',
    '--no-slots',
    '--timeout',
    '120',
    '--parallel',
    '1',
    '--log-colors',
    'off',
    '--log-prefix',
    '--log-timestamps',
  ];
  if (input.kind === 'router_probe') return [...common, '--models-dir', prepared.modelRoot];
  if (settings === null)
    throw new ManagedLocalRuntimeError('invalid_input', 'Invalid Managed Local model settings');
  const args = [
    ...common,
    '--model',
    prepared.modelPath!,
    '--alias',
    input.modelAlias,
    '--ctx-size',
    String(settings.contextTokens),
    '--batch-size',
    String(settings.batchSize),
    '--ubatch-size',
    String(Math.min(settings.batchSize, 512)),
    '--n-gpu-layers',
    String(settings.gpuLayers),
    '--jinja',
  ];
  if (prepared.mmprojPath !== null) args.push('--mmproj', prepared.mmprojPath);
  return args;
}

function validateModelSettings(
  input: Extract<ManagedLocalRuntimeStartInput, { kind: 'model' }>,
  bundle: VerifiedManagedLocalSidecarBundle,
): EffectiveModelSettings {
  const validBackend = ['cpu', 'metal', 'cuda', 'vulkan'].includes(input.backend);
  if (
    !validBackend ||
    !bundle.manifest.candidateBackends.includes(input.backend) ||
    !Number.isInteger(input.contextTokens) ||
    input.contextTokens < 256 ||
    input.contextTokens > 1_048_576 ||
    !Number.isInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > 1_048_576 ||
    !Number.isInteger(input.gpuLayers) ||
    input.gpuLayers < 0 ||
    input.gpuLayers > 4_096 ||
    (input.backend === 'cpu' && input.gpuLayers !== 0) ||
    (input.backend !== 'cpu' && input.gpuLayers === 0)
  )
    throw new ManagedLocalRuntimeError('invalid_input', 'Invalid Managed Local model settings');
  return Object.freeze({
    backend: input.backend,
    gpuLayers: input.gpuLayers,
    contextTokens: input.contextTokens,
    batchSize: input.batchSize,
    runtimeVersion: bundle.manifest.runtimeVersion,
  });
}

export function managedLocalEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  token: string,
  scratchRoot: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LLAMA_API_KEY: token,
    LLAMA_CACHE: scratchRoot,
    TMP: scratchRoot,
    TEMP: scratchRoot,
    TMPDIR: scratchRoot,
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR'])
    if (source[key] !== undefined) environment[key] = source[key];
  return environment;
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const inside = (value: string): boolean =>
    value === '' || (!value.startsWith('..') && !isAbsolute(value));
  return inside(leftToRight) || inside(rightToLeft);
}

async function waitForListeningPort(
  active: ActiveRuntime,
  timeoutMs: number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (active.snapshot.state === 'crashed')
      throw new ManagedLocalRuntimeError('spawn_failed', 'Managed Local exited before listening');
    const match = LISTENING.exec(active.diagnostic.rawValue());
    if (match !== null) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
      throw new ManagedLocalRuntimeError('spawn_failed', 'Managed Local reported an invalid port');
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw new ManagedLocalRuntimeError('startup_timeout', 'Managed Local did not start listening');
}

function attachDiagnostics(stream: Readable | null, diagnostic: BoundedDiagnostic): void {
  stream?.on('data', (chunk: Buffer | string) => diagnostic.append(chunk));
}

class BoundedDiagnostic {
  private raw = '';

  constructor(private readonly secrets: readonly string[]) {}

  append(chunk: Buffer | string): void {
    this.raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    if (Buffer.byteLength(this.raw, 'utf8') > MAX_DIAGNOSTIC_BYTES)
      this.raw = this.raw.slice(-MAX_DIAGNOSTIC_BYTES);
  }

  rawValue(): string {
    return this.raw;
  }

  value(): string {
    let safe = this.raw;
    for (const secret of this.secrets) safe = safe.replaceAll(secret, '[REDACTED]');
    return safe.slice(-MAX_DIAGNOSTIC_BYTES);
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 10 * 60_000)
    throw new RangeError('Managed Local timeout is invalid');
  return resolved;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    if (child.exitCode !== null) {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(true);
    }
  });
}
