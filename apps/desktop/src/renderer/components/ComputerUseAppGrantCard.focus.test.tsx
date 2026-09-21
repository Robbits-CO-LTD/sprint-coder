// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computerAppGrantRequestSchema,
  type ComputerAppGrantRequest,
} from '@sprint-coder/contracts';
import { appGrantActivationIntent } from '../../computer-use-activation-intent';
import { ComputerUseAppGrantCard, isEditingElsewhere } from './ComputerUseAppGrantCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where the caret goes when the card appears.
 *
 * The card arrives unannounced and Main raises the window with it, so this is the difference
 * between a control the user reaches deliberately and one their next keystroke presses.
 */

const card: ComputerAppGrantRequest = computerAppGrantRequestSchema.parse({
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
});

function mountCard(): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ComputerUseAppGrantCard request={card} busy={false} onDecision={() => {}} />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('application approval card focus', () => {
  it('lands on the narrower approval when nobody is typing', () => {
    const view = mountCard();
    expect(document.activeElement).toBe(
      view.container.querySelector('[data-testid="computer-grant-allow-once"]'),
    );
    view.unmount();
  });

  it('leaves the caret alone when the user is writing', () => {
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();
    expect(document.activeElement).toBe(composer);

    const view = mountCard();
    // The next Space or Enter has to reach the message being written, not "今回だけ許可".
    expect(document.activeElement).toBe(composer);
    // The card is still on screen and still announced by its role and label.
    expect(view.container.querySelector('[data-testid="computer-grant-card"]')).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="computer-grant-allow-once"]'),
    ).not.toBeNull();
    view.unmount();
    composer.remove();
  });

  it('knows which elements take a keystroke as text', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(editable);
    const disabled = document.createElement('input');
    disabled.disabled = true;
    document.body.append(disabled);
    const button = document.createElement('button');
    document.body.append(button);

    expect(isEditingElsewhere(document.createElement('textarea'))).toBe(true);
    expect(isEditingElsewhere(document.createElement('input'))).toBe(true);
    expect(isEditingElsewhere(document.createElement('select'))).toBe(true);
    expect(isEditingElsewhere(editable)).toBe(true);
    // Not editing: a button takes a keystroke as a press, and a disabled field takes none.
    expect(isEditingElsewhere(button)).toBe(false);
    expect(isEditingElsewhere(disabled)).toBe(false);
    expect(isEditingElsewhere(null)).toBe(false);
  });
});
