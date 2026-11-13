// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { focusAfterSetupReplay } from './setup-focus';

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
