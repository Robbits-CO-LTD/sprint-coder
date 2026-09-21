import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputerAppGrantView } from '@sprint-coder/contracts';
import {
  ComputerUseAcceptanceBuildNotice,
  ComputerUseGrantSection,
  ComputerUseOnboarding,
  ComputerUseSessionRail,
  ComputerUseUnavailableNotice,
  availableComputerUseMode,
  type ComputerUseProfileView,
  type ComputerUseProviderView,
} from './ComputerUsePanel';

const profiles: readonly ComputerUseProfileView[] = [
  {
    id: 'profile-1',
    revision: 1,
    displayName: 'TextEdit',
    identityLabel: 'com.apple.TextEdit · Apple',
    metadata: '登録確認 2026-08-29',
    available: true,
    unavailableReason: null,
    mode: 'full_access_app',
    connectionId: 'connection-1',
    modelId: 'vision-model',
    providerEgressConsent: true,
    remember: true,
    policyLanguage: 'en',
    maximumMode: 'full_access_app',
  },
];

const providers: readonly ComputerUseProviderView[] = [
  {
    connectionId: 'connection-1',
    modelId: 'vision-model',
    label: 'Local Vision',
    detail: 'vision-model',
    capabilityStatus: 'confirmed',
  },
];

describe('ComputerUseOnboarding', () => {
  it('defaults to full access and makes provider egress an explicit requirement', () => {
    const html = renderToStaticMarkup(
      <ComputerUseOnboarding
        profiles={profiles}
        providers={providers}
        controlAvailable
        busy={false}
        onClose={() => {}}
        onRegister={async () => {}}
        onResolveWindows={async () => []}
        onStart={async () => {}}
      />,
    );

    expect(html).toContain('COMPUTER USE · 1 / 2');
    expect(html).toContain('操作するアプリを選ぶ');
    expect(html).toContain('アプリを登録');
    expect(html).toContain('class="computer-use-quick-start"');
    expect(html).toContain('aria-labelledby="computer-use-dialog-title"');
  });

  it('never accepts a renderer path or process id as component input', () => {
    const source = ComputerUseOnboarding.toString();
    expect(source).not.toContain('executablePath');
    expect(source).not.toContain('processId');
    expect(source).not.toContain('windowHandle');
  });

  it('keeps an actionable empty-provider state and initial focus in the flow', () => {
    const source = ComputerUseOnboarding.toString();
    expect(source).toContain('画像対応のProvider / Modelがありません');
    expect(source).toContain('AI Connections');
    expect(source).toContain('autoFocus');
  });

  it('forces observe-only onboarding when native input permission is unavailable', () => {
    const source = ComputerUseOnboarding.toString();
    expect(availableComputerUseMode('full_access_app', false, 'en')).toBe('observe_only');
    expect(availableComputerUseMode('supervised', false, 'en')).toBe('observe_only');
    expect(availableComputerUseMode('full_access_app', true, 'en')).toBe('full_access_app');
    expect(availableComputerUseMode('full_access_app', true, 'unknown')).toBe('supervised');
    expect(availableComputerUseMode('full_access_app', true, 'en', 'supervised')).toBe(
      'supervised',
    );
    expect(availableComputerUseMode('supervised', true, 'en', 'observe_only')).toBe('observe_only');
    expect(source).toContain('アクセシビリティ操作の許可がないため');
    expect(source).toContain('busy || !controlAvailable');
    expect(source).toContain('停止表示の反応が短く遅れる場合があります');
    expect(source).toContain('文字判定は英語・日本語のUIだけに対応します');
    expect(source).toContain('「確認あり」または「見るだけ」');
  });

  it('explains unknown image capability and keeps it on the preflight path', () => {
    const source = ComputerUseOnboarding.toString();
    const html = renderToStaticMarkup(
      <ComputerUseOnboarding
        profiles={profiles}
        providers={providers}
        controlAvailable
        busy={false}
        error="設定を読み込めませんでした"
        onClose={() => {}}
        onRegister={async () => {}}
        onResolveWindows={async () => []}
        onStart={async () => {}}
      />,
    );

    expect(html).toContain('設定を読み込めませんでした');
    expect(source).toContain('このModelの画像入力対応は未確認です');
    expect(source).toContain('固定画像のpreflight');
  });

  it('states that screenshots are not redacted while the accessibility tree is', () => {
    const source = ComputerUseOnboarding.toString();
    expect(source).toContain('スクリーンショット本体は伏字されません');
    expect(source).toContain('アクセシビリティツリー');
    expect(source).toContain('利用料金');
    expect(source).toContain('保持期間');
    expect(source).toContain('ファイル選択');
    expect(source).not.toContain('座標fallbackは、今回のみ確認');
    expect(source).toContain('登録アプリの署名identityは、この設定に関係なく保持されます');
  });

  it('states the exact V1 application compatibility boundary', () => {
    const source = ComputerUseOnboarding.toString();
    expect(source).toContain('WindowsはSystem32のクラシック版メモ帳');
    expect(source).toContain('同じreleaseで署名した受入fixture');
    expect(source).toContain('macOSはTextEdit');
    expect(source).toContain('公式Visual Studio Code（確認あり）');
    expect(source).toContain('上記以外のアプリは未対応');
  });
});

