// @vitest-environment jsdom

/**
 * Issue #906: the Computer Use onboarding must list every image-capable model, wherever it sits in
 * the catalog. The REAL `ModelCatalogService` answers `models.query` (so cursors, the 100-row page
 * limit and the filters are Main's own), and the REAL `useComputerUse` hook and onboarding are
 * mounted; only the rest of the preload API is a fixture.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  computerUseWindowCandidateSchema,
  type ComputerAppProfile,
  type ModelCatalogQueryInput,
  type ProviderModel,
} from '@sprint-coder/contracts';
import { ModelCatalogService } from '../../main/model-catalog-service';
import { useComputerUse, type ComputerUseFeature } from './useComputerUse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_NOTE = '画像対応のProvider / Modelがありません';

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
  modelId: 'none',
  providerEgressConsent: false,
  remember: false,
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

function model(
  connectionId: string,
  modelId: string,
  displayName: string,
  multimodal: boolean,
): ProviderModel {
  const unknown = { value: null, source: 'unknown' as const };
  return {
    connectionId,
    providerId: 'openai',
    modelId,
    displayName,
    available: true,
    availabilityCheckedAt: '2026-10-24T00:00:00.000Z',
    contextWindow: unknown,
    maxOutputTokens: unknown,
    toolCalling: unknown,
    structuredOutput: unknown,
    multimodalInput: { value: multimodal, source: 'provider_api' as const },
    reasoning: unknown,
  };
}

function textModels(connectionId: string, count: number): ProviderModel[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `text-${String(index).padStart(3, '0')}`;
    return model(connectionId, id, `Text ${id}`, false);
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
  delete (window as { sprintCoder?: unknown }).sprintCoder;
});

type QueryHook = (input: ModelCatalogQueryInput, call: number) => void;

function installPreload(catalog: ModelCatalogService, beforeQuery?: QueryHook) {
  const queries: ModelCatalogQueryInput[] = [];
  (window as unknown as { sprintCoder: unknown }).sprintCoder = {
    computerUse: {
      availability: async () => ({
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
      }),
      listProfiles: async () => ({ profiles: [profile] }),
      listWindowCandidates: async () => ({ profileId: 'profile-1', candidates: [candidate] }),
      registerProfile: async () => profile,
      listGrants: async () => ({ grants: [], discardedRecords: 0 }),
      start: async () => {
        throw new Error('not started in this test');
      },
      getStatus: async () => null,
      subscribeStatus: () => () => undefined,
      stop: async () => undefined,
      resolveApproval: async () => {
        throw new Error('no approvals in this test');
      },
    },
    app: { getInfo: async () => ({ computerUseAgentDrivenV2: false }) },
    permissions: { get: async () => ({ policyEpoch: 4 }) },
    providers: {
      listConnections: async () => [
        { id: 'connection-1', enabled: true, runtimeKind: 'official_api', displayName: 'OpenAI' },
        // Not a Computer Use destination: its image model must never be offered.
        { id: 'builtin:codex-cli', enabled: true, runtimeKind: 'codex', displayName: 'Codex' },
      ],
    },
    models: {
      // The same parse-and-answer the IPC handler does, against the real catalog.
      query: async (input: ModelCatalogQueryInput) => {
        beforeQuery?.(input, queries.length);
        queries.push(input);
        return catalog.query(input);
      },
    },
  };
  return { queries };
}

function Probe(props: { onFeature: (feature: ComputerUseFeature) => void }) {
  const feature = useComputerUse('task-1');
  props.onFeature(feature);
  return <div>{feature.surface}</div>;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

/** Opens the onboarding and presses 次へ, so the destination step is on screen. */
async function openDestinationStep(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let feature: ComputerUseFeature | null = null;
  await act(async () => {
    root.render(<Probe onFeature={(value) => (feature = value)} />);
  });
  await settle();
  expect(feature!.enabled).toBe(true);
  await act(async () => feature!.open());
  await settle();
  const next = [...container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
    (button) => button.textContent === '次へ',
  );
  expect(next, 'the 次へ button of the onboarding').toBeDefined();
  await act(async () => next!.click());
  await settle();
  return container;
}

