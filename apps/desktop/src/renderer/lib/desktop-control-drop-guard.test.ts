// @vitest-environment jsdom
import type { DesktopControlActivity } from '@sprint-coder/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { installDesktopControlDropGuard } from './desktop-control-drop-guard';

// jsdom has no DragEvent or DataTransfer: a cancelable bubbling event carrying the least of one.
function dragEvent(
  type: string,
  transfer: { dropEffect: string; text?: string; files?: string[] },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return event;
}

// What an element does by default with a drop it is given, unless the drop was cancelled: a
// textarea inserts the dragged text, the window takes in the dropped files.
function insertsOnDrop(textarea: HTMLTextAreaElement, filesTaken: string[]) {
  const onDrop = (event: Event) => {
    const transfer = (event as Event & { dataTransfer: { text?: string; files?: string[] } })
      .dataTransfer;
    queueMicrotask(() => {
      if (event.defaultPrevented) return;
      if (transfer.text !== undefined) textarea.value += transfer.text;
      filesTaken.push(...(transfer.files ?? []));
    });
  };
  textarea.addEventListener('drop', onDrop);
  return () => textarea.removeEventListener('drop', onDrop);
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

function setup() {
  let send: (activity: DesktopControlActivity) => void = () => undefined;
  let subscribed = 0;
  cleanups.push(
    installDesktopControlDropGuard(window, (listener) => {
      send = listener;
      subscribed += 1;
      return () => {
        subscribed -= 1;
      };
    }),
  );
  const textarea = document.createElement('textarea');
  textarea.value = 'typed';
  document.body.append(textarea);
  const files: string[] = [];
  cleanups.push(insertsOnDrop(textarea, files));
  return {
    send: (active: boolean) => send({ active }),
    textarea,
    files,
    subscribed: () => subscribed,
  };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('desktop-control drop guard', () => {
  it('refuses text and file drops anywhere in the window while a desktop-control run goes on', async () => {
    const { send, textarea, files } = setup();
    send(true);
    for (const type of ['dragenter', 'dragover'] as const) {
      const transfer = { dropEffect: 'copy' };
      const event = dragEvent(type, transfer);
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      // The drop is not accepted, so the drag ends cancelled.
      expect(transfer.dropEffect).toBe('none');
    }
    let reachedTextarea = false;
    const seen = () => {
      reachedTextarea = true;
    };
    textarea.addEventListener('drop', seen);
    const drop = dragEvent('drop', { dropEffect: 'copy', text: ' dropped', files: ['a.txt'] });
    textarea.dispatchEvent(drop);
    await flush();
    expect(drop.defaultPrevented).toBe(true);
    // Stopped in the capture phase, before the element's own handlers.
    expect(reachedTextarea).toBe(false);
    expect(textarea.value).toBe('typed');
    expect(files).toEqual([]);
    textarea.removeEventListener('drop', seen);

    // The same on a contenteditable and on the document itself.
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.append(editable);
    for (const target of [editable, document.body]) {
      const event = dragEvent('drop', { dropEffect: 'copy', text: 'x' });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('leaves drag and drop as it was when no run goes on, and after a run ends', async () => {
    const { send, textarea, files } = setup();
    const before = dragEvent('drop', { dropEffect: 'copy', text: ' mine' });
    textarea.dispatchEvent(before);
    await flush();
    expect(before.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('typed mine');

    send(true);
    send(false);
    const over = dragEvent('dragover', { dropEffect: 'copy' });
    textarea.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    const after = dragEvent('drop', { dropEffect: 'copy', text: ' again', files: ['b.txt'] });
    textarea.dispatchEvent(after);
    await flush();
    expect(after.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('typed mine again');
    expect(files).toEqual(['b.txt']);
  });

  it('stops listening and accepts drops again once removed', async () => {
    const { send, textarea, subscribed } = setup();
    send(true);
    expect(subscribed()).toBe(1);
    cleanups.shift()?.();
    expect(subscribed()).toBe(0);
    const drop = dragEvent('drop', { dropEffect: 'copy', text: ' later' });
    textarea.dispatchEvent(drop);
    await flush();
    expect(drop.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('typed later');
  });

  it('works without the bridge, accepting every drop', () => {
    cleanups.push(installDesktopControlDropGuard(window, undefined));
    const drop = dragEvent('drop', { dropEffect: 'copy' });
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
  });
});