describe('ComputerUseUnavailableNotice', () => {
  it('explains macOS recovery and exposes a focused retry action', () => {
    const html = renderToStaticMarkup(
      <ComputerUseUnavailableNotice
        availability={{
          platform: 'darwin',
          observe: false,
          control: false,
          reasonCode: 'screen_recording_permission_required',
          missingPermissions: [],
        }}
        busy={false}
        onClose={() => {}}
        onRetry={async () => {}}
        onOpenSettings={async () => {}}
      />,
    );

    expect(html).toContain('OSの許可が必要です');
    expect(html).toContain('画面収録');
    expect(html).toContain('アクセシビリティ');
    expect(html).toContain('autofocus=""');
    expect(html).toContain('許可を再確認');
  });

  it('names each OS permission separately and offers settings only for the missing ones', () => {
    const html = renderToStaticMarkup(
      <ComputerUseUnavailableNotice
        availability={{
          platform: 'darwin',
          observe: false,
          control: false,
          reasonCode: 'accessibility_permission_required',
          missingPermissions: ['accessibility'],
        }}
        busy={false}
        onClose={() => {}}
        onRetry={async () => {}}
        onOpenSettings={async () => {}}
      />,
    );

    expect(html).toContain('アクセシビリティ');
    expect(html).toContain('未許可');
    expect(html).toContain('許可済み');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-computer-use-permission="accessibility"');
    expect(html).not.toContain('data-computer-use-permission="screen_recording"');
    expect(html).toContain('data-computer-use-activation="permission-settings"');
    expect(html).toContain('設定を開く');
    // The permission list never leaks a native reason string or a settings URL to the renderer.
    expect(html).not.toContain('ACCESSIBILITY_PERMISSION_REQUIRED');
    expect(html).not.toContain('x-apple.systempreferences');
    // Recovery after granting still needs the existing re-check path, and macOS may need a restart.
    expect(html).toContain('許可を再確認');
    expect(html).toContain('再起動');
  });

  it('keeps one settings action per missing permission', () => {
    const html = renderToStaticMarkup(
      <ComputerUseUnavailableNotice
        availability={{
          platform: 'darwin',
          observe: false,
          control: false,
          reasonCode: 'accessibility_permission_required',
          missingPermissions: ['accessibility', 'screen_recording'],
        }}
        busy={false}
        onClose={() => {}}
        onRetry={async () => {}}
        onOpenSettings={async () => {}}
      />,
    );

    expect(html.match(/data-computer-use-activation="permission-settings"/gu)).toHaveLength(2);
    expect(html).not.toContain('許可済み');
  });

  it('offers no settings action where the OS has no such permission to grant', () => {
    const html = renderToStaticMarkup(
      <ComputerUseUnavailableNotice
        availability={{
          platform: 'win32',
          observe: false,
          control: false,
          reasonCode: 'ui_automation_unavailable',
          missingPermissions: [],
        }}
        busy={false}
        onClose={() => {}}
        onRetry={async () => {}}
        onOpenSettings={async () => {}}
      />,
    );

    expect(html).not.toContain('data-computer-use-activation="permission-settings"');
    expect(html).toContain('Windowsのプライバシー設定');
  });
});

