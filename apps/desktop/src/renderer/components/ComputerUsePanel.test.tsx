import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
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
        }}
        busy={false}
        onClose={() => {}}
        onRetry={async () => {}}
      />,
    );

    expect(html).toContain('OSの許可が必要です');
    expect(html).toContain('画面収録');
    expect(html).toContain('アクセシビリティ');
    expect(html).toContain('autofocus=""');
    expect(html).toContain('許可を再確認');
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
