// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computerAppGrantRequestSchema,
  type ComputerAppGrantDecision,
  type ComputerAppGrantRequest,
} from '@sprint-coder/contracts';
import { appGrantActivationIntent } from '../../computer-use-activation-intent';
import { ComputerUseAppGrantCard } from './ComputerUseAppGrantCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where the keyboard is when the card appears.
 *
 * The card arrives on the model's schedule and grants a real permission, so the rule is absolute:
 * it takes nothing. Not the caret, not the window's keyboard focus. Whatever the user was in the
 * middle of — in this window or in another application — their next keystroke belongs to that, and
 * an approval has to be something they went and did.
 */

function card(overrides: Partial<ComputerAppGrantRequest> = {}): ComputerAppGrantRequest {
  return computerAppGrantRequestSchema.parse({
    id: 'request-1',
    taskId: 'task-1',
    kind: 'app-grant',
    state: 'pending',
    revision: 1,
    decision: null,
    noticeCode: null,
    verified: {
      platform: 'darwin',
      identityKind: 'verified-signed',
      publisher: 'TEAMID1234',
      appId: 'com.example.notes',
      maxMode: 'full_access_app',
    },
    untrustedAppName: 'Notes',
    untrustedReason: 'copy the table',
    providerEgressModelId: 'vision-model',
    allowedDecisions: ['allow_once', 'allow_always', 'deny'],
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
    ...overrides,
  });
}

function mountCard(request: ComputerAppGrantRequest = card()): {
  container: HTMLElement;
  decisions: ComputerAppGrantDecision[];
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const decisions: ComputerAppGrantDecision[] = [];
  act(() => {
    root.render(
      <ComputerUseAppGrantCard
        request={request}
        busy={false}
        onDecision={(decision) => decisions.push(decision)}
      />,
    );
  });
  return {
    container,
    decisions,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** What a Space or an Enter does to whatever currently has focus. */
function pressActivationKey(key: ' ' | 'Enter'): void {
  const active = document.activeElement;
  if (active === null) return;
  act(() => {
    active.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    // A button treats Space/Enter as a click; jsdom does not synthesise that, so the test does,
    // which is the pessimistic reading: if a button had focus, this would approve.
    if (active instanceof HTMLButtonElement) active.click();
    active.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('application approval card focus', () => {
  it('takes no focus at all when it appears', () => {
    const before = document.activeElement;
    const view = mountCard();
    expect(document.activeElement).toBe(before);
    for (const testId of [
      'computer-grant-allow-once',
      'computer-grant-allow-always',
      'computer-grant-deny',
    ])
      expect(document.activeElement).not.toBe(
        view.container.querySelector(`[data-testid="${testId}"]`),
      );
    view.unmount();
  });

  it('approves nothing on the keystroke that follows it', () => {
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();

    const view = mountCard();
    // The user was writing; the card appeared; the next key is still theirs.
    expect(document.activeElement).toBe(composer);
    pressActivationKey(' ');
    pressActivationKey('Enter');
    expect(view.decisions).toEqual([]);
    view.unmount();
    composer.remove();
  });

  it('approves nothing when the keystroke follows the window coming forward', () => {
    // Nothing in this document has focus, which is what a window that was just shown looks like.
    (document.activeElement as HTMLElement | null)?.blur();
    const view = mountCard();
    pressActivationKey('Enter');
    expect(view.decisions).toEqual([]);
    // Still reachable deliberately: the pointer, or Tab.
    const allowOnce = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="computer-grant-allow-once"]',
    );
    allowOnce?.focus();
    allowOnce?.click();
    expect(view.decisions).toEqual(['allow_once']);
    view.unmount();
  });

  it('announces itself politely instead', () => {
    const view = mountCard();
    const announcement = view.container.querySelector('[data-testid="computer-grant-announce"]');
    expect(announcement?.getAttribute('aria-live')).toBe('polite');
    expect(announcement?.getAttribute('role')).toBe('status');
    expect(announcement?.textContent).toContain('許可');
    // The card itself is labelled, so a screen reader can describe it once the user arrives.
    expect(
      view.container
        .querySelector('[data-testid="computer-grant-card"]')
        ?.getAttribute('aria-label'),
    ).toBe('アプリ操作の許可');
    view.unmount();
  });

  it('never calls focus on any of its own controls', () => {
    // A stronger statement than "nothing has focus afterwards": the component must not be reaching
    // for focus at all, whatever the document around it happens to look like.
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const view = mountCard();
    expect(focusSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
    view.unmount();
  });
});
