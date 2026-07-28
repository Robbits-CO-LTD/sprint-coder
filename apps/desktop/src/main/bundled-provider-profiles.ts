import type { ProviderProfile } from '@sprint-coder/contracts';

const REVIEWED_AT = '2026-07-28T00:00:00.000Z';
const BEARER = { headerName: 'Authorization', scheme: 'Bearer' } as const;

export const PACK_A_PROVIDER_PROFILES: readonly ProviderProfile[] = [
  {
    id: 'mistral',
    displayName: 'Mistral API',
    baseUrl: 'https://api.mistral.ai/v1',
    baseUrlConfigurable: false,
    protocol: 'chat_completions',
    modelsPath: '/models',
    authentication: BEARER,
    requiredCredentialFields: [],
    errorOverrides: [],
    sourceReference: 'https://docs.mistral.ai/resources/migration-guides',
    reviewedAt: REVIEWED_AT,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com',
    baseUrlConfigurable: false,
    protocol: 'chat_completions',
    modelsPath: '/models',
    authentication: BEARER,
    requiredCredentialFields: [],
    errorOverrides: [],
    sourceReference: 'https://api-docs.deepseek.com/guides/function_calling/',
    reviewedAt: REVIEWED_AT,
  },
  {
    id: 'groq',
    displayName: 'GroqCloud API',
    baseUrl: 'https://api.groq.com/openai/v1',
    baseUrlConfigurable: false,
    protocol: 'chat_completions',
    modelsPath: '/models',
    authentication: BEARER,
    requiredCredentialFields: [],
    errorOverrides: [],
    sourceReference: 'https://console.groq.com/docs/openai',
    reviewedAt: REVIEWED_AT,
  },
];
