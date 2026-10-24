import type { Page, TestInfo } from '@playwright/test';

type Primitive = string | number | boolean | null;
type DomMetadata = Record<string, Primitive>;
type BrowserObservation = { events: DomMetadata[]; dom: DomMetadata };

declare global {
  interface Window {
    __sprintSendObservation?: {
      read(): BrowserObservation;
      stop(): void;
    };
  }
}

// Self-contained for page.evaluate: observe native input without changing routing or handlers.
export function installSendObservationInPage(): void {
  window.__sprintSendObservation?.stop();
  const events: DomMetadata[] = [];
  let stopped = false;
  const category = (target: EventTarget | null): string => {
    if (!(target instanceof Element)) return 'none';
    for (const id of ['composer-send-button', 'composer-textarea', 'team-back', 'graph-panel'])
      if (target.closest(`[data-testid="${id}"]`)) return id;
    if (target.closest('.surface--node')) return 'leader';
    if (target.closest('.team-canvas')) return 'canvas';
    return target.closest('button,input,textarea,select,a') ? 'other-control' : 'other';
  };
  const number = (value: number | undefined): number | null =>
    value !== undefined && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const dom = (): DomMetadata => {
    const send = document.querySelector<HTMLButtonElement>('[data-testid="composer-send-button"]');
    const draft = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]');
    const rect = send?.getBoundingClientRect();
    const selected = document.querySelector<HTMLElement>('.sb-row.active[data-task-id]')?.dataset
      .taskId;
    const transform = document.querySelector<HTMLElement>('.team-world')?.style.transform;
    const camera = transform?.match(
      /^translate\(([-\d.e+]+)px,\s*([-\d.e+]+)px\) scale\(([-\d.e+]+)\)$/u,
    );
    return {
      activeTaskId: selected && /^[0-9a-f-]{36}$/iu.test(selected) ? selected : null,
      focused: document.hasFocus(),
      focusTarget: category(document.activeElement),
      sendPresent: send !== null,
      sendDisabled: send?.disabled ?? null,
      sendBusy: send?.getAttribute('aria-busy') === 'true',
      sendX: number(rect?.x),
      sendY: number(rect?.y),
      sendWidth: number(rect?.width),
      sendHeight: number(rect?.height),
      draftLength: draft?.value.length ?? null,
      draftDisabled: draft?.disabled ?? null,
      operationErrorCount: document.querySelectorAll('.composer-operation-error').length,
      userMessageCount: document.querySelectorAll('[data-testid="user-message"]').length,
      assistantMessageCount: document.querySelectorAll('[data-testid="assistant-message"]').length,
      streamingAssistantMessageCount: document.querySelectorAll(
        '[data-testid="streaming-assistant-message"]',
      ).length,
      cameraX: camera ? number(Number(camera[1])) : null,
      cameraY: camera ? number(Number(camera[2])) : null,
      cameraScale: camera ? number(Number(camera[3])) : null,
    };
  };
  const record = (event: Event, afterClick = false): void => {
    if (stopped) return;
    try {
      events.push({
        ...dom(),
        type: afterClick ? 'click-microtask' : event.type,
        trusted: event.isTrusted,
        target: category(event.target),
        atMs: number(performance.now()),
        clientX: event instanceof MouseEvent ? number(event.clientX) : null,
        clientY: event instanceof MouseEvent ? number(event.clientY) : null,
      });
      if (events.length > 24) events.shift();
      if (
        !afterClick &&
        event.type === 'click' &&
        category(event.target) === 'composer-send-button'
      )
        queueMicrotask(() => record(event, true));
    } catch {
      // An optional observer must not affect the application's input dispatch.
    }
  };
  const listener = (event: Event): void => record(event);
  for (const type of ['pointerdown', 'pointerup', 'click'])
    document.addEventListener(type, listener, { capture: true, passive: true });
  window.__sprintSendObservation = {
    read: () => ({ events: events.slice(), dom: dom() }),
    stop: () => {
      stopped = true;
      for (const type of ['pointerdown', 'pointerup', 'click'])
        document.removeEventListener(type, listener, true);
    },
  };
}

export async function installSendObservation(page: Page): Promise<void> {
  await boundedDomProbe(page.evaluate(installSendObservationInPage));
}

export async function freezeSendObservation(page: Page): Promise<unknown> {
  return boundedDomProbe(
    page.evaluate(() => {
      const probe = window.__sprintSendObservation;
      if (!probe) return { status: 'unavailable' };
      probe.stop();
      return { status: 'available', ...probe.read() };
    }),
  );
}

async function boundedDomProbe(probe: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe.catch(() => ({ status: 'unavailable' })),
      new Promise<{ status: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), 1000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// The public snapshot contains text, targets and tool inputs: project only this safe allowlist.
export async function readSendTurnMetadata(taskId: string | null) {
  if (!taskId || !window.sprintCoder) return { status: 'unavailable' as const };
  try {
    const snapshot = await window.sprintCoder.turns.snapshot(taskId);
    return {
      status: 'available' as const,
      activeTurnId: snapshot.activeTurn?.turnId ?? null,
      stage: snapshot.activeTurn?.stage ?? null,
      lastSeq: snapshot.lastSeq,
      queuedCount: snapshot.queued.length,
      approvalCounts: {
        pending: snapshot.pendingApprovals.filter((approval) => approval.state === 'pending')
          .length,
        resolved: snapshot.pendingApprovals.filter((approval) => approval.state === 'resolved')
          .length,
        canceled: snapshot.pendingApprovals.filter((approval) => approval.state === 'canceled')
          .length,
        stale: snapshot.pendingApprovals.filter((approval) => approval.state === 'stale').length,
        expired: snapshot.pendingApprovals.filter((approval) => approval.state === 'expired')
          .length,
      },
    };
  } catch {
    return { status: 'unavailable' as const };
  }
}

export async function attachSendObservation(
  page: Page | null,
  taskId: string | null,
  afterClick: unknown,
  testInfo: TestInfo,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const capture = async () => {
      if (!page || page.isClosed()) return { status: 'unavailable' };
      const finalDom = await page
        .evaluate(() => {
          const probe = window.__sprintSendObservation;
          if (!probe) return { status: 'unavailable' };
          probe.stop();
          try {
            return { status: 'available', ...probe.read() };
          } finally {
            delete window.__sprintSendObservation;
          }
        })
        .catch(() => ({ status: 'unavailable' }));
      return { finalDom, turn: await page.evaluate(readSendTurnMetadata, taskId) };
    };
    const final = await Promise.race([
      capture().catch(() => ({ status: 'unavailable' })),
      new Promise<{ status: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), 3000);
      }),
    ]);
    await testInfo.attach('send-observation', {
      body: JSON.stringify({ expectedTaskId: taskId, afterClick, final }),
      contentType: 'application/json',
    });
  } catch {
    // Capture/attachment failure must never replace the original test result.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
