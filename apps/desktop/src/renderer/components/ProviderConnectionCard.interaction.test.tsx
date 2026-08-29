// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { ProviderConnectionCard } from './ProviderSettingsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: 'conn-1',
    providerId: 'openai',
    runtimeKind: 'official_api',
    displayName: '本番 OpenAI',
    enabled: true,
    secretReference: 'provider-secret:opaque',
    verification: {
      status: 'verified',
      verifiedAt: '2026-08-29T00:00:00.000Z',
      expiresAt: null,
      message: null,
    },
    rateLimit: {
      mode: 'auto',
      maxConcurrentRequests: null,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

const mountedRoots: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

async function renderCard(target: ProviderConnection): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });
  await act(async () =>
    root.render(
      <ProviderConnectionCard
        connection={target}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
        rateLimit={{ supported: true, saving: false, onSave: () => {} }}
      />,
    ),
  );
  return container;
}

afterEach(async () => {
  for (const { container, root } of mountedRoots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe('ProviderConnectionCard disclosure', () => {
  it('keeps low-frequency controls collapsed until the labelled details button opens them', async () => {
    const container = await renderCard(connection());
    const button = container.querySelector(
      '[data-testid="settings-connection-expand-conn-1"]',
    ) as HTMLButtonElement;
    const details = container.querySelector(
      '[data-testid="settings-connection-details-conn-1"]',
    ) as HTMLDivElement;

    expect(button.textContent).toContain('詳細');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(details.id);
    expect(details.hidden).toBe(true);

    await act(async () => button.click());

    expect(button.textContent).toContain('閉じる');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(details.hidden).toBe(false);
    expect(
      details.querySelector('[data-testid="settings-connection-limit-conn-1"]'),
    ).not.toBeNull();
    expect(details.textContent).toContain('接続を再検証');

    await act(async () => button.click());
    expect(details.hidden).toBe(true);
  });

  it('leaves a built-in CLI as a compact status row with no empty disclosure', async () => {
    const container = await renderCard(
      connection({
        providerId: 'anthropic',
        runtimeKind: 'builtin_cli',
        displayName: 'Claude CLI',
        secretReference: null,
        verification: {
          status: 'not_required',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
      }),
    );

    expect(container.querySelector('.settings-connection-summary')).not.toBeNull();
    expect(container.querySelector('[data-testid^="settings-connection-expand-"]')).toBeNull();
    expect(container.querySelector('[data-testid^="settings-connection-details-"]')).toBeNull();
    expect(container.textContent).toContain('確認不要');
  });
});
