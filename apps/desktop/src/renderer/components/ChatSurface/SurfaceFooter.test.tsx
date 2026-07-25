import { describe, expect, it } from 'vitest';
import { describeConnection, describeRecovery } from './SurfaceFooter';

// Issue #9: SurfaceFooter was the only §4.2 ChatSurface element never built, so a database restore
// and a dead Runtime were both invisible. These cover the two decisions the wording encodes —
// staying silent when nothing happened, and naming the actual reason when something did.

describe('describeRecovery', () => {
  const clean = {
    corruptionDetected: false,
    restoredFromBackup: false,
    freshStart: false,
    interruptedTurns: 0,
  };

  it('says nothing on an ordinary launch', () => {
    // The footer must not spend a line telling the user everything is fine.
    expect(describeRecovery(clean)).toBeNull();
    expect(describeRecovery(null)).toBeNull();
  });

  it('reports a restore from backup', () => {
    expect(describeRecovery({ ...clean, corruptionDetected: true, restoredFromBackup: true })).toBe(
      'データベースをバックアップから復元しました',
    );
  });

  it('distinguishes corruption with no backup to restore from', () => {
    // Materially different outcome: the user has lost data rather than had it recovered.
    expect(describeRecovery({ ...clean, corruptionDetected: true })).toBe(
      'データベースが破損していたため退避しました（バックアップなし）',
    );
  });

  it('reports interrupted Runs with their count', () => {
    expect(describeRecovery({ ...clean, interruptedTurns: 2 })).toBe(
      '前回終了時に実行中だったRun 2件を中断として確定しました',
    );
  });

  it('combines both when a launch did both', () => {
    const text = describeRecovery({
      ...clean,
      corruptionDetected: true,
      restoredFromBackup: true,
      interruptedTurns: 1,
    });
    expect(text).toContain('バックアップから復元');
    expect(text).toContain('Run 1件');
  });

  it('ignores freshStart on its own', () => {
    // A first launch creates the database; that is not a recovery and needs no notice.
    expect(describeRecovery({ ...clean, freshStart: true })).toBeNull();
  });
});

describe('describeConnection', () => {
  it('reads sanely before any status has arrived, using the selected Runtime', () => {
    expect(describeConnection(null, 'claude')).toEqual({
      tone: 'idle',
      text: 'Claude Code: 待機中',
    });
  });

  it('reports a running turn', () => {
    expect(
      describeConnection(
        { kind: 'codex', state: 'running', taskId: 't1', errorCode: null, userMessage: null },
        'mock',
      ),
    ).toEqual({ tone: 'running', text: 'Codex: 実行中' });
  });

  it('names the actual failure reason', () => {
    // The whole point of carrying the PublicError through: "the CLI is gone" and "the model
    // refused" both used to arrive as an unexplained failed Turn.
    expect(
      describeConnection(
        {
          kind: 'claude',
          state: 'failed',
          taskId: 't1',
          errorCode: 'RUNTIME_CLI_MISSING',
          userMessage: 'Claude CLIが見つかりません。',
        },
        'claude',
      ),
    ).toEqual({ tone: 'failed', text: 'Claude Code: Claude CLIが見つかりません。' });
  });

  it('still says something useful when a failure carries no message', () => {
    expect(
      describeConnection(
        { kind: 'codex', state: 'failed', taskId: null, errorCode: null, userMessage: null },
        'codex',
      ),
    ).toEqual({ tone: 'failed', text: 'Codex: 接続が失われました' });
  });

  it('prefers the status kind over the selected kind', () => {
    // A failure that arrives just after the user switched Runtime must still name the Runtime that
    // actually failed.
    expect(
      describeConnection(
        { kind: 'claude', state: 'failed', taskId: null, errorCode: null, userMessage: null },
        'mock',
      ).text,
    ).toContain('Claude Code');
  });
});
