import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderExecutionRequest } from '@sprint-coder/contracts';
import {
  MANAGED_LOCAL_CONNECTION_ID,
  MANAGED_LOCAL_PROVIDER_ID,
  managedLocalConnection,
} from './managed-local-provider-runtime';
import { MainProviderRegistry, type ProviderRuntime } from './provider-runtime';
import type { ProviderVerificationService } from './provider-verification';
import { ProviderAwareTeamWorkerRuntime } from './provider-team-worker-runtime';
import type { TeamWorkerRuntime } from './team-coordinator';
import type { RuntimeWorkspaceSet } from '../runtime-host/protocol';

/** The Managed Local model a fixture Worker is hired with. */
export const MANAGED_LOCAL_FIXTURE_SELECTION = Object.freeze({
  connectionId: MANAGED_LOCAL_CONNECTION_ID,
  requestedProvider: MANAGED_LOCAL_PROVIDER_ID,
  requestedModel: 'a'.repeat(64),
});

/** What one execution asked Main's managed catalog for, and the tools it was handed. */
export type ManagedLocalFixtureSession = Readonly<{
  workerId: string;
  writeCapable: boolean;
  workspaceSet: RuntimeWorkspaceSet;
  tools: readonly string[];
}>;

/** One managed tool call the fixture carried out, with the real file it read or wrote. */
export type ManagedLocalFixtureToolCall = Readonly<{
  workerId: string;
  name: string;
  file: string;
}>;

const READ_TOOLS = ['read_file'] as const;
const WRITE_TOOLS = ['create_file'] as const;
const CRITERIA_HEADING = '完了条件（Leaderが決めたものです。番号で報告してください）:';

/**
 * A Managed Local Worker run by the real `ProviderAwareTeamWorkerRuntime`, for Team tests that drive
 * one through TeamCoordinator (issue #570). A Worker without a Connection goes to `fallback`, where
 * the CLI runtime sits in the app. (`computer-use-grant-fixture.ts` is the precedent for a shared
 * fixture module that Vitest does not collect.)
 *
 * `prepareManagedTools` stands in for Main's managed catalog (`buildWorkerManagedCatalog` in
 * ipc.ts) with the same rule — reading tools only over a Workspace, writing tools only for a
 * write-capable Worker — and carries each call out on the real files of the Primary root it was
 * handed. The model uses what it is handed: it creates `writePath` when it has a writing tool,
 * otherwise reads `readPath` when it has a reading tool, and then reports every done criterion done.
 */
export function managedLocalTeamWorkerRuntime(options: {
  fallback: TeamWorkerRuntime;
  readPath?: string;
  writePath?: string;
}): {
  runtime: ProviderAwareTeamWorkerRuntime;
  sessions: ManagedLocalFixtureSession[];
  toolCalls: ManagedLocalFixtureToolCall[];
} {
  const readPath = options.readPath ?? 'README.md';
  const writePath = options.writePath ?? 'managed-output.txt';
  const sessions: ManagedLocalFixtureSession[] = [];
  const toolCalls: ManagedLocalFixtureToolCall[] = [];
  const connection = managedLocalConnection();
  const provider: ProviderRuntime = {
    verify: () => Promise.reject(new Error('The Managed Local fixture verifies nothing')),
    listModels: () => Promise.reject(new Error('The Managed Local fixture lists no models')),
    cancel: async () => undefined,
    async *execute(_connection, request) {
      const toolsUsed = request.messages.some(({ role }) => role === 'tool');
      const handed = new Set((request.tools ?? []).map(({ name }) => name));
      if (!toolsUsed && handed.has('create_file')) {
        yield {
          type: 'tool_call',
          callId: 'fixture-create-file',
          name: 'create_file',
          input: { path: writePath, text: 'written by the Managed Local Worker\n' },
        };
        yield { type: 'completed', stopReason: 'tool_calls' };
        return;
      }
      if (!toolsUsed && handed.has('read_file')) {
        yield {
          type: 'tool_call',
          callId: 'fixture-read-file',
          name: 'read_file',
          input: { path: readPath },
        };
        yield { type: 'completed', stopReason: 'tool_calls' };
        return;
      }
      yield { type: 'output_delta', text: finalAnswer(request) };
      yield { type: 'completed', stopReason: 'stop' };
    },
  };
  const registry = new MainProviderRegistry();
  registry.register({
    runtimeKind: connection.runtimeKind,
    providerId: connection.providerId,
    runtime: provider,
  });
  const runtime = new ProviderAwareTeamWorkerRuntime({
    fallback: options.fallback,
    verification: {
      requireVerifiedForExecution: async () => connection,
    } as unknown as ProviderVerificationService,
    registry,
    getConnection: () => connection,
    authorizeEgress: () => true,
    managerGuidance: '',
    managerTools: [],
    workerGuidance: 'Use the workspace tools.',
    workerTools: [],
    executeManagerTool: () =>
      Promise.reject(new Error('The Managed Local fixture has no Team tools')),
    managedToolsConnectionId: connection.id,
    prepareManagedTools: async ({ worker, workspaceSet }) => {
      const tools = [
        ...(workspaceSet.roots.length === 0 ? [] : READ_TOOLS),
        ...(worker.writeCapable ? WRITE_TOOLS : []),
      ];
      sessions.push({
        workerId: worker.id,
        writeCapable: worker.writeCapable,
        workspaceSet,
        tools,
      });
      const primary = workspaceSet.roots.find(
        ({ rootId }) => rootId === workspaceSet.primaryRootId,
      );
      return {
        tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
        execute: async (name, input) => {
          if (primary === undefined)
            throw new Error('The managed tool session has no Primary root');
          const { path, text } = input as { path: string; text?: string };
          const file = join(primary.path, path);
          toolCalls.push({ workerId: worker.id, name, file });
          if (name === 'read_file') return { text: readFileSync(file, 'utf8') };
          writeFileSync(file, text ?? '', { flag: 'wx' });
          return { rootId: primary.rootId, path, sagaId: `saga:${path}`, state: 'committed' };
        },
        release: () => undefined,
      };
    },
  });
  return { runtime, sessions, toolCalls };
}

/** The final answer, with a report of every numbered done criterion as done. */
function finalAnswer(request: ProviderExecutionRequest): string {
  const prompt =
    request.messages.find(({ role, content }) => role === 'user' && content.includes('依頼: '))
      ?.content ?? '';
  const criteria: number[] = [];
  for (const line of prompt.split(CRITERIA_HEADING)[1]?.split('\n').slice(1) ?? []) {
    const index = /^(\d+)\. /u.exec(line)?.[1];
    if (index === undefined) break;
    criteria.push(Number(index));
  }
  const summary = 'Managed Localの作業を終えました。';
  return criteria.length === 0
    ? summary
    : [
        summary,
        '```json',
        JSON.stringify({
          criteria: criteria.map((index) => ({
            index,
            status: 'done',
            evidence: 'Managed Localの管理ツールで確かめました',
          })),
        }),
        '```',
      ].join('\n');
}
