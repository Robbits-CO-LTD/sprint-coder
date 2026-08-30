import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeEffortSchema, type PublicError } from '@sprint-coder/contracts';
import { ToolRegistry } from '@sprint-coder/domain';
import { ClaudeRuntimeAdapter, probeClaude } from './claude-adapter';
import type { RuntimeCanonicalEvent } from './protocol';
import { WORKSPACE_CREATE_FILE_TOOL } from '../main/workspace-patch-tool';
import { READ_FILE_TOOL, providerToolsFromSnapshot } from '../main/provider-workspace-tools';
import { MANAGED_EXEC_COMMAND_TOOL } from '../main/default-tools';
import { TeamMcpBridge, defaultSocketPathFactory } from '../main/team-mcp-bridge';
import type { TeamCoordinator } from '../main/team-coordinator';
import { queryNativeProcessIdentity } from '../main/native-process-identity';

// Opt-in REAL smoke test: drives one short real turn through the actual adapter code path
// against the locally installed `claude` CLI. Deliberately excluded from the default `npm test`
// run (gated by SPRINT_CODER_CLAUDE_SMOKE=1) since it needs a real, authenticated CLI install and
// spends real usage/quota. Run explicitly with:
//   SPRINT_CODER_CLAUDE_SMOKE=1 npx vitest run src/runtime-host/claude-smoke.test.ts
const enabled = process.env['SPRINT_CODER_CLAUDE_SMOKE'] === '1';

function liveClaudeProcessCount(): number {
  try {
    // pgrep -f matches the full command line; -x would require an exact argv0 match which
    // varies by platform, so -f is the portable choice here.
    const output = execFileSync('pgrep', ['-f', 'claude -p'], { encoding: 'utf8' });
    return output.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    // pgrep exits 1 when nothing matches.
    return 0;
  }
}

function waitFor(conditionMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, conditionMs));
}

