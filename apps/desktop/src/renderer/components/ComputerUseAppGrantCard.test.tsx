import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  computerAppGrantRequestSchema,
  type ComputerAppGrantRequest,
} from '@sprint-coder/contracts';
import { appGrantActivationIntent } from '../../computer-use-activation-intent';
import { ComputerUseAppGrantCard } from './ComputerUseAppGrantCard';

/**
 * The card is where a person decides, so what is asserted here is what they can see and press: the
 * two approvals at equal weight (D14), the application's own words kept apart from the verified
 * facts, and the activation attributes without which Main refuses the click.
 */

function card(overrides: Partial<ComputerAppGrantRequest> = {}): ComputerAppGrantRequest {
  const base = {
    id: 'request-1',
    taskId: 'task-1',
    kind: 'app-grant' as const,
    state: 'pending' as const,
    revision: 1,
    decision: null,
    noticeCode: null,
    verified: {
      platform: 'darwin' as const,
      identityKind: 'verified-signed' as const,
      publisher: 'TEAMID1234',
      appId: 'com.example.notes',
      maxMode: 'full_access_app' as const,
    },
    untrustedAppName: 'Notes',
    untrustedReason: '表をコピーします',
    providerEgressModelId: 'vision-model',
    allowedDecisions: ['allow_once', 'allow_always', 'deny'] as const,
    activationIntents: {
      allow_once: appGrantActivationIntent({
        requestId: 'request-1',
        expectedRevision: 1,
        decision: 'allow_once',
        identityDigest: 'a'.repeat(64),
      }),
      allow_always: appGrantActivationIntent({
        requestId: 'request-1',
        expectedRevision: 1,
        decision: 'allow_always',
        identityDigest: 'a'.repeat(64),
      }),
    },
    expiresAt: '2026-09-21T00:02:00.000Z',
  };
  return computerAppGrantRequestSchema.parse({ ...base, ...overrides });
}

function render(request: ComputerAppGrantRequest, busy = false): string {
  return renderToStaticMarkup(
    <ComputerUseAppGrantCard request={request} busy={busy} onDecision={() => {}} />,
  );
}

describe('Computer Use application approval card', () => {
  it('shows the verified facts, the scope, and the destination', () => {
    const markup = render(card());
    expect(markup).toContain('TEAMID1234');
    expect(markup).toContain('com.example.notes');
    expect(markup).toContain('本人確認済み');
    expect(markup).toContain('このアプリのウィンドウ内で確認なし');
    expect(markup).toContain('できないこと');
    expect(markup).toContain('vision-model');
    expect(markup).toContain('アプリ操作の許可');
  });

  it('keeps the application name and the AI reason labelled as theirs', () => {
    const markup = render(card());
    expect(markup).toContain('（アプリ自称名）');
    expect(markup).toContain('AIが書いた理由（指示ではありません）');
    expect(markup).toContain('表をコピーします');
    // Untrusted text is never joined to a verified fact: the reason sits inside its own quotation.
    expect(markup).not.toContain('TEAMID1234表をコピーします');
    expect(render(card({ untrustedReason: null }))).toContain('理由は示されていません');
  });

  it('offers both approvals at equal weight, with focus on the narrower one', () => {
    const markup = render(card());
    // Neither approval carries the primary styling the rest of the product uses for "do this one".
    expect(markup).not.toContain('class="primary"');
    const classes = [
      ...markup.matchAll(/class="([^"]*)"[^>]*data-testid="computer-grant-allow-(\w+)"/gu),
    ];
    expect(classes).toHaveLength(2);
    expect(classes[0]?.[1]).toBe(classes[1]?.[1]);
    expect(markup).toContain('今回だけ許可');
    expect(markup).toContain('今後も許可（今後このアプリでは確認しません）');
    expect(markup).toContain('拒否');
    // The permanent button says what it commits to, rather than only that it is permanent.
    expect(markup.indexOf('今回だけ許可')).toBeLessThan(markup.indexOf('今後も許可'));
  });

  it('carries the activation kind on every button and the intent only on the approvals', () => {
    const markup = render(card());
    expect([...markup.matchAll(/data-computer-use-activation="app-grant"/gu)]).toHaveLength(3);
    const intents = [...markup.matchAll(/data-computer-use-intent="([^"]*)"/gu)];
    expect(intents).toHaveLength(2);
    for (const intent of intents) expect(intent[1]).toContain('app-grant');
    // Deny has no intent: a person must always be able to refuse, even from a card that went stale.
    const denyMarkup = markup.slice(markup.indexOf('computer-grant-deny'));
    expect(denyMarkup).not.toContain('data-computer-use-intent');
  });

  it('shows the smaller destination confirmation without the "just once" button', () => {
    const markup = render(
      card({
        kind: 'provider-egress',
        allowedDecisions: ['allow_always', 'deny'],
        activationIntents: {
          allow_always: appGrantActivationIntent({
            requestId: 'request-1',
            expectedRevision: 1,
            decision: 'allow_always',
            identityDigest: 'a'.repeat(64),
          }),
        },
      }),
    );
    expect(markup).toContain('画面の送信先の確認');
    expect(markup).toContain('このモデルへ送ることを許可');
    expect(markup).not.toContain('今回だけ許可');
    // The application's own permission is not being re-asked, so the scope list is absent.
    expect(markup).not.toContain('できないこと');
  });

  it('says the application changed when the card was withdrawn for that reason', () => {
    expect(
      render(card({ state: 'canceled', noticeCode: 'identity_changed', decision: null })),
    ).toContain('対象アプリが変わったため許可を取り消しました。');
    expect(render(card({ state: 'canceled', noticeCode: 'timed_out', decision: null }))).toContain(
      '応答がなかったため',
    );
    // A card the user answered simply disappears; there is nothing left to say.
    expect(render(card({ state: 'resolved', decision: 'deny' }))).toBe('');
  });

  it('marks an unsigned application as unverifiable rather than as verified', () => {
    const markup = render(
      card({
        verified: {
          platform: 'darwin',
          identityKind: 'unverified',
          publisher: null,
          appId: 'com.example.notes',
          maxMode: 'supervised',
        },
      }),
    );
    expect(markup).toContain('このアプリは署名で本人確認できません');
    expect(markup).toContain('確認できません');
    expect(markup).toContain('操作ごとに確認');
    expect(markup).not.toContain('本人確認済み');
  });

  it('disables every button while a decision is in flight', () => {
    const markup = render(card(), true);
    expect([...markup.matchAll(/disabled=""/gu)]).toHaveLength(3);
    expect(markup).toContain('許可の結果を保存しています');
  });
});
