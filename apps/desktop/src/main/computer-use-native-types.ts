import type { ComputerUseNativeManifest } from '@sprint-coder/contracts';

export type ComputerUseNativePlatform = 'darwin' | 'win32' | 'linux';

export type ComputerUseNativeProbe = Readonly<{
  available: boolean;
  protocolVersion: 1;
  apiVersion: 2;
  backend: string;
  reason: string;
  artifactPath: string | null;
  artifactDigest: string | null;
  capabilities: Readonly<{
    observe: boolean;
    control: boolean;
    /**
     * Per-capability facts the native probe measured. They are present only when a probe actually
     * reported them, so an absent field means "not measured", never "granted". Main treats
     * anything other than `true` as not granted.
     */
    accessibility?: boolean;
    screenCapture?: boolean;
    screenCaptureKit?: boolean;
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
