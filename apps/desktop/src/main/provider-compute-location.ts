import type {
  ModelCatalogAccessType,
  ProviderComputeLocation,
  ProviderConnection,
  ProviderConnectionView,
  ProviderProfile,
} from '@sprint-coder/contracts';

export type ProviderProfileLookup = Readonly<{
  get(profileId: string): Pick<ProviderProfile, 'computeLocation'>;
}>;

/**
 * Classifies where inference happens without consulting endpoint trust, URL text, or provider IDs.
 * Missing legacy Profile metadata stays cloud so an unknown connection never gains local authority.
 */
export function providerComputeLocation(
  connection: Pick<ProviderConnection, 'providerId' | 'runtimeKind'>,
  profiles: ProviderProfileLookup,
): ProviderComputeLocation {
  if (connection.runtimeKind === 'mock') return 'local';
  if (connection.runtimeKind !== 'openai_compatible') return 'cloud';
  try {
    return profiles.get(connection.providerId).computeLocation ?? 'cloud';
  } catch {
    return 'cloud';
  }
}

export function providerModelCatalogAccessType(
  connection: Pick<ProviderConnection, 'providerId' | 'runtimeKind'>,
  profiles: ProviderProfileLookup,
): ModelCatalogAccessType {
  if (connection.runtimeKind === 'builtin_cli') return 'subscription';
  return providerComputeLocation(connection, profiles) === 'local' ? 'local' : 'api';
}

export function providerConnectionView(
  connection: ProviderConnection,
  profiles: ProviderProfileLookup,
): ProviderConnectionView {
  return {
    ...connection,
    computeLocation: providerComputeLocation(connection, profiles),
  };
}
