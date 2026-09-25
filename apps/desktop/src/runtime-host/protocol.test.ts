import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, createToolDefinition, createToolId } from '@sprint-coder/domain';
import {
  RUNTIME_PROTOCOL_VERSION,
  correlatedRuntimeStartRejection,
  isMainToRuntimeEnvelope,
  isRuntimeToMainEnvelope,
  runtimeWorkspaceSetFromLegacyPath,
} from './protocol';

function startEnvelope() {
  const payload = 'hello';
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: 'runtime-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    seq: 1,
    operationId: 'operation-1',
    type: 'start',
    input: 'hello',
    workspace: {
      primaryRootId: null,
      roots: [],
      digest: createHash('sha256').update('').digest('hex'),
    },
    model: 'auto',
    contextFragments: [],
    projectItems: [],
    projectSnapshotDigest: null,
    payload,
    payloadDigest: createHash('sha256').update(payload).digest('hex'),
    toolCatalogSnapshot: new ToolRegistry().createSnapshot({
      providerId: 'codex',
      workspaceId: null,
    }),
  } as const;
}

describe('Runtime Host protocol', () => {
  it('accepts only bounded runtime process identities with a stable start identity', () => {
    const valid = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'runtime_process',
      processIdentity: { pid: 123, parentPid: 12, startIdentity: 'platform-start-id' },
    } as const;

    expect(isRuntimeToMainEnvelope(valid)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...valid,
        processIdentity: { ...valid.processIdentity, pid: 0 },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...valid,
        processIdentity: { ...valid.processIdentity, startIdentity: '' },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...valid,
        processIdentity: { ...valid.processIdentity, startIdentity: 'x'.repeat(129) },
      }),
    ).toBe(false);
  });

  it('accepts only a non-empty unique canonical Team MCP tool subset', () => {
    const valid = {
      ...startEnvelope(),
      teamMcp: {
        socketPath: '/tmp/team.sock',
        token: '1234567890abcdef',
        guidance: 'team',
        toolNames: ['team_hire_worker'],
      },
    };
    expect(isMainToRuntimeEnvelope(valid)).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        teamMcp: { ...valid.teamMcp, toolNames: ['team_hire_worker', 'team_hire_worker'] },
      }),
    ).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        teamMcp: { ...valid.teamMcp, toolNames: ['unknown_tool'] },
      }),
    ).toBe(false);
  });
  it.runIf(process.platform === 'win32')(
    'keeps legacy Workspace identity stable across drive-letter casing',
    () => {
      const root = parseWin32DriveVariant(process.cwd());
      const canonical = runtimeWorkspaceSetFromLegacyPath(process.cwd());
      const variant = runtimeWorkspaceSetFromLegacyPath(root);
      expect(variant.primaryRootId).toBe(canonical.primaryRootId);
      expect(variant.digest).toBe(canonical.digest);
    },
  );
  it.runIf(process.platform === 'win32')(
    'rejects duplicate Runtime Workspace roots that differ only by drive-letter casing',
    () => {
      const valid = startEnvelope();
      const canonical = process.cwd();
      const variant = parseWin32DriveVariant(canonical);
      const workspace = {
        primaryRootId: 'root-a',
        roots: [
          { rootId: 'root-a', path: canonical, label: 'a', role: 'primary' },
          { rootId: 'root-b', path: variant, label: 'b', role: 'secondary' },
        ],
        digest: 'a'.repeat(64),
      } as const;

      expect(isMainToRuntimeEnvelope({ ...valid, workspace })).toBe(false);
    },
  );
  it('validates bounded same-directory image prepare and bound commit envelopes', () => {
    const selectionIdentity = 'a'.repeat(64);
    const manifestDigest = 'b'.repeat(64);
    const manifest = [
      {
        id: 'attachment-1',
        mimeType: 'image/png',
        byteLength: 128,
        sha256: 'c'.repeat(64),
      },
    ];
    const prepare = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'prepare_images',
      selectionIdentity,
      manifest,
      paths: [join(tmpdir(), 'turn-one', '001.png')],
      manifestDigest,
    } as const;
    expect(isMainToRuntimeEnvelope(prepare)).toBe(true);
    expect(isMainToRuntimeEnvelope({ ...prepare, paths: ['/tmp/001.jpg'] })).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...startEnvelope(),
        type: 'commit_images',
        selectionIdentity,
        manifestDigest,
      }),
    ).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId: 'runtime-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 1,
        operationId: 'operation-1',
        type: 'images_prepared',
        selectionIdentity,
        manifestDigest,
        decodedByteLength: 128,
      }),
    ).toBe(true);
  });

  it('requires a cryptographically valid explicit catalog for managed Runtime starts', () => {
    const valid = startEnvelope();
    expect(isMainToRuntimeEnvelope(valid)).toBe(true);
    expect(isMainToRuntimeEnvelope({ ...valid, toolCatalogSnapshot: undefined })).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        toolCatalogSnapshot: { ...valid.toolCatalogSnapshot, digest: '0'.repeat(64) },
      }),
    ).toBe(false);
  });

  it('rejects the removed Codex user-config policy field', () => {
    const valid = startEnvelope();
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        codexConfigPolicy: { inheritUserConfig: true },
      }),
    ).toBe(false);
  });

  it('accepts a valid non-empty managed catalog and rejects a modified digest', () => {
    const valid = startEnvelope();
    const registry = new ToolRegistry();
    registry.register(
      createToolDefinition({
        toolId: createToolId({
          provider: 'builtin',
          namespace: 'workspace',
          name: 'read',
          version: '1',
        }),
        providerName: 'read_file',
        kind: 'fileRead',
        schemaVersion: 1,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        sideEffect: 'read',
        risk: 'low',
        requiredCapabilities: ['workspace.read'],
        executionTarget: 'main',
        implementationKind: 'built-in',
        priority: 1,
        workspaceBinding: { kind: 'any' },
        providerCompatibility: ['*'],
      }),
    );
    const nonEmpty = registry.createSnapshot({ providerId: 'codex', workspaceId: 'workspace-1' });
    expect(isMainToRuntimeEnvelope({ ...valid, toolCatalogSnapshot: nonEmpty })).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        toolCatalogSnapshot: { ...nonEmpty, digest: '0'.repeat(64) },
      }),
    ).toBe(false);
  });

  it('validates bounded bidirectional managed tool envelopes', () => {
    const base = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 2,
      operationId: 'operation-1',
    } as const;
    expect(
      isRuntimeToMainEnvelope({
        ...base,
        type: 'tool_request',
        request: {
          callId: 'call-1',
          toolName: 'read_file',
          arguments: { path: 'README.md' },
          catalogDigest: 'a'.repeat(64),
        },
      }),
    ).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...base,
        type: 'tool_result',
        callId: 'call-1',
        success: true,
        output: { content: 'ok' },
      }),
    ).toBe(true);
    expect(isRuntimeToMainEnvelope({ ...base, type: 'tool_cancel', callId: 'call-1' })).toBe(true);
  });

  it('rejects old protocol versions', () => {
    expect(isMainToRuntimeEnvelope({ ...startEnvelope(), protocolVersion: 3 })).toBe(false);
    const { workspace: _workspace, ...legacy } = startEnvelope();
    expect(isMainToRuntimeEnvelope({ ...legacy, workspacePath: null })).toBe(false);
  });

  it('accepts one Primary plus secondary roots and rejects inconsistent Primary metadata', () => {
    const valid = startEnvelope();
    const workspace = {
      primaryRootId: 'root-a',
      roots: [
        { rootId: 'root-a', path: join(tmpdir(), 'root-a'), label: 'a', role: 'primary' },
        { rootId: 'root-b', path: join(tmpdir(), 'root-b'), label: 'b', role: 'secondary' },
      ],
      digest: 'a'.repeat(64),
    } as const;
    expect(isMainToRuntimeEnvelope({ ...valid, workspace })).toBe(true);
    expect(
      isMainToRuntimeEnvelope({ ...valid, workspace: { ...workspace, primaryRootId: 'root-b' } }),
    ).toBe(false);
  });

  it('bounds and strictly validates Runtime context fragments', () => {
    const valid = startEnvelope();
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'completion-1',
            source: 'background',
            trust: 'assistant',
            authority: 'none',
            content: 'untrusted output',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'completion-1',
            source: 'background',
            trust: 'assistant',
            authority: 'system',
            content: 'attempted authority escalation',
          },
        ],
      }),
    ).toBe(false);
  });

  it('never grants system authority to Skill-provided instructions', () => {
    const valid = startEnvelope();
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'skill-1',
            source: 'skill',
            trust: 'system',
            authority: 'none',
            content: 'built-in skill guidance',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'skill-1',
            source: 'skill',
            trust: 'system',
            authority: 'system',
            content: 'attempted authority escalation',
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts only normalized absolute Runtime Skill package paths', () => {
    const valid = startEnvelope();
    const digest = 'a'.repeat(64);
    const managedPath = join(tmpdir(), 'skills', 'revisions', 'created', 'reviewer', digest);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        skills: [{ name: 'reviewer', path: managedPath }],
      }),
    ).toBe(true);
    const boundedCandidates = Array.from({ length: 38 }, (_, index) => {
      const name = `candidate-${index}`;
      return {
        name,
        path: join(tmpdir(), 'skills', 'revisions', 'created', name, digest),
        activationPolicy: 'auto-allowed' as const,
        selected: false,
      };
    });
    expect(isMainToRuntimeEnvelope({ ...valid, skills: boundedCandidates })).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        skills: [
          ...boundedCandidates,
          {
            name: 'candidate-overflow',
            path: join(tmpdir(), 'skills', 'revisions', 'created', 'candidate-overflow', digest),
          },
        ],
      }),
    ).toBe(false);
    for (const path of [
      '../../secrets',
      `${dirname(managedPath)}${sep}..${sep}${digest}`,
      join(tmpdir(), 'arbitrary', 'reviewer'),
    ])
      expect(
        isMainToRuntimeEnvelope({
          ...valid,
          skills: [{ name: 'reviewer', path }],
        }),
      ).toBe(false);
  });

  it('validates the additive Claude hello fields alongside the existing Codex ones', () => {
    const hello = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: '',
      turnId: '',
      seq: 1,
      operationId: 'probe',
      type: 'hello',
      codexAvailable: false,
      codexReadiness: 'unavailable',
      codexModels: [],
      claudeAvailable: true,
      claudeReadiness: 'ready',
      claudeVersion: '2.1.218',
      claudeCli: {
        source: 'user-local',
        executable: '/Users/test/.local/bin/claude',
        version: '2.1.218 (Claude Code)',
        compatibility: 'verified',
        capabilities: ['version_probe', 'strict_mcp_config'],
      },
      claudeModels: [{ id: 'auto', displayName: 'Auto', description: '' }],
    };
    expect(isRuntimeToMainEnvelope(hello)).toBe(true);
    expect(isRuntimeToMainEnvelope({ ...hello, claudeAvailable: 'yes' })).toBe(false);
    expect(isRuntimeToMainEnvelope({ ...hello, claudeModels: undefined })).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...hello,
        claudeCli: { ...hello.claudeCli, capabilities: ['invalid-capability'] },
      }),
    ).toBe(false);
  });

  it('validates the additive optional Claude effort field on start envelopes', () => {
    const valid = startEnvelope();
    expect(isMainToRuntimeEnvelope(valid)).toBe(true);
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
      expect(isMainToRuntimeEnvelope({ ...valid, effort })).toBe(true);
    }
    for (const effort of ['', 'invalid effort', 'a'.repeat(65)]) {
      expect(isMainToRuntimeEnvelope({ ...valid, effort })).toBe(false);
    }
    expect(isMainToRuntimeEnvelope({ ...valid, effort: 5 })).toBe(false);
  });

  it('accepts legacy hello but requires a complete, bounded Grok capability when present', () => {
    const legacy = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-grok',
      taskId: '',
      turnId: '',
      seq: 1,
      operationId: 'hello',
      type: 'hello',
      codexAvailable: false,
      codexReadiness: 'unavailable',
      codexModels: [],
      claudeAvailable: false,
      claudeReadiness: 'unavailable',
      claudeModels: [],
    };
    const grok = {
      grokAvailable: true,
      grokReadiness: 'ready',
      grokModels: [{ id: 'grok-code-fast-1', displayName: 'Grok', description: '' }],
      grokVersion: 'grok 1.0.40 (eb1a2256660d) [stable]',
      grokCli: {
        source: 'path',
        executable: '/usr/local/bin/grok',
        version: 'grok 1.0.0 (abcdef1)',
        compatibility: 'verified',
        capabilities: ['version_probe'],
      },
    };
    expect(isRuntimeToMainEnvelope(legacy)).toBe(true);
    expect(isRuntimeToMainEnvelope({ ...legacy, ...grok })).toBe(true);
    for (const field of Object.keys(grok)) {
      expect(isRuntimeToMainEnvelope({ ...legacy, [field]: Reflect.get(grok, field) })).toBe(false);
    }
    for (const invalid of [
      { grokAvailable: 'yes' },
      { grokReadiness: 'unknown' },
      { grokModels: undefined },
      { grokModels: Array.from({ length: 33 }, () => grok.grokModels[0]) },
      { grokModels: [{ id: 'invalid model id' }] },
      { grokVersion: 'grok 1.0.0\n/private/request' },
      { grokVersion: 'grok 1.0.0 (' + 'a'.repeat(128) + ')' },
      { grokCli: { ...grok.grokCli, capabilities: ['invalid-capability'] } },
      { grokProbeStopUnconfirmed: false },
      { grokProbeStopUnconfirmed: 'true' },
    ]) {
      expect(isRuntimeToMainEnvelope({ ...legacy, ...grok, ...invalid })).toBe(false);
    }
    // Issue #581: the probe's stop uncertainty travels beside, not instead of, its readiness.
    expect(isRuntimeToMainEnvelope({ ...legacy, ...grok, grokProbeStopUnconfirmed: true })).toBe(
      true,
    );
  });

  it('accepts catalog-defined Codex effort levels including ultra', () => {
    for (const effort of ['none', 'ultra', 'future_level-2']) {
      expect(isMainToRuntimeEnvelope({ ...startEnvelope(), effort })).toBe(true);
    }
  });

  it('accepts only bounded structured diagnostics on Runtime errors', () => {
    const error = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'error',
      error: { code: 'RUNTIME_FAILED', userMessage: 'failed', retryable: true },
      diagnostic: {
        version: 1,
        diagnosticId: '123e4567-e89b-42d3-a456-426614174000',
        runtimeKind: 'codex',
        failureStage: 'abnormal_exit',
        elapsedMs: 123,
        appVersion: '0.2.1',
        cliVersion: 'codex 1.0.0',
        capabilityMismatch: {
          missingTools: ['mcp__team__team_hire_worker'],
          unexpectedTools: ['mcp__team__skill_draft_create'],
        },
        cliResolution: {
          source: 'npm',
          executable: '<home>/.npm/bin/codex',
          version: 'codex 1.0.0',
          compatibility: 'compatible',
          capabilities: ['version_probe', 'app_server'],
        },
        teamMcp: { enabled: false, status: 'not_configured' },
        lastRecognizedNotification: 'turn/started',
        lastReceivedNotification: '[unsupported]',
        unsupportedNotificationCount: 1,
        stderrObserved: true,
        stderrTruncated: false,
        recordedAt: new Date().toISOString(),
      },
    };

    expect(isRuntimeToMainEnvelope(error)).toBe(true);
    for (const cliVersion of [null, 'grok 1.0.0', 'grok 1.0.0 (abcdef1)']) {
      expect(
        isRuntimeToMainEnvelope({
          ...error,
          diagnostic: { ...error.diagnostic, runtimeKind: 'grok', cliVersion },
        }),
      ).toBe(true);
    }
    for (const cliVersion of [
      'codex 1.0.0',
      'grok 1.0.0\n/private/request',
      'grok 1.0.0 (secret-token)',
      'a'.repeat(129),
    ]) {
      expect(
        isRuntimeToMainEnvelope({
          ...error,
          diagnostic: { ...error.diagnostic, runtimeKind: 'grok', cliVersion },
        }),
      ).toBe(false);
    }
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: {
          ...error.diagnostic,
          capabilityMismatch: { missingTools: ['/Users/alice'], unexpectedTools: [] },
        },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: {
          ...error.diagnostic,
          codexIsolation: {
            userConfigSnapshot: 'copied',
            selectedSkillCount: 2,
            disabledUnexpectedSkillCount: 3,
            verified: true,
          },
        },
      }),
    ).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, cliVersion: 'codex /Users/alice/private' },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, failureStage: 'made_up' },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, requestBody: 'must never cross' },
      }),
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, appVersion: cyclic },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, elapsedMs: 1n },
      }),
    ).toBe(false);
  });

  it('accepts Grok billing and rate-limit diagnostics and rejects them on other runtimes', () => {
    const base = {
      version: 1,
      diagnosticId: '123e4567-e89b-42d3-a456-426614174000',
      runtimeKind: 'grok',
      failureStage: 'billing_error',
      httpStatus: 402,
      elapsedMs: 10,
      appVersion: '0.7.0',
      cliVersion: 'grok 1.0.0',
      teamMcp: { enabled: false, status: 'not_configured' },
      lastRecognizedNotification: null,
      lastReceivedNotification: null,
      unsupportedNotificationCount: 0,
      stderrObserved: false,
      stderrTruncated: false,
      recordedAt: '2026-09-23T00:00:00.000Z',
    };
    const envelope = (
      diagnostic: Record<string, unknown>,
      code: 'RUNTIME_BILLING_REQUIRED' | 'RUNTIME_RATE_LIMIT' = 'RUNTIME_BILLING_REQUIRED',
    ) => ({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'error',
      error: {
        code,
        userMessage:
          code === 'RUNTIME_BILLING_REQUIRED'
            ? 'Grok Buildの利用残高が不足しています。残高を追加してから再試行してください。'
            : 'Grokの利用上限に達しました。時間を置いて再試行してください。',
        retryable: code !== 'RUNTIME_BILLING_REQUIRED',
      },
      diagnostic,
    });
    const { httpStatus: _status, ...withoutStatus } = base;
    expect(isRuntimeToMainEnvelope(envelope(base))).toBe(true);
    expect(
      isRuntimeToMainEnvelope(envelope({ ...withoutStatus }, 'RUNTIME_BILLING_REQUIRED')),
    ).toBe(true);
    expect(
      isRuntimeToMainEnvelope(
        envelope({ ...base, failureStage: 'rate_limit', httpStatus: 429 }, 'RUNTIME_RATE_LIMIT'),
      ),
    ).toBe(true);
    expect(
      isRuntimeToMainEnvelope(
        envelope({ ...withoutStatus, failureStage: 'rate_limit' }, 'RUNTIME_RATE_LIMIT'),
      ),
    ).toBe(true);
    for (const status of [100, 599]) {
      expect(isRuntimeToMainEnvelope(envelope({ ...base, httpStatus: status }))).toBe(true);
    }
    for (const diagnostic of [
      { ...base, runtimeKind: 'codex', cliVersion: 'codex 1.0.0', failureStage: 'protocol_error' },
      { ...withoutStatus, runtimeKind: 'codex', cliVersion: 'codex 1.0.0' },
      {
        ...withoutStatus,
        runtimeKind: 'claude',
        cliVersion: '2.1.218 (Claude Code)',
        failureStage: 'rate_limit',
      },
      {
        ...base,
        runtimeKind: 'claude',
        cliVersion: '2.1.218 (Claude Code)',
        failureStage: 'protocol_error',
        httpStatus: 429,
      },
      { ...base, httpStatus: 99 },
      { ...base, httpStatus: 600 },
      { ...base, httpStatus: 402.5 },
      { ...base, httpStatus: '402' },
      { ...base, httpStatus: null },
      { ...base, failureStage: ['billing_error'] },
      {
        ...withoutStatus,
        runtimeKind: 'codex',
        cliVersion: 'codex 1.0.0',
        failureStage: ['billing_error'],
      },
      {
        ...withoutStatus,
        runtimeKind: 'claude',
        cliVersion: '2.1.218 (Claude Code)',
        failureStage: ['protocol_error'],
      },
    ]) {
      expect(isRuntimeToMainEnvelope(envelope(diagnostic))).toBe(false);
    }
    // Controls for the rejections above: the same Codex/Claude shapes pass once the Grok-only
    // stage and status are removed, so the rejections are about those fields and nothing else.
    for (const diagnostic of [
      {
        ...withoutStatus,
        runtimeKind: 'codex',
        cliVersion: 'codex 1.0.0',
        failureStage: 'protocol_error',
      },
      {
        ...withoutStatus,
        runtimeKind: 'claude',
        cliVersion: '2.1.218 (Claude Code)',
        failureStage: 'protocol_error',
      },
    ]) {
      expect(isRuntimeToMainEnvelope(envelope(diagnostic))).toBe(true);
    }
    // A billing failure whose process stop was not confirmed still reaches Main: the public
    // error becomes RUNTIME_STOP_UNCONFIRMED while the diagnostic keeps the billing stage.
    expect(
      isRuntimeToMainEnvelope({
        ...envelope(base),
        error: {
          code: 'RUNTIME_STOP_UNCONFIRMED',
          userMessage: 'Grok CLIの停止を確認できませんでした。',
          retryable: false,
        },
      }),
    ).toBe(true);
  });

  it('validates the additive optional resolvedModel field on the completed canonical event', () => {
    const event = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'event',
      event: { type: 'completed' },
    };
    expect(isRuntimeToMainEnvelope(event)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { type: 'completed', resolvedModel: 'claude-sonnet-5' },
      }),
    ).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { type: 'completed', finalText: 'ユーザー向けの結論です。' },
      }),
    ).toBe(true);
    expect(
      isRuntimeToMainEnvelope({ ...event, event: { type: 'completed', resolvedModel: '' } }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({ ...event, event: { type: 'completed', resolvedModel: 42 } }),
    ).toBe(false);
    expect(isRuntimeToMainEnvelope({ ...event, event: { type: 'completed', finalText: '' } })).toBe(
      false,
    );
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { type: 'completed', finalText: 'x'.repeat(1_000_001) },
      }),
    ).toBe(false);
  });

  it('strictly validates command and tool operation progress events', () => {
    const event = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'event',
      event: {
        type: 'operation',
        phase: 'command_start',
        label: 'Codex command started',
      },
    };
    expect(isRuntimeToMainEnvelope(event)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { ...event.event, phase: 'command_output' },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { ...event.event, label: '' },
      }),
    ).toBe(false);
  });

  it('accepts only bounded unique context acknowledgements', () => {
    const base = startEnvelope();
    const started = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: base.runtimeInstanceId,
      taskId: base.taskId,
      turnId: base.turnId,
      seq: 1,
      operationId: base.operationId,
      type: 'started',
      acceptedContextFragmentIds: ['completion-1'],
      acceptedProjectItemIds: [],
      acceptedProjectSnapshotDigest: null,
      acceptedPayloadDigest: base.payloadDigest,
    };
    expect(isRuntimeToMainEnvelope(started)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...started,
        acceptedContextFragmentIds: ['completion-1', 'completion-1'],
      }),
    ).toBe(false);
  });

  it('rejects payload tampering and forged Project authority', () => {
    const valid = startEnvelope();
    expect(isMainToRuntimeEnvelope({ ...valid, payload: 'tampered' })).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        projectItems: [
          {
            id: 'reference-1',
            kind: 'reference',
            authority: 'user',
            localOnly: false,
            sealedDigest: 'a'.repeat(64),
            content: 'data',
          },
        ],
      }),
    ).toBe(false);

    const assistantMemory = {
      id: 'memory-1',
      kind: 'memory' as const,
      authority: 'none' as const,
      localOnly: false,
      sealedDigest: 'b'.repeat(64),
      content: 'AIがProjectへ保存したMemory',
    };
    expect(isMainToRuntimeEnvelope({ ...valid, projectItems: [assistantMemory] })).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        projectItems: [{ ...assistantMemory, kind: 'instruction' }],
      }),
    ).toBe(false);
  });

  it('classifies only bounded correlated start rejection metadata', () => {
    const valid = startEnvelope();
    expect(correlatedRuntimeStartRejection(valid, valid.runtimeInstanceId)).toBeNull();
    const forged = {
      ...valid,
      projectItems: [
        {
          id: 'instruction-1',
          kind: 'instruction',
          authority: 'none',
          localOnly: false,
          sealedDigest: 'a'.repeat(64),
          content: 'MEMORY_CANARY_182 /absolute/canary-182',
        },
      ],
    };
    const rejection = correlatedRuntimeStartRejection(forged, valid.runtimeInstanceId);
    expect(rejection).toEqual({
      taskId: valid.taskId,
      turnId: valid.turnId,
      operationId: valid.operationId,
      rejection: {
        reasonCode: 'invalid_project_context_authority',
        itemKind: 'instruction',
        authority: 'none',
      },
    });
    expect(JSON.stringify(rejection)).not.toContain('MEMORY_CANARY_182');
    expect(JSON.stringify(rejection)).not.toContain('/absolute/canary-182');
    expect(
      correlatedRuntimeStartRejection(
        { ...valid, operationId: 'unsafe operation id', projectItems: forged.projectItems },
        valid.runtimeInstanceId,
      ),
    ).toBeNull();
    expect(
      correlatedRuntimeStartRejection(
        { ...valid, runtimeInstanceId: 'other-runtime' },
        valid.runtimeInstanceId,
      ),
    ).toMatchObject({ rejection: { reasonCode: 'runtime_instance_mismatch' } });
    expect(
      correlatedRuntimeStartRejection({ ...valid, payload: 'tampered' }, valid.runtimeInstanceId),
    ).toMatchObject({ rejection: { reasonCode: 'invalid_payload_digest' } });
    expect(
      correlatedRuntimeStartRejection(
        { ...valid, payload: 'x'.repeat(512 * 1024 + 1) },
        valid.runtimeInstanceId,
      ),
    ).toMatchObject({ rejection: { reasonCode: 'invalid_runtime_start_envelope' } });
    expect(
      correlatedRuntimeStartRejection(
        { ...valid, projectItems: Array.from({ length: 257 }, () => null) },
        valid.runtimeInstanceId,
      ),
    ).toMatchObject({ rejection: { reasonCode: 'invalid_runtime_start_envelope' } });
  });

  it('enforces combined Project protocol count and UTF-8 byte budgets', () => {
    const valid = startEnvelope();
    const fragments = Array.from({ length: 255 }, (_, index) => ({
      id: `fragment-${index}`,
      source: 'history' as const,
      trust: 'user' as const,
      authority: 'user' as const,
      content: '',
    }));
    const projectItem = {
      id: 'project-instruction',
      kind: 'instruction' as const,
      authority: 'user' as const,
      localOnly: false,
      sealedDigest: 'a'.repeat(64),
      content: 'あ'.repeat(Math.floor((64 * 1024) / 3)),
    };
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: fragments,
        projectItems: [projectItem],
      }),
    ).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [...fragments, { ...fragments[0]!, id: 'fragment-256' }],
        projectItems: [projectItem],
      }),
    ).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        projectItems: [{ ...projectItem, content: 'あ'.repeat(Math.floor((64 * 1024) / 3) + 1) }],
      }),
    ).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'large-fragment',
            source: 'history',
            trust: 'user',
            authority: 'user',
            content: 'x'.repeat(64 * 1024),
          },
        ],
        projectItems: [{ ...projectItem, content: `y${'x'.repeat(64 * 1024 - 1)}` }],
      }),
    ).toBe(true);
  });
});

function parseWin32DriveVariant(path: string): string {
  const first = path[0];
  if (first === undefined) return path;
  const toggled = first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase();
  return `${toggled}${path.slice(1)}`;
}
