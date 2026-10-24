// @vitest-environment jsdom

/**
 * #785 J12 (the Renderer's part of "a copied value is kept nowhere"): the REAL `useComputerUse` hook is
 * mounted against a fake preload API, a session is started through the quick start of the onboarding,
 * and the status Main publishes carries a copied value. What is shown: the value reaches the screen
 * through the hook (the session card), the hook sends it to nobody (no call of the preload API carries
 * it), local and session storage never hold it, and when the session stops, and again when the
 * component unmounts, it is not on the screen either. The pieces under it (the rail, the approval card)
 * are covered in components/computer-use-c6-renderer.test.tsx; this file adds the hook.
 */
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  computerUseSessionStatusSchema,
  computerUseWindowCandidateSchema,
  type ComputerAppProfile,
  type ComputerUseSessionStatus,
  type ModelCatalogQueryInput,
  type ProviderModel,
} from '@sprint-coder/contracts';
import { ModelCatalogService } from '../../main/model-catalog-service';
import { useComputerUse, type ComputerUseFeature } from './useComputerUse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKER = 'MARKER-J12-7f3a-qzx';

const profile = {
  id: 'profile-1',
  label: 'TextEdit',
  identity: {
    platform: 'darwin',
    identityDigest: 'a'.repeat(64),
    displayName: 'TextEdit',
    bundleId: 'com.apple.TextEdit',
    policyLanguage: 'en',
    maximumMode: 'full_access_app',
  },
  mode: 'full_access_app',
  connectionId: 'connection-1',
  modelId: 'vision-1',
  providerEgressConsent: true,
  remember: true,
  profileRevision: 3,
  policyLanguage: 'en',
  maximumMode: 'full_access_app',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T01:00:00.000Z',
} satisfies ComputerAppProfile;

const candidate = computerUseWindowCandidateSchema.parse({
  windowId: 'window-1',
  appIdentityDigest: 'a'.repeat(64),
  windowIdentityDigest: 'b'.repeat(64),
  title: 'Untitled',
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: true,
  eligible: true,
  ownerKind: 'application',
  modal: false,
  revision: 7,
  policyLanguage: 'en',
  maximumMode: 'full_access_app',
});

function status(overrides: Partial<ComputerUseSessionStatus> = {}): ComputerUseSessionStatus {
  return computerUseSessionStatusSchema.parse({
    sessionId: 'session-1',
    taskId: 'task-1',
    profileId: 'profile-1',
    windowId: 'window-1',
    connectionId: 'connection-1',
    modelId: 'vision-1',
    appIdentityDigest: 'a'.repeat(64),
    windowIdentityDigest: 'b'.repeat(64),
    profileRevision: 3,
    mode: 'full_access_app',
    maximumMode: 'full_access_app',
    policyLanguage: 'en',
    state: 'observing',
    statusRevision: 1,
    policyEpoch: 4,
    observationRevision: 1,
    round: 1,
    maxRounds: 25,
    startedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-29T01:00:00.000Z',
    lastObservationAt: '2026-08-29T00:00:01.000Z',
    stopReason: null,
    copied: [],
    pendingApproval: null,
    ...overrides,
  });
}

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.removeAttribute('open');
    },
  });
});

afterAll(() => {
  for (const [key, descriptor] of [
    ['showModal', originalShowModal],
    ['close', originalClose],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, key);
    else Object.defineProperty(HTMLDialogElement.prototype, key, descriptor);
  }
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  delete (window as { sprintCoder?: unknown }).sprintCoder;
});

type Listener = (value: ComputerUseSessionStatus) => void;

