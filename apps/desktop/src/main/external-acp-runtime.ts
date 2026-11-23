import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import desktopPackage from '../../package.json';
import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
} from '@sprint-coder/contracts';
import { AcpClient, acpRecord } from '../runtime-host/acp-client';
import { spawnOwnedCliProcess, stopOwnedCliProcess } from '../runtime-host/owned-cli-process';
import { terminateRuntimeProcessTree } from '../runtime-host/process-tree';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import {
  prepareExternalAcpProfile,
  resolveExternalAcpCli,
  type ExternalAcpAgent,
} from './external-acp-profile';

type ModelChoice = { id: string; name: string };
type ModelSelection = {
  configId: string | null;
  current: string | undefined;
  choices: ModelChoice[];
};
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return acpRecord(value);
}

function modelChoices(options: unknown): ModelChoice[] {
  if (!Array.isArray(options)) return [];
  const result: ModelChoice[] = [];
  const pending: unknown[] = [...options];
  for (let i = 0; i < pending.length && i < 2000 && result.length < 512; i += 1) {
    const option = record(pending[i]);
    if (option === undefined) continue;
    if (Array.isArray(option['options'])) pending.push(...option['options'].slice(0, 512));
    const value = option['value'] ?? option['modelId'];
    if (typeof value !== 'string' || value.length < 1 || value.length > 128) continue;
    const name = typeof option['name'] === 'string' ? option['name'].slice(0, 256) : value;
    if (!result.some(({ id }) => id === value)) result.push({ id: value, name: name || value });
  }
  return result;
}

function sessionModels(session: JsonRecord): ModelSelection {
  const config = Array.isArray(session['configOptions'])
    ? session['configOptions']
        .map(record)
        .find((option) => option?.['category'] === 'model' || option?.['id'] === 'model')
    : undefined;
  const legacy = record(session['models']);
  if (typeof config?.['id'] === 'string')
    return {
      configId: config['id'],
      current: typeof config['currentValue'] === 'string' ? config['currentValue'] : undefined,
      choices: modelChoices(config['options']),
    };
  return {
    configId: null,
    current: typeof legacy?.['currentModelId'] === 'string' ? legacy['currentModelId'] : undefined,
    choices: modelChoices(legacy?.['availableModels']),
  };
}

class ExternalAcpError extends Error {
  constructor(readonly code: string) {
    super('External agent connection failed');
  }
}

export class ExternalAcpRuntime implements ProviderRuntime {
  private readonly active = new Map<
    string,
    { controller: AbortController; stopped: Promise<void> }
  >();
  private readonly unconfirmedExecutions = new Set<string>();
  private readonly probes = new Map<AbortController, Promise<readonly ProviderModel[]>>();
  private disposed = false;
  private quarantined = false;

  constructor(
    private readonly agent: ExternalAcpAgent,
    private readonly antigravityHome: string,
  ) {}

  async verify(
    connection: ProviderConnection,
    signal: AbortSignal,
    signIn = false,
  ): Promise<ProviderVerificationResult> {
    let message: string | null = null;
    let status: ProviderVerificationResult['status'] = 'unavailable';
    try {
      const models = await this.listModels(connection, signal, signIn);
      if (models.length > 0) status = 'verified';
      else message = `${this.agent.name} CLI の利用可能なモデルがありません。`;
    } catch (error) {
      const code = error instanceof ExternalAcpError ? error.code : 'unavailable';
      if (code === 'authentication_required') status = 'invalid_credentials';
      message =
        code === 'cli_missing'
          ? `${this.agent.name} の公式 CLI をインストールしてください。`
          : code === 'unsupported_cli_version'
            ? 'OpenCode CLI 2.2.3 以上のバージョン 2 が必要です。'
            : code === 'authentication_required'
              ? `${this.agent.name} CLI にログインしてください。`
              : `${this.agent.name} CLI の接続を確認できませんでした。`;
    }
    return {
      status,
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      message,
    };
  }