function offered(container: HTMLElement): string[] {
  const field = [...container.querySelectorAll('label')].find(
    (label) => label.querySelector('span')?.textContent === '画像と画面情報の送信先',
  );
  return [...(field?.querySelectorAll('option') ?? [])].map((option) => option.textContent ?? '');
}

function expectContractPages(queries: readonly ModelCatalogQueryInput[]): void {
  for (const query of queries) {
    expect(query.limit).toBeLessThanOrEqual(100);
    expect(query.connectionIds).toEqual(['connection-1']);
  }
}

describe('#906: Computer Use lists image models from every catalog page', () => {
  it('reproduction: offers the 101st model of a 101-model catalog (it lives on the second page)', async () => {
    const catalog = new ModelCatalogService();
    catalog.replaceCatalog([
      ...textModels('connection-1', 100),
      model('connection-1', 'vision-1', 'Vision 1', true),
    ]);
    const { queries } = installPreload(catalog);

    const container = await openDestinationStep();

    expect(offered(container)).toEqual(['OpenAI — Vision 1']);
    expect(container.textContent).not.toContain(EMPTY_NOTE);
    expect(queries.map((query) => query.cursor)).toEqual([null, 'cursor:100']);
    expectContractPages(queries);
  });

  it('control: the same 101 models with the image model sorted onto the first page', async () => {
    const catalog = new ModelCatalogService();
    catalog.replaceCatalog([
      ...textModels('connection-1', 100),
      model('connection-1', 'aaa-vision', 'Vision 1', true),
    ]);
    installPreload(catalog);

    const container = await openDestinationStep();

    expect(offered(container)).toEqual(['OpenAI — Vision 1']);
    expect(container.textContent).not.toContain(EMPTY_NOTE);
  });

  it('offers image models that exist only on later pages, and only on compatible Connections', async () => {
    const catalog = new ModelCatalogService();
    catalog.replaceCatalog([
      // Sorted before connection-1 and image-capable, but Codex is not a Computer Use destination.
      model('builtin:codex-cli', 'codex-vision', 'Codex Vision', true),
      ...textModels('connection-1', 250),
      model('connection-1', 'zz-vision-a', 'Vision A', true),
      model('connection-1', 'zz-vision-b', 'Vision B', true),
    ]);
    const { queries } = installPreload(catalog);

    const container = await openDestinationStep();

    expect(offered(container)).toEqual(['OpenAI — Vision A', 'OpenAI — Vision B']);
    expect(container.textContent).not.toContain(EMPTY_NOTE);
    expect(queries.map((query) => query.cursor)).toEqual([null, 'cursor:100', 'cursor:200']);
    expectContractPages(queries);
  });

  it('restarts from the first page when the catalog changes while it is being paged', async () => {
    const catalog = new ModelCatalogService();
    catalog.replaceCatalog([
      ...textModels('connection-1', 150),
      model('connection-1', 'vision-old', 'Vision Old', true),
    ]);
    const { queries } = installPreload(catalog, (_input, call) => {
      if (call !== 1) return;
      // The catalog is refreshed between page 1 and page 2: the old model is gone.
      catalog.replaceCatalog([
        ...textModels('connection-1', 150),
        model('connection-1', 'vision-new', 'Vision New', true),
      ]);
    });

    const container = await openDestinationStep();

    expect(offered(container)).toEqual(['OpenAI — Vision New']);
    expect(queries.map((query) => query.cursor)).toEqual([null, 'cursor:100', null, 'cursor:100']);
  });

  it('shows the failure instead of a partial list when a later page cannot be read', async () => {
    const catalog = new ModelCatalogService();
    catalog.replaceCatalog([
      model('connection-1', 'aaa-vision', 'Vision 1', true),
      ...textModels('connection-1', 150),
    ]);
    installPreload(catalog, (_input, call) => {
      if (call === 1) throw new Error('モデル一覧の2ページ目を読めませんでした');
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let feature: ComputerUseFeature | null = null;
    await act(async () => {
      root.render(<Probe onFeature={(value) => (feature = value)} />);
    });
    await settle();
    await act(async () => feature!.open());
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'モデル一覧の2ページ目を読めませんでした',
    );
    expect(offered(container)).toEqual([]);
  });
});
