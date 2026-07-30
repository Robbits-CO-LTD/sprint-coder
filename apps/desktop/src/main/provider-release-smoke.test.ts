import { describe, expect, it } from 'vitest';
import type {
  CanonicalProviderEvent,
  ProviderConnection,
  ProviderRuntimeKind,
} from '@sprint-coder/contracts';
import { AnthropicProviderClient } from './anthropic-provider-client';
import { BUNDLED_PROVIDER_PROFILES } from './bundled-provider-profiles';
import { GeminiProviderClient } from './gemini-provider-client';
import { OpenAICompatibleProviderClient } from './openai-compatible-provider-client';
import { OpenAIProviderClient } from './openai-provider-client';
import { OpenRouterCatalogClient } from './openrouter-provider-client';
import { MainProviderProfileRegistry, type OpenAICompatibleCredential } from './provider-profile';
import type { ProviderRuntime } from './provider-runtime';
import { XAIProviderClient } from './xai-provider-client';

const SMOKE_ENABLED = process.env.SPRINT_CODER_PROVIDER_SMOKE === '1';
const REQUIRED_PROVIDERS = new Set(
  (process.env.SPRINT_CODER_PROVIDER_SMOKE_REQUIRED ?? '')
    .split(',')
    .map((providerId) => providerId.trim())
    .filter(Boolean),
);
const TIMEOUT_MS = 45_000;

type SmokeCase = Readonly<{
  providerId: string;
  displayName: string;
  runtimeKind: ProviderRuntimeKind;
  keyEnvironment: string;
  modelEnvironment: string;
  defaultModel?: string;
  credentialAvailable: () => boolean;
  createRuntime: () => ProviderRuntime;
}>;

const profiles = new MainProviderProfileRegistry();
for (const profile of BUNDLED_PROVIDER_PROFILES) profiles.register(profile);

const officialCases: readonly SmokeCase[] = [
  {
    providerId: 'openai',
    displayName: 'OpenAI API',
    runtimeKind: 'official_api',
    keyEnvironment: 'OPENAI_API_KEY',
    modelEnvironment: 'OPENAI_SMOKE_MODEL',
    credentialAvailable: () => hasEnvironment('OPENAI_API_KEY'),
    createRuntime: () =>
      new OpenAIProviderClient(() => {
        const organizationId = optionalEnvironment('OPENAI_ORGANIZATION_ID');
        const projectId = optionalEnvironment('OPENAI_PROJECT_ID');
        return {
          apiKey: requireEnvironment('OPENAI_API_KEY'),
          ...(organizationId === undefined ? {} : { organizationId }),
          ...(projectId === undefined ? {} : { projectId }),
        };
      }),
  },
  {
    providerId: 'openrouter',
    displayName: 'OpenRouter API',
    runtimeKind: 'official_api',
    keyEnvironment: 'OPENROUTER_API_KEY',
    modelEnvironment: 'OPENROUTER_SMOKE_MODEL',
    defaultModel: 'openrouter/free',
    credentialAvailable: () => hasEnvironment('OPENROUTER_API_KEY'),
    createRuntime: () =>
      new OpenRouterCatalogClient(() => ({
        apiKey: requireEnvironment('OPENROUTER_API_KEY'),
      })),
  },
  {
    providerId: 'anthropic',
    displayName: 'Anthropic API',
    runtimeKind: 'official_api',
    keyEnvironment: 'ANTHROPIC_API_KEY',
    modelEnvironment: 'ANTHROPIC_SMOKE_MODEL',
    credentialAvailable: () => hasEnvironment('ANTHROPIC_API_KEY'),
    createRuntime: () =>
      new AnthropicProviderClient(() => ({
        apiKey: requireEnvironment('ANTHROPIC_API_KEY'),
      })),
  },
  {
    providerId: 'google',
    displayName: 'Google Gemini API',
    runtimeKind: 'official_api',
    keyEnvironment: 'GEMINI_API_KEY or GOOGLE_API_KEY',
    modelEnvironment: 'GEMINI_SMOKE_MODEL',
    credentialAvailable: () => hasEnvironment('GEMINI_API_KEY') || hasEnvironment('GOOGLE_API_KEY'),
    createRuntime: () =>
      new GeminiProviderClient(() => ({
        apiKey: optionalEnvironment('GEMINI_API_KEY') ?? requireEnvironment('GOOGLE_API_KEY'),
      })),
  },
  {
    providerId: 'xai',
    displayName: 'xAI API',
    runtimeKind: 'official_api',
    keyEnvironment: 'XAI_API_KEY',
    modelEnvironment: 'XAI_SMOKE_MODEL',
    credentialAvailable: () => hasEnvironment('XAI_API_KEY'),
    createRuntime: () =>
      new XAIProviderClient(() => ({
        apiKey: requireEnvironment('XAI_API_KEY'),
      })),
  },
];

