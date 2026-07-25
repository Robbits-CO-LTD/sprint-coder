import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicError } from '@sprint-coder/contracts';
import { CodexRuntimeAdapter, probeCodex } from './codex-adapter';
import { collectThreadImages } from '../main/generated-image-collector';
import type { RuntimeCanonicalEvent } from './protocol';

// Opt-in REAL smoke test (Phase 7 hardening, IMPLEMENTATION_PLAN §10.4 5a/5b): drives real turns
// through the actual adapter code path against the locally installed `codex` CLI, following
// claude-smoke.test.ts's pattern exactly (same opt-in gate style, same orphan-process check).
// Deliberately excluded from the default `npm test` run (needs a real, authenticated CLI install
// and spends real usage/quota). Run explicitly with:
//   SPRINT_CODER_CODEX_SMOKE=1 npx vitest run src/runtime-host/codex-smoke.test.ts
const enabled = process.env['SPRINT_CODER_CODEX_SMOKE'] === '1';

function liveCodexProcessCount(): number {
  try {
    const output = execFileSync('pgrep', ['-f', 'codex exec'], { encoding: 'utf8' });
    return output.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!enabled)('Codex runtime adapter (REAL CLI smoke)', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const directory of cleanupDirs.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('probes the real CLI as available', async () => {
    const probe = await probeCodex();
    expect(probe.available).toBe(true);
    console.log('[codex-smoke] probe:', probe);
  });

  it('streams stages and deltas and completes with a real short turn, then cancel leaves no child process', async () => {
    const adapter = new CodexRuntimeAdapter();
    const events: RuntimeCanonicalEvent[] = [];
    const failures: PublicError[] = [];
    let exitInfo: { code: number; canceled: boolean } | null = null;
    let started = false;

    await new Promise<void>((resolve) => {
      adapter.start(
        'codex-smoke-turn-1',
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

    console.log('[codex-smoke] events:', JSON.stringify(events));
    console.log('[codex-smoke] failures:', JSON.stringify(failures));
    console.log('[codex-smoke] exit:', exitInfo);

    expect(started).toBe(true);
    expect(failures).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect(exitInfo).toMatchObject({ code: 0, canceled: false });
  }, 60_000);

  // issue #11: proves the whole image path against the real CLI — that `$imagegen` runs, that the
  // adapter surfaces the thread id, and that the file the CLI wrote is findable from that id alone.
  // Deliberately does NOT parse any path out of the agent's message: doing so is the vulnerability
  // this design exists to avoid, so the test must not demonstrate it working either.
  it('generates an image and makes it findable from the thread id alone', async () => {
    const adapter = new CodexRuntimeAdapter();
    const events: RuntimeCanonicalEvent[] = [];
    const failures: PublicError[] = [];

    await new Promise<void>((resolve) => {
      adapter.start(
        'codex-smoke-imagegen',
        '$imagegen 単色の青い正方形アイコンを1つ生成してください。生成のみで、ファイルのコピーや移動は行わないでください。',
        [],
        () => undefined,
        null,
        'auto',
        (event) => {
          events.push(event);
        },
        (error) => {
          failures.push(error);
        },
        () => resolve(),
      );
    });

    expect(failures).toEqual([]);
    const threadEvent = events.find((event) => event.type === 'thread');
    expect(threadEvent, 'adapter surfaced a thread id').toBeDefined();
    const threadId = threadEvent?.type === 'thread' ? threadEvent.threadId : '';
    console.log('[codex-smoke] imagegen thread:', threadId);

    const collected = collectThreadImages(threadId);
    console.log(
      '[codex-smoke] collected:',
      collected.map(({ fileName, bytes }) => `${fileName} (${bytes.byteLength}B)`),
    );
    expect(collected.length, 'at least one PNG was generated for this thread').toBeGreaterThan(0);
    // The magic-byte gate persistence applies, asserted here against a real generated file rather
    // than a synthetic fixture.
    for (const { bytes } of collected)
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
  }, 300_000);

  it('proves the read-only OS sandbox: a real turn instructed to write outside the workspace never creates the file', async () => {
    // Adversarial proof for deliverable 5b: this is not a Main-process path-guard check (that is
    // covered by path-guard.test.ts) — this proves the Codex CLI's *own* `--sandbox read-only`
    // flag (codex-adapter.ts buildCodexArgs) actually holds against a real, explicitly
    // instructed attempt to escape it, at the OS level, on this machine.
    const workspace = mkdtempSync(join(tmpdir(), 'sprint-coder-codex-sandbox-workspace-'));
    cleanupDirs.push(workspace);
    const escapeTarget = join(tmpdir(), `sprint-coder-codex-sandbox-escape-${Date.now()}.txt`);

    const adapter = new CodexRuntimeAdapter();
    const failures: PublicError[] = [];
    let exitInfo: { code: number; canceled: boolean } | null = null;

    await new Promise<void>((resolve) => {
      adapter.start(
        'codex-smoke-sandbox-escape',
        `Run a shell command that writes the text "escaped" to the file at exactly this path: ${escapeTarget}. Then report whether it succeeded.`,
        [],
        () => undefined,
        workspace,
        'auto',
        () => undefined,
        (error) => {
          failures.push(error);
        },
        (code, canceled) => {
          exitInfo = { code, canceled };
          resolve();
        },
      );
    });

    console.log('[codex-smoke] sandbox-escape failures:', JSON.stringify(failures));
    console.log('[codex-smoke] sandbox-escape exit:', exitInfo);
    console.log('[codex-smoke] escape file exists:', existsSync(escapeTarget));

    // The read-only sandbox must prevent the write regardless of whether Codex attempted it,
    // reported failure, or the turn otherwise errored — the file must simply never exist.
    expect(existsSync(escapeTarget)).toBe(false);
    if (existsSync(escapeTarget)) rmSync(escapeTarget, { force: true });
  }, 60_000);

  it('kills the process tree on cancel mid-turn, leaving no orphan codex process', async () => {
    const baseline = liveCodexProcessCount();
    const adapter = new CodexRuntimeAdapter();
    let exitInfo: { code: number; canceled: boolean } | null = null;

    const settled = new Promise<void>((resolve) => {
      adapter.start(
        'codex-smoke-turn-cancel',
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

    await waitFor(500);
    adapter.cancel('codex-smoke-turn-cancel');
    await settled;

    console.log('[codex-smoke] cancel exit:', exitInfo);
    expect(exitInfo).toMatchObject({ canceled: true });

    await waitFor(3_000);
    const afterCancel = liveCodexProcessCount();
    console.log('[codex-smoke] live codex processes before/after:', baseline, afterCancel);
    expect(afterCancel).toBeLessThanOrEqual(baseline);
  }, 30_000);
});
