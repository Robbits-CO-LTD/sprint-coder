import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installSendObservationInPage,
  readSendTurnMetadata,
} from '../../tests/computer-use/send-observation';

afterEach(() => vi.unstubAllGlobals());

describe('Computer Use send observation privacy and lifetime', () => {
  it('projects only safe public Turn metadata, never snapshot text, paths or tool input', async () => {
    const secret = 'PRIVATE_PROMPT_RESPONSE_PATH_TOOL_INPUT';
    vi.stubGlobal('window', {
      sprintCoder: {
        turns: {
          snapshot: async () => ({
            activeTurn: { turnId: 'turn-1', stage: 'waiting_approval', streamedText: secret },
            lastSeq: 17,
            queued: [{ text: secret }],
            pendingApprovals: [
              { state: 'pending', target: secret, execution: secret, ephemeralExecution: secret },
              { state: 'resolved', reason: secret },
            ],
            latestTurnDiff: { path: secret },
          }),
        },
      },
    });
    const result = await readSendTurnMetadata('task-1');
    expect(result).toEqual({
      status: 'available',
      activeTurnId: 'turn-1',
      stage: 'waiting_approval',
      lastSeq: 17,
      queuedCount: 1,
      approvalCounts: { pending: 1, resolved: 1, canceled: 0, stale: 0, expired: 0 },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('records unavailable without copying an IPC error', async () => {
    vi.stubGlobal('window', {
      sprintCoder: {
        turns: {
          snapshot: async () => {
            throw new Error('PRIVATE_ERROR');
          },
        },
      },
    });
    expect(await readSendTurnMetadata('task-1')).toEqual({ status: 'unavailable' });
  });

  it('caps passive input evidence and detaches without changing input', () => {
    class TestElement {
      constructor(readonly testId: string) {}
      closest(selector: string) {
        return selector === `[data-testid="${this.testId}"]` ? this : null;
      }
    }
    class TestMouseEvent extends Event {
      clientX = 12;
      clientY = 34;
    }
    const privateDraft = 'PRIVATE_DRAFT_BODY';
    const draft = { value: privateDraft, disabled: false };
    const send = Object.assign(new TestElement('composer-send-button'), {
      disabled: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }),
    });
    class TestDocument extends EventTarget {
      activeElement = new TestElement('composer-textarea');
      hasFocus = () => true;
      querySelector(selector: string) {
        if (selector === '[data-testid="composer-send-button"]') return send;
        if (selector === '[data-testid="composer-textarea"]') return draft;
        return null;
      }
      querySelectorAll = () => [];
    }
    const document = new TestDocument();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    vi.stubGlobal('document', document);
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal('window', { matchMedia });
    vi.stubGlobal('Element', TestElement);
    vi.stubGlobal('MouseEvent', TestMouseEvent);
    installSendObservationInPage();
    expect(add.mock.calls).toHaveLength(3);
    for (const call of add.mock.calls) expect(call[2]).toEqual({ capture: true, passive: true });
    for (let index = 0; index < 30; index += 1)
      document.dispatchEvent(new TestMouseEvent('pointerdown'));
    const click = new TestMouseEvent('click', { cancelable: true });
    Object.defineProperty(click, 'target', { value: send });
    document.dispatchEvent(click);
    draft.value = '';
    const probe = window.__sprintSendObservation!;
    const captured = probe.read();
    expect(click.defaultPrevented).toBe(false);
    expect(captured.events).toHaveLength(24);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(captured.dom.prefersReducedMotion).toBe(true);
    expect(captured.events.every((event) => event.prefersReducedMotion === true)).toBe(true);
    expect(captured.events.at(-1)).toMatchObject({
      type: 'click',
      draftLength: privateDraft.length,
    });
    expect(captured.dom.draftLength).toBe(0);
    expect(JSON.stringify(captured)).not.toContain(privateDraft);
    matchMedia.mockReturnValue({ matches: false });
    expect(probe.read().dom.prefersReducedMotion).toBe(false);
    probe.stop();
    expect(remove.mock.calls).toHaveLength(3);
    document.dispatchEvent(new TestMouseEvent('pointerdown'));
    expect(probe.read().events).toEqual(captured.events);
  });
});
