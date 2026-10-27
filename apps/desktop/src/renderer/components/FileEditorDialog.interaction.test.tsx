// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FileOpenResult, FileSaveResult, SprintCoderApi } from '../types/sprint-coder';
import { FileEditorDialog } from './FileEditorDialog';

type FilesApi = SprintCoderApi['files'];

const ORIGINAL_DIGEST = 'a'.repeat(64);
const RELOADED_DIGEST = 'c'.repeat(64);
const SAVED: FileSaveResult = {
  outcome: 'saved',
  digest: 'b'.repeat(64),
  reason: null,
  conflictPath: null,
};

function opened(text: string, digest: string): FileOpenResult {
  return { rootId: 'root-1', path: 'synthetic.txt', text, digest, editable: true, reason: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let save: Mock<FilesApi['save']>;
let open: Mock<FilesApi['open']>;
let pendingSave: ReturnType<typeof deferred<FileSaveResult>>;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  pendingSave = deferred<FileSaveResult>();
  save = vi.fn<FilesApi['save']>(() => pendingSave.promise);
  open = vi.fn<FilesApi['open']>(async () => opened('reloaded\n', RELOADED_DIGEST));
  const files: Pick<FilesApi, 'pick' | 'open' | 'recover' | 'save'> = {
    pick: vi.fn<FilesApi['pick']>(async () => opened('original\n', ORIGINAL_DIGEST)),
    open,
    recover: vi.fn<FilesApi['recover']>(),
    save,
  };
  Object.defineProperty(window, 'sprintCoder', { configurable: true, value: { files } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<FileEditorDialog taskId="task-1" hasWorkspace />));
  await click(container.querySelector<HTMLButtonElement>('[data-testid="open-file-button"]')!);
  edit('edited\n');
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.unstubAllGlobals();
});

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

function textarea(): HTMLTextAreaElement {
  return dialog()!.querySelector<HTMLTextAreaElement>('textarea')!;
}

function status(): string {
  return dialog()!.querySelector('.file-editor-footer [role="status"]')!.textContent ?? '';
}

function closeButton(): HTMLButtonElement {
  return dialog()!.querySelector<HTMLButtonElement>('[aria-label="ファイル編集を閉じる"]')!;
}

function footerButton(label: string): HTMLButtonElement {
  return [...dialog()!.querySelectorAll<HTMLButtonElement>('.file-editor-footer button')].find(
    (button) => button.textContent === label,
  )!;
}

function confirmation(): HTMLElement | null {
  return dialog()?.querySelector<HTMLElement>('.file-editor-discard') ?? null;
}

function discardButton(): HTMLButtonElement | null {
  return confirmation()?.querySelector<HTMLButtonElement>('button.danger') ?? null;
}

function backToEditButton(): HTMLButtonElement {
  return confirmation()!.querySelector<HTMLButtonElement>('button:not(.danger)')!;
}

