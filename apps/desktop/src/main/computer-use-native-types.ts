import type { ComputerUseNativeManifest } from '@sprint-coder/contracts';

export type ComputerUseNativePlatform = 'darwin' | 'win32' | 'linux';

export type ComputerUseNativeProbe = Readonly<{
  available: boolean;
  protocolVersion: 1;
  apiVersion: 1;
  backend: string;
  reason: string;
  artifactPath: string | null;
  artifactDigest: string | null;
  capabilities: Readonly<{
    observe: boolean;
    control: boolean;
  }>;
}>;

export type ComputerUseNativeAddon = Readonly<{
  probe(): unknown;
  handshake?(input: unknown): unknown;
  pickApplication?(input: unknown): unknown;
  listWindows?(input: unknown): unknown;
  startSession?(input: unknown): unknown;
  observe?(input: unknown): unknown;
  dispatch?(input: unknown): unknown;
  cancel?(input: unknown): unknown;
  close?(input: unknown): unknown;
}>;

export type ComputerUseNativeBinding = Readonly<{
  manifest: ComputerUseNativeManifest;
  probe: ComputerUseNativeProbe;
  artifactPath: string | null;
  addon: ComputerUseNativeAddon | null;
}>;