  listModels(
    connection: ProviderConnection,
    signal: AbortSignal,
    signIn = false,
  ): Promise<readonly ProviderModel[]> {
    const controller = new AbortController();
    const probe = this.discoverModels(
      connection,
      AbortSignal.any([signal, controller.signal]),
      signIn,
    );
    this.probes.set(controller, probe);
    return probe.finally(() => this.probes.delete(controller));
  }

  private async discoverModels(
    connection: ProviderConnection,
    signal: AbortSignal,
    signIn = false,
  ): Promise<readonly ProviderModel[]> {
    this.assertConnection(connection);
    const session = await this.open(signal, undefined, signIn);
    try {
      const checkedAt = new Date().toISOString();
      const unknown = { value: null, source: 'unknown' } as const;
      return session.models.choices.map(({ id, name }) => ({
        connectionId: connection.id,
        providerId: connection.providerId,
        connectionDisplayName: connection.displayName,
        providerDisplayName: this.agent.name,
        modelId: id,
        displayName: name,
        available: true,
        availabilityCheckedAt: checkedAt,
        contextWindow: unknown,
        maxOutputTokens: unknown,
        toolCalling: { value: false, source: 'unknown' },
        structuredOutput: { value: false, source: 'unknown' },
        multimodalInput: { value: false, source: 'unknown' },
        reasoning: unknown,
      }));
    } finally {
      await session.close();
    }
  }