function installFakePreload(
  query?: (input: ModelCatalogQueryInput) => Promise<{
    items: readonly ProviderModel[];
    nextCursor: string | null;
  }>,
) {
  const listeners = new Set<Listener>();
  // Every argument the hook hands to the preload API, as text, so a leak anywhere is found.
  const sent: string[] = [];
  const record =
    <Arguments extends unknown[], Result>(
      name: string,
      implementation: (...a: Arguments) => Result,
    ) =>
    (...input: Arguments): Result => {
      sent.push(`${name} ${JSON.stringify(input)}`);
      return implementation(...input);
    };
  const computerUse = {
    availability: record('availability', async () => ({
      platform: 'darwin',
      state: 'ready',
      acceptanceMode: null,
      featureEnabled: true,
      packageReady: true,
      handshakeReady: true,
      observe: true,
      control: true,
      available: true,
      reasonCode: null,
      manifestDigest: 'a'.repeat(64),
      missingPermissions: [],
    })),
    listProfiles: record('listProfiles', async () => ({ profiles: [profile] })),
    listWindowCandidates: record('listWindowCandidates', async () => ({
      profileId: 'profile-1',
      candidates: [candidate],
    })),
    registerProfile: record('registerProfile', async () => profile),
    listGrants: record('listGrants', async () => ({ grants: [], discardedRecords: 0 })),
    start: record('start', async () => status()),
    getStatus: record('getStatus', async () => null),
    subscribeStatus: record('subscribeStatus', (_sessionId: string, listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    stop: record('stop', async () => undefined),
    resolveApproval: record('resolveApproval', async () => status()),
  };
  (window as unknown as { sprintCoder: unknown }).sprintCoder = {
    computerUse,
    app: { getInfo: async () => ({ computerUseAgentDrivenV2: false }) },
    permissions: { get: async () => ({ policyEpoch: 4 }) },
    providers: {
      listConnections: async () => [
        { id: 'connection-1', enabled: true, runtimeKind: 'official_api', displayName: 'OpenAI' },
      ],
    },
    models: {
      query:
        query ??
        (async () => ({
          items: [
            {
              connectionId: 'connection-1',
              modelId: 'vision-1',
              displayName: 'Vision 1',
              multimodalInput: { value: true },
            },
          ],
          nextCursor: null,
        })),
    },
  };
  return {
    sent,
    publish: (value: ComputerUseSessionStatus) => {
      for (const listener of [...listeners]) listener(value);
    },
    listenerCount: () => listeners.size,
  };
}

function Probe(props: { taskId: string; onFeature: (feature: ComputerUseFeature) => void }) {
  const feature = useComputerUse(props.taskId);
  useEffect(() => {
    props.onFeature(feature);
  });
  return <div data-testid="surface">{feature.surface}</div>;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function catalogModel(modelId: string, vision: boolean | null = true): ProviderModel {
  const unknown = { value: null, source: 'unknown' as const };
  return {
    connectionId: 'connection-1',
    providerId: 'openai',
    modelId,
    displayName: modelId,
    available: true,
    availabilityCheckedAt: '2026-10-24T00:00:00.000Z',
    contextWindow: unknown,
    maxOutputTokens: unknown,
    toolCalling: unknown,
    structuredOutput: unknown,
    multimodalInput: { value: vision, source: vision === null ? 'unknown' : 'provider_api' },
    reasoning: unknown,
  };
}

describe('Computer Use onboarding catalog pagination (#906)', () => {
  it.each([
    { name: 'vision only after 100 text models', textCount: 100, visionCount: 1, changes: 0 },
    { name: 'vision options across three pages', textCount: 0, visionCount: 205, changes: 0 },
    { name: 'a catalog update between pages', textCount: 0, visionCount: 101, changes: 1 },
    { name: 'repeated catalog updates fail visibly', textCount: 0, visionCount: 101, changes: 2 },
  ])('loads onboarding safely: $name', async ({ textCount, visionCount, changes }) => {
    const service = new ModelCatalogService();
    const visionModels = Array.from({ length: visionCount }, (_, index) =>
      catalogModel(`vision-${String(index).padStart(3, '0')}`),
    );
    const models = [
      ...Array.from({ length: textCount }, (_, index) =>
        catalogModel(`text-${String(index).padStart(3, '0')}`, false),
      ),
      ...visionModels,
      catalogModel('zz-unknown', null),
      { ...catalogModel('zz-unavailable'), available: false },
      { ...catalogModel('zz-other-connection'), connectionId: 'connection-other' },
    ];
    service.replaceCatalog(models);
    let remainingChanges = changes;
    const query = vi.fn(async (input: ModelCatalogQueryInput) => {
      if (input.cursor !== null && remainingChanges > 0) {
        models.push(catalogModel(`aaa-new-vision-${remainingChanges}`));
        service.replaceCatalog(models);
        remainingChanges -= 1;
      }
      return service.query(input);
    });
    installFakePreload(query);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let feature: ComputerUseFeature | null = null;
    try {
      await act(async () => {
        root.render(
          <Probe
            taskId="task-1"
            onFeature={(value) => {
              feature = value;
            }}
          />,
        );
      });
      await act(async () => feature!.open());
      await settle();
      if (changes === 2) {
        expect(container.textContent).toContain(
          'モデル一覧が更新されました。Computer Useを開き直してください。',
        );
        expect(query).toHaveBeenCalledTimes(4);
        expect(container.textContent).not.toContain('確認中…');
        return;
      }
      const next = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === '次へ',
      );
      expect(next?.disabled).toBe(false);
      await act(async () => next!.click());
      await settle();
      const providerField = Array.from(container.querySelectorAll('label')).find((label) =>
        label.textContent?.startsWith('画像と画面情報の送信先'),
      );
      const options = Array.from(providerField?.querySelectorAll('option') ?? []).map(
        (option) => option.textContent,
      );
      expect(options).toEqual([
        ...(changes === 1 ? ['OpenAI — aaa-new-vision-1'] : []),
        ...visionModels.map((model) => `OpenAI — ${model.displayName}`),
        'OpenAI — zz-unknown',
      ]);
      expect(container.textContent).not.toContain('画像対応のProvider / Modelがありません');
      expect(query.mock.calls.map(([input]) => input.cursor)).toEqual(
        changes === 1
          ? [null, 'cursor:100', null, 'cursor:100']
          : textCount === 100
            ? [null, 'cursor:100']
            : [null, 'cursor:100', 'cursor:200'],
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
});

function storedText(): string {
  return [localStorage, sessionStorage]
    .flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index)!;
        return `${key}=${storage.getItem(key)}`;
      }),
    )
    .join('\n');
}

describe('J12: the real useComputerUse hook keeps a copied value nowhere', () => {
  it('shows the value on the session card, sends it to nobody, stores it nowhere, and drops it when the session ends', async () => {
    const fake = installFakePreload();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let feature: ComputerUseFeature | null = null;
    await act(async () => {
      root.render(
        <Probe
          taskId="task-1"
          onFeature={(value) => {
            feature = value;
          }}
        />,
      );
    });
    await settle();
    expect(feature!.enabled).toBe(true);

    // Open the onboarding and start the remembered profile with its one click.
    await act(async () => feature!.open());
    await settle();
    const quickStart = container.querySelector<HTMLButtonElement>(
      '[data-computer-use-activation="start"]',
    );
    expect(quickStart, 'the quick start of a remembered profile').not.toBeNull();
    await act(async () => {
      quickStart!.click();
    });
    await settle();
    expect(feature!.active).toBe(true);
    expect(fake.listenerCount()).toBe(1);

    // Main publishes a status that carries a copied value: it reaches the screen through the hook.
    await act(async () => {
      fake.publish(
        status({
          statusRevision: 2,
          copied: [{ sizeClass: 'le_256', excerpt: MARKER }],
        }),
      );
    });
    expect(container.textContent).toContain(MARKER);

    // The hook sent the value to no one, and wrote it to no storage.
    expect(fake.sent.join('\n')).not.toContain(MARKER);
    expect(storedText()).not.toContain(MARKER);

    // The session ends: the value is not on the screen, still not in storage, and still not sent.
    await act(async () => {
      fake.publish(
        status({ statusRevision: 3, state: 'stopped', stopReason: 'user_stop', copied: [] }),
      );
    });
    await settle();
    expect(feature!.active).toBe(false);
    expect(container.textContent).not.toContain(MARKER);
    expect(storedText()).not.toContain(MARKER);
    expect(fake.sent.join('\n')).not.toContain(MARKER);

    await act(async () => root.unmount());
    expect(document.body.textContent).not.toContain(MARKER);
    expect(storedText()).not.toContain(MARKER);
    expect(fake.listenerCount()).toBe(0);
  });

  it('drops the value when the component unmounts in the middle of a session, and unsubscribes', async () => {
    const fake = installFakePreload();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let feature: ComputerUseFeature | null = null;
    await act(async () => {
      root.render(
        <Probe
          taskId="task-1"
          onFeature={(value) => {
            feature = value;
          }}
        />,
      );
    });
    await settle();
    await act(async () => feature!.open());
    await settle();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-computer-use-activation="start"]')!.click();
    });
    await settle();
    await act(async () => {
      fake.publish(
        status({ statusRevision: 2, copied: [{ sizeClass: 'le_256', excerpt: MARKER }] }),
      );
    });
    expect(container.textContent).toContain(MARKER);
    await act(async () => root.unmount());
    expect(document.body.textContent).not.toContain(MARKER);
    expect(storedText()).not.toContain(MARKER);
    expect(fake.listenerCount()).toBe(0);
    expect(vi.isMockFunction(fake.publish)).toBe(false);
  });
});
