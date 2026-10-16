// @vitest-environment jsdom

/**
 * T15-10 (PR-A), the Renderer's part of the C6 acceptance (N12, N21 (d), N23): the card a person sees
 * is built from what Main published, shows where a value comes from and goes to, shows it escaped,
 * and keeps none of it anywhere that outlives the screen.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { computerUseApprovalSchema, type ComputerUseApproval } from '@sprint-coder/contracts';
import { approvalView } from '../hooks/useComputerUse';
import { ComputerUseSessionRail, type ComputerUseSessionView } from './ComputerUsePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

const cp = (value: number): string => String.fromCodePoint(value);

const session: ComputerUseSessionView = {
  sessionId: 'session-1',
  appName: 'Form',
  windowLabel: 'Untitled',
  mode: 'supervised',
  providerLabel: 'Local Vision',
  state: 'awaiting_approval',
  round: 1,
  maxRounds: 25,
  expiresAt: '2026-08-30T00:00:00.000Z',
  observedAt: '2026-08-29T12:00:00.000Z',
  pauseReason: null,
};

function card(excerpt: string): ComputerUseApproval {
  return computerUseApprovalSchema.parse({
    id: 'approval-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    actionType: 'set_text',
    actionDigest: 'a'.repeat(64),
    targetLabel: 'control:field',
    preview: '{"type":"set_text","targetId":"field","artifactRef":"artifact-1"}',
    transfer: {
      sourceLabel: 'Notes',
      destinationLabel: 'Form',
      destinationTarget: 'control:field',
      sizeClass: 'le_256',
      excerpt,
    },
    risk: 'high',
    policyEpoch: 0,
    observationRevision: 1,
    eligibleForPlan: false,
    allowedDecisions: ['allow_once', 'deny'],
    state: 'pending',
    decision: null,
    revision: 0,
    challenge: 'challenge-0123456789',
    createdAt: '2026-08-29T12:00:00.000Z',
    expiresAt: '2026-08-29T13:00:00.000Z',
  });
}

const render = (approval: ComputerUseApproval): string =>
  renderToStaticMarkup(
    <ComputerUseSessionRail
      session={session}
      approval={approvalView(approval)}
      stopping={false}
      onStop={() => {}}
      onApproval={() => {}}
    />,
  );

describe('C6 acceptance, Renderer: the card of a paste (N21 (d), N23)', () => {
  it('N21 (d): the card Main published reaches the screen with source, destination, control, size and excerpt', () => {
    const html = render(card('Total 42'));
    expect(html).toContain('Notes');
    expect(html).toContain('Form · control:field');
    expect(html).toContain('256バイト以下');
    expect(html).toContain('Total 42');
    // Only allow_once and deny are offered; there is no plan button on a paste.
    expect(html).toContain('今回のみ許可');
    expect(html).not.toContain('この計画で許可');
  });

  it('N23: the escapes Main made arrive as the text they are, and no invisible character is drawn', () => {
    const excerpt = `pay⟦U+1160⟧ to⟦U+2800⟧ bob⟦U+FE0F⟧ ⚠pаy…`;
    const html = render(card(excerpt));
    for (const shown of ['⟦U+1160⟧', '⟦U+2800⟧', '⟦U+FE0F⟧', '⚠pаy…'])
      expect(html).toContain(shown);
    for (const raw of [0x1160, 0x2800, 0xfe0f, 0x202e]) expect(html).not.toContain(cp(raw));
    // And the mixed-script mark is explained in words.
    expect(html).toContain('文字種が混在');
  });

  it('a card with no transfer shows none (a written text has no source)', () => {
    const { transfer: _transfer, ...plain } = card('x');
    const html = render(plain as ComputerUseApproval);
    expect(html).not.toContain('コピー元');
  });
});

describe('C6 acceptance, Renderer: nothing is kept (N12)', () => {
  it('mounting the rail with a copied value and a paste card writes nothing to local or session storage', async () => {
    const marker = 'MARKER-RENDERER-7f3a';
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ComputerUseSessionRail
          session={{ ...session, copied: [{ sizeClass: 'le_256', excerpt: marker }] }}
          approval={approvalView(card(marker))}
          stopping={false}
          onStop={() => {}}
          onApproval={() => {}}
        />,
      );
    });
    expect(container.textContent).toContain(marker);
    await act(async () => root.unmount());
    const stored = [localStorage, sessionStorage].flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index)!;
        return `${key}=${storage.getItem(key)}`;
      }),
    );
    expect(stored.join('\n')).not.toContain(marker);
    // After the unmount the excerpt is not on the screen either.
    expect(document.body.textContent).not.toContain(marker);
  });
});