  async *execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    externalSignal: AbortSignal,
  ): AsyncIterable<CanonicalProviderEvent> {
    this.assertConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id || this.active.has(parsed.executionId))
      throw new ExternalAcpError('invalid_request');
    const controller = new AbortController();
    const signal = AbortSignal.any([externalSignal, controller.signal]);
    const output = new PassThrough({ objectMode: true });
    const run = this.prompt(
      parsed,
      signal,
      (event) => {
        if (!output.destroyed) output.write(event);
      },
      () => this.unconfirmedExecutions.add(parsed.executionId),
    ).finally(() => output.end());
    this.active.set(parsed.executionId, { controller, stopped: run });
    try {
      for await (const event of output as AsyncIterable<CanonicalProviderEvent>) yield event;
    } finally {
      controller.abort();
      await run;
      this.active.delete(parsed.executionId);
    }
  }

  async cancel(executionId: string): Promise<void> {
    const active = this.active.get(executionId);
    active?.controller.abort();
    await active?.stopped;
    if (this.unconfirmedExecutions.has(executionId)) throw new ExternalAcpError('stop_unconfirmed');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const { controller } of this.active.values()) controller.abort();
    for (const controller of this.probes.keys()) controller.abort();
    await Promise.allSettled([
      ...[...this.active.values()].map(({ stopped }) => stopped),
      ...this.probes.values(),
    ]);
  }

  private assertConnection(connection: ProviderConnection): void {
    if (
      connection.id !== this.agent.connectionId ||
      connection.providerId !== this.agent.providerId
    )
      throw new ExternalAcpError('invalid_connection');
  }

  private async prompt(
    request: ProviderExecutionRequest,
    signal: AbortSignal,
    emit: (event: CanonicalProviderEvent) => void,
    onStopUnconfirmed: () => void,
  ): Promise<void> {
    let session: Awaited<ReturnType<ExternalAcpRuntime['open']>> | undefined;
    let textReceived = false;
    try {
      if (
        request.tools?.length ||
        request.messages.some(
          (message) =>
            message.role === 'tool' || message.inlineImages?.length || message.toolCalls?.length,
        )
      )
        throw new ExternalAcpError('chat_only');
      session = await this.open(
        signal,
        (text) => {
          if (signal.aborted || text === '') return;
          textReceived = true;
          emit({ type: 'output_delta', text });
        },
        false,
        onStopUnconfirmed,
      );
      const { sessionId, models, rpc } = session;
      if (!models.choices.some(({ id }) => id === request.modelId))
        throw new ExternalAcpError('model_not_available');
      if (models.current !== request.modelId) {
        if (models.configId === null) {
          await rpc.request('session/set_model', { sessionId, modelId: request.modelId });
        } else {
          const selected = acpRecord(
            await rpc.request('session/set_config_option', {
              sessionId,
              configId: models.configId,
              value: request.modelId,
            }),
          );
          if (sessionModels(selected).current !== request.modelId)
            throw new ExternalAcpError('model_not_confirmed');
        }
      }
      signal.throwIfAborted();
      const result = acpRecord(
        await rpc.request(
          'session/prompt',
          {
            sessionId,
            prompt: [
              {
                type: 'text',
                text: request.messages
                  .map(({ role, content }) => `[${role}]\n${content}`)
                  .join('\n\n'),
              },
            ],
          },
          180_000,
        ),
      );
      signal.throwIfAborted();
      if (result['stopReason'] !== 'end_turn' || !textReceived)
        throw new ExternalAcpError('incomplete_response');
      // Confirm process-tree shutdown before the Turn can complete.
      await session.close();
      emit({
        type: 'resolution',
        resolution: { resolvedProvider: this.agent.providerId, resolvedModel: request.modelId },
      });
      emit({ type: 'completed', stopReason: 'end_turn' });
    } catch (error) {
      const cleanupError = await session?.close().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      const failure = cleanupError ?? error;
      const code = failure instanceof ExternalAcpError ? failure.code : 'unavailable';
      const stopUnconfirmed = code === 'stop_unconfirmed';
      const canceled = signal.aborted && !stopUnconfirmed;
      const auth = code === 'authentication_required';
      const rateLimited = code === 'free_limit';
      const invalid =
        code === 'chat_only' || code === 'model_not_available' || code === 'model_not_confirmed';
      emit({
        type: 'error',
        error: {
          category: canceled
            ? 'canceled'
            : auth
              ? 'credentials'
              : rateLimited
                ? 'rate_limited'
                : invalid
                  ? 'invalid_request'
                  : 'provider_unavailable',
          message: canceled
            ? 'チャットを停止しました。'
            : stopUnconfirmed
              ? 'CLI の停止を確認できませんでした。アプリを再起動してから再試行してください。'
              : code === 'chat_only'
                ? 'この接続は通常のテキストチャットに対応しています。'
                : auth
                  ? `${this.agent.name} CLI でログインしてください。`
                  : rateLimited
                    ? 'OpenCode の無料利用上限に達しました。別の無料モデルを選ぶか、上限が回復してから再試行してください。'
                    : invalid
                      ? `${this.agent.name} で選択モデルを確認できませんでした。`
                      : `${this.agent.name} CLI との接続を完了できませんでした。`,
          retryable: false,
          retryAfterMs: null,
          providerCode: code,
        },
      });
    }
  }

  private async open(
    signal: AbortSignal,
    receive?: (text: string) => void,
    signIn = false,
    onStopUnconfirmed?: () => void,
  ) {
    signal.throwIfAborted();
    if (this.disposed || this.quarantined) throw new ExternalAcpError('unavailable');
    const executable = resolveExternalAcpCli(this.agent);
    if (executable === undefined) throw new ExternalAcpError('cli_missing');
    const profile = prepareExternalAcpProfile(this.agent, this.antigravityHome);
    let child: ReturnType<typeof spawnOwnedCliProcess>;
    try {
      const argv =
        this.agent.providerId === 'opencode'
          ? ['--print-logs', 'acp']
          : [
              'acp',
              '--disable-telemetry',
              '--include-default-customizations=false',
              '--log-file',
              join(profile.cwd, 'agy.log'),
            ];
      child = spawnOwnedCliProcess(
        executable,
        argv,
        {
          cwd: profile.cwd,
          env: profile.env,
          detached: process.platform !== 'win32',
        },
        () => undefined,
      );
    } catch (error) {
      await profile.cleanup();
      throw error;
    }
    child.stderr.resume();
    let sessionId: string | null = null;
    let stop: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (stop ??= (async () => {
        signal.removeEventListener('abort', abort);
        rpc.close();
        const confirmed = await (
          stopOwnedCliProcess(child) ?? terminateRuntimeProcessTree(child, process.env)
        ).catch(() => false);
        if (!confirmed) {
          this.quarantined = true;
          onStopUnconfirmed?.();
          throw new ExternalAcpError('stop_unconfirmed');
        }
        await profile.cleanup();
      })());
    const abort = () => {
      if (sessionId !== null) rpc.notification('session/cancel', { sessionId });
      void close().catch(() => undefined);
    };
    const rpc = new AcpClient(
      child,
      (method, value) => {
        if (method !== 'session/update' || sessionId === null) return;
        const params = record(value);
        if (params?.['sessionId'] !== sessionId) return;
        const update = record(params['update']);
        const kind = update?.['sessionUpdate'];
        if (
          (kind === 'tool_call' || kind === 'tool_call_update') &&
          update?.['status'] === 'completed'
        )
          throw new ExternalAcpError('unexpected_native_tool');
        if (kind !== 'agent_message_chunk') return;
        const content = record(update?.['content']);
        if (content?.['type'] === 'text' && typeof content['text'] === 'string')
          receive?.(content['text']);
      },
      () => void close().catch(() => undefined),
      {
        failure: (code) => new ExternalAcpError(code),
        isProtocolFailure: (error): error is ExternalAcpError => error instanceof ExternalAcpError,
        response: (code, _message, data) =>
          new ExternalAcpError(
            code === -32000
              ? 'authentication_required'
              : record(data)?.['errorName'] === 'provider.free-limit'
                ? 'free_limit'
                : 'rpc_error',
          ),
      },
    );
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const initialized = acpRecord(
        await rpc.request(
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'Sprint Coder', version: desktopPackage.version },
          },
          10_000,
        ),
      );
      if (initialized['protocolVersion'] !== 1) throw new ExternalAcpError('unsupported_protocol');
      // Tool, MCP and plugin denial use the OpenCode v2.2.3+ policy schema.
      if (this.agent.providerId === 'opencode') {
        const version = record(initialized['agentInfo'])?.['version'];
        const match = typeof version === 'string' ? /^2\.(\d+)\.(\d+)$/.exec(version) : null;
        if (
          match === null ||
          Number(match[1]) < 2 ||
          (Number(match[1]) === 2 && Number(match[2]) < 3)
        )
          throw new ExternalAcpError('unsupported_cli_version');
      }
      const createSession = () =>
        rpc.request('session/new', { cwd: profile.cwd, mcpServers: [] }, 15_000);
      let session: JsonRecord;
      try {
        session = acpRecord(await createSession());
      } catch (error) {
        if (
          !signIn ||
          this.agent.providerId !== 'antigravity' ||
          !(error instanceof ExternalAcpError) ||
          error.code !== 'authentication_required'
        )
          throw error;
        const methods = initialized['authMethods'];
        if (
          !Array.isArray(methods) ||
          !methods.some((method) => record(method)?.['id'] === 'oauth-personal')
        )
          throw error;
        await rpc.request('authenticate', { methodId: 'oauth-personal' }, 120_000);
        session = acpRecord(await createSession());
      }
      if (typeof session['sessionId'] !== 'string' || session['sessionId'].length === 0)
        throw new ExternalAcpError('invalid_session');
      sessionId = session['sessionId'];
      const models = sessionModels(session);
      if (this.agent.providerId === 'antigravity')
        models.choices = models.choices.filter(
          ({ id }) => id.startsWith('gemini-') && !id.includes('orchestrator'),
        );
      return { rpc, sessionId, models, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
