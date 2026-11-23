import { describe, expect, it } from 'vitest';
import { accessDescription, accessEnforcement, commandSandboxDescription } from './access-labels';

describe('managed access labels', () => {
  it('uses a plain command availability message', () => {
    const capability = {
      available: true,
      backend: 'macos-seatbelt',
      reason: null,
      probedAt: '2026-08-18T00:00:00.000Z',
    };
    expect(accessEnforcement(capability)).toBe('os-sandbox');
    expect(accessDescription('auto', capability)).toContain('未許可のコマンドは実行前に確認します');
    expect(commandSandboxDescription(capability)).toBe(
      '作業フォルダーで実行するコマンドは外部と通信できません。',
    );
  });

  it('describes Auto as auto-allowing Workspace file edits and reviewing the rest (issue #526)', () => {
    const description = accessDescription('auto', null);
    expect(description).toContain('作業フォルダー内のファイルの作成・編集は自動で許可します');
    expect(description).toContain('コマンドは使えません');
    expect(description).toContain('選択中のAIが操作の種類とリスクを審査します');
  });

  it('describes Ask as confirming Workspace reads too (issue #842)', () => {
    // allowRules is empty under Ask, so read_file / list_workspace also wait on an approval card.
    const description = accessDescription('ask', null);
    expect(description).toContain('作業フォルダー内のファイルの読み取り・一覧も含め');
    expect(description).toContain('許可ルールにない操作は実行前に確認します');
    // The card offers 「Task中許可」 (allow_task), after which the same operation runs without one.
    expect(description).toContain(
      '「Task中許可」を選ぶと、このTaskでは同じ操作を確認なしで続けます',
    );
    expect(description).not.toContain('1回ごと');
    expect(description).not.toContain('読み取りは共通Harnessで実行し');
  });

  it('reports fail-closed command removal in plain language', () => {
    const capability = {
      available: false,
      backend: 'linux-bubblewrap-landlock-seccomp',
      reason: 'bubblewrap_probe_failed',
      probedAt: '2026-08-18T00:00:00.000Z',
    };
    expect(accessEnforcement(capability)).toBe('command-unavailable');
    expect(commandSandboxDescription(capability)).toBe(
      '安全に実行できることを確認できなかったため、コマンドは使えません。',
    );
  });
});
