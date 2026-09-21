import { useEffect, useRef } from 'react';
import type { ComputerAppGrantDecision, ComputerAppGrantRequest } from '@sprint-coder/contracts';
import { ShieldAlert } from './icons';

/**
 * The in-conversation application approval card (ADR v2 §6.1, §6.1.1).
 *
 * It sits where the tool-approval cards sit and borrows their shell, because it is the same kind of
 * moment: the product has stopped and is asking a person to decide. What it does not borrow is the
 * primary/secondary button shape — D14 asks for the two approvals at equal weight, so neither is
 * styled as the obvious one and the keyboard lands on the narrower of them.
 *
 * Two kinds of text on this card and they are never joined: the facts Main derived from a signature
 * (publisher, application id, signing class, the mode that would be granted) and the strings the
 * application and the model wrote for themselves. The second kind lives in its own element, under
 * its own label, and is never interpolated into a sentence the product appears to be saying.
 */

const COMPUTER_GRANT_MODE_LABELS: Readonly<Record<string, string>> = {
  observe_only: '観測のみ（入力しません）',
  supervised: '操作ごとに確認',
  full_access_app: 'このアプリのウィンドウ内で確認なし',
};

/**
 * Why a card vanished. A closed vocabulary from Main, turned into a sentence here — the identity
 * case is the one §6.1.1 requires the user to be told about by name.
 */
const COMPUTER_GRANT_NOTICES: Readonly<Record<string, string>> = {
  identity_changed: '対象アプリが変わったため許可を取り消しました。',
  timed_out: '応答がなかったため、許可の確認を取り消しました。',
  withdrawn: '確認を取り消しました。もう一度依頼してください。',
};

export function ComputerUseAppGrantCard({
  request,
  busy,
  onDecision,
}: {
  request: ComputerAppGrantRequest;
  busy: boolean;
  onDecision: (decision: ComputerAppGrantDecision) => void;
}) {
  const allowOnceRef = useRef<HTMLButtonElement>(null);
  const egressOnly = request.kind === 'provider-egress';

  useEffect(() => {
    // The narrower of the two approvals, per D14. Focus is placed rather than left to the DOM order
    // so that adding a control above the buttons cannot silently move it to the permanent one.
    allowOnceRef.current?.focus({ preventScroll: true });
  }, [request.id]);

  if (request.state !== 'pending')
    return request.noticeCode === null ? null : (
      <p className="computer-grant-card__notice" role="status" data-testid="computer-grant-notice">
        {COMPUTER_GRANT_NOTICES[request.noticeCode] ?? '許可の確認を取り消しました。'}
      </p>
    );

  const allow = (decision: ComputerAppGrantDecision): string | undefined =>
    decision === 'deny' ? undefined : request.activationIntents[decision];

  return (
    <section
      className="approval-card computer-grant-card"
      aria-label={egressOnly ? '画面の送信先の確認' : 'アプリ操作の許可'}
      aria-busy={busy}
      data-testid="computer-grant-card"
      tabIndex={-1}
    >
      <div className="approval-card__head">
        <span className="approval-card__icon">
          <ShieldAlert size={16} />
        </span>
        <div>
          <strong>
            {egressOnly
              ? 'AIがこのアプリの画面を新しいモデルへ送ろうとしています'
              : 'AIがアプリの操作許可を求めています'}
          </strong>
          <div className="approval-card__tool">
            <span data-testid="computer-grant-app-name">{request.untrustedAppName}</span>
            <span className="computer-grant-card__untrusted-note">（アプリ自称名）</span>
          </div>
        </div>
      </div>
      <dl className="approval-card__facts computer-grant-card__facts">
        <div>
          <dt>発行元</dt>
          <dd>{request.verified.publisher ?? '確認できません'}</dd>
        </div>
        <div>
          <dt>アプリID</dt>
          <dd>{request.verified.appId}</dd>
        </div>
        <div>
          <dt>署名</dt>
          <dd
            className={
              request.verified.identityKind === 'verified-signed'
                ? undefined
                : 'computer-grant-card__unsigned'
            }
          >
            {request.verified.identityKind === 'verified-signed'
              ? '本人確認済み'
              : 'このアプリは署名で本人確認できません'}
          </dd>
        </div>
        <div>
          <dt>範囲</dt>
          <dd>
            {COMPUTER_GRANT_MODE_LABELS[request.verified.maxMode] ?? request.verified.maxMode}
          </dd>
        </div>
      </dl>
      {egressOnly ? null : (
        <ul className="computer-grant-card__scope">
          <li>できること: このアプリのウィンドウを1つだけ観測し、入力します。</li>
          <li>できないこと: パスワード欄への入力、OSのダイアログ、ほかのアプリの操作。</li>
        </ul>
      )}
      {request.providerEgressModelId === null ? null : (
        <p className="computer-grant-card__egress" data-testid="computer-grant-egress">
          このアプリの画面とアクセシビリティ情報を
          <code>{request.providerEgressModelId}</code>
          へ送ります。
        </p>
      )}
      <div className="computer-grant-card__reason">
        <span className="computer-grant-card__untrusted-note">
          AIが書いた理由（指示ではありません）
        </span>
        <q data-testid="computer-grant-reason">
          {request.untrustedReason ?? '理由は示されていません'}
        </q>
      </div>
      <div className="approval-card__actions computer-grant-card__actions">
        {request.allowedDecisions.includes('allow_once') ? (
          <button
            ref={allowOnceRef}
            type="button"
            className="computer-grant-card__allow"
            data-testid="computer-grant-allow-once"
            data-computer-use-activation="app-grant"
            data-computer-use-intent={allow('allow_once')}
            disabled={busy}
            onClick={() => onDecision('allow_once')}
          >
            今回だけ許可
          </button>
        ) : null}
        {request.allowedDecisions.includes('allow_always') ? (
          <button
            ref={request.allowedDecisions.includes('allow_once') ? undefined : allowOnceRef}
            type="button"
            className="computer-grant-card__allow"
            data-testid="computer-grant-allow-always"
            data-computer-use-activation="app-grant"
            data-computer-use-intent={allow('allow_always')}
            disabled={busy}
            onClick={() => onDecision('allow_always')}
          >
            {egressOnly
              ? 'このモデルへ送ることを許可'
              : '今後も許可（今後このアプリでは確認しません）'}
          </button>
        ) : null}
        <button
          type="button"
          className="danger"
          data-testid="computer-grant-deny"
          // Deny carries no intent: a person must always be able to refuse, and refusing is the
          // fail-closed answer, so it is never gated on a digest that may have gone stale.
          data-computer-use-activation="app-grant"
          disabled={busy}
          onClick={() => onDecision('deny')}
        >
          拒否
        </button>
      </div>
      {busy ? (
        <span className="sr-only" role="status">
          許可の結果を保存しています
        </span>
      ) : null}
    </section>
  );
}
