// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SprintCoderApi } from '@sprint-coder/contracts';
import { activeTheme, setTheme } from '../lib/theme';
import { ThemeSetting } from './ThemeSetting';

let container: HTMLDivElement;
let root: Root;
const set = vi.fn<SprintCoderApi['theme']['set']>();

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.documentElement.removeAttribute('data-theme');
  set.mockClear();
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { theme: { set } } as unknown as SprintCoderApi,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ThemeSetting />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'sprintCoder');
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

const radio = (id: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="settings-theme-${id}"]`)!;

it('offers 黒, 灰色 and 白 as one group of radio buttons, 黒 chosen when nothing was', () => {
  const group = container.querySelector('fieldset[data-testid="settings-theme"]')!;
  expect(group.querySelector('legend')?.textContent).toBe('テーマ');
  const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.map((input) => input.closest('label')?.textContent)).toEqual(['黒', '灰色', '白']);
  expect(new Set(radios.map((input) => input.name)).size).toBe(1);
  expect(radios.map((input) => input.checked)).toEqual([true, false, false]);
});

it("draws each choice in that theme's own colours, hidden from assistive technology", () => {
  const previews = [...container.querySelectorAll<HTMLElement>('.theme-preview')];
  expect(previews.map((preview) => preview.getAttribute('data-theme'))).toEqual([
    'black',
    'gray',
    'white',
  ]);
  for (const preview of previews) expect(preview.getAttribute('aria-hidden')).toBe('true');
});

it('recolours the window at once and tells Main, which keeps the choice', async () => {
  await act(async () => radio('white').click());
  expect(document.documentElement.getAttribute('data-theme')).toBe('white');
  expect(activeTheme()).toBe('white');
  expect(set).toHaveBeenCalledExactlyOnceWith('white');
  expect(radio('white').checked).toBe(true);
  expect(radio('black').checked).toBe(false);
});

it('does nothing when the theme on screen is chosen again', async () => {
  await act(async () => radio('black').click());
  expect(set).not.toHaveBeenCalled();
});

it('follows a change made elsewhere while it is open', async () => {
  await act(async () => setTheme('gray'));
  expect(radio('gray').checked).toBe(true);
});

it('still changes the page where Main cannot be told', async () => {
  Reflect.deleteProperty(window, 'sprintCoder');
  await act(async () => radio('gray').click());
  expect(document.documentElement.getAttribute('data-theme')).toBe('gray');
});