describe('ComputerUseSessionRail', () => {
  it('keeps a labelled stop control and full-access status visible', () => {
    const html = renderToStaticMarkup(
      <ComputerUseSessionRail
        session={{
          sessionId: 'session-1',
          appName: 'TextEdit',
          windowLabel: 'Untitled',
          mode: 'full_access_app',
          providerLabel: 'Local Vision',
          state: 'acting',
          round: 2,
          maxRounds: 25,
          expiresAt: '2026-08-30T00:00:00.000Z',
          observedAt: '2026-08-29T12:00:00.000Z',
          pauseReason: null,
        }}
        approval={null}
        stopping={false}
        onStop={() => {}}
        onApproval={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Computer Useの実行状態"');
    expect(html).toContain('aria-atomic="true"');
    expect(html.match(/role="status"/gu)).toHaveLength(1);
    expect(html).toContain('aria-live="off"');
    expect(html).toContain('フルアクセス');
    expect(html).toContain('操作中');
    expect(html).toContain('Provider送信は待機中');
    expect(html).toContain('観測');
    expect(html).toContain('残り');
    expect(html).toMatch(/class="computer-use-stop"[\s\S]*停止<\/button>/);
  });

  it('offers one start-bound resume control only while paused', () => {
    const html = renderToStaticMarkup(
      <ComputerUseSessionRail
        session={{
          sessionId: 'session-1',
          appName: 'TextEdit',
          windowLabel: 'Untitled',
          mode: 'full_access_app',
          providerLabel: 'Local Vision',
          state: 'paused',
          round: 3,
          maxRounds: 25,
          expiresAt: '2026-08-30T12:00:00.000Z',
          observedAt: '2026-08-30T11:59:00.000Z',
          pauseReason: '手動操作を待っています',
        }}
        approval={null}
        stopping={false}
        resumeActivationIntent="resume-bound"
        onStop={() => {}}
        onResume={() => {}}
        onApproval={() => {}}
      />,
    );

    expect(html).toContain('対象へ戻って再開');
    expect(html).toContain('data-computer-use-activation="start"');
    expect(html).toContain('data-computer-use-intent="resume-bound"');
  });

  it('offers a bounded plan decision only when Main marks it eligible', () => {
    const render = (allowPlan: boolean) =>
      renderToStaticMarkup(
        <ComputerUseSessionRail
          session={{
            sessionId: 'session-1',
            appName: 'TextEdit',
            windowLabel: 'Untitled',
            mode: 'supervised',
            providerLabel: 'Local Vision',
            state: 'awaiting_approval',
            round: 1,
            maxRounds: 25,
            expiresAt: '2026-08-30T00:00:00.000Z',
            observedAt: '2026-08-29T12:00:00.000Z',
            pauseReason: null,
          }}
          approval={{
            id: 'approval-1',
            actionLabel: 'ボタンを押す',
            targetLabel: '保存',
            impactLabel: '対象アプリ内を変更します',
            escapedPreview: null,
            allowedDecisions: allowPlan
              ? ['allow_once', 'allow_plan', 'deny']
              : ['allow_once', 'deny'],
          }}
          stopping={false}
          onStop={() => {}}
          onApproval={() => {}}
        />,
      );

    expect(render(true)).toContain('この計画で許可');
    expect(render(false)).not.toContain('この計画で許可');
    expect(render(true)).toContain('data-computer-use-activation="approval"');
  });
});

describe('Computer Use acceptance build notice', () => {
  it('stays hidden for an ordinary build', () => {
    expect(renderToStaticMarkup(<ComputerUseAcceptanceBuildNotice acceptanceMode={null} />)).toBe(
      '',
    );
  });

  it('names the waived verification and the mode in an acceptance build', () => {
    const markup = renderToStaticMarkup(
      <ComputerUseAcceptanceBuildNotice acceptanceMode="windows-unsigned-acceptance" />,
    );

    expect(markup).toContain('受入れ専用ビルド');
    expect(markup).toContain('署名者検証');
    expect(markup).toContain('windows-unsigned-acceptance');
    expect(markup).toContain('role="status"');
  });
});

const grant: ComputerAppGrantView = {
  id: 'grant-1',
  revision: 3,
  platform: 'darwin',
  identityKind: 'verified-signed',
  publisher: 'TEAMID1234',
  appId: 'com.apple.TextEdit',
  untrustedDisplayName: 'TextEdit',
  maxMode: 'full_access_app',
  grantedAt: '2026-09-01T00:00:00.000Z',
  lastUsedAt: '2026-09-18T00:00:00.000Z',
  codeChangedAt: null,
  requestCount: 4,
  denialCount: 1,
};

describe('Computer Use granted applications', () => {
  it('shows the verified facts, the usage counts, and a revoke control per application', () => {
    const markup = renderToStaticMarkup(
      <ComputerUseGrantSection
        grants={[grant]}
        discardedRecords={0}
        requestedApps={[]}
        purgedRecords={null}
        busy={false}
        error={null}
        onRevoke={async () => {}}
        onPurge={async () => {}}
      />,
    );

    expect(markup).toContain('許可済みアプリ');
    expect(markup).toContain('TEAMID1234');
    expect(markup).toContain('com.apple.TextEdit');
    expect(markup).toContain('本人確認済み');
    expect(markup).toContain('フルアクセス');
    expect(markup).toContain('4回');
    expect(markup).toContain('拒否1回');
    // Revoking is privileged, so the control carries its own activation kind. Without it Main
    // refuses the call, which is what makes "a model cannot revoke" structural rather than a habit.
    expect(markup).toContain('data-computer-use-activation="app-grant-revoke"');
    expect(markup).toContain('許可を取り消す');
    // The application's own name is labelled as such and kept out of the verified list.
    expect(markup).toContain('アプリ自称名');
    expect(markup).toContain('aria-labelledby="computer-use-grants-title"');
  });

  it('never renders a path, a digest, or a process id', () => {
    const markup = renderToStaticMarkup(
      <ComputerUseGrantSection
        grants={[grant]}
        discardedRecords={0}
        requestedApps={[]}
        purgedRecords={null}
        busy={false}
        error={null}
        onRevoke={async () => {}}
        onPurge={async () => {}}
      />,
    );
    for (const leak of ['executablePath', '/Applications', 'Digest', 'pid'])
      expect(markup).not.toContain(leak);
  });

  it('names an unsigned application and a missing publisher rather than inventing either', () => {
    const markup = renderToStaticMarkup(
      <ComputerUseGrantSection
        grants={[
          {
            ...grant,
            identityKind: 'unverified',
            publisher: null,
            maxMode: 'supervised',
            lastUsedAt: null,
            codeChangedAt: '2026-09-19T00:00:00.000Z',
          },
        ]}
        discardedRecords={0}
        requestedApps={[]}
        purgedRecords={null}
        busy={false}
        error={null}
        onRevoke={async () => {}}
        onPurge={async () => {}}
      />,
    );

    expect(markup).toContain('未署名');
    expect(markup).toContain('確認できません');
    expect(markup).toContain('操作ごとに確認');
    expect(markup).toContain('未使用');
    expect(markup).toContain('アプリが更新されました');
  });

  it('reports discarded records as a count, and an empty list as empty', () => {
    const markup = renderToStaticMarkup(
      <ComputerUseGrantSection
        grants={[]}
        discardedRecords={2}
        requestedApps={[]}
        purgedRecords={null}
        busy={false}
        error={null}
        onRevoke={async () => {}}
        onPurge={async () => {}}
      />,
    );

    expect(markup).toContain('許可済みのアプリはありません');
    expect(markup).toContain('無効な許可レコードを2件破棄しました');
    expect(markup).toContain('role="status"');
    // The cleanup is offered only where there is something to clean up, and it carries its own
    // activation kind: Main refuses the call without one, so a model cannot delete grant rows.
    expect(markup).toContain('無効なレコードを削除');
    expect(markup).toContain('data-computer-use-activation="app-grant-purge"');
  });

  it('offers no cleanup when every stored grant authenticates, and reports one that ran', () => {
    const clean = renderToStaticMarkup(
      <ComputerUseGrantSection
        grants={[grant]}
        discardedRecords={0}
        requestedApps={[]}
        purgedRecords={null}
        busy={false}
        error={null}
        onRevoke={async () => {}}
        onPurge={async () => {}}
      />,
    );
    expect(clean).not.toContain('無効なレコードを削除');
    expect(clean).not.toContain('app-grant-purge');

    const after = renderToStaticMarkup(
      <ComputerUseGrantSection
        grants={[grant]}
        discardedRecords={0}
        requestedApps={[]}
        purgedRecords={3}
        busy={false}
        error={null}
        onRevoke={async () => {}}
        onPurge={async () => {}}
      />,
    );
    expect(after).toContain('無効な許可レコードを3件削除しました');
  });

  it('shows how often the AI asked about applications that were never granted', () => {
    const markup = renderToStaticMarkup(
      <ComputerUseGrantSection
        grants={[]}
        discardedRecords={0}
        requestedApps={[
          {
            platform: 'darwin',
            appId: 'com.example.other',
            untrustedDisplayName: 'Other',
            requestCount: 5,
            denialCount: 2,
            lastRequestedAt: '2026-09-20T00:00:00.000Z',
          },
        ]}
        purgedRecords={null}
        busy={false}
        error={null}
        onRevoke={async () => {}}
        onPurge={async () => {}}
      />,
    );
    expect(markup).toContain('許可していないアプリへの要求');
    expect(markup).toContain('com.example.other');
    expect(markup).toContain('5回');
    expect(markup).toContain('拒否2回');
    // Nothing here grants anything, so there is no control on these rows.
    expect(markup.slice(markup.indexOf('許可していないアプリへの要求'))).not.toContain('<button');
    // The application's own name stays labelled as the application's.
    expect(markup).toContain('（アプリ自称名）');
  });

  it('stays out of the onboarding dialog entirely while the agent-driven gate is off', () => {
    const off = renderToStaticMarkup(
      <ComputerUseOnboarding
        profiles={profiles}
        providers={providers}
        controlAvailable
        busy={false}
        onClose={() => {}}
        onRegister={async () => {}}
        onResolveWindows={async () => []}
        onStart={async () => {}}
      />,
    );
    expect(off).not.toContain('computer-use-grants');

    const on = renderToStaticMarkup(
      <ComputerUseOnboarding
        profiles={profiles}
        providers={providers}
        controlAvailable
        busy={false}
        grants={{ grants: [grant], discardedRecords: 0, requestedApps: [] }}
        onClose={() => {}}
        onRegister={async () => {}}
        onResolveWindows={async () => []}
        onRevokeGrant={async () => {}}
        onPurgeGrants={async () => {}}
        onStart={async () => {}}
      />,
    );
    expect(on).toContain('computer-use-grants');
    expect(on).toContain('許可を取り消す');
  });
});
