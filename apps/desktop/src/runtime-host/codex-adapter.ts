import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PublicError } from '@vibe/contracts';
import { ApprovalRequestedError, CodexJsonlNormalizer } from './codex-normalizer';
import type { RuntimeCanonicalEvent } from './protocol';

type ActiveProcess = {
  child: ChildProcessWithoutNullStreams;
  canceled: boolean;
  cleanup: () => void;
};
type EmitEvent = (event: RuntimeCanonicalEvent) => void;
type EmitError = (error: PublicError) => void;

export type CodexProbe = { available: boolean; version?: string };

export async function probeCodex(command = 'codex'): Promise<CodexProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, ['--version'], {
      env: minimalEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finish = (result: CodexProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once('error', () => finish({ available: false }));
    child.once('exit', (code) => {
      const version = Buffer.concat(chunks).toString('utf8').trim();
      finish(
        code === 0
          ? { available: true, ...(version === '' ? {} : { version }) }
          : { available: false },
      );
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ available: false });
    }, 5_000);
  });
}

export class CodexRuntimeAdapter {
  private readonly active = new Map<string, ActiveProcess>();

  constructor(private readonly timeoutMs = 10 * 60_000) {}

  start(
    turnId: string,
    input: string,
    workspacePath: string | null,
    emit: EmitEvent,
    fail: EmitError,
    exited: (code: number, canceled: boolean) => void,
  ): void {
    if (this.active.has(turnId)) {
      fail(publicError('RUNTIME_FAILED', 'このTurnはすでに実行中です。', false));
      return;
    }
    let temporaryDirectory: string | null = null;
    const cwd = workspacePath ?? (temporaryDirectory = mkdtempSync(join(tmpdir(), 'vibe-codex-')));
    const normalizer = new CodexJsonlNormalizer();
    const child = spawn(
      'codex',
      [
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-c',
        'approval_policy="never"',
        '-c',
        'shell_environment_policy.inherit="none"',
        '-',
      ],
      {
        cwd,
        env: minimalEnvironment(),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const cleanup = (): void => {
      if (temporaryDirectory !== null) rmSync(temporaryDirectory, { recursive: true, force: true });
    };
    const control: ActiveProcess = { child, canceled: false, cleanup };
    this.active.set(turnId, control);
    child.stdin.end(input);

    let failed = false;
    let sawCompletion = false;
    const timeout = setTimeout(() => {
      if (!failed && !control.canceled) {
        failed = true;
        fail(publicError('RUNTIME_TIMEOUT', 'Codex runtimeがタイムアウトしました。', true));
      }
      void terminateProcessTree(child);
    }, this.timeoutMs);

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (failed || control.canceled || line.trim() === '') return;
      try {
        for (const event of normalizer.push(line)) {
          if (event.type === 'completed') sawCompletion = true;
          emit(event);
        }
      } catch (error) {
        failed = true;
        const approval = error instanceof ApprovalRequestedError;
        fail(
          publicError(
            approval ? 'RUNTIME_FAILED' : 'RUNTIME_PROTOCOL_ERROR',
            approval
              ? 'Codex runtimeが予期しない承認を要求したため停止しました。'
              : 'Codex runtimeの出力を解釈できませんでした。',
            false,
          ),
        );
        void terminateProcessTree(child);
      }
    });
    // Drain diagnostics so the child cannot block, but never forward or retain provider output.
    child.stderr.resume();
    child.once('error', (error) => {
      if (failed || control.canceled) return;
      failed = true;
      fail(
        publicError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'RUNTIME_CLI_MISSING'
            : 'RUNTIME_FAILED',
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'Codex CLIが見つかりません。'
            : 'Codex runtimeを起動できませんでした。',
          false,
        ),
      );
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      this.active.delete(turnId);
      cleanup();
      const exitCode = code ?? -1;
      if (!control.canceled && !failed && (exitCode !== 0 || !sawCompletion)) {
        failed = true;
        fail(publicError('RUNTIME_FAILED', 'Codex runtimeが正常に完了しませんでした。', true));
      }
      exited(exitCode, control.canceled);
    });
  }

  cancel(turnId: string): void {
    const control = this.active.get(turnId);
    if (control === undefined) return;
    control.canceled = true;
    void terminateProcessTree(control.child);
  }

  dispose(): void {
    for (const [turnId] of this.active) this.cancel(turnId);
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowlist = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CODEX_HOME',
  ];
  return Object.fromEntries(
    allowlist.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  signalTree(pid, 'SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) signalTree(pid, 'SIGKILL');
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])], {
        env: minimalEnvironment(),
        stdio: 'ignore',
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process may already have exited between the state check and the signal.
  }
}

function publicError(
  code: PublicError['code'],
  userMessage: string,
  retryable: boolean,
): PublicError {
  return { code, userMessage, retryable };
}