const compatibleCases: readonly SmokeCase[] = BUNDLED_PROVIDER_PROFILES.map((profile) => {
  const prefix = profile.id.toUpperCase().replaceAll('-', '_');
  const keyEnvironment =
    profile.id === 'cloudflare-workers-ai' ? 'CLOUDFLARE_API_TOKEN' : `${prefix}_API_KEY`;
  const modelEnvironment = `${prefix}_SMOKE_MODEL`;
  const defaultModel = profile.verificationModel ?? undefined;
  return {
    providerId: profile.id,
    displayName: profile.displayName,
    runtimeKind: 'openai_compatible',
    keyEnvironment,
    modelEnvironment,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    credentialAvailable: () =>
      hasEnvironment(keyEnvironment) &&
      (profile.id !== 'cloudflare-workers-ai' || hasEnvironment('CLOUDFLARE_ACCOUNT_ID')),
    createRuntime: () =>
      new OpenAICompatibleProviderClient(profiles, () => {
        const baseUrl =
          profile.id === 'nvidia-nim' ? optionalEnvironment('NVIDIA_NIM_BASE_URL') : undefined;
        const credential: OpenAICompatibleCredential = {
          apiKey: requireEnvironment(keyEnvironment),
          ...(profile.id === 'cloudflare-workers-ai'
            ? { accountId: requireEnvironment('CLOUDFLARE_ACCOUNT_ID') }
            : {}),
          ...(baseUrl === undefined ? {} : { baseUrl }),
        };
        return credential;
      }),
  };
});

const smokeCases = [...officialCases, ...compatibleCases];
const knownProviderIds = new Set(smokeCases.map(({ providerId }) => providerId));

describe.skipIf(!SMOKE_ENABLED)('Provider release smoke', () => {
  it('rejects unknown required Provider IDs', () => {
    expect(
      [...REQUIRED_PROVIDERS].filter((providerId) => !knownProviderIds.has(providerId)),
    ).toEqual([]);
  });

  for (const smokeCase of smokeCases) {
    const required = REQUIRED_PROVIDERS.has(smokeCase.providerId);
    const selected = REQUIRED_PROVIDERS.size > 0 ? required : smokeCase.credentialAvailable();
    const runnable = smokeCase.credentialAvailable();

    it.skipIf(!selected)(
      `${smokeCase.displayName}: verify, catalog, streaming, resolution, usage, completion`,
      async () => {
        if (!runnable)
          throw new Error(
            `${smokeCase.providerId} is required but ${smokeCase.keyEnvironment} is not configured`,
          );

        const modelId = optionalEnvironment(smokeCase.modelEnvironment) ?? smokeCase.defaultModel;
        if (modelId === undefined)
          throw new Error(
            `${smokeCase.providerId} requires ${smokeCase.modelEnvironment} for a bounded release smoke`,
          );

        const runtime = smokeCase.createRuntime();
        const connection = connectionFor(smokeCase);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const startedAt = Date.now();

        try {
          const verification = await runtime.verify(connection, controller.signal);
          expect(verification.status).toBe('verified');

          const catalog = await runtime.listModels(connection, controller.signal);
          expect(catalog.length).toBeGreaterThan(0);
          expect(catalog.some((model) => model.modelId === modelId && model.available)).toBe(true);

          const events: CanonicalProviderEvent[] = [];
          for await (const event of runtime.execute(
            connection,
            {
              executionId: `release-smoke-${smokeCase.providerId}`,
              connectionId: connection.id,
              modelId,
              messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
            },
            controller.signal,
          ))
            events.push(event);

          expect(events.filter((event) => event.type === 'error')).toEqual([]);
          expect(events.some((event) => event.type === 'output_delta')).toBe(true);
          expect(events.some((event) => event.type === 'resolution')).toBe(true);
          expect(events.some((event) => event.type === 'usage')).toBe(true);
          expect(events.at(-1)?.type).toBe('completed');

          const usage = events.find((event) => event.type === 'usage');
          const resolution = events.find((event) => event.type === 'resolution');
          process.stdout.write(
            `${JSON.stringify({
              gate: 'provider-release-smoke',
              providerId: smokeCase.providerId,
              modelId,
              catalogCount: catalog.length,
              durationMs: Date.now() - startedAt,
              resolvedProvider:
                resolution?.type === 'resolution' ? resolution.resolution.resolvedProvider : null,
              resolvedModel:
                resolution?.type === 'resolution' ? resolution.resolution.resolvedModel : null,
              usage: usage?.type === 'usage' ? usage.usage : null,
              status: 'green',
            })}\n`,
          );
        } finally {
          clearTimeout(timeout);
          controller.abort();
        }
      },
      TIMEOUT_MS + 5_000,
    );
  }
});

function connectionFor(smokeCase: SmokeCase): ProviderConnection {
  const now = new Date().toISOString();
  return {
    id: `smoke:${smokeCase.providerId}`,
    providerId: smokeCase.providerId,
    runtimeKind: smokeCase.runtimeKind,
    displayName: smokeCase.displayName,
    enabled: true,
    secretReference: 'provider-secret:00000000-0000-4000-8000-000000000001',
    verification: {
      status: 'unverified',
      verifiedAt: null,
      expiresAt: null,
      message: null,
    },
    rateLimit: {
      mode: 'auto',
      maxConcurrentRequests: 1,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function hasEnvironment(name: string): boolean {
  return optionalEnvironment(name) !== undefined;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function requireEnvironment(name: string): string {
  const value = optionalEnvironment(name);
  if (value === undefined) throw new Error(`${name} is not configured`);
  return value;
}