function edit(value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea(),
      value,
    );
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function keydown(target: HTMLElement, key: string, ctrlKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function settleSave(result: FileSaveResult | Error): Promise<void> {
  await act(async () => {
    if (result instanceof Error) pendingSave.reject(result);
    else pendingSave.resolve(result);
  });
}

describe('FileEditorDialog while a save is in flight (issue #958)', () => {
  it('keeps header close and Escape from offering a discard, then closes after a late success', async () => {
    await click(footerButton('保存'));
    let escape!: KeyboardEvent;
    await act(async () => {
      escape = keydown(textarea(), 'Escape');
    });

    expect(escape.defaultPrevented).toBe(true);
    expect(confirmation()).toBeNull();
    expect(document.body.textContent).not.toContain('破棄して閉じる');
    await click(closeButton());
    expect(dialog()).not.toBeNull();
    expect(confirmation()).toBeNull();
    expect(closeButton().disabled).toBe(true);
    expect(status()).toBe('保存中…');

    await settleSave(SAVED);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      taskId: 'task-1',
      rootId: 'root-1',
      path: 'synthetic.txt',
      text: 'edited\n',
      baseDigest: ORIGINAL_DIGEST,
    });
    expect(status()).toBe('保存しました');
    expect(textarea().value).toBe('edited\n');
    expect(closeButton().disabled).toBe(false);
    await act(async () => {
      keydown(textarea(), 'Escape');
    });
    expect(dialog()).toBeNull();
  });

  it.each([
    ['close', '閉じますか？', () => closeButton()],
    ['reload', '再読み込みしますか？', () => footerButton('再読み込み')],
  ] as const)(
    'withdraws a %s discard confirmation that was open when the save started',
    async (_kind, prompt, entry) => {
      await click(entry());
      expect(confirmation()?.textContent).toContain(prompt);

      await click(footerButton('保存'));

      expect(confirmation()).toBeNull();
      expect(discardButton()).toBeNull();
      await settleSave(SAVED);
      expect(dialog()).not.toBeNull();
      expect(status()).toBe('保存しました');
      expect(open).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['close', () => closeButton()],
    ['reload', () => footerButton('再読み込み')],
  ] as const)(
    'refuses a second save and a %s discard fired in the same tick as the save',
    async (_kind, entry) => {
      await click(entry());
      const discard = discardButton()!;

      await act(async () => {
        footerButton('保存').click();
        keydown(textarea(), 's', true);
        discard.click();
        closeButton().click();
        footerButton('再読み込み').click();
        keydown(textarea(), 'Escape');
      });

      expect(save).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      expect(confirmation()).toBeNull();
      expect(textarea().value).toBe('edited\n');
      expect(status()).toBe('保存中…');

      await settleSave(SAVED);
      expect(status()).toBe('保存しました');
    },
  );

  it.each([
    [
      'conflict',
      { outcome: 'conflict', digest: null, reason: null, conflictPath: null },
      '他の処理で変更されました。上書きせず、再読み込みできます。',
    ],
    [
      'refused',
      { outcome: 'refused', digest: null, reason: 'io_error', conflictPath: null },
      '保存できませんでした。ファイルとProjectの状態を確認してください。',
    ],
    ['reject', new Error('ipc failed'), '保存に失敗しました。内容は画面に残っています。'],
  ] as const)(
    'keeps the draft after a late %s and only then allows retry or an explicit discard',
    async (_kind, result, message) => {
      await click(footerButton('保存'));
      await act(async () => {
        keydown(textarea(), 'Escape');
      });
      expect(confirmation()).toBeNull();

      await settleSave(result);

      expect(status()).toBe(message);
      expect(textarea().value).toBe('edited\n');
      expect(textarea().disabled).toBe(false);
      expect(footerButton('保存').disabled).toBe(false);
      expect(closeButton().disabled).toBe(false);

      await click(closeButton());
      expect(confirmation()?.textContent).toContain('閉じますか？');
      await click(discardButton()!);
      expect(dialog()).toBeNull();
      expect(save).toHaveBeenCalledTimes(1);
    },
  );
});

describe('FileEditorDialog dirty confirmations before a save (issue #958 AC-3)', () => {
  it('asks before closing, returns to the draft, and discards only when confirmed', async () => {
    await click(closeButton());
    expect(confirmation()?.textContent).toContain('未保存の変更を破棄して閉じますか？');

    await click(backToEditButton());
    expect(confirmation()).toBeNull();
    expect(textarea().value).toBe('edited\n');

    await act(async () => {
      keydown(textarea(), 'Escape');
    });
    expect(confirmation()?.textContent).toContain('閉じますか？');
    await click(discardButton()!);

    expect(dialog()).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('asks before reloading, returns to the draft, and reloads only when confirmed', async () => {
    await click(footerButton('再読み込み'));
    expect(confirmation()?.textContent).toContain('未保存の変更を破棄して再読み込みしますか？');

    await click(backToEditButton());
    expect(textarea().value).toBe('edited\n');
    expect(open).not.toHaveBeenCalled();

    await click(footerButton('再読み込み'));
    await click(discardButton()!);

    expect(open).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('reloaded\n');
    expect(status()).toBe('読み込みました');
    expect(save).not.toHaveBeenCalled();
  });
});
