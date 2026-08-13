import { providerProfileSchema, type ProviderProfile } from '@sprint-coder/contracts';
import { ProviderEndpointPolicy } from './provider-endpoint-policy';

const endpointPolicy = new ProviderEndpointPolicy();

export interface ProviderProfileRegistry {
  register(profile: ProviderProfile): void;
  get(profileId: string): ProviderProfile;
  list(): readonly ProviderProfile[];
}

export class MainProviderProfileRegistry implements ProviderProfileRegistry {
  private readonly profiles = new Map<string, ProviderProfile>();

  register(profile: ProviderProfile): void {
    const parsed = providerProfileSchema.parse(profile);
    if (this.profiles.has(parsed.id))
      throw new Error(`Provider Profile is already registered: ${parsed.id}`);
    this.profiles.set(parsed.id, parsed);
  }

  get(profileId: string): ProviderProfile {
    const profile = this.profiles.get(profileId);
    if (profile === undefined) throw new Error(`Provider Profile is not registered: ${profileId}`);
    return profile;
  }

  list(): readonly ProviderProfile[] {
    return [...this.profiles.values()];
  }
}

export type OpenAICompatibleCredential = Readonly<{
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  endpointDigest?: string;
  localConsentDigest?: string;
}>;

export function serializeOpenAICompatibleCredential(
  credential: OpenAICompatibleCredential,
): string {
  if (credential.apiKey !== undefined && credential.apiKey.trim().length === 0)
    throw new Error('OpenAI-compatible API key is missing');
  return JSON.stringify(credential);
}

export function parseOpenAICompatibleCredential(value: string): OpenAICompatibleCredential {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object')
    throw new Error('OpenAI-compatible credential is invalid');
  const record = parsed as Record<string, unknown>;
  if (
    record.apiKey !== undefined &&
    (typeof record.apiKey !== 'string' || record.apiKey.trim().length === 0)
  )
    throw new Error('OpenAI-compatible API key is missing');
  if (record.baseUrl !== undefined && typeof record.baseUrl !== 'string')
    throw new Error('OpenAI-compatible base URL is invalid');
  if (record.accountId !== undefined && typeof record.accountId !== 'string')
    throw new Error('OpenAI-compatible account ID is invalid');
  for (const field of ['endpointDigest', 'localConsentDigest'] as const)
    if (record[field] !== undefined && !/^[a-f0-9]{64}$/u.test(String(record[field])))
      throw new Error(`OpenAI-compatible ${field} is invalid`);
  return {
    ...(typeof record.apiKey === 'string' ? { apiKey: record.apiKey } : {}),
    ...(typeof record.baseUrl === 'string' ? { baseUrl: record.baseUrl } : {}),
    ...(typeof record.accountId === 'string' ? { accountId: record.accountId } : {}),
    ...(typeof record.endpointDigest === 'string' ? { endpointDigest: record.endpointDigest } : {}),
    ...(typeof record.localConsentDigest === 'string'
      ? { localConsentDigest: record.localConsentDigest }
      : {}),
  };
}

export function profileRequiresCredential(
  profile: ProviderProfile,
  field: ProviderProfile['requiredCredentialFields'][number],
): boolean {
  return profile.requiredCredentialFields.includes(field);
}

export function resolveProfileBaseUrl(
  profile: ProviderProfile,
  credential: OpenAICompatibleCredential,
): string {
  const configured = credential.baseUrl?.trim();
  if (configured !== undefined && configured.length > 0 && !profile.baseUrlConfigurable)
    throw new Error(`Provider Profile ${profile.id} does not allow a custom base URL`);
  let baseUrl = configured && profile.baseUrlConfigurable ? configured : profile.baseUrl;
  if (baseUrl.includes('{accountId}')) {
    const accountId = credential.accountId?.trim();
    if (accountId === undefined || accountId.length === 0)
      throw new Error(`Provider Profile ${profile.id} requires an account ID`);
    baseUrl = baseUrl.replaceAll('{accountId}', encodeURIComponent(accountId));
  }
  return endpointPolicy.canonicalizeBaseUrl(baseUrl);
}

export function resolvedProfileEndpointTrust(
  profile: ProviderProfile,
  credential: OpenAICompatibleCredential,
): 'trusted-local' | 'trusted-remote' {
  const hostname = new URL(resolveProfileBaseUrl(profile, credential)).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' ? 'trusted-local' : 'trusted-remote';
}
