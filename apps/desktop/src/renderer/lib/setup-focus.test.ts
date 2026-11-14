// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { focusAfterFirstSetup, focusAfterSetupReplay } from './setup-focus';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focus after the replayed Setup closes', () => {
  it('goes back to the Settings button when it is there', () => {
    document.body.innerHTML =
      '<aside><button data-testid="sidebar-settings-button">設定</button></aside><div class="main"><textarea data-testid="composer-textarea"></textarea></div>';
    expect(focusAfterSetupReplay()?.dataset.testid).toBe('sidebar-settings-button');
  });

  it('passes over a button inside an inert (collapsed) Sidebar', () => {
    document.body.innerHTML =
      '<aside inert><button data-testid="sidebar-settings-button">設定</button></aside><div class="main"><textarea data-testid="composer-textarea"></textarea></div>';
    expect(focusAfterSetupReplay()?.dataset.testid).toBe('composer-textarea');
  });

  it('falls back to the main area, never to the page', () => {
    document.body.innerHTML = '<div class="main"><p>なし</p></div>';
    const target = focusAfterSetupReplay();
    expect(target?.className).toBe('main');
    expect(document.activeElement).toBe(target);
  });
});

describe('focus after the first-run Setup leaves', () => {
  const app = (sidebar = '') =>
    `<aside ${sidebar}><button data-testid="sidebar-settings-button">設定</button></aside><div class="main"><textarea data-testid="composer-textarea"></textarea></div>`;

  it('goes to the Composer, not to the Settings button', () => {
    document.body.innerHTML = app();
    expect(focusAfterFirstSetup()?.dataset.testid).toBe('composer-textarea');
  });

  it('keeps a place the user has already chosen', () => {
    document.body.innerHTML = app();
    const settings = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-settings-button"]',
    )!;
    settings.focus();
    expect(focusAfterFirstSetup()).toBeNull();
    expect(document.activeElement).toBe(settings);
  });

  it('passes over a disabled Composer to the next place, never the page', () => {
    document.body.innerHTML = app().replace('<textarea', '<textarea disabled');
    expect(focusAfterFirstSetup()?.dataset.testid).toBe('sidebar-settings-button');
    document.body.innerHTML = '<div class="main"><p>なし</p></div>';
    expect(focusAfterFirstSetup()?.className).toBe('main');
  });

  it('the early try touches nothing until the Composer is there', () => {
    document.body.innerHTML =
      '<aside><button data-testid="sidebar-settings-button">設定</button></aside><div class="main"></div>';
    expect(focusAfterFirstSetup(document, { composerOnly: true })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