describe.skipIf(!enabled)('Claude runtime adapter (REAL CLI smoke)', () => {
  it('probes the real CLI as available', async () => {
    const probe = await probeClaude();
    expect(probe.available).toBe(true);
    expect(probe.version).toBeDefined();
    console.log('[claude-smoke] probe:', probe);
  });

  // issue #8: `ultracode` is accepted by `--effort` but omitted from `claude --help`'s
  // parenthetical list, and the CLI exposes no effort field in its output — so the only evidence
  // that a level is honoured rather than silently dropped is the CLI's own warning, which it
  // prints on stderr whenever it ignores an `--effort` value. This asserts both directions so a
  // future CLI that stops recognising a level fails here instead of quietly degrading every
  // Ultracode turn to the default effort.
  const IGNORED_EFFORT_WARNING = /Unknown --effort value/;

  function effortWarning(effort: string): string {
    const result = spawnSync(
      'claude',
      [
        '-p',
        '1',
        '--effort',
        effort,
        '--output-format',
        'json',
        '--tools',
        '',
        '--strict-mcp-config',
        '--safe-mode',
        '--no-session-persistence',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stderr;
  }

  it('accepts every claudeEffortSchema level without the CLI warning that it ignored one', () => {
    for (const effort of claudeEffortSchema.options) {
      expect(effortWarning(effort), `--effort ${effort}`).not.toMatch(IGNORED_EFFORT_WARNING);
    }
  }, 300_000);

  it('does warn for values outside the schema, proving the check above discriminates', () => {
    // 'ultra' is a deliberate near-miss of 'ultracode': if the CLI merely accepted anything
    // prefix-matching a known level, the assertion above would prove nothing.
    for (const effort of ['ultra', 'bogus']) {
      expect(effortWarning(effort), `--effort ${effort}`).toMatch(IGNORED_EFFORT_WARNING);
    }
  }, 120_000);

  it('streams stages and deltas and completes with a real short turn, then cancel leaves no child process', async () => {
    const adapter = new ClaudeRuntimeAdapter();
    const events: RuntimeCanonicalEvent[] = [];
    const failures: PublicError[] = [];
    let exitInfo: { code: number; canceled: boolean } | null = null;
    let started = false;

    await new Promise<void>((resolve) => {
      adapter.start(
        'smoke-turn-1',
        '1+1は?数字のみ返答',
        [],
        () => {
          started = true;
        },
        null,
        'auto',
        (event) => {
          events.push(event);
        },
        (error) => {
          failures.push(error);
        },
        (code, canceled) => {
          exitInfo = { code, canceled };
          resolve();
        },
      );
    });

    console.log('[claude-smoke] events:', JSON.stringify(events));
    console.log('[claude-smoke] failures:', JSON.stringify(failures));
    console.log('[claude-smoke] exit:', exitInfo);

    expect(started).toBe(true);
    expect(failures).toEqual([]);
    expect(events.map((event) => event.type)).toContain('stage');
    expect(events.map((event) => event.type)).toContain('delta');
    // The real CLI's system/init event always carries a concrete `model` id (verified via direct
    // probe), which the normalizer surfaces here so Main can show "what actually ran" — see the
    // ADR amendment.
    expect(events.at(-1)).toMatchObject({ type: 'completed', resolvedModel: expect.any(String) });
    expect(exitInfo).toMatchObject({ code: 0, canceled: false });
  }, 60_000);

  it('runs a selected Claude-native Skill from the Turn-only plugin', async () => {
    const skillRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-claude-selected-skill-'));
    try {
      writeFileSync(
        join(skillRoot, 'SKILL.md'),
        '---\nname: native-smoke\ndescription: Real Claude native Skill smoke\ndisable-model-invocation: true\n---\nReturn exactly CLAUDE_NATIVE_SKILL_OK.',
      );
      const adapter = new ClaudeRuntimeAdapter();
      const events: RuntimeCanonicalEvent[] = [];
      const failures: PublicError[] = [];
      await new Promise<void>((resolve) => {
        adapter.start(
          'claude-smoke-selected-skill',
          'Follow the selected Skill.',
          [],
          () => undefined,
          null,
          'auto',
          (event) => events.push(event),
          (error) => failures.push(error),
          () => resolve(),
          undefined,
          undefined,
          'read-only',
          [
            {
              name: 'native-smoke',
              path: skillRoot,
              profile: 'claude-native',
              runtimeSupport: 'full',
              activationPolicy: 'manual',
              selected: true,
            },
          ],
        );
      });
      expect(failures).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'completed' });
      expect(
        events
          .filter((event) => event.type === 'delta')
          .map((event) => event.delta)
          .join('')
          .trim(),
      ).toBe('CLAUDE_NATIVE_SKILL_OK');
    } finally {
      rmSync(skillRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('edits, verifies, and reads back through managed MCP tools with no native Claude tool', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sprint-coder-claude-managed-'));
    const registry = new ToolRegistry();
    for (const definition of [
      WORKSPACE_CREATE_FILE_TOOL,
      MANAGED_EXEC_COMMAND_TOOL,
      READ_FILE_TOOL,
    ])
      registry.register(definition);
    const snapshot = registry.createSnapshot({ providerId: 'claude', workspaceId: 'workspace-1' });
    const managedTools = providerToolsFromSnapshot(snapshot);
    const calls: string[] = [];
    const bridge = new TeamMcpBridge(
      {} as TeamCoordinator,
      defaultSocketPathFactory(tmpdir()),
      5_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (input, context) => {
        calls.push(context.toolName);
        if (context.catalogDigest !== snapshot.digest) throw new Error('catalog digest mismatch');
        if (context.toolName === 'create_file') {
          const request = input as { path: string; content: string };
          writeFileSync(join(workspace, request.path), request.content);
          return { state: 'committed', path: request.path };
        }
        if (context.toolName === 'exec_command') {
          if (readFileSync(join(workspace, 'result.txt'), 'utf8') !== 'managed-ok')
            return { exitCode: 1, output: 'verification failed' };
          return { exitCode: 0, output: 'verification passed' };
        }
        if (context.toolName === 'read_file')
          return {
            path: 'result.txt',
            content: readFileSync(join(workspace, 'result.txt'), 'utf8'),
          };
        throw new Error('unexpected managed tool');
      },
    );
    try {
      const socketPath = await bridge.ensureStarted();
      expect(socketPath).not.toBeNull();
      const token = TeamMcpBridge.generateToken();
      const turnId = 'claude-smoke-managed';
      bridge.register(turnId, {
        taskId: 'claude-smoke-task',
        token,
        allowTeamTools: false,
        allowedTools: [],
        managedTools,
        managedToolCatalogDigest: snapshot.digest,
        contextOwner: { type: 'turn', id: turnId },
      });
      const events: RuntimeCanonicalEvent[] = [];
      const failures: PublicError[] = [];
      let processBound = false;
      await new Promise<void>((resolve) => {
        const adapter = new ClaudeRuntimeAdapter();
        adapter.start(
          turnId,
          'Use create_file to write result.txt with exactly managed-ok. Then call exec_command with executable node and argv ["--version"]. Finally call read_file for result.txt and report success.',
          [],
          () => undefined,
          workspace,
          'auto',
          (event) => events.push(event),
          (error) => failures.push(error),
          () => resolve(),
          {
            socketPath: socketPath!,
            token,
            guidance: 'Only the supplied managed MCP tools may access the workspace.',
            toolNames: [],
            managedTools,
            toolCatalogDigest: snapshot.digest,
          },
          undefined,
          'workspace-write',
          [],
          [],
          undefined,
          undefined,
          (pid) => {
            const identity = queryNativeProcessIdentity(pid);
            processBound = identity !== null && bridge.bindRuntimeProcess(turnId, identity);
          },
        );
      });
      expect(processBound).toBe(true);
      expect(failures).toEqual([]);
      expect(calls).toEqual(['create_file', 'exec_command', 'read_file']);
      expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('managed-ok');
      expect(events.at(-1)).toMatchObject({ type: 'completed' });
      bridge.unregister(turnId);
    } finally {
      await bridge.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);

  it('kills the process tree on cancel mid-turn, leaving no orphan claude process', async () => {
    const baseline = liveClaudeProcessCount();
    const adapter = new ClaudeRuntimeAdapter();
    let exitInfo: { code: number; canceled: boolean } | null = null;

    const settled = new Promise<void>((resolve) => {
      adapter.start(
        'smoke-turn-cancel',
        '1から100までの数字をカンマ区切りで数えて、それぞれの数字について簡単な豆知識も添えてください。',
        [],
        () => undefined,
        null,
        'auto',
        () => undefined,
        () => undefined,
        (code, canceled) => {
          exitInfo = { code, canceled };
          resolve();
        },
      );
    });

    // Give the CLI a moment to actually spawn before canceling mid-flight.
    await waitFor(500);
    adapter.cancel('smoke-turn-cancel');
    await settled;

    console.log('[claude-smoke] cancel exit:', exitInfo);
    expect(exitInfo).toMatchObject({ canceled: true });

    // Grace period for SIGTERM/SIGKILL to actually reap the process tree.
    await waitFor(3_000);
    const afterCancel = liveClaudeProcessCount();
    console.log('[claude-smoke] live claude processes before/after:', baseline, afterCancel);
    expect(afterCancel).toBeLessThanOrEqual(baseline);
  }, 30_000);
});
